import { createHash, randomUUID } from "node:crypto";
import type { HubDevice } from "../shared/hubProtocol";
import {
  CLI_MEMORY_AUTHORS,
  CLI_MEMORY_FILE_MAX_CHARS,
  CLI_MEMORY_LABELS,
  CLI_MEMORY_NAME_MAX_CHARS,
  CLI_MEMORY_PROVIDERS,
  CLI_MEMORY_SYNC_PAGE,
  CLI_MEMORY_TAG,
  type CliMemoryProvider,
  type CliMemorySyncOutcome,
  type CliMemorySyncResult,
  type CliMemorySyncValue
} from "../shared/cliMemory";
import {
  MEMORY_BODY_MAX_BYTES,
  MEMORY_LIVE_NOTES_MAX,
  MEMORY_SOURCE_MAX_CHARS,
  MEMORY_TAGS_MAX,
  MEMORY_TAG_MAX_CHARS,
  MEMORY_TITLE_MAX_CHARS,
  isMemoryNoteKind,
  memoryTitleKey,
  normalizeMemoryTags,
  type MemoryNoteKind,
  type MemoryResult,
  type MemoryScope
} from "../shared/memory";
import { BUMP_SQL, SEQ_SQL, SUMMARY_COLUMNS, parseTags, quote, searchText, type Row } from "./memoryRows";

/**
 * Which entry of which device's CLI memory fills which note, and the version
 * the sync last wrote each such note at (a later version is a member's or
 * the User's change, never overwritten).
 */
const SCHEMA_SQL = `
  create table if not exists member_memory_cli_sources (
    -- The provider, the device and the entry's file on it.
    source_key text primary key,
    device_id text not null,
    provider text not null,
    file text not null,
    note_id text,
    -- What the entry held when it was last sent (empty: send it again).
    content_hash text not null,
    updated_at text not null
  );
  create table if not exists member_memory_cli_notes (
    note_id text primary key,
    -- The provider, the note's place and the entry's name in its store: the
    -- same entry on two devices is one note.
    identity_key text not null,
    synced_version integer not null
  );
  create index if not exists member_memory_cli_notes_identity on member_memory_cli_notes(identity_key);
`;

export interface HubCliMemoryDependencies {
  query<T>(sql: string): Promise<T[]>;
  run(sql: string): Promise<void>;
  now(): Date;
  log(event: string, payload: Record<string, unknown>): void;
  /** A note created or changed (printed again for search by meaning). */
  noteChanged(note: { id: string; title: string; tags: string[]; body: string }): void;
  /** Whether a cloud machine hosts a member in a chat of this project. */
  machineHostsProject(device: HubDevice, projectPath: string): Promise<boolean>;
}

/** An entry as the server keeps it: checked, its place decided. */
interface Placed {
  provider: CliMemoryProvider;
  file: string;
  name: string;
  kind: MemoryNoteKind;
  scope: MemoryScope;
  scopeKey: string;
  title: string;
  body: string;
  tags: string[];
  source: string;
  author: string;
}

/**
 * What members' CLIs remember on their own, one note per entry
 * (shared/cliMemory.ts). A device sends the entries that are new or changed;
 * each is matched to its note by the provider, the device and its file, and
 * the same entry seen on another device fills the same note. A note a member
 * or the User changed since the sync last wrote it is never overwritten, a
 * note she deleted is not made again, and nothing is deleted because a file
 * went away. Runs inside HubMemory's order of changes.
 */
export class HubCliMemory {
  private ready?: Promise<void>;

  constructor(private readonly deps: HubCliMemoryDependencies) {}

