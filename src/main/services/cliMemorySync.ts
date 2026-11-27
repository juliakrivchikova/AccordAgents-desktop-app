import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  CLI_MEMORY_FILE_MAX_CHARS,
  CLI_MEMORY_NAME_MAX_CHARS,
  CLI_MEMORY_SYNC_PAGE,
  type CliMemoryEntry,
  type CliMemoryProvider,
  type CliMemorySyncValue
} from "../../shared/cliMemory";
import { MEMORY_IMPORT_PAGE_BYTES, isUnknownMemoryAction } from "../../shared/memory";
import { lineHoldsSecret } from "../../shared/secretPatterns";
import { displayPath, noteBody, noteTitle } from "./cliMemorySync/entryText";
import { ProjectFolders, type DeviceProject } from "./cliMemorySync/projects";
import { claudeIndexTitles, claudeMemoryEntry, codexSummaryEntry, codexTaskGroups, type ReadEntry } from "./cliMemorySync/stores";
import { claudeProjectsDir } from "./memberSessionFiles";
import { sqlString as quote } from "./storage/database/sqlText";
import type { MemoryServerAccess } from "./memoryTools";

/** How often the CLIs' stores are looked at (a stat of each file). */
const LOOK_INTERVAL_MS = 30_000;
/** The first look after the app starts, so it never slows the start. */
const FIRST_LOOK_MS = 10_000;
/** How often the User's projects are read again. */
const PROJECTS_REFRESH_MS = 5 * 60_000;
/** After a request without an answer, the next one waits this long. */
const FAILED_PAUSE_MS = 5 * 60_000;
/** A server older than this app keeps no CLI memory: asked again this late. */
const OLD_SERVER_PAUSE_MS = 60 * 60_000;
/** A file larger than this is not a memory entry (Claude Code: one memory
 *  per file). */
const ENTRY_FILE_MAX_BYTES = 1024 * 1024;
/** Codex keeps every task group in one handbook. */
const HANDBOOK_MAX_BYTES = 8 * 1024 * 1024;

interface Database {
  queryJson<T>(sql: string): Promise<T[]>;
  runSql(sql: string): Promise<void>;
}

export interface CliMemorySyncOptions {
  /** The User's server (ServerChatLink): members' memory goes only there. */
  access: () => MemoryServerAccess | undefined;
  /** The server this device is linked to (its id), or none yet. */
  serverId: () => Promise<string | undefined>;
  /** This device's own database: what was sent to which server. */
  database: () => Database;
  /** The environment members' CLIs run in: it says where they keep their
   *  data (HOME, CLAUDE_CONFIG_DIR, CODEX_HOME). */
  env: () => Promise<NodeJS.ProcessEnv>;
  /** The User's projects as this device has them. */
  projects: () => Promise<DeviceProject[]>;
  log: (event: string, payload: Record<string, unknown>) => void;
  /** For QA only (ACCORDAGENTS_CLI_MEMORY_HOME): read `.claude` and `.codex`
   *  under this folder instead of where members' CLIs keep them. */
  homeOverride?: string;
  folders?: ProjectFolders;
  intervalMs?: number;
  firstLookMs?: number;
}

/** One entry as this device read it. */
interface LocalEntry {
  key: string;
  hash: string;
  entry: CliMemoryEntry;
}

interface Projects {
  at: number;
  list: DeviceProject[];
  claude: Map<string, string>;
  signature: string;
}

export interface CliMemorySyncPass {
  /** Why nothing was looked at (not linked to a server, paused after a failure). */
  skipped?: string;
  entries: number;
  sent: number;
  outcomes: Record<string, number>;
}

/**
 * What members' CLIs remember on their own, kept in members' memory on the
 * User's server (shared/cliMemory.ts): every half a minute this device looks
 * at its CLIs' stores (a stat per file; a folder whose files did not change
 * is not read again) and sends the entries that are new or changed since it
 * last sent them to this server. It only reads the CLIs' files; a file that
 * went away changes nothing on the server.
 */
