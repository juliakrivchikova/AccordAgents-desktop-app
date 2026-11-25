import type {
  ChatAgentPermissions, ChatAppToolApproval, ChatAppToolApprovalRequest, ChatParticipant, ChatPermissionChangeRequest,
  ChatPermissionGrant, ChatPermissionRequestToolResult, ChatShellPermissionRule, Conversation
} from "../../../../shared/types";
import {
  CHAT_PROVIDER_NATIVE_ALLOWED_TOOL_MAX_LENGTH, CHAT_SHELL_RULE_PATTERN_MAX_LENGTH, effectiveChatAgentPermissionsForProvider,
  isChatShellPermissionPatternSafe, normalizeChatAgentMode, normalizeChatAgentPermissions
} from "../../../../shared/agentPermissions";
import { APP_PERMISSIONS_REQUEST_CHANGE_TOOL } from "../../appMcp";
import {
  chatAppToolApprovals, findReplayablePermissionApproval, isPermissionChangeRequest, newAppToolApproval,
  permissionRequestIdFromRaw, permissionRequestStatusForTool, permissionRequestStatusResult, upsertAppToolApproval
} from "./approvalRecords";
import { CHAT_GITHUB_APP_PERMISSION_MAX_LENGTH, CHAT_GITHUB_APP_PERMISSION_PATTERN, CHAT_GITHUB_APP_REPOSITORY_PATTERN } from "./constants";
import type { PreparedPermissionChange } from "./types";
import { chatParticipants, formatHandleList } from "../members/identity";
import { createChatMessage } from "../store/messages";
import type { ChatAppMcpActor } from "../types";

const CHAT_GITHUB_APP_REPOSITORY_MAX_LENGTH = 200;

export async function applyPermissionChangeRequestFromTool(
  conversation: Conversation,
  requester: ChatParticipant,
  actor: ChatAppMcpActor,
  rawRequest: unknown,
  options: { requestId?: string; remoteRun?: boolean } = {}
): Promise<{ result: ChatPermissionRequestToolResult; mutated: boolean }> {
  const requestId = permissionRequestIdFromRaw(rawRequest);
  if (requestId) {
    return {
      result: permissionRequestStatusForTool(conversation, requester, requestId, actor),
      mutated: false
    };
  }

  const runPermissions = actor.runPermissions ? normalizeChatAgentPermissions(actor.runPermissions) : undefined;
  const prepared = preparePermissionChange(requester, normalizePermissionChangeRequest(rawRequest), runPermissions);
  const requesterMode = normalizeChatAgentMode(requester.agentMode);
  if ((requesterMode === "auto" || requesterMode === "full-access") && prepared.request.kind === "shellRules") {
    // In Auto-review the provider's native auto classifier decides each shell command,
    // so an agent shellRules request needs no User approval and stored app rules are
    // not forwarded as a second hard gate.
    return {
      result: {
        ok: true,
        status: "already_granted",
        summary: "Auto-review handles shell command decisions via the provider's native auto classifier; no shell-rule grant is needed."
      },
      mutated: false
    };
  }
  if (!preparedPermissionChangeHasAdditions(prepared)) {
    return {
      result: {
        ok: true,
        status: "already_granted",
        summary: prepared.summary
      },
      mutated: false
    };
  }

  const existingApproval = findReplayablePermissionApproval(conversation, requester, prepared.request, actor);
  if (existingApproval) {
    return {
      result: permissionRequestStatusResult(existingApproval),
      mutated: false
    };
  }

  const approval = newAppToolApproval(
    conversation,
    requester,
    APP_PERMISSIONS_REQUEST_CHANGE_TOOL,
    "permissions.request",
    prepared.request,
    prepared.summary,
    "pending"
  );
  if (options.requestId) {
    approval.id = options.requestId;
  }
  if (actor.runId && actor.triggerMessageId) {
    approval.resumeContext = {
      runId: actor.runId,
      triggerMessageId: actor.triggerMessageId,
      participantRequestBatchId: actor.participantRequestBatchId,
      remoteRun: options.remoteRun || undefined
    };
  }
  upsertAppToolApproval(conversation, approval);
  conversation.messages.push(createChatMessage("system", `Permission approval needed for @${requester.handle}: ${prepared.summary}.`, undefined, {
    threadId: "system"
  }));
  conversation.updatedAt = new Date().toISOString();
  return {
    result: {
      ok: true,
      status: "pending_user_approval",
      requestId: approval.id,
      approvalId: approval.id,
      summary: prepared.summary,
      request: prepared.request,
      updatedAt: approval.updatedAt
    },
    mutated: true
  };
}

