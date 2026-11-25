import { cloudRunSelection } from "../../../../shared/cloudRunPreparation";
import { randomUUID } from "node:crypto";
import type {
  ChatAgentMode, ChatAgentPermissions, ChatParticipantConfig, ChatParticipantConfigUpdate, ChatParticipantSeedState,
  ChatProviderKind, ChatRoleConfig
} from "../../../../shared/types";
import { newChatMemberPermissions, normalizeChatAgentMode, chatAgentPermissionsFromAgent } from "../../../../shared/agentPermissions";
import { normalizeChatReasoningEffort } from "../../../../shared/reasoningEffort";
import { cliProviderHostCliLabel } from "../../../../shared/cliProviderHosts";
import { normalizeRemoteExecutionMode } from "../aws/storedAws";
import { CHAT_HANDLE_PATTERN } from "../constants";
import { SEEDABLE_CHAT_PROVIDER_KINDS } from "./constants";
import { normalizedCliProviderHosts } from "../providers/storedHosts";
import { GENERIC_PARTICIPANT_ROLE_ID, WORKFLOW_MANAGER_ROLE_ID } from "../roles/roleIds";
import { autoWatchEnabledForRole } from "../roles/storedRoles";
import { normalizeBehaviorRuleIds } from "../roles/storedRules";
import type { StoredSettings } from "../types";

export function normalizeParticipantConfigs(
  participants: ChatParticipantConfig[] | undefined,
  roles: ChatRoleConfig[],
  options: { migrateWorkflowManagerParticipantManagement?: boolean } = {}
): ChatParticipantConfig[] {
  const seenHandles = new Set<string>();
  const roleById = new Map(roles.map((role) => [role.id, role]));
  return (Array.isArray(participants) ? participants : [])
    .filter((participant): participant is ChatParticipantConfig => {
      const handle = typeof participant.handle === "string" ? participant.handle.trim().replace(/^@/, "") : "";
      const normalized = handle.toLowerCase();
      const kind = participant.kind as ChatProviderKind;
      if (!CHAT_HANDLE_PATTERN.test(handle) || seenHandles.has(normalized) || (kind !== "codex-cli" && kind !== "claude-code" && kind !== "gemini-cli")) {
        return false;
      }
      seenHandles.add(normalized);
      return typeof participant.id === "string" && typeof participant.roleConfigId === "string";
    })
    .map((participant) => {
      const permissions = chatAgentPermissionsFromAgent((participant as { permissions?: ChatAgentPermissions }).permissions);
      return {
        id: participant.id,
        handle: participant.handle.trim().replace(/^@/, ""),
        roleConfigId: participant.roleConfigId,
        behaviorRuleIds: normalizeBehaviorRuleIds((participant as { behaviorRuleIds?: unknown }).behaviorRuleIds),
        kind: participant.kind,
        model: participant.model?.trim() || undefined,
        reasoningEffort: normalizeChatReasoningEffort((participant as { reasoningEffort?: unknown }).reasoningEffort, participant.kind),
        avatarId: participant.avatarId?.trim() || undefined,
        hostId: typeof (participant as { hostId?: unknown }).hostId === "string"
          ? ((participant as { hostId: string }).hostId.trim() || undefined)
          : undefined,
        agentMode: normalizeChatAgentMode((participant as { agentMode?: ChatAgentMode }).agentMode),
        permissions: options.migrateWorkflowManagerParticipantManagement && participant.roleConfigId === WORKFLOW_MANAGER_ROLE_ID
          ? { ...permissions, manageRolesParticipants: "allow" as const }
          : permissions,
        remoteExecution: normalizeRemoteExecutionMode((participant as { remoteExecution?: unknown }).remoteExecution),
        cloudRun: cloudRunSelection((participant as { cloudRun?: unknown }).cloudRun),
        homeMachineId: typeof (participant as { homeMachineId?: unknown }).homeMachineId === "string" &&
          ((participant as { homeMachineId?: string }).homeMachineId ?? "").trim()
          ? ((participant as { homeMachineId?: string }).homeMachineId ?? "").trim()
          : undefined,
        skipToolchainPreflight: (participant as { skipToolchainPreflight?: unknown }).skipToolchainPreflight === true,
        autoWatchEnabled: autoWatchEnabledForRole(
          roleById.get(participant.roleConfigId) ?? { id: participant.roleConfigId },
          (participant as { autoWatchEnabled?: unknown }).autoWatchEnabled
        ),
        updatedAt: participant.updatedAt || new Date().toISOString()
      };
    });
}

