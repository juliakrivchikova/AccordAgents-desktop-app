import { randomUUID } from "node:crypto";
import type {
  ChatAgentPermissions, ChatAppToolApproval, ChatExistingParticipantOverrides, ChatParticipant, ChatParticipantChangeOperation,
  ChatParticipantChangeRequest, ChatProviderKind, ChatRoleChangeOperation, ChatRoleChangeRequest, ChatRoleConfig,
  ChatRoleParticipantChangeRequest, ChatRosterChangeRequest, ChatRosterCurrentParticipant, Conversation
} from "../../../../shared/types";
import { normalizeChatReasoningEffort } from "../../../../shared/reasoningEffort";
import {
  chatAgentModeFromAgent, chatAgentPermissionsFromAgent, chatParticipantRequestPermissionExceeds, normalizeChatAgentMode,
  normalizeChatAgentPermissions, normalizeChatRoleManagementPermission, normalizeOptionalChatParticipantRequestPermission
} from "../../../../shared/agentPermissions";
import { normalizeChatAppToolCapabilities } from "../../../../shared/appTools";
import { preservedRemoteExecution } from "../../../../shared/chatParticipantHome";
import { APP_ROLES_REQUEST_CHANGE_TOOL } from "../../appMcp";
import { chatAppToolApprovals, isRoleChangeRequest, isRoleParticipantChangeRequest } from "../approvals/approvalRecords";
import { GENERIC_PARTICIPANT_ROLE_ID } from "../constants";
import { CHAT_ROSTER_CHANGE_MAX_OPERATIONS } from "./constants";
import { chatParticipants, normalizeBehaviorRuleIds, normalizeRoleParticipantDefaults, roleLabelForParticipant } from "./identity";
import { manageRolesParticipantsResolutionForRole } from "./roleRuntime";
import type { ParticipantRemovalInput } from "./types";

const CHAT_ROLE_LABEL_MAX_CHARS = 80;
const CHAT_ROLE_INSTRUCTIONS_MAX_CHARS = 40_000;

/** The rights the main session asks for its member: what it names, and
 *  its own for the rest; leave to ask members "allow" unless it names one
 *  (it may always ask the main session, as far as the main session itself
 *  may ask), and managing members only when named. Clamped afterwards. */
export function delegationRequestedPermissions(given: Record<string, unknown> | undefined, ceiling: ChatAgentPermissions): ChatAgentPermissions {
  // Codex's Plan mode is the main session's own way of working, not a
  // right: a member it makes starts without it.
  const { manageRolesParticipants: _ownManage, codexPlanMode: _plan, ...inherited } = ceiling;
  const merged: Record<string, unknown> = { ...inherited, requestParticipants: "allow" };
  if (given) {
    for (const key of ["repoRead", "workspaceWrite", "webAccess"] as const) {
      if (typeof given[key] === "boolean") merged[key] = given[key];
    }
    for (const key of ["requestParticipants", "requestCompaction", "manageRolesParticipants"] as const) {
      const value = normalizeOptionalChatParticipantRequestPermission(given[key]);
      if (value) merged[key] = value;
    }
    if (given.shell && typeof given.shell === "object" && !Array.isArray(given.shell)) {
      const shell = given.shell as { enabled?: unknown; rules?: unknown };
      merged.shell = {
        enabled: typeof shell.enabled === "boolean" ? shell.enabled : inherited.shell.enabled,
        rules: Array.isArray(shell.rules) ? shell.rules : inherited.shell.rules
      };
    }
    if ("providerNative" in given) merged.providerNative = given.providerNative;
  }
  return normalizeChatAgentPermissions(merged);
}

/** A delegated member's name when the main session gives none: its role's
 *  (code-reviewer), or its CLI's for the generic role. */
export function delegatedMemberHandleBase(role: ChatRoleConfig, kind: ChatProviderKind): string {
  if (role.id === GENERIC_PARTICIPANT_ROLE_ID) {
    return kind === "codex-cli" ? "codex" : kind === "gemini-cli" ? "gemini" : "claude";
  }
  const slug = role.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  return slug || "member";
}

/** The removals of a member change request and the rest of it (additions),
 *  or no removal when it asks for additions only. */
