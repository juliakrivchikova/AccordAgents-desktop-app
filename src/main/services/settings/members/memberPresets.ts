import { MAIN_SESSION_ROLE_ID } from "../../../../shared/mainSession";
import { cloudRunSelection } from "../../../../shared/cloudRunPreparation";
import { randomUUID } from "node:crypto";
import type { AppSettings, AgentHealth, ChatParticipantConfig, ChatParticipantConfigUpdate } from "../../../../shared/types";
import { normalizeChatAgentMode, chatAgentPermissionsFromAgent } from "../../../../shared/agentPermissions";
import { normalizeChatReasoningEffort } from "../../../../shared/reasoningEffort";
import { normalizeConcreteRemoteExecutionMode } from "../aws/storedAws";
import { CHAT_HANDLE_PATTERN } from "../constants";
import { SEEDABLE_CHAT_PROVIDER_KINDS } from "./constants";
import { memberUsageEvent } from "./memberUsageEvent";
import { genericSeedParticipant, normalizeSeedState, participantHostIdForUpdate } from "./storedMembers";
import { DEFAULT_CHAT_ROLES } from "../roles/defaultRoles";
import { GENERIC_PARTICIPANT_ROLE_ID } from "../roles/roleIds";
import { autoWatchEnabledForRole } from "../roles/storedRoles";
import { normalizeBehaviorRuleIds } from "../roles/storedRules";
import type { SettingsModules } from "../modules";

/** Saved member presets. */
export class MemberPresets {
  constructor(private readonly settings: Pick<SettingsModules, "memberUsage" | "publicSettings" | "settingsStore">) {}

  async saveChatParticipantConfig(update: ChatParticipantConfigUpdate): Promise<AppSettings> {
    const stored = await this.settings.settingsStore.readStored();
    const participants = stored.chatParticipantConfigs ?? [];
    const roles = stored.chatRoleConfigs ?? DEFAULT_CHAT_ROLES;
    const handle = update.handle.trim().replace(/^@/, "");
    const normalizedId = update.id?.trim();
    if (!CHAT_HANDLE_PATTERN.test(handle)) {
      throw new Error("Member names may use letters, numbers, underscores, and hyphens only.");
    }
    const role = roles.find((item) => item.id === update.roleConfigId);
    if (!role) {
      throw new Error("Select a role for the member.");
    }
    const existingParticipant = normalizedId ? participants.find((participant) => participant.id === normalizedId) : undefined;
    if (role.archivedAt && existingParticipant?.roleConfigId !== role.id) {
      throw new Error(`Deleted role "${role.label}" cannot be assigned to a member.`);
    }
    // Each chat makes its own main session; a saved member is never one.
    if (role.id === MAIN_SESSION_ROLE_ID) {
      throw new Error(`The "${role.label}" role cannot be given to a saved member.`);
    }
    const requestedRuleIds = new Set(normalizeBehaviorRuleIds(update.behaviorRuleIds));
    const behaviorRuleIds = (stored.chatBehaviorRules ?? []).map((rule) => rule.id).filter((id) => requestedRuleIds.has(id));
    if (update.kind !== "codex-cli" && update.kind !== "claude-code" && update.kind !== "gemini-cli") {
      throw new Error("Chat supports local CLI members only.");
    }

    const duplicate = participants.find(
      (participant) => participant.id !== normalizedId && participant.handle.toLowerCase() === handle.toLowerCase()
    );
    if (duplicate) {
      throw new Error(`Duplicate member name: @${handle}.`);
    }

    const now = new Date().toISOString();
    const nextParticipant: ChatParticipantConfig = {
      id: normalizedId || randomUUID(),
      handle,
      roleConfigId: update.roleConfigId,
      behaviorRuleIds,
      kind: update.kind,
      model: update.model?.trim() || undefined,
      reasoningEffort: normalizeChatReasoningEffort(update.reasoningEffort, update.kind),
      avatarId: update.avatarId?.trim() || undefined,
      hostId: participantHostIdForUpdate(stored, update),
      agentMode: normalizeChatAgentMode(update.agentMode),
      permissions: chatAgentPermissionsFromAgent(update.permissions),
      remoteExecution: normalizeConcreteRemoteExecutionMode(update.remoteExecution),
      homeMachineId: typeof update.homeMachineId === "string" && update.homeMachineId.trim() ? update.homeMachineId.trim() : undefined,
      cloudRun: cloudRunSelection(update.cloudRun),
      skipToolchainPreflight: update.skipToolchainPreflight === true,
      autoWatchEnabled: autoWatchEnabledForRole(role, update.autoWatchEnabled),
      updatedAt: now
    };
    stored.chatParticipantConfigs = participants.some((participant) => participant.id === nextParticipant.id)
      ? participants.map((participant) => (participant.id === nextParticipant.id ? nextParticipant : participant))
      : [...participants, nextParticipant];

    await this.settings.settingsStore.writeStored(stored);
    this.settings.memberUsage.notifyUsage(memberUsageEvent(existingParticipant, nextParticipant));
    return this.settings.publicSettings.getPublicSettings();
  }

