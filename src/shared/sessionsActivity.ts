// A running reply's work in the sessions view (docs/main-session.md), as T3
// Code shows a turn in progress: one quiet line per step, an outline icon by
// its kind and what it is about (the thinking text, the search query, the
// command, the file). The desktop and the phone read the same rows; the phone
// gets them already made (mobileTimeline.ts, hubPhoneState.ts), short.

import { claudeStepBlocks, claudeStepSummary } from "./claudeStepFold";
import { chatActivityStandsAlone } from "./processingTranscript";
import type { ChatAgentActivityEvent } from "./types";

/** What a row is about: its icon. */
export type SessionsActivityKind = "thinking" | "web" | "shell" | "read" | "edit" | "tool" | "status";

export interface SessionsActivityRow {
  kind: SessionsActivityKind;
  /** One line: what the step is about. */
  text: string;
}

/** A phone's row: a step, or steps folded into one line as Claude Code folds
 *  them (claudeStepFold.ts), drawn without an icon. A phone app from before
 *  folding draws such a line as the status row its kind says. */
export type PhoneActivityRow = SessionsActivityRow & { folded?: true; notice?: true };

/** The rows a phone gets of one reply at most (the newest), and each row's
 *  length: a reply that ran hundreds of tools stays a few lines on the wire. */
export const PHONE_ACTIVITY_ROWS_MAX = 12;
export const PHONE_ACTIVITY_ROW_CHARS = 120;

const THINKING_LABEL = /^(thinking|reasoning)\b/i;
const READ_LABEL = /^(reading|viewing|read)\b/i;
/** A label that only says what kind of step it is: the app's own words from
 *  before rows took each CLI's ("Using Bash", "Running command"), kept in
 *  stored replies, or a CLI's that says no more. Its row says the step's
 *  detail instead when there is one; a label in the CLI's own words ("Running
 *  npm test", "Reading src/a.ts") is the row. */
const KIND_ONLY_LABEL = /^(running command|reading (file|file outline|code|result)|viewing image|updating files|listing files|scanning files|searching (files|code)|fetching url|handling a tool error|using \S+( (search|tool))?|(spawning|messaging|waiting for|using) subagent)$/i;

function oneLine(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/** The first line of an activity's detail: the command, the query, the path. */
function detailLine(detail: string | undefined): string {
  const first = (detail ?? "").split(/\r?\n/).find((line) => line.trim());
  return oneLine(first);
}

/** Whether a step's row says its detail rather than its label (a label that
 *  says only what kind of step it is, or "Thinking"): when a reply's details
 *  are cut, such a step keeps the line its row shows (sessionsRowDetailLine). */
export function sessionsRowShowsDetail(label: string): boolean {
  const line = oneLine(label);
  return THINKING_LABEL.test(line) || KIND_ONLY_LABEL.test(line);
}

/** What a row shows of a detail: its first line, PHONE_ACTIVITY_ROW_CHARS at most. */
export function sessionsRowDetailLine(detail: string | undefined): string {
  return detailLine(detail).slice(0, PHONE_ACTIVITY_ROW_CHARS);
}

/** One step of a reply as its row shows it: its label when that is in the
 *  CLI's own words ("Running npm test"); else the detail (the command, the
 *  query, the path) when the CLI gave one; else the label ("Using Bash"). */
export function sessionsActivityRow(event: Pick<ChatAgentActivityEvent, "kind" | "label" | "detail">): SessionsActivityRow {
  const label = oneLine(event.label);
  const detail = detailLine(event.detail);
  const text = (fallback: string) => (label && !KIND_ONLY_LABEL.test(label) ? label : detail) || fallback;
  if (THINKING_LABEL.test(label)) {
    return { kind: "thinking", text: detail || (label.replace(THINKING_LABEL, "").replace(/^[\s:.…-]+/, "") || label) };
  }
  switch (event.kind) {
    case "command":
      return { kind: "shell", text: text(label) };
    case "web":
      return { kind: "web", text: text(label) };
    case "file-edit":
      return { kind: "edit", text: text(label) };
    case "status":
    case "approval":
      return { kind: "status", text: label || detail };
    default:
      return READ_LABEL.test(label) ? { kind: "read", text: text(label) } : { kind: "tool", text: label || detail };
  }
}

type PhoneActivityEvent = Pick<ChatAgentActivityEvent, "kind" | "label" | "detail" | "status">;

/** A step's row; a notice about the run itself is marked: the phone keeps it
 *  in view under a running reply's one live step line (the User, 2026-11-27). */
function phoneActivityRow(event: PhoneActivityEvent): PhoneActivityRow {
  const row = sessionsActivityRow(event);
  return chatActivityStandsAlone(event) ? { ...row, notice: true } : row;
}

/** The index of the newest block of steps: a notice about the run that came
 *  after them (a background task finishing) is not the step in progress. */
function newestStepBlock(blocks: ReturnType<typeof claudeStepBlocks>): number {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!;
    if (block.fold || !chatActivityStandsAlone(block.event)) return index;
  }
  return -1;
}

