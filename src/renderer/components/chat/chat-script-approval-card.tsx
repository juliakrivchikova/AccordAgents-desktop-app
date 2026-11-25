import { useState } from "react";
import { CalendarDotsIcon, CheckIcon, CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";

import { Input } from "@/components/ui/input";
import type { ChatAppToolApproval, ChatAppToolApprovalScope, ChatParticipant } from "../../../shared/types";
import type { ChatScriptChangeRequest } from "../../../shared/scripts";
import { avatarForParticipant } from "../avatar/avatar";
import { chatParticipantDisplayName, chatParticipantReference } from "../conversation/conversation-display";
import { avatarForChatParticipant } from "./chat-avatars";
import { ChatMemberMark } from "./chat-member-mark";
import { formatChatTime } from "./chat-format";
import { ChatAppToolReviewFooter } from "./chat-app-tool-approval-review";
import { ChatUsedApprovalLine } from "./chat-used-card-row";
import { ChatScriptApprovalDetails } from "./chat-script-approval-details";
import { useSessionsViewLabel, useSessionsViewText } from "./chat-sessions-links";
import { useScriptApprovalKeys, type ScriptApprovalKeys } from "./use-script-approval-keys";

function scriptApprovalTitle(handle: string, request: ChatScriptChangeRequest): string {
  const who = chatParticipantReference(handle);
  switch (request.op) {
    case "create": return `${who} wants to add a scheduled task`;
    case "update": return `${who} wants to change a scheduled task`;
    case "delete": return `${who} wants to delete a scheduled task`;
    case "enable": return `${who} wants to switch on a scheduled task`;
    case "disable": return `${who} wants to switch off a scheduled task`;
  }
}

function scriptApprovedEnding(request: ChatScriptChangeRequest, schedule: string | undefined, withoutCard: boolean): string {
  const done = withoutCard ? "Created" : request.op === "delete" ? "Deleted" : request.op === "disable" ? "Switched off" : request.op === "enable" ? "Switched on" : "Approved";
  return schedule ? `${done} · ${schedule}` : done;
}

function scriptApprovalPrimaryLabel(request: ChatScriptChangeRequest): string {
  switch (request.op) {
    case "create": return "Approve and run";
    case "update": return "Approve change";
    case "delete": return "Delete task";
    case "enable": return "Switch on";
    case "disable": return "Switch off";
  }
}

/** What the card proposes, beside who proposes it. */
function scriptProposal(op: ChatScriptChangeRequest["op"]): string {
  switch (op) {
    case "create": return "Proposes a scheduled task";
    case "update": return "Proposes a change to a scheduled task";
    case "delete": return "Proposes to delete a scheduled task";
    case "enable": return "Proposes to switch on a scheduled task";
    case "disable": return "Proposes to switch off a scheduled task";
  }
}

/** The approval card for a scheduled-script proposal. It always approves
 *  this one proposal: no "for this chat", no editing. It says the task's name
 *  and when it runs and asks for its keys; everything else is under Details
 *  (the User, 2026-11-25: a huge card nobody reads). Keys are typed here and
 *  saved, as she approves, straight to the computer that runs the script (this
 *  one, or the member's machine); they never travel with the decision. */
export function ChatScriptApprovalCard(props: {
  approval: ChatAppToolApproval;
  request: ChatScriptChangeRequest;
  participants: ChatParticipant[];
  submitting: boolean;
  embedded?: boolean;
  onRespond: (approvalId: string, approve: boolean, scope?: ChatAppToolApprovalScope) => Promise<void>;
}): JSX.Element {
  const { approval, request } = props;
  const requester = props.participants.find((participant) => participant.id === approval.requesterParticipantId);
  const requesterLabel = requester ? chatParticipantDisplayName(requester) : chatParticipantReference(approval.requesterHandle);
  const requesterAvatar = requester
    ? avatarForChatParticipant(requester, requesterLabel)
    : avatarForParticipant(requesterLabel, approval.requesterParticipantId);
  // The sessions view names members by their task, the main session by
  // nothing (it is "this chat" where a list must name it).
  const appText = useSessionsViewText();
  const nameOf = useSessionsViewLabel();
  const requesterName = nameOf(requesterLabel);
  const pending = approval.status === "pending";
  // A member on a machine proposed it: the script, its code and its keys
  // live on that machine.
  const hostId = approval.homeMachineId;
  const needsKeys = request.op === "create" || request.op === "update";
  const keys = useScriptApprovalKeys(request, hostId, pending && needsKeys);
  const [detailsOpen, setDetailsOpen] = useState(false);

  async function approve(): Promise<void> {
    if (await keys.save()) await props.onRespond(approval.id, true, "once");
  }

  const chats = request.permissions.chatIds.map((chatId) => request.chatLabels[chatId] ?? chatId);
  const members = request.permissions.participantIds.map((participantId) => {
    const label = request.participantLabels[participantId] ?? participantId;
    return nameOf(label) || (label.startsWith("@") ? "this chat" : label);
  });
  const title = appText(scriptApprovalTitle(approval.requesterHandle, request));

  // A task created without a card has nothing to wait for.
  const queuedDecision = approval.status === "auto-applied" ? undefined : approval.machineDecisionPending;
  if (queuedDecision) {
    return (
      <section className="chat-app-tool-approval-card is-compact-result" aria-label={title}
        data-app-tool-approval-id={approval.id} tabIndex={-1}>
        <ChatMemberMark className="message-avatar chat-app-tool-approval-avatar" markClassName="is-large" avatar={requesterAvatar} member={requester} />
        <div className="chat-app-tool-approval-body">
          <strong>{queuedDecision.approve ? "Approval saved" : "Refusal saved"}</strong>
          <p>Waiting for machine {queuedDecision.machineName} to confirm the decision.</p>
        </div>
      </section>
    );
  }

  // Used: one line, like a folded urgent alert (the User, 2026-11-18).
  if (!pending) {
    // Approved, it ends as the button she pressed says (created without a
    // card: that it was); a task that will run ends with its schedule, not a
    // second time.
    const withoutCard = approval.status === "auto-applied";
    const applied = approval.status === "approved" || withoutCard;
    const runs = applied && request.op !== "delete" && request.op !== "disable";
    const schedule = runs && request.scheduleText ? request.scheduleText : undefined;
    const ended = applied ? scriptApprovedEnding(request, schedule, withoutCard)
      : approval.status === "denied" ? "Declined" : approval.status === "cancelled" ? "Cancelled" : "Expired";
    return (
      <ChatUsedApprovalLine approval={approval} kind="Scheduled task" icon={CalendarDotsIcon} preview={request.name} ended={ended}
        withoutTime={Boolean(schedule)} detail={approval.error} />
    );
  }

  return (
    <section
      className={`chat-app-tool-approval-card is-review-change chat-script-approval-card ${props.embedded ? "is-embedded" : ""} is-${approval.status}`}
      aria-label={title}
      data-app-tool-approval-id={approval.id}
      tabIndex={-1}
    >
      <ChatMemberMark className="message-avatar chat-app-tool-approval-avatar" markClassName="is-large" avatar={requesterAvatar} member={requester} />
      <div className="chat-app-tool-approval-body">
        <div className="chat-app-tool-approval-meta">
          {requesterName && <strong>{requesterName}</strong>}
          <span className="message-provider">{scriptProposal(request.op)}</span>
          <span className="message-when">{formatChatTime(approval.createdAt)}</span>
        </div>
        <div className="chat-app-tool-approval-panel is-review-change">
          <div className="chat-script-approval-content">
            <div className="chat-script-approval-head">
              <CalendarDotsIcon size={14} aria-hidden />
              <strong className="chat-script-approval-name">{request.name}</strong>
              <span className="chat-script-approval-schedule">{request.scheduleText} on {request.hostPhrase}</span>
            </div>
            {approval.cardRefusals?.length ? (
              <p className="chat-script-approval-error">Your earlier answer was not applied: {appText(approval.cardRefusals[approval.cardRefusals.length - 1].reason)}</p>
            ) : null}
            {keys.names.map((name) => <ChatScriptApprovalKey key={name} name={name} keys={keys} />)}
            {keys.error && <p className="chat-script-approval-error">{keys.error}</p>}
            <button type="button" className="chat-script-approval-toggle" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(!detailsOpen)}>
              {detailsOpen ? <CaretDownIcon size={14} aria-hidden /> : <CaretRightIcon size={14} aria-hidden />}
              Details
            </button>
            {detailsOpen && <ChatScriptApprovalDetails request={request} hostId={hostId} chats={chats} members={members} installs={needsKeys} />}
          </div>
          <ChatAppToolReviewFooter
            primaryLabel={scriptApprovalPrimaryLabel(request)}
            submitting={props.submitting || keys.saving}
            approveDisabled={!keys.complete}
            cancelLabel="Decline"
            onCancel={() => void props.onRespond(approval.id, false)}
            onApprove={() => void approve()}
          />
        </div>
      </div>
    </section>
  );
}

interface ChatScriptApprovalKeyProps {
  name: string;
  keys: ScriptApprovalKeys;
}

const ChatScriptApprovalKey = ({ name, keys }: ChatScriptApprovalKeyProps): JSX.Element => (
  <div className="chat-script-approval-key">
    <code>{name}</code>
    {keys.isSaved(name) ? (
      <span className="chat-script-approval-key-saved">
        <CheckIcon size={13} aria-hidden /> Saved
        <button type="button" className="chat-script-approval-link" onClick={() => keys.replace(name)}>Replace</button>
      </span>
    ) : (
      <Input
        type="password"
        autoComplete="off"
        spellCheck={false}
        className="chat-script-approval-key-field focus-visible:ring-0"
        aria-label={`Value for ${name}`}
        placeholder="Paste value"
        disabled={keys.saving}
        value={keys.valueOf(name)}
        onChange={(event) => keys.onChange(name, event.target.value)}
      />
    )}
  </div>
);
