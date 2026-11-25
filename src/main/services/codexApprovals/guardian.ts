import type { ChatCodexApprovalOption, ChatCodexApprovalRequest } from "../../../shared/types";
import { CODEX_GUARDIAN_DENIED_APPROVAL_METHOD, CODEX_GUARDIAN_TIMED_OUT_APPROVAL_METHOD } from "../../../shared/codexApproval";
import { MAX_DISPLAY_PATH, MAX_DISPLAY_TEXT } from "./constants";
import { displayArgv, displayString, displayStringArray, permissionSummary } from "./display";
import {
  assertOnlyKeys, optionalNullableString, record, requiredNullableString, requiredNumber, requiredRecord, requiredString,
  requiredStringArray, requiredStringValue
} from "./fields";
import { prepared } from "./preparedApproval";
import type { PreparedCodexApproval } from "./types";
import { validatePermissionProfile } from "./validation";

/**
 * Rebuild the core GuardianAssessmentEvent consumed by
 * thread/approveGuardianDeniedAction. The app-server notification is a v2
 * camelCase transport object, while the core event is a snake_case, internally
 * tagged protocol value. Keep this conversion explicit so provider schema
 * changes fail closed instead of being sent back as a plausible-looking but
 * ignored object.
 */
export function codexGuardianAssessmentEvent(value: unknown): Record<string, unknown> {
  const params = requiredRecord(value, "Guardian review notification");
  const review = requiredRecord(params.review, "review");
  const action = requiredRecord(params.action, "action");
  const id = requiredString(params.reviewId, "reviewId");
  const turnId = requiredString(params.turnId, "turnId");
  const startedAtMs = requiredNumber(params.startedAtMs, "startedAtMs");
  const completedAtMs = requiredNumber(params.completedAtMs, "completedAtMs");
  const status = guardianStatus(requiredString(review.status, "review.status"));
  const decisionSource = guardianDecisionSource(requiredString(params.decisionSource, "decisionSource"));
  const targetItemId = requiredNullableString(params.targetItemId, "targetItemId");
  const riskLevel = optionalGuardianRiskLevel(review.riskLevel);
  const userAuthorization = optionalGuardianUserAuthorization(review.userAuthorization);
  const rationale = optionalNullableString(review.rationale, "review.rationale");
  const serializedAction = guardianSerializedAction(action);
  return {
    type: "guardian_assessment",
    id,
    target_item_id: targetItemId,
    turn_id: turnId,
    started_at_ms: startedAtMs,
    completed_at_ms: completedAtMs,
    status,
    ...(riskLevel !== undefined ? { risk_level: riskLevel } : {}),
    ...(userAuthorization !== undefined ? { user_authorization: userAuthorization } : {}),
    ...(rationale !== undefined && rationale !== null ? { rationale } : {}),
    decision_source: decisionSource,
    action: serializedAction
  };
}

export function prepareGuardianDeniedApproval(requestId: string | number, value: unknown): PreparedCodexApproval {
  const params = record(value);
  const review = record(params?.review);
  const action = record(params?.action);
  if (!params || !review || !action || review.status !== "denied") {
    throw new Error("Guardian approval can only be offered for a completed denied review.");
  }
  // Constructing the exact event here is a validation gate. The returned chat
  // request deliberately contains only a bounded projection; the event itself
  // remains connection-local in CliAgentRunner.
  codexGuardianAssessmentEvent(params);
  const responses: Array<{ option: ChatCodexApprovalOption; response: unknown }> = [
    {
      option: { id: "approveRetry", label: "Approve one retry", outcome: "approve" },
      response: { decision: "approveRetry" }
    },
    {
      option: { id: "keepDenied", label: "Keep denied", outcome: "deny" },
      response: { decision: "keepDenied" }
    }
  ];
  const base = guardianDisplayRequest(requestId, CODEX_GUARDIAN_DENIED_APPROVAL_METHOD, params, review, action, responses);
  return prepared(base, responses);
}

