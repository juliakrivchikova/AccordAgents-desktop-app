import { useMemo, useRef } from "react";

import type { ActiveChatRunSummary } from "../../../shared/chatActiveRuns";
import { isPendingReply } from "../../../shared/chatActiveRuns";
import {
  buildSessionsViewIndex,
  isOtherMemberTurnFinishedNote,
  mainSessionParticipantId,
  membersMainSessionWaitsOn,
  sessionsFormerMembers,
  sessionsTaskPlacement,
  sessionsViewLane,
  type SessionsFormerMember,
  type SessionsViewIndex,
  type SessionsViewLane
} from "../../../shared/mainSession";
import {
  isMainSessionDelegationRosterCard,
  isMemberWorking,
  latestTaskByMember,
  openMemberCardMessages,
  sessionsFormerMemberStatus,
  sessionsMemberActivity,
  sessionsMemberRows,
  sessionsMemberTitle,
  sessionsTaskEntries,
  sessionsWaitingText,
  type SessionsMemberActivity,
  type SessionsMemberRow,
  type SessionsMemberTask,
  type SessionsTaskEntry,
  type SessionsWorkStatus
} from "../../../shared/mainSessionView";
import type { ChatAppToolApproval, ChatMessage, ChatParticipant, ChatViewMode, Conversation } from "../../../shared/types";
import type { ChatParticipantRosterStatus } from "./chat-roster-status";
import { isChatMessageHiddenInChat } from "./chat-thread-data";

export { useChatSessionsChrome } from "./use-chat-sessions-chrome";

/** A member no longer in the chat, listed read-only under "Removed". */
export interface SessionsFormerRow {
  member: SessionsFormerMember;
  title: string;
  status: SessionsWorkStatus;
  task?: SessionsMemberTask;
}

/** Everything the sessions view shows, worked out once per change of the
 *  loaded chat (docs/main-session.md, shared/mainSession.ts). */
export interface ChatSessionsView {
  mainSessionId: string;
  index: SessionsViewIndex;
  /** The main timeline's messages: the User and the main session, and
   *  members' choice cards still open. The main session's tasks are inside
   *  the replies of the turns that gave them (workByReplyId); a task whose
   *  reply is not loaded is here on its own. */
  mainMessages: ChatMessage[];
  /** Members' messages on the main timeline only for their open card. */
  openCardMessageIds: ReadonlySet<string>;
  messagesById: ReadonlyMap<string, ChatMessage>;
  tasksByMember: ReadonlyMap<string, SessionsMemberTask>;
  activity: SessionsMemberActivity;
  /** Each request message's tasks, by the message's id. */
  taskEntriesByMessageId: ReadonlyMap<string, readonly SessionsTaskEntry[]>;
  /** The tasks shown inside a reply of the main session, by the reply's id. */
  workByReplyId: ReadonlyMap<string, readonly SessionsTaskEntry[]>;
  memberRows: { current: SessionsMemberRow[]; previous: SessionsMemberRow[] };
  formerRows: SessionsFormerRow[];
  runningMemberCount: number;
  /** "Waiting on N members", while the main session is not answering. */
  waitingOn: ChatParticipant[];
  waitingText: string;
  waitingRunIds: string[];
  /** A member's (or former member's) title: its latest task's first line. */
  memberTitle: (participantId: string) => string;
  isFormerMember: (participantId: string) => boolean;
  laneOf: (message: ChatMessage) => SessionsViewLane;
  /** A card the sessions view does not show: the member a delegation added. */
  hidesApproval: (approval: ChatAppToolApproval) => boolean;
}

const NO_ENTRIES: readonly SessionsTaskEntry[] = [];

/** Keeps each value's identity while its signature is the same, so a row
 *  drawn from it is not drawn again on every update of the chat. */
function useSignatureCache<T>(): (key: string, signature: string, value: () => T) => T {
  const cache = useRef(new Map<string, { signature: string; value: T }>());
  return (key, signature, value) => {
    const known = cache.current.get(key);
    if (known && known.signature === signature) return known.value;
    const next = value();
    cache.current.set(key, { signature, value: next });
    return next;
  };
}

function entriesSignature(entries: readonly SessionsTaskEntry[]): string {
  return entries.map((entry) =>
    [entry.messageId, entry.item.targetParticipantId, entry.item.replyMessageId, entry.title, entry.status, entry.since, entry.durationMs, entry.line].join("\u0001")
  ).join("\u0002");
}

