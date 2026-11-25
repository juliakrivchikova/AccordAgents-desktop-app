import type { ChatCodexApprovalMethod, ChatCodexApprovalOption } from "../../../shared/types";
import { isCodexGuardianDeniedApprovalMethod, isCodexGuardianTimedOutApprovalMethod } from "../../../shared/codexApproval";
import { MAX_DISPLAY_PATH, MAX_DISPLAY_TEXT } from "./constants";
import {
  commandDecision, commandDecisionDetail, commandDecisionId, commandDecisionLabel, commandDecisionOutcome, grantedPermissions,
  simpleDecisionResponses
} from "./decisions";
import { commandActionSummary, displayArgv, displayString, fileChangeSummary, permissionSummary } from "./display";
import { optionalNullableString, record, requiredRecord, requiredString } from "./fields";
import { prepareGuardianDeniedApproval, prepareGuardianTimedOutApproval } from "./guardian";
import { commonV2Fields, prepared } from "./preparedApproval";
import type { CodexApprovalCorrelation, CodexInboundServerRequest, PreparedCodexApproval } from "./types";
import {
  validateApprovalParams, validateCommandApprovalParams, validateFileApprovalParams, validateLegacyCommandApprovalParams,
  validateLegacyFileApprovalParams, validatePermissionsApprovalParams
} from "./validation";

export function isCodexApprovalMethod(method: string): method is ChatCodexApprovalMethod {
  return method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "item/permissions/requestApproval" ||
    method === "applyPatchApproval" ||
    method === "execCommandApproval";
}

export function codexApprovalCancellationResult(method: ChatCodexApprovalMethod): unknown {
  if (isCodexGuardianDeniedApprovalMethod(method) || isCodexGuardianTimedOutApprovalMethod(method)) {
    return { decision: "keepDenied" };
  }
  if (method === "item/permissions/requestApproval") {
    return { permissions: {}, scope: "turn" };
  }
  if (method === "applyPatchApproval" || method === "execCommandApproval") {
    return { decision: "abort" };
  }
  return { decision: "cancel" };
}

export function prepareCodexApproval(input: Pick<CodexInboundServerRequest, "id" | "method" | "params">): PreparedCodexApproval {
  if (isCodexGuardianDeniedApprovalMethod(input.method)) {
    return prepareGuardianDeniedApproval(input.id, input.params);
  }
  if (isCodexGuardianTimedOutApprovalMethod(input.method)) {
    return prepareGuardianTimedOutApproval(input.id, input.params);
  }
  if (!isCodexApprovalMethod(input.method)) {
    throw new Error(`Unsupported Codex approval method: ${input.method}`);
  }
  const params = record(input.params);
  if (!params) {
    throw new Error(`${input.method} did not include valid approval parameters.`);
  }
  if (input.method === "item/commandExecution/requestApproval") {
    return prepareCommandApproval(input.id, input.method, params);
  }
  if (input.method === "item/fileChange/requestApproval") {
    return prepareFileApproval(input.id, input.method, params);
  }
  if (input.method === "item/permissions/requestApproval") {
    return preparePermissionsApproval(input.id, input.method, params);
  }
  if (input.method === "execCommandApproval") {
    return prepareLegacyCommandApproval(input.id, input.method, params);
  }
  return prepareLegacyFileApproval(input.id, input.method, params);
}

export function validateCodexApprovalCorrelation(
  method: ChatCodexApprovalMethod,
  value: unknown,
  expectedThreadId: string,
  expectedTurnId?: string
): CodexApprovalCorrelation {
  const params = requiredRecord(value, `${method} params`);
  validateApprovalParams(method, params);
  const v2 = method.startsWith("item/");
  const threadId = requiredString(v2 ? params.threadId : params.conversationId, v2 ? "threadId" : "conversationId");
  const turnId = v2 ? requiredString(params.turnId, "turnId") : undefined;
  const itemId = requiredString(v2 ? params.itemId : params.callId, v2 ? "itemId" : "callId");
  const approvalId = optionalNullableString(params.approvalId, "approvalId") ?? undefined;
  if (threadId !== expectedThreadId) {
    throw new Error(`${method} belongs to thread ${threadId}, not the active thread ${expectedThreadId}.`);
  }
  if (expectedTurnId && turnId && turnId !== expectedTurnId) {
    throw new Error(`${method} belongs to turn ${turnId}, not the active turn ${expectedTurnId}.`);
  }
  return { threadId, turnId, itemId, approvalId };
}

