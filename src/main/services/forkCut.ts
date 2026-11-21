// Fork to new chat (src/shared/forkToNewChat.ts): the copy of a member's CLI
// session ends with the turn of the reply the User saw last when she tapped
// Fork (the User, 2026-11-21: "When you tap Fork — Like the CLI: the copy is
// exactly what you saw at that moment"). Read on the device that holds the
// session, through each CLI's own cut, verified on the installed CLIs
// (2026-11-21):
// - Claude Code 2.1.329 `--resume <id> --fork-session --resume-session-at
//   <uuid>` keeps the session up to and including that assistant message;
//   it refuses ("No message found with message.uuid of: …") a message before
//   a later compaction, which it does not load.
// - Codex 0.155.1 app-server `thread/fork` with `lastTurnId` keeps the
//   thread through that turn (before a later compaction too); an unknown turn
//   is refused ("turn not found: …").

/** Where the copy ends, as the chat asked (ChatSessionForkCut without its
 *  `unknown`): the CLI's own point, or the reply's finish on this device's
 *  clock for a reply from before that point was recorded. */
export interface ForkCutRequest {
  at?: string;
  finishedBy?: string;
}

/** What the fork does: copy up to `at`; copy all of it (nothing came after
 *  the reply, as before); or copy all of it and say why it could not stop
 *  there. */
export type ForkCutDecision =
  | { kind: "cut"; at: string }
  | { kind: "whole" }
  | { kind: "missed"; reason: string };

/** The CLI refused the point the copy was to end at: Claude Code's words
 *  for a message it did not load, Codex's for an unknown turn. */
export function isForkCutMissingError(text: string | undefined): boolean {
  return /no message found with message\.uuid|turn not found/i.test(text ?? "");
}

export const FORK_CUT_NOT_IN_SESSION = "that reply is not in its session here";
export const FORK_CUT_NO_TURN_BY_THEN = "none of its session's turns here ended by that reply";
// Claude Code loads a compacted session only from its compaction on.
export const FORK_CUT_COMPACTED = "its session was compacted after that reply";
export const FORK_CUT_TRANSCRIPT_UNREADABLE = "its session file could not be read here";
export const FORK_CUT_TURNS_UNLISTED = "Codex could not list its session's turns";
export const FORK_CUT_UNSUPPORTED = "this Claude Code cannot end a copy at a reply";

/** Claude Code does not know `--resume-session-at` (a hidden flag: a later
 *  version may drop it). */
export function isForkCutUnsupportedError(text: string | undefined): boolean {
  return /unknown option '?--resume-session-at/i.test(text ?? "");
}

interface TranscriptRow {
  kind: "assistant" | "user" | "compact";
  uuid?: string;
  at: number;
}

/** The rows of a Claude Code transcript the cut reads, in file order: the
 *  conversation's own user and assistant messages (not a subagent's) and its
 *  compactions. */
function claudeTranscriptRows(transcript: string): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (const line of transcript.split("\n")) {
    // Only lines that can be one of these are parsed: a long session is tens
    // of megabytes.
    if (!line.includes("\"type\":\"assistant\"") && !line.includes("\"type\":\"user\"") && !line.includes("compact_boundary")) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object" || entry.isSidechain === true) continue;
    const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
    if (entry.type === "system" && entry.subtype === "compact_boundary") {
      rows.push({ kind: "compact", at });
    } else if (entry.type === "assistant" || entry.type === "user") {
      rows.push({ kind: entry.type, ...(typeof entry.uuid === "string" ? { uuid: entry.uuid } : {}), at });
    }
  }
  return rows;
}

/**
 * Where a Claude Code fork stops, read from the source session's transcript:
 * at the reply's last assistant message (recorded, or the last one written by
 * the reply's finish); all of it when nothing of the conversation follows
 * that message; all of it, said, when the message is not there or a
 * compaction came after it (the CLI does not load a message before one).
 */
export function claudeForkCut(transcript: string, request: ForkCutRequest): ForkCutDecision {
  const finishedBy = request.finishedBy ? Date.parse(request.finishedBy) : Number.NaN;
  if (!request.at && !Number.isFinite(finishedBy)) return { kind: "missed", reason: FORK_CUT_NO_TURN_BY_THEN };
  const rows = claudeTranscriptRows(transcript);
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
  if (after.length === 0) return { kind: "whole" };
  if (after.some((row) => row.kind === "compact")) return { kind: "missed", reason: FORK_CUT_COMPACTED };
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
 * reply's finish; all of it when that is the newest; undefined when the
 * turns given do not reach it (the caller reads more); said when none ended
 * by then.
 */
export function codexForkCut(turnsNewestFirst: ReadonlyArray<CodexTurnSummary>, finishedBy: string, complete: boolean): ForkCutDecision | undefined {
  const finish = Date.parse(finishedBy);
  if (!Number.isFinite(finish)) return { kind: "missed", reason: FORK_CUT_NO_TURN_BY_THEN };
  const index = turnsNewestFirst.findIndex((turn) => codexTurnEndedBy(turn, finish));
  if (index === 0) return { kind: "whole" };
  if (index > 0) return { kind: "cut", at: turnsNewestFirst[index]!.id };
  return complete ? { kind: "missed", reason: FORK_CUT_NO_TURN_BY_THEN } : undefined;
}
