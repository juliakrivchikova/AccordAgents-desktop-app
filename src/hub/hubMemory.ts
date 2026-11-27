import { createHash, randomUUID } from "node:crypto";
import type { ChatSearchService } from "../main/services/chatSearch";
import type { StorageService } from "../main/services/storage";
import type { HubDevice } from "../shared/hubProtocol";
import type { ChatParticipant, Conversation } from "../shared/types";
import {
  MEMORY_BODY_MAX_BYTES,
  MEMORY_EXPORT_PAGE,
  MEMORY_INDEX_MAX_NOTES,
  MEMORY_INDEX_MAX_TAGS,
  MEMORY_INDEX_STALE_DAYS,
  MEMORY_LIST_MAX,
  MEMORY_LIVE_NOTES_MAX,
  MEMORY_PICK_MAX,
  MEMORY_QUERY_MAX_CHARS,
  MEMORY_SEARCH_DEFAULT_LIMIT,
  MEMORY_SEARCH_MAX_LIMIT,
  MEMORY_SOURCE_MAX_CHARS,
  MEMORY_STATUS_STALE_DAYS,
  MEMORY_SWEEP_INTERVAL_MS,
  MEMORY_TAGS_MAX_LISTED,
  MEMORY_TAG_MAX_CHARS,
  MEMORY_TAGS_MAX,
  MEMORY_TITLE_MAX_CHARS,
  isMemoryNoteKind,
  isMemoryScope,
  memoryTitleKey,
  normalizeMemoryTags,
  type HubMemoryRequest,
  type MemoryError,
  type MemoryExportValue,
  type MemoryImportValue,
  type MemoryIndexValue,
  type MemoryMemberRef,
  type MemoryNote,
  type MemoryNoteKind,
  type MemoryNoteSummary,
  type MemoryOwnerListValue,
  type MemoryPickValue,
  type MemoryResult,
  type MemoryScope,
  type MemorySearchHit,
  type MemorySearchValue,
  type MemoryTagCount,
  type MemoryTagsValue
} from "../shared/memory";
import { homeDeviceId } from "./hubOps";
import { HubCliMemory } from "./hubCliMemory";
import { BUMP_SQL, SEQ_SQL, SUMMARY_COLUMNS, noteOf, parseTags, quote, searchText, summaryOf, type Row } from "./memoryRows";
import { candidateAnchors, rankCounted, searchWords as wordsAsked, snippetOf, wordCounts, type SearchWord } from "./memoryWordSearch";
import type { HubSemantic, PrintableNote } from "./semantic/hubSemantic";
import { searchProjectChats } from "./semantic/projectChatSearch";
import { NOTE_PASSAGE_CHARS, QUERY_MAX_CHARS, passageRanges, takeTurns } from "./semantic/semanticVectors";

const SCHEMA_SQL = `
  create table if not exists member_memory_notes (
    id text primary key,
    kind text not null,
    title text not null,
    title_key text not null,
    tags_json text not null,
    scope text not null,
    scope_key text not null,
    source text,
    author text not null,
    updated_by text not null,
    version integer not null,
    created_at text not null,
    updated_at text not null,
    verified_at text,
    last_read_at text,
    awaiting_repository integer not null default 0,
    archived_at text,
    -- The order of changes, for the owner's copy (export).
    change_seq integer not null default 0,
    -- The member's own retry keys (device, chat, member and its requestId),
    -- with what the request asked, so a retry is told from a reuse.
    create_request_key text unique,
    create_request_hash text,
    last_request text,
    -- Large columns last: filters and sorting never read past them.
    body text not null,
    search_text text not null
  );
  create index if not exists member_memory_notes_scope on member_memory_notes(scope, scope_key);
  create index if not exists member_memory_notes_live on member_memory_notes(archived_at, kind, updated_at);
`;
/** Columns added after the table was first made (a server from an earlier build). */
const ADDED_COLUMNS: Array<{ column: string; definition: string }> = [
  { column: "change_seq", definition: "integer not null default 0" }
];
const CHANGE_INDEX_SQL = "create index if not exists member_memory_notes_changes on member_memory_notes(change_seq, id);";
/** The order of changes only goes up (a delete never frees a number), and a
 *  deleted note is kept as a mark with its place, so the owner's copy learns
 *  of every change and every deletion. */
const ORDER_SQL = `
  create table if not exists member_memory_counter (key text primary key, value integer not null);
  create table if not exists member_memory_deleted (id text primary key, change_seq integer not null, deleted_at text not null);
  create index if not exists member_memory_deleted_changes on member_memory_deleted(change_seq, id);
  insert or ignore into member_memory_counter(key, value) values ('change_seq',
    max((select coalesce(max(change_seq), 0) from member_memory_notes), (select coalesce(max(change_seq), 0) from member_memory_deleted)));
`;

const DAY_MS = 24 * 60 * 60_000;
/** Notes counted for a search before the server answers other requests. */
const COUNT_BATCH = 50;
/**
 * Notes picked for a message by meaning (prints of 1536 numbers), tuned on
 * the User's notes and messages (2026-11-26: 37 queries with known answers,
 * 60 of her real messages): a note at least this close, and close to the
 * closest one, fits. Her real messages got notes about one time in five,
 * and nothing for "ok", "done" or "I'm home".
 */
const PICK_MIN = 0.4;
const PICK_GAP = 0.07;
/** A note further than this in meaning is not given by a search (it may
 *  still come for a word it holds). */
const SEARCH_MEANING_MIN = 0.15;
const PICK_PRINT_TIMEOUT_MS = 3_000;
const SEARCH_PRINT_TIMEOUT_MS = 4_000;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const NOTE_ID = /^[A-Za-z0-9-]{8,64}$/;

/** The member a request is for, as the server's copy of the chat has it. */
export interface MemberContext {
  conversationId: string;
  participantId: string;
  deviceId: string;
  handle: string;
  roleId: string;
  /** The chat's project folder, when the chat has one. */
  projectPath?: string;
}

/**
 * Members' long-term memory on the User's server (shared/memory.ts). The
 * server decides who sees and changes a note from its own copy of the chat a
 * member acts in: the member must be in that chat and run on the device that
 * asks (as for documents, Д4), and its role and project are the chat's.
 * Changes are made one at a time, so a version check and its write never
 * interleave with another change.
 */
export class HubMemory {
  private ready?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  /** When stale statuses were last archived (at most every few minutes). */
  private sweptAt?: number;

  private readonly semantic?: HubSemantic;
  private readonly chatSearch?: ChatSearchService;
  /** What members' CLIs remember on their own (shared/cliMemory.ts). */
  private readonly cliMemory: HubCliMemory;