function normalizePermissionChangeRequest(raw: unknown): ChatPermissionChangeRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Permission change request must be an object.");
  }
  const record = raw as Record<string, unknown>;
  if (record.kind === "shellRules") {
    return normalizeShellRulesPermissionChangeRequest(record);
  }
  if (record.kind === "providerNative") {
    return normalizeProviderNativePermissionChangeRequest(record);
  }
  if (record.kind === "githubApp") {
    return normalizeGitHubAppPermissionChangeRequest(record);
  }
  if (record.kind === "portable" || Array.isArray(record.permissions)) {
    return normalizePortablePermissionChangeRequest(record);
  }
  throw new Error("Permission change request has an unsupported kind.");
}

function normalizePortablePermissionChangeRequest(record: Record<string, unknown>): ChatPermissionChangeRequest {
  if (!Array.isArray(record.permissions) || record.permissions.length === 0) {
    throw new Error("Permission change request needs at least one permission.");
  }
  const permissions = new Set<ChatPermissionGrant>();
  for (const permission of record.permissions) {
    if (permission === "workspaceWrite" || permission === "webAccess" || permission === "repoRead") {
      permissions.add(permission);
    } else {
      throw new Error(`Unsupported permission request: ${String(permission)}.`);
    }
  }
  return {
    kind: "portable",
    reason: normalizePermissionChangeReason(record.reason),
    permissions: Array.from(permissions)
  };
}

function normalizeShellRulesPermissionChangeRequest(record: Record<string, unknown>): ChatPermissionChangeRequest {
  if (!Array.isArray(record.rules) || record.rules.length === 0) {
    throw new Error("Shell permission request needs at least one rule.");
  }
  const rules: ChatShellPermissionRule[] = [];
  const seen = new Set<string>();
  for (const item of record.rules) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Shell permission rules must be objects.");
    }
    const candidate = item as Partial<ChatShellPermissionRule>;
    const action = candidate.action === "allow" || candidate.action === "ask" || candidate.action === "deny"
      ? candidate.action
      : undefined;
    const match = candidate.match === "exact" || candidate.match === "prefix"
      ? candidate.match
      : undefined;
    const pattern = typeof candidate.pattern === "string" ? candidate.pattern.trim() : "";
    if (!action || !match || pattern.length > CHAT_SHELL_RULE_PATTERN_MAX_LENGTH || !isChatShellPermissionPatternSafe(pattern)) {
      throw new Error("Shell permission rules need action, match, and a safe command pattern.");
    }
    const key = shellPermissionRuleKey({ action, match, pattern });
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    rules.push({ action, match, pattern });
  }
  if (rules.length === 0) {
    throw new Error("Shell permission request needs at least one unique rule.");
  }
  return {
    kind: "shellRules",
    reason: normalizePermissionChangeReason(record.reason),
    rules
  };
}

