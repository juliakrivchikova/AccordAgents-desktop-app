import type {
  ChatCodexCommandActionSummary,
  ChatCodexApprovalMethod,
  ChatCodexApprovalOption,
  ChatCodexApprovalRequest,
  ChatCodexFileChangeSummary,
  ChatCodexPermissionSummary
} from "../../shared/types";

export const CODEX_APPROVAL_TOOL_NAME = "codex_auto_review_approval";
export const CODEX_GUARDIAN_DENIED_APPROVAL_METHOD = "item/autoApprovalReview/denied";
export const CODEX_GUARDIAN_TIMED_OUT_APPROVAL_METHOD = "item/autoApprovalReview/timedOut";

const MAX_DISPLAY_TEXT = 2_000;
const MAX_DISPLAY_PATH = 600;
const MAX_DISPLAY_ITEMS = 24;

export interface CodexInboundServerRequest {
  id: string | number;
  method: string;
  params: unknown;
  signal: AbortSignal;
  responseDelivered: Promise<void>;
}

export interface CodexApprovalCorrelation {
  threadId: string;
  turnId?: string;
  itemId: string;
  approvalId?: string;
}

export interface PreparedCodexApproval {
  request: ChatCodexApprovalRequest;
  responseByOptionId: ReadonlyMap<string, unknown>;
}

export function isCodexApprovalMethod(method: string): method is ChatCodexApprovalMethod {
  return method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "item/permissions/requestApproval" ||
    method === "applyPatchApproval" ||
    method === "execCommandApproval";
}

