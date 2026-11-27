/**
 * Members' long-term memory: notes members keep for themselves and each other
 * (runbooks, articles, task statuses) on the User's own server, so a member
 * on this computer and one on a cloud machine read the same notes. The User
 * never has to think about it: members write, find, update and archive notes
 * themselves; Settings → Memory only lets her look and delete.
 *
 * Who sees a note is decided by the server from the chat the member acts in
 * (never from what the member says about itself): every member sees global
 * notes, notes of its chat's project, of its own role and of its chat.
 */

export const MEMORY_NOTE_KINDS = ["runbook", "article", "status"] as const;
export type MemoryNoteKind = typeof MEMORY_NOTE_KINDS[number];

export const MEMORY_SCOPES = ["global", "project", "role", "chat"] as const;
export type MemoryScope = typeof MEMORY_SCOPES[number];

export const MEMORY_TITLE_MAX_CHARS = 160;
export const MEMORY_BODY_MAX_BYTES = 16 * 1024;
export const MEMORY_TAGS_MAX = 12;
export const MEMORY_TAG_MAX_CHARS = 40;
export const MEMORY_SOURCE_MAX_CHARS = 500;
export const MEMORY_QUERY_MAX_CHARS = 500;
export const MEMORY_SEARCH_DEFAULT_LIMIT = 20;
export const MEMORY_SEARCH_MAX_LIMIT = 100;
/** A task status nobody updated for this long is archived by the server. */
export const MEMORY_STATUS_STALE_DAYS = 30;
/** A session starts with every note its member sees, one line each (the
 *  User, 2026-11-27). Past this many, it gets the User's preferences first,
 *  then all of its chat's own notes (project, role, chat) and the global
 *  ones most relevant to the chat, and is told how many are left out. */
export const MEMORY_INDEX_MAX_NOTES = 150;
/** At most this many of the chat's own notes are listed all the same (a
 *  bound on a session's first message; a project far past it is unlikely). */
export const MEMORY_INDEX_NEAR_MAX = 300;
/** Past MEMORY_INDEX_MAX_NOTES the User's preferences (tag `preference`)
 *  are listed first, at most this many (the User, 2026-11-27: they are few). */
export const MEMORY_INDEX_PREFERENCES_MAX = 50;
/** At most this many bytes (UTF-8) of the list go into a session's first
 *  message (a Gemini member gets its message as one command-line argument,
 *  128 KB at most on Linux). */
export const MEMORY_INDEX_MAX_BYTES = 32 * 1024;
/** At most this many tags are named at the start of a session. */
export const MEMORY_INDEX_MAX_TAGS = 12;
/** At most this many tags are given when a member asks for them. */
export const MEMORY_TAGS_MAX_LISTED = 200;
/** The owner's list in Settings shows at most this many notes per page. */
export const MEMORY_LIST_MAX = 500;
/** At most this many notes are kept unarchived on a server: a member that
 *  loops cannot fill it. */
export const MEMORY_LIVE_NOTES_MAX = 2000;
/** How often the server archives stale task statuses, at most. */
export const MEMORY_SWEEP_INTERVAL_MS = 10 * 60_000;

/** Where the server keeps members' memory (protocol v3, signed requests). */
export const HUB_MEMORY_PATH = "/v3/memory";

export interface MemoryNoteSummary {
  id: string;
  kind: MemoryNoteKind;
  title: string;
  tags: string[];
  scope: MemoryScope;
  /** The project folder (as the chat names it) for a project note. */
  projectPath?: string;
  /** The role id for a role note. */
  roleId?: string;
  /** The chat for a chat note. */
  conversationId?: string;
  /** Handle of the member that created the note. */
  author: string;
  /** Handle of the member that changed it last. */
  updatedBy: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** When a member last confirmed the note still holds. */
  verifiedAt?: string;
  /** Project knowledge that belongs in the repository and waits for the
   *  next task in this project to be moved there. */
  awaitingRepository: boolean;
  archivedAt?: string;
}

export interface MemoryNote extends MemoryNoteSummary {
  body: string;
  /** Where the knowledge comes from (a link, a commit, a document). */
  source?: string;
}

/** The member a request is made for: the server checks it is in that chat
 *  and runs on the device that asks. */