function normalizeProviderNativePermissionChangeRequest(record: Record<string, unknown>): ChatPermissionChangeRequest {
  if (record.provider !== "claude-code") {
    throw new Error("Provider-native permission requests currently support only claude-code.");
  }
  if (!Array.isArray(record.allowedTools) || record.allowedTools.length === 0) {
    throw new Error("Provider-native permission request needs at least one allowed tool token.");
  }
  const allowedTools: string[] = [];
  const seen = new Set<string>();
  for (const item of record.allowedTools) {
    if (typeof item !== "string") {
      throw new Error("Provider-native allowed tool tokens must be strings.");
    }
    const token = item.trim();
    if (!token || token.length > CHAT_PROVIDER_NATIVE_ALLOWED_TOOL_MAX_LENGTH) {
      throw new Error("Provider-native allowed tool tokens must be non-empty and reasonably short.");
    }
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    allowedTools.push(token);
  }
  if (allowedTools.length === 0) {
    throw new Error("Provider-native permission request needs at least one unique allowed tool token.");
  }
  return {
    kind: "providerNative",
    reason: normalizePermissionChangeReason(record.reason),
    provider: "claude-code",
    allowedTools
  };
}

function normalizeGitHubAppPermissionChangeRequest(record: Record<string, unknown>): ChatPermissionChangeRequest {
  const repositoryFullName = typeof record.repository_full_name === "string"
    ? record.repository_full_name.trim()
    : typeof record.repositoryFullName === "string"
      ? record.repositoryFullName.trim()
      : "";
  if (
    !repositoryFullName ||
    repositoryFullName.length > CHAT_GITHUB_APP_REPOSITORY_MAX_LENGTH ||
    !CHAT_GITHUB_APP_REPOSITORY_PATTERN.test(repositoryFullName)
  ) {
    throw new Error("GitHub App permission request needs a repository_full_name like owner/repo.");
  }
  if (!Array.isArray(record.permissions) || record.permissions.length === 0) {
    throw new Error("GitHub App permission request needs at least one permission token.");
  }
  const permissions: string[] = [];
  const seen = new Set<string>();
  for (const item of record.permissions) {
    if (typeof item !== "string") {
      throw new Error("GitHub App permission tokens must be strings.");
    }
    const token = item.trim();
    if (
      !token ||
      token.length > CHAT_GITHUB_APP_PERMISSION_MAX_LENGTH ||
      !CHAT_GITHUB_APP_PERMISSION_PATTERN.test(token)
    ) {
      throw new Error("GitHub App permission tokens must be non-empty permission:access strings.");
    }
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    permissions.push(token);
  }
  if (permissions.length === 0) {
    throw new Error("GitHub App permission request needs at least one unique permission token.");
  }
  return {
    kind: "githubApp",
    reason: normalizePermissionChangeReason(record.reason),
    repository_full_name: repositoryFullName,
    permissions
  };
}

export function normalizePermissionChangeReason(reason: unknown): string | undefined {
  return typeof reason === "string" ? reason.trim().slice(0, 500) || undefined : undefined;
}

