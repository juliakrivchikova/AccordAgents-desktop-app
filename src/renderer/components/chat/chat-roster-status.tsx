import type { ChatParticipantRosterStatus } from "../../../shared/chatParticipantStatus";

export type { ChatParticipantRosterStatus };

const ROSTER_STATUS_LABELS: Record<ChatParticipantRosterStatus, string> = {
  idle: "Idle",
  running: "Running",
  pending: "Pending",
  compacting: "Compacting",
  stopped: "Stopped",
  error: "Error"
};

// Shared borderless dot + label status indicator, reused by the roster name line and
// the message meta row. Intentionally NOT a pill (no background/border) so it reads as
// inline status text rather than a badge.
export function RosterStatusIndicator({
  status,
  runningRemotely = false
}: {
  status: ChatParticipantRosterStatus;
  runningRemotely?: boolean;
}): JSX.Element {
  const label = status === "running" && runningRemotely ? "Running remotely" : ROSTER_STATUS_LABELS[status];
  return (
    <span className={`chat-rt-status is-${status}`} title={`Status: ${label}`}>
      <span className="chat-rt-status-dot" />
      {label}
    </span>
  );
}
