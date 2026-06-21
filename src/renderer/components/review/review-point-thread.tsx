import { CheckCircle2, Columns2, Maximize2, MessageSquare, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import type {
  ConversationKind,
  Finding,
  PlanItemReview
} from "../../../shared/types";
import {
  ARBITER_AVATAR,
  Avatar,
  USER_AVATAR,
  avatarForParticipant
} from "../avatar/avatar";
import { MarkdownText } from "../content/markdown-text";
import {
  IconButton,
  ResizableTextarea,
  SeverityBadge
} from "../primitives";
import {
  canonicalPlanItemContent,
  pointSourceContent,
  pointThreadReplies,
  sourceItemContent
} from "./review-conversation-data";
import {
  PlanItemReviewBadge,
  PointStatusBadge
} from "./review-badges";
import { ThreadMessage } from "./review-thread-message";

export function PointThread(props: {
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
