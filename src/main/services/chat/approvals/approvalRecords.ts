import { isClaudePlanApprovalRequest } from "../../../../shared/claudePlanApproval";
import { createHash, randomUUID } from "node:crypto";
import { isHubTurnRunId } from "../../../../shared/hubOps";
import type {
  ChatAppToolApproval, ChatAppToolApprovalPolicy, ChatAppToolApprovalRequest, ChatAppToolCapability, ChatCodexApprovalRequest,
  ChatParticipant, ChatParticipantChangeRequest, ChatParticipantRemovalRequest, ChatParticipantRequestApprovalRequest,
  ChatParticipantRequestInput, ChatPermissionChangeRequest, ChatPermissionRequestToolResult, ChatRoleChangeRequest,
  ChatRoleParticipantChangeRequest, ChatRosterChangeRequest, ChatShellPermissionRule, ChatToolPermissionRequest, Conversation
} from "../../../../shared/types";
import { CODEX_APPROVAL_TOOL_NAME } from "../../codexApprovals";
import { isCodexGuardianDeniedApprovalMethod, isCodexGuardianTimedOutApprovalMethod } from "../../../../shared/codexApproval";
import {
  APP_CHAT_REQUEST_PARTICIPANTS_TOOL, APP_CHAT_REQUEST_COMPACTION_TOOL, APP_CONNECTOR_SIGN_IN_TOOL,
  APP_PERMISSIONS_REQUEST_CHANGE_TOOL, APP_PARTICIPANTS_REQUEST_CHANGE_TOOL, APP_ROLES_REQUEST_CHANGE_TOOL,
  APP_ROSTER_REQUEST_CHANGE_TOOL, APP_TOOL_PERMISSION_TOOL, APP_SCRIPTS_REQUEST_CHANGE_TOOL
} from "../../appMcp";
import { chatToolPermissionScopesEqual, normalizeChatToolPermissionScope } from "../../../../shared/toolPermissionScope";
import { isChatScriptChangeRequest, type ChatScriptChangeRequest } from "../../../../shared/scripts";
import { isConnectorSignInRequest, type McpServerStatus } from "../../../../shared/connectorSignIn";
import { CHAT_GITHUB_APP_PERMISSION_MAX_LENGTH, CHAT_GITHUB_APP_PERMISSION_PATTERN, CHAT_GITHUB_APP_REPOSITORY_PATTERN } from "./constants";
import { permissionChangeRequestCovers } from "./permissionGrants";
import { withoutFencedCode } from "../choices/mentions";
import { isSelfCompactionRequest } from "../compaction/compactionText";
import type { ChatAppMcpActor } from "../types";

/** The run a permission approval resumes its member in. It is a turn of its
 *  own on the User's server: the turn that asked for the permission has ended
 *  there, and a claim of it again is answered "finished", so nothing would
 *  run. Named after the approval, the resume is one turn however often the
 *  approval is read again. Its run here has the same name as its turn on the
 *  server, so every device (the computer stopping a cloud member's turn, the
 *  phone, the member's own device) names it the same way. */
export function permissionApprovalResumeRunId(approvalId: string): string {
  const named = `turn-permission-resume-${approvalId}`;
  return isHubTurnRunId(named)
    ? named
    : `turn-permission-resume-${createHash("sha256").update(approvalId).digest("hex").slice(0, 32)}`;
}

/** Reconnects the server in the member's process, as the CLI's /mcp does
 *  after a sign-in, and says what the CLI reports then. */
