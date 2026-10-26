import { AlertTriangle, Check, Clock } from "lucide-react";

import type {
  ChatAppToolApproval,
  ChatAppToolApprovalScope,
  ChatParticipantRemovalRequest,
  ChatParticipantRemoveOperation
} from "../../../shared/types";
import { chatParticipantReference } from "../conversation/conversation-display";

/** "@a", "@a and @b", "@a, @b, and @c". */
function handleList(operations: ChatParticipantRemoveOperation[]): string {
  const handles = operations.map((operation) => chatParticipantReference(operation.handle));
  if (handles.length <= 1) {
    return handles[0] ?? "";
  }
  if (handles.length === 2) {
    return `${handles[0]} and ${handles[1]}`;
  }
  return `${handles.slice(0, -1).join(", ")}, and ${handles[handles.length - 1]}`;
}

export function memberRemovalQuestion(approval: ChatAppToolApproval, request: ChatParticipantRemovalRequest): string {
  return `${chatParticipantReference(approval.requesterHandle)} wants to remove ${handleList(request.operations)} from this chat`;
}

export function memberRemovalOptions(request: ChatParticipantRemovalRequest): {
  key: string;
  label: string;
  approve: boolean;
  scope?: ChatAppToolApprovalScope;
}[] {
  const handles = handleList(request.operations);
  return [
    { key: "remove", label: `Yes, remove ${handles}`, approve: true, scope: "once" },
    { key: "deny", label: `No, keep ${handles} in this chat`, approve: false }
  ];
}

/** What approving does, said once and wrapping (roster rows truncate). */
export function memberRemovalConsequence(approval: ChatAppToolApproval, request: ChatParticipantRemovalRequest): string {
  const one = request.operations.length === 1;
  return `${one ? "Its" : "Their"} session in this chat ends and open requests to or from ${one ? "it" : "them"} are cancelled. ` +
    `This happens once ${chatParticipantReference(approval.requesterHandle)}'s turn has ended and no member is running.`;
}

export function ChatAppToolMemberRemovalOperation(props: {
  approval: ChatAppToolApproval;
  request: ChatParticipantRemovalRequest;
}): JSX.Element {
  return (
    <div className="chat-app-tool-roster-list">
      <div className="chat-app-tool-approval-reason">{memberRemovalConsequence(props.approval, props.request)}</div>
    </div>
  );
}

export function memberRemovalResultSummary(
  approval: ChatAppToolApproval,
  request: ChatParticipantRemovalRequest
): { title: string; detail: string; tone: "done" | "waiting" | "refused" } {
  const handles = handleList(request.operations);
  const stays = request.operations.length === 1 ? "stays" : "stay";
  if (approval.status === "approved" && approval.memberRemovalQueuedAt) {
    return {
      title: "Removal approved",
      detail: `Waiting for running turns to finish, then ${handles} ${request.operations.length === 1 ? "leaves" : "leave"} this chat.`,
      tone: "waiting"
    };
  }
  if (approval.status === "approved" || approval.status === "auto-applied") {
    const applied = approval.appliedParticipantIds;
    const removed = applied ? request.operations.filter((operation) => applied.includes(operation.participantId)) : request.operations;
    const gone = applied ? request.operations.filter((operation) => !applied.includes(operation.participantId)) : [];
    if (removed.length === 0) {
      return { title: "Nothing to remove", detail: `${handles} had already left this chat.`, tone: "done" };
    }
    return {
      title: removed.length === 1 ? "Member removed" : "Members removed",
      detail: `${handleList(removed)} left this chat.${gone.length > 0 ? ` ${handleList(gone)} had already left.` : ""}`,
      tone: "done"
    };
  }
  if (approval.status === "denied" && !approval.error) {
    return { title: "Removal declined", detail: `${handles} ${stays} in this chat.`, tone: "refused" };
  }
  return {
    title: "Removal not applied",
    detail: approval.error ?? `${handles} ${stays} in this chat.`,
    tone: "refused"
  };
}

export function ChatAppToolMemberRemovalResult(props: {
  approval: ChatAppToolApproval;
  request: ChatParticipantRemovalRequest;
}): JSX.Element {
  const summary = memberRemovalResultSummary(props.approval, props.request);
  return (
    <div className={`chat-app-tool-result-card is-${props.approval.status}`} data-member-removal-state={summary.tone}>
      <div className={`chat-app-tool-result-icon ${summary.tone === "refused" ? "is-denied" : ""}`} aria-hidden>
        {summary.tone === "refused" ? <AlertTriangle size={18} /> : summary.tone === "waiting" ? <Clock size={18} /> : <Check size={19} />}
      </div>
      <div className="chat-app-tool-result-copy">
        <strong>{summary.title}</strong>
        <span>{summary.detail}</span>
      </div>
    </div>
  );
}