export class CliMemorySync {
  private timer?: NodeJS.Timeout;
  private firstLook?: NodeJS.Timeout;
  private running?: Promise<CliMemorySyncPass>;
  private stopped = true;
  /** start() was called at least once (a pass run alone by syncNow before
   *  that is never cut short). */
  private started = false;
  private ready?: Promise<void>;
  private readonly folders: ProjectFolders;
  /** What this device sent to the server it is linked to: entry → hash. */
  private sent?: { hubId: string; hashes: Map<string, string>; earlier: Map<string, string> };
  /** Entries the server refused in this run (looked at again after a restart
   *  or once they change). */
  private readonly refused = new Map<string, string>();
  /** Per store folder: what its files were when they were last read, and the entries read. */
  private readonly read = new Map<string, { signature: string; entries: LocalEntry[] }>();
  private projectsCache?: Projects;
  /** Where the CLIs keep their memory, read with the projects. */
  private storesCache?: { at: number; home: string; claudeDir: string; codexDir: string };
  /** After a failure, the server not asked again until then (that server only). */
  private paused?: { hubId: string; until: number };

  constructor(private readonly options: CliMemorySyncOptions) {
    this.folders = options.folders ?? new ProjectFolders();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.started = true;
    const tick = () => { void this.syncNow().catch((error: unknown) => this.options.log("cli-memory.error", { message: error instanceof Error ? error.message : String(error) })); };
    this.firstLook = setTimeout(tick, this.options.firstLookMs ?? FIRST_LOOK_MS);
    this.firstLook.unref?.();
    this.timer = setInterval(tick, this.options.intervalMs ?? LOOK_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** Stops looking; a pass under way is given a moment to end. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.firstLook) clearTimeout(this.firstLook);
    if (this.timer) clearInterval(this.timer);
    this.firstLook = undefined;
    this.timer = undefined;
    let wait: NodeJS.Timeout | undefined;
    await Promise.race([this.running?.catch(() => undefined), new Promise((resolve) => { wait = setTimeout(resolve, 2_000); })]);
    if (wait) clearTimeout(wait);
  }

  /** The User's projects (or where the CLIs keep their memory) changed:
   *  read again at the next look. */
  projectsChanged(): void {
    this.projectsCache = undefined;
    this.storesCache = undefined;
  }

  /** One look at the stores, and what is new or changed sent (one at a time). */
  syncNow(): Promise<CliMemorySyncPass> {
    if (this.running) return this.running;
    const run = this.pass().finally(() => { if (this.running === run) this.running = undefined; });
    this.running = run;
    return run;
  }

