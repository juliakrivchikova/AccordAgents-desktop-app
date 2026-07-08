import { ChatConversationView } from "../chat/chat-conversation-view";
import { SlackView } from "../review/review-view";
import { AppLoadingState } from "../loading-states";
import { planDecisionReplies } from "../review/review-conversation-data";
import type { AppState } from "../../app/app-state";
import type { ConversationActions } from "../../app/use-conversation-actions";
import type { ChatActions } from "../../app/use-chat-actions";
import type { ReviewDecisionActions } from "../../app/use-review-decision-actions";
import type { ReviewPlanActions } from "../../app/use-review-plan-actions";
import type { SettingsActions } from "../../app/use-settings-actions";
import type { useAppViewModel } from "../../app/use-app-view-model";

type AppViewModel = ReturnType<typeof useAppViewModel>;

export interface ConversationPanelProps {
  state: AppState;
  view: AppViewModel;
  conversationActions: ConversationActions;
  chatActions: ChatActions;
  reviewDecisionActions: ReviewDecisionActions;
  reviewPlanActions: ReviewPlanActions;
  settingsActions: SettingsActions;
  openingConversationDescription: string;
  accordDisabledReason?: string;
  onOpenAccord: () => void;
}

export function ConversationPanel({
  state,
  view,
  conversationActions,
  chatActions,
  reviewDecisionActions,
  reviewPlanActions,
  settingsActions,
  openingConversationDescription,
  accordDisabledReason,
  onOpenAccord
}: ConversationPanelProps): JSX.Element | null {
  if (!view.hasResultContext) {
    return null;
  }
  return (
    <section className={`conversation-panel ${view.conversationKind === "chat" ? "chat-conversation-panel" : ""}`}>
      {view.isOpeningConversation ? (
        <AppLoadingState title="Loading chat" description={openingConversationDescription} />
      ) : view.conversationKind === "chat" && state.conversation ? (
        <ChatConversationView
          conversation={state.conversation}
          settings={state.settings}
          progress={view.visibleProgressLog}
          isRunning={view.conversationRunning}
          participantStatusById={view.participantStatusById}
          hasOlderMessages={Boolean(state.messagePage?.hasMoreBefore)}
          olderMessagesLoading={state.olderMessagesLoading}
          draft={state.chatMessageDraft}
          onDraftChange={state.setChatMessageDraft}
          onLoadOlderMessages={() => void conversationActions.loadOlderConversationMessages()}
          onLoadMessagePageForMessage={conversationActions.loadConversationMessagePageForMessage}
          messageFocusRequest={state.chatMessageFocusRequest}
          onSend={(repoFileMentions, imageAttachments, skillMentions) => chatActions.sendChatMessage({ repoFileMentions, imageAttachments, skillMentions })}
          accordDisabledReason={accordDisabledReason}
          onOpenAccord={onOpenAccord}
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
          onRespondToAppToolApproval={chatActions.respondToChatAppToolApproval}
          setRepoFileOpenPreference={settingsActions.setRepoFileOpenPreference}
          onCompactParticipant={(participantId) => chatActions.compactChatParticipant(participantId)}
          onStopRun={(runId) => void window.consensus.cancelReview(runId)}
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
