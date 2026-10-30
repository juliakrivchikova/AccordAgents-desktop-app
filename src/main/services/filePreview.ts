import { createHash, randomBytes } from "node:crypto";
import { createReadStream, watch as fsWatch, type FSWatcher } from "node:fs";
import { access, constants as fsConstants, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import {
  FILE_PREVIEW_PDF_LIMIT,
  FILE_PREVIEW_PROTOCOL,
  FILE_PREVIEW_TEXT_EDIT_LIMIT,
  FILE_PREVIEW_TEXT_READ_LIMIT,
  fileExtension,
  filePreviewKindForPath,
  isTextPreviewKind,
  utf8SafePrefixLength
} from "../../shared/filePreview";
import type {
  FilePreview,
  FilePreviewChangedEvent,
  FilePreviewKind,
  ReadFilePreviewRequest,
  UnsavedFileEdit,
  WriteFilePreviewRequest,
  WriteFilePreviewResult
} from "../../shared/types";
import { isPathInside, type LocalFileResolution, type LocalFileResolutionFailureReason } from "./repoFile";
import { WorkspaceFileResolver } from "./workspaceFiles";

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const SNIFF_BYTES = 8 * 1024;
const WATCH_DEBOUNCE_MS = 200;

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
  knownHash?: string;
  knownSize?: number;
  knownMtimeMs?: number;
  timer?: NodeJS.Timeout;
  deleted?: boolean;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function failureMessage(reason: LocalFileResolutionFailureReason): string {
  switch (reason) {
    case "base-missing": return "This chat has no selected workspace, so relative file links cannot be opened.";
    case "directory": return "That path is a directory, not a file.";
    case "not-regular-file": return "That path is not a regular file.";
    case "not-found": return "That file no longer exists.";
    default: return "That file path is invalid.";
  }
}

function hasNulByte(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, SNIFF_BYTES);
  for (let index = 0; index < end; index += 1) {
    if (bytes[index] === 0) return true;
  }
  return false;
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
  private readonly unsavedDir: string;

  constructor(
    private readonly chats: FilePreviewChatLookup,
    private readonly resolver: WorkspaceFileResolver,
    userDataPath: string,
    private readonly emitChanged: (event: FilePreviewChangedEvent) => void
  ) {
    this.unsavedDir = path.join(userDataPath, "unsaved-edits");
  }

  async resolve(conversationId: unknown, rawPath: unknown): Promise<LocalFileResolution & { ok: true }> {
    const id = typeof conversationId === "string" ? conversationId.trim() : "";
    if (!id) throw new Error("A conversation is required to open a file.");
    const chat = await this.chats.conversationRepoPath(id);
    if (!chat) throw new Error("Conversation not found.");
    const resolution = await this.resolver.resolve(chat.repoPath, rawPath);
    if (!resolution.ok) throw new Error(failureMessage(resolution.reason));
    return resolution;
  }

  async read(request: ReadFilePreviewRequest): Promise<FilePreview> {
    const resolution = await this.resolve(request?.conversationId, request?.path);
    const info = await stat(resolution.realPath);
    let kind: FilePreviewKind = filePreviewKindForPath(resolution.realPath);
    const base = {
      path: request.path,
      absolutePath: resolution.absolutePath,
      realPath: resolution.realPath,
      insideWorkspace: resolution.insideWorkspace,
      size: info.size,
      mtimeMs: info.mtimeMs
    };
    const readOnly = (reason: string) => ({ editable: false, readOnlyReason: reason });

    if (kind === "unsupported") {
      return { ...base, kind, hash: "", truncated: false, tooLarge: false, utf8: false, bom: false, editable: false };
    }

    // An HTML page is shown live and its source is text like any other.
    const url = kind === "html" ? this.grant(resolution.realPath, resolution.insideWorkspace ? "tree" : "file") : undefined;

    if (kind === "image") {
      const url = this.grant(resolution.realPath, "file");
      const hash = info.size <= FILE_PREVIEW_TEXT_READ_LIMIT ? sha256(await readFile(resolution.realPath)) : `${info.size}:${info.mtimeMs}`;
      this.noteKnown(resolution.realPath, hash, info.size, info.mtimeMs);
      return { ...base, kind, hash, url, truncated: false, tooLarge: false, utf8: false, bom: false, editable: false };
    }

    if (kind === "pdf") {
      if (info.size > FILE_PREVIEW_PDF_LIMIT) {
        return { ...base, kind, hash: `${info.size}:${info.mtimeMs}`, truncated: false, tooLarge: true, utf8: false, bom: false, editable: false };
      }
      const bytes = await readFile(resolution.realPath);
      const hash = sha256(bytes);
      this.noteKnown(resolution.realPath, hash, info.size, info.mtimeMs);
      return { ...base, kind, hash, data: new Uint8Array(bytes), truncated: false, tooLarge: false, utf8: false, bom: false, editable: false };
    }

    // Text kinds.
    if (info.size > FILE_PREVIEW_TEXT_READ_LIMIT) {
      const hash = `${info.size}:${info.mtimeMs}`;
      this.noteKnown(resolution.realPath, hash, info.size, info.mtimeMs);
      return { ...base, kind, hash, url, truncated: true, tooLarge: true, utf8: true, bom: false, ...readOnly("This file is too large to show in the panel.") };
    }
    const bytes = await readFile(resolution.realPath);
    if (hasNulByte(bytes)) {
      kind = "unsupported";
      return { ...base, kind, hash: "", truncated: false, tooLarge: false, utf8: false, bom: false, editable: false };
    }
    const hash = sha256(bytes);
    this.noteKnown(resolution.realPath, hash, info.size, info.mtimeMs);
    const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    const body = bom ? bytes.subarray(3) : bytes;
    const truncated = body.length > FILE_PREVIEW_TEXT_EDIT_LIMIT;
    const shown = truncated ? body.subarray(0, utf8SafePrefixLength(body, FILE_PREVIEW_TEXT_EDIT_LIMIT)) : body;
    let text: string;
    let utf8 = true;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(shown);
    } catch {
      utf8 = false;
      text = new TextDecoder("utf-8").decode(shown);
    }
    const writable = await access(resolution.realPath, fsConstants.W_OK).then(() => true, () => false);
    const reason = !resolution.insideWorkspace
      ? "This file is outside the project, so it opens read-only."
      : truncated
        ? "Only the start of this file is shown, so it cannot be edited here."
        : !utf8
          ? "This file is not UTF-8 text, so it cannot be edited here."
          : !writable
            ? "You do not have permission to change this file."
            : undefined;
    return { ...base, kind, hash, url, text, truncated, tooLarge: false, utf8, bom, editable: !reason, readOnlyReason: reason };
  }

  /**
   * Saves panel edits in place, through one file handle: the hash check, the
   * write and the check that the path still names the same file all use it, so
   * an agent's change between them is reported as a conflict, never overwritten.
   */
  async write(request: WriteFilePreviewRequest): Promise<WriteFilePreviewResult> {
    let resolution: LocalFileResolution & { ok: true };
    try {
      resolution = await this.resolve(request?.conversationId, request?.path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === failureMessage("not-found")) return { ok: false, conflict: true, reason: "deleted" };
      return { ok: false, conflict: false, error: message };
    }
    if (!resolution.insideWorkspace) {
      return { ok: false, conflict: false, error: "Only files in the project can be edited in the panel." };
    }
    const writableKind = filePreviewKindForPath(resolution.realPath);
    if (!isTextPreviewKind(writableKind) && writableKind !== "html") {
      return { ok: false, conflict: false, error: "This kind of file cannot be edited in the panel." };
    }
    if (typeof request.content !== "string" || typeof request.baseHash !== "string") {
      return { ok: false, conflict: false, error: "Invalid save request." };
    }
    const body = Buffer.from(request.content, "utf8");
    const next = request.bom ? Buffer.concat([UTF8_BOM, body]) : body;
    if (next.length > FILE_PREVIEW_TEXT_EDIT_LIMIT + UTF8_BOM.length) {
      return { ok: false, conflict: false, error: "The text is larger than the panel can save." };
    }
    let handle;
    try {
      handle = await open(resolution.realPath, "r+");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { ok: false, conflict: true, reason: "deleted" };
      return { ok: false, conflict: false, error: code === "EACCES" || code === "EPERM" ? "You do not have permission to change this file." : String(error) };
    }
    try {
      const current = await handle.readFile();
      if (sha256(current) !== request.baseHash) {
        return { ok: false, conflict: true, reason: "changed" };
      }
      await handle.truncate(0);
      await handle.write(next, 0, next.length, 0);
      await handle.sync();
      const opened = await handle.stat();
      const named = await stat(resolution.realPath).catch(() => undefined);
      if (!named || named.ino !== opened.ino || named.dev !== opened.dev) {
        return { ok: false, conflict: true, reason: named ? "replaced" : "deleted" };
      }
      const hash = sha256(next);
      this.noteKnown(resolution.realPath, hash, opened.size, opened.mtimeMs);
      return { ok: true, hash, mtimeMs: opened.mtimeMs, size: opened.size };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  // --- Watching ----------------------------------------------------------

  async watch(request: ReadFilePreviewRequest): Promise<void> {
    const resolution = await this.resolve(request?.conversationId, request?.path);
    const realFile = resolution.realPath;
    let entry = this.watches.get(realFile);
    if (!entry) {
      entry = { refs: 0 };
      this.watches.set(realFile, entry);
    }
    entry.refs += 1;
    if (entry.watcher) return;
    const directory = path.dirname(realFile);
    const name = path.basename(realFile);
    try {
      entry.watcher = fsWatch(directory, { persistent: false }, (_event, changed) => {
        if (changed && changed.toString() !== name) return;
        this.scheduleCheck(realFile);
      });
      entry.watcher.on("error", () => {
        this.scheduleCheck(realFile);
      });
    } catch {
      this.scheduleCheck(realFile);
    }
  }

  unwatch(realFile: unknown): void {
    if (typeof realFile !== "string") return;
    const entry = this.watches.get(realFile);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    this.closeWatch(realFile, entry);
  }

  /** The window reloaded, crashed or closed: nothing it watched or loaded is needed any more. */
  releaseAll(): void {
    for (const [realFile, entry] of this.watches) this.closeWatch(realFile, entry);
    this.grants.clear();
  }

  private closeWatch(realFile: string, entry: WatchEntry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.watcher?.close();
    this.watches.delete(realFile);
  }

  private noteKnown(realFile: string, hash: string, size: number, mtimeMs: number): void {
    const entry = this.watches.get(realFile) ?? { refs: 0 };
    entry.knownHash = hash;
    entry.knownSize = size;
    entry.knownMtimeMs = mtimeMs;
    entry.deleted = false;
    if (!this.watches.has(realFile)) this.watches.set(realFile, entry);
  }

  private scheduleCheck(realFile: string): void {
    const entry = this.watches.get(realFile);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.check(realFile);
    }, WATCH_DEBOUNCE_MS);
  }

  private async check(realFile: string): Promise<void> {
    const entry = this.watches.get(realFile);
    if (!entry) return;
    const info = await stat(realFile).catch(() => undefined);
    if (!info || !info.isFile()) {
      if (!entry.deleted) {
        entry.deleted = true;
        this.emitChanged({ realPath: realFile, change: "deleted" });
      }
      return;
    }
    let hash: string;
    if (info.size > FILE_PREVIEW_TEXT_READ_LIMIT) {
      hash = `${info.size}:${info.mtimeMs}`;
    } else {
      const bytes = await readFile(realFile).catch(() => undefined);
      if (!bytes) return;
      hash = sha256(bytes);
    }
    if (hash === entry.knownHash && !entry.deleted) return;
    entry.deleted = false;
    entry.knownHash = hash;
    entry.knownSize = info.size;
    entry.knownMtimeMs = info.mtimeMs;
    this.emitChanged({ realPath: realFile, change: "changed", hash, mtimeMs: info.mtimeMs });
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

  async saveUnsaved(edit: UnsavedFileEdit): Promise<void> {
    if (!edit || typeof edit.realPath !== "string" || typeof edit.text !== "string" || typeof edit.conversationId !== "string") {
      throw new Error("Invalid unsaved edit.");
    }
    if (Buffer.byteLength(edit.text, "utf8") > FILE_PREVIEW_TEXT_EDIT_LIMIT) return;
    await mkdir(this.unsavedDir, { recursive: true });
    const record: UnsavedFileEdit = {
      conversationId: edit.conversationId,
      path: String(edit.path ?? ""),
      realPath: edit.realPath,
      baseHash: String(edit.baseHash ?? ""),
      text: edit.text,
      bom: edit.bom === true,
      updatedAt: new Date().toISOString()
    };
    const file = this.unsavedFile(edit.realPath);
    const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file).catch(async (error) => {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    });
  }

  async clearUnsaved(realFile: unknown): Promise<void> {
    if (typeof realFile !== "string") return;
    await rm(this.unsavedFile(realFile), { force: true });
  }

  async listUnsaved(): Promise<UnsavedFileEdit[]> {
    const names = await readdir(this.unsavedDir).catch(() => [] as string[]);
    const edits: UnsavedFileEdit[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const record = JSON.parse(await readFile(path.join(this.unsavedDir, name), "utf8")) as UnsavedFileEdit;
        if (typeof record.realPath === "string" && typeof record.text === "string" && typeof record.conversationId === "string") {
          edits.push(record);
        }
      } catch {
        // A copy that cannot be read is skipped, not deleted: it may be the User's only copy.
      }
    }
    return edits.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
