import type {
  ChatAppToolApproval,
  ChatParticipantChangeRequest,
  ChatParticipantRequestApprovalRequest,
  ChatParticipantRequestBatch,
  ChatPermissionChangeRequest,
  ChatPermissionGrant,
  ChatRoleChangeRequest,
  ChatRoleParticipantChangeRequest,
  ChatSelfCompactionRequest,
  ChatShellPermissionRule,
  ChatToolPermissionRequest,
  Conversation
} from "../../../shared/types";
import { chatParticipantReference } from "../conversation/conversation-display";

export const APP_PERMISSIONS_REQUEST_CHANGE_TOOL = "app_permissions_request_change";
export const APP_TOOL_PERMISSION_TOOL = "app_tool_permission";
export const APP_ROSTER_REQUEST_CHANGE_TOOL = "app_roster_request_change";
export const APP_ROLES_REQUEST_CHANGE_TOOL = "app_roles_request_change";
export const APP_PARTICIPANTS_REQUEST_CHANGE_TOOL = "app_participants_request_change";
export const APP_CHAT_REQUEST_PARTICIPANTS_TOOL = "app_chat_request_participants";
export const APP_CHAT_REQUEST_COMPACTION_TOOL = "app_chat_request_compaction";
export const CHAT_CUSTOM_CHOICE_OPTION_ID = "__custom__";

export function chatAppToolApprovals(conversation: Conversation | undefined): ChatAppToolApproval[] {
  const value = conversation?.metadata.pendingAppToolApprovals;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is ChatAppToolApproval => {
    const approval = item as Partial<ChatAppToolApproval>;
    const request = approval.request;
    const isRosterRequest =
      approval.toolName === APP_ROSTER_REQUEST_CHANGE_TOOL &&
      request &&
      typeof request === "object" &&
      !Array.isArray(request) &&
      Array.isArray((request as { operations?: unknown }).operations);
    const isPermissionRequest =
      approval.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL &&
      Boolean(chatPermissionChangeRequest(approval as ChatAppToolApproval));
    const isToolPermissionRequest =
      approval.toolName === APP_TOOL_PERMISSION_TOOL &&
      Boolean(chatToolPermissionRequest(approval as ChatAppToolApproval));
    const isRoleRequest =
      approval.toolName === APP_ROLES_REQUEST_CHANGE_TOOL &&
      Boolean(chatRoleChangeRequest(approval as ChatAppToolApproval));
    const isParticipantChangeRequest =
      approval.toolName === APP_PARTICIPANTS_REQUEST_CHANGE_TOOL &&
      (Boolean(chatParticipantChangeRequest(approval as ChatAppToolApproval)) ||
        Boolean(chatRoleParticipantChangeRequest(approval as ChatAppToolApproval)));
    const isParticipantRequest =
      approval.toolName === APP_CHAT_REQUEST_PARTICIPANTS_TOOL &&
      Boolean(chatParticipantRequestApprovalRequest(approval as ChatAppToolApproval));
    const isSelfCompactionRequest =
      approval.toolName === APP_CHAT_REQUEST_COMPACTION_TOOL &&
      Boolean(chatSelfCompactionRequest(approval as ChatAppToolApproval));
    return (
      typeof approval.id === "string" &&
      typeof approval.requesterHandle === "string" &&
      typeof approval.summary === "string" &&
      (approval.status === "pending" || approval.status === "approved" || approval.status === "denied" || approval.status === "auto-applied") &&
      (isRosterRequest || isRoleRequest || isParticipantChangeRequest || isPermissionRequest || isToolPermissionRequest || isParticipantRequest || isSelfCompactionRequest)
    );
  });
}

export function chatSelfCompactionRequest(approval: ChatAppToolApproval): ChatSelfCompactionRequest | undefined {
  if (approval.toolName !== APP_CHAT_REQUEST_COMPACTION_TOOL) {
    return undefined;
  }
  const request = approval.request as Partial<ChatSelfCompactionRequest>;
  return request.type === "self_compaction" &&
    (request.instructions === undefined || typeof request.instructions === "string")
    ? {
        type: "self_compaction",
        instructions: request.instructions?.trim() || undefined
      }
    : undefined;
}