  constructor(
    private readonly storage: StorageService,
    private readonly log: (event: string, payload: Record<string, unknown>) => void = () => undefined,
    private readonly now: () => Date = () => new Date(),
    /** Search by meaning (the User's OpenAI key) and the chats' word index. */
    search: { semantic?: HubSemantic; chatSearch?: ChatSearchService } = {}
  ) {
    this.semantic = search.semantic;
    this.chatSearch = search.chatSearch;
    this.semantic?.setNoteSource({ notesPage: (afterId, limit) => this.notesPage(afterId, limit) });
    this.cliMemory = new HubCliMemory({
      query: (sql) => this.query(sql),
      run: (sql) => this.run(sql),
      now: () => this.now(),
      log: (event, payload) => this.log(event, payload),
      noteChanged: (note) => this.semantic?.noteChanged(note),
      machineHosts: (device, projectPath) => this.machineHosts(device, projectPath)
    });
  }

  /** Whether a cloud machine hosts a member in a chat of this project, or
   *  in any chat without one (the chats' members only: a chat's body can be
   *  large). */
  private async machineHosts(device: HubDevice, projectPath: string | undefined): Promise<boolean> {
    if (device.role !== "machine" || !device.machineId) return false;
    const rows = await this.query<{ participantsJson: string | null }>(`select json_extract(coalesce(nullif(body_json, ''), payload_json), '$.metadata.participants') as participantsJson
      from conversations where kind = 'chat' and ${projectPath === undefined ? `instr(coalesce(nullif(body_json, ''), payload_json), ${quote(JSON.stringify(device.machineId))}) > 0` : `repo_path = ${quote(projectPath)}`};`);
    return rows.some((row) => {
      try {
        const participants = JSON.parse(row.participantsJson ?? "[]") as unknown;
        return Array.isArray(participants) && participants.some((participant) => (participant as { homeMachineId?: unknown } | null)?.homeMachineId === device.machineId);
      } catch {
        return false;
      }
    });
  }

  /** Notes not archived, by id, as they are printed (HubSemantic). */
  private async notesPage(afterId: string, limit: number): Promise<PrintableNote[]> {
    await this.init();
    const rows = await this.query<{ id: string; title: string; tagsJson: string; body: string }>(`select id, title, tags_json as tagsJson, body
      from member_memory_notes where archived_at is null and id > ${quote(afterId)} order by id limit ${Math.max(1, Math.floor(limit))};`);
    return rows.map((row) => ({ id: row.id, title: row.title, tags: parseTags(row.tagsJson), body: row.body }));
  }

