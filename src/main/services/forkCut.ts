import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

// Fork to new chat (src/shared/forkToNewChat.ts): the copy of a member's CLI
// session ends with the turn of the reply the User saw last when she tapped
// Fork (the User, 2026-11-21: "When you tap Fork — Like the CLI: the copy is
// exactly what you saw at that moment"). Read on the device that holds the
// session, through each CLI's own cut, verified on the installed CLIs
// (2026-11-21):
// - Claude Code 2.1.329 `--resume <id> --fork-session --resume-session-at
//   <uuid>` keeps the session up to and including that assistant message;
//   it refuses ("No message found with message.uuid of: …") a message before
//   a later compaction, which it does not load, unless that compaction kept
//   the message as it was (its `compactMetadata.preservedMessages`): then
//   the copy is the compaction's summary and the kept messages up to it.
// - Codex 0.155.1 app-server `thread/fork` with `lastTurnId` keeps the
//   thread through that turn (before a later compaction too); an unknown turn
//   is refused ("turn not found: …").

/** Where the copy ends, as the chat asked (ChatSessionForkCut without its
 *  `unknown`): the CLI's own point, or the reply's finish on this device's
 *  clock for a reply from before that point was recorded. */
export interface ForkCutRequest {
  at?: string;
  /** The session `at` is in, when it is not the one the fork would copy. */
  sessionId?: string;
  finishedBy?: string;
  /** No point can be named (forkCutFor): the whole session is copied, and
   *  the runner says why once it knows there is a copy to make. */
  unknown?: string;
}

/** What the fork does: copy up to `at` (with nothing after it yet, that is
 *  all of it, and a turn the member starts meanwhile stays out); or copy all
 *  of it and say why it could not stop there. */
export type ForkCutDecision =
  /** `afterCompaction`: the point is one a later compaction kept. */
  | { kind: "cut"; at: string; afterCompaction?: boolean }
  | { kind: "missed"; reason: string };

/** The CLI refused the point the copy was to end at: Claude Code's words
 *  for a message it did not load, Codex's for an unknown turn. */
export function isForkCutMissingError(text: string | undefined): boolean {
  return /no message found with message\.uuid|turn not found/i.test(text ?? "");
}

// Said in a line every device shows: none says "here".
export const FORK_CUT_NOT_IN_SESSION = "that reply is not in its session";
export const FORK_CUT_NO_TURN_BY_THEN = "none of its session's turns ended by that reply";
// Claude Code loads a compacted session only from its compaction on.
export const FORK_CUT_COMPACTED = "its session was compacted after that reply";
export const FORK_CUT_TRANSCRIPT_UNREADABLE = "its session file could not be read";
export const FORK_CUT_TURNS_UNLISTED = "Codex could not list its session's turns";
export const FORK_CUT_UNSUPPORTED = "this Claude Code cannot end a copy at a reply";
export const FORK_CUT_SESSION_GONE = "its session changed after its last reply, and that earlier session is gone";

/** Claude Code does not know `--resume-session-at` (a hidden flag: a later
 *  version may drop it). */
export function isForkCutUnsupportedError(text: string | undefined): boolean {
  return /unknown option '?--resume-session-at/i.test(text ?? "");
}

/** A row of a Claude Code transcript the cut reads: the conversation's own
 *  user and assistant messages (not a subagent's) and its compactions. */
export interface ClaudeTranscriptRow {
  kind: "assistant" | "user" | "compact";
  uuid?: string;
  at: number;
  /** A user row that is not the member's work: a compaction's summary, the
   *  `/compact` command, and a local command's caveat and output (any
   *  command's: onlyCompactions takes them only around a `/compact`). */
  compaction?: "summary" | "caveat" | "command" | "output";
  /** A compaction's: the messages before it that it kept as they were;
   *  only for one the User asked for (`/compact`, not one the CLI made
   *  itself during a turn, which may hold that turn's prompt). */
  kept?: string[];
}

