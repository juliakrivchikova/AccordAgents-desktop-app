import { useCallback, useEffect, useMemo, useRef } from "react";

import type { ActiveChatRunSummary } from "../../../shared/chatActiveRuns";
import { isPendingReply } from "../../../shared/chatActiveRuns";
import {
  buildSessionsViewIndex,
  mainSessionParticipantId,
  membersMainSessionWaitsOn,
  sessionsViewLane,
  type SessionsViewIndex,
  type SessionsViewLane
} from "../../../shared/mainSession";
import {
  isMemberWorking,
  latestTaskByMember,
  openMemberCardMessages,
  sessionsMemberRows,
  type SessionsMemberRow,
  type SessionsMemberTask
} from "../../../shared/mainSessionView";
import type { ChatMessage, ChatParticipant, ChatViewMode, Conversation } from "../../../shared/types";
import type { ChatParticipantRosterStatus } from "./chat-roster-status";
import type { ChatSessionsTimelineContext } from "./chat-sessions-timeline-row";
import type { ChatViewHeaderState } from "./chat-view-switch";
import type { ChatRightPanelState } from "./use-chat-right-panel";
import type { ChatViewModeState } from "./use-chat-view-mode";
import { isChatMessageHiddenInChat } from "./chat-thread-data";

/** Everything the sessions view shows, worked out once per change of the
 *  loaded chat (docs/main-session.md, shared/mainSession.ts). */
export interface ChatSessionsView {
  mainSessionId: string;
  index: SessionsViewIndex;
  /** The main timeline's messages: the User and the main session, its task
   *  requests (drawn as task cards) and members' choice cards still open. */
  mainMessages: ChatMessage[];
  /** Members' messages on the main timeline only for their open card. */
  openCardMessageIds: ReadonlySet<string>;
  messagesById: ReadonlyMap<string, ChatMessage>;
  tasksByMember: ReadonlyMap<string, SessionsMemberTask>;
  memberRows: { current: SessionsMemberRow[]; previous: SessionsMemberRow[] };
  runningMemberCount: number;
  /** "Waiting on N members", while the main session is not answering. */
  waitingOn: ChatParticipant[];
  waitingRunIds: string[];
  laneOf: (message: ChatMessage) => SessionsViewLane;
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

  const placement = useMemo(() => {
    if (!mainId) return undefined;
    const messages = conversation.messages;
    const index = buildSessionsViewIndex(messages, mainId);
    const shown = (message: ChatMessage): boolean => !isChatMessageHiddenInChat(conversation, message);
    const openCards = openMemberCardMessages(messages, index).filter(shown);
    const openCardMessageIds = new Set(openCards.map((message) => message.id));
    const mainMessages = messages.filter((message) =>
      openCardMessageIds.has(message.id) || (sessionsViewLane(message, index).kind === "main" && shown(message)));
    return {
      index,
      mainMessages,
      openCardMessageIds,
      messagesById: new Map(messages.map((message) => [message.id, message])),
      tasksByMember: latestTaskByMember(messages),
      waitingIds: membersMainSessionWaitsOn(messages, index),
      mainStreaming: messages.some((message) => isPendingReply(message) && message.participantId === mainId)
    };
  }, [conversation.messages, mainId]);

  return useMemo(() => {
    if (!mainId || !placement) return undefined;
    const byId = new Map(participants.map((participant) => [participant.id, participant]));
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
      memberRows: sessionsMemberRows(participants, mainId, participantStatusById, placement.tasksByMember),
      runningMemberCount: participants.filter((participant) =>
        participant.id !== mainId && isMemberWorking(participantStatusById.get(participant.id))).length,
      waitingOn,
      waitingRunIds: waitingOn.flatMap((participant) => activeRunSummary.runIdsByParticipantId.get(participant.id) ?? []),
      laneOf: (message: ChatMessage) => sessionsViewLane(message, index)
    };
  }, [activeRunSummary, mainId, participantStatusById, participants, placement]);
}


/** What the sessions view gives the timeline's rows and the header (the
 *  task cards' context, the view switch, the members button), and the way a
 *  member's message reached from elsewhere opens its session. */
export function useChatSessionsChrome(input: {
  sessions: ChatSessionsView | undefined;
  viewMode: ChatViewModeState;
  rightPanel: ChatRightPanelState;
  messages: readonly ChatMessage[];
  participantsById: ReadonlyMap<string, ChatParticipant>;
  closeArtifacts: () => void;
}): {
  timeline?: ChatSessionsTimelineContext;
  header: ChatViewHeaderState;
  openOutsideTimeline?: (messageId: string) => boolean;
} {
  const { sessions, viewMode, rightPanel, messages } = input;
  const latest = useRef(input);
  latest.current = input;
  const openMember = useCallback((participantId: string) => {
    latest.current.closeArtifacts();
    latest.current.rightPanel.openMember(participantId);
  }, []);
  // Search, Activity or a link reaching a member's message: its session opens.
  const openOutsideTimeline = useCallback((messageId: string): boolean => {
    const current = latest.current.sessions;
    const message = current?.messagesById.get(messageId);
    const lane = message ? current?.laneOf(message) : undefined;
    if (lane?.kind !== "member" || !latest.current.participantsById.has(lane.participantId)) {
      return false;
    }
    openMember(lane.participantId);
    return true;
  }, [openMember]);
  const timeline = useMemo<ChatSessionsTimelineContext | undefined>(
    () => (sessions ? { sessions, messages, onOpenMember: openMember } : undefined),
    [sessions, messages, openMember]
  );
  const kind = rightPanel.panel?.kind;
  const inSessions = Boolean(sessions);
  // A thread belongs to the classic view, the members to the sessions view.
  useEffect(() => {
    if (kind && (kind === "thread") === inSessions) {
      rightPanel.close();
    }
  }, [kind, inSessions, rightPanel.close]);
  const membersOpen = kind === "members" || kind === "member";
  const runningCount = sessions?.runningMemberCount;
  const header = useMemo<ChatViewHeaderState>(() => ({
    view: viewMode.view,
    canSwitch: viewMode.canSwitch,
    onChangeView: viewMode.setView,
    members: runningCount === undefined ? undefined : {
      runningCount,
      open: membersOpen,
      onToggle: () => {
        if (membersOpen) {
          rightPanel.close();
          return;
        }
        latest.current.closeArtifacts();
        rightPanel.openMembers();
      }
    }
  }), [viewMode.view, viewMode.canSwitch, viewMode.setView, runningCount, membersOpen, rightPanel.close, rightPanel.openMembers]);
  return { timeline, header, openOutsideTimeline: inSessions ? openOutsideTimeline : undefined };
}