export async function reconnectConnectorForMember(
  control: (request: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>,
  serverNow: (name: string) => Promise<McpServerStatus | undefined>,
  connector: string
): Promise<Record<string, unknown>> {
  try {
    const reconnected = await control({ subtype: "mcp_reconnect", serverName: connector });
    if (!reconnected) {
      return { status: "unavailable", connector, message: "This member's Claude Code process ended before the server could be reconnected." };
    }
    const server = await serverNow(connector);
    if (server?.status === "connected") {
      return { status: "connected", connector, message: "Connected. Its tools are available now, in this same reply (find them with ToolSearch)." };
    }
    return {
      status: server?.status ?? "not_found",
      connector,
      message: `The User finished, but Claude Code still reports ${server?.status ?? "no such server"} for ${connector}.`
    };
  } catch (error) {
    return { status: "error", connector, message: `Claude Code could not reconnect ${connector}: ${(error instanceof Error ? error.message : String(error))}` };
  }
}

export function isGuardianDeniedApproval(approval: ChatAppToolApproval): boolean {
  return isCodexApprovalRequest(approval.request) &&
    isCodexGuardianDeniedApprovalMethod(approval.request.method);
}

export function codexApprovalSummary(request: ChatCodexApprovalRequest): string {
  if (isCodexGuardianDeniedApprovalMethod(request.method)) {
    return request.command
      ? `Codex Auto Review denied: ${request.command}`
      : request.networkTarget
        ? `Codex Auto Review denied network access to ${request.networkTarget}.`
        : request.mcpToolName
          ? `Codex Auto Review denied the MCP tool ${request.mcpToolName}.`
          : "Codex Auto Review denied a protected action.";
  }
  if (request.action === "command") {
    return request.command ? `Codex wants to run: ${request.command}` : "Codex wants to run a protected command.";
  }
  if (request.action === "permissions") {
    return "Codex is requesting additional filesystem or network permissions.";
  }
  const count = request.fileChanges?.length ?? 0;
  return count > 0
    ? `Codex wants to apply ${count} protected file ${count === 1 ? "change" : "changes"}.`
    : "Codex wants to apply protected file changes.";
}

export function confirmationRequestWasAsked(content: string): boolean {
  const searchable = withoutFencedCode(content);
  return [
    /\bdo\s+you\s+agree\b/i,
    /\bagree\??\s*$/i,
    /\b(?:can|could|please|pls|kindly|would\s+you)\s+(?:confirm|approve|acknowledge|validate)\b/i,
    /\bconfirm\??\s*$/i,
    /\bconfirm\s+(?:this|that|it|whether|if)\b/i,
    /\bconfirm\s+or\s+(?:correct|add|object)\b/i,
    /\b(?:any|no)\s+objections?\b/i,
    /\breview\b[^.!?\n]{0,80}\b(?:objections?|corrections?|blockers?)\b/i,
    /\bare\s+you\s+(?:ok|okay|aligned|good)\s+with\b/i,
    /\bdoes\s+this\s+(?:look|seem)\s+(?:right|correct|good)\b/i,
    /\bis\s+this\s+(?:right|correct|ok|okay)\b/i,
    /\b(?:sign\s*off|lgtm)\b/i
  ].some((pattern) => pattern.test(searchable));
}

export function isTerminalAppToolApprovalStatus(status: string): boolean {
  return status === "approved" || status === "denied" || status === "cancelled" || status === "expired" || status === "auto-applied";
}

export function permissionRequestIdFromRaw(rawRequest: unknown): string | undefined {
  if (!rawRequest || typeof rawRequest !== "object" || Array.isArray(rawRequest)) {
    return undefined;
  }
  const requestId = (rawRequest as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? requestId.trim() || undefined : undefined;
}

export function permissionRequestStatusForTool(
  conversation: Conversation,
  requester: ChatParticipant,
  requestId: string,
  actor: ChatAppMcpActor
): ChatPermissionRequestToolResult {
  const approval = chatAppToolApprovals(conversation).find((item) =>
    item.id === requestId &&
    item.requesterParticipantId === requester.id &&
    item.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL &&
    isPermissionChangeRequest(item.request) &&
    (!actor.runId || isPermissionRequestOfRun(item, actor.runId))
  );
  if (!approval) {
    return {
      ok: false,
      status: "not_found",
      requestId,
      error: "Permission request was not found for this member run."
    };
  }
  return permissionRequestStatusResult(approval);
}

export function permissionRequestStatusResult(approval: ChatAppToolApproval): ChatPermissionRequestToolResult {
  const status: ChatPermissionRequestToolResult["status"] =
    approval.status === "pending"
      ? "pending_user_approval"
      : approval.status === "approved"
        ? "approved"
        : approval.status === "denied"
          ? "denied"
          : "already_granted";
  return {
    ok: true,
    status,
    requestId: approval.id,
    approvalId: approval.id,
    summary: approval.summary,
    request: isPermissionChangeRequest(approval.request) ? approval.request : undefined,
    approvalScope: approval.approvalScope,
    updatedAt: approval.updatedAt,
    ...(approval.error ? { error: approval.error } : {})
  };
}

/** A member's permission request belongs to the run that asked for it and
 *  to the run its approval resumed the member in: there the member may ask
 *  for it again, or for its status, and gets the answer it already has. */
function isPermissionRequestOfRun(approval: ChatAppToolApproval, runId: string): boolean {
  return approval.resumeContext?.runId === runId || permissionApprovalResumeRunId(approval.id) === runId;
}

export function findReplayablePermissionApproval(
  conversation: Conversation,
  requester: ChatParticipant,
  request: ChatPermissionChangeRequest,
  actor: ChatAppMcpActor
): ChatAppToolApproval | undefined {
  return chatAppToolApprovals(conversation).find((approval) => {
    if (
      approval.toolName !== APP_PERMISSIONS_REQUEST_CHANGE_TOOL ||
      approval.requesterParticipantId !== requester.id ||
      !isPermissionChangeRequest(approval.request)
    ) {
      return false;
    }
    if (actor.runId) {
      if (!isPermissionRequestOfRun(approval, actor.runId)) {
        return false;
      }
    } else if (approval.status !== "pending") {
      return false;
    }
    return (
      permissionChangeRequestCovers(approval.request, request) &&
      permissionChangeRequestCovers(request, approval.request)
    );
  });
}

function hasPendingPermissionApproval(
  conversation: Conversation,
  participant: ChatParticipant,
  request: ChatPermissionChangeRequest
): boolean {
  return chatAppToolApprovals(conversation).some((approval) => {
    if (
      approval.status !== "pending" ||
      approval.toolName !== APP_PERMISSIONS_REQUEST_CHANGE_TOOL ||
      approval.requesterParticipantId !== participant.id ||
      !isPermissionChangeRequest(approval.request)
    ) {
      return false;
    }
    return permissionChangeRequestCovers(approval.request as ChatPermissionChangeRequest, request);
  });
}

export function hasPendingPermissionApprovalForResume(conversation: Conversation, approval: ChatAppToolApproval): boolean {
  const triggerMessageId = approval.resumeContext?.triggerMessageId;
  if (!triggerMessageId) {
    return false;
  }
  return chatAppToolApprovals(conversation).some((item) =>
    item.id !== approval.id &&
    item.status === "pending" &&
    item.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL &&
    item.requesterParticipantId === approval.requesterParticipantId &&
    item.resumeContext?.triggerMessageId === triggerMessageId
  );
}

export function hasPendingPermissionApprovalForParticipantTurn(
  conversation: Conversation,
  participant: ChatParticipant,
  triggerMessageId: string,
  participantRequestBatchId?: string
): boolean {
  return chatAppToolApprovals(conversation).some((approval) =>
    approval.status === "pending" &&
    approval.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL &&
    approval.requesterParticipantId === participant.id &&
    approval.resumeContext?.triggerMessageId === triggerMessageId &&
    (!participantRequestBatchId || approval.resumeContext?.participantRequestBatchId === participantRequestBatchId)
  );
}

export function newAppToolApproval(
  conversation: Conversation,
  requester: ChatParticipant,
  toolName: string,
  capability: ChatAppToolCapability,
  request: ChatAppToolApprovalRequest,
  summary: string,
  status: ChatAppToolApproval["status"]
): ChatAppToolApproval {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    conversationId: conversation.id,
    requesterParticipantId: requester.id,
    requesterHandle: requester.handle,
    requesterRoleConfigId: requester.roleConfigId,
    toolName,
    capability,
    status,
    request,
    summary,
    createdAt: now,
    updatedAt: now
  };
}

export function upsertAppToolApproval(conversation: Conversation, approval: ChatAppToolApproval): void {
  const approvals = chatAppToolApprovals(conversation);
  conversation.metadata = {
    ...conversation.metadata,
    pendingAppToolApprovals: approvals.some((item) => item.id === approval.id)
      ? approvals.map((item) => (item.id === approval.id ? approval : item))
      : [...approvals, approval]
  };
}

function appToolApprovalPolicyMatches(
  policy: ChatAppToolApprovalPolicy,
  participant: ChatParticipant,
  toolName: string,
  capability: ChatAppToolCapability,
  targetParticipantId?: string,
  targetToolName?: string
): boolean {
  return policy.participantId === participant.id &&
    policy.roleConfigId === participant.roleConfigId &&
    policy.toolName === toolName &&
    policy.capability === capability &&
    (targetParticipantId ? policy.targetParticipantId === targetParticipantId : !policy.targetParticipantId) &&
    (targetToolName ? policy.targetToolName === targetToolName : !policy.targetToolName) &&
    policy.scope === "chat";
}

export function matchingAppToolApprovalPolicy(
  conversation: Conversation,
  participant: ChatParticipant,
  toolName: string,
  capability: ChatAppToolCapability,
  targetParticipantId?: string,
  targetToolName?: string
): ChatAppToolApprovalPolicy | undefined {
  return chatAppToolApprovalPolicies(conversation).find((policy) =>
    appToolApprovalPolicyMatches(policy, participant, toolName, capability, targetParticipantId, targetToolName)
  );
}

export function upsertAppToolApprovalPolicy(conversation: Conversation, policy: ChatAppToolApprovalPolicy): void {
  const policies = chatAppToolApprovalPolicies(conversation);
  const existing = policies.find((item) =>
    appToolApprovalPolicyMatches(
      item,
      { id: policy.participantId, roleConfigId: policy.roleConfigId } as ChatParticipant,
      policy.toolName,
      policy.capability,
      policy.targetParticipantId,
      policy.targetToolName
    ) &&
    chatToolPermissionScopesEqual(item.targetToolScope, policy.targetToolScope) &&
    item.scope === policy.scope
  );
  conversation.metadata = {
    ...conversation.metadata,
    appToolApprovalPolicies: existing
      ? policies.map((item) => (item.id === existing.id ? { ...item, updatedAt: policy.updatedAt } : item))
      : [...policies, policy]
  };
}

export function chatAppToolApprovals(conversation: Conversation): ChatAppToolApproval[] {
  const value = conversation.metadata.pendingAppToolApprovals;
  return Array.isArray(value) ? value.filter((item): item is ChatAppToolApproval => isChatAppToolApproval(item)) : [];
}

export function chatAppToolApprovalPolicies(conversation: Conversation): ChatAppToolApprovalPolicy[] {
  const value = conversation.metadata.appToolApprovalPolicies;
  return Array.isArray(value)
    ? value.filter((item): item is ChatAppToolApprovalPolicy => isChatAppToolApprovalPolicy(item))
    : [];
}

export function isChatAppToolApproval(item: unknown): item is ChatAppToolApproval {
  const approval = item as Partial<ChatAppToolApproval>;
  const isRosterApproval =
    approval.toolName === APP_ROSTER_REQUEST_CHANGE_TOOL &&
    approval.capability === "participants.manage" &&
    isRosterChangeRequest(approval.request);
  const isRoleApproval =
    approval.toolName === APP_ROLES_REQUEST_CHANGE_TOOL &&
    approval.capability === "participants.manage" &&
    isRoleChangeRequest(approval.request);
  const isParticipantChangeApproval =
    approval.toolName === APP_PARTICIPANTS_REQUEST_CHANGE_TOOL &&
    approval.capability === "participants.manage" &&
    (
      isParticipantChangeRequest(approval.request) ||
      isRoleParticipantChangeRequest(approval.request) ||
      isParticipantRemovalRequest(approval.request)
    );
  const isPermissionApproval =
    approval.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL &&
    approval.capability === "permissions.request" &&
    isPermissionChangeRequest(approval.request);
  const isToolPermissionApproval =
    approval.toolName === APP_TOOL_PERMISSION_TOOL &&
    approval.capability === "permissions.request" &&
    isToolPermissionRequest(approval.request);
  const isParticipantRequestApproval =
    approval.toolName === APP_CHAT_REQUEST_PARTICIPANTS_TOOL &&
    approval.capability === "participants.request" &&
    isParticipantRequestApprovalRequest(approval.request);
  const isSelfCompactionApproval =
    approval.toolName === APP_CHAT_REQUEST_COMPACTION_TOOL &&
    approval.capability === "compaction.request" &&
    isSelfCompactionRequest(approval.request);
  const isCodexApproval =
    approval.toolName === CODEX_APPROVAL_TOOL_NAME &&
    approval.capability === "permissions.request" &&
    isCodexApprovalRequest(approval.request);
  const isConnectorSignInApproval =
    approval.toolName === APP_CONNECTOR_SIGN_IN_TOOL &&
    approval.capability === "permissions.request" &&
    isConnectorSignInRequest(approval.request);
  const isScriptApproval =
    approval.toolName === APP_SCRIPTS_REQUEST_CHANGE_TOOL &&
    approval.capability === "scripts.request" &&
    isScriptChangeRequest(approval.request);
  return (
    typeof approval.id === "string" &&
    typeof approval.conversationId === "string" &&
    typeof approval.requesterParticipantId === "string" &&
    typeof approval.requesterHandle === "string" &&
    typeof approval.requesterRoleConfigId === "string" &&
    (isRosterApproval || isRoleApproval || isParticipantChangeApproval || isPermissionApproval || isToolPermissionApproval || isParticipantRequestApproval || isSelfCompactionApproval || isCodexApproval || isScriptApproval || isConnectorSignInApproval) &&
    (approval.status === "pending" || approval.status === "approved" || approval.status === "denied" || approval.status === "cancelled" || approval.status === "expired" || approval.status === "auto-applied") &&
    typeof approval.summary === "string" &&
    typeof approval.createdAt === "string" &&
    typeof approval.updatedAt === "string"
  );
}

export function isScriptChangeRequest(request: unknown): request is ChatScriptChangeRequest {
  return isChatScriptChangeRequest(request);
}

export function isCodexApprovalRequest(request: unknown): request is ChatCodexApprovalRequest {
  const candidate = request as Partial<ChatCodexApprovalRequest>;
  const method = candidate.method;
  return Boolean(
    request &&
    typeof request === "object" &&
    !Array.isArray(request) &&
    candidate.kind === "codexApproval" &&
    (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval" ||
      method === "item/permissions/requestApproval" ||
      isCodexGuardianDeniedApprovalMethod(method) ||
      isCodexGuardianTimedOutApprovalMethod(method) ||
      method === "applyPatchApproval" ||
      method === "execCommandApproval"
    ) &&
    (typeof candidate.requestId === "string" || typeof candidate.requestId === "number") &&
    (
      candidate.action === "command" ||
      candidate.action === "fileChange" ||
      candidate.action === "permissions" ||
      candidate.action === "network" ||
      candidate.action === "mcpToolCall"
    ) &&
    Array.isArray(candidate.options) &&
    (isCodexGuardianTimedOutApprovalMethod(method) ? candidate.options.length === 0 : candidate.options.length > 0) &&
    candidate.options.every((option) =>
      typeof option?.id === "string" &&
      typeof option.label === "string" &&
      (option.detail === undefined || typeof option.detail === "string") &&
      (option.outcome === "approve" || option.outcome === "deny" || option.outcome === "cancel")
    )
  );
}

export function isRosterChangeRequest(request: unknown): request is ChatRosterChangeRequest {
  return Boolean(
    request &&
    typeof request === "object" &&
    !Array.isArray(request) &&
    Array.isArray((request as Partial<ChatRosterChangeRequest>).operations)
  );
}

export function isRoleChangeRequest(request: unknown): request is ChatRoleChangeRequest {
  return Boolean(
    request &&
    typeof request === "object" &&
    !Array.isArray(request) &&
    Array.isArray((request as Partial<ChatRoleChangeRequest>).operations) &&
    (request as Partial<ChatRoleChangeRequest>).operations?.every((operation) =>
      operation?.type === "create_role" || operation?.type === "edit_role" || operation?.type === "archive_role"
    )
  );
}

export function isParticipantChangeRequest(request: unknown): request is ChatParticipantChangeRequest {
  return Boolean(
    request &&
    typeof request === "object" &&
    !Array.isArray(request) &&
    Array.isArray((request as Partial<ChatParticipantChangeRequest>).operations) &&
    (request as Partial<ChatParticipantChangeRequest>).operations?.every((operation) =>
      operation?.type === "add_new_participant_to_chat" || operation?.type === "add_existing_participant_to_chat"
    )
  );
}

export function isParticipantRemovalRequest(request: unknown): request is ChatParticipantRemovalRequest {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return false;
  }
  const record = request as Partial<ChatParticipantRemovalRequest>;
  return record.kind === "participant_removal" &&
    Array.isArray(record.operations) &&
    record.operations.length > 0 &&
    record.operations.every((operation) =>
      operation?.type === "remove_participant_from_chat" &&
      typeof operation.participantId === "string" &&
      typeof operation.handle === "string"
    );
}