function guardianDisplayRequest(
  requestId: string | number,
  method: typeof CODEX_GUARDIAN_DENIED_APPROVAL_METHOD | typeof CODEX_GUARDIAN_TIMED_OUT_APPROVAL_METHOD,
  params: Record<string, unknown>,
  review: Record<string, unknown>,
  action: Record<string, unknown>,
  responses: Array<{ option: ChatCodexApprovalOption; response: unknown }>
): ChatCodexApprovalRequest {
  const actionType = displayString(action.type, 80);
  const base: ChatCodexApprovalRequest = {
    kind: "codexApproval",
    method,
    requestId,
    threadId: displayString(params.threadId, MAX_DISPLAY_PATH),
    turnId: displayString(params.turnId, MAX_DISPLAY_PATH),
    itemId: displayString(params.targetItemId, MAX_DISPLAY_PATH),
    approvalId: displayString(params.reviewId, MAX_DISPLAY_PATH),
    action: guardianDisplayAction(actionType),
    reason: displayString(review.rationale, MAX_DISPLAY_TEXT),
    guardianRiskLevel: displayString(review.riskLevel, 40),
    guardianUserAuthorization: displayString(review.userAuthorization, 40),
    guardianDecisionSource: displayString(params.decisionSource, 40),
    options: responses.map((item) => item.option)
  };
  if (actionType === "command") {
    base.command = displayString(action.command, MAX_DISPLAY_TEXT);
    base.cwd = displayString(action.cwd, MAX_DISPLAY_PATH);
  } else if (actionType === "execve") {
    base.command = displayArgv(action.argv) ?? displayString(action.program, MAX_DISPLAY_TEXT);
    base.cwd = displayString(action.cwd, MAX_DISPLAY_PATH);
  } else if (actionType === "applyPatch") {
    base.cwd = displayString(action.cwd, MAX_DISPLAY_PATH);
    const files = displayStringArray(action.files).map((path) => ({ path, change: "update" as const }));
    base.fileChanges = files.length > 0 ? files : undefined;
  } else if (actionType === "networkAccess") {
    base.networkTarget = displayString(action.target, MAX_DISPLAY_TEXT);
    base.networkProtocol = displayString(action.protocol, 40);
  } else if (actionType === "mcpToolCall") {
    base.mcpServer = displayString(action.connectorName, MAX_DISPLAY_TEXT) ?? displayString(action.server, MAX_DISPLAY_TEXT);
    base.mcpToolName = displayString(action.toolTitle, MAX_DISPLAY_TEXT) ?? displayString(action.toolName, MAX_DISPLAY_TEXT);
  } else if (actionType === "requestPermissions") {
    base.reason = displayString(action.reason, MAX_DISPLAY_TEXT) ?? base.reason;
    base.permissions = permissionSummary(action.permissions);
  }
  return base;
}

export function prepareGuardianTimedOutApproval(requestId: string | number, value: unknown): PreparedCodexApproval {
  const params = requiredRecord(value, "Guardian review notification");
  const review = requiredRecord(params.review, "review");
  const action = requiredRecord(params.action, "action");
  if (review.status !== "timedOut") {
    throw new Error("Guardian timeout projection requires a completed timed-out review.");
  }
  requiredString(params.threadId, "threadId");
  requiredString(params.turnId, "turnId");
  requiredNumber(params.startedAtMs, "startedAtMs");
  requiredNumber(params.completedAtMs, "completedAtMs");
  requiredString(params.reviewId, "reviewId");
  requiredNullableString(params.targetItemId, "targetItemId");
  guardianDecisionSource(requiredString(params.decisionSource, "decisionSource"));
  guardianSerializedAction(action);
  const request = guardianDisplayRequest(requestId, CODEX_GUARDIAN_TIMED_OUT_APPROVAL_METHOD, params, review, action, []);
  return prepared(request, []);
}

function guardianDisplayAction(type: string | undefined): ChatCodexApprovalRequest["action"] {
  if (type === "command" || type === "execve") return "command";
  if (type === "applyPatch") return "fileChange";
  if (type === "networkAccess") return "network";
  if (type === "mcpToolCall") return "mcpToolCall";
  if (type === "requestPermissions") return "permissions";
  throw new Error(`Unsupported Guardian action type: ${type ?? "missing"}`);
}

function guardianStatus(value: string): string {
  if (value === "inProgress") return "in_progress";
  if (value === "timedOut") return "timed_out";
  if (value === "approved" || value === "denied" || value === "aborted") return value;
  throw new Error(`Unsupported Guardian review status: ${value}`);
}

