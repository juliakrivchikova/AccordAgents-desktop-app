import type { ComponentProps } from "react";
import { ChevronRight, Loader2, X } from "lucide-react";

import { isWaitingChoice } from "../../../shared/chatActiveRuns";
import { isMainSessionTaskMessage } from "../../../shared/mainSession";
import { machineAnswerPendingText } from "../../../shared/machineWaitingText";
import type { ChatMessage, ChatParticipant } from "../../../shared/types";
import { chatParticipantDisplayName } from "../conversation/conversation-display";
import { Button } from "@/components/ui/button";
import { ChatChoiceCard } from "./chat-choice-card";
import { participantProviderLabel } from "./chat-mention-directory";
import { ChatMessageItem } from "./chat-message-item";
import { chatMessageCards } from "./chat-server-card";
import { ChatTaskCard } from "./chat-task-card";
import type { ChatSessionsView } from "./use-chat-sessions-view";
import { ProviderIcon } from "./provider-icon";

type ChatMessageItemProps = ComponentProps<typeof ChatMessageItem>;

export interface ChatSessionsTimelineContext {
  sessions: ChatSessionsView;
  messages: readonly ChatMessage[];
  onOpenMember: (participantId: string) => void;
}

/** One message row of the sessions view's main timeline: a task card for the
 *  main session's request, a member's card still waiting for the User, or the
 *  message itself without avatar, author or thread controls. */
export function ChatSessionsTimelineRow(props: {
  itemProps: ChatMessageItemProps;
  context: ChatSessionsTimelineContext;
}): JSX.Element {
  const { itemProps, context } = props;
  const { message } = itemProps;
  const batch = message.metadata?.participantRequest;
  if (batch && isMainSessionTaskMessage(message, context.sessions.index)) {
    return (
      <ChatTaskCard
        message={message}
        batch={batch}
        participants={itemProps.participants ?? []}
        participantStatusById={itemProps.participantStatusById}
        messages={context.messages}
        messagesById={context.sessions.messagesById}
        onOpenMember={context.onOpenMember}
      />
    );
  }
  if (context.sessions.openCardMessageIds.has(message.id) && !isWaitingChoice(message)) {
    // A mention approval: the member's message with its card, named.
    const participant = itemProps.participants?.find((candidate) => candidate.id === message.participantId);
    return (
      <ChatMessageItem
        {...itemProps}
        presentation="sessions"
        authorLabel={participant ? chatParticipantDisplayName(participant) : message.participantLabel}
        onOpenThread={undefined}
      />
    );
  }
  if (context.sessions.openCardMessageIds.has(message.id)) {
    return (
      <ChatSessionsChoiceRow
        message={message}
        participant={itemProps.participants?.find((participant) => participant.id === message.participantId)}
        submittingChoiceIds={itemProps.submittingChoiceIds}
        onRespondToChoice={itemProps.onRespondToChoice}
        onOpenMember={context.onOpenMember}
      />
    );
  }
  return <ChatMessageItem {...itemProps} presentation="sessions" onOpenThread={undefined} />;
}

/** A member's choice card that still waits for the User, on the main
 *  timeline: who asks (opens its session) and the card itself. */
export function ChatSessionsChoiceRow(props: {
  message: ChatMessage;
  participant?: ChatParticipant;
  submittingChoiceIds?: ReadonlySet<string>;
  onRespondToChoice: ChatMessageItemProps["onRespondToChoice"];
  onOpenMember: (participantId: string) => void;
}): JSX.Element | null {
  const { message, participant } = props;
  const { choice, choiceAnswered } = chatMessageCards(message);
  if (!choice) {
    return null;
  }
  const name = participant ? chatParticipantDisplayName(participant) : message.participantLabel ?? "A member";
  return (
    <div className="chat-sessions-choice" data-message-id={message.id} data-participant-id={message.participantId} data-testid="chat-sessions-member-choice">
      <button
        type="button"
        className="chat-sessions-choice-from"
        onClick={() => message.participantId && props.onOpenMember(message.participantId)}
      >
        {participant && (
          <ProviderIcon className="chat-provider-icon" kind={participant.kind} label={participantProviderLabel(participant.kind, participant.hostLabel)} />
        )}
        <span>{name} asks</span>
        <ChevronRight size={14} aria-hidden />
      </button>
      <ChatChoiceCard
        choice={choice}
        requesterLabel={name}
        submitting={props.submittingChoiceIds?.has(choice.id) === true}
        onConfirm={(response) => props.onRespondToChoice(message.id, choice.id, response)}
      />
      {choiceAnswered && <div className="chat-queued-badge"><span>{machineAnswerPendingText(choiceAnswered.machineName)}</span></div>}
    </div>
  );
}

/** The line at the end of the main timeline while the main session waits on
 *  its members (and is not answering itself). */
export function ChatSessionsWaitingLine(props: {
  members: readonly ChatParticipant[];
  runIds: readonly string[];
  onStop?: (runIds: readonly string[]) => void;
}): JSX.Element | null {
  if (props.members.length === 0) {
    return null;
  }
  const names = props.members.map((participant) => chatParticipantDisplayName(participant)).join(", ");
  const count = `${props.members.length} ${props.members.length === 1 ? "member" : "members"}`;
  return (
    <div className="chat-sessions-waiting" role="status" data-testid="chat-sessions-waiting" data-waiting-count={props.members.length}>
      <Loader2 size={14} className="spin" aria-hidden />
      <span className="chat-sessions-waiting-text">Waiting on {count}: {names}</span>
      {props.onStop && props.runIds.length > 0 && (
        <Button variant="outline" size="sm" data-testid="chat-sessions-waiting-stop" onClick={() => props.onStop?.(props.runIds)}>
          <X size={14} aria-hidden />
          Stop
        </Button>
      )}
    </div>
  );
}