export interface MemoryMemberRef {
  conversationId: string;
  participantId: string;
}

export interface MemorySearchQuery {
  query?: string;
  tags?: string[];
  kind?: MemoryNoteKind;
  scope?: MemoryScope;
  limit?: number;
}

export interface MemoryWriteRequest {
  /** Absent: a new note. */
  noteId?: string;
  /** Required with noteId: the version the change is based on. */
  baseVersion?: number;
  kind?: MemoryNoteKind;
  title?: string;
  body?: string;
  tags?: string[];
  scope?: MemoryScope;
  /** With scope project: the project the note concerns when it is not the
   *  chat's own (its folder's name or path); one of the User's projects,
   *  those of her chats on the server. The note is then seen in that
   *  project's chats only. */
  project?: string;
  source?: string;
  awaitingRepository?: boolean;
  /** The member checked the note still holds. */
  verified?: boolean;
  /** The same request sent again (a retry) changes nothing twice. */
  requestId: string;
}

export interface MemoryArchiveRequest {
  noteId: string;
  requestId: string;
}

export type MemoryErrorCode =
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "duplicate"
  | "access_denied"
  | "server_unavailable";

export interface MemoryError {
  code: MemoryErrorCode;
  message: string;
  /** For conflict and duplicate: the note as it stands. */
  current?: MemoryNoteSummary;
}

export type MemoryResult<T> = { ok: true; value: T } | { ok: false; error: MemoryError };

/** One signed request to the server's memory. */
export type HubMemoryRequest =
  // `picks`: the asking app adds notes picked by meaning to each message
  // (memoryPicks). `full`: every note the member sees (an app asking
  // without it gets the 25 most relevant, or none while notes are picked).
  // `text`: the message the session starts with (and the chat's title), to
  // tell the global notes most relevant to the chat when not all fit. An
  // older server ignores `full` and `text`.
  | ({ action: "index"; picks?: boolean; full?: boolean; text?: string } & MemoryMemberRef)
  | ({ action: "tags" } & MemoryMemberRef)
  | ({ action: "search" } & MemoryMemberRef & MemorySearchQuery)
  | ({ action: "read"; noteId: string } & MemoryMemberRef)
  | ({ action: "write" } & MemoryMemberRef & MemoryWriteRequest)
  | ({ action: "archive" } & MemoryMemberRef & MemoryArchiveRequest)
  // Notes that fit a message, by meaning (only with the User's OpenAI key).
  | ({ action: "pick"; text: string; shown?: MemoryShownNote[] } & MemoryMemberRef)
  // Messages of the chats of this chat's project.
  | ({ action: "chat-search"; query: string; limit?: number } & MemoryMemberRef)
  // The owner only: the OpenAI key for search by meaning (Settings → General).
  | { action: "semantic-settings" }
  | { action: "semantic-key"; key?: string; remove?: boolean }
  // The owner only (Settings → Memory).
  | ({ action: "list" } & MemoryOwnerListQuery)
  | { action: "owner-read"; noteId: string }
  | { action: "delete"; noteId: string }
  // The owner's copy of every note (so they move with the chats to another
  // server): what changed after a place, and putting a copy on a new server.
  | { action: "export"; after?: MemoryExportPlace }
  | { action: "import"; notes: MemoryNote[] };

/** A place in the order of changes on one server. */
export interface MemoryExportPlace {
  seq: number;
  id: string;
}

export interface MemoryExportedNote extends MemoryNote {
  changeSeq: number;
}

export interface MemoryExportValue {
  notes: MemoryExportedNote[];
  /** Notes deleted (by the User, in Settings) in this page's stretch. */
  deleted: Array<{ id: string; changeSeq: number }>;
  /** The server's latest place: lower than a copy's cursor means the
   *  server's notes were started anew (the copy reads everything again). */
  head: number;
  /** Where the next page starts; absent when this was the last one. */
  next?: MemoryExportPlace;
}

export interface MemoryImportValue {
  imported: number;
  /** Already on the server (by id), or not a valid note. */
  skipped: number;
}

/** Notes in one page of the owner's copy read from the server. */
export const MEMORY_EXPORT_PAGE = 100;
/** How large one page of notes moved to a new server may be (under the
 *  server's limit for a request body). */
