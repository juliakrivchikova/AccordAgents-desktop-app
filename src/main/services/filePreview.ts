import { createHash, randomBytes } from "node:crypto";
import { createReadStream, watch as fsWatch, type FSWatcher, type Stats } from "node:fs";
import { access, constants as fsConstants, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import {
  FILE_PREVIEW_PDF_LIMIT,
  FILE_PREVIEW_PROTOCOL,
  FILE_PREVIEW_TEXT_EDIT_LIMIT,
  FILE_PREVIEW_TEXT_READ_LIMIT,
  FILE_PREVIEW_UNSAVED_COPY_LIMIT,
  fileExtension,
  filePreviewKindForPath,
  isEditablePreviewKind,
  utf8SafePrefixLength
} from "../../shared/filePreview";
import type {
  FilePreview,
  FilePreviewChangedEvent,
  ReadFilePreviewRequest,
  UnsavedFileEdit,
  WriteFilePreviewRequest,
  WriteFilePreviewResult
} from "../../shared/types";
import { isPathInside, localFileFailureMessage, type LocalFileResolution } from "./repoFile";
import { WorkspaceFileResolver } from "./workspaceFiles";

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const SNIFF_BYTES = 8 * 1024;
const WATCH_DEBOUNCE_MS = 200;
/** A chat's project folder is read from storage at most this often per chat. */
const REPO_PATH_CACHE_MS = 10_000;
/** Largest file whose content decides "changed": bigger ones compare size and time. */
const HASHED_LIMIT = FILE_PREVIEW_TEXT_EDIT_LIMIT + UTF8_BOM.length;

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif",
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8", txt: "text/plain; charset=utf-8", csv: "text/csv; charset=utf-8",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav"
};

export interface FilePreviewChatLookup {
  conversationRepoPath(conversationId: string): Promise<{ repoPath?: string } | undefined>;
}

interface ProtocolGrant {
  /** The file the panel shows (real path). */
  realPath: string;
  /** "file": only realPath is served; "tree": anything under root, except dot entries below it. */
  scope: "file" | "tree";
  root: string;
}

interface WatchEntry {
  watcher?: FSWatcher;
  refs: number;
  /** The content the panel knows about: from its last read, or the last save the app made. */
  knownToken?: string;
  knownSize?: number;
  knownMtimeMs?: number;
  timer?: NodeJS.Timeout;
  deleted?: boolean;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Editable text is compared by content; anything else (or too big to edit) by size and time. */
function hashedByContent(realFile: string, size: number): boolean {
  return isEditablePreviewKind(filePreviewKindForPath(realFile)) && size <= HASHED_LIMIT;
}

function sizeToken(info: Pick<Stats, "size" | "mtimeMs">): string {
  return `${info.size}:${info.mtimeMs}`;
}

function hasNulByte(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, SNIFF_BYTES);
  for (let index = 0; index < end; index += 1) {
    if (bytes[index] === 0) return true;
  }
  return false;
}

