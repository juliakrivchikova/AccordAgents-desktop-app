/** "background": the member's turn is over but work it started in the
 *  background (Claude Code `run_in_background`) is still running. */
export type ChatParticipantRosterStatus = "idle" | "running" | "pending" | "compacting" | "background" | "stopped" | "error";

export function canCompactParticipant(status: ChatParticipantRosterStatus): boolean {
  return status === "idle" || status === "stopped" || status === "error";
}

/** Whether the User may restart the member's process now: not while it
 *  answers or compacts; with background work it asks first. */
export function canRestartParticipant(status: ChatParticipantRosterStatus): boolean {
  return status === "idle" || status === "stopped" || status === "error" || status === "background";
}

/** Members whose CLI keeps a live process between messages (Gemini starts one
 *  for every message, so restarting it would change nothing). */
export function memberProcessRestartable(kind: string): boolean {
  return kind !== "gemini-cli";
}