function prepareCommandApproval(
  requestId: string | number,
  method: ChatCodexApprovalMethod,
  params: Record<string, unknown>
): PreparedCodexApproval {
  validateCommandApprovalParams(params);
  const hasAdvertised = params.availableDecisions !== undefined && params.availableDecisions !== null;
  const advertised = hasAdvertised ? params.availableDecisions as unknown[] : [];
  const responses: Array<{ option: ChatCodexApprovalOption; response: unknown }> = advertised.map((decision, index) => {
    const normalized = commandDecision(decision, `availableDecisions[${index}]`);
    const id = commandDecisionId(normalized, index);
    return {
      option: {
        id,
        label: commandDecisionLabel(normalized),
        detail: commandDecisionDetail(normalized),
        outcome: commandDecisionOutcome(normalized)
      } satisfies ChatCodexApprovalOption,
      response: { decision: normalized }
    };
  });
  // Current v2 requests normally advertise their exact choices. Older v2
  // producers omit the field, in which case the installed string decision
  // union is the documented compatibility fallback. Structured amendments are
  // never invented because their payload must come from availableDecisions.
  if (!hasAdvertised) {
    responses.push(...simpleDecisionResponses([
      ["accept", "Allow once", "approve"],
      ["acceptForSession", "Allow for this Codex session", "approve"],
      ["decline", "Deny", "deny"],
      ["cancel", "Cancel", "cancel"]
    ]));
  }
  if (responses.length === 0) {
    throw new Error("availableDecisions was present but did not contain any supported decision.");
  }
  const decisionKeys = responses.map((item) => JSON.stringify(record(item.response)?.decision));
  if (new Set(decisionKeys).size !== decisionKeys.length) {
    throw new Error("availableDecisions contains duplicate decisions.");
  }
  const optionIds = responses.map((item) => item.option.id);
  if (new Set(optionIds).size !== optionIds.length) {
    throw new Error("availableDecisions contains duplicate decisions.");
  }
  const networkContext = record(params.networkApprovalContext);
  return prepared({
    kind: "codexApproval",
    method,
    requestId,
    ...commonV2Fields(params),
    action: "command",
    command: displayString(params.command, MAX_DISPLAY_TEXT),
    commandActions: commandActionSummary(params.commandActions),
    cwd: displayString(params.cwd, MAX_DISPLAY_PATH),
    reason: displayString(params.reason, MAX_DISPLAY_TEXT),
    permissions: permissionSummary(params.additionalPermissions, params.networkApprovalContext),
    networkTarget: displayString(networkContext?.host, MAX_DISPLAY_TEXT),
    networkProtocol: displayString(networkContext?.protocol, 40),
    options: responses.map((item) => item.option)
  }, responses);
}

function prepareFileApproval(
  requestId: string | number,
  method: ChatCodexApprovalMethod,
  params: Record<string, unknown>
): PreparedCodexApproval {
  validateFileApprovalParams(params);
  const responses = simpleDecisionResponses([
    ["accept", "Allow once", "approve"],
    ["acceptForSession", "Allow for this Codex session", "approve"],
    ["decline", "Deny", "deny"],
    ["cancel", "Cancel", "cancel"]
  ]);
  const grantRoot = displayString(params.grantRoot, MAX_DISPLAY_PATH);
  return prepared({
    kind: "codexApproval",
    method,
    requestId,
    ...commonV2Fields(params),
    action: "fileChange",
    cwd: grantRoot,
    grantRoot,
    reason: displayString(params.reason, MAX_DISPLAY_TEXT),
    fileChanges: fileChangeSummary(params.fileChanges),
    options: responses.map((item) => item.option)
  }, responses);
}