export function preparePermissionChange(
  requester: ChatParticipant | undefined,
  request: ChatAppToolApprovalRequest,
  currentPermissionsOverride?: ChatAgentPermissions
): PreparedPermissionChange {
  if (!requester) {
    throw new Error("The requesting member is no longer in this chat.");
  }
  if (!isPermissionChangeRequest(request)) {
    throw new Error("Permission approval request is invalid.");
  }
  const normalizedRequest = normalizePermissionChangeRequest(request);
  const mode = normalizeChatAgentMode(requester.agentMode);
  if (mode === "plan" && normalizedRequest.kind === "portable" && normalizedRequest.permissions.includes("workspaceWrite")) {
    throw new Error("Plan mode blocks file edits for this member. Switch the member to default or auto mode before granting edit access.");
  }
  if (mode === "plan" && normalizedRequest.kind === "shellRules") {
    throw new Error("Plan mode blocks shell commands for this member. Switch the member to default or auto mode before granting shell access.");
  }
  if (mode === "plan" && normalizedRequest.kind === "providerNative") {
    throw new Error("Plan mode blocks provider-native tool grants for this member. Switch the member to default or auto mode before granting provider-native access.");
  }
  if (mode === "plan" && normalizedRequest.kind === "githubApp") {
    throw new Error("Plan mode blocks GitHub App permission grants for this member. Switch the member to default or auto mode before granting GitHub write access.");
  }
  // Resolve "already granted" against the effective launch profile, not the raw
  // stored toggles. In Auto-review mode the provider preset already grants web/edit,
  // so an in-preset request must report already_granted instead of producing a
  // spurious auto-applied approval and an unnecessary session relaunch.
  const current = currentPermissionsOverride
    ? normalizeChatAgentPermissions(currentPermissionsOverride)
    : effectiveChatAgentPermissionsForProvider(
        requester.kind,
        mode,
        normalizeChatAgentPermissions(requester.permissions)
      );
  if (normalizedRequest.kind === "portable") {
    const portablePermissions = normalizedRequest.permissions.filter((permission) => !current[permission]);
    const summaryPermissions = portablePermissions.length > 0 ? portablePermissions : normalizedRequest.permissions;
    return {
      request: normalizedRequest,
      portablePermissions,
      shellRules: [],
      providerNativeAllowedTools: [],
      githubAppRequest: false,
      summary: `Grant @${requester.handle} ${formatPermissionGrantList(summaryPermissions)}`
    };
  }
  if (normalizedRequest.kind === "shellRules") {
    for (const rule of normalizedRequest.rules) {
      if (isDeniedShellPermissionRule(rule)) {
        throw new Error(`Shell permission rule is too broad: ${rule.pattern}.`);
      }
    }
    const currentRuleKeys = current.shell.enabled
      ? new Set(current.shell.rules.map((rule) => shellPermissionRuleKey(rule)))
      : new Set<string>();
    const shellRules = normalizedRequest.rules.filter((rule) => !currentRuleKeys.has(shellPermissionRuleKey(rule)));
    const summaryRules = shellRules.length > 0 ? shellRules : normalizedRequest.rules;
    return {
      request: normalizedRequest,
      portablePermissions: [],
      shellRules,
      providerNativeAllowedTools: [],
      githubAppRequest: false,
      summary: `Grant @${requester.handle} ${formatShellPermissionRuleList(summaryRules)}`
    };
  }
  if (normalizedRequest.kind === "githubApp") {
    return {
      request: normalizedRequest,
      portablePermissions: [],
      shellRules: [],
      providerNativeAllowedTools: [],
      githubAppRequest: true,
      summary: `Grant @${requester.handle} ${formatGitHubAppPermissionList(normalizedRequest.repository_full_name, normalizedRequest.permissions)}`
    };
  }
  if (normalizedRequest.provider !== requester.kind) {
    throw new Error("Provider-native Claude grants can only be approved for Claude Code members.");
  }
  for (const token of normalizedRequest.allowedTools) {
    if (isDeniedProviderNativeAllowedTool(token)) {
      throw new Error(`Provider-native allowed tool token is too broad: ${token}.`);
    }
  }
  const currentAllowedTools = new Set(current.providerNative?.["claude-code"]?.allowedTools ?? []);
  const providerNativeAllowedTools = normalizedRequest.allowedTools.filter((token) => !currentAllowedTools.has(token));
  const summaryAllowedTools = providerNativeAllowedTools.length > 0 ? providerNativeAllowedTools : normalizedRequest.allowedTools;
  return {
    request: normalizedRequest,
    portablePermissions: [],
    shellRules: [],
    providerNativeAllowedTools,
    githubAppRequest: false,
    summary: `Grant @${requester.handle} ${formatProviderNativeAllowedToolList(summaryAllowedTools)}`
  };
}

export function applyPreparedPermissionChange(
  conversation: Conversation,
  requesterParticipantId: string,
  prepared: PreparedPermissionChange
): ChatParticipant {
  const participants = chatParticipants(conversation);
  const target = participants.find((participant) => participant.id === requesterParticipantId);
  if (!target) {
    throw new Error("The requesting member is no longer in this chat.");
  }
  const nextPermissions = applyPermissionChangeToPermissions(
    normalizeChatAgentPermissions(target.permissions),
    prepared.request
  );
  const nextParticipant: ChatParticipant = {
    ...target,
    permissions: nextPermissions
  };
  conversation.metadata = {
    ...conversation.metadata,
    participants: participants.map((participant) => participant.id === target.id ? nextParticipant : participant)
  };
  return nextParticipant;
}

