import { createContext, useContext } from "react";
import type { ChatParticipantRosterStatus } from "../../../shared/chatParticipantStatus";

export type { ChatParticipantRosterStatus };

const ROSTER_STATUS_LABELS: Record<ChatParticipantRosterStatus, string> = {
  idle: "Idle",
  running: "Running",
  pending: "Pending",
  compacting: "Compacting",
  background: "Background task",
  stopped: "Stopped",
  error: "Error"
};

// Shared borderless dot + label status indicator, reused by the roster name line and
// the message meta row. Intentionally NOT a pill (no background/border) so it reads as
// inline status text rather than a badge.
/** The names of each member's running background tasks in the open chat. */
export const ChatBackgroundTasksContext = createContext<ReadonlyMap<string, readonly string[]>>(new Map());

export function backgroundTasksStatusLabel(count: number): string {
  return count <= 1 ? "1 background task" : `${count} background tasks`;
}

export function RosterStatusIndicator({
  status,
  runningRemotely = false,
  participantId
}: {
  status: ChatParticipantRosterStatus;
  runningRemotely?: boolean;
  participantId?: string;
}): JSX.Element {
  const backgroundTasks = useContext(ChatBackgroundTasksContext).get(participantId ?? "") ?? [];
  const label = status === "running" && runningRemotely
    ? "Running remotely"
    : status === "background"
      ? backgroundTasksStatusLabel(backgroundTasks.length)
      : ROSTER_STATUS_LABELS[status];
  const title = status === "background" && backgroundTasks.length > 0
    ? `Running in the background:\n${backgroundTasks.join("\n")}`
    : `Status: ${label}`;
  return (
    <span className={`chat-rt-status is-${status}`} title={title}>
      <span className="chat-rt-status-dot" />
      {label}
    </span>
  );
}