  private init(): Promise<void> {
    this.ready ??= this.options.database().runSql(`
      create table if not exists cli_memory_sync_state (
        hub_id text not null,
        entry_key text not null,
        entry_hash text not null,
        note_id text,
        outcome text not null,
        synced_at text not null,
        primary key (hub_id, entry_key)
      );
    `).catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  private async pass(): Promise<CliMemorySyncPass> {
    const none = (skipped: string): CliMemorySyncPass => ({ skipped, entries: 0, sent: 0, outcomes: {} });
    const access = this.options.access();
    const hubId = access ? await this.options.serverId().catch(() => undefined) : undefined;
    if (!access || !hubId) return none("not linked to a server");
    // A pause is the server's that failed: another one (or the same one
    // updated and linked again) is asked at once.
    if (this.paused?.hubId === hubId && Date.now() < this.paused.until) return none("paused after a failure");
    await this.init();
    const sent = await this.sentTo(hubId);
    const entries = await this.readStores();
    const due = entries.filter((item) => sent.get(item.key) !== item.hash && this.refused.get(item.key) !== item.hash);
    const outcomes: Record<string, number> = {};
    let count = 0;
    for (const page of pages(due)) {
      // Stopped (the app quits): nothing more is sent or written.
      if (this.stopped && this.started) break;
      // The first time to this server: the note the entry filled on the one before.
      const entriesSent = page.map((item) => {
        const knownNoteId = sent.has(item.key) ? undefined : this.sent?.earlier.get(item.key);
        return knownNoteId ? { ...item.entry, knownNoteId } : item.entry;
      });
      const result = await access.memory<CliMemorySyncValue>({ action: "cli-sync", entries: entriesSent });
      if (this.stopped && this.started) break;
      if (!result.ok) {
        const old = isUnknownMemoryAction(result);
        this.paused = { hubId, until: Date.now() + (old || result.error.code === "access_denied" ? OLD_SERVER_PAUSE_MS : FAILED_PAUSE_MS) };
        this.options.log("cli-memory.send-failed", { code: result.error.code, message: result.error.message.slice(0, 300), olderServer: old });
        break;
      }
      const rows: string[] = [];
      const now = new Date().toISOString();
      page.forEach((item, index) => {
        const answer = result.value.results[index];
        // An answer that is not this entry's is taken as a refusal: the
        // entry is not sent again until it changes (never every look).
        const matched = Boolean(answer && answer.file === item.entry.file && answer.provider === item.entry.provider);
        const outcome = matched ? answer!.outcome : "refused";
        outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
        if (outcome === "refused") {
          this.refused.set(item.key, item.hash);
          this.options.log("cli-memory.entry-refused", { file: item.entry.file, reason: matched ? answer!.reason?.slice(0, 200) : "the server's answer did not name this entry" });
          return;
        }
        sent.set(item.key, item.hash);
        rows.push(`(${quote(hubId)}, ${quote(item.key)}, ${quote(item.hash)}, ${answer!.noteId ? quote(answer!.noteId) : "null"}, ${quote(outcome)}, ${quote(now)})`);
      });
      count += page.length;
      if (rows.length) {
        await this.options.database().runSql(`insert or replace into cli_memory_sync_state(hub_id, entry_key, entry_hash, note_id, outcome, synced_at) values ${rows.join(", ")};`);
      }
    }
    if (count) this.options.log("cli-memory.synced", { entries: entries.length, sent: count, ...outcomes });
    return { entries: entries.length, sent: count, outcomes };
  }

  /** What this device sent to this server before (read once per server). */
  private async sentTo(hubId: string): Promise<Map<string, string>> {
    if (this.sent?.hubId === hubId) return this.sent.hashes;
    // What another server refused is offered to this one.
    this.refused.clear();
    const rows = await this.options.database().queryJson<{ key: string; hash: string }>(`select entry_key as key, entry_hash as hash
      from cli_memory_sync_state where hub_id = ${quote(hubId)};`);
    // The notes the entries filled on other servers, the latest last.
    const earlier = await this.options.database().queryJson<{ key: string; noteId: string }>(`select entry_key as key, note_id as noteId
      from cli_memory_sync_state where hub_id <> ${quote(hubId)} and note_id is not null order by synced_at;`);
    this.sent = { hubId, hashes: new Map(rows.map((row) => [row.key, row.hash])), earlier: new Map(earlier.map((row) => [row.key, row.noteId])) };
    return this.sent.hashes;
  }

  private async projectsNow(): Promise<Projects> {
    if (this.projectsCache && Date.now() - this.projectsCache.at < PROJECTS_REFRESH_MS) return this.projectsCache;
    const list = await this.options.projects().catch((error: unknown) => {
      this.options.log("cli-memory.projects-failed", { message: error instanceof Error ? error.message : String(error) });
      return this.projectsCache?.list ?? [];
    });
    const claude = await this.folders.claudeFolders(list);
    this.projectsCache = { at: Date.now(), list, claude, signature: JSON.stringify(list.map((project) => [project.projectPath, project.localPath]).sort()) };
    return this.projectsCache;
  }

  private async readStores(): Promise<LocalEntry[]> {
    const { home, claudeDir, codexDir } = await this.storesNow();
    const projects = await this.projectsNow();
    return [...await this.claudeEntries(claudeDir, home, projects), ...await this.codexEntries(codexDir, home, projects)];
  }

  /** Where members' CLIs keep their memory (members' environment, read
   *  again with the projects: it decrypts Settings → Environment). */
  private async storesNow(): Promise<{ home: string; claudeDir: string; codexDir: string }> {
    if (this.storesCache && Date.now() - this.storesCache.at < PROJECTS_REFRESH_MS) return this.storesCache;
    const override = this.options.homeOverride?.trim();
    const env = override ? {} : await this.options.env();
    const home = override || env.HOME?.trim() || homedir();
    const claudeDir = claudeProjectsDir(override ? { CLAUDE_CONFIG_DIR: path.join(override, ".claude") } : env);
    const codexDir = path.join(override ? path.join(override, ".codex") : (env.CODEX_HOME?.trim() || path.join(home, ".codex")), "memories");
    this.storesCache = { at: Date.now(), home, claudeDir, codexDir };
    return this.storesCache;
  }

  private async claudeEntries(projectsDir: string, home: string, projects: Projects): Promise<LocalEntry[]> {
    const folders = await readdir(projectsDir).catch(() => [] as string[]);
    const entries: LocalEntry[] = [];
    for (const folder of folders) {
      const dir = path.join(projectsDir, folder, "memory");
      // A link out of the store is never followed (an agent could point one
      // at files it may not read itself).
      if (!await realDirectory(path.join(projectsDir, folder)) || !await realDirectory(dir)) {
        this.read.delete(dir);
        continue;
      }
      const projectPath = projects.claude.get(folder);
      entries.push(...await this.readFolder(dir, `claude:${projectPath ?? ""}`, async (files) => {
        const index = files.has("MEMORY.md") ? claudeIndexTitles(await readRegularFile(path.join(dir, "MEMORY.md")) ?? "") : new Map<string, string>();
        const read: LocalEntry[] = [];
        for (const name of [...files.keys()].sort()) {
          if (name === "MEMORY.md") continue;
          const text = await readRegularFile(path.join(dir, name));
          const entry = text === undefined ? undefined : claudeMemoryEntry(name, text, index.get(name));
          if (!entry) continue;
          const file = displayPath(path.join(dir, name), home);
          // Two folders of no project the app knows are two places: the
          // folder is part of what the entry is.
          const local = this.localEntry("claude-code", file, projectPath ? name : `${folder}/${name}`, entry, projectPath);
          if (local) read.push(local);
        }
        return read;
      }));
    }
    return entries;
  }

  private async codexEntries(dir: string, home: string, projects: Projects): Promise<LocalEntry[]> {
    return this.readFolder(dir, `codex:${projects.signature}`, async (files) => {
      const read: LocalEntry[] = [];
      if (files.has("MEMORY.md")) {
        const text = await readRegularFile(path.join(dir, "MEMORY.md"), HANDBOOK_MAX_BYTES) ?? "";
        const file = displayPath(path.join(dir, "MEMORY.md"), home);
        for (const group of codexTaskGroups(text)) {
          const projectPath = group.cwd ? this.folders.projectFor(projects.list, group.cwd) : undefined;
          const local = this.localEntry("codex", `${file}#${group.name.slice("MEMORY.md#".length)}`, group.name, group, projectPath);
          if (local) read.push(local);
        }
      }
      if (files.has("memory_summary.md")) {
        const entry = codexSummaryEntry(await readRegularFile(path.join(dir, "memory_summary.md")) ?? "");
        const local = entry ? this.localEntry("codex", displayPath(path.join(dir, "memory_summary.md"), home), "memory_summary.md", entry, undefined) : undefined;
        if (local) read.push(local);
      }
      return read;
    }, (name) => name === "MEMORY.md" || name === "memory_summary.md", (name) => name === "MEMORY.md" ? HANDBOOK_MAX_BYTES : ENTRY_FILE_MAX_BYTES);
  }

  /** A store folder's entries: read again only when its files (or what
   *  decides their project) changed since the last look. */
  private async readFolder(
    dir: string,
    context: string,
    readEntries: (files: Map<string, string>) => Promise<LocalEntry[]>,
    wanted: (name: string) => boolean = (name) => /\.md$/i.test(name),
    maxBytes: (name: string) => number = () => ENTRY_FILE_MAX_BYTES
  ): Promise<LocalEntry[]> {
    const names = (await readdir(dir).catch(() => [] as string[])).filter(wanted);
    if (!names.length) {
      this.read.delete(dir);
      return [];
    }
    const files = new Map<string, string>();
    for (const name of names) {
      // Regular files only: a link is not followed.
      const info = await lstat(path.join(dir, name)).catch(() => undefined);
      if (!info?.isFile()) continue;
      if (info.size > maxBytes(name)) {
        if (!skippedLarge.has(path.join(dir, name))) this.options.log("cli-memory.entry-skipped", { file: path.join(dir, name), reason: "too large", bytes: info.size });
        skippedLarge.add(path.join(dir, name));
        continue;
      }
      files.set(name, `${info.mtimeMs}:${info.size}`);
    }
    const signature = `${context}|${[...files].map(([name, mark]) => `${name}:${mark}`).sort().join("|")}`;
    const known = this.read.get(dir);
    if (known?.signature === signature) return known.entries;
    const entries = await readEntries(files);
    this.read.set(dir, { signature, entries });
    return entries;
  }

  private localEntry(provider: CliMemoryProvider, file: string, name: string, read: ReadEntry, projectPath: string | undefined): LocalEntry | undefined {
    // Beyond what the server keeps for a file's name: not sent (said once).
    if ([...file].length > CLI_MEMORY_FILE_MAX_CHARS || [...name].length > CLI_MEMORY_NAME_MAX_CHARS) {
      this.options.log("cli-memory.entry-skipped", { file: [...file].slice(0, 200).join(""), reason: "its file name is too long" });
      return undefined;
    }
    const { body, dropped } = noteBody(read.body, file);
    // A title that looks like it holds a secret gives way to the entry's name.
    const title = lineHoldsSecret(read.title) ? noteTitle((name.split(/[/#]/).pop() ?? name).replace(/\.md$/i, "").replace(/[-_]+/g, " ")) : read.title;
    if (dropped || title !== read.title) this.options.log("cli-memory.secret-lines-left-out", { file, lines: dropped, title: title !== read.title });
    if (!body || !title) return undefined;
    const entry: CliMemoryEntry = {
      provider, file, name, kind: read.kind, title, body, tags: read.tags,
      ...(projectPath ? { projectPath } : {})
    };
    return { key: `${provider}:${file}`, hash: createHash("sha256").update(JSON.stringify(entry)).digest("hex"), entry };
  }
}

/** Files left out for their size, said once per run. */
const skippedLarge = new Set<string>();

async function realDirectory(dir: string): Promise<boolean> {
  return (await lstat(dir).catch(() => undefined))?.isDirectory() === true;
}

/** A regular file's text, never through a link (also not one put there
 *  after it was looked at); undefined when it cannot be read so. */
async function readRegularFile(file: string, maxBytes = ENTRY_FILE_MAX_BYTES): Promise<string | undefined> {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => undefined);
  if (!handle) return undefined;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) return undefined;
    return await handle.readFile("utf8");
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Entries in requests under the server's limits (count and size). */
function pages(entries: LocalEntry[]): LocalEntry[][] {
  const out: LocalEntry[][] = [];
  let page: LocalEntry[] = [];
  let size = 0;
  for (const item of entries) {
    const itemSize = Buffer.byteLength(JSON.stringify(item.entry)) + 1;
    if (page.length && (page.length >= CLI_MEMORY_SYNC_PAGE || size + itemSize > MEMORY_IMPORT_PAGE_BYTES)) {
      out.push(page);
      page = [];
      size = 0;
    }
    page.push(item);
    size += itemSize;
  }
  if (page.length) out.push(page);
  return out;
}
