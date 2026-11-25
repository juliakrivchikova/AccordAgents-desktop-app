import type { ReactNode } from "react";
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
 * Only an author the view must tell apart stays: a member's open card by its
 * task (`authorLabel`), the main session in a member's session by its
 * provider's logo alone (`authorMark`; it is named by nothing). A reply still being written has no status line
 * either: its "Working for …" says it (ChatSessionsRunningReply); one that
 * has not started has no row (shared/waitingMessages.ts).
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
  authorMark?: ReactNode;
  inThread?: boolean;
}): JSX.Element | null {
  const { message, participant, sessions } = props;
  if (sessions) {
    return props.authorLabel || props.authorMark
      ? <div className="message-meta">{props.authorMark}{props.authorLabel && <strong>{props.authorLabel}</strong>}</div>
      : null;
  }
  return (
    <div className="message-meta">
      <strong>{props.author}</strong>
      {participant && message.role === "participant" && (
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
      {/* A queued reply has no clock, as in the CLI ("Queued") and on the
          phone: the turn's one clock is the running reply's. */}
      <ChatMessageWhen createdAt={message.createdAt} runningSince={props.isStreaming && !props.queued ? props.streamingStartedAt : undefined} />
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