export function splitParticipantRemovalInput(raw: unknown): { removal?: ParticipantRemovalInput; additions?: Record<string, unknown>; additionNumbers?: number[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const record = raw as Record<string, unknown> & { reason?: unknown; operations?: unknown };
  if (!Array.isArray(record.operations)) {
    return {};
  }
  const operations: unknown[] = record.operations;
  const isRemoval = (operation: unknown): boolean =>
    Boolean(operation && typeof operation === "object" && (operation as { type?: unknown }).type === "remove_participant_from_chat");
  if (!operations.some(isRemoval)) {
    return {};
  }
  if (operations.length > CHAT_ROSTER_CHANGE_MAX_OPERATIONS) {
    throw new Error("Member change request is too large.");
  }
  const targets: ParticipantRemovalInput["targets"] = [];
  for (const [index, operation] of operations.entries()) {
    if (!isRemoval(operation)) continue;
    const operationRecord = operation as Record<string, unknown>;
    const participantId = typeof operationRecord.participantId === "string" ? operationRecord.participantId.trim() : "";
    const handle = typeof operationRecord.handle === "string" ? operationRecord.handle.trim().replace(/^@/, "") : "";
    if (!participantId && !handle) {
      throw new Error(`Member operation ${index + 1} needs the participantId or handle of the member to remove.`);
    }
    targets.push({ ...(participantId ? { participantId } : { handle }), operationNumber: index + 1 });
  }
  const rest = operations.filter((operation) => !isRemoval(operation));
  const additionNumbers = operations.flatMap((operation, index) => isRemoval(operation) ? [] : [index + 1]);
  return {
    removal: {
      reason: typeof record.reason === "string" ? record.reason.trim().slice(0, 500) || undefined : undefined,
      targets
    },
    ...(rest.length > 0 ? { additions: { ...record, operations: rest }, additionNumbers } : {})
  };
}

export function rosterParticipantSummary(conversation: Conversation, participant: ChatParticipant): ChatRosterCurrentParticipant {
  return {
    id: participant.id,
    participantConfigId: participant.participantConfigId,
    handle: participant.handle,
    roleConfigId: participant.roleConfigId,
    roleLabel: roleLabelForParticipant(conversation, participant),
    behaviorRuleIds: normalizeBehaviorRuleIds(participant.behaviorRuleIds),
    kind: participant.kind,
    hostId: participant.hostId,
    model: participant.model,
    reasoningEffort: participant.reasoningEffort,
    agentMode: normalizeChatAgentMode(participant.agentMode),
    remoteExecution: preservedRemoteExecution(participant.remoteExecution),
    homeMachineId: participant.homeMachineId || undefined,
    cloudRun: participant.cloudRun,
    skipToolchainPreflight: participant.skipToolchainPreflight === true,
    autoWatch: participant.autoWatch === true
  };
}

export function normalizeRosterChangeRequest(raw: unknown): ChatRosterChangeRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Roster change request must be an object.");
  }
  const record = raw as { reason?: unknown; operations?: unknown };
  if (!Array.isArray(record.operations) || record.operations.length === 0) {
    throw new Error("Roster change request needs at least one operation.");
  }
  if (record.operations.length > CHAT_ROSTER_CHANGE_MAX_OPERATIONS) {
    throw new Error("Roster change request is too large.");
  }
  return {
    reason: typeof record.reason === "string" ? record.reason.trim().slice(0, 500) || undefined : undefined,
    operations: record.operations.map((operation, index) => {
      if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
        throw new Error(`Roster operation ${index + 1} must be an object.`);
      }
      const operationRecord = operation as { type?: unknown; participant?: unknown };
      if (operationRecord.type !== "add") {
        throw new Error("Only add roster operations are supported in this version.");
      }
      const participant = operationRecord.participant;
      if (!participant || typeof participant !== "object" || Array.isArray(participant)) {
        throw new Error(`Roster operation ${index + 1} needs a member object.`);
      }
      const participantRecord = participant as Record<string, unknown>;
      const handle = typeof participantRecord.handle === "string" ? participantRecord.handle.trim() : "";
      const roleConfigId = typeof participantRecord.roleConfigId === "string" ? participantRecord.roleConfigId.trim() : "";
      const kind = participantRecord.kind;
      if (kind !== "codex-cli" && kind !== "claude-code" && kind !== "gemini-cli") {
        throw new Error(`Roster operation ${index + 1} has an unsupported CLI kind.`);
      }
      return {
        type: "add",
        participant: {
          participantConfigId: typeof participantRecord.participantConfigId === "string"
            ? participantRecord.participantConfigId.trim() || undefined
            : undefined,
          handle,
          roleConfigId,
          behaviorRuleIds: normalizeBehaviorRuleIds(participantRecord.behaviorRuleIds),
          kind,
          model: typeof participantRecord.model === "string" ? participantRecord.model.trim() || undefined : undefined,
          reasoningEffort: normalizeChatReasoningEffort(participantRecord.reasoningEffort, kind),
          avatarId: typeof participantRecord.avatarId === "string" ? participantRecord.avatarId.trim() || undefined : undefined,
          hostId: typeof participantRecord.hostId === "string" ? participantRecord.hostId.trim() || undefined : undefined,
          // Full Access only by the User's own choice, never by a tool's input.
          agentMode: chatAgentModeFromAgent(participantRecord.agentMode),
          permissions: chatAgentPermissionsFromAgent(participantRecord.permissions),
          remoteExecution: preservedRemoteExecution(participantRecord.remoteExecution),
          skipToolchainPreflight: participantRecord.skipToolchainPreflight === true,
          autoWatch: participantRecord.autoWatch === true
        }
      };
    })
  };
}

