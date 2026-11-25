import { randomUUID } from "node:crypto";
import type {
  AppSettings, ChatParticipantConfig, ChatParticipantConfigUpdate, ChatRoleChangeOperation, ChatRoleConfigUpdate
} from "../../../../shared/types";
import { normalizeChatAgentMode, chatAgentPermissionsFromAgent } from "../../../../shared/agentPermissions";
import { normalizeChatAppToolCapabilities } from "../../../../shared/appTools";
import { normalizeChatReasoningEffort } from "../../../../shared/reasoningEffort";
import { normalizeConcreteRemoteExecutionMode } from "../aws/storedAws";
import { CHAT_HANDLE_PATTERN } from "../constants";
import { memberUsageEvent, type SettingsUsageEvent } from "../members/memberUsageEvent";
import { participantHostIdForUpdate } from "../members/storedMembers";
import { DEFAULT_CHAT_ROLES } from "./defaultRoles";
import { CHAT_ROLE_INSTRUCTIONS_MAX_CHARS, CHAT_ROLE_LABEL_MAX_CHARS } from "./roleIds";
import {
  autoWatchEnabledForRole, normalizeRoleParticipantDefaults, normalizeRoleParticipantDefaultsForRole, roleIdFromLabel,
  roleParticipantUsageCount, uniqueRoleId
} from "./storedRoles";
import { normalizeBehaviorRuleIds } from "./storedRules";
import type { SettingsModules } from "../modules";

/** Roles: saved, archived, and saved together with their members. */
export class RoleConfigs {
  constructor(private readonly settings: Pick<SettingsModules, "memberUsage" | "publicSettings" | "settingsStore">) {}

  async saveChatRoleConfig(update: ChatRoleConfigUpdate): Promise<AppSettings> {
    const stored = await this.settings.settingsStore.readStored();
    const label = update.label.trim();
    const instructions = update.instructions.trim();
    if (!label) {
      throw new Error("Role label is required.");
    }
    if (label.length > CHAT_ROLE_LABEL_MAX_CHARS) {
      throw new Error(`Role label must be ${CHAT_ROLE_LABEL_MAX_CHARS} characters or less.`);
    }
    if (!instructions) {
      throw new Error("Role instructions are required.");
    }
    if (instructions.length > CHAT_ROLE_INSTRUCTIONS_MAX_CHARS) {
      throw new Error(`Role instructions must be ${CHAT_ROLE_INSTRUCTIONS_MAX_CHARS} characters or less.`);
    }

    const roles = stored.chatRoleConfigs ?? DEFAULT_CHAT_ROLES;
    const now = new Date().toISOString();
    const existing = update.id ? roles.find((role) => role.id === update.id) : undefined;
    const participantDefaultsProvided = Object.prototype.hasOwnProperty.call(update, "participantDefaults");
    const participantDefaults = normalizeRoleParticipantDefaultsForRole(
      {
        id: existing?.id ?? "",
        appToolCapabilities: update.appToolCapabilities
      },
      update.participantDefaults,
      { inferLegacyManage: !participantDefaultsProvided }
    );
    if (existing) {
      if (existing.archivedAt) {
        throw new Error(`Deleted role "${existing.label}" cannot be edited.`);
      }
      stored.chatRoleConfigs = roles.map((role) =>
        role.id === existing.id
          ? {
              ...role,
              label,
              instructions,
              appToolCapabilities: update.appToolCapabilities === undefined
                ? role.appToolCapabilities
                : normalizeChatAppToolCapabilities(update.appToolCapabilities),
              participantDefaults: participantDefaultsProvided
                ? normalizeRoleParticipantDefaultsForRole(role, participantDefaults, { inferLegacyManage: false })
                : normalizeRoleParticipantDefaultsForRole(role, role.participantDefaults),
              version: role.version + 1,
              updatedAt: now
            }
          : role
      );
    } else {
      const baseId = roleIdFromLabel(label);
      let id = baseId;
      let suffix = 2;
      while (roles.some((role) => role.id === id)) {
        id = `${baseId}-${suffix}`;
        suffix += 1;
      }
      stored.chatRoleConfigs = [
        ...roles,
        {
          id,
          label,
          instructions,
          version: 1,
          builtIn: false,
          appToolCapabilities: normalizeChatAppToolCapabilities(update.appToolCapabilities),
          participantDefaults: normalizeRoleParticipantDefaultsForRole(
            { id, appToolCapabilities: update.appToolCapabilities },
            participantDefaults,
            { inferLegacyManage: false }
          ),
          updatedAt: now
        }
      ];
    }

    await this.settings.settingsStore.writeStored(stored);
    if (!existing) this.settings.memberUsage.notifyUsage({ kind: "role-created" });
    return this.settings.publicSettings.getPublicSettings();
  }

