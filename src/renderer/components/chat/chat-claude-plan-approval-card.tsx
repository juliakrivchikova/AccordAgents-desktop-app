import { useState, type KeyboardEvent } from "react";
import { ArrowDownIcon, ArrowUpIcon, ArrowElbowDownLeftIcon, ClipboardTextIcon } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type {
  ChatAppToolApproval,
  ChatAppToolApprovalRequest,
  ChatAppToolApprovalScope,
  ChatClaudePlanDecision,
  ChatParticipant
} from "../../../shared/types";
import {
  CLAUDE_PLAN_APPROVAL_INTRO,
  CLAUDE_PLAN_APPROVAL_QUESTION,
  CLAUDE_PLAN_APPROVAL_TITLE,
  claudePlanApprovalOption,
  claudePlanApprovalOptions,
  claudePlanShown
} from "../../../shared/claudePlanApproval";
import { avatarForParticipant } from "../avatar/avatar";
import { chatParticipantDisplayName, chatParticipantReference } from "../conversation/conversation-display";
import { MarkdownText } from "../content/markdown-text";
import { avatarForChatParticipant } from "./chat-avatars";
import { chatApprovalKeyboardAction, participantProviderLabel } from "./chat-conversation-data";
import { ChatMemberMark } from "./chat-member-mark";
import { formatChatTime } from "./chat-format";
import { useSessionsViewLabel, useSessionsViewText } from "./chat-sessions-links";
import { ChatUsedApprovalLine } from "./chat-used-card-row";
import type { ChatClaudePlanApprovalRequest } from "./chat-app-tool-data";

/** How an answered plan approval ended, for its one line. */
function planApprovalEnding(approval: ChatAppToolApproval, request: ChatClaudePlanApprovalRequest): { ended: string; detail?: string } {
  const picked = claudePlanApprovalOption(request.planApproval, approval.planDecision?.optionId);
  if (picked && (approval.status === "approved" || approval.status === "denied")) {
    return { ended: picked.label, ...(approval.planDecision?.feedback ? { detail: approval.planDecision.feedback } : {}) };
  }
  return { ended: "Closed", detail: approval.error ? `Closed: ${approval.error}` : "Closed without an answer." };
}

/**
 * Claude Code's own plan approval (src/shared/claudePlanApproval.ts): the
 * CLI's "Ready to code?" dialog, its words around the plan and its rows.
 * A Yes moves the member's CLI into the mode it names; "No, keep planning"
 * sends her words back to it.
 */
