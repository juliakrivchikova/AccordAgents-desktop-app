/**
 * How a member's bubble ends when its run cannot say so itself (a Stop, a
 * Stop its device never confirmed), and the machine runtime's start counter.
 * Pure functions, so the failure paths are unit-tested.
 */

import type { ChatMessage } from "../../shared/types";

/** Marks a member bubble as stopped by the User (its device confirmed the
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

/** A diagnostic line is added once; a repeated outcome never repeats it. */
function appendNoteOnce(content: string, note: string): string {
  if (content.includes(note)) {
    return content;
  }
  return content.trim() ? `${content}\n\n${note}` : note;
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
