import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  SCRIPT_MAX_FILES,
  SCRIPT_MAX_FILES_BYTES,
  SCRIPT_RUNTIMES,
  type ScriptFile,
  type ScriptPermissions,
  type ScriptRunRow,
  type ScriptRuntime,
  type ScriptSchedule
} from "../../shared/scripts";

/** Everything about one scheduled script except its key values and files.
 *  One small JSON file per script, under its own directory; the history and
 *  run state live in separate files so a run never rewrites the record. */
export interface ScriptRecord {
  version: 1;
  id: string;
  name: string;
  description: string;
  hostId: string;
  runtime: ScriptRuntime;
  entry: string;
  schedule: ScriptSchedule;
  timeoutSeconds: number;
  secretNames: string[];
  permissions: ScriptPermissions;
  chatLabels: Record<string, string>;
  participantLabels: Record<string, string>;
  enabled: boolean;
  approvedHash?: string;
  approvedAt?: string;
  /** The proposal whose approval installed the current files. */
  appliedRevisionId?: string;
  pendingRevisionId?: string;
  pendingApprovalId?: string;
  createdByParticipantId: string;
  createdByLabel?: string;
  createdInChatId: string;
  createdAt: string;
  updatedAt: string;
}

/** A proposed version waiting for the User's approval. */
export interface ScriptRevision {
  version: 1;
  revisionId: string;
  scriptId: string;
  createdAt: string;
  name: string;
  description: string;
  runtime: ScriptRuntime;
  entry: string;
  schedule: ScriptSchedule;
  timeoutSeconds: number;
  secretNames: string[];
  permissions: ScriptPermissions;
  chatLabels: Record<string, string>;
  participantLabels: Record<string, string>;
  files: ScriptFile[];
  contentHash: string;
}

export interface ScriptRuntimeState {
  version: 1;
  /** The scheduled time of the next run (the anchor intervals keep). */
  nextDueAt?: string;
  lastRunAt?: string;
  lastRunStatus?: ScriptRunRow["status"];
  /** Set while the script's last finished run failed; cleared by a good run. */
  failingSince?: string;
  /** Consecutive failed runs; a notice waits for a second one on interval schedules. */
  failureCount?: number;
  /** True once this failing stretch was announced in the chat. */
  failingAnnounced?: boolean;
  /** When an "is failing" notice was last posted, across stretches. */
  lastFailingNoticeAt?: string;
  lastError?: string;
  blockedReason?: string;
}

/** The script API's counters, in a file of their own so the small runtime
 *  file stays small while a busy script keys many posts. */
export interface ScriptRateState {
  version: 1;
  /** Instants of messages that mentioned someone, for the hourly wake-up budget. */
  wakeups: string[];
  /** Instants of every message posted, for the hourly message limit. */
  posts: string[];
  /** idempotencyKey -> message id and when it was first posted. */
  idempotency: Record<string, { messageId?: string; status: "posting" | "posted" | "held"; at: string }>;
}

export interface ScriptHeldMessage {
  id: string;
  chatId: string;
  text: string;
  participantIds: string[];
  createdAt: string;
}

export interface ScriptPidRecord {
  pid: number;
  runId: string;
  bootAt: number;
  startedAt: string;
}

const RECORD_FILE = "script.json";
const RUNTIME_FILE = "runtime.json";
const RATE_FILE = "rate.json";
const RUNS_FILE = "runs.json";
const HELD_FILE = "held.json";
const PID_FILE = "run.pid.json";
const FILES_DIR = "files";
const STATE_DIR = "state";
const REVISIONS_DIR = "revisions";
const SCRIPT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,63}$/;

export function newScriptId(): string {
  return `script-${randomUUID()}`;
}

export function isScriptId(value: unknown): value is string {
  return typeof value === "string" && SCRIPT_ID_PATTERN.test(value);
}

