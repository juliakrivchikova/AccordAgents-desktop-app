import { useState } from "react";
import { CheckCircle2, Copy } from "lucide-react";

import type {
  Conversation,
  ConversationKind,
  Finding,
  PlanDecisionRequest,
  PlanItemReview
} from "../../../shared/types";
import {
  Avatar,
  ARBITER_AVATAR,
  avatarForMessage,
  avatarForParticipant
} from "../avatar/avatar";
import { MarkdownText } from "../content/markdown-text";
import { authorForMessage } from "../conversation/conversation-display";
import {
  IconButton,
  LoadingDot,
  SeverityBadge,
  StatusBadge
} from "../primitives";
import {
  displayMessageContent,
  sourceLabelForDecision
} from "./review-conversation-data";
import {
  PlanItemReviewBadge,
  PointStatusBadge
} from "./review-badges";

export function TimelineMessage({ message, kind }: { message: Conversation["messages"][number]; kind: ConversationKind }): JSX.Element {
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

export function PointTimelineMessage(props: {
  finding: Finding;
  kind: ConversationKind;
  selected: boolean;
  reviewRequired?: boolean;
  review?: PlanItemReview;
  onSelect: () => void;
}): JSX.Element {
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

export function DecisionTimelineMessage(props: {
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