export const MEMORY_IMPORT_PAGE_BYTES = 180 * 1024;

export interface MemoryOwnerListQuery {
  query?: string;
  tag?: string;
  kind?: MemoryNoteKind;
  scope?: MemoryScope;
  /** Archived notes only (otherwise only notes not archived). */
  archived?: boolean;
}

export interface MemoryIndexValue {
  /** Every note the member sees, its chat's own first (see
   *  MEMORY_INDEX_MAX_NOTES); empty from an older server that picks notes
   *  for each message instead (`picks`). */
  notes: MemoryNoteSummary[];
  /** How many visible notes there are beyond the ones listed. */
  more: number;
  /** The tags used most among the notes this member sees. */
  tags?: MemoryTagCount[];
  /** Search by meaning is on: notes that fit come with each message. */
  picks?: boolean;
  /** Every note the member sees was asked for (`full`) and given, past
   *  MEMORY_INDEX_MAX_NOTES as described there; absent from an older server. */
  full?: boolean;
}

/** A tag in use, with how many notes (not archived) carry it. */
export interface MemoryTagCount {
  tag: string;
  count: number;
}

export interface MemoryTagsValue {
  tags: MemoryTagCount[];
}

/** A note found by search: with the passage where the words asked were
 *  found (absent for a search by tags, kind or scope only). */
export interface MemorySearchHit extends MemoryNoteSummary {
  snippet?: string;
}

export interface MemorySearchValue {
  /** Best match first when words were asked; otherwise the most recently
   *  written, read or confirmed first. */
  notes: MemorySearchHit[];
  /** "meaning": the closest in meaning (the User's OpenAI key) and the best
   *  by the words asked take turns, meaning first. "any-word": a note with any word asked is found,
   *  ranked. Absent from an older server, which finds only notes holding
   *  every word. */
  ranking?: "any-word" | "meaning";
}

/** A note a member was already given in its session (not given again
 *  until it changes). */
export interface MemoryShownNote {
  id: string;
  version: number;
}

/** At most this many notes are picked for one message. */
export const MEMORY_PICK_MAX = 5;
/** What of a message notes are picked for (the rest is not looked at). */
export const MEMORY_PICK_TEXT_MAX_CHARS = 6000;
/** At most this many notes given already are named with a pick. */
export const MEMORY_PICK_SHOWN_MAX = 500;

export interface MemoryPickValue {
  /** Whether the server picks by meaning (the User's OpenAI key is set). */
  enabled: boolean;
  /** The notes that fit, closest first; often none. */
  notes: MemoryNoteSummary[];
}

export const CHAT_SEARCH_DEFAULT_LIMIT = 10;
export const CHAT_SEARCH_MAX_LIMIT = 30;

/** A message found in the chats of a member's project. */
export interface ChatSearchHit {
  conversationId: string;
  chatTitle: string;
  messageId: string;
  /** "User", or the member's handle. */
  author: string;
  createdAt: string;
  /** Where the message matched, cut short. */
  snippet: string;
}

export interface ChatSearchValue {
  hits: ChatSearchHit[];
  /** "meaning": the closest in meaning and the best by the words asked take
   *  turns, meaning first; "any-word": messages holding any word asked. */
  ranking: "meaning" | "any-word";
  /** Old messages are still being printed: some are found by words only. */
  catchingUp?: boolean;
}

/** What Settings shows of search by meaning: never the key itself. */
export interface SemanticSettingsView {
  keySet: boolean;
  /** Why the key stopped working (OpenAI refused it, no credit left). */
  keyError?: string;
  notesPrinted?: number;
  messagesPrinted?: number;
  /** Old notes and messages are still being printed. */
  catchingUp?: boolean;
  /** The last failure while printing (OpenAI unreachable, slowed down). */
  lastError?: string;
}

/** What Settings → General gets: the server's view, or why there is none. */
export interface SemanticSettingsResult {
  status: "ok" | "unavailable";
  view?: SemanticSettingsView;
  message?: string;
}

export interface MemoryOwnerListValue {
  notes: MemoryNoteSummary[];
  /** Whether there were more notes than one page shows. */
  truncated: boolean;
}

