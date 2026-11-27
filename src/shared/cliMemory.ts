/**
 * What members' CLIs remember on their own (Claude Code's auto memory, Codex's
 * memories), kept in members' memory on the User's server too, so members on
 * other providers and on cloud machines see it (the User, 2026-11-27:
 * "Постоянный: новые и изменённые записи Claude Code и Codex подтягиваются
 * сами, всё время"). Each device where members' CLIs run (the computer, every
 * cloud machine) reads its CLIs' stores, never writes them, and sends what is
 * new or changed; the server keeps one note per entry.
 */

import type { MemoryNoteKind } from "./memory";

export const CLI_MEMORY_PROVIDERS = ["claude-code", "codex"] as const;
export type CliMemoryProvider = typeof CLI_MEMORY_PROVIDERS[number];

/** The tag every note from a CLI's memory carries (and its provider's). */
export const CLI_MEMORY_TAG = "cli-memory";

/** Who a note from a CLI's memory is written by: never a member's handle. */
export const CLI_MEMORY_AUTHORS: Record<CliMemoryProvider, string> = {
  "claude-code": "claude-code-memory",
  codex: "codex-memory"
};

export const CLI_MEMORY_LABELS: Record<CliMemoryProvider, string> = {
  "claude-code": "Claude Code",
  codex: "Codex"
};

/** Longest name of an entry's file as the device shows it. */
export const CLI_MEMORY_FILE_MAX_CHARS = 300;
/** Longest name of an entry within its CLI's store (its identity). */
export const CLI_MEMORY_NAME_MAX_CHARS = 200;
/** At most this many entries go in one request. */
export const CLI_MEMORY_SYNC_PAGE = 100;

/** One entry of a CLI's own memory, as a device read it. */
export interface CliMemoryEntry {
  provider: CliMemoryProvider;
  /** The entry's file in its CLI's store, as the device names it
   *  (`~/.claude/projects/<folder>/memory/foo.md`,
   *  `~/.codex/memories/MEMORY.md#<task group>`): with the provider and the
   *  device, what the note is kept for. */
  file: string;
  /** The entry within its store, the same on every device
   *  (`foo.md`, `MEMORY.md#<task group>`): the same entry seen on two
   *  devices is one note. */
  name: string;
  kind: MemoryNoteKind;
  title: string;
  body: string;
  /** Besides `cli-memory` and the provider's tag, which the server adds. */
  tags: string[];
  /** The User's project the entry belongs to (as her chats name it); absent
   *  for an entry that belongs to no project the app knows: a global note. */
  projectPath?: string;
  /** The note this entry filled on the server this device was linked to
   *  before (notes move to a new server with their ids): sent the first
   *  time to a new server, so a moved note is found again and one the User
   *  deleted is not made again. */
  knownNoteId?: string;
}

/** What became of one entry on the server. */
export type CliMemorySyncOutcome =
  /** A new note. */
  | "created"
  /** Its note was changed to the entry as it is now. */
  | "updated"
  /** Nothing changed since the last time it was sent. */
  | "unchanged"
  /** Its note was changed by a member or the User since the sync wrote it,
   *  or it is a note a member wrote with the same title: kept as it is. */
  | "kept"
  /** Its note was deleted by the User: not made again. */
  | "deleted"
  /** Not kept (not a valid entry, too many notes, a title another note has). */
  | "refused";

export interface CliMemorySyncResult {
  provider: CliMemoryProvider;
  file: string;
  outcome: CliMemorySyncOutcome;
  noteId?: string;
  reason?: string;
}

export interface CliMemorySyncValue {
  results: CliMemorySyncResult[];
}
