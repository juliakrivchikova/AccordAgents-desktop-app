import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  CheckCircle2,
  Circle,
  Columns2,
  Copy,
  HelpCircle,
  Maximize2,
  MessageSquare,
  Play,
  RefreshCw,
  SendHorizontal,
  X,
  XCircle
} from "lucide-react";

import { Button } from "@/components/ui/button";
import type {
  Conversation,
  ConversationKind,
  Finding,
  PlanDecisionAnswer,
  PlanDecisionReply,
  PlanDecisionRequest,
  PlanItemReview,
  ReviewProgress
} from "../../../shared/types";
import type { AvatarSpec } from "../chat/chat-avatars";
import {
  IconButton,
  LoadingDot,
  ResizableTextarea,
  SeverityBadge,
  StatusBadge,
  type StatusBadgeTone
} from "../primitives";
import { MarkdownText } from "../content/markdown-text";
import {
  ARBITER_AVATAR,
  Avatar,
  USER_AVATAR,
  avatarForMessage,
  avatarForParticipant
} from "../avatar/avatar";
import { authorForMessage } from "../conversation/conversation-display";
import { RunStatusLine, TimelineLoadMoreRow } from "../conversation/timeline-primitives";
import {
  canonicalPlanItemContent,
  decisionAnswerForDecision,
  decisionThreadHasUserReply,
  decisionThreadIsReady,
  decisionTypingLabels,
  displayMessageContent,
  hasFallbackFinalPlan,
  hasFinalImplementationPlan,
  implementationPlanAnswers,
  isHiddenImplementationPlanInternalMessage,
  liveProgressLabel,
  pendingPlanItemReview,
  planItemReviewForFinding,
  planItemReviews,
  pointSourceContent,
  pointStatus,
  pointThreadReplies,
  requiredPlanItemReviewFindings,
  sourceItemContent,
  sourceLabelForDecision,
  timelineFindings,
  typingText,
  visiblePlanDecisionRequests
} from "./review-conversation-data";

function EmptyState({ title, body }: { title: string; body: string }): JSX.Element {
  return (
    <div className="empty-state">
      <HelpCircle size={26} />
      <h2>{title}</h2>
      <p>{body}</p>
    </div>
  );
}

type TimelineItem =
  | { id: string; type: "message"; createdAt: string; message: Conversation["messages"][number] }
  | { id: string; type: "finding"; createdAt: string; finding: Finding }
  | { id: string; type: "decision"; createdAt: string; decision: PlanDecisionRequest };

type SlackTimelineRow = { id: string; type: "load-older" } | TimelineItem;

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