/** What Settings → Memory asks for (the owner's view of every note). */
export interface MemorySettingsListRequest extends MemoryOwnerListQuery {}

export interface MemorySettingsListResult {
  /** "unavailable": this computer is not linked to a server yet, or the
   *  server is older and keeps no memory. */
  status: "ok" | "unavailable";
  notes: MemoryNoteSummary[];
  truncated: boolean;
  message?: string;
  /** Names to show for the roles and chats the notes are kept for. */
  roleLabels: Record<string, string>;
  chatTitles: Record<string, string>;
}

export interface MemoryNoteIdRequest {
  noteId: string;
}

export function isMemoryNoteKind(value: unknown): value is MemoryNoteKind {
  return typeof value === "string" && (MEMORY_NOTE_KINDS as readonly string[]).includes(value);
}

export function isMemoryScope(value: unknown): value is MemoryScope {
  return typeof value === "string" && (MEMORY_SCOPES as readonly string[]).includes(value);
}

/** Tags as the server keeps them: lower case, single spaces, no duplicates. */
export function normalizeMemoryTags(tags: readonly unknown[] | undefined): string[] {
  const seen = new Set<string>();
  for (const tag of tags ?? []) {
    if (typeof tag !== "string") continue;
    const normalized = tag.trim().replace(/^#/, "").replace(/\s+/g, " ").toLowerCase();
    if (normalized) seen.add(normalized);
  }
  return [...seen];
}

/** A title as duplicates are told by: case, spacing and punctuation aside
 *  (a title of punctuation or emoji only is told by itself). */
export function memoryTitleKey(title: string): string {
  const lower = title.toLowerCase().normalize("NFKC");
  return lower.replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim() || lower.replace(/\s+/g, " ").trim();
}

/** At most this long a project named for a note (a folder's name or path). */
export const MEMORY_PROJECT_MAX_CHARS = 1000;

/** A folder path as projects are told by: without a trailing slash. */
function projectPathKey(path: string): string {
  return path.trim().replace(/[\\/]+$/, "");
}

/** A project folder's own name: its last part. */
export function memoryProjectName(path: string): string {
  const key = projectPathKey(path);
  return key.slice(Math.max(key.lastIndexOf("/"), key.lastIndexOf("\\")) + 1);
}

/**
 * The projects a name asked for a note means, among the User's (her chats'
 * folders): the folder of that very path, else every folder of that name
 * (case aside). One is the project; none or several is for the member to
 * say again.
 */
export function memoryProjectsNamed(asked: string, projects: readonly string[]): string[] {
  const key = projectPathKey(asked);
  if (!key) return [];
  const exact = projects.filter((path) => projectPathKey(path) === key);
  if (exact.length) return exact.slice(0, 1);
  const name = memoryProjectName(key).toLowerCase();
  return projects.filter((path) => memoryProjectName(path).toLowerCase() === name);
}

/** The memory actions that change notes (sent as POST); the rest only read. */
export const MEMORY_CHANGE_ACTIONS = ["write", "archive", "delete", "import"] as const;

export function isMemoryChangeAction(action: string): boolean {
  return (MEMORY_CHANGE_ACTIONS as readonly string[]).includes(action);
}

/** Sent as POST though they change no note: a message's whole text (too
 *  long for an address), and the OpenAI key (never in an address, which
 *  logs may keep). */
export const MEMORY_POST_ONLY_ACTIONS = ["pick", "semantic-key"] as const;

/** A server older than this app does not know the action asked. */
export function isUnknownMemoryAction(result: MemoryResult<unknown>): boolean {
  return !result.ok && result.error.code === "invalid_request" && /^Unknown memory action/.test(result.error.message);
}

export function isMemoryPostAction(action: string): boolean {
  return isMemoryChangeAction(action) || (MEMORY_POST_ONLY_ACTIONS as readonly string[]).includes(action);
}

/** Whether a request goes as POST: a change, a post-only action, or the
 *  list carrying a message's text (every server takes any action as POST;
 *  a GET of a list without text still works on every server). */
export function memoryRequestIsPost(request: { action: string; text?: unknown }): boolean {
  return isMemoryPostAction(request.action) || (request.action === "index" && typeof request.text === "string");
}