export function consumeOneTimePermissionApprovals(
  conversation: Conversation,
  participant: ChatParticipant,
  approvalIds: string[]
): void {
  if (approvalIds.length === 0) {
    return;
  }
  const approvalIdSet = new Set(approvalIds);
  const approvals = chatAppToolApprovals(conversation);
  const now = new Date().toISOString();
  let changed = false;
  const nextApprovals = approvals.map((approval) => {
    if (!approvalIdSet.has(approval.id) || !isUnconsumedOneTimePermissionApproval(approval, participant)) {
      return approval;
    }
    changed = true;
    return {
      ...approval,
      consumedAt: now,
      updatedAt: now
    };
  });
  if (!changed) {
    return;
  }
  conversation.metadata = {
    ...conversation.metadata,
    pendingAppToolApprovals: nextApprovals
  };
}

export function oneTimePermissionApprovalsForParticipant(
  conversation: Conversation,
  participant: ChatParticipant
): ChatAppToolApproval[] {
  return chatAppToolApprovals(conversation).filter((approval) =>
    isUnconsumedOneTimePermissionApproval(approval, participant)
  );
}

function isUnconsumedOneTimePermissionApproval(
  approval: ChatAppToolApproval,
  participant: ChatParticipant
): boolean {
  return (
    approval.status === "approved" &&
    approval.approvalScope === "once" &&
    !approval.consumedAt &&
    approval.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL &&
    approval.capability === "permissions.request" &&
    approval.requesterParticipantId === participant.id &&
    approval.requesterRoleConfigId === participant.roleConfigId &&
    isPermissionChangeRequest(approval.request)
  );
}

function preparedPermissionChangeHasAdditions(prepared: PreparedPermissionChange): boolean {
  return (
    prepared.portablePermissions.length > 0 ||
    prepared.shellRules.length > 0 ||
    prepared.providerNativeAllowedTools.length > 0 ||
    prepared.githubAppRequest
  );
}

export function permissionChangeRequestCovers(existing: ChatPermissionChangeRequest, requested: ChatPermissionChangeRequest): boolean {
  try {
    const normalizedExisting = normalizePermissionChangeRequest(existing);
    const normalizedRequested = normalizePermissionChangeRequest(requested);
    if (normalizedExisting.kind !== normalizedRequested.kind) {
      return false;
    }
    if (normalizedRequested.kind === "portable") {
      return normalizedExisting.kind === "portable" &&
        normalizedRequested.permissions.every((permission) => normalizedExisting.permissions.includes(permission));
    }
    if (normalizedRequested.kind === "shellRules") {
      if (normalizedExisting.kind !== "shellRules") {
        return false;
      }
      const existingRules = new Set(normalizedExisting.rules.map((rule) => shellPermissionRuleKey(rule)));
      return normalizedRequested.rules.every((rule) => existingRules.has(shellPermissionRuleKey(rule)));
    }
    if (normalizedRequested.kind === "githubApp") {
      return normalizedExisting.kind === "githubApp" &&
        normalizedExisting.repository_full_name === normalizedRequested.repository_full_name &&
        normalizedRequested.permissions.every((token) => normalizedExisting.permissions.includes(token));
    }
    return normalizedExisting.kind === "providerNative" &&
      normalizedExisting.provider === normalizedRequested.provider &&
      normalizedRequested.allowedTools.every((token) => normalizedExisting.allowedTools.includes(token));
  } catch {
    return false;
  }
}