export function chatRoleChangeRequest(approval: ChatAppToolApproval): ChatRoleChangeRequest | undefined {
  if (approval.toolName !== APP_ROLES_REQUEST_CHANGE_TOOL) {
    return undefined;
  }
  const request = approval.request as Partial<ChatRoleChangeRequest>;
  return Array.isArray(request.operations) &&
    request.operations.every((operation) =>
      operation?.type === "create_role" || operation?.type === "edit_role" || operation?.type === "archive_role"
    )
    ? {
        reason: typeof request.reason === "string" ? request.reason : undefined,
        operations: request.operations
      }
    : undefined;
}

export function chatParticipantChangeRequest(approval: ChatAppToolApproval): ChatParticipantChangeRequest | undefined {
  if (approval.toolName !== APP_PARTICIPANTS_REQUEST_CHANGE_TOOL) {
    return undefined;
  }
  if ((approval.request as Partial<ChatRoleParticipantChangeRequest>).kind === "role_participant_change") {
    return undefined;
  }
  const request = approval.request as Partial<ChatParticipantChangeRequest>;
  return Array.isArray(request.operations) &&
    request.operations.every((operation) =>
      operation?.type === "add_new_participant_to_chat" || operation?.type === "add_existing_participant_to_chat"
    )
    ? {
        reason: typeof request.reason === "string" ? request.reason : undefined,
        operations: request.operations
      }
    : undefined;
}

export function chatRoleParticipantChangeRequest(approval: ChatAppToolApproval): ChatRoleParticipantChangeRequest | undefined {
  if (approval.toolName !== APP_PARTICIPANTS_REQUEST_CHANGE_TOOL) {
    return undefined;
  }
  const request = approval.request as Partial<ChatRoleParticipantChangeRequest>;
  const roleRequest = request.roleRequest as Partial<ChatRoleChangeRequest> | undefined;
  const participantRequest = request.participantRequest as Partial<ChatParticipantChangeRequest> | undefined;
  return request.kind === "role_participant_change" &&
    Array.isArray(roleRequest?.operations) &&
    roleRequest.operations.every((operation) => operation?.type === "create_role" || operation?.type === "edit_role") &&
    Array.isArray(participantRequest?.operations) &&
    participantRequest.operations.every((operation) =>
      operation?.type === "add_new_participant_to_chat" || operation?.type === "add_existing_participant_to_chat"
    )
    ? {
        kind: "role_participant_change",
        reason: typeof request.reason === "string" ? request.reason : undefined,
        roleRequest: {
          reason: typeof roleRequest.reason === "string" ? roleRequest.reason : undefined,
          operations: roleRequest.operations
        },
        participantRequest: {
          reason: typeof participantRequest.reason === "string" ? participantRequest.reason : undefined,
          operations: participantRequest.operations
        }
      }
    : undefined;
}

export function chatParticipantRequestApprovalRequest(approval: ChatAppToolApproval): ChatParticipantRequestApprovalRequest | undefined {
  if (approval.toolName !== APP_CHAT_REQUEST_PARTICIPANTS_TOOL) {
    return undefined;
  }
  const request = approval.request as Partial<ChatParticipantRequestApprovalRequest>;
  return Array.isArray(request.requests) &&
    request.requests.every((item) => (
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      typeof (item as { target?: unknown }).target === "string" &&
      typeof (item as { prompt?: unknown }).prompt === "string"
    ))
    ? {
        reason: typeof request.reason === "string" ? request.reason : undefined,
        requests: request.requests,
        resumeRequester: request.resumeRequester,
        source: request.source,
        requestMessageId: request.requestMessageId,
        batchId: request.batchId
      }
    : undefined;
}

