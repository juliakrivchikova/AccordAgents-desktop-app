import { ChatConversationView } from "../chat/chat-conversation-view";
import type { MainSessionActions } from "../chat/chat-view-switch";
import { SlackView } from "../review/review-view";
import { LoadingBar } from "@/components/ui/loading-bar";
import { planDecisionReplies } from "../review/review-conversation-data";
import { markActivityItemRead } from "../../app/activity-item-state";
import type { AppState } from "../../app/app-state";
import type { ConversationActions } from "../../app/use-conversation-actions";
import type { ChatActions } from "../../app/use-chat-actions";
import type { ReviewDecisionActions } from "../../app/use-review-decision-actions";
import type { ReviewPlanActions } from "../../app/use-review-plan-actions";
import type { SettingsActions } from "../../app/use-settings-actions";
import type { useAppViewModel } from "../../app/use-app-view-model";
import type { ArtifactsState } from "../artifacts/use-artifacts";

type AppViewModel = ReturnType<typeof useAppViewModel>;

/** React 18 has no typed `inert`; the attribute is passed through as is. */
const INERT = { inert: "" } as Record<string, string>;

export interface ConversationPanelProps {
  state: AppState;
  view: AppViewModel;
  conversationActions: ConversationActions;
  chatActions: ChatActions;
  reviewDecisionActions: ReviewDecisionActions;
  reviewPlanActions: ReviewPlanActions;
  settingsActions: SettingsActions;
  accordDisabledReason?: string;
  onOpenAccord: () => void;
  /** The sessions view: a member's … actions (its session's header), and
   *  its controls under its composer. */
  renderMemberSettings?: (participantId: string) => React.ReactNode;
  renderMemberChip?: (participantId: string) => React.ReactNode;
  /** The main session's … actions, in the chat title's menu. */
  mainSessionActions?: MainSessionActions;
  topBar?: React.ReactNode;
  artifacts: ArtifactsState;
}

