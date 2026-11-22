import { useCallback, useContext, useEffect, useMemo, useRef, type ComponentProps, type ReactNode } from "react";

import type { DockedAccord } from "../../../shared/accordProgress";
import { memberSessionMessages } from "../../../shared/mainSession";
import { SESSIONS_REMOVED_MEMBER_DETAIL, sessionsMemberDetail, sessionsMemberStatus, sessionsTaskDurationMs, type SessionsMemberRow } from "../../../shared/mainSessionView";
import { sessionsActivityRow } from "../../../shared/sessionsActivity";
import type {
  AgentContextUsage,
  AgentRunProgress,
  AppSettings,
  ChatMessage,
  ChatParticipant,
  ChatParticipantRequestBatch,
  ChatParticipantSession,
  Conversation
} from "../../../shared/types";
import { AccordLinesContext } from "./chat-accord-closed-line";
import { ChatAccordPanel } from "./chat-accord-panel";
import { contextUsageForMessage, sessionIdForMessage } from "./chat-message-metadata";
import type { ChatAgentDetail } from "./chat-agent-row";
import { ChatMembersPanel } from "./chat-members-panel";
import { ChatMemberSessionPanel, type ChatMemberSendRequest } from "./chat-member-session-panel";
import { chatRoleLabel, participantProviderLabel } from "./chat-mention-directory";
import type { ChatMessageItem } from "./chat-message-item";
import type { ChatParticipantRosterStatus } from "./chat-roster-status";
import { isChatMessageHiddenInChat } from "./chat-thread-data";
import type { ChatRightPanelState } from "./use-chat-right-panel";
import type { ChatSessionsView } from "./use-chat-sessions-view";
import { useMachineList } from "./use-cli-start-defaults";
import { useMemberModelSummary, type MemberModelSummary } from "./use-member-model-summary";

type ChatMessageItemProps = ComponentProps<typeof ChatMessageItem>;

/** What every message of a member's session is drawn with: the handlers and
 *  submission state the timeline uses, and the maps its per-message details
 *  come from. */
export type ChatPanelMessageContext = Pick<ChatMessageItemProps,
  | "activityDisclosure" | "conversationId" | "participantStatusById" | "busy" | "onApproveMentions"
  | "onRejectMentions" | "onRespondToChoice" | "onToggleReaction" | "onDismissTurnFinishedNote" | "onStopRun">
  & Required<Pick<ChatMessageItemProps,
    "participants" | "submittingChoiceIds" | "submittingApprovalIds" | "onCompactParticipant" | "onRespondToAppToolApproval">> & {
  settings: AppSettings;
  contextUsageByParticipant: Map<string, AgentContextUsage>;
  sessionsByParticipant: Map<string, ChatParticipantSession>;
  continuedMentionRequestIds: Set<string>;
  inferredParticipantRequestsByTrigger: Map<string, ChatParticipantRequestBatch[]>;
  liveProgressById: Map<string, AgentRunProgress>;
};

export function panelMessageProps(context: ChatPanelMessageContext, message: ChatMessage): ChatMessageItemProps {
  const { settings, contextUsageByParticipant, sessionsByParticipant, continuedMentionRequestIds, inferredParticipantRequestsByTrigger, liveProgressById, ...common } = context;
  return {
    ...common,
    message,
    contextUsage: contextUsageForMessage(message, contextUsageByParticipant),
    sessionId: sessionIdForMessage(message, sessionsByParticipant),
    hasContinuationReply: continuedMentionRequestIds.has(message.id),
    inferredParticipantRequests: inferredParticipantRequestsByTrigger.get(message.id),
    liveProgress: liveProgressById.get(message.id),
    savedParticipants: settings.chatParticipantConfigs,
    cliProviderHosts: settings.cliProviderHosts,
    roles: settings.chatRoleConfigs
  };
}

/** "Load older" in a member's session: a page of the chat may hold nothing
 *  of this member, so pages are loaded until one adds a message of it or the
 *  chat's start is reached, a few at most. */