export function applyPermissionChangeToPermissions(
  permissions: ChatAgentPermissions,
  request: ChatPermissionChangeRequest
): ChatAgentPermissions {
  const normalizedRequest = normalizePermissionChangeRequest(request);
  if (normalizedRequest.kind === "portable") {
    return {
      ...permissions,
      repoRead: permissions.repoRead || normalizedRequest.permissions.includes("repoRead"),
      workspaceWrite: permissions.workspaceWrite || normalizedRequest.permissions.includes("workspaceWrite"),
      webAccess: permissions.webAccess || normalizedRequest.permissions.includes("webAccess")
    };
  }
  if (normalizedRequest.kind === "shellRules") {
    return {
      ...permissions,
      shell: {
        enabled: true,
        rules: mergeShellPermissionRules(permissions.shell.rules, normalizedRequest.rules)
      }
    };
  }
  if (normalizedRequest.kind === "githubApp") {
    return permissions;
  }
  const allowedTools = mergeProviderNativeAllowedTools(
    permissions.providerNative?.["claude-code"]?.allowedTools ?? [],
    normalizedRequest.allowedTools
  );
  return {
    ...permissions,
    providerNative: {
      ...permissions.providerNative,
      "claude-code": {
        allowedTools
      }
    }
  };
}

function mergeShellPermissionRules(
  existing: ChatShellPermissionRule[],
  additions: ChatShellPermissionRule[]
): ChatShellPermissionRule[] {
  const rules = existing.map((rule) => ({ ...rule }));
  const seen = new Set(rules.map((rule) => shellPermissionRuleKey(rule)));
  for (const rule of additions) {
    const key = shellPermissionRuleKey(rule);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    rules.push({ ...rule });
  }
  return rules;
}

function mergeProviderNativeAllowedTools(existing: string[], additions: string[]): string[] {
  const allowedTools = [...existing];
  const seen = new Set(allowedTools);
  for (const token of additions) {
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    allowedTools.push(token);
  }
  return allowedTools;
}

function shellPermissionRuleKey(rule: ChatShellPermissionRule): string {
  return `${rule.action}\0${rule.match}\0${rule.pattern}`;
}

function isDeniedShellPermissionRule(rule: ChatShellPermissionRule): boolean {
  // Provider-native wildcard tokens such as Bash(*) are rejected before this path;
  // shell rules carry the command pattern only.
  return rule.pattern.trim() === "*";
}

function isDeniedProviderNativeAllowedTool(token: string): boolean {
  const trimmed = token.trim();
  return (
    trimmed === "*" ||
    trimmed === "Bash(*)" ||
    trimmed === "Bash(*:*)" ||
    /^mcp__.+__\*$/.test(trimmed)
  );
}

export function formatPermissionChangeGrantList(request: ChatPermissionChangeRequest): string {
  if (request.kind === "portable") {
    return formatPermissionGrantList(request.permissions);
  }
  if (request.kind === "shellRules") {
    return formatShellPermissionRuleList(request.rules);
  }
  if (request.kind === "githubApp") {
    return formatGitHubAppPermissionList(request.repository_full_name, request.permissions);
  }
  return formatProviderNativeAllowedToolList(request.allowedTools);
}

function formatPermissionGrantList(permissions: ChatPermissionGrant[]): string {
  const labels = permissions.map((permission) => {
    if (permission === "repoRead") {
      return "repository read access";
    }
    return permission === "workspaceWrite" ? "file editing" : "web access";
  });
  return formatHandleList(labels);
}

function formatShellPermissionRuleList(rules: ChatShellPermissionRule[]): string {
  const labels = rules.map((rule) => `shell ${rule.action} ${rule.match} ${JSON.stringify(rule.pattern)}`);
  return formatHandleList(labels);
}

function formatProviderNativeAllowedToolList(allowedTools: string[]): string {
  const labels = allowedTools.map((token) => `Claude native tool ${JSON.stringify(token)}`);
  return formatHandleList(labels);
}

function formatGitHubAppPermissionList(repositoryFullName: string, permissions: string[]): string {
  const labels = permissions.map((permission) => `GitHub App ${JSON.stringify(permission)} on ${repositoryFullName}`);
  return formatHandleList(labels);
}