export function codexApprovalCancellationResult(method: ChatCodexApprovalMethod): unknown {
  if (method === CODEX_GUARDIAN_DENIED_APPROVAL_METHOD || method === CODEX_GUARDIAN_TIMED_OUT_APPROVAL_METHOD) {
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
  if (input.method === CODEX_GUARDIAN_DENIED_APPROVAL_METHOD) {
    return prepareGuardianDeniedApproval(input.id, input.params);
  }
  if (input.method === CODEX_GUARDIAN_TIMED_OUT_APPROVAL_METHOD) {
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

function prepareGuardianDeniedApproval(requestId: string | number, value: unknown): PreparedCodexApproval {
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

function prepareGuardianTimedOutApproval(requestId: string | number, value: unknown): PreparedCodexApproval {
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

function prepared(
  request: ChatCodexApprovalRequest,
  responses: Array<{ option: ChatCodexApprovalOption; response: unknown }>
): PreparedCodexApproval {
  return {
    request,
    responseByOptionId: new Map(responses.map((item) => [item.option.id, item.response]))
  };
}

function commonV2Fields(params: Record<string, unknown>): Pick<ChatCodexApprovalRequest, "threadId" | "turnId" | "itemId" | "approvalId"> {
  return {
    threadId: displayString(params.threadId, MAX_DISPLAY_PATH),
    turnId: displayString(params.turnId, MAX_DISPLAY_PATH),
    itemId: displayString(params.itemId, MAX_DISPLAY_PATH),
    approvalId: displayString(params.approvalId, MAX_DISPLAY_PATH)
  };
}

function simpleDecisionResponses(
  decisions: Array<[string, string, ChatCodexApprovalOption["outcome"]]>
): Array<{ option: ChatCodexApprovalOption; response: unknown }> {
  return decisions.map(([id, label, outcome]) => ({
    option: { id, label, outcome },
    response: { decision: id }
  }));
}

function commandDecision(value: unknown, field: string): unknown {
  if (value === "accept" || value === "acceptForSession" || value === "decline" || value === "cancel") {
    return value;
  }
  const candidate = record(value);
  if (candidate && Object.keys(candidate).length === 1 && record(candidate.acceptWithExecpolicyAmendment)) {
    const wrapper = requiredRecord(candidate.acceptWithExecpolicyAmendment, `${field}.acceptWithExecpolicyAmendment`);
    assertOnlyKeys(wrapper, ["execpolicy_amendment"], `${field}.acceptWithExecpolicyAmendment`);
    const amendment = requiredStringArray(wrapper.execpolicy_amendment, `${field}.acceptWithExecpolicyAmendment.execpolicy_amendment`);
    return { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } };
  }
  if (candidate && Object.keys(candidate).length === 1 && record(candidate.applyNetworkPolicyAmendment)) {
    const wrapper = requiredRecord(candidate.applyNetworkPolicyAmendment, `${field}.applyNetworkPolicyAmendment`);
    assertOnlyKeys(wrapper, ["network_policy_amendment"], `${field}.applyNetworkPolicyAmendment`);
    const amendment = validateNetworkPolicyAmendment(wrapper.network_policy_amendment, `${field}.applyNetworkPolicyAmendment.network_policy_amendment`);
    return { applyNetworkPolicyAmendment: { network_policy_amendment: amendment } };
  }
  throw new Error(`${field} contains an unsupported decision.`);
}

function commandDecisionId(value: unknown, index: number): string {
  if (typeof value === "string") {
    return value;
  }
  const candidate = record(value);
  return candidate?.acceptWithExecpolicyAmendment
    ? `acceptWithExecpolicyAmendment-${index}`
    : `applyNetworkPolicyAmendment-${index}`;
}

function commandDecisionLabel(value: unknown): string {
  if (value === "accept") return "Allow once";
  if (value === "acceptForSession") return "Allow for this Codex session";
  if (value === "decline") return "Deny";
  if (value === "cancel") return "Cancel";
  const candidate = record(value);
  return candidate?.acceptWithExecpolicyAmendment
    ? "Allow and update command policy"
    : "Apply proposed network policy";
}

function commandDecisionDetail(value: unknown): string | undefined {
  const candidate = record(value);
  const exec = record(candidate?.acceptWithExecpolicyAmendment);
  if (exec) {
    const amendment = requiredStringArray(exec.execpolicy_amendment, "execpolicy amendment");
    return displayString(`Command policy: ${amendment.map((item) => JSON.stringify(redactApprovalText(item))).join(" ")}`, MAX_DISPLAY_TEXT);
  }
  const network = record(record(candidate?.applyNetworkPolicyAmendment)?.network_policy_amendment);
  if (network) {
    return displayString(`Network policy: ${String(network.action)} ${String(network.host)}`, MAX_DISPLAY_TEXT);
  }
  return undefined;
}

function commandDecisionOutcome(value: unknown): ChatCodexApprovalOption["outcome"] {
  if (value === "decline") return "deny";
  if (value === "cancel") return "cancel";
  return "approve";
}

function grantedPermissions(value: unknown): Record<string, unknown> {
  const permissions = requiredRecord(value, "permissions");
  const granted: Record<string, unknown> = {};
  if (record(permissions.network)) granted.network = permissions.network;
  if (record(permissions.fileSystem)) granted.fileSystem = permissions.fileSystem;
  return granted;
}

function permissionSummary(value: unknown, networkContext?: unknown): ChatCodexPermissionSummary | undefined {
  const permissions = record(value);
  const network = record(permissions?.network);
  const fileSystem = record(permissions?.fileSystem);
  const summary: ChatCodexPermissionSummary = {};
  if (network?.enabled === true || record(networkContext)) summary.network = true;
  const readPaths = displayStringArray(fileSystem?.read);
  const writePaths = displayStringArray(fileSystem?.write);
  for (const entry of Array.isArray(fileSystem?.entries) ? fileSystem.entries.slice(0, MAX_DISPLAY_ITEMS) : []) {
    const entryRecord = record(entry);
    const entryPath = fileSystemEntryPath(entryRecord?.path);
    if (!entryPath) continue;
    if (entryRecord?.access === "read") readPaths.push(entryPath);
    if (entryRecord?.access === "write") writePaths.push(entryPath);
  }
  if (readPaths.length > 0) summary.readPaths = unique(readPaths);
  if (writePaths.length > 0) summary.writePaths = unique(writePaths);
  return Object.keys(summary).length > 0 ? summary : undefined;
}

function fileSystemEntryPath(value: unknown): string | undefined {
  const candidate = record(value);
  if (!candidate) return undefined;
  if (candidate.type === "path") return displayString(candidate.path, MAX_DISPLAY_PATH);
  if (candidate.type === "glob_pattern") return displayString(candidate.pattern, MAX_DISPLAY_PATH);
  if (candidate.type === "special") return displayString(candidate.value, MAX_DISPLAY_PATH);
  return undefined;
}

function fileChangeSummary(value: unknown): ChatCodexFileChangeSummary[] | undefined {
  if (Array.isArray(value)) {
    const summary = value.slice(0, MAX_DISPLAY_ITEMS).flatMap((item): ChatCodexFileChangeSummary[] => {
      const change = record(item);
      const path = displayString(change?.path, MAX_DISPLAY_PATH);
      const kind = record(change?.kind)?.type ?? change?.change ?? change?.type;
      if (!path) return [];
      return [{
        path,
        change: kind === "add" || kind === "delete" || kind === "update" ? kind : "unknown"
      }];
    });
    return summary.length > 0 ? summary : undefined;
  }
  const changes = record(value);
  if (!changes) return undefined;
  const summary = Object.entries(changes).slice(0, MAX_DISPLAY_ITEMS).map(([path, change]) => {
    const changeType = record(change)?.type;
    return {
      path: displayString(path, MAX_DISPLAY_PATH) ?? "<redacted>",
      change: changeType === "add" || changeType === "delete" || changeType === "update" ? changeType : "unknown"
    } satisfies ChatCodexFileChangeSummary;
  });
  return summary.length > 0 ? summary : undefined;
}

function displayStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const text = displayString(item, MAX_DISPLAY_PATH);
        return text ? [text] : [];
      }).slice(0, MAX_DISPLAY_ITEMS)
    : [];
}

function displayArgv(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const argv = value.flatMap((item) => typeof item === "string" ? [redactApprovalText(item)] : []);
  return boundedString(argv.map((item) => JSON.stringify(item)).join(" "), MAX_DISPLAY_TEXT);
}

function commandActionSummary(value: unknown): ChatCodexCommandActionSummary[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const actions = value.slice(0, MAX_DISPLAY_ITEMS).flatMap((item): ChatCodexCommandActionSummary[] => {
    const action = record(item);
    if (!action) return [];
    const rawType = action.type;
    const type = rawType === "list_files" ? "listFiles" : rawType;
    if (type !== "read" && type !== "listFiles" && type !== "search" && type !== "unknown") return [];
    const command = displayString(action.command ?? action.cmd, MAX_DISPLAY_TEXT);
    if (!command) return [];
    return [{
      type,
      command,
      name: displayString(action.name, MAX_DISPLAY_TEXT),
      path: displayString(action.path, MAX_DISPLAY_PATH),
      query: displayString(action.query, MAX_DISPLAY_TEXT)
    }];
  });
  return actions.length > 0 ? actions : undefined;
}

function validateApprovalParams(method: ChatCodexApprovalMethod, params: Record<string, unknown>): void {
  if (method === "item/commandExecution/requestApproval") return validateCommandApprovalParams(params);
  if (method === "item/fileChange/requestApproval") return validateFileApprovalParams(params);
  if (method === "item/permissions/requestApproval") return validatePermissionsApprovalParams(params);
  if (method === "execCommandApproval") return validateLegacyCommandApprovalParams(params);
  if (method === "applyPatchApproval") return validateLegacyFileApprovalParams(params);
  throw new Error(`${method} is not a direct Codex approval request.`);
}

function validateCommandApprovalParams(params: Record<string, unknown>): void {
  assertOnlyKeys(params, [
    "threadId", "turnId", "itemId", "startedAtMs", "approvalId", "environmentId", "reason",
    "networkApprovalContext", "command", "cwd", "commandActions", "additionalPermissions",
    "proposedExecpolicyAmendment", "proposedNetworkPolicyAmendments", "availableDecisions"
  ], "item/commandExecution/requestApproval params");
  validateV2Identity(params);
  requiredNumber(params.startedAtMs, "startedAtMs");
  requiredNullableString(params.environmentId, "environmentId");
  optionalNullableString(params.approvalId, "approvalId");
  optionalNullableString(params.reason, "reason");
  optionalNullableString(params.command, "command");
  optionalNullableString(params.cwd, "cwd");
  if (params.networkApprovalContext !== undefined && params.networkApprovalContext !== null) {
    validateNetworkApprovalContext(params.networkApprovalContext, "networkApprovalContext");
  }
  if (params.commandActions !== undefined && params.commandActions !== null) {
    validateCommandActions(params.commandActions, "commandActions", false);
  }
  if (params.additionalPermissions !== undefined && params.additionalPermissions !== null) {
    validatePermissionProfile(params.additionalPermissions, "additionalPermissions");
  }
  if (params.proposedExecpolicyAmendment !== undefined && params.proposedExecpolicyAmendment !== null) {
    requiredStringArray(params.proposedExecpolicyAmendment, "proposedExecpolicyAmendment");
  }
  if (params.proposedNetworkPolicyAmendments !== undefined && params.proposedNetworkPolicyAmendments !== null) {
    if (!Array.isArray(params.proposedNetworkPolicyAmendments)) {
      throw new Error("proposedNetworkPolicyAmendments must be an array or null.");
    }
    params.proposedNetworkPolicyAmendments.forEach((item, index) => validateNetworkPolicyAmendment(item, `proposedNetworkPolicyAmendments[${index}]`));
  }
  if (params.availableDecisions !== undefined && params.availableDecisions !== null && !Array.isArray(params.availableDecisions)) {
    throw new Error("availableDecisions must be an array, null, or omitted.");
  }
}

function validateFileApprovalParams(params: Record<string, unknown>): void {
  assertOnlyKeys(params, ["threadId", "turnId", "itemId", "startedAtMs", "reason", "grantRoot", "fileChanges"], "item/fileChange/requestApproval params");
  validateV2Identity(params);
  requiredNumber(params.startedAtMs, "startedAtMs");
  optionalNullableString(params.reason, "reason");
  optionalNullableString(params.grantRoot, "grantRoot");
  if (params.fileChanges !== undefined && !Array.isArray(params.fileChanges)) {
    throw new Error("fileChanges correlation summary must be an array when present.");
  }
}

function validatePermissionsApprovalParams(params: Record<string, unknown>): void {
  assertOnlyKeys(params, ["threadId", "turnId", "itemId", "environmentId", "startedAtMs", "cwd", "reason", "permissions"], "item/permissions/requestApproval params");
  validateV2Identity(params);
  requiredNullableString(params.environmentId, "environmentId");
  requiredNumber(params.startedAtMs, "startedAtMs");
  requiredStringValue(params.cwd, "cwd");
  requiredNullableString(params.reason, "reason");
  validatePermissionProfile(params.permissions, "permissions");
}

function validateLegacyCommandApprovalParams(params: Record<string, unknown>): void {
  assertOnlyKeys(params, ["conversationId", "callId", "approvalId", "command", "cwd", "reason", "parsedCmd"], "execCommandApproval params");
  requiredString(params.conversationId, "conversationId");
  requiredString(params.callId, "callId");
  requiredNullableString(params.approvalId, "approvalId");
  requiredStringArray(params.command, "command");
  requiredStringValue(params.cwd, "cwd");
  requiredNullableString(params.reason, "reason");
  validateCommandActions(params.parsedCmd, "parsedCmd", true);
}

function validateLegacyFileApprovalParams(params: Record<string, unknown>): void {
  assertOnlyKeys(params, ["conversationId", "callId", "fileChanges", "reason", "grantRoot"], "applyPatchApproval params");
  requiredString(params.conversationId, "conversationId");
  requiredString(params.callId, "callId");
  const changes = requiredRecord(params.fileChanges, "fileChanges");
  for (const [path, value] of Object.entries(changes)) {
    if (!path) throw new Error("fileChanges contains an empty path.");
    const change = requiredRecord(value, `fileChanges.${path}`);
    const type = requiredString(change.type, `fileChanges.${path}.type`);
    if (type === "add" || type === "delete") {
      assertOnlyKeys(change, ["type", "content"], `fileChanges.${path}`);
      requiredStringValue(change.content, `fileChanges.${path}.content`);
    } else if (type === "update") {
      assertOnlyKeys(change, ["type", "unified_diff", "move_path"], `fileChanges.${path}`);
      requiredStringValue(change.unified_diff, `fileChanges.${path}.unified_diff`);
      requiredNullableString(change.move_path, `fileChanges.${path}.move_path`);
    } else {
      throw new Error(`fileChanges.${path}.type is unsupported.`);
    }
  }
  requiredNullableString(params.reason, "reason");
  requiredNullableString(params.grantRoot, "grantRoot");
}

function validateV2Identity(params: Record<string, unknown>): void {
  requiredString(params.threadId, "threadId");
  requiredString(params.turnId, "turnId");
  requiredString(params.itemId, "itemId");
}

function validateNetworkApprovalContext(value: unknown, field: string): void {
  const context = requiredRecord(value, field);
  assertOnlyKeys(context, ["host", "protocol"], field);
  requiredString(context.host, `${field}.host`);
  if (context.protocol !== "http" && context.protocol !== "https" && context.protocol !== "socks5Tcp" && context.protocol !== "socks5Udp") {
    throw new Error(`${field}.protocol is unsupported.`);
  }
}

function validateNetworkPolicyAmendment(value: unknown, field: string): Record<string, unknown> {
  const amendment = requiredRecord(value, field);
  assertOnlyKeys(amendment, ["host", "action"], field);
  const host = requiredString(amendment.host, `${field}.host`);
  if (amendment.action !== "allow" && amendment.action !== "deny") {
    throw new Error(`${field}.action is unsupported.`);
  }
  return { host, action: amendment.action };
}

function validateCommandActions(value: unknown, field: string, legacy: boolean): void {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  value.forEach((item, index) => {
    const action = requiredRecord(item, `${field}[${index}]`);
    const type = requiredString(action.type, `${field}[${index}].type`);
    if (type === "read") {
      assertOnlyKeys(action, legacy ? ["type", "cmd", "name", "path"] : ["type", "command", "name", "path"], `${field}[${index}]`);
      requiredStringValue(action[legacy ? "cmd" : "command"], `${field}[${index}].command`);
      requiredStringValue(action.name, `${field}[${index}].name`);
      requiredStringValue(action.path, `${field}[${index}].path`);
      return;
    }
    const listType = legacy ? "list_files" : "listFiles";
    if (type === listType) {
      assertOnlyKeys(action, legacy ? ["type", "cmd", "path"] : ["type", "command", "path"], `${field}[${index}]`);
      requiredStringValue(action[legacy ? "cmd" : "command"], `${field}[${index}].command`);
      requiredNullableString(action.path, `${field}[${index}].path`);
      return;
    }
    if (type === "search") {
      assertOnlyKeys(action, legacy ? ["type", "cmd", "query", "path"] : ["type", "command", "query", "path"], `${field}[${index}]`);
      requiredStringValue(action[legacy ? "cmd" : "command"], `${field}[${index}].command`);
      requiredNullableString(action.query, `${field}[${index}].query`);
      requiredNullableString(action.path, `${field}[${index}].path`);
      return;
    }
    if (type === "unknown") {
      assertOnlyKeys(action, legacy ? ["type", "cmd"] : ["type", "command"], `${field}[${index}]`);
      requiredStringValue(action[legacy ? "cmd" : "command"], `${field}[${index}].command`);
      return;
    }
    throw new Error(`${field}[${index}].type is unsupported.`);
  });
}

function validatePermissionProfile(value: unknown, field: string): void {
  const profile = requiredRecord(value, field);
  assertOnlyKeys(profile, ["network", "fileSystem"], field);
  if (!("network" in profile) || !("fileSystem" in profile)) {
    throw new Error(`${field} must include network and fileSystem.`);
  }
  if (profile.network !== null) {
    const network = requiredRecord(profile.network, `${field}.network`);
    assertOnlyKeys(network, ["enabled"], `${field}.network`);
    if (network.enabled !== null && typeof network.enabled !== "boolean") {
      throw new Error(`${field}.network.enabled must be boolean or null.`);
    }
  }
  if (profile.fileSystem === null) return;
  const fileSystem = requiredRecord(profile.fileSystem, `${field}.fileSystem`);
  assertOnlyKeys(fileSystem, ["read", "write", "globScanMaxDepth", "entries"], `${field}.fileSystem`);
  if (!("read" in fileSystem) || !("write" in fileSystem)) {
    throw new Error(`${field}.fileSystem must include read and write.`);
  }
  if (fileSystem.read !== null) requiredStringArray(fileSystem.read, `${field}.fileSystem.read`);
  if (fileSystem.write !== null) requiredStringArray(fileSystem.write, `${field}.fileSystem.write`);
  if (fileSystem.globScanMaxDepth !== undefined && (!Number.isInteger(fileSystem.globScanMaxDepth) || (fileSystem.globScanMaxDepth as number) < 0)) {
    throw new Error(`${field}.fileSystem.globScanMaxDepth must be a non-negative integer.`);
  }
  if (fileSystem.entries !== undefined) {
    if (!Array.isArray(fileSystem.entries)) throw new Error(`${field}.fileSystem.entries must be an array.`);
    fileSystem.entries.forEach((entry, index) => validateFileSystemEntry(entry, `${field}.fileSystem.entries[${index}]`));
  }
}

function validateFileSystemEntry(value: unknown, field: string): void {
  const entry = requiredRecord(value, field);
  assertOnlyKeys(entry, ["path", "access"], field);
  if (entry.access !== "read" && entry.access !== "write" && entry.access !== "deny") {
    throw new Error(`${field}.access is unsupported.`);
  }
  const path = requiredRecord(entry.path, `${field}.path`);
  const type = requiredString(path.type, `${field}.path.type`);
  if (type === "path") {
    assertOnlyKeys(path, ["type", "path"], `${field}.path`);
    requiredStringValue(path.path, `${field}.path.path`);
  } else if (type === "glob_pattern") {
    assertOnlyKeys(path, ["type", "pattern"], `${field}.path`);
    requiredStringValue(path.pattern, `${field}.path.pattern`);
  } else if (type === "special") {
    assertOnlyKeys(path, ["type", "value"], `${field}.path`);
    requiredRecord(path.value, `${field}.path.value`);
  } else {
    throw new Error(`${field}.path.type is unsupported.`);
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)].slice(0, MAX_DISPLAY_ITEMS);
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

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

function requiredStringValue(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number.`);
  }
  return value;
}

function requiredNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string or null.`);
  }
  return value;
}

function optionalNullableString(value: unknown, field: string): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string, null, or omitted.`);
  }
  return value;
}

function requiredStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${field} must be an array of strings.`);
  }
  return value;
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  const candidate = record(value);
  if (!candidate) throw new Error(`${field} must be an object.`);
  return candidate;
}

function assertOnlyKeys(value: Record<string, unknown>, keys: string[], field: string): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${field} contains unsupported fields: ${unknown.join(", ")}.`);
  }
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function displayString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" ? boundedString(redactApprovalText(value), maxLength) : undefined;
}

export function redactCodexApprovalText(value: string): string {
  return redactApprovalText(value);
}

function redactApprovalText(value: string): string {
  return value
    .replace(/\b(Authorization\s*:\s*Bearer\s+)([^\s"',;]+)/gi, "$1••••")
    .replace(/((?:^|[\s,{?&])(?:["']?)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret)(?:["']?)\s*(?:=|:)\s*["']?)([^\s"',;}&#]+)/gim, "$1••••")
    .replace(/(--(?:api-key|access-token|refresh-token|token|password|secret)\s+)([^\s]+)/gi, "$1••••")
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{12,})\b/g, "••••");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
