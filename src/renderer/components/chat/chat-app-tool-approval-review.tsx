import { AlertTriangle, Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import type {
  ChatAppToolApproval,
  ChatAppToolApprovalScope,
  ChatParticipantChangeRequest,
  ChatParticipantConfig,
  ChatParticipantRequestApprovalRequest,
  ChatPermissionChangeRequest,
  ChatRoleChangeRequest,
  ChatRoleConfig,
  ChatRoleParticipantChangeRequest,
  ChatRosterChangeOperation,
  ChatToolPermissionRequest
} from "../../../shared/types";
import { chatParticipantReference } from "../conversation/conversation-display";

export function roleReviewChipLabel(request: ChatRoleChangeRequest): string {
  if (request.operations.length !== 1) {
    return "Role changes";
  }
  const opType = request.operations[0].type;
  return opType === "create_role" ? "New role" : opType === "archive_role" ? "Deleting role" : "Editing role";
}

export function participantReviewChipLabel(request: ChatParticipantChangeRequest | undefined): string {
  if (!request || request.operations.length !== 1) {
    return "Members";
  }
  return request.operations[0].type === "add_existing_participant_to_chat" ? "Saved member" : "New member";
}

export function reviewPrimaryLabel(
  roleRequest: ChatRoleChangeRequest | undefined,
  participantChange: ChatParticipantChangeRequest | undefined,
  combinedRequest?: ChatRoleParticipantChangeRequest
): string {
  if (combinedRequest) {
    return "Approve all";
  }
  if (roleRequest) {
    if (roleRequest.operations.length !== 1) {
      return "Apply role changes";
    }
    const opType = roleRequest.operations[0].type;
    return opType === "create_role" ? "Create role" : opType === "archive_role" ? "Delete role" : "Save role";
  }
  if (participantChange) {
    if (participantChange.operations.length !== 1) {
      return "Approve all";
    }
    return participantChange.operations[0].type === "add_existing_participant_to_chat" ? "Add to chat" : "Add member";
  }
  return "Approve";
}

export function temporaryRolesForReview(request: ChatRoleChangeRequest): ChatRoleConfig[] {
  const now = new Date().toISOString();
  return request.operations
    .filter((operation): operation is Extract<ChatRoleChangeRequest["operations"][number], { type: "create_role" }> =>
      operation.type === "create_role"
    )
    .map((operation) => ({
      id: operation.role.draftRoleRef ?? operation.role.label,
      label: operation.role.label,
      instructions: operation.role.instructions,
      version: 1,
      builtIn: false,
      appToolCapabilities: operation.role.appToolCapabilities,
      updatedAt: now
    }));
}

export function approvalReason(
  approval: ChatAppToolApproval,
  combinedRequest?: ChatRoleParticipantChangeRequest
): string | undefined {
  if (combinedRequest) {
    return combinedRequest.reason ?? combinedRequest.roleRequest.reason ?? combinedRequest.participantRequest.reason;
  }
  return "reason" in approval.request && typeof approval.request.reason === "string"
    ? approval.request.reason
    : undefined;
}

export function ChatAppToolReviewStatus({ approval }: { approval: ChatAppToolApproval }): JSX.Element {
  const label = approval.status === "approved"
    ? "Approved"
    : approval.status === "denied"
      ? "Cancelled"
      : approval.status === "auto-applied"
        ? "Applied"
        : "Pending";
  return (
    <div className={`chat-app-tool-review-status is-${approval.status}`}>
      {label}{approval.error ? `: ${approval.error}` : ""}
    </div>
  );
}

export function ChatAppToolReviewResult(props: {
  approval: ChatAppToolApproval;
  roleRequest: ChatRoleChangeRequest | undefined;
  participantChange: ChatParticipantChangeRequest | undefined;
  combinedRequest: ChatRoleParticipantChangeRequest | undefined;
  savedParticipants: ChatParticipantConfig[];
}): JSX.Element {
  const summary = reviewResultSummary(props.approval, props.roleRequest, props.participantChange, props.combinedRequest, props.savedParticipants);
  const denied = props.approval.status === "denied";
  return (
    <div className={`chat-app-tool-result-card is-${props.approval.status}`}>
      <div className={`chat-app-tool-result-icon ${denied ? "is-denied" : ""}`} aria-hidden>
        {denied ? <AlertTriangle size={18} /> : <Check size={19} />}
      </div>
      <div className="chat-app-tool-result-copy">
        <strong>{summary.title}</strong>
        <span>{props.approval.error ? `${summary.detail}: ${props.approval.error}` : summary.detail}</span>
      </div>
    </div>
  );
}

function reviewResultSummary(
  approval: ChatAppToolApproval,
  roleRequest: ChatRoleChangeRequest | undefined,
  participantChange: ChatParticipantChangeRequest | undefined,
  combinedRequest: ChatRoleParticipantChangeRequest | undefined,
  savedParticipants: ChatParticipantConfig[]
): { title: string; detail: string } {
  if (approval.status === "denied") {
    return {
      title: "Request cancelled",
      detail: "No role or member changes were made."
    };
  }

  const participantSummary = participantResultSummary(participantChange, savedParticipants);
  const roleSummary = roleResultSummary(roleRequest);

  if (combinedRequest && participantSummary && roleSummary) {
    return {
      title: participantSummary.count === 1 ? "Role and member added" : "Role and members added",
      detail: `${participantSummary.detail} ${roleSummary.detail}`
    };
  }
  if (participantSummary) {
    return {
      title: participantSummary.count === 1 ? "Member added" : "Members added",
      detail: participantSummary.detail
    };
  }
  if (roleSummary) {
    return roleSummary;
  }

  return {
    title: approval.status === "auto-applied" ? "Changes applied" : "Changes approved",
    detail: "The requested change was applied."
  };
}

function participantResultSummary(
  request: ChatParticipantChangeRequest | undefined,
  savedParticipants: ChatParticipantConfig[]
): { count: number; detail: string } | undefined {
  if (!request || request.operations.length === 0) {
    return undefined;
  }
  if (request.operations.length > 1) {
    return {
      count: request.operations.length,
      detail: `${request.operations.length} members joined this chat.`
    };
  }

  const operation = request.operations[0];
  if (operation.type === "add_existing_participant_to_chat") {
    const savedParticipant = savedParticipants.find((participant) => participant.id === operation.participantConfigId);
    const handle = savedParticipant ? chatParticipantReference(savedParticipant.handle) : "The saved member";
    return {
      count: 1,
      detail: `${handle} joined this chat from your saved members.`
    };
  }

  const handle = chatParticipantReference(operation.participant.handle);
  return {
    count: 1,
    detail: operation.saveAsPreset === false
      ? `${handle} joined this chat as a chat-only member.`
      : `${handle} joined this chat and was saved to your presets.`
  };
}

function roleResultSummary(request: ChatRoleChangeRequest | undefined): { title: string; detail: string } | undefined {
  if (!request || request.operations.length === 0) {
    return undefined;
  }
  if (request.operations.length > 1) {
    return {
      title: "Role changes applied",
      detail: `${request.operations.length} role changes were applied.`
    };
  }

  const operation = request.operations[0];
  if (operation.type === "archive_role") {
    return {
      title: "Role deleted",
      detail: "The role was deleted. Existing members keep working under it."
    };
  }
  const roleName = operation.role.label.trim() || "Role";
  if (operation.type === "create_role") {
    return {
      title: "Role created",
      detail: `${roleName} was created.`
    };
  }
  return {
    title: "Role updated",
    detail: `${roleName} was updated.`
  };
}

export function ChatAppToolReviewFooter(props: {
  primaryLabel: string;
  submitting: boolean;
  onCancel: () => void;
  onApprove: () => void;
}): JSX.Element {
  return (
    <div className="chat-app-tool-review-footer">
      <button
        type="button"
        className="chat-app-tool-review-cancel"
        disabled={props.submitting}
        onClick={props.onCancel}
      >
        Cancel
      </button>
      <Button
        type="button"
        variant="default"
        size="sm"
        className="chat-app-tool-review-submit"
        disabled={props.submitting}
        onClick={props.onApprove}
      >
        {props.primaryLabel}
      </Button>
    </div>
  );
}

export function approvalOptions(
  approval: ChatAppToolApproval,
  permissionRequest: ChatPermissionChangeRequest | undefined,
  roleRequest: ChatRoleChangeRequest | undefined,
  participantChange: ChatParticipantChangeRequest | undefined,
  participantRequest: ChatParticipantRequestApprovalRequest | undefined,
  toolPermissionRequest: ChatToolPermissionRequest | undefined,
  added: ChatRosterChangeOperation[],
  inferredParticipantRequest: boolean
): { key: string; label: string; approve: boolean; scope?: ChatAppToolApprovalScope }[] {
  if (roleRequest) {
    return [
      { key: "approve", label: roleRequest.operations.length === 1 ? "Apply role change" : "Apply role changes", approve: true, scope: "chat" },
      { key: "deny", label: `No, tell ${chatParticipantReference(approval.requesterHandle)} what to do differently`, approve: false }
    ];
  }
  if (participantChange) {
    return [
      { key: "approve", label: participantChange.operations.length === 1 ? "Add member" : "Add members", approve: true, scope: "chat" },
      { key: "deny", label: `No, tell ${chatParticipantReference(approval.requesterHandle)} what to do differently`, approve: false }
    ];
  }
  if (added.length > 0 && !permissionRequest && !participantRequest) {
    const target = added.length === 1 ? `@${added[0].participant.handle}` : "these members";
    return [
      { key: "once", label: added.length === 1 ? "Add to this chat" : "Add these members to this chat", approve: true, scope: "once" },
      { key: "chat", label: "Add and remember for this chat", approve: true, scope: "chat" },
      { key: "deny", label: added.length === 1 ? `No, don't add ${target}` : "No, don't add these members", approve: false }
    ];
  }

  const chatOptionLabel = permissionRequest
    ? `Yes, allow ${chatParticipantReference(approval.requesterHandle)} in this chat`
    : toolPermissionRequest
      ? `Yes, allow ${chatParticipantReference(approval.requesterHandle)} to use ${toolPermissionRequest.toolName} in this chat`
    : participantRequest
      ? `Yes, allow ${chatParticipantReference(approval.requesterHandle)} to ask ${participantRequest.requests.length === 1 ? chatParticipantReference(participantRequest.requests[0].target) : "these members"}`
      : "Yes, allow for this chat";
  return [
    { key: "once", label: "Yes, allow once", approve: true, scope: "once" },
    ...(inferredParticipantRequest ? [] : [{ key: "chat", label: chatOptionLabel, approve: true, scope: "chat" as ChatAppToolApprovalScope }]),
    { key: "deny", label: `No, tell ${chatParticipantReference(approval.requesterHandle)} what to do differently`, approve: false }
  ];
}

export function approvalQuestion(
  approval: ChatAppToolApproval,
  permissionRequest: ChatPermissionChangeRequest | undefined,
  roleRequest: ChatRoleChangeRequest | undefined,
  participantChange: ChatParticipantChangeRequest | undefined,
  participantRequest: ChatParticipantRequestApprovalRequest | undefined,
  toolPermissionRequest: ChatToolPermissionRequest | undefined
): string {
  const requester = chatParticipantReference(approval.requesterHandle);
  if (permissionRequest?.kind === "portable") {
    return `Do you want to allow ${requester} ${approval.summary.replace(/^Grant @\S+\s+/, "")}?`;
  }
  if (permissionRequest?.kind === "shellRules") {
    const ruleCount = permissionRequest.rules.length;
    return `Do you want to allow ${requester} to run ${ruleCount === 1 ? "this matching shell command" : "these matching shell commands"}?`;
  }
  if (permissionRequest?.kind === "providerNative") {
    return `Do you want to allow ${requester} to use ${permissionRequest.allowedTools.length === 1 ? "this provider-native tool" : "these provider-native tools"}?`;
  }
  if (permissionRequest?.kind === "githubApp") {
    return `Do you want to allow ${requester} GitHub App access to ${permissionRequest.repository_full_name}?`;
  }
  if (toolPermissionRequest) {
    return `Do you want to allow ${requester} to use ${toolPermissionRequest.toolName}?`;
  }
  if (participantRequest) {
    if (participantRequest.requests.length === 1) {
      return `Do you want to allow ${requester} to ask ${chatParticipantReference(participantRequest.requests[0].target)}?`;
    }
    return `Do you want to allow ${requester} to ask these members?`;
  }
  if (roleRequest) {
    if (roleRequest.operations.length === 1) {
      const opType = roleRequest.operations[0].type;
      const action = opType === "create_role" ? "create a role" : opType === "archive_role" ? "delete a role" : "edit a role";
      return `${requester} wants to ${action}`;
    }
    return `${requester} wants to change roles`;
  }
  if (participantChange) {
    return participantChange.operations.length === 1
      ? `${requester} wants to add a member`
      : `${requester} wants to add members`;
  }
  return `Do you want to allow ${requester} to ${approval.summary.replace(/^Add\s+/, "add ")}?`;
}