/** A Claude Code member's steps, folded; the newest fold says the step it is
 *  at while the reply is being written, with that step's kind (the live
 *  line's icon). */
function foldedPhoneRows(events: readonly PhoneActivityEvent[], live: boolean): PhoneActivityRow[] {
  const blocks = claudeStepBlocks(events);
  const current = live ? newestStepBlock(blocks) : -1;
  return blocks.map((block, index): PhoneActivityRow => {
    if (!block.fold) return phoneActivityRow(block.event);
    if (index === current) return { ...sessionsActivityRow(block.events[block.events.length - 1]!), folded: true };
    return { kind: "status", folded: true, text: claudeStepSummary(block.events) };
  });
}

/** A reply's newest rows as the phone gets them, how many earlier ones were
 *  left out, and how many steps they all stand for where that differs (a
 *  folded row is several): the "N steps" a turn's part folds into says it,
 *  as the computer's does. `claude`: its member runs on Claude Code. `live`:
 *  it is being written. */
export function phoneSessionsActivity(
  events: readonly PhoneActivityEvent[] | undefined,
  options: { claude?: boolean; live?: boolean } = {}
): { activity: PhoneActivityRow[]; activityMore?: number; activitySteps?: number; activityLiveSummary?: string } | undefined {
  if (!Array.isArray(events) || events.length === 0) return undefined;
  const all: PhoneActivityRow[] = options.claude ? foldedPhoneRows(events, options.live === true) : events.map(phoneActivityRow);
  const rows = all.filter((row) => row.text);
  if (rows.length === 0) return undefined;
  const kept = rows.slice(-PHONE_ACTIVITY_ROWS_MAX).map((row) => ({
    ...row,
    text: row.text.length > PHONE_ACTIVITY_ROW_CHARS ? `${row.text.slice(0, PHONE_ACTIVITY_ROW_CHARS - 1).trimEnd()}…` : row.text
  }));
  const more = rows.length - kept.length;
  const steps = events.length !== rows.length ? { activitySteps: events.length } : {};
  // While it runs, its newest fold names the step in progress (the live
  // line, and the current row of a phone app from before); what that fold
  // came to so far is sent beside it, for the opened list.
  const blocks = options.claude && options.live ? claudeStepBlocks(events) : [];
  const lastBlock = blocks[newestStepBlock(blocks)];
  const summary = lastBlock?.fold ? claudeStepSummary(lastBlock.events) : "";
  const live = summary ? { activityLiveSummary: summary.length > PHONE_ACTIVITY_ROW_CHARS ? `${summary.slice(0, PHONE_ACTIVITY_ROW_CHARS - 1).trimEnd()}…` : summary } : {};
  return more > 0 ? { activity: kept, activityMore: more, ...steps, ...live } : { activity: kept, ...steps, ...live };
}

/** Whether a reply's member runs on Claude Code (its steps are folded). */
export function isClaudeMember(participants: unknown, participantId: string | undefined): boolean {
  return Boolean(participantId) && Array.isArray(participants) &&
    participants.some((member: { id?: unknown; kind?: unknown }) => member?.id === participantId && member.kind === "claude-code");
}