  // Soft-delete a custom role. The record stays in settings so existing participants
  // keep resolving; it is hidden from the Roles list and pickers by the renderer.
  // Product rule: custom roles only, and only when no saved participant preset uses it.
  async archiveChatRoleConfig(id: string): Promise<AppSettings> {
    const stored = await this.settings.settingsStore.readStored();
    const normalized = id.trim();
    const roles = stored.chatRoleConfigs ?? DEFAULT_CHAT_ROLES;
    const role = roles.find((item) => item.id === normalized);
    if (!role) {
      throw new Error("Unknown role.");
    }
    if (role.builtIn) {
      throw new Error(`Built-in role "${role.label}" cannot be deleted.`);
    }
    if (role.archivedAt) {
      // Idempotent: already archived.
      return this.settings.publicSettings.getPublicSettings();
    }
    const usage = roleParticipantUsageCount(normalized, stored.chatParticipantConfigs ?? []);
    if (usage > 0) {
      throw new Error(
        `Role "${role.label}" is used by ${usage} saved member preset${usage === 1 ? "" : "s"} and cannot be deleted. Reassign or remove them first.`
      );
    }
    const now = new Date().toISOString();
    stored.chatRoleConfigs = roles.map((item) => (item.id === normalized ? { ...item, archivedAt: now } : item));
    await this.settings.settingsStore.writeStored(stored);
    return this.settings.publicSettings.getPublicSettings();
  }