/** Hash over what runs: runtime, entry and every file. Approval binds it. */
export function scriptContentHash(runtime: ScriptRuntime, entry: string, files: ScriptFile[]): string {
  const hash = createHash("sha256");
  hash.update(`runtime\0${runtime}\0entry\0${entry}\0`);
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(`file\0${file.path}\0${Buffer.byteLength(file.content, "utf8")}\0`);
    hash.update(file.content, "utf8");
  }
  return hash.digest("hex");
}

/** Throws a reason when the files cannot be installed as given. */
export function validateScriptFiles(runtime: unknown, entry: unknown, files: unknown): { runtime: ScriptRuntime; entry: string; files: ScriptFile[]; totalBytes: number } {
  if (typeof runtime !== "string" || !SCRIPT_RUNTIMES.includes(runtime as ScriptRuntime)) {
    throw new Error(`runtime must be one of: ${SCRIPT_RUNTIMES.join(", ")}.`);
  }
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("files must list at least one file.");
  }
  if (files.length > SCRIPT_MAX_FILES) {
    throw new Error(`A script has at most ${SCRIPT_MAX_FILES} files.`);
  }
  const seen = new Set<string>();
  // macOS and Windows file systems ignore case: "Lib.js" and "lib.js" are one file.
  const seenFolded = new Set<string>();
  const normalized: ScriptFile[] = [];
  let totalBytes = 0;
  for (const item of files) {
    const candidate = item as Partial<ScriptFile>;
    if (typeof candidate?.path !== "string" || typeof candidate.content !== "string") {
      throw new Error("Each file needs a path and content.");
    }
    const filePath = normalizeScriptFilePath(candidate.path);
    if (seenFolded.has(filePath.toLowerCase())) {
      throw new Error(`The file ${filePath} is listed twice (names differing only in case are the same file).`);
    }
    seen.add(filePath);
    seenFolded.add(filePath.toLowerCase());
    totalBytes += Buffer.byteLength(candidate.content, "utf8");
    normalized.push({ path: filePath, content: candidate.content });
  }
  for (const filePath of seenFolded) {
    const parts = filePath.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      if (seenFolded.has(parts.slice(0, depth).join("/"))) {
        throw new Error(`${parts.slice(0, depth).join("/")} cannot be both a file and a folder.`);
      }
    }
  }
  if (totalBytes > SCRIPT_MAX_FILES_BYTES) {
    throw new Error(`A script's files total at most ${SCRIPT_MAX_FILES_BYTES / 1024} KB.`);
  }
  const entryPath = typeof entry === "string" && entry.trim() ? normalizeScriptFilePath(entry) : normalized[0]!.path;
  if (!seen.has(entryPath)) {
    throw new Error(`The entry ${entryPath} is not one of the files.`);
  }
  return { runtime: runtime as ScriptRuntime, entry: entryPath, files: normalized, totalBytes };
}

function normalizeScriptFilePath(raw: string): string {
  const trimmed = raw.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) {
    throw new Error(`File path "${raw}" must be relative.`);
  }
  const normalized = path.posix.normalize(trimmed);
  if (normalized === "." || normalized.startsWith("../") || normalized === ".." || normalized.split("/").some((part) => part.startsWith("."))) {
    throw new Error(`File path "${raw}" may not leave the script's directory or name a hidden file.`);
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(normalized) || normalized.length > 200) {
    throw new Error(`File path "${raw}" may use only letters, digits, ".", "_", "-" and "/".`);
  }
  return normalized;
}

async function atomicWrite(filePath: string, content: string, mode = 0o600): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, content, { mode });
    await rename(tmp, filePath);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** File-backed store for scheduled scripts on one host. Writes per script go
 *  through one queue, and every file is replaced atomically. */