function guardianDecisionSource(value: string): string {
  if (value === "agent") return value;
  throw new Error(`Unsupported Guardian decision source: ${value}`);
}

function guardianSerializedAction(action: Record<string, unknown>): Record<string, unknown> {
  const type = requiredString(action.type, "action.type");
  if (type === "command") {
    assertOnlyKeys(action, ["type", "source", "command", "cwd"], "action");
    return {
      type,
      source: guardianCommandSource(action.source),
      command: requiredStringValue(action.command, "action.command"),
      cwd: requiredStringValue(action.cwd, "action.cwd")
    };
  }
  if (type === "execve") {
    assertOnlyKeys(action, ["type", "source", "program", "argv", "cwd"], "action");
    return {
      type,
      source: guardianCommandSource(action.source),
      program: requiredStringValue(action.program, "action.program"),
      argv: requiredStringArray(action.argv, "action.argv"),
      cwd: requiredStringValue(action.cwd, "action.cwd")
    };
  }
  if (type === "applyPatch") {
    assertOnlyKeys(action, ["type", "cwd", "files"], "action");
    return {
      type: "apply_patch",
      cwd: requiredStringValue(action.cwd, "action.cwd"),
      files: requiredStringArray(action.files, "action.files")
    };
  }
  if (type === "networkAccess") {
    assertOnlyKeys(action, ["type", "target", "host", "protocol", "port"], "action");
    return {
      type: "network_access",
      target: requiredStringValue(action.target, "action.target"),
      host: requiredStringValue(action.host, "action.host"),
      protocol: guardianNetworkProtocol(action.protocol),
      port: requiredNumber(action.port, "action.port")
    };
  }
  if (type === "mcpToolCall") {
    assertOnlyKeys(action, ["type", "server", "toolName", "connectorId", "connectorName", "toolTitle"], "action");
    return {
      type: "mcp_tool_call",
      server: requiredStringValue(action.server, "action.server"),
      tool_name: requiredStringValue(action.toolName, "action.toolName"),
      connector_id: requiredNullableString(action.connectorId, "action.connectorId"),
      connector_name: requiredNullableString(action.connectorName, "action.connectorName"),
      tool_title: requiredNullableString(action.toolTitle, "action.toolTitle")
    };
  }
  if (type === "requestPermissions") {
    assertOnlyKeys(action, ["type", "reason", "permissions"], "action");
    return {
      type: "request_permissions",
      reason: requiredNullableString(action.reason, "action.reason"),
      permissions: guardianPermissionProfile(action.permissions, "action.permissions")
    };
  }
  throw new Error(`Guardian review notification included unsupported action type ${type}.`);
}

function guardianPermissionProfile(value: unknown, field: string): Record<string, unknown> {
  validatePermissionProfile(value, field);
  const profile = requiredRecord(value, field);
  const fileSystem = record(profile.fileSystem);
  return {
    network: profile.network,
    file_system: fileSystem
      ? {
          read: fileSystem.read,
          write: fileSystem.write,
          ...(fileSystem.globScanMaxDepth === undefined ? {} : { glob_scan_max_depth: fileSystem.globScanMaxDepth }),
          ...(fileSystem.entries === undefined ? {} : {
            entries: (fileSystem.entries as unknown[]).map((entry) => {
              const item = requiredRecord(entry, `${field}.fileSystem.entries[]`);
              return { path: item.path, access: item.access };
            })
          })
        }
      : null
  };
}

function guardianCommandSource(value: unknown): string {
  if (value === "shell") return value;
  if (value === "unifiedExec") return "unified_exec";
  throw new Error("Guardian action source is unsupported.");
}

function guardianNetworkProtocol(value: unknown): string {
  if (value === "http" || value === "https") return value;
  if (value === "socks5Tcp") return "socks5_tcp";
  if (value === "socks5Udp") return "socks5_udp";
  throw new Error("Guardian network protocol is unsupported.");
}

function optionalGuardianRiskLevel(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (value === "low" || value === "medium" || value === "high" || value === "critical") return value;
  throw new Error("Guardian review riskLevel is unsupported.");
}

function optionalGuardianUserAuthorization(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (value === "unknown" || value === "low" || value === "medium" || value === "high") return value;
  throw new Error("Guardian review userAuthorization is unsupported.");
}
