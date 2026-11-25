import {
  claudePlanApprovalOption, claudePlanRejectionMessage, claudePlanSetMode, isClaudePlanApprovalRequest
} from "../../../../shared/claudePlanApproval";
import { realpathSync } from "node:fs";
import path from "node:path";
import type {
  ChatAgentMode, ChatAppToolApproval, ChatAppToolApprovalPolicy, ChatParticipant, ChatToolPermissionRequest, Conversation
} from "../../../../shared/types";
import { CHAT_PROVIDER_NATIVE_ALLOWED_TOOL_MAX_LENGTH } from "../../../../shared/agentPermissions";
import { APP_TOOL_PERMISSION_TOOL } from "../../appMcp";
import {
  CHAT_TOOL_PERMISSION_EDIT_TOOLS, chatToolPermissionCoveredByScopes, chatToolPermissionIsScoped, chatToolPermissionScope
} from "../../../../shared/toolPermissionScope";
import { chatAppToolApprovalPolicies, chatAppToolApprovals, isToolPermissionRequest } from "./approvalRecords";
import { normalizePermissionChangeReason } from "./permissionGrants";
import type { PreparedToolPermission, ToolPermissionDecision } from "./types";
import { chatUserDataPath } from "../members/identity";

/** The permission prompt tool's allow: on a plan she approved, with the
 *  mode the CLI moves to, as its own dialog applies it (`setMode` for the
 *  session). */
export function toolPermissionAllowed(toolInput: unknown, decision: ToolPermissionDecision): Record<string, unknown> {
  return {
    behavior: "allow",
    updatedInput: toolInput,
    ...(decision.planMode ? { updatedPermissions: claudePlanSetMode(decision.planMode) } : {})
  };
}

/** Where a member's CLI runs in this chat on this device: the project, or
 *  the chat's own folder. */
export function chatWorkingDirectory(conversation: Conversation): string {
  return conversation.repoPath || path.join(chatUserDataPath(), "chats", conversation.id);
}

/** The member's "for this chat" rule that answers this request, if one
 *  does: one for the whole tool (a tool whose answer is not scoped, or a
 *  rule kept from before answers were scoped, as its card said), else the
 *  scoped rules that together cover it (every command of it by a prefix,
 *  its domain, its folder; src/shared/toolPermissionScope.ts). */
export function toolPermissionPolicyFor(
  conversation: Conversation,
  participant: ChatParticipant,
  toolName: string,
  toolInput: unknown
): ChatAppToolApprovalPolicy | undefined {
  const policies = chatAppToolApprovalPolicies(conversation).filter((policy) =>
    policy.participantId === participant.id &&
    policy.roleConfigId === participant.roleConfigId &&
    policy.toolName === APP_TOOL_PERMISSION_TOOL &&
    policy.capability === "permissions.request" &&
    !policy.targetParticipantId &&
    policy.scope === "chat"
  );
  const whole = policies.find((policy) => policy.targetToolName === toolName && !policy.targetToolScope);
  if (whole || !chatToolPermissionIsScoped(toolName)) {
    return whole;
  }
  const editTool = CHAT_TOOL_PERMISSION_EDIT_TOOLS.includes(toolName);
  const family = editTool ? CHAT_TOOL_PERMISSION_EDIT_TOOLS : [toolName];
  const scoped = policies.filter((policy) => policy.targetToolScope && family.includes(policy.targetToolName ?? ""));
  const scopes = scoped.map((policy) => policy.targetToolScope!);
  if (!chatToolPermissionCoveredByScopes(toolName, toolInput, scopes)) {
    return undefined;
  }
  // A file edit is covered where it really lands too: a link inside the
  // folder that leads out of it is not the folder.
  if (editTool && !chatToolPermissionCoveredByScopes(toolName, withRealEditTarget(toolInput), scopes.map((scope) =>
    scope.kind === "folder" ? { kind: "folder" as const, path: realPathOf(scope.path) } : scope))) {
    return undefined;
  }
  return scoped[0];
}

/** An absolute path with links resolved as far as it exists (the rest, a
 *  file still to be made, kept as written). */