/** The text of a user row, when it is text. */
function userRowText(message: unknown): string {
  const content = message && typeof message === "object" ? (message as { content?: unknown }).content : undefined;
  if (typeof content === "string") return content;
  if (Array.isArray(content) && content.length === 1 && content[0] && typeof content[0] === "object" && typeof (content[0] as { text?: unknown }).text === "string") {
    return (content[0] as { text: string }).text;
  }
  return "";
}

/** What a user row is to a compaction (as Claude Code 2.1.280-2.1.329 write
 *  them, the app's `/compact` and her own alike). */
function compactionRowOf(entry: Record<string, unknown>): ClaudeTranscriptRow["compaction"] {
  if (entry.isCompactSummary === true) return "summary";
  const text = userRowText(entry.message).trimStart();
  if (entry.isMeta === true && text.startsWith("<local-command-caveat>")) return "caveat";
  if (/^<command-name>\/compact<\/command-name>/.test(text)) return "command";
  if (text.startsWith("<local-command-stdout>")) return "output";
  return undefined;
}

/** The messages a `/compact` kept as they were (Claude Code loads them
 *  after it). None for a compaction the CLI made during a turn (`trigger`
 *  "auto", or one that names the turn it ran in): what it summed up may
 *  hold that turn's prompt, which the User had not seen answered. */
function compactionKept(entry: Record<string, unknown>): string[] | undefined {
  const metadata = entry.compactMetadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const fields = metadata as Record<string, unknown>;
  if (fields.trigger !== "manual" || "runningTurnPrompt" in fields || "runningTurnSends" in fields) return undefined;
  const preserved = fields.preservedMessages;
  if (!preserved || typeof preserved !== "object") return undefined;
  const ids = new Set<string>();
  for (const key of ["uuids", "allUuids"]) {
    const list = (preserved as Record<string, unknown>)[key];
    if (Array.isArray(list)) for (const id of list) if (typeof id === "string" && id) ids.add(id);
  }
  return ids.size ? [...ids] : undefined;
}

/** One transcript line as the cut reads it; undefined for every other line. */
function claudeTranscriptRow(line: string): ClaudeTranscriptRow | undefined {
  // Only lines that can be one of these are parsed.
  if (!line.includes("\"type\":\"assistant\"") && !line.includes("\"type\":\"user\"") && !line.includes("compact_boundary")) return undefined;
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!entry || typeof entry !== "object" || entry.isSidechain === true) return undefined;
  const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
  if (entry.type === "system" && entry.subtype === "compact_boundary") {
    const kept = compactionKept(entry);
    return { kind: "compact", at, ...(kept ? { kept } : {}) };
  }
  if (entry.type === "assistant" || entry.type === "user") {
    const compaction = entry.type === "user" ? compactionRowOf(entry) : undefined;
    return { kind: entry.type, ...(typeof entry.uuid === "string" ? { uuid: entry.uuid } : {}), at, ...(compaction ? { compaction } : {}) };
  }
  return undefined;
}

/** The rows of a transcript file, read a line at a time: a long session is
 *  over a hundred megabytes, and this runs in the app's main process, so it
 *  is neither held whole nor parsed in one go. */
export async function readClaudeTranscriptRows(file: string): Promise<ClaudeTranscriptRow[]> {
  const rows: ClaudeTranscriptRow[] = [];
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    const row = claudeTranscriptRow(line);
    if (row) rows.push(row);
  }
  return rows;
}

/** Rows between the point and a later compaction that are only
 *  compactions: their boundaries, summaries and `/compact` lines (an output
 *  only right after its command). Anything else is the member's work. */