  private init(): Promise<void> {
    this.ready ??= (async () => {
      await this.run(SCHEMA_SQL);
      const columns = new Set((await this.query<{ name: string }>("pragma table_info(member_memory_notes);")).map((row) => row.name));
      for (const added of ADDED_COLUMNS) {
        if (!columns.has(added.column)) await this.run(`alter table member_memory_notes add column ${added.column} ${added.definition};`);
      }
      await this.run(CHANGE_INDEX_SQL);
      await this.run(ORDER_SQL);
    })().catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  private query<T>(sql: string): Promise<T[]> {
    return this.storage.sqlExecutor().queryJson<T>(sql);
  }

  private run(sql: string): Promise<void> {
    return this.storage.sqlExecutor().runSql(sql);
  }

  /** One request from a device on the roster. */
  async handle(device: HubDevice, raw: unknown): Promise<MemoryResult<unknown>> {
    await this.init();
    const request = raw as HubMemoryRequest | undefined;
    if (!request || typeof request !== "object" || typeof (request as { action?: unknown }).action !== "string") {
      return invalid("The memory request has no action.");
    }
    if (device.role === "phone") return denied("The phone does not read or write members' memory.");
    switch (request.action) {
      case "semantic-settings":
      case "semantic-key": {
        if (device.role !== "owner") return denied("Only the computer that set up this server gives it the OpenAI key.");
        if (!this.semantic) return invalid("This server does not search by meaning.");
        if (request.action === "semantic-settings") return { ok: true, value: await this.semantic.view() };
        if (request.remove === true) return { ok: true, value: await this.semantic.removeKey() };
        const set = await this.semantic.setKey(request.key);
        return set.ok ? set : invalid(set.message);
      }
      case "list":
      case "owner-read":
      case "delete":
      case "export":
      case "import":
        if (device.role !== "owner") return denied("Only the computer that set up this server looks at every note.");
        if (request.action === "list") return this.ownerList(request);
        if (request.action === "owner-read") return this.readNote(request.noteId, undefined);
        if (request.action === "export") return this.exportNotes(request.after);
        if (request.action === "import") return this.serialize(() => this.importNotes(request.notes, device));
        return this.serialize(() => this.deleteNote(request.noteId, device));
      case "cli-sync":
        // In the same order as members' changes: a version read is never
        // moved on by a change in between.
        return this.serialize(() => this.cliMemory.sync(device, request.entries));
      case "index":
      case "tags":
      case "search":
      case "pick":
      case "chat-search":
      case "read":
      case "write":
      case "archive": {
        const member = await this.member(device, request);
        if ("code" in member) return { ok: false, error: member };
        // In the same order as changes: a version read for a change is never
        // moved on by an archive in between.
        await this.serialize(() => this.sweepIfDue());
        if (request.action === "index") return this.index(member, request.picks === true);
        if (request.action === "pick") return this.pick(member, request);
        if (request.action === "chat-search") {
          return searchProjectChats({ storage: this.storage, semantic: this.semantic, chatSearch: this.chatSearch, log: this.log }, member, request);
        }
        if (request.action === "tags") return { ok: true, value: { tags: await this.tagsInUse(member, MEMORY_TAGS_MAX_LISTED) } satisfies MemoryTagsValue };
        if (request.action === "search") return this.search(member, request);
        if (request.action === "read") return this.readNote(request.noteId, member);
        if (request.action === "write") return this.serialize(() => this.write(member, request, device));
        return this.serialize(() => this.archive(member, request, device));
      }
      default:
        return invalid(`Unknown memory action: ${String((request as { action?: unknown }).action).slice(0, 40)}.`);
    }
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async member(device: HubDevice, ref: Partial<MemoryMemberRef>): Promise<MemberContext | MemoryError> {
    if (typeof ref.conversationId !== "string" || typeof ref.participantId !== "string" || !ref.conversationId || !ref.participantId) {
      return { code: "invalid_request", message: "A memory request names the chat and the member it is for." };
    }
    // The chat's members and project only: a chat's body can be megabytes.
    const chat = await this.storage.conversationAccess(ref.conversationId);
    if (!chat || chat.kind !== "chat") return { code: "access_denied", message: "The server has no such chat (yet)." };
    const participants = chat.participants as ChatParticipant[];
    const participant = participants.find((item) => item?.id === ref.participantId);
    if (!participant) return { code: "access_denied", message: "This member is not in the chat." };
    const devices = await this.storage.hub().devices();
    if (homeDeviceId({ metadata: { participants } } as unknown as Conversation, participant.id, devices) !== device.deviceId) {
      return { code: "access_denied", message: `@${participant.handle} runs on another device; only that device reads and writes memory for it.` };
    }
    const projectPath = typeof chat.repoPath === "string" && chat.repoPath.trim() ? chat.repoPath : undefined;
    return {
      conversationId: ref.conversationId,
      participantId: participant.id,
      deviceId: device.deviceId,
      handle: normalizeHandle(participant.handle),
      roleId: participant.roleConfigId || "",
      ...(projectPath ? { projectPath } : {})
    };
  }

  /** What a member may see: global notes and those of its project, role and chat. */
  private visibleSql(member: MemberContext): string {
    return `archived_at is null and ${this.scopeSql(member)}`;
  }

  /** The scopes a member sees, archived or not. */
  private scopeSql(member: MemberContext): string {
    const parts = [
      "scope = 'global'",
      `(scope = 'chat' and scope_key = ${quote(member.conversationId)})`,
      ...(member.roleId ? [`(scope = 'role' and scope_key = ${quote(member.roleId)})`] : []),
      ...(member.projectPath ? [`(scope = 'project' and scope_key = ${quote(member.projectPath)})`] : [])
    ];
    return `(${parts.join(" or ")})`;
  }

  /** A task status nobody updated for a month is done with: it is archived
   *  (looked at most every few minutes, not on every request). */
  private async sweepIfDue(): Promise<void> {
    const now = this.now();
    if (this.sweptAt !== undefined && now.getTime() - this.sweptAt >= 0 && now.getTime() - this.sweptAt < MEMORY_SWEEP_INTERVAL_MS) return;
    this.sweptAt = now.getTime();
    const cutoff = new Date(now.getTime() - MEMORY_STATUS_STALE_DAYS * DAY_MS).toISOString();
    const stale = `kind = 'status' and archived_at is null and updated_at < ${quote(cutoff)}`;
    const due = await this.query<{ total: number }>(`select count(*) as total from member_memory_notes where ${stale};`);
    if (!Number(due[0]?.total ?? 0)) return;
    await this.run(`${BUMP_SQL} update member_memory_notes set archived_at = ${quote(now.toISOString())}, version = version + 1, updated_by = 'server',
      change_seq = ${SEQ_SQL} where ${stale};`);
  }

  private async index(member: MemberContext, picks: boolean): Promise<MemoryResult<MemoryIndexValue>> {
    // Notes that fit come with each message instead (the User, 2026-11-26:
    // 3–5 that fit rather than the same 25 every time).
    // Only while picks can be made (the key works, every note is printed,
    // OpenAI answers): otherwise the list, as without the key.
    if (picks && this.semantic?.ready()) {
      const counted = await this.query<{ total: number }>(`select count(*) as total from member_memory_notes where ${this.visibleSql(member)};`);
      const tags = await this.tagsInUse(member, MEMORY_INDEX_MAX_TAGS);
      return { ok: true, value: { notes: [], more: Number(counted[0]?.total ?? 0), ...(tags.length ? { tags } : {}), picks: true } };
    }
    const cutoff = new Date(this.now().getTime() - MEMORY_INDEX_STALE_DAYS * DAY_MS).toISOString();
    const activity = "max(updated_at, coalesce(verified_at, ''), coalesce(last_read_at, ''))";
    const rank = `case when kind = 'status' and author = ${quote(member.handle)} then 0
      when awaiting_repository = 1 and scope = 'project' and ${member.projectPath ? `scope_key = ${quote(member.projectPath)}` : "0"} then 1 else 2 end`;
    const where = `${this.visibleSql(member)} and (${rank} < 2 or ${activity} >= ${quote(cutoff)})`;
    const rows = await this.query<Row>(`select ${SUMMARY_COLUMNS} from member_memory_notes where ${where}
      order by ${rank}, ${activity} desc limit ${MEMORY_INDEX_MAX_NOTES};`);
    const counted = await this.query<{ total: number }>(`select count(*) as total from member_memory_notes where ${this.visibleSql(member)};`);
    const total = Number(counted[0]?.total ?? 0);
    const tags = await this.tagsInUse(member, MEMORY_INDEX_MAX_TAGS);
    return { ok: true, value: { notes: rows.map(summaryOf), more: Math.max(0, total - rows.length), ...(tags.length ? { tags } : {}) } };
  }

  /** The tags on the notes a member sees (not archived), most used first:
   *  so members pick a tag already in use instead of a new spelling of it. */
  private async tagsInUse(member: MemberContext, limit: number): Promise<MemoryTagCount[]> {
    const rows = await this.query<{ tag: string; count: number }>(`select tags.value as tag, count(*) as count
      from member_memory_notes, json_each(member_memory_notes.tags_json) as tags
      where ${this.visibleSql(member)} and json_valid(member_memory_notes.tags_json)
      group by tags.value order by count(*) desc, tags.value limit ${Math.max(1, Math.floor(limit))};`);
    return rows.filter((row) => typeof row.tag === "string" && row.tag).map((row) => ({ tag: row.tag, count: Number(row.count) }));
  }

  private async search(member: MemberContext, request: Extract<HubMemoryRequest, { action: "search" }>): Promise<MemoryResult<MemorySearchValue>> {
    if (request.query !== undefined && !validQuery(request.query)) return invalid(QUERY_RULE);
    const words = typeof request.query === "string" ? wordsAsked(request.query) : [];
    // Words are looked for below, ranked. A query with no word in it (only
    // one-letter words or signs) keeps the notes holding all it has, as before.
    const filters = this.filters(words.length ? { ...request, query: undefined } : request);
    if ("code" in filters) return { ok: false, error: filters };
    const limit = clampLimit(request.limit);
    const where = `${this.visibleSql(member)}${filters.sql}`;
    const activity = "max(updated_at, coalesce(verified_at, ''), coalesce(last_read_at, ''))";
    if (!words.length) {
      const rows = await this.query<Row>(`select ${SUMMARY_COLUMNS} from member_memory_notes where ${where} order by ${activity} desc limit ${limit};`);
      this.log("hub.memory.search", { conversationId: member.conversationId, found: rows.length });
      return { ok: true, value: { notes: rows.map(summaryOf), ranking: "any-word" } };
    }
    // With the User's OpenAI key: the closest in meaning and the best by
    // words take turns, meaning first (a name or an id asked is not buried).
    const [byWords, meaning] = await Promise.all([
      this.rankByWords(where, words),
      this.semantic?.enabled() ? this.rankByMeaning(request.query as string, where) : Promise.resolve(undefined)
    ]);
    const wordOrder: Array<{ row: Row; part?: number }> = byWords.map((row) => ({ row }));
    const ordered = meaning?.length ? takeTurns<{ row: Row; part?: number }>(meaning, wordOrder, (item) => item.row.id) : wordOrder;
    const top = ordered.slice(0, limit);
    const bodies = new Map<string, string>();
    if (top.length) {
      const read = await this.query<{ id: string; body: string }>(`select id, body from member_memory_notes where id in (${top.map((item) => quote(item.row.id)).join(", ")});`);
      for (const row of read) bodies.set(row.id, row.body);
    }
    const notes: MemorySearchHit[] = top.map((item) => ({ ...summaryOf(item.row), snippet: snippetOf(passageOf(bodies.get(item.row.id) ?? "", item.part), words) }));
    const ranking = meaning?.length ? "meaning" : "any-word";
    this.log("hub.memory.search", { conversationId: member.conversationId, found: notes.length, words: words.length, ranking });
    return { ok: true, value: { notes, ranking } };
  }

  /** The notes holding any word asked, best match first. */
  private async rankByWords(where: string, words: SearchWord[]): Promise<Array<Row & { activity: string }>> {
    const activity = "max(updated_at, coalesce(verified_at, ''), coalesce(last_read_at, ''))";
    // Candidates: the notes holding any word's first letters (all its forms
    // hold them). Their search text is read to rank them; bodies only for the
    // notes given back.
    const holds = candidateAnchors(words).map((anchor) => `instr(search_text, ${quote(anchor)}) > 0`).join(" or ");
    const rows = await this.query<Row & { activity: string; searchText: string }>(`select ${SUMMARY_COLUMNS}, ${activity} as activity, search_text as searchText
      from member_memory_notes where ${where} and (${holds});`);
    const corpus = await this.query<{ total: number; averageLength: number | null }>(`select count(*) as total, avg(length(search_text)) as averageLength
      from member_memory_notes where ${where};`);
    // Counted a few notes at a time: on a server full of long notes this takes
    // a while, and other requests are answered meanwhile.
    const counted: Array<{ note: (typeof rows)[number]; counts: number[] }> = [];
    for (const [index, row] of rows.entries()) {
      if (index > 0 && index % COUNT_BATCH === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      counted.push({ note: row, counts: wordCounts(row.searchText, words) });
    }
    const ranked = rankCounted(counted, words, { total: Number(corpus[0]?.total ?? rows.length), averageLength: Number(corpus[0]?.averageLength ?? 0) });
    // Equal scores: the most recently active first, as without words.
    ranked.sort((left, right) => right.score - left.score || (left.note.activity < right.note.activity ? 1 : left.note.activity > right.note.activity ? -1 : 0));
    return ranked.map((item) => item.note);
  }

  /** The notes closest in meaning to a query, with the passage that is
   *  closest; undefined when OpenAI did not answer (search goes by words). */
  private async rankByMeaning(query: string, where: string): Promise<Array<{ row: Row; part: number }> | undefined> {
    const print = await this.semantic?.printQuery(query, SEARCH_PRINT_TIMEOUT_MS);
    if (!print || !this.semantic) return undefined;
    const rows = await this.query<Row>(`select ${SUMMARY_COLUMNS} from member_memory_notes where ${where};`);
    const scores = this.semantic.noteCloseness(print, rows.map((row) => row.id));
    return rows.flatMap((row) => {
      const score = scores.get(row.id);
      return score && score.score >= SEARCH_MEANING_MIN ? [{ row, part: score.part, score: score.score }] : [];
    }).sort((left, right) => right.score - left.score).map(({ row, part }) => ({ row, part }));
  }

  /**
   * The notes that fit a message, by meaning: only those close enough, at
   * most a few, none the member was given in its session already (unless
   * changed since). With no key, or when OpenAI does not answer, none.
   */
  private async pick(member: MemberContext, request: Extract<HubMemoryRequest, { action: "pick" }>): Promise<MemoryResult<MemoryPickValue>> {
    // Not now (no key, notes still printed, OpenAI not answering): said so,
    // and the member's device gives the list instead for a while.
    if (!this.semantic?.ready()) return { ok: true, value: { enabled: false, notes: [] } };
    if (typeof request.text !== "string" || request.text.includes("\u0000")) return invalid("Give the message's text to pick notes for.");
    const shown = new Map<string, number>();
    if (request.shown !== undefined) {
      if (!Array.isArray(request.shown) || request.shown.length > MEMORY_LIVE_NOTES_MAX) return invalid("shown lists the notes given already, by id and version.");
      for (const item of request.shown) if (item && typeof item.id === "string" && Number.isSafeInteger(item.version)) shown.set(item.id, item.version);
    }
    const print = await this.semantic.printQuery(request.text.slice(0, QUERY_MAX_CHARS), PICK_PRINT_TIMEOUT_MS);
    if (!print) return { ok: true, value: { enabled: false, notes: [] } };
    // Every turn asks: only ids and versions are read for all, summaries for the few picked.
    const visible = await this.query<{ id: string; version: number }>(`select id, version from member_memory_notes where ${this.visibleSql(member)};`);
    const scores = this.semantic.noteCloseness(print, visible.map((row) => row.id));
    const ranked = visible.flatMap((row) => {
      const score = scores.get(row.id)?.score;
      return score === undefined ? [] : [{ row, score }];
    }).sort((left, right) => right.score - left.score);
    const closest = ranked[0]?.score ?? 0;
    const picked = ranked
      .filter((item) => item.score >= PICK_MIN && item.score >= closest - PICK_GAP && shown.get(item.row.id) !== Number(item.row.version))
      .slice(0, MEMORY_PICK_MAX);
    const rows = picked.length
      ? await this.query<Row>(`select ${SUMMARY_COLUMNS} from member_memory_notes where id in (${picked.map((item) => quote(item.row.id)).join(", ")}) and ${this.visibleSql(member)};`)
      : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const notes = picked.flatMap((item) => {
      const row = byId.get(item.row.id);
      return row ? [summaryOf(row)] : [];
    });
    this.log("hub.memory.pick", { conversationId: member.conversationId, picked: notes.length, closest: Math.round(closest * 1000) / 1000 });
    return { ok: true, value: { enabled: true, notes } };
  }

  private filters(request: { query?: unknown; tags?: unknown; tag?: unknown; kind?: unknown; scope?: unknown }): { sql: string } | MemoryError {
    let sql = "";
    if (request.query !== undefined) {
      if (!validQuery(request.query)) return { code: "invalid_request", message: QUERY_RULE };
      for (const word of searchWords(request.query)) sql += ` and instr(search_text, ${quote(word)}) > 0`;
    }
    const tags = request.tags !== undefined ? request.tags : request.tag !== undefined ? [request.tag] : undefined;
    if (tags !== undefined) {
      if (!Array.isArray(tags) || tags.length > MEMORY_TAGS_MAX || tags.some((tag) => typeof tag !== "string" || tag.includes("\u0000") || tag.length > MEMORY_TAG_MAX_CHARS)) {
        return { code: "invalid_request", message: "Give at most a dozen short tags to search by." };
      }
      for (const tag of normalizeMemoryTags(tags)) sql += ` and instr(tags_json, ${quote(JSON.stringify(tag))}) > 0`;
    }
    if (request.kind !== undefined) {
      if (!isMemoryNoteKind(request.kind)) return { code: "invalid_request", message: "kind is runbook, article or status." };
      sql += ` and kind = ${quote(request.kind)}`;
    }
    if (request.scope !== undefined) {
      if (!isMemoryScope(request.scope)) return { code: "invalid_request", message: "scope is global, project, role or chat." };
      sql += ` and scope = ${quote(request.scope)}`;
    }
    return { sql };
  }

  private async readNote(noteId: unknown, member: MemberContext | undefined): Promise<MemoryResult<MemoryNote>> {
    if (typeof noteId !== "string" || !NOTE_ID.test(noteId)) return invalid("Name the note by its id.");
    const where = member ? ` and ${this.visibleSql(member)}` : "";
    const rows = await this.query<Row>(`select ${SUMMARY_COLUMNS}, body from member_memory_notes where id = ${quote(noteId)}${where};`);
    const row = rows[0];
    if (!row) return { ok: false, error: { code: "not_found", message: "There is no such note, or it is not one this member sees." } };
    if (member) {
      await this.run(`update member_memory_notes set last_read_at = ${quote(this.now().toISOString())} where id = ${quote(noteId)};`);
    }
    return { ok: true, value: noteOf(row) };
  }

  private async write(member: MemberContext, request: Extract<HubMemoryRequest, { action: "write" }>, device: HubDevice): Promise<MemoryResult<MemoryNote>> {
    if (typeof request.requestId !== "string" || !REQUEST_ID.test(request.requestId)) return invalid("A write carries a requestId of letters, digits and .:_- only.");
    return request.noteId === undefined ? this.create(member, request, device) : this.update(member, request, device);
  }

  private async create(member: MemberContext, request: Extract<HubMemoryRequest, { action: "write" }>, device: HubDevice): Promise<MemoryResult<MemoryNote>> {
    const key = requestKey(member, request.requestId);
    const hash = requestHash(request);
    // A retry of this member's own create: the note it made. The same
    // requestId used for something else is refused, never answered with a note.
    const again = await this.query<Row>(`select ${SUMMARY_COLUMNS}, body, create_request_hash as createRequestHash from member_memory_notes
      where create_request_key = ${quote(key)};`);
    if (again[0]) {
      return again[0].createRequestHash === hash ? { ok: true, value: noteOf(again[0]) } : invalid("This requestId was already used for another note; send a new one or none.");
    }
    if (request.kind === undefined || request.scope === undefined || request.title === undefined || request.body === undefined) {
      return invalid("A new note has a kind, a scope, a title and a body.");
    }
    const fields = validFields({
      kind: request.kind, scope: request.scope, title: request.title, body: request.body, tags: request.tags ?? [],
      source: request.source, awaitingRepository: request.awaitingRepository ?? false
    }, member);
    if ("code" in fields) return { ok: false, error: fields };
    const duplicate = await this.duplicateOf(fields, undefined);
    if (duplicate) return { ok: false, error: duplicate };
    const live = await this.query<{ total: number }>("select count(*) as total from member_memory_notes where archived_at is null;");
    if (Number(live[0]?.total ?? 0) >= MEMORY_LIVE_NOTES_MAX) {
      return invalid(`Your server already keeps ${MEMORY_LIVE_NOTES_MAX} notes. Archive notes that no longer hold, or merge this one into an existing note.`);
    }
    const id = randomUUID();
    const now = this.now().toISOString();
    await this.run(`${BUMP_SQL} insert into member_memory_notes(id, kind, title, title_key, tags_json, scope, scope_key, source, author, updated_by,
      version, created_at, updated_at, verified_at, awaiting_repository, create_request_key, create_request_hash, last_request, change_seq, body, search_text) values (
      ${quote(id)}, ${quote(fields.kind)}, ${quote(fields.title)}, ${quote(memoryTitleKey(fields.title))}, ${quote(JSON.stringify(fields.tags))},
      ${quote(fields.scope)}, ${quote(fields.scopeKey)}, ${fields.source ? quote(fields.source) : "null"}, ${quote(member.handle)}, ${quote(member.handle)},
      1, ${quote(now)}, ${quote(now)}, ${quote(now)}, ${fields.awaitingRepository ? 1 : 0}, ${quote(key)}, ${quote(hash)}, ${quote(`${key}:${hash}`)},
      ${SEQ_SQL}, ${quote(fields.body)}, ${quote(searchText(fields))});`);
    this.log("hub.memory.created", { noteId: id, kind: fields.kind, scope: fields.scope, deviceId: device.deviceId, conversationId: member.conversationId });
    this.semantic?.noteChanged({ id, title: fields.title, tags: fields.tags, body: fields.body });
    return this.readNote(id, undefined);
  }

  private async update(member: MemberContext, request: Extract<HubMemoryRequest, { action: "write" }>, device: HubDevice): Promise<MemoryResult<MemoryNote>> {
    if (typeof request.noteId !== "string" || !NOTE_ID.test(request.noteId)) return invalid("Name the note to change by its id.");
    const rows = await this.query<Row>(`select ${SUMMARY_COLUMNS}, body, last_request as lastRequest from member_memory_notes
      where id = ${quote(request.noteId)} and ${this.visibleSql(member)};`);
    const row = rows[0];
    if (!row) return { ok: false, error: { code: "not_found", message: "There is no such note, or it is not one this member sees." } };
    const key = requestKey(member, request.requestId);
    const done = `${key}:${requestHash(request)}`;
    // The same change sent again (its answer was lost): it is done already.
    if (row.lastRequest === done) return { ok: true, value: noteOf(row) };
    if (row.lastRequest?.startsWith(`${key}:`)) return invalid("This requestId was already used for another change; send a new one or none.");
    if (!Number.isSafeInteger(request.baseVersion)) return invalid("A change names the version it is based on (baseVersion).");
    if (request.baseVersion !== row.version) {
      return { ok: false, error: { code: "conflict", message: `The note changed since version ${request.baseVersion}; it is at version ${row.version} now. Read it again and redo the change on top of it.`, current: summaryOf(row) } };
    }
    const current = noteOf(row);
    const fields = validFields({
      kind: request.kind ?? current.kind,
      scope: request.scope ?? current.scope,
      title: request.title ?? current.title,
      body: request.body ?? current.body,
      tags: request.tags ?? current.tags,
      source: request.source !== undefined ? request.source : current.source,
      awaitingRepository: request.awaitingRepository ?? current.awaitingRepository,
      ...(request.scope === undefined ? { scopeKey: row.scopeKey } : {})
    }, member);
    if ("code" in fields) return { ok: false, error: fields };
    const duplicate = await this.duplicateOf(fields, row.id);
    if (duplicate) return { ok: false, error: duplicate };
    const now = this.now().toISOString();
    await this.run(`${BUMP_SQL} update member_memory_notes set kind = ${quote(fields.kind)}, title = ${quote(fields.title)}, title_key = ${quote(memoryTitleKey(fields.title))},
      body = ${quote(fields.body)}, tags_json = ${quote(JSON.stringify(fields.tags))}, search_text = ${quote(searchText(fields))},
      scope = ${quote(fields.scope)}, scope_key = ${quote(fields.scopeKey)}, source = ${fields.source ? quote(fields.source) : "null"},
      awaiting_repository = ${fields.awaitingRepository ? 1 : 0}, updated_by = ${quote(member.handle)}, version = version + 1,
      updated_at = ${quote(now)}${request.verified === true ? `, verified_at = ${quote(now)}` : ""}, last_request = ${quote(done)},
      change_seq = ${SEQ_SQL} where id = ${quote(row.id)} and version = ${row.version};`);
    const after = await this.query<Row>(`select ${SUMMARY_COLUMNS}, body, last_request as lastRequest from member_memory_notes where id = ${quote(row.id)};`);
    // Changed meanwhile (deleted in Settings, or moved on): never reported as done.
    if (!after[0]) return { ok: false, error: { code: "not_found", message: "The note was deleted meanwhile." } };
    if (after[0].lastRequest !== done) {
      return { ok: false, error: { code: "conflict", message: `The note changed meanwhile; it is at version ${after[0].version} now. Read it again and redo the change on top of it.`, current: summaryOf(after[0]) } };
    }
    this.log("hub.memory.updated", { noteId: row.id, version: row.version + 1, deviceId: device.deviceId, conversationId: member.conversationId });
    this.semantic?.noteChanged({ id: row.id, title: fields.title, tags: fields.tags, body: fields.body });
    return { ok: true, value: noteOf(after[0]) };
  }

  private async archive(member: MemberContext, request: Extract<HubMemoryRequest, { action: "archive" }>, device: HubDevice): Promise<MemoryResult<MemoryNoteSummary>> {
    if (typeof request.requestId !== "string" || !REQUEST_ID.test(request.requestId)) return invalid("An archive carries a requestId of letters, digits and .:_- only.");
    if (typeof request.noteId !== "string" || !NOTE_ID.test(request.noteId)) return invalid("Name the note by its id.");
    const done = `${requestKey(member, request.requestId)}:${requestHash({ noteId: request.noteId })}`;
    // A note this member sees; an archived one only when this very archive
    // made it so (a retry).
    const rows = await this.query<Row>(`select ${SUMMARY_COLUMNS}, last_request as lastRequest from member_memory_notes where id = ${quote(request.noteId)}
      and ${this.scopeSql(member)} and (archived_at is null or last_request = ${quote(done)});`);
    const row = rows[0];
    if (!row) return { ok: false, error: { code: "not_found", message: "There is no such note, or it is not one this member sees." } };
    if (row.archivedAt) return { ok: true, value: summaryOf(row) };
    const now = this.now().toISOString();
    await this.run(`${BUMP_SQL} update member_memory_notes set archived_at = ${quote(now)}, version = version + 1, updated_by = ${quote(member.handle)},
      last_request = ${quote(done)}, change_seq = ${SEQ_SQL} where id = ${quote(row.id)};`);
    this.log("hub.memory.archived", { noteId: row.id, deviceId: device.deviceId, conversationId: member.conversationId });
    const after = await this.query<Row>(`select ${SUMMARY_COLUMNS} from member_memory_notes where id = ${quote(row.id)};`);
    return { ok: true, value: summaryOf(after[0] ?? row) };
  }

  private async duplicateOf(fields: ValidFields, exceptId: string | undefined): Promise<MemoryError | undefined> {
    const rows = await this.query<Row>(`select ${SUMMARY_COLUMNS} from member_memory_notes where archived_at is null
      and kind = ${quote(fields.kind)} and scope = ${quote(fields.scope)} and scope_key = ${quote(fields.scopeKey)}
      and title_key = ${quote(memoryTitleKey(fields.title))}${exceptId ? ` and id <> ${quote(exceptId)}` : ""} limit 1;`);
    const row = rows[0];
    if (!row) return undefined;
    return {
      code: "duplicate",
      message: `A ${row.kind} titled "${row.title}" already exists here (id ${row.id}, version ${row.version}). Update that note instead of adding another.`,
      current: summaryOf(row)
    };
  }

  private async ownerList(request: Extract<HubMemoryRequest, { action: "list" }>): Promise<MemoryResult<MemoryOwnerListValue>> {
    await this.serialize(() => this.sweepIfDue());
    const filters = this.filters(request);
    if ("code" in filters) return { ok: false, error: filters };
    const archived = request.archived === true ? "archived_at is not null" : "archived_at is null";
    const rows = await this.query<Row>(`select ${SUMMARY_COLUMNS} from member_memory_notes where ${archived}${filters.sql}
      order by updated_at desc limit ${MEMORY_LIST_MAX + 1};`);
    return { ok: true, value: { notes: rows.slice(0, MEMORY_LIST_MAX).map(summaryOf), truncated: rows.length > MEMORY_LIST_MAX } };
  }

  /** The owner's copy: every note (archived too, bodies included) changed
   *  after a place in the order of changes, a page at a time. */
  private async exportNotes(after: unknown): Promise<MemoryResult<MemoryExportValue>> {
    const place = after as { seq?: unknown; id?: unknown } | undefined;
    const seq = place && Number.isSafeInteger(place.seq) ? Number(place.seq) : 0;
    const id = place && typeof place.id === "string" && NOTE_ID.test(place.id) ? place.id : "";
    const afterSql = `(change_seq > ${seq} or (change_seq = ${seq} and id > ${quote(id)}))`;
    const notes = await this.query<Row & { changeSeq: number }>(`select ${SUMMARY_COLUMNS}, body, change_seq as changeSeq from member_memory_notes
      where ${afterSql} order by change_seq, id limit ${MEMORY_EXPORT_PAGE + 1};`);
    const deleted = await this.query<{ id: string; changeSeq: number }>(`select id, change_seq as changeSeq from member_memory_deleted
      where ${afterSql} order by change_seq, id limit ${MEMORY_EXPORT_PAGE + 1};`);
    const head = await this.query<{ value: number }>("select value from member_memory_counter where key = 'change_seq';");
    // One order for both: notes changed and notes deleted.
    const entries = [
      ...notes.map((row) => ({ seq: Number(row.changeSeq), id: row.id, note: row })),
      ...deleted.map((row) => ({ seq: Number(row.changeSeq), id: row.id, note: undefined }))
    ].sort((left, right) => left.seq - right.seq || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    const page = entries.slice(0, MEMORY_EXPORT_PAGE);
    const last = page[page.length - 1];
    return {
      ok: true,
      value: {
        notes: page.flatMap((entry) => entry.note ? [{ ...noteOf(entry.note), changeSeq: entry.seq }] : []),
        deleted: page.flatMap((entry) => entry.note ? [] : [{ id: entry.id, changeSeq: entry.seq }]),
        head: Number(head[0]?.value ?? 0),
        ...(entries.length > MEMORY_EXPORT_PAGE && last ? { next: { seq: last.seq, id: last.id } } : {})
      }
    };
  }

  /** The owner's copy put on this server (moving to it): each note as it
   *  was, kept only where this server has no note of that id. */
  private async importNotes(raw: unknown, device: HubDevice): Promise<MemoryResult<MemoryImportValue>> {
    if (!Array.isArray(raw) || raw.length > 500) return invalid("Send between 0 and 500 notes at a time.");
    let imported = 0;
    let skipped = 0;
    for (const item of raw as Array<Partial<MemoryNote>>) {
      const note = importableNote(item);
      if (!note) {
        skipped += 1;
        continue;
      }
      const existing = await this.query<{ id: string }>(`select id from member_memory_notes where id = ${quote(note.id)}
        union all select id from member_memory_deleted where id = ${quote(note.id)};`);
      if (existing[0]) {
        skipped += 1;
        continue;
      }
      await this.run(`${BUMP_SQL} insert into member_memory_notes(id, kind, title, title_key, tags_json, scope, scope_key, source, author, updated_by,
        version, created_at, updated_at, verified_at, awaiting_repository, archived_at, change_seq, body, search_text) values (
        ${quote(note.id)}, ${quote(note.kind)}, ${quote(note.title)}, ${quote(memoryTitleKey(note.title))}, ${quote(JSON.stringify(note.tags))},
        ${quote(note.scope)}, ${quote(note.scopeKey)}, ${note.source ? quote(note.source) : "null"}, ${quote(note.author)}, ${quote(note.updatedBy)},
        ${note.version}, ${quote(note.createdAt)}, ${quote(note.updatedAt)}, ${note.verifiedAt ? quote(note.verifiedAt) : "null"},
        ${note.awaitingRepository ? 1 : 0}, ${note.archivedAt ? quote(note.archivedAt) : "null"}, ${SEQ_SQL},
        ${quote(note.body)}, ${quote(searchText(note))});`);
      if (!note.archivedAt) this.semantic?.noteChanged({ id: note.id, title: note.title, tags: note.tags, body: note.body });
      imported += 1;
    }
    this.log("hub.memory.imported", { deviceId: device.deviceId, imported, skipped });
    return { ok: true, value: { imported, skipped } };
  }

  private async deleteNote(noteId: unknown, device: HubDevice): Promise<MemoryResult<{ deleted: boolean }>> {
    if (typeof noteId !== "string" || !NOTE_ID.test(noteId)) return invalid("Name the note by its id.");
    const rows = await this.query<{ id: string }>(`select id from member_memory_notes where id = ${quote(noteId)};`);
    // The deletion keeps its place in the order: the owner's copy drops the
    // note too (and never brings it back to another server).
    if (rows[0]) {
      await this.run(`${BUMP_SQL} insert or replace into member_memory_deleted(id, change_seq, deleted_at) values (${quote(noteId)}, ${SEQ_SQL}, ${quote(this.now().toISOString())});
        delete from member_memory_notes where id = ${quote(noteId)};`);
    }
    this.log("hub.memory.deleted", { noteId, deviceId: device.deviceId, existed: Boolean(rows[0]) });
    if (rows[0]) this.semantic?.noteRemoved(noteId);
    return { ok: true, value: { deleted: Boolean(rows[0]) } };
  }
}

interface ValidFields {
  kind: MemoryNoteKind;
  scope: MemoryScope;
  scopeKey: string;
  title: string;
  body: string;
  tags: string[];
  source?: string;
  awaitingRepository: boolean;
}

function validFields(
  input: { kind: unknown; scope: unknown; title: unknown; body: unknown; tags: unknown; source?: unknown; awaitingRepository: unknown; scopeKey?: string },
  member: MemberContext
): ValidFields | MemoryError {
  // Checked on every path (a change as well as a new note): a tool's schema
  // is not enforced before it reaches the server.
  if (!isMemoryNoteKind(input.kind)) return { code: "invalid_request", message: "kind is runbook, article or status." };
  if (!isMemoryScope(input.scope)) return { code: "invalid_request", message: "scope is global, project, role or chat." };
  if (typeof input.title !== "string" || typeof input.body !== "string") return { code: "invalid_request", message: "title and body are text." };
  if (typeof input.awaitingRepository !== "boolean") return { code: "invalid_request", message: "awaitingRepository is true or false." };
  const title = input.title.replace(/\s+/g, " ").trim();
  if (!title) return { code: "invalid_request", message: "The note needs a title." };
  if ([...title].length > MEMORY_TITLE_MAX_CHARS) return { code: "invalid_request", message: `Keep the title under ${MEMORY_TITLE_MAX_CHARS} characters.` };
  const body = input.body.trim();
  if (!body) return { code: "invalid_request", message: "The note needs a body." };
  if (Buffer.byteLength(body) > MEMORY_BODY_MAX_BYTES) return { code: "invalid_request", message: `Keep the note under ${MEMORY_BODY_MAX_BYTES / 1024} KB; split it or put it in the repository.` };
  if (!Array.isArray(input.tags)) return { code: "invalid_request", message: "tags is a list of words." };
  const tags = normalizeMemoryTags(input.tags);
  if (tags.length > MEMORY_TAGS_MAX) return { code: "invalid_request", message: `Use at most ${MEMORY_TAGS_MAX} tags.` };
  if (tags.some((tag) => [...tag].length > MEMORY_TAG_MAX_CHARS)) return { code: "invalid_request", message: `Keep every tag under ${MEMORY_TAG_MAX_CHARS} characters.` };
  let source: string | undefined;
  if (input.source !== undefined && input.source !== null) {
    if (typeof input.source !== "string" || [...input.source].length > MEMORY_SOURCE_MAX_CHARS) return { code: "invalid_request", message: `Keep the source under ${MEMORY_SOURCE_MAX_CHARS} characters.` };
    source = input.source.trim() || undefined;
  }
  if ([title, body, ...tags, source ?? ""].some((text) => text.includes("\u0000"))) return { code: "invalid_request", message: "The note has a NUL character." };
  if (input.kind === "status" && input.scope === "global") {
    return { code: "invalid_request", message: "A task status is not for every chat: give it the project, role or chat scope." };
  }
  if (input.awaitingRepository && input.scope !== "project") {
    return { code: "invalid_request", message: "Only a project note waits for the repository." };
  }
  let scopeKey = input.scopeKey;
  if (scopeKey === undefined) {
    if (input.scope === "global") scopeKey = "";
    else if (input.scope === "chat") scopeKey = member.conversationId;
    else if (input.scope === "role") {
      if (!member.roleId) return { code: "invalid_request", message: "This member has no role to keep a role note for." };
      scopeKey = member.roleId;
    } else {
      if (!member.projectPath) return { code: "invalid_request", message: "This chat has no project, so there is no project to keep a note for." };
      scopeKey = member.projectPath;
    }
  }
  return { kind: input.kind, scope: input.scope, scopeKey, title, body, tags, ...(source ? { source } : {}), awaitingRepository: input.awaitingRepository };
}

/** A note from the owner's copy, checked as strictly as a member's write
 *  (it may be old, or from another build): undefined when it is not one. */
function importableNote(item: Partial<MemoryNote> | undefined): (MemoryNote & { scopeKey: string }) | undefined {
  if (!item || typeof item !== "object") return undefined;
  if (typeof item.id !== "string" || !NOTE_ID.test(item.id) || !isMemoryNoteKind(item.kind) || !isMemoryScope(item.scope)) return undefined;
  if (typeof item.title !== "string" || typeof item.body !== "string" || !item.title.trim() || [...item.title].length > MEMORY_TITLE_MAX_CHARS) return undefined;
  if (!item.body.trim() || Buffer.byteLength(item.body) > MEMORY_BODY_MAX_BYTES) return undefined;
  if (item.kind === "status" && item.scope === "global") return undefined;
  if (typeof item.author !== "string" || typeof item.updatedBy !== "string" || !item.author || item.author.length > 64 || item.updatedBy.length > 64) return undefined;
  if (!Number.isSafeInteger(item.version) || Number(item.version) < 1) return undefined;
  if (!isTime(item.createdAt) || !isTime(item.updatedAt) || (item.verifiedAt !== undefined && !isTime(item.verifiedAt)) ||
      (item.archivedAt !== undefined && !isTime(item.archivedAt))) return undefined;
  const tags = normalizeMemoryTags(Array.isArray(item.tags) ? item.tags : []);
  if (tags.length > MEMORY_TAGS_MAX || tags.some((tag) => [...tag].length > MEMORY_TAG_MAX_CHARS)) return undefined;
  if (item.source !== undefined && (typeof item.source !== "string" || [...item.source].length > MEMORY_SOURCE_MAX_CHARS)) return undefined;
  const scopeKey = item.scope === "project" ? item.projectPath : item.scope === "role" ? item.roleId : item.scope === "chat" ? item.conversationId : "";
  if (typeof scopeKey !== "string" || (item.scope !== "global" && !scopeKey)) return undefined;
  const texts = [item.id, item.title, item.body, item.author, item.updatedBy, item.createdAt, item.updatedAt, scopeKey, item.source ?? "", item.verifiedAt ?? "", item.archivedAt ?? "", ...tags];
  if (texts.some((text) => typeof text !== "string" || text.includes("\u0000"))) return undefined;
  return {
    id: item.id, kind: item.kind, scope: item.scope, scopeKey, title: item.title.replace(/\s+/g, " ").trim(), body: item.body, tags,
    author: item.author, updatedBy: item.updatedBy, version: Number(item.version), createdAt: item.createdAt, updatedAt: item.updatedAt,
    awaitingRepository: item.awaitingRepository === true && item.scope === "project",
    ...(typeof item.source === "string" && item.source ? { source: item.source } : {}),
    ...(typeof item.verifiedAt === "string" ? { verifiedAt: item.verifiedAt } : {}),
    ...(typeof item.archivedAt === "string" ? { archivedAt: item.archivedAt } : {})
  };
}

/** A time as the server writes it (ISO 8601): the stale-status sweep compares them as text. */
function isTime(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value) && !Number.isNaN(Date.parse(value));
}

/** A retry key that is the member's own: the same requestId from another
 *  member, chat or device is another key. */
function requestKey(member: MemberContext, requestId: string): string {
  return createHash("sha256").update(`${member.deviceId}\n${member.conversationId}\n${member.participantId}\n${requestId}`).digest("hex").slice(0, 32);
}

/** What a request asked, to tell a retry from a reuse of its requestId. */
function requestHash(request: object): string {
  const asked = ["noteId", "baseVersion", "kind", "title", "body", "tags", "scope", "source", "awaitingRepository", "verified"]
    .map((field) => [field, (request as Record<string, unknown>)[field] ?? null]);
  return createHash("sha256").update(JSON.stringify(asked)).digest("hex").slice(0, 32);
}

/** The passage of a body a print was made from (the whole body when none). */
function passageOf(body: string, part: number | undefined): string {
  if (part === undefined) return body;
  const range = passageRanges(body, NOTE_PASSAGE_CHARS)[part];
  return range ? body.slice(range.start, range.end) : body;
}

const QUERY_RULE = `Search by words under ${MEMORY_QUERY_MAX_CHARS} characters.`;

function validQuery(query: unknown): query is string {
  return typeof query === "string" && query.length <= MEMORY_QUERY_MAX_CHARS && !query.includes("\u0000");
}

/** The owner's list (Settings → Memory) keeps notes holding every word typed. */
function searchWords(query: string): string[] {
  return [...new Set(query.toLocaleLowerCase().split(/\s+/).map((word) => word.trim()).filter(Boolean))].slice(0, 12);
}

function clampLimit(limit: unknown): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return MEMORY_SEARCH_DEFAULT_LIMIT;
  return Math.max(1, Math.min(MEMORY_SEARCH_MAX_LIMIT, Math.floor(limit)));
}

function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@+/, "").toLowerCase();
}

function invalid(message: string): { ok: false; error: MemoryError } {
  return { ok: false, error: { code: "invalid_request", message } };
}

function denied(message: string): { ok: false; error: MemoryError } {
  return { ok: false, error: { code: "access_denied", message } };
}