export function useChatSessionsView(input: {
  conversation: Conversation;
  view: ChatViewMode;
  participants: ChatParticipant[];
  participantStatusById: ReadonlyMap<string, ChatParticipantRosterStatus>;
  activeRunSummary: ActiveChatRunSummary;
}): ChatSessionsView | undefined {
  const { conversation, view, participants, participantStatusById, activeRunSummary } = input;
  const mainId = view === "sessions" ? mainSessionParticipantId(conversation.metadata) : undefined;
  const cached = useSignatureCache<readonly SessionsTaskEntry[]>();

  const placement = useMemo(() => {
    if (!mainId) return undefined;
    const messages = conversation.messages;
    const index = buildSessionsViewIndex(messages, mainId);
    const shown = (message: ChatMessage): boolean => !isChatMessageHiddenInChat(conversation, message);
    const openCards = openMemberCardMessages(messages, index).filter(shown);
    const openCardMessageIds = new Set(openCards.map((message) => message.id));
    const lane = messages.filter((message) => openCardMessageIds.has(message.id) ||
      (sessionsViewLane(message, index).kind === "main" && shown(message) && !isOtherMemberTurnFinishedNote(message, index)));
    const tasks = sessionsTaskPlacement(lane, index);
    return {
      index,
      mainMessages: lane.filter((message) => !tasks.placedTaskIds.has(message.id)),
      tasks,
      openCardMessageIds,
      messagesById: new Map(messages.map((message) => [message.id, message])),
      tasksByMember: latestTaskByMember(messages),
      activity: sessionsMemberActivity(messages),
      waitingIds: membersMainSessionWaitsOn(messages, index),
      mainStreaming: messages.some((message) => isPendingReply(message) && message.participantId === mainId),
      requestMessages: messages.filter((message) => message.metadata?.participantRequest)
    };
  }, [conversation.messages, mainId]);

  const former = useMemo(
    () => (mainId ? sessionsFormerMembers(conversation.messages, participants, mainId) : []),
    [conversation.messages, mainId, participants]
  );

  return useMemo(() => {
    if (!mainId || !placement) return undefined;
    const byId = new Map(participants.map((participant) => [participant.id, participant]));
    const formerById = new Map(former.map((member) => [member.id, member]));
    const memberTitle = (participantId: string): string => {
      const task = placement.tasksByMember.get(participantId)?.item;
      return sessionsMemberTitle(byId.get(participantId) ?? formerById.get(participantId), task);
    };
    const taskEntriesByMessageId = new Map<string, readonly SessionsTaskEntry[]>();
    for (const message of placement.requestMessages) {
      const batch = message.metadata!.participantRequest!;
      const entries = sessionsTaskEntries(message, batch, participantStatusById, placement.activity, placement.messagesById);
      taskEntriesByMessageId.set(message.id, cached(message.id, entriesSignature(entries), () => entries));
    }
    const workByReplyId = new Map<string, readonly SessionsTaskEntry[]>();
    for (const [replyId, tasks] of placement.tasks.tasksByReplyId) {
      const entries = tasks.flatMap((task) => taskEntriesByMessageId.get(task.id) ?? NO_ENTRIES);
      workByReplyId.set(replyId, cached(`reply:${replyId}`, entriesSignature(entries), () => entries));
    }
    const waitingOn = placement.mainStreaming
      ? []
      : placement.waitingIds.flatMap((id) => {
        const participant = byId.get(id);
        return participant ? [participant] : [];
      });
    const index = placement.index;
    return {
      mainSessionId: mainId,
      index,
      mainMessages: placement.mainMessages,
      openCardMessageIds: placement.openCardMessageIds,
      messagesById: placement.messagesById,
      tasksByMember: placement.tasksByMember,
      activity: placement.activity,
      taskEntriesByMessageId,
      workByReplyId,
      memberRows: sessionsMemberRows(participants, mainId, participantStatusById, placement.tasksByMember, placement.activity.finishedAt),
      formerRows: former.map((member) => {
        const task = placement.tasksByMember.get(member.id);
        return { member, title: memberTitle(member.id), status: sessionsFormerMemberStatus(task?.item), ...(task ? { task } : {}) };
      }),
      runningMemberCount: participants.filter((participant) =>
        participant.id !== mainId && isMemberWorking(participantStatusById.get(participant.id))).length,
      waitingOn,
      waitingText: sessionsWaitingText(waitingOn.map((participant) => memberTitle(participant.id))),
      waitingRunIds: waitingOn.flatMap((participant) => activeRunSummary.runIdsByParticipantId.get(participant.id) ?? []),
      memberTitle,
      isFormerMember: (participantId: string) => formerById.has(participantId),
      laneOf: (message: ChatMessage) => sessionsViewLane(message, index),
      hidesApproval: (approval: ChatAppToolApproval) => isMainSessionDelegationRosterCard(approval, mainId)
    };
  }, [activeRunSummary, former, mainId, participantStatusById, participants, placement]);
}