const MEMBER_OLDER_PAGES_MAX = 6;

export function useLoadOlderUntilMember(count: number, hasOlder: boolean, loading: boolean, load: () => void): () => void {
  const run = useRef<{ from: number; pages: number } | undefined>();
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const current = run.current;
    if (!current || loading) return;
    if (count > current.from || !hasOlder || current.pages >= MEMBER_OLDER_PAGES_MAX) {
      run.current = undefined;
      return;
    }
    current.pages += 1;
    loadRef.current();
  }, [count, hasOlder, loading]);
  return useCallback(() => {
    run.current = { from: count, pages: 1 };
    loadRef.current();
  }, [count]);
}

/** The sessions view's right panel: the members list, one member's session,
 *  or an Accord. */
export function ChatSessionsRightPanel(props: {
  rightPanel: ChatRightPanelState;
  sessions: ChatSessionsView;
  /** The chat's latest Accord (open, else the newest closed one). */
  latestAccord?: DockedAccord;
  onOpenAccord: (launchId: string) => void;
  conversation: Conversation;
  participants: ChatParticipant[];
  participantStatusById: ReadonlyMap<string, ChatParticipantRosterStatus>;
  runIdsByParticipantId: ReadonlyMap<string, readonly string[]>;
  messageContext: ChatPanelMessageContext;
  hasOlderMessages: boolean;
  olderMessagesLoading: boolean;
  onLoadOlderMessages: () => void;
  onSendToMember: (request: ChatMemberSendRequest) => Promise<boolean>;
  onStopRuns?: (runIds: readonly string[]) => void;
  /** A member's … actions (Restart, Fork to new chat, Remove from chat) in
   *  its session's header. */
  renderMemberSettings?: (participantId: string) => ReactNode;
  /** Its controls under its session's composer. */
  renderMemberChip?: (participantId: string) => ReactNode;
}): JSX.Element | null {
  const { rightPanel, sessions, conversation, messageContext } = props;
  const settings = messageContext.settings;
  const accordLines = useContext(AccordLinesContext);
  const panel = rightPanel.panel;
  const memberId = panel?.kind === "member" ? panel.participantId : undefined;
  const participant = memberId ? props.participants.find((candidate) => candidate.id === memberId) : undefined;
  const former = memberId && !participant ? sessions.formerRows.find((row) => row.member.id === memberId) : undefined;
  const messages = useMemo(
    () => memberId
      ? memberSessionMessages(conversation.messages, memberId, sessions.index).filter((message) => !isChatMessageHiddenInChat(conversation, message))
      : [],
    [conversation.messages, memberId, sessions.index]
  );
  const ownCount = useMemo(() => messages.filter((message) => message.participantId === memberId).length, [messages, memberId]);
  const loadOlder = useLoadOlderUntilMember(ownCount, props.hasOlderMessages, props.olderMessagesLoading, props.onLoadOlderMessages);
  const memberDetail = (member: ChatParticipant): ChatAgentDetail => (model: MemberModelSummary): string => sessionsMemberDetail({
    provider: participantProviderLabel(member.kind, member.hostLabel),
    model: model.effort ? `${model.model} · ${model.effort}` : model.model,
    roleLabel: chatRoleLabel(settings.chatRoleConfigs, member),
    roleConfigId: member.roleConfigId
  });
  // What a running member does now: the newest step of the reply it works
  // on (the first started, never one queued behind it).
  const currentStep = (participantId: string): string | undefined => {
    const message = sessions.activity.runningReply.get(participantId);
    if (!message) return undefined;
    const live = messageContext.liveProgressById.get(message.id);
    const events = live?.activityEvents?.length ? live.activityEvents : message.metadata?.activityEvents;
    const newest = events?.[events.length - 1];
    return (newest ? sessionsActivityRow(newest).text : live?.activity)?.trim() || undefined;
  };
  const taskResult = (participantId: string): string | undefined => {
    const task = sessions.tasksByMember.get(participantId);
    return task ? sessions.taskEntriesByMessageId.get(task.messageId)?.find((entry) => entry.item.targetParticipantId === participantId)?.line : undefined;
  };
  const taskDurationMs = (row: { task?: SessionsMemberRow["task"] }): number | undefined =>
    row.task ? sessionsTaskDurationMs(row.task.item, sessions.messagesById) : undefined;
  if (panel?.kind === "accord") {
    const latest = props.latestAccord;
    return (
      <ChatAccordPanel
        launchId={panel.launchId}
        accord={latest?.launchId === panel.launchId ? latest : accordLines?.accordOf(panel.launchId)}
        participants={props.participants}
        onBack={rightPanel.openMembers}
        onClose={rightPanel.close}
      />
    );
  }
  if (panel?.kind === "members") {
    return (
      <ChatMembersPanel
        accord={props.latestAccord}
        onOpenAccord={props.onOpenAccord}
        rows={sessions.memberRows}
        formerRows={sessions.formerRows}
        activity={sessions.activity}
        runIdsByParticipantId={props.runIdsByParticipantId}
        memberTitle={sessions.memberTitle}
        memberDetail={memberDetail}
        taskDurationMs={taskDurationMs}
        waitingSince={sessions.waitingSince}
        currentStep={currentStep}
        taskResult={taskResult}
        onOpenMember={rightPanel.openMember}
        onStopRuns={props.onStopRuns}
        onClose={rightPanel.close}
      />
    );
  }
  if (!memberId || (!participant && !former)) {
    return null;
  }
  const task = sessions.tasksByMember.get(memberId)?.item;
  const status = former
    ? former.status
    : sessionsMemberStatus(props.participantStatusById.get(memberId), task, sessions.activity.finishedAt.get(memberId), sessions.waitingForUser.has(memberId));
  return (
    <ChatMemberSessionPanel
      key={memberId}
      member={participant
        ? { id: participant.id, kind: participant.kind, hostLabel: participant.hostLabel }
        : { id: memberId, ...(former?.member.kind ? { kind: former.member.kind } : {}) }}
      title={sessions.memberTitle(memberId)}
      detail={participant ? <MemberSessionDetail member={participant} detail={memberDetail(participant)} /> : SESSIONS_REMOVED_MEMBER_DETAIL}
      readOnly={!participant}
      settings={participant ? props.renderMemberSettings?.(participant.id) : undefined}
      chip={participant ? props.renderMemberChip?.(participant.id) : undefined}
      focus={panel?.kind === "member" ? panel.focus : undefined}
      mainSessionId={sessions.mainSessionId}
      status={status}
      runningSince={sessions.activity.runningSince.get(memberId) ?? task?.createdAt}
      runIds={props.runIdsByParticipantId.get(memberId) ?? []}
      messages={messages}
      messageProps={(message) => panelMessageProps(messageContext, message)}
      appSettings={settings}
      conversationId={conversation.id}
      repoPath={conversation.repoPath}
      draft={rightPanel.memberDrafts[memberId] ?? ""}
      busy={messageContext.busy}
      hasOlderMessages={props.hasOlderMessages}
      olderMessagesLoading={props.olderMessagesLoading}
      onLoadOlderMessages={loadOlder}
      onDraftChange={(value) => rightPanel.setMemberDraft(memberId, value)}
      onSend={props.onSendToMember}
      onStopRuns={props.onStopRuns}
      onBack={rightPanel.openMembers}
      onClose={rightPanel.close}
    />
  );
}

/** The line under a member's title in its session's header: its CLI, the
 *  model by its name in the CLI's list and its effort, as its row's card. */
function MemberSessionDetail(props: { member: ChatParticipant; detail: ChatAgentDetail }): JSX.Element {
  const machines = useMachineList();
  const model = useMemberModelSummary(props.member, machines);
  return <>{props.detail(model)}</>;
}