  async deleteChatParticipantConfig(id: string): Promise<AppSettings> {
    const stored = await this.settings.settingsStore.readStored();
    const normalized = id.trim();
    const seedState = normalizeSeedState(stored.chatParticipantSeedState);
    const now = new Date().toISOString();
    for (const kind of SEEDABLE_CHAT_PROVIDER_KINDS) {
      const seeded = seedState.seededProviders?.[kind];
      if (seeded?.participantConfigId === normalized) {
        seedState.deletedSeedProviders = {
          ...seedState.deletedSeedProviders,
          [kind]: {
            participantConfigId: normalized,
            updatedAt: now
          }
        };
        seedState.seededProviders = { ...seedState.seededProviders };
        delete seedState.seededProviders[kind];
      }
    }
    stored.chatParticipantSeedState = seedState;
    stored.chatParticipantConfigs = (stored.chatParticipantConfigs ?? []).filter((participant) => participant.id !== normalized);
    await this.settings.settingsStore.writeStored(stored);
    return this.settings.publicSettings.getPublicSettings();
  }

  async ensureGenericChatParticipantSeeds(agents: AgentHealth[]): Promise<AppSettings> {
    const stored = await this.settings.settingsStore.readStored();
    const installed = new Set(
      agents
        .filter((agent) => SEEDABLE_CHAT_PROVIDER_KINDS.includes(agent.kind) && agent.installed)
        .map((agent) => agent.kind)
    );
    if (installed.size === 0) {
      return this.settings.publicSettings.getPublicSettings();
    }

    const now = new Date().toISOString();
    const participants = [...(stored.chatParticipantConfigs ?? [])];
    const seedState = normalizeSeedState(stored.chatParticipantSeedState);
    const seededProviders = { ...(seedState.seededProviders ?? {}) };
    const deletedSeedProviders = { ...(seedState.deletedSeedProviders ?? {}) };
    let changed = false;

    for (const kind of SEEDABLE_CHAT_PROVIDER_KINDS) {
      if (!installed.has(kind) || deletedSeedProviders[kind]) {
        continue;
      }

      const seeded = seededProviders[kind];
      if (seeded) {
        if (participants.some((participant) => participant.id === seeded.participantConfigId)) {
          continue;
        }
        deletedSeedProviders[kind] = {
          participantConfigId: seeded.participantConfigId,
          updatedAt: now
        };
        delete seededProviders[kind];
        changed = true;
        continue;
      }

      const existingGeneric = participants.find((participant) =>
        participant.kind === kind && participant.roleConfigId === GENERIC_PARTICIPANT_ROLE_ID
      );
      if (existingGeneric) {
        seededProviders[kind] = {
          participantConfigId: existingGeneric.id,
          updatedAt: now
        };
        changed = true;
        continue;
      }

      const participant = genericSeedParticipant(kind, participants, now);
      participants.push(participant);
      seededProviders[kind] = {
        participantConfigId: participant.id,
        updatedAt: now
      };
      changed = true;
    }

    if (!changed) {
      return this.settings.publicSettings.getPublicSettings();
    }

    stored.chatParticipantConfigs = participants;
    stored.chatParticipantSeedState = {
      seededProviders,
      deletedSeedProviders
    };
    await this.settings.settingsStore.writeStored(stored);
    return this.settings.publicSettings.getPublicSettings();
  }
}
