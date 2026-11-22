import { useEffect, useState } from "react";
import { ListChecksIcon, PencilLineIcon } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { ChatPendingChoice } from "../../../shared/types";
import { choiceOutcome } from "../../../shared/usedCards";
import { CHAT_CUSTOM_CHOICE_OPTION_ID } from "./chat-conversation-data";
import { formatChatTime } from "./chat-format";
import { useSessionsViewLabel, useSessionsViewText } from "./chat-sessions-links";

export function ChatChoiceCard(props: {
  choice: ChatPendingChoice;
  requesterLabel: string;
  submitting: boolean;
  onConfirm: (response: { cancel?: boolean; selectedOptionId?: string; customAnswer?: string; note?: string }) => void;
}): JSX.Element {
  const { choice, submitting, onConfirm } = props;
  // The sessions view names the main session by nothing and a member by its
  // task: the "who" and every sentence about it follow.
  const appText = useSessionsViewText();
  const requesterLabel = useSessionsViewLabel()(props.requesterLabel);
  const [draftSelection, setDraftSelection] = useState(choice.selectedOptionId ?? choice.recommendedOptionId ?? "");
  const [customAnswer, setCustomAnswer] = useState(choice.customAnswer ?? "");
  const [note, setNote] = useState(choice.note ?? "");
  const selectedOptionId = draftSelection;
  const isCustomSelected = selectedOptionId === CHAT_CUSTOM_CHOICE_OPTION_ID;
  const selectedOption = choice.options.find((option) => option.id === selectedOptionId);
  const requesterMention = props.requesterLabel.startsWith("@") ? props.requesterLabel : props.requesterLabel === "You" ? "User" : props.requesterLabel;
  const canCancel = !submitting;
  const canConfirm = !submitting && (isCustomSelected ? Boolean(customAnswer.trim()) : Boolean(selectedOption));

  useEffect(() => {
    setDraftSelection(choice.selectedOptionId ?? choice.recommendedOptionId ?? "");
    setCustomAnswer(choice.customAnswer ?? "");
    setNote(choice.note ?? "");
  }, [choice.id, choice.status, choice.selectedOptionId, choice.recommendedOptionId, choice.customAnswer, choice.note]);

  // Answered, cancelled or expired: one line, like a folded urgent alert
  // (the User, 2026-11-16) -- what was asked, then who asked and how it ended.
  const outcome = choiceOutcome(choice);
  if (outcome) {
    return (
      <section className="chat-choice-card is-folded" aria-label={`${choice.title}: ${outcome.text}`}>
        <div className="chat-card-row">
          <ListChecksIcon className="chat-card-row-icon" size={14} aria-hidden="true" />
          <span className="chat-card-row-preview">{choice.title}</span>
          <span className="chat-card-row-outcome" title={outcome.text}>
            {requesterLabel ? `${requesterLabel} · ` : ""}{outcome.text}{outcome.at ? ` ${formatChatTime(outcome.at)}` : ""}
          </span>
        </div>
      </section>
    );
  }

  function cancelChoice(): void {
    if (!canCancel) {
      return;
    }
    onConfirm({ cancel: true });
  }

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
    <section className="chat-choice-card" aria-label={choice.title}>
      <div className="chat-choice-head">
        <div className="chat-choice-title-block">
          <h3>{choice.title}</h3>
          <p className="chat-choice-question">{choice.question}</p>
        </div>
      </div>
      <div className="chat-choice-options" role="radiogroup" aria-label={choice.question}>
        {choice.options.map((option, index) => {
          const selected = selectedOptionId === option.id;
          return (
            <label className={`chat-choice-option ${selected ? "selected" : ""}`} key={option.id}>
              <input
                type="radio"
                name={choice.id}
                checked={selected}
                disabled={submitting}
                onChange={() => setDraftSelection(option.id)}
              />
              <span className="chat-choice-num" aria-hidden="true">{index + 1}.</span>
              <span className="chat-choice-option-body">
                <span className="chat-choice-option-title">
                  <strong>{option.label}</strong>
                  {choice.recommendedOptionId === option.id && <small className="chat-choice-recommended-chip">Recommended</small>}
                </span>
                {option.description && <span className="chat-choice-option-description">{option.description}</span>}
              </span>
            </label>
          );
        })}
        <label className={`chat-choice-option custom-answer-option ${isCustomSelected ? "selected" : ""}`}>
          <input
            type="radio"
            name={choice.id}
            checked={isCustomSelected}
            disabled={submitting}
            onChange={() => setDraftSelection(CHAT_CUSTOM_CHOICE_OPTION_ID)}
          />
          <span className="chat-choice-num chat-choice-custom-icon" aria-hidden="true">
            <PencilLineIcon size={14} />
          </span>
          <span className="chat-choice-option-body">
            <span className="chat-choice-option-title">
              <strong>Write your own answer</strong>
            </span>
            <span className="chat-choice-option-description">{appText(`None of the suggestions fit — type your own direction for ${requesterMention}.`)}</span>
          </span>
        </label>
      </div>
      {isCustomSelected && (
        <label className="chat-choice-text-panel">
          <span>
            <strong>Your answer</strong>
            <small>{appText(`required · sent verbatim to ${requesterMention}`)}</small>
          </span>
          <Textarea
            value={customAnswer}
            onChange={(event) => setCustomAnswer(event.target.value)}
            placeholder={'e.g. "Use session cookies for web, but issue short-lived JWTs to native clients"'}
            rows={3}
            disabled={submitting}
          />
        </label>
      )}
      {!isCustomSelected && selectedOption && (
        <label className="chat-choice-text-panel">
          <span>
            <strong>Add a note</strong>
            <small>{appText(`optional · ${requesterMention} will see it alongside your pick`)}</small>
          </span>
          <Textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={appText(`Constraints, caveats, or follow-up questions for ${requesterMention}...`)}
            rows={2}
            disabled={submitting}
          />
        </label>
      )}
      <div className="chat-choice-actions">
        {isCustomSelected && !customAnswer.trim() && (
          <span className="chat-choice-hint">Type your answer to enable send.</span>
        )}
        <div className="chat-choice-action-buttons">
          <button type="button" className="chat-choice-cancel" disabled={submitting} onClick={cancelChoice}>
            Cancel
          </button>
          <Button size="sm" className="chat-choice-submit" disabled={!canConfirm} onClick={confirmChoice}>
            <span>Submit</span>
            <kbd aria-hidden="true">↵</kbd>
          </Button>
        </div>
      </div>
    </section>
  );
}
