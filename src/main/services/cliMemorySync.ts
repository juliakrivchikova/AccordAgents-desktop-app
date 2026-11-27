import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  CLI_MEMORY_SYNC_PAGE,
  type CliMemoryEntry,
  type CliMemoryProvider,
  type CliMemorySyncValue
} from "../../shared/cliMemory";
import { MEMORY_IMPORT_PAGE_BYTES, isUnknownMemoryAction } from "../../shared/memory";
import { displayPath, noteBody } from "./cliMemorySync/entryText";
import { ProjectFolders, type DeviceProject } from "./cliMemorySync/projects";
import { claudeIndexTitles, claudeMemoryEntry, codexSummaryEntry, codexTaskGroups, type ReadEntry } from "./cliMemorySync/stores";
import { claudeProjectsDir } from "./memberSessionFiles";
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
/** A file larger than this is not a memory entry. */
const ENTRY_FILE_MAX_BYTES = 1024 * 1024;

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
  private ready?: Promise<void>;
  private readonly folders: ProjectFolders;
  /** What this device sent to the server it is linked to: entry → hash. */
  private sent?: { hubId: string; hashes: Map<string, string> };
  /** Entries the server refused in this run (looked at again after a restart
   *  or once they change). */
  private readonly refused = new Map<string, string>();
  /** Per store folder: what its files were when they were last read, and the entries read. */
  private readonly read = new Map<string, { signature: string; entries: LocalEntry[] }>();
  private projectsCache?: Projects;
  private pausedUntil = 0;

  constructor(private readonly options: CliMemorySyncOptions) {
    this.folders = options.folders ?? new ProjectFolders();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
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
    if (Date.now() < this.pausedUntil) return none("paused after a failure");
    const access = this.options.access();
    const hubId = access ? await this.options.serverId().catch(() => undefined) : undefined;
    if (!access || !hubId) return none("not linked to a server");
    await this.init();
    const sent = await this.sentTo(hubId);
    const entries = await this.readStores();
    const due = entries.filter((item) => sent.get(item.key) !== item.hash && this.refused.get(item.key) !== item.hash);
    const outcomes: Record<string, number> = {};
    let count = 0;
    for (const page of pages(due)) {
      const result = await access.memory<CliMemorySyncValue>({ action: "cli-sync", entries: page.map((item) => item.entry) });
      if (!result.ok) {
        const old = isUnknownMemoryAction(result);
        this.pausedUntil = Date.now() + (old || result.error.code === "access_denied" ? OLD_SERVER_PAUSE_MS : FAILED_PAUSE_MS);
        this.options.log("cli-memory.send-failed", { code: result.error.code, message: result.error.message.slice(0, 300), olderServer: old });
        break;
      }
      const rows: string[] = [];
      const now = new Date().toISOString();
      page.forEach((item, index) => {
        const answer = result.value.results[index];
        if (!answer || answer.file !== item.entry.file || answer.provider !== item.entry.provider) return;
        outcomes[answer.outcome] = (outcomes[answer.outcome] ?? 0) + 1;
        if (answer.outcome === "refused") {
          this.refused.set(item.key, item.hash);
          this.options.log("cli-memory.entry-refused", { file: item.entry.file, reason: answer.reason?.slice(0, 200) });
          return;
        }
        sent.set(item.key, item.hash);
        rows.push(`(${quote(hubId)}, ${quote(item.key)}, ${quote(item.hash)}, ${answer.noteId ? quote(answer.noteId) : "null"}, ${quote(answer.outcome)}, ${quote(now)})`);
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
    const rows = await this.options.database().queryJson<{ key: string; hash: string }>(`select entry_key as key, entry_hash as hash
      from cli_memory_sync_state where hub_id = ${quote(hubId)};`);
    this.sent = { hubId, hashes: new Map(rows.map((row) => [row.key, row.hash])) };
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
    const override = this.options.homeOverride?.trim();
    const env = override ? {} : await this.options.env();
    const home = override || env.HOME?.trim() || homedir();
    const claudeDir = claudeProjectsDir(override ? { CLAUDE_CONFIG_DIR: path.join(override, ".claude") } : env);
    const codexDir = path.join(override ? path.join(override, ".codex") : (env.CODEX_HOME?.trim() || path.join(home, ".codex")), "memories");
    const projects = await this.projectsNow();
    return [...await this.claudeEntries(claudeDir, home, projects), ...await this.codexEntries(codexDir, home, projects)];
  }

  private async claudeEntries(projectsDir: string, home: string, projects: Projects): Promise<LocalEntry[]> {
    const folders = await readdir(projectsDir).catch(() => [] as string[]);
    const entries: LocalEntry[] = [];
    for (const folder of folders) {
      const dir = path.join(projectsDir, folder, "memory");
      const projectPath = projects.claude.get(folder);
      entries.push(...await this.readFolder(dir, `claude:${projectPath ?? ""}`, async (files) => {
        const index = files.has("MEMORY.md") ? claudeIndexTitles(await readFile(path.join(dir, "MEMORY.md"), "utf8").catch(() => "")) : new Map<string, string>();
        const read: LocalEntry[] = [];
        for (const name of [...files.keys()].sort()) {
          if (name === "MEMORY.md") continue;
          const text = await readFile(path.join(dir, name), "utf8").catch(() => undefined);
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
        const text = await readFile(path.join(dir, "MEMORY.md"), "utf8").catch(() => "");
        const file = displayPath(path.join(dir, "MEMORY.md"), home);
        for (const group of codexTaskGroups(text)) {
          const projectPath = group.cwd ? this.folders.projectFor(projects.list, group.cwd) : undefined;
          const local = this.localEntry("codex", `${file}#${group.name.slice("MEMORY.md#".length)}`, group.name, group, projectPath);
          if (local) read.push(local);
        }
      }
      if (files.has("memory_summary.md")) {
        const entry = codexSummaryEntry(await readFile(path.join(dir, "memory_summary.md"), "utf8").catch(() => ""));
        const local = entry ? this.localEntry("codex", displayPath(path.join(dir, "memory_summary.md"), home), "memory_summary.md", entry, undefined) : undefined;
        if (local) read.push(local);
      }
      return read;
    }, (name) => name === "MEMORY.md" || name === "memory_summary.md");
  }

  /** A store folder's entries: read again only when its files (or what
   *  decides their project) changed since the last look. */
  private async readFolder(
    dir: string,
    context: string,
    readEntries: (files: Map<string, string>) => Promise<LocalEntry[]>,
    wanted: (name: string) => boolean = (name) => /\.md$/i.test(name)
  ): Promise<LocalEntry[]> {
    const names = (await readdir(dir).catch(() => [] as string[])).filter(wanted);
    if (!names.length) {
      this.read.delete(dir);
      return [];
    }
    const files = new Map<string, string>();
    for (const name of names) {
      const info = await stat(path.join(dir, name)).catch(() => undefined);
      if (info?.isFile() && info.size <= ENTRY_FILE_MAX_BYTES) files.set(name, `${info.mtimeMs}:${info.size}`);
    }
    const signature = `${context}|${[...files].map(([name, mark]) => `${name}:${mark}`).sort().join("|")}`;
    const known = this.read.get(dir);
    if (known?.signature === signature) return known.entries;
    const entries = await readEntries(files);
    this.read.set(dir, { signature, entries });
    return entries;
  }

  private localEntry(provider: CliMemoryProvider, file: string, name: string, read: ReadEntry, projectPath: string | undefined): LocalEntry | undefined {
    const { body, dropped } = noteBody(read.body, file);
    if (dropped) this.options.log("cli-memory.secret-lines-left-out", { file, lines: dropped });
    if (!body || !read.title) return undefined;
    const entry: CliMemoryEntry = {
      provider, file, name, kind: read.kind, title: read.title, body, tags: read.tags,
      ...(projectPath ? { projectPath } : {})
    };
    return { key: `${provider}:${file}`, hash: createHash("sha256").update(JSON.stringify(entry)).digest("hex"), entry };
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

function quote(value: string): string {
  if (value.includes("\u0000")) throw new Error("A value with a NUL character cannot be stored.");
  return `'${value.replace(/'/g, "''")}'`;
}
