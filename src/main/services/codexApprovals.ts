import type {
  ChatCodexApprovalMethod,
  ChatCodexApprovalOption,
  ChatCodexApprovalRequest,
  ChatCodexFileChangeSummary,
  ChatCodexPermissionSummary
} from "../../shared/types";

export const CODEX_APPROVAL_TOOL_NAME = "codex_auto_review_approval";

const MAX_DISPLAY_TEXT = 2_000;
const MAX_DISPLAY_PATH = 600;
const MAX_DISPLAY_ITEMS = 24;

export interface CodexInboundServerRequest {
  id: string | number;
  method: string;
  params: unknown;
  signal: AbortSignal;
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
  if (method === "item/permissions/requestApproval") {
    return { permissions: {}, scope: "turn" };
  }
  if (method === "applyPatchApproval" || method === "execCommandApproval") {
    return { decision: "abort" };
  }
  return { decision: "cancel" };
}

export function prepareCodexApproval(input: Pick<CodexInboundServerRequest, "id" | "method" | "params">): PreparedCodexApproval {
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

function prepareCommandApproval(
  requestId: string | number,
  method: ChatCodexApprovalMethod,
  params: Record<string, unknown>
): PreparedCodexApproval {
  const advertised = Array.isArray(params.availableDecisions) ? params.availableDecisions : [];
  const responses: Array<{ option: ChatCodexApprovalOption; response: unknown }> = advertised.flatMap((decision, index) => {
    const normalized = commandDecision(decision);
    if (!normalized) {
      return [];
    }
    const id = commandDecisionId(normalized, index);
    return [{
      option: {
        id,
        label: commandDecisionLabel(normalized),
        outcome: commandDecisionOutcome(normalized)
      } satisfies ChatCodexApprovalOption,
      response: { decision: normalized }
    }];
  });
  // Current v2 requests normally advertise their exact choices. Older v2
  // producers omit the field, in which case the installed string decision
  // union is the documented compatibility fallback. Structured amendments are
  // never invented because their payload must come from availableDecisions.
  if (responses.length === 0) {
    responses.push(...simpleDecisionResponses([
      ["accept", "Allow once", "approve"],
      ["acceptForSession", "Allow for this Codex session", "approve"],
      ["decline", "Deny", "deny"],
      ["cancel", "Cancel", "cancel"]
    ]));
  }
  return prepared({
    kind: "codexApproval",
    method,
    requestId,
    ...commonV2Fields(params),
    action: "command",
    command: boundedString(params.command, MAX_DISPLAY_TEXT),
    cwd: boundedString(params.cwd, MAX_DISPLAY_PATH),
    reason: boundedString(params.reason, MAX_DISPLAY_TEXT),
    permissions: permissionSummary(params.additionalPermissions, params.networkApprovalContext),
    options: responses.map((item) => item.option)
  }, responses);
}

function prepareFileApproval(
  requestId: string | number,
  method: ChatCodexApprovalMethod,
  params: Record<string, unknown>
): PreparedCodexApproval {
  const responses = simpleDecisionResponses([
    ["accept", "Allow once", "approve"],
    ["acceptForSession", "Allow for this Codex session", "approve"],
    ["decline", "Deny", "deny"],
    ["cancel", "Cancel", "cancel"]
  ]);
  const grantRoot = boundedString(params.grantRoot, MAX_DISPLAY_PATH);
  return prepared({
    kind: "codexApproval",
    method,
    requestId,
    ...commonV2Fields(params),
    action: "fileChange",
    cwd: grantRoot,
    grantRoot,
    reason: boundedString(params.reason, MAX_DISPLAY_TEXT),
    options: responses.map((item) => item.option)
  }, responses);
}

function preparePermissionsApproval(
  requestId: string | number,
  method: ChatCodexApprovalMethod,
  params: Record<string, unknown>
): PreparedCodexApproval {
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
    cwd: boundedString(params.cwd, MAX_DISPLAY_PATH),
    reason: boundedString(params.reason, MAX_DISPLAY_TEXT),
    permissions: permissionSummary(params.permissions),
    options: responses.map((item) => item.option)
  }, responses);
}

