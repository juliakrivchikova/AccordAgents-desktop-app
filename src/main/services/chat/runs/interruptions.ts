import type { ChatMessage } from "../../../../shared/types";

/** A member's reply whose run is gone before it ended (a restart, a quit). */
export const INTERRUPTED_REPLY_TEXT = "Interrupted before completion.";

/** Set once this device repaired the replies an older build left running on
 *  the server (repairRepliesLeftRunning). */
export const REPLIES_REPAIRED_KEY = "chat.replies-left-running.repaired";

/** Ends a member's pending bubble whose run is gone as interrupted, marked
 *  so the run's own result, if it does come, may still replace it. */
export function markInterruptedForRecovery(message: ChatMessage): void {
  message.status = "error";
  if (!message.content) message.content = INTERRUPTED_REPLY_TEXT;
  message.metadata = { ...message.metadata, staleRunRecovery: { runId: message.metadata?.runId, at: new Date().toISOString() } };
}

/** Whether a failed run failed because its process was closed or cancelled
 *  (what quitting does to it), not for a reason of its own (sign-in, a
 *  limit, a missing folder), which the reply keeps saying even then. */
export function closedByQuit(error: string | undefined): boolean {
  return /process exited|exited with code|transport channel closed|stdin is closed|process is not running|worker quit|cancelled|canceled|interrupted|SIGTERM|SIGKILL/i.test(error ?? "");
}

/** A member's turn the User's quit ended (2026-11-22): stopped, as a Stop
 *  is, and saying it was interrupted, alike on the computer and the phone,
 *  whichever ended it first, the quit or the run itself as its process
 *  closed (which alone would say the member "stopped before it returned a
 *  response", an error). */
export function markStoppedByQuit(message: ChatMessage, recovery: boolean, written?: string): void {
  if (recovery) markInterruptedForRecovery(message);
  else {
    message.status = "error";
    // What the member wrote before the quit stays, as the CLI leaves it on
    // screen when interrupted; only a reply with nothing in it says so.
    message.content = written?.trim() ? written : INTERRUPTED_REPLY_TEXT;
  }
  message.metadata = { ...message.metadata, terminalReason: "user-stopped" };
}