export function isRoleParticipantChangeRequest(request: unknown): request is ChatRoleParticipantChangeRequest {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return false;
  }
  const record = request as Partial<ChatRoleParticipantChangeRequest>;
  return record.kind === "role_participant_change" &&
    isRoleChangeRequest(record.roleRequest) &&
    isParticipantChangeRequest(record.participantRequest);
}

export function isPermissionChangeRequest(request: unknown): request is ChatPermissionChangeRequest {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return false;
  }
  const record = request as Record<string, unknown>;
  if (record.kind === "shellRules") {
    const rules = record.rules;
    return Array.isArray(rules) && rules.length > 0 && rules.every((item) =>
      Boolean(
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        ((item as Partial<ChatShellPermissionRule>).action === "allow" ||
          (item as Partial<ChatShellPermissionRule>).action === "ask" ||
          (item as Partial<ChatShellPermissionRule>).action === "deny") &&
        ((item as Partial<ChatShellPermissionRule>).match === "exact" ||
          (item as Partial<ChatShellPermissionRule>).match === "prefix") &&
        typeof (item as Partial<ChatShellPermissionRule>).pattern === "string"
      )
    );
  }
  if (record.kind === "providerNative") {
    return record.provider === "claude-code" &&
      Array.isArray(record.allowedTools) &&
      record.allowedTools.length > 0 &&
      record.allowedTools.every((token) => typeof token === "string");
  }
  if (record.kind === "githubApp") {
    const repositoryFullName = record.repository_full_name;
    const permissions = record.permissions;
    return typeof repositoryFullName === "string" &&
      CHAT_GITHUB_APP_REPOSITORY_PATTERN.test(repositoryFullName.trim()) &&
      Array.isArray(permissions) &&
      permissions.length > 0 &&
      permissions.every((token) =>
        typeof token === "string" &&
        token.trim().length > 0 &&
        token.trim().length <= CHAT_GITHUB_APP_PERMISSION_MAX_LENGTH &&
        CHAT_GITHUB_APP_PERMISSION_PATTERN.test(token.trim())
      );
  }
  const permissions = record.permissions;
  return (record.kind === "portable" || record.kind === undefined) &&
    Array.isArray(permissions) &&
    permissions.length > 0 &&
    permissions.every((permission) => permission === "workspaceWrite" || permission === "webAccess" || permission === "repoRead");
}

