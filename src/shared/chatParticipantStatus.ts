export type ChatParticipantRosterStatus = "idle" | "running" | "pending" | "compacting" | "stopped" | "error";

export function canCompactParticipant(status: ChatParticipantRosterStatus): boolean {
  return status === "idle" || status === "stopped" || status === "error";
}
