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
/** A note nobody wrote, read or confirmed for this long leaves the list a
 *  member is shown at the start of a session (it is still found by search). */
export const MEMORY_INDEX_STALE_DAYS = 60;
/** At most this many notes are listed at the start of a session. */
export const MEMORY_INDEX_MAX_NOTES = 25;
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
  | ({ action: "index" } & MemoryMemberRef)
  | ({ action: "tags" } & MemoryMemberRef)
  | ({ action: "search" } & MemoryMemberRef & MemorySearchQuery)
  | ({ action: "read"; noteId: string } & MemoryMemberRef)
  | ({ action: "write" } & MemoryMemberRef & MemoryWriteRequest)
  | ({ action: "archive" } & MemoryMemberRef & MemoryArchiveRequest)
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
  notes: MemoryNoteSummary[];
  /** How many visible notes there are beyond the ones listed. */
  more: number;
  /** The tags used most among the notes this member sees. */
  tags?: MemoryTagCount[];
}

/** A tag in use, with how many notes (not archived) carry it. */
export interface MemoryTagCount {
  tag: string;
  count: number;
}

export interface MemoryTagsValue {
  tags: MemoryTagCount[];
}

export interface MemorySearchValue {
  notes: MemoryNoteSummary[];
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

/** The memory actions that change notes (sent as POST); the rest only read. */
export const MEMORY_CHANGE_ACTIONS = ["write", "archive", "delete", "import"] as const;

export function isMemoryChangeAction(action: string): boolean {
  return (MEMORY_CHANGE_ACTIONS as readonly string[]).includes(action);
}
