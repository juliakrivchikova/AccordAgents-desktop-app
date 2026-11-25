import type { ChatCodexApprovalMethod } from "../../../shared/types";
import {
  assertOnlyKeys, optionalNullableString, requiredNullableString, requiredNumber, requiredRecord, requiredString,
  requiredStringArray, requiredStringValue
} from "./fields";

export function validateApprovalParams(method: ChatCodexApprovalMethod, params: Record<string, unknown>): void {
  if (method === "item/commandExecution/requestApproval") return validateCommandApprovalParams(params);
  if (method === "item/fileChange/requestApproval") return validateFileApprovalParams(params);
  if (method === "item/permissions/requestApproval") return validatePermissionsApprovalParams(params);
  if (method === "execCommandApproval") return validateLegacyCommandApprovalParams(params);
  if (method === "applyPatchApproval") return validateLegacyFileApprovalParams(params);
  throw new Error(`${method} is not a direct Codex approval request.`);
}

export function validateCommandApprovalParams(params: Record<string, unknown>): void {
  assertOnlyKeys(params, [
    "threadId", "turnId", "itemId", "startedAtMs", "approvalId", "environmentId", "reason",
    "networkApprovalContext", "command", "cwd", "commandActions", "additionalPermissions",
    "proposedExecpolicyAmendment", "proposedNetworkPolicyAmendments", "availableDecisions", "kind"
  ], "item/commandExecution/requestApproval params");
  // Codex 0.155.1 says what is under review: a command, or input sent to a
  // terminal it already runs ("command" when absent, from older servers).
  if (params.kind !== undefined && params.kind !== null && params.kind !== "command" && params.kind !== "writeStdin") {
    throw new Error("kind must be \"command\" or \"writeStdin\".");
  }
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

export function validateFileApprovalParams(params: Record<string, unknown>): void {
  assertOnlyKeys(params, ["threadId", "turnId", "itemId", "startedAtMs", "reason", "grantRoot", "fileChanges"], "item/fileChange/requestApproval params");
  validateV2Identity(params);
  requiredNumber(params.startedAtMs, "startedAtMs");
  optionalNullableString(params.reason, "reason");
  optionalNullableString(params.grantRoot, "grantRoot");
  if (params.fileChanges !== undefined && !Array.isArray(params.fileChanges)) {
    throw new Error("fileChanges correlation summary must be an array when present.");
  }
}

export function validatePermissionsApprovalParams(params: Record<string, unknown>): void {
  assertOnlyKeys(params, ["threadId", "turnId", "itemId", "environmentId", "startedAtMs", "cwd", "reason", "permissions"], "item/permissions/requestApproval params");
  validateV2Identity(params);
  requiredNullableString(params.environmentId, "environmentId");
  requiredNumber(params.startedAtMs, "startedAtMs");
  requiredStringValue(params.cwd, "cwd");
  requiredNullableString(params.reason, "reason");
  validatePermissionProfile(params.permissions, "permissions");
}

export function validateLegacyCommandApprovalParams(params: Record<string, unknown>): void {
  assertOnlyKeys(params, ["conversationId", "callId", "approvalId", "command", "cwd", "reason", "parsedCmd"], "execCommandApproval params");
  requiredString(params.conversationId, "conversationId");
  requiredString(params.callId, "callId");
  requiredNullableString(params.approvalId, "approvalId");
  requiredStringArray(params.command, "command");
  requiredStringValue(params.cwd, "cwd");
  requiredNullableString(params.reason, "reason");
  validateCommandActions(params.parsedCmd, "parsedCmd", true);
}

export function validateLegacyFileApprovalParams(params: Record<string, unknown>): void {
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

export function validateNetworkPolicyAmendment(value: unknown, field: string): Record<string, unknown> {
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

export function validatePermissionProfile(value: unknown, field: string): void {
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