/** Members prepared against an earlier read, checked against the chat as
 *  it is now (the User or another member may have added some since), as
 *  validateParticipants checks them: a name already taken is refused; a
 *  second watcher joins without watching. Callers check before writing
 *  anything else, such as saved member presets. */
export function fitRosterAdditions(conversation: Conversation, additions: ChatParticipant[]): ChatParticipant[] {
  const participants = chatParticipants(conversation);
  const handles = new Set(participants.map((participant) => participant.handle.toLowerCase()));
  const ids = new Set(participants.map((participant) => participant.id));
  let watcherAssigned = participants.some((participant) => participant.autoWatch === true);
  return additions.map((participant) => {
    const handle = participant.handle.toLowerCase();
    if (handles.has(handle) || ids.has(participant.id)) {
      throw new Error(`Duplicate member name: @${participant.handle}.`);
    }
    handles.add(handle);
    ids.add(participant.id);
    if (participant.autoWatch !== true) {
      return participant;
    }
    if (watcherAssigned) {
      return { ...participant, autoWatch: false };
    }
    watcherAssigned = true;
    return participant;
  });
}

export function normalizeRoleChangeRequest(raw: unknown): ChatRoleChangeRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Role change request must be an object.");
  }
  const record = raw as { reason?: unknown; operations?: unknown };
  if (!Array.isArray(record.operations) || record.operations.length === 0) {
    throw new Error("Role change request needs at least one operation.");
  }
  if (record.operations.length > 4) {
    throw new Error("Role change request is too large.");
  }
  return {
    reason: typeof record.reason === "string" ? record.reason.trim().slice(0, 500) || undefined : undefined,
    operations: record.operations.map((operation, index): ChatRoleChangeOperation => {
      if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
        throw new Error(`Role operation ${index + 1} must be an object.`);
      }
      const operationRecord = operation as { type?: unknown; role?: unknown };
      if (
        operationRecord.type !== "create_role" &&
        operationRecord.type !== "edit_role" &&
        operationRecord.type !== "archive_role"
      ) {
        throw new Error(`Role operation ${index + 1} has an unsupported type.`);
      }
      if (!operationRecord.role || typeof operationRecord.role !== "object" || Array.isArray(operationRecord.role)) {
        throw new Error(`Role operation ${index + 1} needs a role object.`);
      }
      const role = operationRecord.role as Record<string, unknown>;
      if (operationRecord.type === "archive_role") {
        const roleConfigId = typeof role.roleConfigId === "string" ? role.roleConfigId.trim() : "";
        if (!roleConfigId) {
          throw new Error(`Role operation ${index + 1} needs roleConfigId.`);
        }
        return { type: "archive_role", role: { roleConfigId } };
      }
      const label = typeof role.label === "string" ? role.label.trim() : "";
      const instructions = typeof role.instructions === "string" ? role.instructions.trim() : "";
      if (!label) {
        throw new Error(`Role operation ${index + 1} needs a role label.`);
      }
      if (label.length > CHAT_ROLE_LABEL_MAX_CHARS) {
        throw new Error(`Role operation ${index + 1} label must be ${CHAT_ROLE_LABEL_MAX_CHARS} characters or less.`);
      }
      if (!instructions) {
        throw new Error(`Role operation ${index + 1} needs role instructions.`);
      }
      if (instructions.length > CHAT_ROLE_INSTRUCTIONS_MAX_CHARS) {
        throw new Error(`Role operation ${index + 1} instructions must be ${CHAT_ROLE_INSTRUCTIONS_MAX_CHARS} characters or less.`);
      }
      const participantDefaults = Object.prototype.hasOwnProperty.call(role, "participantDefaults")
        ? normalizeRoleParticipantDefaults(role.participantDefaults)
        : undefined;
      if (operationRecord.type === "edit_role") {
        const roleConfigId = typeof role.roleConfigId === "string" ? role.roleConfigId.trim() : "";
        if (!roleConfigId) {
          throw new Error(`Role operation ${index + 1} needs roleConfigId.`);
        }
        return {
          type: "edit_role",
          role: {
            roleConfigId,
            label,
            instructions,
            ...(Object.prototype.hasOwnProperty.call(role, "participantDefaults")
              ? { participantDefaults }
              : {})
            // Omit appToolCapabilities: Chat Assistant must never change a role's powers.
            // Leaving it undefined makes the settings save preserve the role's existing
            // capabilities instead of stripping them to [] (settings.ts editChatRoleConfigs).
          }
        };
      }
      return {
        type: "create_role",
        role: {
          draftRoleRef: normalizeDraftRoleRef(role.draftRoleRef, label),
          label,
          instructions,
          // New agent-created roles start with no app-tool capabilities. Built-in roles set
          // capabilities in code, never through this tool, so admin powers can't be granted here.
          appToolCapabilities: [],
          ...(Object.prototype.hasOwnProperty.call(role, "participantDefaults")
            ? { participantDefaults }
            : {})
        }
      };
    })
  };
}