export function isToolPermissionRequest(request: unknown): request is ChatToolPermissionRequest {
  return Boolean(
    request &&
    typeof request === "object" &&
    !Array.isArray(request) &&
    (request as Partial<ChatToolPermissionRequest>).kind === "toolPermission" &&
    typeof (request as Partial<ChatToolPermissionRequest>).toolName === "string"
  );
}

export function isParticipantRequestApprovalRequest(request: unknown): request is ChatParticipantRequestApprovalRequest {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return false;
  }
  const requests = (request as Partial<ChatParticipantRequestApprovalRequest>).requests;
  return Array.isArray(requests) && requests.every((item) =>
    Boolean(
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      typeof (item as Partial<ChatParticipantRequestInput>).target === "string" &&
      typeof (item as Partial<ChatParticipantRequestInput>).prompt === "string"
    )
  );
}

function isChatAppToolApprovalPolicy(item: unknown): item is ChatAppToolApprovalPolicy {
  const policy = item as Partial<ChatAppToolApprovalPolicy>;
  return (
    typeof policy.id === "string" &&
    typeof policy.participantId === "string" &&
    typeof policy.roleConfigId === "string" &&
    ((
      policy.toolName === APP_ROSTER_REQUEST_CHANGE_TOOL &&
      policy.capability === "participants.manage" &&
      typeof policy.targetParticipantId !== "string" &&
      typeof policy.targetToolName !== "string"
    ) || (
      policy.toolName === APP_TOOL_PERMISSION_TOOL &&
      policy.capability === "permissions.request" &&
      typeof policy.targetParticipantId !== "string" &&
      typeof policy.targetToolName === "string" &&
      (policy.targetToolScope === undefined || (normalizeChatToolPermissionScope(policy.targetToolScope) !== undefined &&
        chatToolPermissionScopesEqual(normalizeChatToolPermissionScope(policy.targetToolScope), policy.targetToolScope)))
    )) &&
    policy.scope === "chat" &&
    typeof policy.createdAt === "string" &&
    typeof policy.updatedAt === "string"
  );
}

/** A plan approval no longer asking (answered, expired, closed with its
 *  turn) keeps only what it asked and what she picked: the plan itself
 *  stays in the CLI's session, so plans do not pile up in the chat. */
export function withoutAnsweredPlans(conversation: Conversation): void {
  const approvals = conversation.metadata?.pendingAppToolApprovals;
  const answered = (approval: ChatAppToolApproval): boolean => approval.status !== "pending" &&
    isClaudePlanApprovalRequest(approval.request) && approval.request.planApproval.plan !== undefined;
  if (!Array.isArray(approvals) || !approvals.some(answered)) return;
  conversation.metadata = {
    ...conversation.metadata,
    pendingAppToolApprovals: approvals.map((approval) => {
      if (!answered(approval) || !isClaudePlanApprovalRequest(approval.request)) return approval;
      const { plan: _plan, ...asked } = approval.request.planApproval;
      return { ...approval, request: { ...approval.request, planApproval: asked } };
    })
  };
}
