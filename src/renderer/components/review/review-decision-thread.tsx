import { CheckCircle2, Columns2, Maximize2, MessageSquare, RefreshCw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import type {
  PlanDecisionAnswer,
  PlanDecisionReply,
  PlanDecisionRequest
} from "../../../shared/types";
import {
  ARBITER_AVATAR,
  USER_AVATAR,
  avatarForParticipant
} from "../avatar/avatar";
import {
  IconButton,
  ResizableTextarea,
  StatusBadge
} from "../primitives";
import {
  decisionThreadHasUserReply,
  decisionThreadIsReady,
  sourceLabelForDecision
} from "./review-conversation-data";
import {
  ThreadMessage,
  TypingIndicator
} from "./review-thread-message";

export function DecisionThread(props: {
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
