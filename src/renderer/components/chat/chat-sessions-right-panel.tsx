import { useContext, useMemo, type ComponentProps } from "react";

import type { DockedAccord } from "../../../shared/accordProgress";
import { memberSessionMessages } from "../../../shared/mainSession";
import { sessionsMemberStatus } from "../../../shared/mainSessionView";
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
import { ChatMembersPanel } from "./chat-members-panel";
import { ChatMemberSessionPanel, type ChatMemberSendRequest } from "./chat-member-session-panel";
import { chatRoleLabel } from "./chat-mention-directory";
import type { ChatMessageItem } from "./chat-message-item";
import type { ChatParticipantRosterStatus } from "./chat-roster-status";
import { isChatMessageHiddenInChat } from "./chat-thread-data";
import type { ChatRightPanelState } from "./use-chat-right-panel";
import type { ChatSessionsView } from "./use-chat-sessions-view";

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
}): JSX.Element | null {
  const { rightPanel, sessions, conversation, messageContext } = props;
  const settings = messageContext.settings;
  const accordLines = useContext(AccordLinesContext);
  const panel = rightPanel.panel;
  const memberId = panel?.kind === "member" ? panel.participantId : undefined;
  const participant = memberId ? props.participants.find((candidate) => candidate.id === memberId) : undefined;
  const messages = useMemo(
    () => memberId
      ? memberSessionMessages(conversation.messages, memberId, sessions.index).filter((message) => !isChatMessageHiddenInChat(conversation, message))
      : [],
    [conversation.messages, memberId, sessions.index]
  );
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
        messages={conversation.messages}
        runIdsByParticipantId={props.runIdsByParticipantId}
        roleLabel={(item) => chatRoleLabel(settings.chatRoleConfigs, item)}
        onOpenMember={rightPanel.openMember}
        onStopRuns={props.onStopRuns}
        onClose={rightPanel.close}
      />
    );
  }
  if (!participant) {
    return null;
  }
  return (
    <ChatMemberSessionPanel
      key={participant.id}
      participant={participant}
      mainSessionId={sessions.mainSessionId}
      status={sessionsMemberStatus(props.participantStatusById.get(participant.id), sessions.tasksByMember.get(participant.id)?.item)}
      runIds={props.runIdsByParticipantId.get(participant.id) ?? []}
      messages={messages}
      allMessages={conversation.messages}
      messageProps={(message) => panelMessageProps(messageContext, message)}
      participants={props.participants}
      settings={settings}
      conversationId={conversation.id}
      repoPath={conversation.repoPath}
      draft={rightPanel.memberDrafts[participant.id] ?? ""}
      busy={messageContext.busy}
      hasOlderMessages={props.hasOlderMessages}
      olderMessagesLoading={props.olderMessagesLoading}
      onLoadOlderMessages={props.onLoadOlderMessages}
      onDraftChange={(value) => rightPanel.setMemberDraft(participant.id, value)}
      onSend={props.onSendToMember}
      onStopRuns={props.onStopRuns}
      onBack={rightPanel.openMembers}
      onClose={rightPanel.close}
    />
  );
}