function VirtualSlackTimeline(props: {
  header: React.ReactNode;
  items: TimelineItem[];
  hasOlderMessages: boolean;
  olderMessagesLoading: boolean;
  onLoadOlderMessages: () => void;
  renderItem: (item: TimelineItem) => React.ReactNode;
}): JSX.Element {
  const timelineRef = useRef<HTMLElement>(null);
  const stickToBottomRef = useRef(true);
  const previousLastRowIdRef = useRef<string | undefined>();
  const rows = useMemo<SlackTimelineRow[]>(() => {
    return props.hasOlderMessages || props.olderMessagesLoading
      ? [{ id: "load-older", type: "load-older" }, ...props.items]
      : props.items;
  }, [props.hasOlderMessages, props.items, props.olderMessagesLoading]);
  const lastRowId = rows[rows.length - 1]?.id;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => timelineRef.current,
    estimateSize: (index) => {
      const row = rows[index];
      return row?.type === "message" ? 190 : row?.type === "load-older" ? 56 : 150;
    },
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan: 8,
    useFlushSync: false
  });
  const virtualItems = virtualizer.getVirtualItems();

  function scrollToBottom(): void {
    if (rows.length === 0) {
      return;
    }
    virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
    const timeline = timelineRef.current;
    if (timeline) {
      timeline.scrollTop = timeline.scrollHeight;
    }
  }

  function scheduleScrollToBottom(): void {
    scrollToBottom();
    window.requestAnimationFrame(() => {
      scrollToBottom();
      window.requestAnimationFrame(scrollToBottom);
    });
    window.setTimeout(scrollToBottom, 80);
    window.setTimeout(scrollToBottom, 180);
  }

  function handleScroll(): void {
    const timeline = timelineRef.current;
    if (!timeline) {
      return;
    }
    stickToBottomRef.current = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 96;
    if (timeline.scrollTop < 96 && props.hasOlderMessages && !props.olderMessagesLoading) {
      props.onLoadOlderMessages();
    }
  }

  useLayoutEffect(() => {
    const previousLastRowId = previousLastRowIdRef.current;
    previousLastRowIdRef.current = lastRowId;
    const lastRowChanged = previousLastRowId !== lastRowId;
    if (stickToBottomRef.current || lastRowChanged) {
      scheduleScrollToBottom();
      stickToBottomRef.current = true;
    }
  }, [lastRowId, rows.length, virtualizer]);

  return (
    <section className="slack-timeline virtual-timeline" aria-label="Consensus timeline" ref={timelineRef} onScroll={handleScroll}>
      {props.header}
      <div className="virtual-timeline-inner" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualItems.map((virtualItem) => {
          const row = rows[virtualItem.index];
          if (!row) {
            return null;
          }
          return (
            <div
              className="virtual-timeline-item"
              data-index={virtualItem.index}
              key={virtualItem.key}
              ref={virtualizer.measureElement}
              style={{ transform: `translateY(${virtualItem.start}px)` }}
            >
              {row.type === "load-older" ? (
                <TimelineLoadMoreRow
                  loading={props.olderMessagesLoading}
                  disabled={!props.hasOlderMessages || props.olderMessagesLoading}
                  onClick={props.onLoadOlderMessages}
                />
              ) : (
                props.renderItem(row)
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TimelineMessage({ message, kind }: { message: Conversation["messages"][number]; kind: ConversationKind }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const author = authorForMessage(message, kind);
  const isLiveProgress = Boolean(message.progressPhase && message.status === "pending");
  const isFinalPlan = kind === "implementation-plan" && message.role === "summary";
  const display = displayMessageContent(message, kind);
  const canCopy = Boolean(display.content.trim());

  async function copyMessage(): Promise<void> {
    if (!canCopy) {
      return;
    }
    await navigator.clipboard.writeText(display.content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  return (
    <article
      className={`message ${message.role} ${isLiveProgress ? "progress-active" : ""} ${isFinalPlan ? "final-plan-message" : ""}`}
      data-final-plan={isFinalPlan ? "true" : undefined}
    >
      <Avatar className="message-avatar" spec={avatarForMessage(message, author)} />
      <div className="message-body">
        <IconButton
          className="message-copy-button"
          size="xs"
          icon={copied ? CheckCircle2 : Copy}
          label={copied ? "Copied" : "Copy markdown"}
          tooltip={copied ? "Copied" : "Copy markdown"}
          disabled={!canCopy}
          data-testid={isFinalPlan ? "final-plan-copy-button" : undefined}
          onClick={() => void copyMessage()}
        />
        <div className="message-meta">
          <strong>{author}</strong>
          {isFinalPlan && (
            <StatusBadge tone="success" icon={CheckCircle2} uppercase>
              Final plan
            </StatusBadge>
          )}
          <span>{new Date(message.createdAt).toLocaleString()}</span>
          {message.progressPhase && (
            <StatusBadge tone="neutral">{message.progressPhase}</StatusBadge>
          )}
          {isLiveProgress && <LoadingDot label="In progress" />}
          {message.status === "error" && <StatusBadge tone="danger">error</StatusBadge>}
        </div>
        <div className="message-content">{display.markdown ? <MarkdownText content={display.content} /> : <pre>{display.content}</pre>}</div>
      </div>
    </article>
  );
}

function PointTimelineMessage(props: { finding: Finding; kind: ConversationKind; selected: boolean; reviewRequired?: boolean; review?: PlanItemReview; onSelect: () => void }): JSX.Element {
  const { finding, kind, selected, reviewRequired, review, onSelect } = props;
  const ownerLabel = kind === "implementation-plan" ? "Planner" : "Arbiter";
  const metaLabel = kind === "implementation-plan" ? "Plan item extracted" : "Point extracted";
  return (
    <article
      className={`message system point-message ${selected ? "selected" : ""}`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <Avatar className="message-avatar" spec={ARBITER_AVATAR} />
      <div className="message-body">
        <div className="message-meta">
          <strong>{ownerLabel}</strong>
          <span>{metaLabel}</span>
          <PointStatusBadge finding={finding} />
          {reviewRequired && <PlanItemReviewBadge review={review} />}
          <SeverityBadge severity={finding.severity} />
        </div>
        <h3>{finding.title}</h3>
        <p>{finding.claim || finding.description}</p>
        <small>{finding.rounds.length} thread {finding.rounds.length === 1 ? "reply" : "replies"}</small>
      </div>
    </article>
  );
}

function DecisionTimelineMessage(props: {
  decision: PlanDecisionRequest;
  selected: boolean;
  pending: boolean;
  ready: boolean;
  replyCount: number;
  onSelect: () => void;
}): JSX.Element {
  const { decision, selected, pending, ready, replyCount, onSelect } = props;
  const author = sourceLabelForDecision(decision);
  const statusLabel = pending ? (ready ? "ready" : "pending") : "answered";
  return (
    <article
      className={`message system point-message decision-message ${selected ? "selected" : ""}`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <Avatar className="message-avatar" spec={avatarForParticipant(author, decision.sourceParticipantIds?.[0])} />
      <div className="message-body">
        <div className="message-meta">
          <strong>{author}</strong>
          <span>{pending ? "Decision needed" : "Decision answered"}</span>
          <StatusBadge tone={ready || !pending ? "success" : "neutral"}>{statusLabel}</StatusBadge>
        </div>
        <h3>{decision.title}</h3>
        <p>{decision.question}</p>
        <small>{replyCount} thread {replyCount === 1 ? "reply" : "replies"}</small>
      </div>
    </article>
  );
}

function PointThread(props: {
  finding: Finding;
  kind: ConversationKind;
  focused: boolean;
  reviewRequired?: boolean;
  reviewReadOnly?: boolean;
  review?: PlanItemReview;
  reviewDraft?: string;
  busy?: boolean;
  onFocus: () => void;
  onExitFocus: () => void;
  onClose: () => void;
  onConfirmReview?: () => void;
  onReviewDraftChange?: (value: string) => void;
  onSubmitReviewComment?: () => void;
}): JSX.Element {
  const {
    finding,
    kind,
    focused,
    reviewRequired,
    reviewReadOnly = false,
    review,
    reviewDraft = "",
    busy = false,
    onFocus,
    onExitFocus,
    onClose,
    onConfirmReview,
    onReviewDraftChange,
    onSubmitReviewComment
  } = props;
  const replies = pointThreadReplies(finding);
  const hasPlanSources = Boolean(finding.sourceItems?.length);
  const ownerLabel = kind === "implementation-plan" ? "Planner" : "Arbiter";

  return (
    <div className="point-thread">
      <div className="thread-panel-head">
        <div>
          <span>Thread</span>
          <h2>{finding.title}</h2>
        </div>
        <div className="thread-panel-actions">
          <PointStatusBadge finding={finding} />
          {reviewRequired && <PlanItemReviewBadge review={review} />}
          <IconButton
            size="sm"
            icon={focused ? Columns2 : Maximize2}
            label={focused ? "Show timeline" : "Expand thread"}
            tooltip={focused ? "Show timeline" : "Expand thread"}
            onClick={focused ? onExitFocus : onFocus}
          />
          <IconButton size="sm" icon={X} label="Close thread" tooltip="Close thread" onClick={onClose} />
        </div>
      </div>

      <ThreadMessage
        avatar={ARBITER_AVATAR}
        author={ownerLabel}
        meta={hasPlanSources ? "Canonical plan item" : "Parent point"}
        createdAt={finding.createdAt}
        content={hasPlanSources ? canonicalPlanItemContent(finding) : pointSourceContent(finding)}
        title={finding.title}
        badges={
          <>
            <PointStatusBadge finding={finding} />
            {reviewRequired && <PlanItemReviewBadge review={review} />}
            <SeverityBadge severity={finding.severity} />
          </>
        }
      />

      {hasPlanSources && <PlanSourceSupport finding={finding} />}

      {replies.length > 0 && (
        <div className="thread-replies">
          {replies.map((reply) => (
            <ThreadMessage
              avatar={avatarForParticipant(reply.author)}
              author={reply.author}
              meta={reply.meta}
              createdAt={reply.createdAt}
              content={reply.content}
              key={reply.id}
            />
          ))}
        </div>
      )}

      {reviewRequired && (
        <PlanItemReviewComposer
          review={review}
          readOnly={reviewReadOnly}
          draft={reviewDraft}
          busy={busy}
          onConfirm={onConfirmReview}
          onDraftChange={onReviewDraftChange}
          onSubmitComment={onSubmitReviewComment}
        />
      )}
    </div>
  );
}

function PlanSourceSupport({ finding }: { finding: Finding }): JSX.Element | null {
  const sourceItems = finding.sourceItems ?? [];
  if (sourceItems.length === 0) {
    return null;
  }
  const hasRawPlans = sourceItems.some((item) => Boolean(item.rawContent?.trim()));

  return (
    <section className="plan-source-support">
      <div className="plan-source-support-head">
        <span>Agent support</span>
        <strong>{sourceItems.length} source{sourceItems.length === 1 ? "" : "s"}</strong>
      </div>
      <div className="plan-source-support-list">
        {sourceItems.map((item, index) => (
          <div className="plan-source-support-row" key={`${item.participantId}-${index}`}>
            <Avatar className="thread-avatar support-avatar" spec={avatarForParticipant(item.participantLabel, item.participantId)} />
            <div>
              <strong>{item.participantLabel}</strong>
              <span>Supported this canonical item</span>
            </div>
          </div>
        ))}
      </div>
      <details className="plan-source-details">
        <summary>{hasRawPlans ? "Original participant plans" : "Original participant plan items"}</summary>
        <div className="plan-source-detail-list">
          {sourceItems.map((item, index) => (
            <article className="plan-source-detail-card" key={`${item.participantId}-detail-${index}`}>
              <div className="message-meta">
                <strong>{item.participantLabel}</strong>
                <span>{item.rawContent?.trim() ? "Initial plan" : "Initial plan item"}</span>
              </div>
              <MarkdownText content={sourceItemContent(item)} />
            </article>
          ))}
        </div>
      </details>
    </section>
  );
}

function PlanItemReviewComposer(props: {
  review?: PlanItemReview;
  readOnly?: boolean;
  draft: string;
  busy: boolean;
  onConfirm?: () => void;
  onDraftChange?: (value: string) => void;
  onSubmitComment?: () => void;
}): JSX.Element {
  const { review, readOnly = false, draft, busy, onConfirm, onDraftChange, onSubmitComment } = props;
  if (readOnly) {
    return review ? (
      <div className="plan-item-review-box">
        <ThreadMessage
          avatar={USER_AVATAR}
          author="You"
          meta={review.status === "commented" ? "Item comment" : "Item confirmation"}
          createdAt={review.updatedAt}
          content={review.status === "commented" ? review.comment ?? "" : "Confirmed as-is."}
        />
      </div>
    ) : <div className="plan-item-review-box" />;
  }
  return (
    <div className="plan-item-review-box">
      {review && (
        <ThreadMessage
          avatar={USER_AVATAR}
          author="You"
          meta={review.status === "commented" ? "Item comment" : "Item confirmation"}
          createdAt={review.updatedAt}
          content={review.status === "commented" ? review.comment ?? "" : "Confirmed as-is."}
        />
      )}
      <div className="decision-compose plan-item-review-compose">
        <ResizableTextarea
          value={draft}
          onChange={(event) => onDraftChange?.(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (!busy && draft.trim()) {
                onSubmitComment?.();
              }
            }
          }}
          rows={3}
          maxHeight={220}
          placeholder="Comment before final plan synthesis"
          disabled={busy}
        />
        <div className="plan-item-review-actions">
          <Button variant="outline" size="sm" disabled={busy || !draft.trim()} onClick={onSubmitComment}>
            <MessageSquare size={16} />
            Comment
          </Button>
          <Button variant="outline" size="sm" disabled={busy || review?.status === "confirmed"} onClick={onConfirm}>
            <CheckCircle2 size={16} />
            Confirm
          </Button>
        </div>
      </div>
    </div>
  );
}

function PlanCorrectionComposer(props: {
  draft: string;
  busy: boolean;
  disabled?: boolean;
  placeholder?: string;
  status?: React.ReactNode;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
}): JSX.Element {
  const { draft, busy, disabled = false, placeholder = "Ask for follow-up changes", status, onDraftChange, onSubmit } = props;
  const canSubmit = !busy && !disabled && Boolean(draft.trim());
  const disabledTitle = disabled && !busy ? placeholder : "Send correction";
  return (
    <div className={`plan-correction-composer ${busy ? "is-running" : ""}`} data-testid="plan-followup-composer">
      {status && <div className="plan-correction-status">{status}</div>}
      <div className="plan-correction-input-row">
        <ResizableTextarea
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (canSubmit) {
                onSubmit();
              }
            }
          }}
          rows={2}
          maxHeight={220}
          placeholder={placeholder}
          disabled={busy || disabled}
        />
        <Button
          variant="outline"
          size="icon-lg"
          className="plan-correction-submit"
          title={disabledTitle}
          aria-label={disabledTitle}
          disabled={!canSubmit}
          onClick={onSubmit}
        >
          {busy ? <RefreshCw size={18} className="spin" /> : <SendHorizontal size={18} />}
        </Button>
      </div>
    </div>
  );
}

function DecisionThread(props: {
  decision: PlanDecisionRequest;
  replies: PlanDecisionReply[];
  selectedOptionId?: string;
  resolved: boolean;
  readOnly: boolean;
  savedAnswer?: PlanDecisionAnswer;
  clarificationDraft: string;
  typingLabels: string[];
  busy: boolean;
  focused: boolean;
  onFocus: () => void;
  onExitFocus: () => void;
  onClose: () => void;
  onSelectOption: (optionId: string) => void;
  onResolve: () => void;
  onDraftChange: (value: string) => void;
  onAskClarification: () => void;
}): JSX.Element {
  const {
    decision,
    replies,
    selectedOptionId,
    resolved,
    readOnly,
    savedAnswer,
    clarificationDraft,
    typingLabels,
    busy,
    focused,
    onFocus,
    onExitFocus,
    onClose,
    onSelectOption,
    onResolve,
    onDraftChange,
    onAskClarification
  } = props;
  const isAsking = busy && replies.some((reply) => reply.id.startsWith("pending:"));
  const hasThreadContext = decisionThreadIsReady(
    decision,
    selectedOptionId ? { [decision.id]: selectedOptionId } : {},
    resolved ? { [decision.id]: true } : {},
    savedAnswer ? [savedAnswer] : []
  );
  const canResolve = !hasThreadContext && decisionThreadHasUserReply(decision, replies);
  const decisionAuthor = sourceLabelForDecision(decision);
  const statusLabel = readOnly ? "Answered" : hasThreadContext ? "Ready" : "Pending";

  return (
    <div className="point-thread decision-thread">
      <div className="thread-panel-head">
        <div>
          <span>Decision</span>
          <h2>{decision.title}</h2>
        </div>
        <div className="thread-panel-actions">
          <StatusBadge tone={hasThreadContext || readOnly ? "success" : "neutral"}>{statusLabel}</StatusBadge>
          <IconButton
            size="sm"
            icon={focused ? Columns2 : Maximize2}
            label={focused ? "Show timeline" : "Expand thread"}
            tooltip={focused ? "Show timeline" : "Expand thread"}
            onClick={focused ? onExitFocus : onFocus}
          />
          <IconButton size="sm" icon={X} label="Close thread" tooltip="Close thread" onClick={onClose} />
        </div>
      </div>

      <ThreadMessage
        avatar={avatarForParticipant(decisionAuthor, decision.sourceParticipantIds?.[0])}
        author={decisionAuthor}
        meta="Decision request"
        createdAt={decision.createdAt}
        title={decision.question}
        content={decision.impact}
      />

      {decision.options.length > 0 && (
        <div className="decision-options thread-decision-options">
          {decision.options.map((option) => (
            <label className={`decision-option ${selectedOptionId === option.id ? "selected" : ""}`} key={option.id}>
              <input
                type="radio"
                name={decision.id}
                checked={selectedOptionId === option.id}
                disabled={busy || readOnly}
                onChange={() => onSelectOption(option.id)}
              />
              <span className="decision-option-body">
                <span>{option.label}</span>
                {decision.recommendedOptionId === option.id && <small>Recommended</small>}
              </span>
            </label>
          ))}
        </div>
      )}

      <div className="thread-replies">
        {readOnly && savedAnswer && (
          <ThreadMessage
            avatar={savedAnswer.answerSource === "automatic" ? ARBITER_AVATAR : USER_AVATAR}
            author={savedAnswer.answerSource === "automatic" ? "Planner" : "You"}
            meta={savedAnswer.answerSource === "automatic" ? "Automatic answer" : "Answer"}
            content={savedAnswer.answer}
          />
        )}
        {replies.map((reply) => (
          <ThreadMessage
            avatar={reply.role === "user" ? USER_AVATAR : avatarForParticipant(reply.participantLabel ?? reply.role, reply.participantId)}
            author={reply.role === "user" ? "You" : reply.participantLabel ?? "Participant"}
            meta={reply.id.startsWith("pending:") ? "Message sent" : reply.status === "error" ? "Reply error" : reply.answerSource === "automatic" ? "automatic" : reply.role === "user" ? "Message" : "Reply"}
            createdAt={reply.createdAt}
            content={reply.content}
            key={reply.id}
          />
        ))}
        {isAsking && (
          <TypingIndicator labels={typingLabels} />
        )}
      </div>

      {!readOnly && (
        <div className="decision-compose">
          <ResizableTextarea
            value={clarificationDraft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (!busy && clarificationDraft.trim()) {
                  onAskClarification();
                }
              }
            }}
            rows={3}
            maxHeight={240}
            placeholder="Send a message in this thread"
            disabled={busy}
          />
          <div className="decision-compose-actions">
            <Button variant="outline" size="sm" disabled={busy || !clarificationDraft.trim()} onClick={onAskClarification}>
              {isAsking ? <RefreshCw size={16} className="spin" /> : <MessageSquare size={16} />}
              {isAsking ? "Sending..." : "Send"}
            </Button>
            <Button variant="outline" size="sm" disabled={busy || !canResolve} onClick={onResolve}>
              <CheckCircle2 size={16} />
              Resolve
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function TypingIndicator({ labels }: { labels: string[] }): JSX.Element {
  const visibleLabels = labels.length ? labels : ["Models"];
  return (
    <article className="thread-typing" aria-live="polite">
      <Avatar className="thread-avatar typing-avatar" spec={avatarForParticipant(visibleLabels[0])} />
      <div className="typing-bubble">
        <span>{typingText(visibleLabels)}</span>
        <span className="typing-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </div>
    </article>
  );
}

function ThreadMessage(props: {
  avatar: AvatarSpec;
  author: string;
  meta: string;
  createdAt?: string;
  title?: string;
  content: string;
  badges?: React.ReactNode;
}): JSX.Element {
  return (
    <article className="thread-message">
      <Avatar className="thread-avatar" spec={props.avatar} />
      <div className="thread-bubble">
        <div className="message-meta">
          <strong>{props.author}</strong>
          <span>{props.meta}</span>
          {props.createdAt && <span>{new Date(props.createdAt).toLocaleString()}</span>}
          {props.badges}
        </div>
        {props.title && <h3>{props.title}</h3>}
        <MarkdownText content={props.content} />
      </div>
    </article>
  );
}

const POINT_STATUS_TONE: Record<"confirmed" | "disputed" | "unresolved" | "filtered-out", StatusBadgeTone> = {
  confirmed: "success",
  disputed: "warning",
  unresolved: "neutral",
  "filtered-out": "muted"
};

function PointStatusBadge({ finding }: { finding: Finding }): JSX.Element {
  const status = pointStatus(finding);
  const Icon = status.kind === "confirmed" ? CheckCircle2 : status.kind === "filtered-out" ? XCircle : HelpCircle;
  return (
    <StatusBadge tone={POINT_STATUS_TONE[status.kind]} icon={Icon}>
      {status.label}
    </StatusBadge>
  );
}

function PlanItemReviewBadge({ review }: { review?: PlanItemReview }): JSX.Element {
  if (review) {
    return (
      <StatusBadge tone="success" icon={CheckCircle2}>
        reviewed
      </StatusBadge>
    );
  }
  return (
    <StatusBadge tone="neutral" icon={Circle}>
      pending
    </StatusBadge>
  );
}