  private init(): Promise<void> {
    this.ready ??= this.deps.run(SCHEMA_SQL).catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  async sync(device: HubDevice, raw: unknown): Promise<MemoryResult<CliMemorySyncValue>> {
    if (device.role !== "owner" && device.role !== "machine") {
      return { ok: false, error: { code: "access_denied", message: "Only the computer that set up this server and its cloud machines send what their CLIs remember." } };
    }
    if (!Array.isArray(raw) || raw.length > CLI_MEMORY_SYNC_PAGE) {
      return { ok: false, error: { code: "invalid_request", message: `Send between 0 and ${CLI_MEMORY_SYNC_PAGE} entries at a time.` } };
    }
    await this.init();
    const projects = new Map<string, boolean>();
    const results: CliMemorySyncResult[] = [];
    for (const item of raw as unknown[]) results.push(await this.syncOne(device, item, projects));
    const counts: Record<string, number> = {};
    for (const result of results) counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
    this.deps.log("hub.memory.cli-synced", { deviceId: device.deviceId, entries: results.length, ...counts });
    return { ok: true, value: { results } };
  }

  private async syncOne(device: HubDevice, item: unknown, projects: Map<string, boolean>): Promise<CliMemorySyncResult> {
    const named = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const echo = {
      provider: (CLI_MEMORY_PROVIDERS as readonly unknown[]).includes(named.provider) ? named.provider as CliMemoryProvider : "claude-code",
      file: typeof named.file === "string" ? named.file.slice(0, CLI_MEMORY_FILE_MAX_CHARS) : ""
    };
    const placed = await this.place(device, named, projects);
    if (typeof placed === "string") return { ...echo, outcome: "refused", reason: placed };
    const sourceKey = digest([placed.provider, device.deviceId, placed.file]);
    const identity = digest([placed.provider, placed.scope, placed.scopeKey, placed.name]);
    const hash = digest([placed.kind, placed.scope, placed.scopeKey, placed.title, placed.body, JSON.stringify(placed.tags), placed.source]);
    const known = (await this.deps.query<{ noteId: string | null; contentHash: string }>(`select note_id as noteId, content_hash as contentHash
      from member_memory_cli_sources where source_key = ${quote(sourceKey)};`))[0];
    if (known?.noteId && known.contentHash === hash) return { ...echo, outcome: "unchanged", noteId: known.noteId };
    // The note this entry filled before; or the one the same entry fills
    // from another device (or filled before it moved to another place).
    let noteId = known?.noteId ?? (await this.deps.query<{ noteId: string }>(`select c.note_id as noteId from member_memory_cli_notes c
      join member_memory_notes n on n.id = c.note_id where c.identity_key = ${quote(identity)} order by n.created_at limit 1;`))[0]?.noteId;
    let outcome: { outcome: CliMemorySyncOutcome; reason?: string };
    if (noteId) {
      outcome = await this.applyTo(noteId, placed, identity, device);
    } else {
      const titled = (await this.deps.query<Row>(`select ${SUMMARY_COLUMNS} from member_memory_notes where archived_at is null
        and kind = ${quote(placed.kind)} and scope = ${quote(placed.scope)} and scope_key = ${quote(placed.scopeKey)}
        and title_key = ${quote(memoryTitleKey(placed.title))} limit 1;`))[0];
      if (titled && titled.author === placed.author && titled.updatedBy === placed.author) {
        // The sync's own note from before (a server the notes moved to keeps
        // no record of what filled them): it is the sync's to keep up to date.
        noteId = titled.id;
        await this.deps.run(`insert or replace into member_memory_cli_notes(note_id, identity_key, synced_version)
          values (${quote(titled.id)}, ${quote(identity)}, ${Number(titled.version)});`);
        outcome = await this.applyTo(titled.id, placed, identity, device);
      } else if (titled) {
        // A member wrote this already: theirs is kept, this entry follows it.
        noteId = titled.id;
        outcome = { outcome: "kept", reason: `@${titled.author} keeps a note with this title.` };
      } else {
        const created = await this.create(placed, identity, device);
        if ("reason" in created) outcome = { outcome: "refused", reason: created.reason };
        else {
          noteId = created.id;
          outcome = { outcome: "created" };
        }
      }
    }
    // A refusal is looked at again when the entry is sent again.
    const keep = outcome.outcome === "refused" ? { noteId: null, hash: "" } : { noteId: noteId ?? null, hash };
    await this.deps.run(`insert into member_memory_cli_sources(source_key, device_id, provider, file, note_id, content_hash, updated_at) values (
      ${quote(sourceKey)}, ${quote(device.deviceId)}, ${quote(placed.provider)}, ${quote(placed.file)}, ${keep.noteId ? quote(keep.noteId) : "null"},
      ${quote(keep.hash)}, ${quote(this.deps.now().toISOString())}) on conflict(source_key) do update set file = excluded.file,
      note_id = coalesce(excluded.note_id, member_memory_cli_sources.note_id), content_hash = excluded.content_hash, updated_at = excluded.updated_at;`);
    if (outcome.outcome === "kept" || outcome.outcome === "deleted" || outcome.outcome === "refused") {
      this.deps.log("hub.memory.cli-entry-not-applied", { deviceId: device.deviceId, provider: placed.provider, outcome: outcome.outcome, noteId, reason: outcome.reason });
    }
    return { ...echo, outcome: outcome.outcome, ...(noteId && outcome.outcome !== "refused" ? { noteId } : {}), ...(outcome.reason ? { reason: outcome.reason } : {}) };
  }

  /** The entry checked as strictly as a member's write, and its place. */
  private async place(device: HubDevice, item: Record<string, unknown>, projects: Map<string, boolean>): Promise<Placed | string> {
    const provider = item.provider;
    if (!(CLI_MEMORY_PROVIDERS as readonly unknown[]).includes(provider)) return "Not a CLI whose memory is kept.";
    const cli = provider as CliMemoryProvider;
    const texts = [item.file, item.name, item.title, item.body];
    if (texts.some((text) => typeof text !== "string" || !text.trim() || text.includes("\u0000"))) return "The entry has no file, name, title or body.";
    const file = (item.file as string).trim();
    const name = (item.name as string).trim();
    if ([...file].length > CLI_MEMORY_FILE_MAX_CHARS || [...name].length > CLI_MEMORY_NAME_MAX_CHARS) return "The entry's file name is too long.";
    if (!isMemoryNoteKind(item.kind)) return "kind is runbook, article or status.";
    const title = (item.title as string).replace(/\s+/g, " ").trim();
    if ([...title].length > MEMORY_TITLE_MAX_CHARS) return `The title is over ${MEMORY_TITLE_MAX_CHARS} characters.`;
    const body = (item.body as string).trim();
    if (Buffer.byteLength(body) > MEMORY_BODY_MAX_BYTES) return `The body is over ${MEMORY_BODY_MAX_BYTES / 1024} KB.`;
    if (!Array.isArray(item.tags)) return "tags is a list of words.";
    const tags = normalizeMemoryTags([CLI_MEMORY_TAG, cli, ...item.tags]).filter((tag) => [...tag].length <= MEMORY_TAG_MAX_CHARS && !tag.includes("\u0000")).slice(0, MEMORY_TAGS_MAX);
    let scope: MemoryScope = "global";
    let scopeKey = "";
    if (item.projectPath !== undefined) {
      const projectPath = typeof item.projectPath === "string" ? item.projectPath.trim() : "";
      if (!projectPath || projectPath.includes("\u0000") || projectPath.length > 4096) return "The project is not a folder path.";
      // The computer names its own projects; a cloud machine only those it
      // hosts a member of, as its members could write there themselves.
      if (device.role !== "owner") {
        if (!projects.has(projectPath)) projects.set(projectPath, await this.deps.machineHostsProject(device, projectPath));
        if (!projects.get(projectPath)) return "This machine hosts no member in a chat of that project.";
      }
      scope = "project";
      scopeKey = projectPath;
    }
    // A task status is never for every chat (as for members' notes).
    const kind = item.kind === "status" && scope === "global" ? "article" : item.kind;
    const source = `${CLI_MEMORY_LABELS[cli]} memory: ${file} on ${device.name || device.deviceId}`;
    return {
      provider: cli, file, name, kind, scope, scopeKey, title, body, tags,
      source: [...source].length > MEMORY_SOURCE_MAX_CHARS ? `${[...source].slice(0, MEMORY_SOURCE_MAX_CHARS - 1).join("")}…` : source,
      author: CLI_MEMORY_AUTHORS[cli]
    };
  }

  private async create(placed: Placed, identity: string, device: HubDevice): Promise<{ id: string } | { reason: string }> {
    const live = await this.deps.query<{ total: number }>("select count(*) as total from member_memory_notes where archived_at is null;");
    if (Number(live[0]?.total ?? 0) >= MEMORY_LIVE_NOTES_MAX) return { reason: `The server already keeps ${MEMORY_LIVE_NOTES_MAX} notes.` };
    const id = randomUUID();
    const now = this.deps.now().toISOString();
    await this.deps.run(`${BUMP_SQL} insert into member_memory_notes(id, kind, title, title_key, tags_json, scope, scope_key, source, author, updated_by,
      version, created_at, updated_at, verified_at, awaiting_repository, change_seq, body, search_text) values (
      ${quote(id)}, ${quote(placed.kind)}, ${quote(placed.title)}, ${quote(memoryTitleKey(placed.title))}, ${quote(JSON.stringify(placed.tags))},
      ${quote(placed.scope)}, ${quote(placed.scopeKey)}, ${quote(placed.source)}, ${quote(placed.author)}, ${quote(placed.author)},
      1, ${quote(now)}, ${quote(now)}, ${quote(now)}, 0, ${SEQ_SQL}, ${quote(placed.body)}, ${quote(searchText(placed))});
      insert or replace into member_memory_cli_notes(note_id, identity_key, synced_version) values (${quote(id)}, ${quote(identity)}, 1);`);
    this.deps.log("hub.memory.created", { noteId: id, kind: placed.kind, scope: placed.scope, deviceId: device.deviceId, cliMemory: placed.provider });
    this.deps.noteChanged({ id, title: placed.title, tags: placed.tags, body: placed.body });
    return { id };
  }

  /** The entry as it is now, into the note it fills, unless a member or the
   *  User changed that note since the sync last wrote it. */
  private async applyTo(noteId: string, placed: Placed, identity: string, device: HubDevice): Promise<{ outcome: CliMemorySyncOutcome; reason?: string }> {
    const row = (await this.deps.query<Row>(`select ${SUMMARY_COLUMNS}, body from member_memory_notes where id = ${quote(noteId)};`))[0];
    if (!row) return { outcome: "deleted", reason: "The User deleted this note." };
    const synced = (await this.deps.query<{ version: number }>(`select synced_version as version from member_memory_cli_notes where note_id = ${quote(noteId)};`))[0];
    const version = Number(row.version);
    // The server archiving a stale status is no one's change of it.
    const untouched = synced && (version === Number(synced.version) || (version === Number(synced.version) + 1 && row.updatedBy === "server" && Boolean(row.archivedAt)));
    if (!untouched) {
      return { outcome: "kept", reason: synced ? `@${row.updatedBy} changed this note since; it is kept as it is.` : `@${row.author} keeps a note with this title.` };
    }
    const same = row.kind === placed.kind && row.scope === placed.scope && row.scopeKey === placed.scopeKey && row.title === placed.title &&
      (row.body ?? "") === placed.body && JSON.stringify(parseTags(row.tagsJson)) === JSON.stringify(placed.tags) && !row.archivedAt;
    if (same) {
      await this.deps.run(`update member_memory_cli_notes set identity_key = ${quote(identity)} where note_id = ${quote(noteId)};`);
      return { outcome: "unchanged" };
    }
    const taken = (await this.deps.query<{ id: string; author: string }>(`select id, author from member_memory_notes where archived_at is null
      and kind = ${quote(placed.kind)} and scope = ${quote(placed.scope)} and scope_key = ${quote(placed.scopeKey)}
      and title_key = ${quote(memoryTitleKey(placed.title))} and id <> ${quote(noteId)} limit 1;`))[0];
    if (taken) return { outcome: "refused", reason: `Another note here has this title (id ${taken.id}).` };
    const now = this.deps.now().toISOString();
    await this.deps.run(`${BUMP_SQL} update member_memory_notes set kind = ${quote(placed.kind)}, title = ${quote(placed.title)},
      title_key = ${quote(memoryTitleKey(placed.title))}, body = ${quote(placed.body)}, tags_json = ${quote(JSON.stringify(placed.tags))},
      search_text = ${quote(searchText(placed))}, scope = ${quote(placed.scope)}, scope_key = ${quote(placed.scopeKey)}, source = ${quote(placed.source)},
      awaiting_repository = 0, archived_at = null, updated_by = ${quote(placed.author)}, version = version + 1, updated_at = ${quote(now)},
      verified_at = ${quote(now)}, change_seq = ${SEQ_SQL} where id = ${quote(noteId)} and version = ${version};
      update member_memory_cli_notes set synced_version = ${version + 1}, identity_key = ${quote(identity)} where note_id = ${quote(noteId)};`);
    this.deps.log("hub.memory.updated", { noteId, version: version + 1, deviceId: device.deviceId, cliMemory: placed.provider });
    this.deps.noteChanged({ id: noteId, title: placed.title, tags: placed.tags, body: placed.body });
    return { outcome: "updated" };
  }
}

function digest(parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 40);
}