function preparePermissionsApproval(
  requestId: string | number,
  method: ChatCodexApprovalMethod,
  params: Record<string, unknown>
): PreparedCodexApproval {
  validatePermissionsApprovalParams(params);
  const requested = grantedPermissions(params.permissions);
  const responses: Array<{ option: ChatCodexApprovalOption; response: unknown }> = [
    {
      option: { id: "turn", label: "Allow for this turn", outcome: "approve" },
      response: { permissions: requested, scope: "turn" }
    },
    {
      option: { id: "session", label: "Allow for this Codex session", outcome: "approve" },
      response: { permissions: requested, scope: "session" }
    },
    {
      option: { id: "deny", label: "Deny", outcome: "deny" },
      response: { permissions: {}, scope: "turn" }
    }
  ];
  return prepared({
    kind: "codexApproval",
    method,
    requestId,
    ...commonV2Fields(params),
    action: "permissions",
    cwd: displayString(params.cwd, MAX_DISPLAY_PATH),
    reason: displayString(params.reason, MAX_DISPLAY_TEXT),
    permissions: permissionSummary(params.permissions),
    options: responses.map((item) => item.option)
  }, responses);
}

function prepareLegacyCommandApproval(
  requestId: string | number,
  method: ChatCodexApprovalMethod,
  params: Record<string, unknown>
): PreparedCodexApproval {
  validateLegacyCommandApprovalParams(params);
  const responses: Array<{ option: ChatCodexApprovalOption; response: unknown }> = [
    {
      option: { id: "approved", label: "Allow once", outcome: "approve" },
      response: { decision: "approved" }
    },
    {
      option: { id: "approved_for_session", label: "Allow for this Codex session", outcome: "approve" },
      response: { decision: "approved_for_session" }
    },
    {
      option: { id: "denied", label: "Deny", outcome: "deny" },
      response: { decision: { denied: { rejection: "User denied this command." } } }
    },
    {
      option: { id: "abort", label: "Cancel", outcome: "cancel" },
      response: { decision: "abort" }
    }
  ];
  return prepared({
    kind: "codexApproval",
    method,
    requestId,
    threadId: displayString(params.conversationId, MAX_DISPLAY_PATH),
    approvalId: displayString(params.approvalId, MAX_DISPLAY_PATH),
    itemId: displayString(params.callId, MAX_DISPLAY_PATH),
    action: "command",
    command: displayArgv(params.command),
    commandActions: commandActionSummary(params.parsedCmd),
    cwd: displayString(params.cwd, MAX_DISPLAY_PATH),
    reason: displayString(params.reason, MAX_DISPLAY_TEXT),
    options: responses.map((item) => item.option)
  }, responses);
}

function prepareLegacyFileApproval(
  requestId: string | number,
  method: ChatCodexApprovalMethod,
  params: Record<string, unknown>
): PreparedCodexApproval {
  validateLegacyFileApprovalParams(params);
  const responses: Array<{ option: ChatCodexApprovalOption; response: unknown }> = [
    {
      option: { id: "approved", label: "Allow once", outcome: "approve" },
      response: { decision: "approved" }
    },
    {
      option: { id: "approved_for_session", label: "Allow for this Codex session", outcome: "approve" },
      response: { decision: "approved_for_session" }
    },
    {
      option: { id: "denied", label: "Deny", outcome: "deny" },
      response: { decision: { denied: { rejection: "User denied these file changes." } } }
    },
    {
      option: { id: "abort", label: "Cancel", outcome: "cancel" },
      response: { decision: "abort" }
    }
  ];
  return prepared({
    kind: "codexApproval",
    method,
    requestId,
    threadId: displayString(params.conversationId, MAX_DISPLAY_PATH),
    itemId: displayString(params.callId, MAX_DISPLAY_PATH),
    action: "fileChange",
    reason: displayString(params.reason, MAX_DISPLAY_TEXT),
    grantRoot: displayString(params.grantRoot, MAX_DISPLAY_PATH),
    fileChanges: fileChangeSummary(params.fileChanges),
    options: responses.map((item) => item.option)
  }, responses);
}