export class ScriptStore {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly root: string) {}

  scriptDir(id: string): string {
    if (!isScriptId(id)) throw new Error("Unknown script.");
    return path.join(this.root, id);
  }

  filesDir(id: string): string {
    return path.join(this.scriptDir(id), FILES_DIR);
  }

  stateDir(id: string): string {
    return path.join(this.scriptDir(id), STATE_DIR);
  }

  /** Serialize one script's writes; reads may run freely. */
  withScript<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    const settled = next.catch(() => undefined);
    this.queues.set(id, settled);
    void settled.then(() => {
      if (this.queues.get(id) === settled) this.queues.delete(id);
    });
    return next;
  }

  async listIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.root, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory() && isScriptId(entry.name)).map((entry) => entry.name).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  readRecord(id: string): Promise<ScriptRecord | undefined> {
    return readJson<ScriptRecord>(path.join(this.scriptDir(id), RECORD_FILE));
  }

  writeRecord(record: ScriptRecord): Promise<void> {
    return atomicWrite(path.join(this.scriptDir(record.id), RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);
  }

  async deleteScript(id: string): Promise<void> {
    await rm(this.scriptDir(id), { recursive: true, force: true });
  }

  readRevision(id: string, revisionId: string): Promise<ScriptRevision | undefined> {
    if (!/^[a-zA-Z0-9-]{8,80}$/.test(revisionId)) return Promise.resolve(undefined);
    return readJson<ScriptRevision>(path.join(this.scriptDir(id), REVISIONS_DIR, `${revisionId}.json`));
  }

  writeRevision(revision: ScriptRevision): Promise<void> {
    return atomicWrite(path.join(this.scriptDir(revision.scriptId), REVISIONS_DIR, `${revision.revisionId}.json`), JSON.stringify(revision));
  }

  async deleteRevision(id: string, revisionId: string): Promise<void> {
    if (!/^[a-zA-Z0-9-]{8,80}$/.test(revisionId)) return;
    await rm(path.join(this.scriptDir(id), REVISIONS_DIR, `${revisionId}.json`), { force: true });
  }

  /** Replace the installed files with exactly these. */
  async installFiles(id: string, files: ScriptFile[]): Promise<void> {
    const target = this.filesDir(id);
    const staging = `${target}.${randomUUID()}.staging`;
    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      for (const file of files) {
        const filePath = path.join(staging, ...file.path.split("/"));
        await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
        await writeFile(filePath, file.content, { mode: 0o600 });
      }
      await rm(target, { recursive: true, force: true });
      await rename(staging, target);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    await mkdir(this.stateDir(id), { recursive: true, mode: 0o700 });
  }

  /** The installed files as they are on disk now (they may have been edited). */
  async readInstalledFiles(id: string): Promise<ScriptFile[]> {
    const root = this.filesDir(id);
    const files: ScriptFile[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile()) {
          files.push({ path: path.relative(root, full).split(path.sep).join("/"), content: await readFile(full, "utf8") });
        }
      }
    };
    await walk(root);
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  async readRuntime(id: string): Promise<ScriptRuntimeState> {
    const stored = await readJson<ScriptRuntimeState>(path.join(this.scriptDir(id), RUNTIME_FILE));
    return { ...stored, version: 1 };
  }

  writeRuntime(id: string, state: ScriptRuntimeState): Promise<void> {
    return atomicWrite(path.join(this.scriptDir(id), RUNTIME_FILE), JSON.stringify(state));
  }

  async readRate(id: string): Promise<ScriptRateState> {
    const stored = await readJson<ScriptRateState>(path.join(this.scriptDir(id), RATE_FILE));
    return {
      version: 1,
      wakeups: Array.isArray(stored?.wakeups) ? stored!.wakeups : [],
      posts: Array.isArray(stored?.posts) ? stored!.posts : [],
      idempotency: stored?.idempotency && typeof stored.idempotency === "object" ? stored.idempotency : {}
    };
  }

  writeRate(id: string, state: ScriptRateState): Promise<void> {
    return atomicWrite(path.join(this.scriptDir(id), RATE_FILE), JSON.stringify(state));
  }

  async readRuns(id: string): Promise<ScriptRunRow[]> {
    const rows = await readJson<ScriptRunRow[]>(path.join(this.scriptDir(id), RUNS_FILE));
    return Array.isArray(rows) ? rows : [];
  }

  writeRuns(id: string, rows: ScriptRunRow[]): Promise<void> {
    return atomicWrite(path.join(this.scriptDir(id), RUNS_FILE), JSON.stringify(rows));
  }

  async readHeld(id: string): Promise<ScriptHeldMessage[]> {
    const rows = await readJson<ScriptHeldMessage[]>(path.join(this.scriptDir(id), HELD_FILE));
    return Array.isArray(rows) ? rows : [];
  }

  writeHeld(id: string, rows: ScriptHeldMessage[]): Promise<void> {
    return atomicWrite(path.join(this.scriptDir(id), HELD_FILE), JSON.stringify(rows));
  }

  readPid(id: string): Promise<ScriptPidRecord | undefined> {
    return readJson<ScriptPidRecord>(path.join(this.scriptDir(id), PID_FILE));
  }

  writePid(id: string, record: ScriptPidRecord): Promise<void> {
    return atomicWrite(path.join(this.scriptDir(id), PID_FILE), JSON.stringify(record));
  }

  async clearPid(id: string): Promise<void> {
    await rm(path.join(this.scriptDir(id), PID_FILE), { force: true });
  }
}