function normalizeDraftRoleRef(value: unknown, label: string): string {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (/^draft-role-[A-Za-z0-9_-]{1,80}$/.test(normalized)) {
      return normalized;
    }
  }
  const slug = (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "role"
  );
  return `draft-role-${slug}-${randomUUID().slice(0, 8)}`;
}

export function temporaryRolesForRoleRequest(request: ChatRoleChangeRequest): ChatRoleConfig[] {
  const now = new Date().toISOString();
  return request.operations
    .filter((operation): operation is Extract<ChatRoleChangeOperation, { type: "create_role" }> => operation.type === "create_role")
    .map((operation) => {
      const participantDefaults = normalizeRoleParticipantDefaults(operation.role.participantDefaults);
      return {
        id: operation.role.draftRoleRef ?? normalizeDraftRoleRef(undefined, operation.role.label),
        label: operation.role.label,
        instructions: operation.role.instructions,
        version: 1,
        builtIn: false,
        appToolCapabilities: normalizeChatAppToolCapabilities(operation.role.appToolCapabilities),
        participantDefaults,
        updatedAt: now
      };
    });
}

export function pendingRoleApprovalForParticipantRequest(
  conversation: Conversation,
  requester: ChatParticipant,
  request: ChatParticipantChangeRequest
): { approval: ChatAppToolApproval; roleRequest: ChatRoleChangeRequest } | undefined {
  const requestedRoleIds = new Set(
    request.operations
      .filter((operation): operation is Extract<ChatParticipantChangeOperation, { type: "add_new_participant_to_chat" }> =>
        operation.type === "add_new_participant_to_chat"
      )
      .map((operation) => operation.participant.roleConfigId)
  );
  if (requestedRoleIds.size === 0) {
    return undefined;
  }
  const matches = chatAppToolApprovals(conversation)
    .filter((approval) =>
      approval.status === "pending" &&
      approval.toolName === APP_ROLES_REQUEST_CHANGE_TOOL &&
      approval.requesterParticipantId === requester.id &&
      isRoleChangeRequest(approval.request)
    )
    .map((approval) => ({
      approval,
      roleRequest: approval.request as ChatRoleChangeRequest,
      refs: new Set(temporaryRolesForRoleRequest(approval.request as ChatRoleChangeRequest).map((role) => role.id))
    }))
    .filter((candidate) => Array.from(requestedRoleIds).some((roleId) => candidate.refs.has(roleId)));
  if (matches.length > 1) {
    throw new Error("Member request references roles from multiple pending role approvals.");
  }
  return matches[0]
    ? { approval: matches[0].approval, roleRequest: matches[0].roleRequest }
    : undefined;
}

