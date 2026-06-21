import React, { useRef, useState } from "react";
import { MessageSquare, Play, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import type {
  Conversation,
  ConversationKind,
  PlanDecisionReply,
  PlanDecisionRequest,
  ReviewProgress
} from "../../../shared/types";
import { RunStatusLine } from "../conversation/timeline-primitives";
import {
  decisionAnswerForDecision,
  decisionThreadIsReady,
  decisionTypingLabels,
  hasFallbackFinalPlan,
  hasFinalImplementationPlan,
  implementationPlanAnswers,
  isHiddenImplementationPlanInternalMessage,
  liveProgressLabel,
  pendingPlanItemReview,
  planItemReviewForFinding,
  planItemReviews,
  requiredPlanItemReviewFindings,
  timelineFindings,
  visiblePlanDecisionRequests
} from "./review-conversation-data";
import { DecisionThread } from "./review-decision-thread";
import { EmptyState } from "./review-empty-state";
import { PlanCorrectionComposer } from "./review-plan-correction-composer";
import { PointThread } from "./review-point-thread";
import {
  DecisionTimelineMessage,
  PointTimelineMessage,
  TimelineMessage
} from "./review-timeline-messages";
import type { TimelineItem } from "./review-timeline-types";
import { VirtualSlackTimeline } from "./review-virtual-timeline";

export function SlackView(props: {
  conversation?: Conversation;
  progress: ReviewProgress[];
  kind: ConversationKind;
  isRunning: boolean;
  hasOlderMessages: boolean;
  olderMessagesLoading: boolean;
  onLoadOlderMessages: () => void;
  selectedThreadId?: string;
  focusedThreadId?: string;
  onSelectThread: (id: string | undefined) => void;
  onFocusThread: (id: string) => void;
  onExitFocus: () => void;
  onCloseThread: () => void;
  pendingDecisions: PlanDecisionRequest[];
  decisionReplies: PlanDecisionReply[];
  decisionAnswers: Record<string, string>;
  decisionResolutions: Record<string, boolean>;
  clarificationDrafts: Record<string, string>;
  planItemReviewDrafts: Record<string, string>;
  planCorrectionDraft: string;
  canComposePlan: boolean;
  reviewedPlanItemCount: number;
  reviewablePlanItemCount: number;
  canRecoverPlan: boolean;
  onDecisionAnswer: (decisionId: string, optionId: string) => void;
  onResolveDecision: (decisionId: string) => void;
  onClarificationDraftChange: (decisionId: string, value: string) => void;
  onAskClarification: (decisionId: string) => void;
  onPlanItemReviewDraftChange: (findingId: string, value: string) => void;
  onConfirmPlanItem: (findingId: string) => void;
  onCommentPlanItem: (findingId: string) => void;
  onPlanCorrectionDraftChange: (value: string) => void;
  onContinue: () => void;
  onComposePlan: () => void;
  onRetryFinalPlan: () => void;
  onRecoverPlan: () => void;
  onRevisePlan: () => void;
}): JSX.Element {
  const {
    conversation,
    progress,
    kind,
    isRunning,
    hasOlderMessages,
    olderMessagesLoading,
    onLoadOlderMessages,
    selectedThreadId,
    focusedThreadId,
    onSelectThread,
    onFocusThread,
    onExitFocus,
    onCloseThread,
    pendingDecisions,
    decisionReplies,
    decisionAnswers,
    decisionResolutions,
    clarificationDrafts,
    planItemReviewDrafts,
    planCorrectionDraft,
    canComposePlan,
    reviewedPlanItemCount,
    reviewablePlanItemCount,
    canRecoverPlan,
    onDecisionAnswer,
    onResolveDecision,
    onClarificationDraftChange,
    onAskClarification,
    onPlanItemReviewDraftChange,
    onConfirmPlanItem,
    onCommentPlanItem,
    onPlanCorrectionDraftChange,
    onContinue,
    onComposePlan,
    onRetryFinalPlan,
    onRecoverPlan,
    onRevisePlan
  } = props;
  const [threadWidth, setThreadWidth] = useState(460);
  const [isResizingThread, setIsResizingThread] = useState(false);
  const viewRef = useRef<HTMLDivElement>(null);

  if (!conversation) {
    return <EmptyState title="No conversation selected" body="Start a new review or choose a previous conversation." />;
  }

  const showLiveProgress = isRunning && (conversation.metadata.running === true || progress.length > 0);
  const latestLiveProgress = showLiveProgress ? progress[progress.length - 1] : undefined;
  const itemReviews = planItemReviews(conversation);
  const isReviewingPlanItems = pendingPlanItemReview(conversation);
  const reviewablePlanItems = requiredPlanItemReviewFindings(conversation);
  const planActionItemIds = new Set(reviewablePlanItems.map((finding) => finding.id));
  const pendingReviewPlanItemIds = new Set(
    reviewablePlanItems.filter((finding) => !planItemReviewForFinding(finding, itemReviews)).map((finding) => finding.id)
  );
  const visibleFindings = timelineFindings(conversation);
  const visibleDecisions = visiblePlanDecisionRequests(conversation);
  const pendingDecisionIds = new Set(pendingDecisions.map((decision) => decision.id));
  const messageItems: TimelineItem[] = conversation.messages
    .filter((message) => (kind === "implementation-plan" || message.role !== "summary") && !message.progressPhase && !isHiddenImplementationPlanInternalMessage(message, kind))
    .map((message) => ({
      id: message.id,
      type: "message",
      createdAt: message.createdAt,
      message
    }));
  const findingItems: TimelineItem[] = visibleFindings.map((finding) => ({
    id: finding.id,
    type: "finding",
    createdAt: finding.createdAt ?? conversation.updatedAt,
    finding
  }));
  const decisionItems: TimelineItem[] = visibleDecisions.map((decision) => ({
    id: decision.id,
    type: "decision",
    createdAt: decision.createdAt,
    decision
  }));
  const items = [...messageItems, ...decisionItems, ...findingItems].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  const selectedFinding = visibleFindings.find((finding) => finding.id === selectedThreadId);
  const selectedDecision = visibleDecisions.find((decision) => decision.id === selectedThreadId);
  const selectedDecisionIsPending = Boolean(selectedDecision && pendingDecisionIds.has(selectedDecision.id));
  const selectedFindingReview = selectedFinding ? planItemReviewForFinding(selectedFinding, itemReviews) : undefined;
  const selectedFindingIsPlanActionItem = Boolean(selectedFinding && planActionItemIds.has(selectedFinding.id));
  const selectedFindingNeedsReview = Boolean(selectedFinding && pendingReviewPlanItemIds.has(selectedFinding.id));
  const savedDecisionAnswers = implementationPlanAnswers(conversation);
  const selectedDecisionAnswer = selectedDecision ? decisionAnswerForDecision(selectedDecision, savedDecisionAnswers) : undefined;
  const readyDecisionCount = pendingDecisions.filter((decision) =>
    decisionThreadIsReady(decision, decisionAnswers, decisionResolutions, savedDecisionAnswers)
  ).length;
  const hasAnyDecisionInput = readyDecisionCount > 0;
  const pendingPlanReviewCount = Math.max(0, reviewablePlanItemCount - reviewedPlanItemCount);
  const decisionActionTitle =
    readyDecisionCount === 0
      ? "No decisions ready"
      : readyDecisionCount === pendingDecisions.length
        ? "All decisions ready"
        : "Decisions ready";
  const isThreadFocused = Boolean(focusedThreadId && (selectedDecision || selectedFinding));
  const hasThread = Boolean(selectedDecision || selectedFinding);
  const hasFinalPlan = hasFinalImplementationPlan(conversation);
  const canRetryFinalPlan = kind === "implementation-plan" && !isReviewingPlanItems && conversation.findings.some((finding) => finding.status === "Confirmed") && hasFallbackFinalPlan(conversation);
  const showPlanFollowupComposer = kind === "implementation-plan" && !isReviewingPlanItems && pendingDecisions.length === 0;
  const planFollowupDisabled = isRunning || !hasFinalPlan;
  const planFollowupPlaceholder = isRunning
    ? "Wait for the current plan run to finish"
    : hasFinalPlan
      ? "Ask for follow-up changes"
      : canRecoverPlan
        ? "Resume the plan before follow-up changes"
        : "Final plan needed before follow-up changes";

  function startThreadResize(event: React.PointerEvent<HTMLDivElement>): void {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsResizingThread(true);
    const rect = view.getBoundingClientRect();
    const minThread = 320;
    const maxThread = Math.max(minThread, Math.min(820, rect.width - 360));

    const move = (moveEvent: PointerEvent): void => {
      const nextWidth = Math.round(rect.right - moveEvent.clientX);
      setThreadWidth(Math.min(maxThread, Math.max(minThread, nextWidth)));
    };
    const stop = (): void => {
      setIsResizingThread(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  return (
    <div
      className={`slack-view ${hasThread ? "thread-open" : ""} ${isThreadFocused ? "thread-focused" : ""} ${isResizingThread ? "resizing-thread" : ""}`}
      ref={viewRef}
      style={{ "--thread-width": `${threadWidth}px` } as React.CSSProperties}
    >
      {!isThreadFocused && (
        <VirtualSlackTimeline
          header={(
            <div className="view-heading">
            <h2>{kind === "code-review" ? "Review Timeline" : kind === "implementation-plan" ? "Plan Timeline" : "Consensus Timeline"}</h2>
            <div className="view-heading-actions">
              <span>
                {showLiveProgress
                  ? liveProgressLabel(progress)
                  : pendingDecisions.length
                    ? `${pendingDecisions.length} decisions`
                    : isReviewingPlanItems
                      ? pendingPlanReviewCount > 0
                        ? `${pendingPlanReviewCount} action${pendingPlanReviewCount === 1 ? "" : "s"} needed`
                        : "No reviews needed"
                    : kind === "implementation-plan"
                      ? canRecoverPlan
                        ? "Interrupted"
                        : hasFinalPlan
                        ? "Final plan"
                        : "No actions needed"
                      : `${conversation.findings.length} points`}
              </span>
              {canRecoverPlan && (
                <Button size="sm" disabled={isRunning} onClick={onRecoverPlan}>
                  {isRunning ? <RefreshCw size={17} className="spin" /> : <Play size={17} />}
                  {isRunning ? "Resuming..." : "Resume plan"}
                </Button>
              )}
              {canRetryFinalPlan && (
                <Button size="sm" disabled={isRunning} onClick={onRetryFinalPlan}>
                  {isRunning ? <RefreshCw size={17} className="spin" /> : <RefreshCw size={17} />}
                  {isRunning ? "Retrying..." : "Retry final plan"}
                </Button>
              )}
              {pendingDecisions.length === 0 && isReviewingPlanItems && (
                <Button size="sm" disabled={isRunning || !canComposePlan} onClick={onComposePlan}>
                  {isRunning ? <RefreshCw size={17} className="spin" /> : <Play size={17} />}
                  {isRunning ? "Composing..." : "Compose final plan"}
                </Button>
              )}
            </div>
          </div>
          )}
          items={items}
          hasOlderMessages={hasOlderMessages}
          olderMessagesLoading={olderMessagesLoading}
          onLoadOlderMessages={onLoadOlderMessages}
          renderItem={(item) =>
            item.type === "message" ? (
              <TimelineMessage message={item.message} kind={kind} />
            ) : item.type === "finding" ? (
              <PointTimelineMessage
                finding={item.finding}
                kind={kind}
                selected={item.finding.id === selectedThreadId}
                reviewRequired={planActionItemIds.has(item.finding.id)}
                review={planItemReviewForFinding(item.finding, itemReviews)}
                onSelect={() => onSelectThread(item.finding.id)}
              />
            ) : (
              <DecisionTimelineMessage
                decision={item.decision}
                selected={item.decision.id === selectedThreadId}
                pending={pendingDecisionIds.has(item.decision.id)}
                ready={decisionThreadIsReady(item.decision, decisionAnswers, decisionResolutions, savedDecisionAnswers)}
                replyCount={decisionReplies.filter((reply) => reply.decisionId === item.decision.id).length}
                onSelect={() => onSelectThread(item.decision.id)}
              />
            )
          }
        />
      )}
      {hasThread && !isThreadFocused && <div className="thread-resizer" role="separator" aria-orientation="vertical" onPointerDown={startThreadResize} />}
      {hasThread && (
        <section className="slack-thread-panel" aria-label="Point thread">
          {selectedDecision ? (
            <DecisionThread
              decision={selectedDecision}
              replies={decisionReplies.filter((reply) => reply.decisionId === selectedDecision.id)}
              selectedOptionId={decisionAnswers[selectedDecision.id] ?? selectedDecisionAnswer?.selectedOptionId}
              resolved={Boolean(decisionResolutions[selectedDecision.id])}
              readOnly={!selectedDecisionIsPending}
              savedAnswer={selectedDecisionAnswer}
              clarificationDraft={clarificationDrafts[selectedDecision.id] ?? ""}
              typingLabels={decisionTypingLabels(selectedDecision, progress, isRunning)}
              busy={isRunning}
              focused={isThreadFocused}
              onFocus={() => onFocusThread(selectedDecision.id)}
              onExitFocus={onExitFocus}
              onClose={onCloseThread}
              onSelectOption={(optionId) => onDecisionAnswer(selectedDecision.id, optionId)}
              onResolve={() => onResolveDecision(selectedDecision.id)}
              onDraftChange={(value) => onClarificationDraftChange(selectedDecision.id, value)}
              onAskClarification={() => onAskClarification(selectedDecision.id)}
            />
          ) : selectedFinding ? (
            <PointThread
              finding={selectedFinding}
              kind={kind}
              focused={isThreadFocused}
              reviewRequired={selectedFindingIsPlanActionItem}
              reviewReadOnly={!selectedFindingNeedsReview}
              review={selectedFindingReview}
              reviewDraft={planItemReviewDrafts[selectedFinding.id] ?? ""}
              busy={isRunning}
              onFocus={() => onFocusThread(selectedFinding.id)}
              onExitFocus={onExitFocus}
              onClose={onCloseThread}
              onConfirmReview={() => onConfirmPlanItem(selectedFinding.id)}
              onReviewDraftChange={(value) => onPlanItemReviewDraftChange(selectedFinding.id, value)}
              onSubmitReviewComment={() => onCommentPlanItem(selectedFinding.id)}
            />
          ) : (
            <div className="thread-empty-state">
              <MessageSquare size={24} />
              <h2>
                {pendingDecisions.length
                  ? "Decision thread"
                  : kind === "code-review"
                    ? "Finding thread"
                    : kind === "implementation-plan"
                      ? "Plan item thread"
                      : "Point thread"}
              </h2>
              <p>No point selected.</p>
            </div>
          )}
        </section>
      )}
      {(showLiveProgress || pendingDecisions.length > 0 || showPlanFollowupComposer) && (
        <div className={`slack-action-bar ${showPlanFollowupComposer ? "with-composer" : ""}`} role="region" aria-label="Run status and actions">
          {showLiveProgress && !showPlanFollowupComposer ? <RunStatusLine progress={latestLiveProgress} /> : pendingDecisions.length > 0 ? <span className="slack-action-spacer" /> : null}
          {pendingDecisions.length > 0 && (
            <div className="decision-action-bar" aria-label="Decision actions">
              <div className="decision-action-status" aria-live="polite">
                <span>
                  {readyDecisionCount}/{pendingDecisions.length} ready
                </span>
                <strong>{decisionActionTitle}</strong>
              </div>
              <Button size="sm" disabled={isRunning || !hasAnyDecisionInput} onClick={onContinue}>
                {isRunning ? <RefreshCw size={17} className="spin" /> : <Play size={17} />}
                {isRunning ? "Continuing..." : "Continue plan"}
              </Button>
            </div>
          )}
          {showPlanFollowupComposer && (
            <PlanCorrectionComposer
              draft={planCorrectionDraft}
              busy={isRunning}
              disabled={planFollowupDisabled}
              placeholder={planFollowupPlaceholder}
              status={showLiveProgress ? <RunStatusLine progress={latestLiveProgress} /> : undefined}
              onDraftChange={onPlanCorrectionDraftChange}
              onSubmit={onRevisePlan}
            />
          )}
        </div>
      )}
    </div>
  );
}