export function ConversationPanel({
  state,
  view,
  conversationActions,
  chatActions,
  reviewDecisionActions,
  reviewPlanActions,
  settingsActions,
  accordDisabledReason,
  onOpenAccord,
  renderMemberSettings,
  renderMemberChip,
  mainSessionActions,
  topBar,
  artifacts
}: ConversationPanelProps): JSX.Element | null {
  if (!view.hasResultContext) {
    return null;
  }
  // Opening another chat keeps the one on screen until the new one is in,
  // with a thin line under its header if that takes a while; no loading card
  // (the User, 2026-11-22). Meanwhile the old chat takes no clicks, keys or
  // focus: nothing done there could land on the chat being opened.
  const leaving = view.isOpeningConversation && Boolean(state.conversation);
  return (
    <section className={`conversation-panel ${view.conversationKind === "chat" ? "chat-conversation-panel" : ""}`}
      {...(leaving ? INERT : {})}>
      {view.isOpeningConversation && (
        <LoadingBar label="Loading chat" className={leaving ? "top-[calc(var(--app-header-height)_-_1px)]" : undefined} delayMs={leaving ? undefined : 0} />
      )}
      {view.isOpeningConversation && !state.conversation ? null : view.conversationKind === "chat" && state.conversation ? (
        <ChatConversationView
          // One view per chat: nothing it holds (a draft image, a scroll
          // position) carries over to the next chat opened.
          key={state.conversation.id}
          conversation={state.conversation}
          topBar={topBar}
          settings={state.settings}
          artifacts={artifacts}
          progress={view.visibleProgressLog}
          isRunning={view.conversationRunning}
          participantStatusById={view.participantStatusById}
          hasOlderMessages={Boolean(state.messagePage?.hasMoreBefore)}
          olderMessagesLoading={state.olderMessagesLoading}
          draft={state.chatMessageDraft}
          composerPicks={{
            skillMentions: state.chatComposerSkillMentions,
            onSkillMentionsChange: state.setChatComposerSkillMentions,
            pluginMentions: state.chatComposerPluginMentions,
            onPluginMentionsChange: state.setChatComposerPluginMentions,
            fileMentions: state.chatComposerFileMentions,
            onFileMentionsChange: state.setChatComposerFileMentions
          }}
          onDraftChange={state.setChatMessageDraft}
          onLoadOlderMessages={() => void conversationActions.loadOlderConversationMessages()}
          onLoadMessagePageForMessage={conversationActions.loadConversationMessagePageForMessage}
          messageFocusRequest={state.chatMessageFocusRequest}
          onSend={(repoFileMentions, imageAttachments, skillMentions, content, targetParticipantIds) =>
            chatActions.sendChatMessage({ content, repoFileMentions, imageAttachments, skillMentions, targetParticipantIds, fromMainComposer: true })}
          onSendToMember={(request) => chatActions.sendChatMessage(request)}
          onChatViewSaved={(saved) => state.setConversation((current) => current?.id === saved.conversationId
            ? { ...current, metadata: { ...current.metadata, chatView: saved.view } }
            : current)}
          onChatViewError={state.setError}
          accordDisabledReason={accordDisabledReason}
          onOpenAccord={onOpenAccord}
          renderMemberSettings={renderMemberSettings}
          renderMemberChip={renderMemberChip}
          mainSessionActions={mainSessionActions}
          onSendThread={(rootMessage, content, repoFileMentions, imageAttachments, skillMentions) => chatActions.sendChatMessage({
            content,
            skillMentions,
            repoFileMentions,
            imageAttachments,
            threadId: rootMessage.metadata?.threadId ?? rootMessage.id,
            parentMessageId: rootMessage.id,
            chatThreadRootId: rootMessage.id
          })}
          onApproveMentions={(sourceMessageId, targetParticipantIds, continueRequester) =>
            void chatActions.respondToChatMentions(sourceMessageId, targetParticipantIds, true, continueRequester)
          }
          onRejectMentions={(sourceMessageId, targetParticipantIds) =>
            void chatActions.respondToChatMentions(sourceMessageId, targetParticipantIds, false)
          }
          onRespondToChoice={(sourceMessageId, choiceId, response) => chatActions.respondToChatChoice(sourceMessageId, choiceId, response)}
          onToggleReaction={(messageId, emoji) => void chatActions.toggleChatReaction(messageId, emoji)}
          onDismissTurnFinishedNote={(messageId) => void chatActions.dismissTurnFinishedNote(messageId)}
          onRespondToAppToolApproval={chatActions.respondToChatAppToolApproval}
          setRepoFileOpenPreference={settingsActions.setRepoFileOpenPreference}
          setRepoFileExternalOpenPreference={settingsActions.setRepoFileExternalOpenPreference}
          onCompactParticipant={(participantId) => chatActions.compactChatParticipant(participantId)}
          onStopRun={(runId) => void window.consensus.cancelReview(runId)}
          onJumpToParticipantLastMessage={conversationActions.jumpToParticipantLastMessage}
          onDismissMessageFocus={() => {
            // Dismissing the highlight by clicking outside it is the acknowledgment
            // gesture in the activity view: mark the selected finished item read.
            // Pending items keep their badge until actually resolved.
            const selected = state.selectedActivityItem;
            if (state.railView === "activity" && selected?.status === "recent" && selected.conversationId === state.conversation?.id) {
              markActivityItemRead(state, selected.id);
            }
          }}
        />
      ) : (
        <SlackView
          conversation={state.conversation}
          progress={view.visibleProgressLog}
          kind={view.conversationKind}
          isRunning={view.conversationRunning}
          hasOlderMessages={Boolean(state.messagePage?.hasMoreBefore)}
          olderMessagesLoading={state.olderMessagesLoading}
          onLoadOlderMessages={() => void conversationActions.loadOlderConversationMessages()}
          selectedThreadId={state.selectedThreadId}
          focusedThreadId={state.focusedThreadId}
          onSelectThread={(id) => {
            state.setSelectedThreadId(id);
            if (!id) state.setFocusedThreadId(undefined);
          }}
          onFocusThread={(id) => {
            state.setSelectedThreadId(id);
            state.setFocusedThreadId(id);
          }}
          onExitFocus={() => state.setFocusedThreadId(undefined)}
          onCloseThread={() => {
            state.setSelectedThreadId(undefined);
            state.setFocusedThreadId(undefined);
          }}
          pendingDecisions={view.pendingDecisions}
          decisionReplies={[...planDecisionReplies(state.conversation), ...Object.values(state.pendingClarifications)]}
          decisionAnswers={view.visibleDecisionAnswers}
          decisionResolutions={view.visibleDecisionResolutions}
          clarificationDrafts={state.clarificationDrafts}
          planItemReviewDrafts={state.planItemReviewDrafts}
          planCorrectionDraft={state.planCorrectionDraft}
          canComposePlan={view.canComposePlan}
          reviewedPlanItemCount={view.reviewedPlanItemCount}
          reviewablePlanItemCount={view.reviewablePlanItems.length}
          canRecoverPlan={view.canRecoverPlan}
          onDecisionAnswer={(decisionId, optionId) => void reviewDecisionActions.selectDecisionAnswer(decisionId, optionId)}
          onResolveDecision={(decisionId) => void reviewDecisionActions.resolveDecisionThread(decisionId)}
          onClarificationDraftChange={(decisionId, value) => state.setClarificationDrafts((current) => ({ ...current, [decisionId]: value }))}
          onAskClarification={(decisionId) => void reviewDecisionActions.askDecisionClarification(decisionId)}
          onPlanItemReviewDraftChange={(findingId, value) => state.setPlanItemReviewDrafts((current) => ({ ...current, [findingId]: value }))}
          onConfirmPlanItem={(findingId) => void reviewDecisionActions.confirmPlanItem(findingId)}
          onCommentPlanItem={(findingId) => void reviewDecisionActions.commentOnPlanItem(findingId)}
          onPlanCorrectionDraftChange={state.setPlanCorrectionDraft}
          onContinue={() => void reviewDecisionActions.continueReview()}
          onComposePlan={() => void reviewPlanActions.composeImplementationPlan()}
          onRetryFinalPlan={() => void reviewPlanActions.retryFinalPlanSynthesis()}
          onRecoverPlan={() => void reviewPlanActions.recoverImplementationPlan()}
          onRevisePlan={() => void reviewPlanActions.reviseImplementationPlan()}
        />
      )}
    </section>
  );
}
