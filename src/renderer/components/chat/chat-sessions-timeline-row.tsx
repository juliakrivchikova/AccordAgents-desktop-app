import type { ComponentProps } from "react";
import { ChevronRight, Loader2, X } from "lucide-react";

import { isWaitingChoice } from "../../../shared/chatActiveRuns";
import { isMainSessionTaskMessage } from "../../../shared/mainSession";
import { machineAnswerPendingText } from "../../../shared/machineWaitingText";
import type { SessionsTaskEntry } from "../../../shared/mainSessionView";
import type { ChatMessage, ChatParticipant } from "../../../shared/types";
import { Button } from "@/components/ui/button";
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
  const title = message.participantId ? sessions.memberTitle(message.participantId) : "A member";
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
  return (
    <ChatMessageItem
      {...itemProps}
      presentation="sessions"
      onOpenThread={undefined}
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
        <ChevronRight size={14} aria-hidden />
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

/** The line at the end of the main timeline while the main session waits on
 *  its members (and is not answering itself): their tasks, and Stop. */
export function ChatSessionsWaitingLine(props: {
  members: readonly ChatParticipant[];
  text: string;
  runIds: readonly string[];
  onStop?: (runIds: readonly string[]) => void;
}): JSX.Element | null {
  if (props.members.length === 0) {
    return null;
  }
  return (
    <div className="chat-sessions-waiting" role="status" data-testid="chat-sessions-waiting" data-waiting-count={props.members.length}>
      <Loader2 size={14} className="spin" aria-hidden />
      <span className="chat-sessions-waiting-text">{props.text}</span>
      {props.onStop && props.runIds.length > 0 && (
        <Button variant="ghost" size="sm" data-testid="chat-sessions-waiting-stop" onClick={() => props.onStop?.(props.runIds)}>
          <X size={14} aria-hidden />
          Stop
        </Button>
      )}
    </div>
  );
}
