import { memo } from "react";
import { ChevronRight } from "lucide-react";

import {
  firstTextLine,
  SESSIONS_WORK_STATUS_LABELS,
  sessionsTaskGroupLabel,
  sessionsTaskReplyLine,
  sessionsTaskRunningSince,
  sessionsTaskStatus,
  type SessionsWorkStatus
} from "../../../shared/mainSessionView";
import type { ChatMessage, ChatParticipant, ChatParticipantRequestBatch } from "../../../shared/types";
import { chatParticipantReference } from "../conversation/conversation-display";
import { participantProviderLabel } from "./chat-mention-directory";
import type { ChatParticipantRosterStatus } from "./chat-roster-status";
import { useStreamingElapsedSeconds } from "./chat-streaming";
import { formatWorkedDuration } from "./chat-worked-row";
import { ProviderIcon } from "./provider-icon";

/** A running time that counts up every second, like a streaming reply's. */
export function ChatElapsed(props: { since: string; className?: string }): JSX.Element {
  const seconds = useStreamingElapsedSeconds(props.since);
  return <span className={props.className ?? "chat-elapsed"}>{formatWorkedDuration(seconds * 1000)}</span>;
}

export function ChatWorkStatusLabel(props: { status: SessionsWorkStatus }): JSX.Element {
  return (
    <span className={`chat-work-status is-${props.status}`} data-work-status={props.status}>
      <span className="chat-work-status-dot" aria-hidden="true" />
      {SESSIONS_WORK_STATUS_LABELS[props.status]}
    </span>
  );
}

/**
 * The main session's request on the main timeline of the sessions view: one
 * row per member it gave a task (its provider, handle, the task, the state,
 * the time while it runs and one line of the result), each opening that
 * member's session.
 */
export const ChatTaskCard = memo(function ChatTaskCard(props: {
  message: ChatMessage;
  batch: ChatParticipantRequestBatch;
  participants: readonly ChatParticipant[];
  participantStatusById: ReadonlyMap<string, ChatParticipantRosterStatus>;
  messages: readonly ChatMessage[];
  messagesById: ReadonlyMap<string, ChatMessage>;
  onOpenMember: (participantId: string) => void;
}): JSX.Element {
  const rows = props.batch.items.map((item) => {
    const participant = props.participants.find((candidate) => candidate.id === item.targetParticipantId);
    const status = sessionsTaskStatus(item, props.participantStatusById.get(item.targetParticipantId));
    return { item, participant, status };
  });
  const grouped = rows.length > 1;
  return (
    <section
      className={`chat-task-card ${grouped ? "is-group" : ""}`}
      data-message-id={props.message.id}
      data-task-batch-id={props.batch.id}
      data-testid="chat-task-card"
      aria-label={grouped ? "Tasks from the main session" : "Task from the main session"}
    >
      {grouped && (
        <header className="chat-task-card-head">{sessionsTaskGroupLabel(rows.map((row) => row.status))}</header>
      )}
      {rows.map(({ item, participant, status }) => {
        const result = status === "done" ? sessionsTaskReplyLine(item, props.messagesById) : undefined;
        const error = status === "failed" ? firstTextLine(item.error) : undefined;
        const handle = chatParticipantReference(participant?.handle ?? item.targetHandle);
        return (
          <button
            type="button"
            className="chat-task-card-row"
            key={`${item.targetParticipantId}:${item.createdAt}`}
            data-testid="chat-task-card-row"
            data-participant-id={item.targetParticipantId}
            data-task-status={status}
            onClick={() => props.onOpenMember(item.targetParticipantId)}
          >
            {participant ? (
              <ProviderIcon
                className="chat-provider-icon"
                kind={participant.kind}
                label={participantProviderLabel(participant.kind, participant.hostLabel)}
              />
            ) : <span className="chat-provider-icon" aria-hidden="true" />}
            <span className="chat-task-card-main">
              <span className="chat-task-card-line">
                <span className="chat-task-card-handle">{handle}</span>
                <span className="chat-task-card-title">{firstTextLine(item.prompt) || "Task"}</span>
              </span>
              {(result || error) && <span className="chat-task-card-result">{result ?? error}</span>}
            </span>
            <span className="chat-task-card-state">
              <ChatWorkStatusLabel status={status} />
              {status === "running" && (
                <ChatElapsed className="chat-task-card-elapsed" since={sessionsTaskRunningSince(item, props.messages)} />
              )}
            </span>
            <ChevronRight className="chat-task-card-chevron" size={15} aria-hidden />
          </button>
        );
      })}
    </section>
  );
});
