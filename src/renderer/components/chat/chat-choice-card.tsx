import { useEffect, useState } from "react";
import { CheckCircle2, PencilLine } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { ChatPendingChoice } from "../../../shared/types";
import {
  CHAT_CUSTOM_CHOICE_OPTION_ID,
  formatChatChoiceReceiptTime
} from "./chat-conversation-data";

export function ChatChoiceCard(props: {
  choice: ChatPendingChoice;
  requesterLabel: string;
  submitting: boolean;
  onConfirm: (response: { selectedOptionId?: string; customAnswer?: string; note?: string }) => void;
}): JSX.Element {
  const { choice, requesterLabel, submitting, onConfirm } = props;
  const [draftSelection, setDraftSelection] = useState(choice.selectedOptionId ?? "");
  const [customAnswer, setCustomAnswer] = useState(choice.customAnswer ?? "");
  const [note, setNote] = useState(choice.note ?? "");
  const isAnswered = choice.status === "selected";
  const selectedOptionId = choice.selectedOptionId ?? draftSelection;
  const isCustomSelected = selectedOptionId === CHAT_CUSTOM_CHOICE_OPTION_ID;
  const selectedOption = choice.options.find((option) => option.id === selectedOptionId);
  const requesterMention = requesterLabel.startsWith("@") ? requesterLabel : requesterLabel === "You" ? "User" : requesterLabel;
  const selectedOverridesRecommendation = isAnswered && Boolean(choice.recommendedOptionId) && selectedOptionId !== choice.recommendedOptionId;
  const receiptTime = formatChatChoiceReceiptTime(choice.selectedAt);
  const canConfirm = !submitting && !isAnswered && (isCustomSelected ? Boolean(customAnswer.trim()) : Boolean(selectedOption));
  const selectedLabel = isCustomSelected
    ? customAnswer.trim() || "Write your own answer"
    : selectedOption?.label;
  const trimmedCustomAnswer = customAnswer.trim();
  const trimmedNote = note.trim();
  const showCustomAnswerPanel = isCustomSelected && (!isAnswered || Boolean(trimmedCustomAnswer));
  const showNotePanel = !isCustomSelected && Boolean(selectedOption) && (!isAnswered || Boolean(trimmedNote));

  useEffect(() => {
    setDraftSelection(choice.selectedOptionId ?? "");
    setCustomAnswer(choice.customAnswer ?? "");
    setNote(choice.note ?? "");
  }, [choice.id, choice.selectedOptionId, choice.customAnswer, choice.note]);

  function confirmChoice(): void {
    if (!canConfirm) {
      return;
    }
    if (isCustomSelected) {
      onConfirm({
        selectedOptionId: CHAT_CUSTOM_CHOICE_OPTION_ID,
        customAnswer: customAnswer.trim()
      });
      return;
    }
    if (selectedOption) {
      onConfirm({
        selectedOptionId: selectedOption.id,
        note: note.trim() || undefined
      });
    }
  }

  return (
    <section className={`chat-choice-card ${isAnswered ? "answered" : ""}`} aria-label={choice.title}>
      <div className="chat-choice-head">
        <div className="chat-choice-title-block">
          <h3>{choice.title}</h3>
        </div>
        <span className={`chat-choice-status ${isAnswered ? "answered" : ""}`}>
          {isAnswered && <CheckCircle2 size={14} aria-hidden="true" />}
          {isAnswered ? `Sent${receiptTime ? ` · ${receiptTime}` : ""}` : "Awaiting answer"}
        </span>
      </div>
      <p>{choice.question}</p>
      <div className="chat-choice-options" role="radiogroup" aria-label={choice.question}>
        {choice.options.map((option) => {
          const selected = selectedOptionId === option.id;
          return (
            <label className={`chat-choice-option ${selected ? "selected" : ""} ${isAnswered && !selected ? "collapsed" : ""}`} key={option.id}>
              <input
                type="radio"
                name={choice.id}
                checked={selected}
                disabled={submitting || isAnswered}
                onChange={() => setDraftSelection(option.id)}
              />
              <span className="chat-choice-radio" aria-hidden="true" />
              <span className="chat-choice-option-body">
                <span className="chat-choice-option-title">
                  <strong>{option.label}</strong>
                  {isAnswered && selected && selectedOverridesRecommendation && <small className="chat-choice-override-chip">≠ recommendation</small>}
                  {choice.recommendedOptionId === option.id && <small className="chat-choice-recommended-chip">Recommended</small>}
                </span>
                {option.description && (!isAnswered || selected) && <span className="chat-choice-option-description">{option.description}</span>}
              </span>
            </label>
          );
        })}
        <label className={`chat-choice-option custom-answer-option ${isCustomSelected ? "selected" : ""} ${isAnswered && !isCustomSelected ? "collapsed" : ""}`}>
          <input
            type="radio"
            name={choice.id}
            checked={isCustomSelected}
            disabled={submitting || isAnswered}
            onChange={() => setDraftSelection(CHAT_CUSTOM_CHOICE_OPTION_ID)}
          />
          <span className="chat-choice-radio" aria-hidden="true" />
          <span className="chat-choice-option-body">
            <span className="chat-choice-option-title">
              <span className="chat-choice-custom-icon" aria-hidden="true">
                <PencilLine size={14} />
              </span>
              <strong>Write your own answer</strong>
              {isAnswered && isCustomSelected && selectedOverridesRecommendation && <small className="chat-choice-override-chip">≠ recommendation</small>}
            </span>
            {(!isAnswered || isCustomSelected) && (
              <span className="chat-choice-option-description">None of the suggestions fit — type your own direction for {requesterMention}.</span>
            )}
          </span>
        </label>
      </div>
      {showCustomAnswerPanel && isAnswered && (
        <div className="chat-choice-text-panel locked">
          <span>
            <strong>Your answer</strong>
            <small>sent to {requesterMention}</small>
          </span>
          <blockquote>{trimmedCustomAnswer}</blockquote>
        </div>
      )}
      {showCustomAnswerPanel && !isAnswered && (
        <label className="chat-choice-text-panel">
          <span>
            <strong>Your answer</strong>
            <small>required · sent verbatim to {requesterMention}</small>
          </span>
          <Textarea
            value={customAnswer}
            onChange={(event) => setCustomAnswer(event.target.value)}
            placeholder={'e.g. "Use session cookies for web, but issue short-lived JWTs to native clients"'}
            rows={3}
            disabled={submitting || isAnswered}
          />
        </label>
      )}
      {showNotePanel && isAnswered && (
        <div className="chat-choice-text-panel locked">
          <span>
            <strong>Your note</strong>
            <small>sent with your pick</small>
          </span>
          <blockquote>{trimmedNote}</blockquote>
        </div>
      )}
      {showNotePanel && !isAnswered && (
        <label className="chat-choice-text-panel">
          <span>
            <strong>Add a note</strong>
            <small>optional · {requesterMention} will see it alongside your pick</small>
          </span>
          <Textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={`Constraints, caveats, or follow-up questions for ${requesterMention}...`}
            rows={2}
            disabled={submitting || isAnswered}
          />
        </label>
      )}
      {!isAnswered && (
        <div className="chat-choice-actions">
          {isCustomSelected && !customAnswer.trim() ? (
            <span>Type your answer to enable send.</span>
          ) : selectedLabel ? (
            <span>Selected: <strong>{selectedLabel}</strong></span>
          ) : (
            <span>Select one option to continue.</span>
          )}
          <Button size="sm" className="chat-choice-submit" disabled={!canConfirm} onClick={confirmChoice}>
            <span>Submit</span>
            <kbd aria-hidden="true">↵</kbd>
          </Button>
        </div>
      )}
    </section>
  );
}