function onlyCompactions(rows: ReadonlyArray<ClaudeTranscriptRow>): boolean {
  let command = false;
  for (const row of rows) {
    if (row.kind === "compact" || row.compaction === "summary" || row.compaction === "caveat") continue;
    if (row.compaction === "command") {
      command = true;
      continue;
    }
    if (row.compaction === "output" && command) {
      command = false;
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Where a Claude Code fork stops, read from the source session's transcript:
 * at the reply's last assistant message (recorded, or the last one written by
 * the reply's finish); all of it, said, when the message is not there or a
 * compaction came after it (the CLI does not load a message before one),
 * unless nothing but compactions came after the message and the last of them
 * kept it as it was: then the CLI loads it, and the copy is that
 * compaction's summary of what came before and the message itself.
 */
export function claudeForkCut(transcript: string | ReadonlyArray<ClaudeTranscriptRow>, request: ForkCutRequest): ForkCutDecision {
  const finishedBy = request.finishedBy ? Date.parse(request.finishedBy) : Number.NaN;
  if (!request.at && !Number.isFinite(finishedBy)) return { kind: "missed", reason: FORK_CUT_NO_TURN_BY_THEN };
  const rows = typeof transcript === "string"
    ? transcript.split("\n").map(claudeTranscriptRow).filter((row): row is ClaudeTranscriptRow => Boolean(row))
    : transcript;
  let index = -1;
  if (request.at) {
    index = rows.findIndex((row) => row.kind === "assistant" && row.uuid === request.at);
  } else {
    for (let candidate = rows.length - 1; candidate >= 0; candidate -= 1) {
      const row = rows[candidate]!;
      if (row.kind === "assistant" && row.uuid && Number.isFinite(row.at) && row.at <= finishedBy) {
        index = candidate;
        break;
      }
    }
  }
  if (index < 0) return { kind: "missed", reason: request.at ? FORK_CUT_NOT_IN_SESSION : FORK_CUT_NO_TURN_BY_THEN };
  const after = rows.slice(index + 1);
  let lastCompaction = -1;
  for (let candidate = after.length - 1; candidate >= 0; candidate -= 1) {
    if (after[candidate]!.kind === "compact") {
      lastCompaction = candidate;
      break;
    }
  }
  if (lastCompaction >= 0) {
    const at = rows[index]!.uuid!;
    const kept = after[lastCompaction]!.kept?.includes(at) && onlyCompactions(after.slice(0, lastCompaction));
    return kept ? { kind: "cut", at, afterCompaction: true } : { kind: "missed", reason: FORK_CUT_COMPACTED };
  }
  // With nothing after it yet the point is given all the same: a turn the
  // member starts before the CLI reads the session stays out of the copy.
  return { kind: "cut", at: rows[index]!.uuid! };
}

/** A Codex turn as `thread/turns/list` gives it (no items). */
export interface CodexTurnSummary {
  id: string;
  status?: string;
  startedAt?: number | null;
  completedAt?: number | null;
}

/** The millisecond a UUIDv7 was made (Codex's turn ids are UUIDv7: made when
 *  the turn starts); undefined for any other id. */
export function uuidV7Ms(id: string): number | undefined {
  const hex = id.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex) || hex[12] !== "7") return undefined;
  return Number.parseInt(hex.slice(0, 12), 16);
}

/** A finished turn that belongs to the reply or came before it: it started
 *  before the reply finished (the next turn of the member starts after its
 *  reply is written), or, for an id that does not say when, it completed by
 *  then (to the second Codex reports). */
function codexTurnEndedBy(turn: CodexTurnSummary, finishedBy: number): boolean {
  if (turn.status === "inProgress") return false;
  const started = uuidV7Ms(turn.id);
  if (started !== undefined) return started < finishedBy;
  return typeof turn.completedAt === "number" && turn.completedAt * 1000 <= finishedBy;
}

/**
 * Where a Codex fork of a reply from before the turn id was recorded stops,
 * from the thread's turns, newest first: the last turn that ended by the
 * reply's finish (the newest too: a turn started meanwhile stays out);
 * undefined when the turns given do not reach it (the caller reads more);
 * said when none ended by then.
 */
export function codexForkCut(turnsNewestFirst: ReadonlyArray<CodexTurnSummary>, finishedBy: string, complete: boolean): ForkCutDecision | undefined {
  const finish = Date.parse(finishedBy);
  if (!Number.isFinite(finish)) return { kind: "missed", reason: FORK_CUT_NO_TURN_BY_THEN };
  const index = turnsNewestFirst.findIndex((turn) => codexTurnEndedBy(turn, finish));
  if (index >= 0) return { kind: "cut", at: turnsNewestFirst[index]!.id };
  return complete ? { kind: "missed", reason: FORK_CUT_NO_TURN_BY_THEN } : undefined;
}