async function readPrefix(realFile: string, length: number): Promise<Buffer> {
  const handle = await open(realFile, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** A path inside a `.git` folder (any depth): the panel never writes there. */
function insideGitDirectory(realFile: string): boolean {
  return realFile.split(path.sep).includes(".git");
}

/**
 * Reads, writes and watches the local files the chat's side panel shows, and
 * serves images and HTML pages to it through the app's own scheme.
 *
 * Nothing here is stored in SQLite or in a conversation; the only thing written
 * besides the file itself is a copy of unsaved edits under userData, removed
 * once the edit is saved or discarded.
 */
export class FilePreviewService {
  private readonly grants = new Map<string, ProtocolGrant>();
  private readonly watches = new Map<string, WatchEntry>();
  /** Unwatch calls that arrived before their watch finished resolving the path. */
  private readonly earlyUnwatches = new Map<string, number>();
  /** Files being written right now: their watcher waits for the write. */
  private readonly writing = new Set<string>();
  /** Files the panel read as editable in this window: the only ones it may write. */
  private readonly writable = new Set<string>();
  private readonly repoPaths = new Map<string, { value: { repoPath?: string } | undefined; at: number }>();
  /** Copies of unsaved edits are written and removed one at a time per file. */
  private readonly unsavedQueue = new Map<string, Promise<void>>();
  private readonly unsavedDir: string;

  constructor(
    private readonly chats: FilePreviewChatLookup,
    private readonly resolver: WorkspaceFileResolver,
    userDataPath: string,
    private readonly emitChanged: (event: FilePreviewChangedEvent) => void,
    private readonly now: () => number = Date.now
  ) {
    this.unsavedDir = path.join(userDataPath, "unsaved-edits");
  }

  private async resolution(conversationId: unknown, rawPath: unknown): Promise<LocalFileResolution> {
    const id = typeof conversationId === "string" ? conversationId.trim() : "";
    if (!id) throw new Error("A conversation is required to open a file.");
    const cached = this.repoPaths.get(id);
    let chat = cached && this.now() - cached.at < REPO_PATH_CACHE_MS ? cached.value : undefined;
    if (!chat) {
      chat = await this.chats.conversationRepoPath(id);
      this.repoPaths.set(id, { value: chat, at: this.now() });
    }
    if (!chat) throw new Error("Conversation not found.");
    return this.resolver.resolve(chat.repoPath, rawPath);
  }

  async resolve(conversationId: unknown, rawPath: unknown): Promise<LocalFileResolution & { ok: true }> {
    const resolution = await this.resolution(conversationId, rawPath);
    if (!resolution.ok) throw new Error(localFileFailureMessage(resolution.reason));
    return resolution;
  }

  async read(request: ReadFilePreviewRequest): Promise<FilePreview> {
    const resolution = await this.resolve(request?.conversationId, request?.path);
    const realFile = resolution.realPath;
    const info = await stat(realFile);
    const kind = filePreviewKindForPath(realFile);
    const base = {
      path: request.path,
      absolutePath: resolution.absolutePath,
      realPath: realFile,
      insideWorkspace: resolution.insideWorkspace,
      size: info.size,
      mtimeMs: info.mtimeMs,
      truncated: false,
      tooLarge: false,
      utf8: false,
      bom: false,
      editable: false
    };
    const unsupported = (): FilePreview => ({ ...base, kind: "unsupported", hash: "" });

    if (kind === "unsupported") return unsupported();

    if (kind === "image") {
      const hash = sizeToken(info);
      this.noteKnown(realFile, hash, info);
      return { ...base, kind, hash, url: this.grant(realFile, "file") };
    }

    if (kind === "pdf") {
      const hash = sizeToken(info);
      this.noteKnown(realFile, hash, info);
      if (info.size > FILE_PREVIEW_PDF_LIMIT) return { ...base, kind, hash, tooLarge: true };
      return { ...base, kind, hash, data: await readFile(realFile) };
    }

    // Text kinds, and an HTML page, whose source is text and which is also shown live.
    const url = kind === "html" ? this.grant(realFile, resolution.insideWorkspace ? "tree" : "file") : undefined;
    if (info.size > FILE_PREVIEW_TEXT_READ_LIMIT) {
      const hash = sizeToken(info);
      this.noteKnown(realFile, hash, info);
      return { ...base, kind, hash, url, truncated: true, tooLarge: true, utf8: true, readOnlyReason: "This file is too large to show in the panel." };
    }
    // A file too big to edit is read only as far as it is shown.
    const whole = info.size <= HASHED_LIMIT;
    const bytes = whole ? await readFile(realFile) : await readPrefix(realFile, HASHED_LIMIT);
    if (hasNulByte(bytes)) return unsupported();
    const hash = whole ? sha256(bytes) : sizeToken(info);
    this.noteKnown(realFile, hash, info);
    const bom = bytes.subarray(0, UTF8_BOM.length).equals(UTF8_BOM);
    const body = bom ? bytes.subarray(UTF8_BOM.length) : bytes;
    const truncated = !whole || body.length > FILE_PREVIEW_TEXT_EDIT_LIMIT;
    const shown = truncated ? body.subarray(0, utf8SafePrefixLength(body, FILE_PREVIEW_TEXT_EDIT_LIMIT)) : body;
    let text: string;
    let utf8 = true;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(shown);
    } catch {
      utf8 = false;
      text = new TextDecoder("utf-8").decode(shown);
    }
    const canWrite = await access(realFile, fsConstants.W_OK).then(() => true, () => false);
    const reason = !resolution.insideWorkspace
      ? truncated
        ? "This file is outside the project and only its start is shown, so it opens read-only."
        : "This file is outside the project, so it opens read-only."
      : truncated
        ? "Only the start of this file is shown, so it cannot be edited here."
        : !utf8
          ? "This file is not UTF-8 text, so it cannot be edited here."
          : insideGitDirectory(realFile)
            ? "Files inside .git are not edited in the panel."
            : !canWrite
              ? "You do not have permission to change this file."
              : undefined;
    if (!reason) this.writable.add(realFile);
    return { ...base, kind, hash, url, text, truncated, utf8, bom, editable: !reason, readOnlyReason: reason };
  }

  /**
   * Saves panel edits in place, through one file handle: the hash check, the
   * write and the check that the path still names the same file all use it. A
   * change made before the check is a conflict; one made in the instant between
   * the check and the write (an agent writing in place at that very moment) is
   * not detectable, as in any editor.
   */
  async write(request: WriteFilePreviewRequest): Promise<WriteFilePreviewResult> {
    let resolution: LocalFileResolution;
    try {
      resolution = await this.resolution(request?.conversationId, request?.path);
    } catch (error) {
      return { ok: false, conflict: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!resolution.ok) {
      if (resolution.reason === "not-found") return { ok: false, conflict: true, reason: "deleted" };
      return { ok: false, conflict: false, error: localFileFailureMessage(resolution.reason) };
    }
    const realFile = resolution.realPath;
    if (!resolution.insideWorkspace) {
      return { ok: false, conflict: false, error: "Only files in the project can be edited in the panel." };
    }
    if (!this.writable.has(realFile) || !isEditablePreviewKind(filePreviewKindForPath(realFile)) || insideGitDirectory(realFile)) {
      return { ok: false, conflict: false, error: "This file cannot be edited in the panel." };
    }
    if (typeof request.content !== "string" || typeof request.baseHash !== "string") {
      return { ok: false, conflict: false, error: "Invalid save request." };
    }
    const body = Buffer.from(request.content, "utf8");
    const next = request.bom ? Buffer.concat([UTF8_BOM, body]) : body;
    if (next.length > HASHED_LIMIT) {
      return { ok: false, conflict: false, error: "The text is larger than the panel can save (2 MB)." };
    }
    let handle;
    try {
      handle = await open(realFile, "r+");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { ok: false, conflict: true, reason: "deleted" };
      return { ok: false, conflict: false, error: code === "EACCES" || code === "EPERM" ? "You do not have permission to change this file." : String(error) };
    }
    this.writing.add(realFile);
    try {
      const before = await handle.stat();
      if (before.size > HASHED_LIMIT) return { ok: false, conflict: true, reason: "changed" };
      const current = await handle.readFile();
      if (sha256(current) !== request.baseHash) {
        return { ok: false, conflict: true, reason: "changed" };
      }
      const hash = sha256(next);
      await handle.truncate(0);
      let written = 0;
      while (written < next.length) {
        const { bytesWritten } = await handle.write(next, written, next.length - written, written);
        if (bytesWritten <= 0) throw new Error("The file stopped accepting data.");
        written += bytesWritten;
      }
      await handle.sync();
      const opened = await handle.stat();
      if (opened.size !== next.length) throw new Error("The file was not written completely.");
      this.noteKnown(realFile, hash, opened);
      const named = await stat(realFile).catch(() => undefined);
      if (!named || named.ino !== opened.ino || named.dev !== opened.dev) {
        return { ok: false, conflict: true, reason: named ? "replaced" : "deleted" };
      }
      return { ok: true, hash, mtimeMs: opened.mtimeMs, size: opened.size };
    } catch (error) {
      return { ok: false, conflict: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      await handle.close().catch(() => undefined);
      this.writing.delete(realFile);
      // Events from this write were held back; look once more now it is done.
      this.scheduleCheck(realFile);
    }
  }

  // --- Watching ----------------------------------------------------------

  async watch(request: ReadFilePreviewRequest): Promise<void> {
    const resolution = await this.resolve(request?.conversationId, request?.path);
    const realFile = resolution.realPath;
    const early = this.earlyUnwatches.get(realFile) ?? 0;
    if (early > 0) {
      // The panel already let go of this file while its path was being resolved.
      if (early === 1) this.earlyUnwatches.delete(realFile);
      else this.earlyUnwatches.set(realFile, early - 1);
      return;
    }
    let entry = this.watches.get(realFile);
    if (!entry) {
      entry = { refs: 0 };
      this.watches.set(realFile, entry);
    }
    entry.refs += 1;
    if (entry.watcher) return;
    const name = path.basename(realFile);
    try {
      entry.watcher = fsWatch(path.dirname(realFile), { persistent: false }, (_event, changed) => {
        if (changed && changed.toString() !== name) return;
        this.scheduleCheck(realFile);
      });
      entry.watcher.on("error", () => this.scheduleCheck(realFile));
    } catch {
      void this.check(realFile);
    }
  }

  unwatch(realFile: unknown): void {
    if (typeof realFile !== "string") return;
    const entry = this.watches.get(realFile);
    if (!entry || entry.refs <= 0) {
      this.earlyUnwatches.set(realFile, (this.earlyUnwatches.get(realFile) ?? 0) + 1);
      return;
    }
    entry.refs -= 1;
    if (entry.refs > 0) return;
    this.closeWatch(realFile, entry);
  }

  /** The window reloaded, crashed or closed: nothing it watched, loaded or read is needed any more. */
  releaseAll(): void {
    for (const [realFile, entry] of this.watches) this.closeWatch(realFile, entry);
    this.earlyUnwatches.clear();
    this.grants.clear();
    this.writable.clear();
  }

  private closeWatch(realFile: string, entry: WatchEntry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.watcher?.close();
    this.watches.delete(realFile);
  }

  private noteKnown(realFile: string, token: string, info: Pick<Stats, "size" | "mtimeMs">): void {
    const entry = this.watches.get(realFile) ?? { refs: 0 };
    entry.knownToken = token;
    entry.knownSize = info.size;
    entry.knownMtimeMs = info.mtimeMs;
    entry.deleted = false;
    if (!this.watches.has(realFile)) this.watches.set(realFile, entry);
  }

  private scheduleCheck(realFile: string): void {
    const entry = this.watches.get(realFile);
    if (!entry?.watcher) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.check(realFile);
    }, WATCH_DEBOUNCE_MS);
  }

  private async check(realFile: string): Promise<void> {
    const entry = this.watches.get(realFile);
    if (!entry || this.writing.has(realFile)) return;
    const info = await stat(realFile).catch(() => undefined);
    if (!info || !info.isFile()) {
      if (!entry.deleted) {
        entry.deleted = true;
        this.emitChanged({ realPath: realFile, change: "deleted" });
      }
      return;
    }
    if (!entry.deleted && info.size === entry.knownSize && info.mtimeMs === entry.knownMtimeMs) return;
    let token: string;
    if (hashedByContent(realFile, info.size)) {
      const bytes = await readFile(realFile).catch(() => undefined);
      if (!bytes) return;
      token = sha256(bytes);
    } else {
      token = sizeToken(info);
    }
    if (this.writing.has(realFile)) return;
    const wasDeleted = entry.deleted;
    entry.deleted = false;
    entry.knownSize = info.size;
    entry.knownMtimeMs = info.mtimeMs;
    if (token === entry.knownToken && !wasDeleted) return;
    entry.knownToken = token;
    this.emitChanged({ realPath: realFile, change: "changed", hash: token, mtimeMs: info.mtimeMs });
  }

  // --- The app's own scheme for images and HTML -------------------------

  private grant(realFile: string, scope: ProtocolGrant["scope"]): string {
    for (const [token, existing] of this.grants) {
      if (existing.realPath === realFile && existing.scope === scope) {
        return this.urlFor(token, realFile, existing.root);
      }
    }
    const token = randomBytes(16).toString("hex");
    const root = scope === "tree" ? path.dirname(realFile) : realFile;
    this.grants.set(token, { realPath: realFile, scope, root });
    return this.urlFor(token, realFile, root);
  }

  private urlFor(token: string, realFile: string, root: string): string {
    const relative = root === realFile ? path.basename(realFile) : path.relative(root, realFile);
    const encoded = relative.split(path.sep).map(encodeURIComponent).join("/");
    return `${FILE_PREVIEW_PROTOCOL}://${token}/${encoded}`;
  }

  release(realFile: unknown): void {
    if (typeof realFile !== "string") return;
    for (const [token, grant] of this.grants) {
      if (grant.realPath === realFile) this.grants.delete(token);
    }
  }

  /** Whether a URL is one this service handed out and still serves. */
  isGrantedUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === `${FILE_PREVIEW_PROTOCOL}:` && this.grants.has(parsed.hostname);
    } catch {
      return false;
    }
  }

  async handleProtocolRequest(request: Request): Promise<Response> {
    const notFound = () => new Response("Not found", { status: 404, headers: { "X-Content-Type-Options": "nosniff" } });
    let parsed: URL;
    try {
      parsed = new URL(request.url);
    } catch {
      return notFound();
    }
    const grant = this.grants.get(parsed.hostname);
    if (!grant) return notFound();
    let relative: string;
    try {
      relative = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    } catch {
      return notFound();
    }
    if (relative.includes("\0")) return notFound();
    let target: string;
    if (grant.scope === "file") {
      target = grant.realPath;
    } else {
      const candidate = path.resolve(grant.root, relative || path.basename(grant.realPath));
      if (!isPathInside(grant.root, candidate)) return notFound();
      const below = path.relative(grant.root, candidate).split(path.sep);
      if (below.some((segment) => segment.startsWith("."))) return notFound();
      const real = await realpath(candidate).catch(() => undefined);
      if (!real || !isPathInside(grant.root, real)) return notFound();
      target = real;
    }
    const info = await stat(target).catch(() => undefined);
    if (!info?.isFile()) return notFound();
    const type = CONTENT_TYPES[fileExtension(target)] ?? "application/octet-stream";
    // No Access-Control-Allow-Origin, ever: the HTML page runs in a sandboxed,
    // opaque-origin frame, and the missing header is what keeps its scripts from
    // reading the bytes of any file this grant can reach.
    return new Response(Readable.toWeb(createReadStream(target)) as unknown as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": type,
        "Content-Length": String(info.size),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store"
      }
    });
  }

  // --- Unsaved edits ----------------------------------------------------

  private unsavedFile(realFile: string): string {
    return path.join(this.unsavedDir, `${createHash("sha256").update(realFile).digest("hex")}.json`);
  }

  /** Writes and removals of one file's copy happen in the order they were asked for. */
  private queueUnsaved(realFile: string, work: () => Promise<void>): Promise<void> {
    const previous = this.unsavedQueue.get(realFile) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.unsavedQueue.set(realFile, next);
    void next.catch(() => undefined).finally(() => {
      if (this.unsavedQueue.get(realFile) === next) this.unsavedQueue.delete(realFile);
    });
    return next;
  }

  saveUnsaved(edit: UnsavedFileEdit): Promise<void> {
    if (!edit || typeof edit.realPath !== "string" || typeof edit.text !== "string" || typeof edit.conversationId !== "string") {
      return Promise.reject(new Error("Invalid unsaved edit."));
    }
    if (Buffer.byteLength(edit.text, "utf8") > FILE_PREVIEW_UNSAVED_COPY_LIMIT) {
      return Promise.reject(new Error("The unsaved text is too large to keep a copy of."));
    }
    const record: UnsavedFileEdit = {
      conversationId: edit.conversationId,
      path: String(edit.path ?? ""),
      realPath: edit.realPath,
      baseHash: String(edit.baseHash ?? ""),
      text: edit.text,
      bom: edit.bom === true,
      updatedAt: new Date().toISOString()
    };
    return this.queueUnsaved(edit.realPath, async () => {
      await mkdir(this.unsavedDir, { recursive: true });
      const file = this.unsavedFile(edit.realPath);
      const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
      await writeFile(temporary, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
      await rename(temporary, file).catch(async (error) => {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      });
    });
  }

  clearUnsaved(realFile: unknown): Promise<void> {
    if (typeof realFile !== "string") return Promise.resolve();
    return this.queueUnsaved(realFile, () => rm(this.unsavedFile(realFile), { force: true }));
  }

  async listUnsaved(): Promise<UnsavedFileEdit[]> {
    const names = await readdir(this.unsavedDir).catch(() => [] as string[]);
    const edits: UnsavedFileEdit[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const record = JSON.parse(await readFile(path.join(this.unsavedDir, name), "utf8")) as UnsavedFileEdit;
        if (typeof record.realPath === "string" && typeof record.text === "string" && typeof record.conversationId === "string") {
          edits.push({ ...record, updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "" });
        }
      } catch {
        // A copy that cannot be read is skipped, not deleted: it may be the User's only copy.
      }
    }
    return edits.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