interface StoredSecret {
  encryptedValue: string;
  protection: "os-encrypted" | "local-obfuscated";
}

interface StoredSecretsFile {
  version: 1;
  scripts: Record<string, Record<string, StoredSecret>>;
}

export interface ScriptSecretCipher {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(cipher: Buffer): string;
}

/** Script keys. A file of its own, never part of settings.json, so no
 *  settings export, snapshot or machine sync can ever carry a value. */
export class ScriptSecretStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string, private readonly cipher: ScriptSecretCipher) {}

  private async readAll(): Promise<StoredSecretsFile> {
    const stored = await readJson<StoredSecretsFile>(this.filePath);
    return { version: 1, scripts: stored?.scripts && typeof stored.scripts === "object" ? stored.scripts : {} };
  }

  private mutate(fn: (file: StoredSecretsFile) => void): Promise<void> {
    const next = this.queue.catch(() => undefined).then(async () => {
      const file = await this.readAll();
      fn(file);
      await atomicWrite(this.filePath, JSON.stringify(file));
      await chmod(this.filePath, 0o600).catch(() => undefined);
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  async savedNames(scriptId: string): Promise<string[]> {
    const file = await this.readAll();
    return Object.keys(file.scripts[scriptId] ?? {}).sort();
  }

  /** Saved key names of every script, from one read of the file. */
  async savedNamesByScript(): Promise<Record<string, string[]>> {
    const file = await this.readAll();
    return Object.fromEntries(Object.entries(file.scripts).map(([id, names]) => [id, Object.keys(names).sort()]));
  }

  /** True when values are protected by the OS keychain, not merely encoded. */
  isEncryptionAvailable(): boolean {
    try {
      return this.cipher.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  async values(scriptId: string, names: readonly string[]): Promise<Record<string, string>> {
    const file = await this.readAll();
    const stored = file.scripts[scriptId] ?? {};
    const values: Record<string, string> = {};
    for (const name of names) {
      const entry = stored[name];
      if (!entry) continue;
      const buffer = Buffer.from(entry.encryptedValue, "base64");
      values[name] = entry.protection === "os-encrypted" ? this.cipher.decryptString(buffer) : buffer.toString("utf8");
    }
    return values;
  }

  set(scriptId: string, name: string, value: string): Promise<void> {
    const encrypted: StoredSecret = this.cipher.isEncryptionAvailable()
      ? { encryptedValue: this.cipher.encryptString(value).toString("base64"), protection: "os-encrypted" }
      : { encryptedValue: Buffer.from(value, "utf8").toString("base64"), protection: "local-obfuscated" };
    return this.mutate((file) => {
      file.scripts[scriptId] = { ...(file.scripts[scriptId] ?? {}), [name]: encrypted };
    });
  }

  delete(scriptId: string, name: string): Promise<void> {
    return this.mutate((file) => {
      const current = { ...(file.scripts[scriptId] ?? {}) };
      delete current[name];
      file.scripts[scriptId] = current;
    });
  }

  deleteScript(scriptId: string): Promise<void> {
    return this.mutate((file) => {
      delete file.scripts[scriptId];
    });
  }
}