export function normalizeRoleParticipantChangeRequest(raw: unknown): ChatRoleParticipantChangeRequest {
  if (!isRoleParticipantChangeRequest(raw)) {
    throw new Error("Role and member request must include roleRequest and participantRequest.");
  }
  const record = raw as ChatRoleParticipantChangeRequest;
  return {
    kind: "role_participant_change",
    reason: typeof record.reason === "string" ? record.reason.trim().slice(0, 500) || undefined : undefined,
    roleRequest: normalizeRoleChangeRequest(record.roleRequest),
    participantRequest: normalizeParticipantChangeRequest(record.participantRequest)
  };
}

export function roleChangeSummary(operations: ChatRoleChangeOperation[], roles: ChatRoleConfig[]): string {
  const labels = operations.map((operation) => {
    if (operation.type === "create_role") {
      return `create role "${operation.role.label}"`;
    }
    if (operation.type === "archive_role") {
      const label = roles.find((role) => role.id === operation.role.roleConfigId)?.label ?? operation.role.roleConfigId;
      return `delete role "${label}"`;
    }
    return `edit role "${operation.role.label}"`;
  });
  return labels.length === 1
    ? labels[0][0].toUpperCase() + labels[0].slice(1)
    : `Apply ${operations.length} role changes`;
}

export function roleChangeManagementEscalates(request: ChatRoleChangeRequest, roles: ChatRoleConfig[]): boolean {
  return request.operations.some((operation) => {
    if (operation.type === "archive_role") {
      return false;
    }
    if (operation.type === "create_role") {
      const nextDefault = normalizeChatRoleManagementPermission(operation.role.participantDefaults?.manageRolesParticipants);
      return chatParticipantRequestPermissionExceeds(nextDefault, "deny");
    }
    const existing = roles.find((role) => role.id === operation.role.roleConfigId);
    const previousDefault = normalizeChatRoleManagementPermission(existing?.participantDefaults?.manageRolesParticipants);
    const nextDefault = Object.prototype.hasOwnProperty.call(operation.role, "participantDefaults")
      ? normalizeChatRoleManagementPermission(operation.role.participantDefaults?.manageRolesParticipants)
      : previousDefault;
    return chatParticipantRequestPermissionExceeds(nextDefault, previousDefault);
  });
}

export function participantManagementChangeEscalates(
  role: ChatRoleConfig | undefined,
  nextPermissions: unknown,
  previousPermissions?: unknown
): boolean {
  const next = manageRolesParticipantsResolutionForRole(role, nextPermissions);
  if (next.exceedsRoleDefault) {
    return true;
  }
  if (previousPermissions === undefined) {
    return false;
  }
  const previous = manageRolesParticipantsResolutionForRole(role, previousPermissions);
  return chatParticipantRequestPermissionExceeds(next.effective, previous.effective);
}