function prepareLegacyCommandApproval(
  requestId: string | number,
  method: ChatCodexApprovalMethod,
  params: Record<string, unknown>
): PreparedCodexApproval {
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
  const command = Array.isArray(params.command)
    ? params.command.filter((item): item is string => typeof item === "string").join(" ")
    : boundedString(params.command, MAX_DISPLAY_TEXT);
  return prepared({
    kind: "codexApproval",
    method,
    requestId,
    threadId: boundedString(params.conversationId, MAX_DISPLAY_PATH),
    approvalId: boundedString(params.approvalId, MAX_DISPLAY_PATH),
    itemId: boundedString(params.callId, MAX_DISPLAY_PATH),
    action: "command",
    command: boundedString(command, MAX_DISPLAY_TEXT),
    cwd: boundedString(params.cwd, MAX_DISPLAY_PATH),
    reason: boundedString(params.reason, MAX_DISPLAY_TEXT),
    options: responses.map((item) => item.option)
  }, responses);
}

function prepareLegacyFileApproval(
  requestId: string | number,
  method: ChatCodexApprovalMethod,
  params: Record<string, unknown>
): PreparedCodexApproval {
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
    threadId: boundedString(params.conversationId, MAX_DISPLAY_PATH),
    itemId: boundedString(params.callId, MAX_DISPLAY_PATH),
    action: "fileChange",
    reason: boundedString(params.reason, MAX_DISPLAY_TEXT),
    grantRoot: boundedString(params.grantRoot, MAX_DISPLAY_PATH),
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
    threadId: boundedString(params.threadId, MAX_DISPLAY_PATH),
    turnId: boundedString(params.turnId, MAX_DISPLAY_PATH),
    itemId: boundedString(params.itemId, MAX_DISPLAY_PATH),
    approvalId: boundedString(params.approvalId, MAX_DISPLAY_PATH)
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

function commandDecision(value: unknown): unknown | undefined {
  if (value === "accept" || value === "acceptForSession" || value === "decline" || value === "cancel") {
    return value;
  }
  const candidate = record(value);
  if (candidate && record(candidate.acceptWithExecpolicyAmendment)) {
    return { acceptWithExecpolicyAmendment: candidate.acceptWithExecpolicyAmendment };
  }
  if (candidate && record(candidate.applyNetworkPolicyAmendment)) {
    return { applyNetworkPolicyAmendment: candidate.applyNetworkPolicyAmendment };
  }
  return undefined;
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

function commandDecisionOutcome(value: unknown): ChatCodexApprovalOption["outcome"] {
  if (value === "decline") return "deny";
  if (value === "cancel") return "cancel";
  return "approve";
}

function grantedPermissions(value: unknown): Record<string, unknown> {
  const permissions = record(value);
  if (!permissions) return {};
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
  const readPaths = stringArray(fileSystem?.read);
  const writePaths = stringArray(fileSystem?.write);
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
  if (candidate.type === "path") return boundedString(candidate.path, MAX_DISPLAY_PATH);
  if (candidate.type === "glob_pattern") return boundedString(candidate.pattern, MAX_DISPLAY_PATH);
  if (candidate.type === "special") return boundedString(candidate.value, MAX_DISPLAY_PATH);
  return undefined;
}

function fileChangeSummary(value: unknown): ChatCodexFileChangeSummary[] | undefined {
  const changes = record(value);
  if (!changes) return undefined;
  const summary = Object.entries(changes).slice(0, MAX_DISPLAY_ITEMS).map(([path, change]) => {
    const changeType = record(change)?.type;
    return {
      path: path.slice(0, MAX_DISPLAY_PATH),
      change: changeType === "add" || changeType === "delete" || changeType === "update" ? changeType : "unknown"
    } satisfies ChatCodexFileChangeSummary;
  });
  return summary.length > 0 ? summary : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const text = boundedString(item, MAX_DISPLAY_PATH);
        return text ? [text] : [];
      }).slice(0, MAX_DISPLAY_ITEMS)
    : [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)].slice(0, MAX_DISPLAY_ITEMS);
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