export function ChatClaudePlanApprovalCard(props: {
  approval: ChatAppToolApproval;
  request: ChatClaudePlanApprovalRequest;
  participants: ChatParticipant[];
  submitting: boolean;
  embedded?: boolean;
  onRespond: (
    approvalId: string,
    approve: boolean,
    scope?: ChatAppToolApprovalScope,
    draftOverride?: ChatAppToolApprovalRequest,
    codexDecisionId?: string,
    planDecision?: ChatClaudePlanDecision
  ) => Promise<void>;
}): JSX.Element {
  const { approval, request } = props;
  const requester = props.participants.find((participant) => participant.id === approval.requesterParticipantId);
  const requesterLabel = requester ? chatParticipantDisplayName(requester) : chatParticipantReference(approval.requesterHandle);
  // The sessions view names who asks by its task, the main session by nothing.
  const appText = useSessionsViewText();
  const requesterName = useSessionsViewLabel()(requesterLabel);
  const requesterAvatar = requester
    ? avatarForChatParticipant(requester, requesterLabel)
    : avatarForParticipant(requesterLabel, approval.requesterParticipantId);
  const options = claudePlanApprovalOptions(request.planApproval);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [feedback, setFeedback] = useState("");
  const shown = claudePlanShown(request.planApproval);
  const isPlan = shown === request.planApproval.plan;
  const selected = options[Math.min(selectedIndex, options.length - 1)];
  const queuedDecision = approval.machineDecisionPending;

  if (queuedDecision) {
    return (
      <section className="chat-app-tool-approval-card is-compact-result" aria-label={CLAUDE_PLAN_APPROVAL_TITLE}
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
    return <ChatUsedApprovalLine approval={approval} kind="Plan approval" icon={ClipboardTextIcon} preview={CLAUDE_PLAN_APPROVAL_TITLE} {...planApprovalEnding(approval, request)} />;
  }

  function submit(): void {
    if (props.submitting || !selected) return;
    const words = selected.placeholder ? feedback.trim() : "";
    void props.onRespond(approval.id, Boolean(selected.mode), undefined, undefined, undefined, {
      optionId: selected.id,
      ...(words ? { feedback: words } : {})
    });
  }

  function handleOptionsKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (props.submitting) return;
    const action = chatApprovalKeyboardAction(event.key, selectedIndex, options.length);
    if (!action) return;
    event.preventDefault();
    if (action.type === "submit") submit();
    else setSelectedIndex(action.index);
  }

  const lastRefusal = approval.cardRefusals?.at(-1);
  return (
    <section
      className={`chat-app-tool-approval-card chat-plan-approval-card ${props.embedded ? "is-embedded" : ""} is-${approval.status}`}
      aria-label={CLAUDE_PLAN_APPROVAL_TITLE}
      data-app-tool-approval-id={approval.id}
      tabIndex={-1}
    >
      <ChatMemberMark className="message-avatar chat-app-tool-approval-avatar" markClassName="is-large" avatar={requesterAvatar} member={requester} />
      <div className="chat-app-tool-approval-body">
        <div className="chat-app-tool-approval-meta">
          {requesterName && <strong>{requesterName}</strong>}
          {requester && <span className="message-provider">{participantProviderLabel(requester.kind, requester.hostLabel)}</span>}
          <span className="message-when">{formatChatTime(approval.createdAt)}</span>
        </div>
        <div className="chat-app-tool-approval-panel">
          <h3>{CLAUDE_PLAN_APPROVAL_TITLE}</h3>
          {lastRefusal && <div className="chat-app-tool-approval-reason">Your earlier answer was not applied: {appText(lastRefusal.reason)}</div>}
          <p className="chat-plan-approval-intro">{CLAUDE_PLAN_APPROVAL_INTRO}</p>
          <div className="chat-plan-approval-plan">
            {isPlan ? <MarkdownText content={shown} /> : <p className="chat-plan-approval-placeholder">{shown}</p>}
          </div>
          <p className="chat-plan-approval-question">{CLAUDE_PLAN_APPROVAL_QUESTION}</p>
          <div className="chat-approval-options" role="listbox" tabIndex={0} aria-label="Approval options" onKeyDown={handleOptionsKeyDown}>
            {options.map((option, index) => (
              <button
                type="button"
                role="option"
                aria-selected={index === selectedIndex}
                className={`chat-approval-option ${index === selectedIndex ? "selected" : ""}`}
                disabled={props.submitting}
                onClick={() => setSelectedIndex(index)}
                key={option.id}
                data-plan-option-id={option.id}
              >
                <span className="chat-approval-option-num">{index + 1}.</span>
                <span className="chat-approval-option-copy">
                  <span className="chat-approval-option-label">{option.label}</span>
                </span>
                {index === selectedIndex && (
                  <span className="chat-approval-option-keys" aria-hidden>
                    <ArrowUpIcon size={16} />
                    <ArrowDownIcon size={16} />
                  </span>
                )}
              </button>
            ))}
          </div>
          {selected?.placeholder && (
            <Textarea
              className="chat-plan-approval-feedback"
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder={selected.placeholder}
              aria-label={selected.label}
              rows={2}
              disabled={props.submitting}
            />
          )}
          <div className="chat-approval-footer">
            <Button variant="default" size="sm" className="chat-approval-submit" disabled={props.submitting} onClick={submit}>
              <span>Submit</span>
              <ArrowElbowDownLeftIcon size={14} aria-hidden />
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
