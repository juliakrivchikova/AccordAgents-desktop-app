/**
 * Machines transport: the one place a machine's turn result is folded into
 * the desktop's copy of the member bubble, whatever the outcome, plus the
 * small durable-state helpers of the machine runtime (instance counter and
 * outbox validation). Pure functions, so the failure paths are unit-tested.
 */

import type { ChatMessage, ChatMessageMetadata } from "../../shared/types";
import type { MachineTurnFinishedBody } from "../../shared/machineLink";

export type MachineTurnOutcomeStatus = "completed" | "interrupted" | "failed" | "unconfirmed";

export interface MachineTurnOutcomeInput {
  status: MachineTurnOutcomeStatus;
  messages: ChatMessage[];
  error?: string;
  /** The machine's own finish time of this result; absent for outcomes the
   *  desktop produced itself (a timeout, a lost run). */
  finishedAt?: string;
  receiptId?: string;
}

/** Marks a member bubble as stopped by the User (the machine confirmed the
 *  run is gone). Delivered text is kept. */
export function markStoppedByUser(message: ChatMessage, handle: string, options: { preserveContent?: boolean } = {}): void {
  message.status = "error";
  if (!options.preserveContent || !message.content.trim()) {
    message.content = `@${handle} stopped by user.`;
  }
  message.metadata = { ...message.metadata, terminalReason: "user-stopped" };
}

/** Rule 2 (docs/parity-requirements.md): a Stop the member's machine never
 *  confirmed is shown as exactly that, never as "stopped by user". */
export function markStopUnconfirmed(message: ChatMessage, handle: string, reason?: string): void {
  message.status = "error";
  const detail = reason?.trim() ? ` ${reason.trim()}` : "";
  const note = `Stop not confirmed for @${handle}: the machine did not confirm the run is gone.${detail}`;
  message.content = appendNoteOnce(message.content, note);
  message.metadata = { ...message.metadata, terminalReason: "stop-unconfirmed" };
}

/** A diagnostic line is added once; a redelivered outcome never repeats it. */
function appendNoteOnce(content: string, note: string): string {
  if (content.includes(note)) {
    return content;
  }
  return content.trim() ? `${content}\n\n${note}` : note;
}

/** Folds a machine's result into the desktop's bubble for every status:
 *  the machine's copy of the bubble (same id) always contributes its text
 *  and metadata, other messages of the run are returned for insertion, and
 *  the status decides the terminal marking. Returns the messages that are
 *  not the bubble itself. */
export function foldMachineTurnResult(
  bubble: ChatMessage,
  handle: string,
  runId: string,
  result: MachineTurnOutcomeInput
): ChatMessage[] {
  const reply = result.messages.find((message) => message.id === bubble.id);
  const others = result.messages.filter((message) => message.id !== bubble.id);
  const applied = bubble.metadata?.machineOutcome;
  if (applied?.runId === runId && applied.finishedAt && !result.finishedAt) {
    // A restored dispatch intent can receive "unknown" after the actual
    // result was already stored and acknowledged. Recovery cannot erase it.
    return others;
  }
  if (applied && applied.runId === runId && applied.status === result.status && applied.finishedAt !== undefined && applied.finishedAt === result.finishedAt && applied.receiptId === result.receiptId) {
    // The very same result again (a redelivery): the bubble already carries
    // it. A different result of the same run (a real terminal after a
    // provisional desktop-side outcome) is folded.
    return others;
  }
  if (reply) {
    if (reply.content.trim() || !bubble.content.trim()) {
      bubble.content = reply.content;
    }
    const metadata: ChatMessageMetadata = { ...bubble.metadata, ...reply.metadata, runId };
    // Terminal markings below decide the reason; the machine's stopPending
    // mark never survives the outcome.
    delete metadata.stopPending;
    bubble.metadata = metadata;
  }
  bubble.metadata = { ...bubble.metadata, machineOutcome: { runId, status: result.status, ...(result.finishedAt ? { finishedAt: result.finishedAt } : {}), ...(result.receiptId ? { receiptId: result.receiptId } : {}) } };
  delete bubble.metadata.stopPending;
  switch (result.status) {
    case "completed":
      if (reply) {
        bubble.status = reply.status === "pending" ? "done" : (reply.status ?? "done");
      } else {
        bubble.status = "error";
        bubble.content = `@${handle} finished on its machine without a reply.`;
      }
      return others;
    case "interrupted":
      markStoppedByUser(bubble, handle, { preserveContent: true });
      return others;
    case "unconfirmed":
      markStopUnconfirmed(bubble, handle, result.error);
      return others;
    case "failed": {
      bubble.status = "error";
      const detail = result.error?.trim() ? `: ${result.error.trim()}` : ".";
      bubble.content = appendNoteOnce(bubble.content, `@${handle} failed on its machine${detail}`);
      return others;
    }
    default:
      return others;
  }
}

/** Reads and advances the machine's start counter. The number is published
 *  only when it was read reliably (or the file did not exist yet) and the
 *  increment was written durably; otherwise undefined, so a desktop never
 *  sees a number that could repeat after the next start. */
export function advanceInstanceSequence(
  io: {
    read: () => string;
    write: (content: string) => void;
    now: () => number;
  }
): { sequence?: number; error?: string } {
  let previous: number | undefined;
  try {
    const parsed = JSON.parse(io.read()) as { sequence?: unknown };
    if (typeof parsed.sequence !== "number" || !Number.isFinite(parsed.sequence)) {
      return { error: "the instance counter file is damaged" };
    }
    previous = parsed.sequence;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      previous = undefined;
    } else {
      return { error: `the instance counter could not be read: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const next = previous === undefined ? Math.max(1, io.now()) : Math.max(previous + 1, io.now());
  try {
    io.write(JSON.stringify({ sequence: next }));
  } catch (error) {
    return { error: `the instance counter could not be written: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { sequence: next };
}

const TERMINAL_STATUSES = new Set<string>(["completed", "interrupted", "failed"]);

/** A stored outbox entry is accepted only when every field the desktop will
 *  act on has the expected shape. */
export function isStoredTerminal(entry: unknown): entry is MachineTurnFinishedBody {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const record = entry as Partial<MachineTurnFinishedBody>;
  return record.type === "machine.turn.finished" &&
    typeof record.runId === "string" && record.runId.length > 0 &&
    typeof record.conversationId === "string" && record.conversationId.length > 0 &&
    typeof record.participantId === "string" &&
    typeof record.status === "string" && TERMINAL_STATUSES.has(record.status) &&
    Array.isArray(record.messages) && record.messages.every(isStoredMessage) &&
    Array.isArray(record.warnings) && record.warnings.every((warning) => typeof warning === "string") &&
    typeof record.finishedAt === "string" &&
    (record.receiptId === undefined || (typeof record.receiptId === "string" && record.receiptId.length > 0)) &&
    (record.error === undefined || typeof record.error === "string");
}

function isStoredMessage(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const message = value as Partial<ChatMessage>;
  return typeof message.id === "string" && message.id.length > 0 &&
    typeof message.role === "string" &&
    typeof message.content === "string" &&
    typeof message.createdAt === "string";
}