export function chatPermissionChangeRequest(approval: ChatAppToolApproval): ChatPermissionChangeRequest | undefined {
  if (approval.toolName !== APP_PERMISSIONS_REQUEST_CHANGE_TOOL) {
    return undefined;
  }
  const request = approval.request as unknown as Record<string, unknown>;
  const reason = typeof request.reason === "string" ? request.reason : undefined;
  if ((request.kind === "portable" || request.kind === undefined) && Array.isArray(request.permissions)) {
    const permissions = request.permissions.filter((permission): permission is ChatPermissionGrant =>
      permission === "workspaceWrite" || permission === "webAccess" || permission === "repoRead"
    );
    return permissions.length === request.permissions.length && permissions.length > 0
      ? { kind: "portable", reason, permissions }
      : undefined;
  }
  if (request.kind === "shellRules" && Array.isArray(request.rules)) {
    const rules = request.rules.flatMap((item): ChatShellPermissionRule[] => {
      const rule = item as Partial<ChatShellPermissionRule>;
      if (
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        (rule.action !== "allow" && rule.action !== "ask" && rule.action !== "deny") ||
        (rule.match !== "exact" && rule.match !== "prefix") ||
        typeof rule.pattern !== "string"
      ) {
        return [];
      }
      const pattern = rule.pattern.trim();
      return pattern ? [{ action: rule.action, match: rule.match, pattern }] : [];
    });
    return rules.length === request.rules.length && rules.length > 0
      ? { kind: "shellRules", reason, rules }
      : undefined;
  }
  if (request.kind === "providerNative" && request.provider === "claude-code" && Array.isArray(request.allowedTools)) {
    const allowedTools = request.allowedTools
      .map((token) => (typeof token === "string" ? token.trim() : ""))
      .filter((token) => token.length > 0);
    return allowedTools.length === request.allowedTools.length && allowedTools.length > 0
      ? { kind: "providerNative", reason, provider: "claude-code", allowedTools }
      : undefined;
  }
  if (request.kind === "githubApp" && Array.isArray(request.permissions)) {
    const repositoryFullName = typeof request.repository_full_name === "string" ? request.repository_full_name.trim() : "";
    const permissions = request.permissions
      .map((token) => (typeof token === "string" ? token.trim() : ""))
      .filter((token) => token.length > 0);
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryFullName) &&
      permissions.length === request.permissions.length &&
      permissions.length > 0
      ? { kind: "githubApp", reason, repository_full_name: repositoryFullName, permissions }
      : undefined;
  }
  return undefined;
}

export function chatToolPermissionRequest(approval: ChatAppToolApproval): ChatToolPermissionRequest | undefined {
  if (approval.toolName !== APP_TOOL_PERMISSION_TOOL) {
    return undefined;
  }
  const request = approval.request as Partial<ChatToolPermissionRequest>;
  const toolName = typeof request.toolName === "string" ? request.toolName.trim() : "";
  if (request.kind !== "toolPermission" || !toolName) {
    return undefined;
  }
  return {
    kind: "toolPermission",
    reason: typeof request.reason === "string" ? request.reason : undefined,
    toolName,
    toolInput: request.toolInput
  };
}

export function chatPermissionGrantLabel(permission: ChatPermissionGrant): string {
  if (permission === "repoRead") {
    return "Repository read";
  }
  return permission === "workspaceWrite" ? "File editing" : "Web access";
}

export function chatPermissionGrantDescription(permission: ChatPermissionGrant): string {
  if (permission === "repoRead") {
    return "Allow read-only inspection of files in the selected repository.";
  }
  return permission === "workspaceWrite"
    ? "Allow file edits in the selected repository."
    : "Allow web search and fetch when the CLI supports it.";
}

export function participantRequestStatusLabel(batch: ChatParticipantRequestBatch): string {
  const targets = batch.items.map((item) => chatParticipantReference(item.targetHandle)).join(", ");
  if (batch.status === "pending_approval") {
    return `Approval needed for ${targets}`;
  }
  if (batch.status === "running") {
    return `Running ${targets}`;
  }
  if (batch.status === "answered") {
    return `Answered by ${targets}`;
  }
  if (batch.status === "resuming_requester") {
    return `Returning to ${chatParticipantReference(batch.requesterHandle)}`;
  }
  if (batch.status === "completed") {
    return "Completed";
  }
  if (batch.status === "denied") {
    return "Denied";
  }
  if (batch.status === "failed") {
    return "Failed";
  }
  return "Interrupted";
}