export function normalizeParticipantChangeRequest(raw: unknown): ChatParticipantChangeRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Member change request must be an object.");
  }
  const record = raw as { reason?: unknown; operations?: unknown };
  if (!Array.isArray(record.operations) || record.operations.length === 0) {
    throw new Error("Member change request needs at least one operation.");
  }
  if (record.operations.length > CHAT_ROSTER_CHANGE_MAX_OPERATIONS) {
    throw new Error("Member change request is too large.");
  }
  return {
    reason: typeof record.reason === "string" ? record.reason.trim().slice(0, 500) || undefined : undefined,
    operations: record.operations.map((operation, index): ChatParticipantChangeOperation => {
      if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
        throw new Error(`Member operation ${index + 1} must be an object.`);
      }
      const operationRecord = operation as Record<string, unknown>;
      if (operationRecord.type === "add_existing_participant_to_chat") {
        const participantConfigId = typeof operationRecord.participantConfigId === "string"
          ? operationRecord.participantConfigId.trim()
          : "";
        if (!participantConfigId) {
          throw new Error(`Member operation ${index + 1} needs participantConfigId.`);
        }
        const overrides = normalizeExistingParticipantOverrides(operationRecord.overrides);
        return {
          type: "add_existing_participant_to_chat",
          participantConfigId,
          ...(overrides ? { overrides } : {})
        };
      }
      if (operationRecord.type !== "add_new_participant_to_chat") {
        throw new Error(`Member operation ${index + 1} has an unsupported type.`);
      }
      const participant = operationRecord.participant;
      if (!participant || typeof participant !== "object" || Array.isArray(participant)) {
        throw new Error(`Member operation ${index + 1} needs a member object.`);
      }
      const participantRecord = participant as Record<string, unknown>;
      const kind = participantRecord.kind;
      if (kind !== "codex-cli" && kind !== "claude-code" && kind !== "gemini-cli") {
        throw new Error(`Member operation ${index + 1} has an unsupported CLI kind.`);
      }
      const roleConfigId = typeof participantRecord.roleConfigId === "string" ? participantRecord.roleConfigId.trim() : "";
      const permissionsProvided = Object.prototype.hasOwnProperty.call(participantRecord, "permissions");
      return {
        type: "add_new_participant_to_chat",
        saveAsPreset: operationRecord.saveAsPreset !== false,
        participant: {
          participantConfigId: typeof participantRecord.participantConfigId === "string"
            ? participantRecord.participantConfigId.trim() || undefined
            : undefined,
          handle: typeof participantRecord.handle === "string" ? participantRecord.handle.trim() : "",
          roleConfigId,
          behaviorRuleIds: normalizeBehaviorRuleIds(participantRecord.behaviorRuleIds),
          kind,
          model: typeof participantRecord.model === "string" ? participantRecord.model.trim() || undefined : undefined,
          reasoningEffort: normalizeChatReasoningEffort(participantRecord.reasoningEffort, kind),
          avatarId: typeof participantRecord.avatarId === "string" ? participantRecord.avatarId.trim() || undefined : undefined,
          hostId: typeof participantRecord.hostId === "string" ? participantRecord.hostId.trim() || undefined : undefined,
          // Full Access only by the User's own choice, never by a tool's input.
          agentMode: chatAgentModeFromAgent(participantRecord.agentMode),
          permissions: permissionsProvided
            ? chatAgentPermissionsFromAgent(participantRecord.permissions)
            : undefined,
          remoteExecution: preservedRemoteExecution(participantRecord.remoteExecution),
          skipToolchainPreflight: participantRecord.skipToolchainPreflight === true,
          autoWatch: typeof participantRecord.autoWatch === "boolean" ? participantRecord.autoWatch : undefined
        }
      };
    })
  };
}

// Chat-level overrides for an existing saved participant. Returns undefined when no
// recognizable override is present so the preset's own values are used unchanged.
function normalizeExistingParticipantOverrides(raw: unknown): ChatExistingParticipantOverrides | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (!("model" in record) && !("reasoningEffort" in record) && !("agentMode" in record) && !("permissions" in record) && !("remoteExecution" in record) && !("skipToolchainPreflight" in record) && !("autoWatch" in record)) {
    return undefined;
  }
  const overrides: ChatExistingParticipantOverrides = {};
  if ("model" in record) {
    overrides.model = typeof record.model === "string" ? record.model.trim() || undefined : undefined;
  }
  if ("reasoningEffort" in record) {
    overrides.reasoningEffort = normalizeChatReasoningEffort(record.reasoningEffort);
  }
  if ("agentMode" in record) {
    overrides.agentMode = chatAgentModeFromAgent(record.agentMode);
  }
  if ("permissions" in record) {
    overrides.permissions = chatAgentPermissionsFromAgent(record.permissions);
  }
  if ("remoteExecution" in record) {
    overrides.remoteExecution = preservedRemoteExecution(record.remoteExecution);
  }
  if ("skipToolchainPreflight" in record) {
    overrides.skipToolchainPreflight = record.skipToolchainPreflight === true;
  }
  if ("autoWatch" in record) {
    overrides.autoWatch = record.autoWatch === true;
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}
