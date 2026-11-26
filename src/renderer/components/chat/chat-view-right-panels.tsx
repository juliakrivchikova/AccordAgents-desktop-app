import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";

import type { DockedAccord } from "../../../shared/accordProgress";
import type { ChatAppToolApproval, ChatImageInput, ChatSkillMention, Conversation, RepoFileMention } from "../../../shared/types";
import type { ChatMemberSendRequest } from "./chat-member-session-panel";
import { ChatSessionsRightPanel, type ChatPanelMessageContext } from "./chat-sessions-right-panel";
import type { ChatThreadSummary } from "./chat-thread-data";
import { ChatThreadPanel } from "./chat-thread-panel";
import type { ChatRightPanelState } from "./use-chat-right-panel";
import type { ChatSessionsView } from "./use-chat-sessions-view";

type ChatMessage = Conversation["messages"][number];

/**
 * The chat's right panel beside the timeline, with its resizer: a thread in
 * the classic view; the members list, one member's session or an Accord in
 * the sessions view. Artifacts and files share the place (ChatSidePanel).
 */
export function ChatViewRightPanels(props: {
  shown: boolean;
  onStartResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
  context: ChatPanelMessageContext;
  conversation: Conversation;
  thread?: {
    root: ChatMessage;
    summary?: ChatThreadSummary;
    draft: string;
    approvalsByMessageId: ReadonlyMap<string, ChatAppToolApproval[]>;
    onDraftChange: (value: string) => void;
    onSend: (repoFileMentions?: RepoFileMention[], imageAttachments?: ChatImageInput[], skillMentions?: ChatSkillMention[], content?: string) => Promise<boolean>;
    onClose: () => void;
  };
  sessions?: {
    view: ChatSessionsView;
    rightPanel: ChatRightPanelState;
    runIdsByParticipantId: ReadonlyMap<string, readonly string[]>;
    hasOlderMessages: boolean;
    olderMessagesLoading: boolean;
    onLoadOlderMessages: () => void;
    onSendToMember: (request: ChatMemberSendRequest) => Promise<boolean>;
    onStopRuns?: (runIds: readonly string[]) => void;
    latestAccord?: DockedAccord;
    onOpenAccord: (launchId: string) => void;
    accordNeedsAgent?: boolean;
    renderMemberSettings?: (participantId: string) => ReactNode;
    renderMemberChip?: (participantId: string) => ReactNode;
  };
}): JSX.Element {
  const { context, thread, sessions } = props;
  return (
    <>
      {props.shown && <div className="thread-resizer" role="separator" aria-orientation="vertical" onPointerDown={props.onStartResize} />}
      {thread && (
        <ChatThreadPanel
          activityDisclosure={context.activityDisclosure}
          rootMessage={thread.root}
          replies={thread.summary?.replies ?? []}
          replyCount={thread.summary?.countedReplies.length ?? 0}
          participants={context.participants}
          participantStatusById={context.participantStatusById}
          conversationId={props.conversation.id}
          repoPath={props.conversation.repoPath}
          contextUsageByParticipant={context.contextUsageByParticipant}
          sessionsByParticipant={context.sessionsByParticipant}
          settings={context.settings}
          draft={thread.draft}
          busy={context.busy}
          submittingChoiceIds={context.submittingChoiceIds}
          liveProgressById={context.liveProgressById}
          onDraftChange={thread.onDraftChange}
          onSend={thread.onSend}
          onClose={thread.onClose}
          onApproveMentions={context.onApproveMentions}
          onRejectMentions={context.onRejectMentions}
          onRespondToChoice={context.onRespondToChoice}
          onToggleReaction={context.onToggleReaction}
          onDismissTurnFinishedNote={context.onDismissTurnFinishedNote}
          onCompactParticipant={context.onCompactParticipant}
          onStopRun={context.onStopRun}
          continuedMentionRequestIds={context.continuedMentionRequestIds}
          inferredParticipantRequestsByTrigger={context.inferredParticipantRequestsByTrigger}
          approvalsByMessageId={thread.approvalsByMessageId}
          submittingApprovalIds={context.submittingApprovalIds}
          onRespondToAppToolApproval={context.onRespondToAppToolApproval}
        />
      )}
      {sessions && (
        <ChatSessionsRightPanel
          rightPanel={sessions.rightPanel}
          sessions={sessions.view}
          conversation={props.conversation}
          participants={context.participants}
          participantStatusById={context.participantStatusById}
          runIdsByParticipantId={sessions.runIdsByParticipantId}
          messageContext={context}
          hasOlderMessages={sessions.hasOlderMessages}
          olderMessagesLoading={sessions.olderMessagesLoading}
          onLoadOlderMessages={sessions.onLoadOlderMessages}
          onSendToMember={sessions.onSendToMember}
          onStopRuns={sessions.onStopRuns}
          latestAccord={sessions.latestAccord}
          onOpenAccord={sessions.onOpenAccord}
          accordNeedsAgent={sessions.accordNeedsAgent}
          renderMemberSettings={sessions.renderMemberSettings}
          renderMemberChip={sessions.renderMemberChip}
        />
      )}
    </>
  );
}
