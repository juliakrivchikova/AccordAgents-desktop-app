export type ChatParticipantRosterStatus = "idle" | "running" | "pending" | "stopped" | "error";

const ROSTER_STATUS_LABELS: Record<ChatParticipantRosterStatus, string> = {
  idle: "Idle",
  running: "Running",
  pending: "Pending",
  stopped: "Stopped",
  error: "Error"
};

// Shared borderless dot + label status indicator, reused by the roster name line and
// the message meta row. Intentionally NOT a pill (no background/border) so it reads as
// inline status text rather than a badge.
export function RosterStatusIndicator({ status }: { status: ChatParticipantRosterStatus }): JSX.Element {
  const label = ROSTER_STATUS_LABELS[status];
  return (
    <span className={`chat-rt-status is-${status}`} title={`Status: ${label}`}>
      <span className="chat-rt-status-dot" />
      {label}
    </span>
  );
}