function realPathOf(target: string): string {
  const missing: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(realpathSync.native(current), ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function withRealEditTarget(toolInput: unknown): unknown {
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return toolInput;
  const input = toolInput as Record<string, unknown>;
  const key = ["file_path", "notebook_path", "path"].find((name) => typeof input[name] === "string");
  if (!key || !(input[key] as string).startsWith("/")) return toolInput;
  return { ...input, [key]: realPathOf(input[key] as string) };
}

export function prepareToolPermissionRequest(raw: unknown, agentMode: ChatAgentMode, workingDirectory?: string): PreparedToolPermission {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Tool permission request must be an object.");
  }
  const record = raw as Record<string, unknown>;
  const rawToolName = record.tool_name ?? record.toolName ?? record.name;
  const toolName = typeof rawToolName === "string" ? rawToolName.trim() : "";
  if (!toolName) {
    throw new Error("Tool permission request needs a tool_name.");
  }
  const toolInput = record.input ?? record.tool_input ?? record.toolInput ?? {};
  const reason = normalizePermissionChangeReason(record.reason ?? record.description);
  const rawNativeOccurrenceId = record.tool_use_id ?? record.toolUseId;
  const nativeOccurrenceId = typeof rawNativeOccurrenceId === "string"
    ? rawNativeOccurrenceId.trim().slice(0, 500) || undefined
    : undefined;
  const chatScope = agentMode === "auto" ? undefined : chatToolPermissionScope(toolName, toolInput, workingDirectory);
  const request: ChatToolPermissionRequest = {
    kind: "toolPermission",
    agentMode,
    nativeOccurrenceId,
    reason,
    toolName: toolName.slice(0, CHAT_PROVIDER_NATIVE_ALLOWED_TOOL_MAX_LENGTH),
    toolInput: toolPermissionInputPreview(toolInput),
    ...(chatScope ? { chatScope } : {})
  };
  return {
    request,
    toolInput,
    summary: toolPermissionSummary(request)
  };
}

function toolPermissionInputPreview(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value.length > 2000 ? `${value.slice(0, 2000)}...` : value;
  }
  if (Array.isArray(value)) {
    if (depth >= 4) {
      return "[array omitted]";
    }
    return value.slice(0, 25).map((item) => toolPermissionInputPreview(item, depth + 1));
  }
  if (value && typeof value === "object") {
    if (depth >= 4) {
      return "[object omitted]";
    }
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 50);
    const preview: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      preview[key.slice(0, 120)] = toolPermissionInputPreview(item, depth + 1);
    }
    return preview;
  }
  return undefined;
}

function toolPermissionSummary(request: ChatToolPermissionRequest): string {
  const reason = request.reason ? `: ${request.reason}` : "";
  return `Use ${request.toolName}${reason}`;
}

export function toolPermissionApprovalForOccurrence(
  conversation: Conversation,
  participantId: string,
  runId: string | undefined,
  nativeOccurrenceId: string | undefined
): ChatAppToolApproval | undefined {
  if (!runId || !nativeOccurrenceId) {
    return undefined;
  }
  return chatAppToolApprovals(conversation).find((approval) =>
    approval.requesterParticipantId === participantId &&
    approval.toolName === APP_TOOL_PERMISSION_TOOL &&
    approval.resumeContext?.runId === runId &&
    isToolPermissionRequest(approval.request) &&
    approval.request.nativeOccurrenceId === nativeOccurrenceId
  );
}

export function toolPermissionDecisionForApproval(approval: ChatAppToolApproval): ToolPermissionDecision | undefined {
  const plan = isClaudePlanApprovalRequest(approval.request) ? approval.request.planApproval : undefined;
  if (approval.status === "approved" || approval.status === "auto-applied") {
    const planMode = plan ? claudePlanApprovalOption(plan, approval.planDecision?.optionId)?.mode : undefined;
    return {
      approve: true,
      scope: approval.approvalScope,
      source: approval.status === "auto-applied" ? "policy" : "user",
      ...(planMode ? { planMode } : {})
    };
  }
  if (approval.status === "denied" || approval.status === "cancelled" || approval.status === "expired") {
    return {
      approve: false,
      source: "user",
      reason: approval.error ?? (plan && approval.status === "denied" ? claudePlanRejectionMessage(approval.planDecision?.feedback) : "User denied this tool request.")
    };
  }
  return undefined;
}
