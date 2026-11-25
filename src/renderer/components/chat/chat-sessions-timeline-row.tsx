import type { ComponentProps } from "react";
import { CaretRightIcon } from "@phosphor-icons/react";

import { isWaitingChoice } from "../../../shared/chatActiveRuns";
import { isMainSessionTaskMessage } from "../../../shared/mainSession";
import { machineAnswerPendingText } from "../../../shared/machineWaitingText";
import type { SessionsTaskEntry } from "../../../shared/mainSessionView";
import type { ChatMessage, ChatParticipant } from "../../../shared/types";
import { ChatChoiceCard } from "./chat-choice-card";
import { ChatDelegationRows } from "./chat-delegation-fold";
import { ChatProviderMark } from "./chat-member-mark";
import { ChatMessageItem } from "./chat-message-item";
import { chatMessageCards } from "./chat-server-card";
import type { ChatSessionsView } from "./use-chat-sessions-view";

type ChatMessageItemProps = ComponentProps<typeof ChatMessageItem>;

export interface ChatSessionsTimelineContext {
  sessions: ChatSessionsView;
  onOpenMember: (participantId: string, focusMessageId?: string) => void;
  onOpenTask: (entry: SessionsTaskEntry) => void;
}

const NO_WORK: readonly SessionsTaskEntry[] = [];

/** One message row of the sessions view's main timeline: the message without
 *  avatar, author or thread controls (the main session's reply with the tasks
 *  of its turn in its "Worked for …" fold), a member's card still waiting for
 *  the User, or a task whose reply is not loaded, on its own. */
export function ChatSessionsTimelineRow(props: {
  itemProps: ChatMessageItemProps;
  context: ChatSessionsTimelineContext;
}): JSX.Element {
  const { itemProps, context } = props;
  const { message } = itemProps;
  const { sessions } = context;
  if (message.metadata?.participantRequest && isMainSessionTaskMessage(message, sessions.index)) {
    return (
      <div className="chat-sessions-task" data-message-id={message.id} data-testid="chat-sessions-task">
        <ChatDelegationRows bare entries={sessions.taskEntriesByMessageId.get(message.id) ?? NO_WORK} participants={itemProps.participants} onOpenTask={context.onOpenTask} />
      </div>
    );
  }
  const title = message.participantId ? sessions.memberTitle(message.participantId) : "A session";
  if (sessions.openCardMessageIds.has(message.id) && !isWaitingChoice(message)) {
    // A mention approval: the member's message with its card, named.
    return <ChatMessageItem {...itemProps} presentation="sessions" authorLabel={title} onOpenThread={undefined} />;
  }
  if (sessions.openCardMessageIds.has(message.id)) {
    return (
      <ChatSessionsChoiceRow
        message={message}
        title={title}
        participant={itemProps.participants?.find((participant) => participant.id === message.participantId)}
        submittingChoiceIds={itemProps.submittingChoiceIds}
        onRespondToChoice={itemProps.onRespondToChoice}
        onOpenMember={context.onOpenMember}
      />
    );
  }
  const waiting = sessions.waiting.get(message.id);
  return (
    <ChatMessageItem
      {...itemProps}
      presentation="sessions"
      onOpenThread={undefined}
      waitingRunId={waiting?.runId}
      waitingBehindRunId={waiting?.behind?.runId}
      sessionsWork={sessions.workByReplyId.get(message.id)}
      onOpenTask={context.onOpenTask}
    />
  );
}

/** A member's choice card that still waits for the User, on the main
 *  timeline: who asks (its task's title; opens its session) and the card. */
export function ChatSessionsChoiceRow(props: {
  message: ChatMessage;
  title: string;
  participant?: ChatParticipant;
  submittingChoiceIds?: ReadonlySet<string>;
  onRespondToChoice: ChatMessageItemProps["onRespondToChoice"];
  onOpenMember: (participantId: string, focusMessageId?: string) => void;
}): JSX.Element | null {
  const { message, participant } = props;
  const { choice, choiceAnswered } = chatMessageCards(message);
  if (!choice) {
    return null;
  }
  return (
    <div className="chat-sessions-choice" data-message-id={message.id} data-participant-id={message.participantId} data-testid="chat-sessions-member-choice">
      <button
        type="button"
        className="chat-sessions-choice-from"
        onClick={() => message.participantId && props.onOpenMember(message.participantId, message.id)}
      >
        {participant && <ChatProviderMark member={participant} />}
        <span>{props.title} asks</span>
        <CaretRightIcon size={14} aria-hidden />
      </button>
      <ChatChoiceCard
        choice={choice}
        requesterLabel={props.title}
        submitting={props.submittingChoiceIds?.has(choice.id) === true}
        onConfirm={(response) => props.onRespondToChoice(message.id, choice.id, response)}
      />
      {choiceAnswered && <div className="chat-queued-badge"><span>{machineAnswerPendingText(choiceAnswered.machineName)}</span></div>}
    </div>
  );
}
