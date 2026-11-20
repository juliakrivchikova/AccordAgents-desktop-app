import { useCallback, useEffect, useMemo, useRef } from "react";

import type { SessionsTaskEntry } from "../../../shared/mainSessionView";
import type { ChatParticipant } from "../../../shared/types";
import type { ChatSessionsLinks, ChatSessionsMemberLink } from "./chat-sessions-links";
import type { ChatSessionsTimelineContext } from "./chat-sessions-timeline-row";
import type { ChatViewHeaderState } from "./chat-view-switch";
import type { ChatRightPanelState } from "./use-chat-right-panel";
import type { ChatSessionsView } from "./use-chat-sessions-view";
import type { ChatViewModeState } from "./use-chat-view-mode";

/** The message a task row or a member's chip opens its session at: the
 *  member's reply to that task, else the task itself. */
export function taskFocusMessageId(entry: Pick<SessionsTaskEntry, "messageId" | "item">): string {
  return entry.item.replyMessageId ?? entry.messageId;
}

/** What the sessions view gives the timeline's rows and the header (the
 *  task rows' context, the view switch, the members button), how a member's
 *  mention in a message reaches its session, and the way a member's message
 *  reached from elsewhere opens its session. */
export function useChatSessionsChrome(input: {
  sessions: ChatSessionsView | undefined;
  viewMode: ChatViewModeState;
  rightPanel: ChatRightPanelState;
  participantsById: ReadonlyMap<string, ChatParticipant>;
  closeArtifacts: () => void;
  /** An Accord is open: the members button says so. */
  accordOpen?: boolean;
}): {
  timeline?: ChatSessionsTimelineContext;
  header: ChatViewHeaderState;
  links?: ChatSessionsLinks;
  openOutsideTimeline?: (messageId: string) => boolean;
  /** The sessions view: an Accord opens in the right panel (again: closes). */
  openAccord?: (launchId: string) => void;
} {
  const { sessions, viewMode, rightPanel } = input;
  const latest = useRef(input);
  latest.current = input;
  const openMember = useCallback((participantId: string, focusMessageId?: string) => {
    latest.current.closeArtifacts();
    latest.current.rightPanel.openMember(participantId, focusMessageId);
  }, []);
  const openTask = useCallback((entry: SessionsTaskEntry) => {
    openMember(entry.item.targetParticipantId, taskFocusMessageId(entry));
  }, [openMember]);
  const openAccord = useCallback((launchId: string) => {
    const { rightPanel: panel, closeArtifacts } = latest.current;
    if (panel.panel?.kind === "accord" && panel.panel.launchId === launchId) {
      panel.close();
      return;
    }
    closeArtifacts();
    panel.openAccord(launchId);
  }, []);
  const isKnownMember = useCallback((participantId: string): boolean =>
    latest.current.participantsById.has(participantId) || latest.current.sessions?.isFormerMember(participantId) === true, []);
  // Search, Activity or a link reaching a member's message: its session opens
  // at that message.
  const openOutsideTimeline = useCallback((messageId: string): boolean => {
    const current = latest.current.sessions;
    const message = current?.messagesById.get(messageId);
    const lane = message ? current?.laneOf(message) : undefined;
    if (lane?.kind !== "member" || !isKnownMember(lane.participantId)) {
      return false;
    }
    openMember(lane.participantId, messageId);
    return true;
  }, [isKnownMember, openMember]);
  const timeline = useMemo<ChatSessionsTimelineContext | undefined>(
    () => (sessions ? { sessions, onOpenMember: openMember, onOpenTask: openTask } : undefined),
    [sessions, openMember, openTask]
  );
  const links = useMemo<ChatSessionsLinks | undefined>(() => {
    if (!sessions) return undefined;
    const byHandle = new Map<string, ChatSessionsMemberLink>();
    const add = (id: string, handle: string, member?: ChatParticipant): void => {
      const task = sessions.tasksByMember.get(id);
      byHandle.set(handle.replace(/^@/, "").toLowerCase(), {
        id,
        title: sessions.memberTitle(id),
        ...(member ? { kind: member.kind, hostLabel: member.hostLabel } : {}),
        ...(task ? { focusMessageId: task.item.replyMessageId ?? task.messageId } : {})
      });
    };
    for (const row of sessions.formerRows) add(row.member.id, row.member.handle);
    for (const member of input.participantsById.values()) {
      if (member.id !== sessions.mainSessionId) add(member.id, member.handle, member);
    }
    return { mainSessionId: sessions.mainSessionId, mainHandle: input.participantsById.get(sessions.mainSessionId)?.handle, byHandle, openMember };
  }, [sessions, input.participantsById, openMember]);
  const kind = rightPanel.panel?.kind;
  const inSessions = Boolean(sessions);
  const shownMemberId = rightPanel.panel?.kind === "member" ? rightPanel.panel.participantId : undefined;
  const memberGone = shownMemberId !== undefined && !input.participantsById.has(shownMemberId) && sessions?.isFormerMember(shownMemberId) !== true;
  // A thread belongs to the classic view, the members to the sessions view;
  // a member's session closes once nothing of the member is left to read.
  useEffect(() => {
    if ((kind && (kind === "thread") === inSessions) || memberGone) {
      rightPanel.close();
    }
  }, [kind, inSessions, memberGone, rightPanel.close]);
  const membersOpen = kind === "members" || kind === "member" || (inSessions && kind === "accord");
  const runningCount = sessions?.runningMemberCount;
  const accordOpen = input.accordOpen === true;
  const header = useMemo<ChatViewHeaderState>(() => ({
    view: viewMode.view,
    canSwitch: viewMode.canSwitch,
    onChangeView: viewMode.setView,
    members: runningCount === undefined ? undefined : {
      runningCount,
      accordOpen,
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
  }), [viewMode.view, viewMode.canSwitch, viewMode.setView, runningCount, accordOpen, membersOpen, rightPanel.close, rightPanel.openMembers]);
  return {
    timeline,
    header,
    links,
    openOutsideTimeline: inSessions ? openOutsideTimeline : undefined,
    openAccord: inSessions ? openAccord : undefined
  };
}