/** A member preset may only be bound to an added provider that exists and
 *  runs through the preset's own CLI. */
export function participantHostIdForUpdate(stored: StoredSettings, update: Pick<ChatParticipantConfigUpdate, "id" | "kind" | "hostId">): string | undefined {
  const hostId = update.hostId?.trim();
  if (!hostId) {
    return undefined;
  }
  const host = normalizedCliProviderHosts(stored).find((item) => item.id === hostId);
  if (!host) {
    // A preset whose provider was removed keeps its dangling binding (so its
    // members fail visibly rather than switch backends) until the user picks
    // another provider; only a new binding to a missing provider is refused.
    const existing = update.id?.trim() ? (stored.chatParticipantConfigs ?? []).find((config) => config.id === update.id?.trim()) : undefined;
    if (existing?.hostId === hostId && existing.kind === update.kind) {
      return hostId;
    }
    throw new Error("That provider no longer exists. Pick another provider for the member.");
  }
  if (host.cli !== update.kind) {
    throw new Error(`${host.label} runs through ${cliProviderHostCliLabel(host.cli)}, not the member's CLI.`);
  }
  return host.id;
}

export function normalizeSeedState(value: unknown): ChatParticipantSeedState {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<ChatParticipantSeedState>
    : {};
  return {
    seededProviders: normalizeSeedRecords(record.seededProviders),
    deletedSeedProviders: normalizeSeedRecords(record.deletedSeedProviders)
  };
}

function normalizeSeedRecords(value: unknown): Partial<Record<ChatProviderKind, { participantConfigId: string; updatedAt: string }>> {
  const records: Partial<Record<ChatProviderKind, { participantConfigId: string; updatedAt: string }>> = {};
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<Record<ChatProviderKind, { participantConfigId?: unknown; updatedAt?: unknown }>>
    : {};
  for (const kind of SEEDABLE_CHAT_PROVIDER_KINDS) {
    const item = source[kind];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const participantConfigId = typeof item.participantConfigId === "string" ? item.participantConfigId.trim() : "";
    if (!participantConfigId) {
      continue;
    }
    records[kind] = {
      participantConfigId,
      updatedAt: typeof item.updatedAt === "string" && item.updatedAt.trim()
        ? item.updatedAt
        : new Date().toISOString()
    };
  }
  return records;
}

export function genericSeedParticipant(kind: ChatProviderKind, participants: ChatParticipantConfig[], now: string): ChatParticipantConfig {
  const baseHandle = kind === "codex-cli" ? "codex" : kind === "gemini-cli" ? "gemini" : "claude";
  return {
    id: randomUUID(),
    handle: uniqueParticipantConfigHandle(baseHandle, participants),
    roleConfigId: GENERIC_PARTICIPANT_ROLE_ID,
    behaviorRuleIds: [],
    kind,
    avatarId: kind === "codex-cli" ? "codex-logo" : kind === "gemini-cli" ? "gemini-logo" : "claude-logo",
    agentMode: "default",
    // A chat with a project gives it repoRead (seededParticipantInputs).
    permissions: newChatMemberPermissions(false),
    updatedAt: now
  };
}

function uniqueParticipantConfigHandle(base: string, participants: ChatParticipantConfig[]): string {
  const existing = new Set(participants.map((participant) => participant.handle.toLowerCase()));
  const normalizedBase = base.trim().replace(/^@/, "") || "participant";
  if (!existing.has(normalizedBase.toLowerCase())) {
    return normalizedBase;
  }
  let suffix = 2;
  while (existing.has(`${normalizedBase}-${suffix}`.toLowerCase())) {
    suffix += 1;
  }
  return `${normalizedBase}-${suffix}`;
}
