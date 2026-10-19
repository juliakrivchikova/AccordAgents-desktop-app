/** "background": the member's turn is over but work it started in the
 *  background (Claude Code `run_in_background`) is still running. */
export type ChatParticipantRosterStatus = "idle" | "running" | "pending" | "compacting" | "background" | "stopped" | "error";

export function canCompactParticipant(status: ChatParticipantRosterStatus): boolean {
  return status === "idle" || status === "stopped" || status === "error";
}