  async saveChatRoleParticipantConfigBatch(
    roleOperations: ChatRoleChangeOperation[],
    participantUpdates: ChatParticipantConfigUpdate[]
  ): Promise<{ settings: AppSettings; roleIdByDraftRoleRef: Record<string, string> }> {
    const stored = await this.settings.settingsStore.readStored();
    const now = new Date().toISOString();
    let roles = [...(stored.chatRoleConfigs ?? DEFAULT_CHAT_ROLES)];
    const roleIdByDraftRoleRef: Record<string, string> = {};

    for (const operation of roleOperations) {
      if (operation.type === "archive_role") {
        // Archiving is a standalone action; it is never combined with adding a participant
        // (you would not delete a role and bind a participant to it in one step).
        throw new Error("Deleting a role cannot be combined with participant changes.");
      }
      const label = operation.role.label.trim();
      const instructions = operation.role.instructions.trim();
      const participantDefaultsProvided = Object.prototype.hasOwnProperty.call(operation.role, "participantDefaults");
      const participantDefaults = normalizeRoleParticipantDefaults(operation.role.participantDefaults);
      if (!label) {
        throw new Error("Role label is required.");
      }
      if (label.length > CHAT_ROLE_LABEL_MAX_CHARS) {
        throw new Error(`Role label must be ${CHAT_ROLE_LABEL_MAX_CHARS} characters or less.`);
      }
      if (!instructions) {
        throw new Error("Role instructions are required.");
      }
      if (instructions.length > CHAT_ROLE_INSTRUCTIONS_MAX_CHARS) {
        throw new Error(`Role instructions must be ${CHAT_ROLE_INSTRUCTIONS_MAX_CHARS} characters or less.`);
      }

      if (operation.type === "edit_role") {
        const existing = roles.find((role) => role.id === operation.role.roleConfigId);
        if (!existing) {
          throw new Error(`Unknown role: ${operation.role.roleConfigId}.`);
        }
        if (existing.builtIn) {
          throw new Error(`Built-in role "${existing.label}" cannot be edited by Chat Assistant.`);
        }
        if (existing.archivedAt) {
          throw new Error(`Deleted role "${existing.label}" cannot be edited.`);
        }
        roles = roles.map((role) =>
          role.id === existing.id
            ? {
                ...role,
                label,
                instructions,
                appToolCapabilities: operation.role.appToolCapabilities === undefined
                  ? role.appToolCapabilities
                  : normalizeChatAppToolCapabilities(operation.role.appToolCapabilities),
                participantDefaults: participantDefaultsProvided
                  ? normalizeRoleParticipantDefaultsForRole(role, participantDefaults, { inferLegacyManage: false })
                  : normalizeRoleParticipantDefaultsForRole(role, role.participantDefaults),
                version: role.version + 1,
                updatedAt: now
              }
            : role
        );
      } else {
        const id = uniqueRoleId(label, roles);
        if (operation.role.draftRoleRef) {
          roleIdByDraftRoleRef[operation.role.draftRoleRef] = id;
        }
        roles = [
          ...roles,
          {
            id,
            label,
            instructions,
            version: 1,
            builtIn: false,
            appToolCapabilities: normalizeChatAppToolCapabilities(operation.role.appToolCapabilities),
            participantDefaults: normalizeRoleParticipantDefaultsForRole(
              { id, appToolCapabilities: operation.role.appToolCapabilities },
              participantDefaults,
              { inferLegacyManage: false }
            ),
            updatedAt: now
          }
        ];
      }
    }

    let participants = [...(stored.chatParticipantConfigs ?? [])];
    const usageEvents: SettingsUsageEvent[] = roleOperations.some((operation) => operation.type === "create_role")
      ? [{ kind: "role-created" }]
      : [];
    for (const update of participantUpdates) {
      const handle = update.handle.trim().replace(/^@/, "");
      const roleConfigId = roleIdByDraftRoleRef[update.roleConfigId] ?? update.roleConfigId;
      const normalizedId = update.id?.trim();
      if (!CHAT_HANDLE_PATTERN.test(handle)) {
        throw new Error("Member names may use letters, numbers, underscores, and hyphens only.");
      }
      const role = roles.find((item) => item.id === roleConfigId);
      if (!role) {
        throw new Error("Select a role for the member.");
      }
      const existingParticipant = normalizedId ? participants.find((participant) => participant.id === normalizedId) : undefined;
      if (role.archivedAt && existingParticipant?.roleConfigId !== role.id) {
        throw new Error(`Deleted role "${role.label}" cannot be assigned to a member.`);
      }
      const duplicate = participants.find(
        (participant) => participant.id !== normalizedId && participant.handle.toLowerCase() === handle.toLowerCase()
      );
      if (duplicate) {
        throw new Error(`Duplicate member name: @${handle}.`);
      }
      if (update.kind !== "codex-cli" && update.kind !== "claude-code" && update.kind !== "gemini-cli") {
        throw new Error("Chat supports local CLI members only.");
      }
      const requestedRuleIds = new Set(normalizeBehaviorRuleIds(update.behaviorRuleIds));
      const behaviorRuleIds = (stored.chatBehaviorRules ?? []).map((rule) => rule.id).filter((id) => requestedRuleIds.has(id));
      const nextParticipant: ChatParticipantConfig = {
        id: normalizedId || randomUUID(),
        handle,
        roleConfigId,
        behaviorRuleIds,
        kind: update.kind,
        model: update.model?.trim() || undefined,
        reasoningEffort: normalizeChatReasoningEffort(update.reasoningEffort, update.kind),
        avatarId: update.avatarId?.trim() || undefined,
        hostId: participantHostIdForUpdate(stored, update),
        agentMode: normalizeChatAgentMode(update.agentMode),
        permissions: chatAgentPermissionsFromAgent(update.permissions),
        remoteExecution: normalizeConcreteRemoteExecutionMode(update.remoteExecution),
        skipToolchainPreflight: update.skipToolchainPreflight === true,
        autoWatchEnabled: autoWatchEnabledForRole(role, update.autoWatchEnabled),
        updatedAt: now
      };
      usageEvents.push(memberUsageEvent(existingParticipant, nextParticipant));
      participants = participants.some((participant) => participant.id === nextParticipant.id)
        ? participants.map((participant) => (participant.id === nextParticipant.id ? nextParticipant : participant))
        : [...participants, nextParticipant];
    }

    stored.chatRoleConfigs = roles;
    stored.chatParticipantConfigs = participants;
    await this.settings.settingsStore.writeStored(stored);
    for (const event of usageEvents) this.settings.memberUsage.notifyUsage(event);
    return { settings: await this.settings.publicSettings.getPublicSettings(), roleIdByDraftRoleRef };
  }
}
