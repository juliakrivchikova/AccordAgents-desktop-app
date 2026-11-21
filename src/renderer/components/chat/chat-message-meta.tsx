import type { ChatMessage, ChatParticipant } from "../../../shared/types";
import { StatusBadge } from "../primitives";
import { participantProviderLabel } from "./chat-mention-directory";
import { RosterStatusIndicator, type ChatParticipantRosterStatus } from "./chat-roster-status";
import { ChatMessageWhen } from "./chat-streaming";

/**
 * A message's meta line: author, provider, the member's state and the time.
 *
 * In the sessions view (docs/main-session.md) a finished message has none of
 * it: the member's state now says nothing about a message it finished
 * earlier, so it is not shown, and the time is with the message's controls
 * on hover (ChatMessageHoverWhen), as in Claude's and Codex's desktop apps.
 * Only a name the view must tell apart (`authorLabel`, the main session in a
 * member's session) stays. A reply still being written has no status line
 * either: its "Working for …" says it (ChatSessionsRunningReply); one still
 * queued keeps "Queued".
 */
export function ChatMessageMeta(props: {
  message: ChatMessage;
  author: string;
  participant?: ChatParticipant;
  participantStatus: ChatParticipantRosterStatus;
  queued: boolean;
  isStreaming: boolean;
  streamingStartedAt?: string;
  sessions: boolean;
  authorLabel?: string;
  inThread?: boolean;
}): JSX.Element | null {
  const { message, participant, sessions } = props;
  if (sessions && (!props.isStreaming || !props.queued)) {
    return props.authorLabel ? <div className="message-meta"><strong>{props.authorLabel}</strong></div> : null;
  }
  return (
    <div className="message-meta">
      {!sessions ? <strong>{props.author}</strong> : props.authorLabel ? <strong>{props.authorLabel}</strong> : null}
      {!sessions && participant && message.role === "participant" && (
        <span className="message-provider">{participantProviderLabel(participant.kind, participant.hostLabel)}</span>
      )}
      {message.role === "participant" && (
        props.queued ? (
          <span className="chat-rt-status is-queued" title="Status: Queued">
            <span className="chat-rt-status-dot" />
            Queued
          </span>
        ) : (
          <RosterStatusIndicator
            status={props.participantStatus}
            runningRemotely={participant?.remoteExecution === "remote"}
            participantId={message.participantId}
          />
        )
      )}
      <ChatMessageWhen createdAt={message.createdAt} runningSince={props.isStreaming ? props.streamingStartedAt : undefined} />
      {!props.inThread && message.metadata?.parentMessageId && message.role === "user" && (
        <StatusBadge tone="neutral">reply</StatusBadge>
      )}
    </div>
  );
}

/** The time of a finished message in the sessions view, among its controls
 *  shown on hover. */
export function ChatMessageHoverWhen(props: { createdAt: string }): JSX.Element {
  return (
    <span className="message-actions-when" data-testid="chat-message-hover-when">
      <ChatMessageWhen createdAt={props.createdAt} />
    </span>
  );
}
