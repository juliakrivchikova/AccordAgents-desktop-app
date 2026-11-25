import { useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { ArrowElbowDownLeftIcon, ArrowsInSimpleIcon } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import type { ChatAppToolApproval, ChatAppToolApprovalScope, ChatParticipant, ChatSelfCompactionRequest } from "../../../shared/types";
import {
  COMPACTION_CARD_CHAT_SCOPE,
  COMPACTION_CARD_COMPACT,
  COMPACTION_CARD_KEEPS,
  COMPACTION_CARD_METER_NAME,
  COMPACTION_CARD_NOT_NOW,
  COMPACTION_CARD_SENTENCE,
  COMPACTION_CARD_TITLE,
  COMPACTION_CARD_USED_PREVIEW,
  compactionCardEnding,
  compactionMeterLabel
} from "../../../shared/compactionCard";
import { avatarForParticipant } from "../avatar/avatar";
import { chatParticipantDisplayName, chatParticipantReference } from "../conversation/conversation-display";
import { avatarForChatParticipant } from "./chat-avatars";
import { ChatMemberMark, useChatSessionsPresentation } from "./chat-member-mark";
import { useSessionsViewLabel, useSessionsViewText } from "./chat-sessions-links";
import { ChatUsedApprovalLine } from "./chat-used-card-row";

/** Cards whose "Don't ask again" box is ticked in this window: the tick
 *  survives the card being drawn again (the timeline topping up, the view
 *  switching), as the phone keeps it. */
const tickedCards = new Set<string>();

/**
 * The card a member raises to compact its own conversation, as the User
 * approved it on 2026-11-22 (src/shared/compactionCard.ts has its words).
 * Who asks is one small line above it: the member's avatar and name in the
 * classic view; in the sessions view its task's title, and nothing for the
 * main session (sessionsViewText's rule, decided 2026-11-22). Answered, it
 * folds to one line like every used card.
 */
export function ChatCompactionApprovalCard(props: {
  approval: ChatAppToolApproval;
  request: ChatSelfCompactionRequest;
  participants: ChatParticipant[];
  submitting: boolean;
  embedded?: boolean;
  onRespond: (approvalId: string, approve: boolean, scope?: ChatAppToolApprovalScope) => Promise<void>;
}): JSX.Element {
  const { approval, request } = props;
  const [dontAskAgain, setDontAskAgainState] = useState(() => tickedCards.has(props.approval.id));
  const setDontAskAgain = (value: boolean): void => {
    if (value) tickedCards.add(props.approval.id);
    else tickedCards.delete(props.approval.id);
    setDontAskAgainState(value);
  };
  const sessions = useChatSessionsPresentation();
  const appText = useSessionsViewText();
  const requester = props.participants.find((participant) => participant.id === approval.requesterParticipantId);
  const requesterLabel = requester ? chatParticipantDisplayName(requester) : chatParticipantReference(approval.requesterHandle);
  const requesterName = useSessionsViewLabel()(requesterLabel);
  const requesterAvatar = requester
    ? avatarForChatParticipant(requester, requesterLabel)
    : avatarForParticipant(requesterLabel, approval.requesterParticipantId);
  const queuedDecision = approval.machineDecisionPending;
  // Focused by a click on its text (a pointer press on it since it last had
  // focus): Enter is not Compact then. Chromium shows :focus-visible as soon
  // as a key is pressed, so the ring alone cannot tell.
  const pointerFocused = useRef(false);

  if (queuedDecision) {
    // As every card says it while a machine confirms (chat-app-tool-approval-card).
    return (
      <section className="chat-app-tool-approval-card is-compact-result" aria-label={COMPACTION_CARD_TITLE}
        data-app-tool-approval-id={approval.id} tabIndex={-1}>
        <ChatMemberMark className="message-avatar chat-app-tool-approval-avatar" markClassName="is-large" avatar={requesterAvatar} member={requester} />
        <div className="chat-app-tool-approval-body">
          <strong>{queuedDecision.approve ? "Approval saved" : "Refusal saved"}</strong>
          <p>Waiting for machine {queuedDecision.machineName} to confirm the decision.</p>
        </div>
      </section>
    );
  }

  if (approval.status !== "pending") {
    return (
      <ChatUsedApprovalLine
        approval={approval}
        kind="Compaction"
        icon={ArrowsInSimpleIcon}
        preview={COMPACTION_CARD_USED_PREVIEW}
        {...compactionCardEnding(approval)}
      />
    );
  }

  const percentage = request.contextPercentage;
  const lastRefusal = approval.cardRefusals?.at(-1);
  const compact = (): void => {
    if (!props.submitting) void props.onRespond(approval.id, true, dontAskAgain ? "chat" : "once");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    // Enter is Compact, as its key hint says: on the card itself while its
    // ring shows (keyboard focus, or Activity's Open in chat). Never on a
    // control, never held down, and not after a mouse click on its text,
    // which focuses it without a ring.
    if (event.key !== "Enter" || event.repeat || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    const card = event.currentTarget;
    if (event.target !== card || pointerFocused.current || !card.matches(":focus-visible, .approval-focused")) return;
    event.preventDefault();
    compact();
  };
  const onBlur = (event: FocusEvent<HTMLElement>): void => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) pointerFocused.current = false;
  };

  return (
    <section
      className={`chat-compaction-card ${props.embedded ? "is-embedded" : ""} ${sessions ? "is-sessions" : ""}`}
      aria-label={COMPACTION_CARD_TITLE}
      data-app-tool-approval-id={approval.id}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerDown={() => { pointerFocused.current = true; }}
      onBlur={onBlur}
    >
      {/* Under its member's own message the message names it already. */}
      {requesterName && !props.embedded && (
        <div className="chat-compaction-card-who">
          {!sessions && <ChatMemberMark className="chat-compaction-card-who-avatar" markClassName="is-mini" avatar={requesterAvatar} member={requester} />}
          <span className="chat-compaction-card-who-name">{requesterName}</span>
        </div>
      )}
      <div className="chat-compaction-card-panel">
        <div className="chat-compaction-card-top">
          <span className="chat-compaction-card-icon" aria-hidden="true"><ArrowsInSimpleIcon size={16} /></span>
          <div className="chat-compaction-card-text">
            <h3 className="chat-compaction-card-title">{COMPACTION_CARD_TITLE}</h3>
            <p className="chat-compaction-card-desc">{COMPACTION_CARD_SENTENCE}</p>
            {lastRefusal && <p className="chat-compaction-card-refusal">Your earlier answer was not applied: {appText(lastRefusal.reason)}</p>}
            {percentage !== undefined && (
              <div className="chat-compaction-card-meter">
                <div className="chat-compaction-card-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage}
                  aria-label={COMPACTION_CARD_METER_NAME} aria-valuetext={compactionMeterLabel(percentage)}>
                  <span style={{ width: `${percentage}%` }} />
                </div>
                <span className="chat-compaction-card-meter-label" aria-hidden="true">{compactionMeterLabel(percentage)}</span>
              </div>
            )}
            {request.instructions && (
              <p className="chat-compaction-card-keeps" title={request.instructions}><b>{COMPACTION_CARD_KEEPS}</b> {request.instructions}</p>
            )}
          </div>
        </div>
        <div className="chat-compaction-card-foot">
          <label className="chat-compaction-card-check">
            <input type="checkbox" checked={dontAskAgain} disabled={props.submitting}
              onChange={(event) => setDontAskAgain(event.target.checked)} />
            <span>{COMPACTION_CARD_CHAT_SCOPE}</span>
          </label>
          <button type="button" className="chat-compaction-card-not-now" disabled={props.submitting}
            onClick={() => void props.onRespond(approval.id, false)}>
            {COMPACTION_CARD_NOT_NOW}
          </button>
          <Button type="button" variant="default" size="sm" className="chat-compaction-card-compact" disabled={props.submitting} onClick={compact}>
            <span>{COMPACTION_CARD_COMPACT}</span>
            <ArrowElbowDownLeftIcon size={14} aria-hidden />
          </Button>
        </div>
      </div>
    </section>
  );
}
