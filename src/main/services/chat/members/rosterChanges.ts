import { cloudRunSelection } from "../../../../shared/cloudRunPreparation";
import { randomUUID } from "node:crypto";
import type {
  ChatParticipant, ChatParticipantConfig, ChatParticipantConfigUpdate, ChatParticipantChangeRequest, ChatRoleChangeRequest,
  ChatRoleConfig, ChatRoleParticipantChangeRequest, ChatRosterChangeRequest, Conversation
} from "../../../../shared/types";
import { normalizeChatReasoningEffort } from "../../../../shared/reasoningEffort";
import { normalizeChatAgentMode, normalizeChatAgentPermissions } from "../../../../shared/agentPermissions";
import { preservedRemoteExecution } from "../../../../shared/chatParticipantHome";
import { assertParticipantProvidersReady, chatParticipants, formatHandleList, inCliOwnModeInMainSessionChat } from "./identity";
import { normalizeBehaviorRuleIds } from "./roleRuntime";
import {
  fitRosterAdditions, participantManagementChangeEscalates, roleChangeManagementEscalates, roleChangeSummary,
  temporaryRolesForRoleRequest
} from "./rosterRequests";
import type { PreparedParticipantChange, PreparedRoleChange, PreparedRoleParticipantChange, PreparedRosterChange } from "../types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** Prepares and applies approved role and roster changes. */
export class RosterChanges {
  constructor(
    private readonly chat: Pick<ChatModules, "agentEnvironment" | "autoWatch" | "creation">,
    private readonly deps: Pick<ChatDependencies, "settings">
  ) {}

  async prepareRosterChange(conversation: Conversation, request: ChatRosterChangeRequest): Promise<PreparedRosterChange> {
    const settings = await this.deps.settings.getPublicSettings();
    const roleById = new Map(settings.chatRoleConfigs.map((role) => [role.id, role]));
    const existing = chatParticipants(conversation);
    const participantInputs = request.operations.map((operation) => operation.participant);
    const participants = await this.chat.creation.validateParticipants(participantInputs, existing, false, settings.chatRoleConfigs);
    const agents = await this.chat.agentEnvironment.detectAgentsForReadiness();
    assertParticipantProvidersReady(participantInputs, agents, settings.providers ?? [], settings.cliProviderHosts ?? []);
    const normalizedRequest: ChatRosterChangeRequest = {
      reason: request.reason,
      operations: participants.map((participant) => ({
        type: "add",
        participant: {
          participantConfigId: participant.participantConfigId,
          handle: participant.handle,
          roleConfigId: participant.roleConfigId,
          behaviorRuleIds: normalizeBehaviorRuleIds(participant.behaviorRuleIds),
          kind: participant.kind,
          model: participant.model,
          reasoningEffort: participant.reasoningEffort,
          avatarId: participant.avatarId,
          hostId: participant.hostId,
          agentMode: normalizeChatAgentMode(participant.agentMode),
          permissions: normalizeChatAgentPermissions(participant.permissions),
          remoteExecution: preservedRemoteExecution(participant.remoteExecution),
          skipToolchainPreflight: participant.skipToolchainPreflight === true,
          autoWatch: participant.autoWatch === true
        }
      }))
    };
    return {
      request: normalizedRequest,
      participants,
      summary: `Add ${formatHandleList(participants.map((participant) => `@${participant.handle}`))}`,
      managementEscalation: participants.some((participant) =>
        participantManagementChangeEscalates(roleById.get(participant.roleConfigId), participant.permissions)
      )
    };
  }

  applyPreparedRosterChange(conversation: Conversation, prepared: PreparedRosterChange): ChatParticipant[] {
    const participants = chatParticipants(conversation);
    const added = inCliOwnModeInMainSessionChat(conversation, fitRosterAdditions(conversation, prepared.participants));
    conversation.metadata = {
      ...conversation.metadata,
      participants: [...participants, ...added]
    };
    if (added.some((participant) => participant.autoWatch === true)) {
      this.chat.autoWatch.scheduleAutoWatchEvaluation(conversation.id, "participant-added");
    }
    return added;
  }

  async prepareRoleChange(request: ChatRoleChangeRequest): Promise<PreparedRoleChange> {
    const settings = await this.deps.settings.getPublicSettings();
    for (const operation of request.operations) {
      if (operation.type === "edit_role") {
        const existing = settings.chatRoleConfigs.find((role) => role.id === operation.role.roleConfigId);
        if (!existing) {
          throw new Error(`Unknown role: ${operation.role.roleConfigId}.`);
        }
        if (existing.builtIn) {
          throw new Error(`Built-in role "${existing.label}" cannot be edited by Chat Assistant.`);
        }
        if (existing.archivedAt) {
          throw new Error(`Deleted role "${existing.label}" cannot be edited.`);
        }
        continue;
      }
      if (operation.type === "archive_role") {
        const existing = settings.chatRoleConfigs.find((role) => role.id === operation.role.roleConfigId);
        if (!existing) {
          throw new Error(`Unknown role: ${operation.role.roleConfigId}.`);
        }
        if (existing.builtIn) {
          throw new Error(`Built-in role "${existing.label}" cannot be deleted.`);
        }
        const usage = settings.chatParticipantConfigs.filter(
          (participant) => participant.roleConfigId === existing.id
        ).length;
        if (usage > 0) {
          throw new Error(
            `Role "${existing.label}" is used by ${usage} saved member preset${usage === 1 ? "" : "s"} and cannot be deleted.`
          );
        }
      }
    }
    return {
      request,
      summary: roleChangeSummary(request.operations, settings.chatRoleConfigs),
      managementEscalation: roleChangeManagementEscalates(request, settings.chatRoleConfigs)
    };
  }

  async prepareRoleParticipantChange(
    conversation: Conversation,
    request: ChatRoleParticipantChangeRequest
  ): Promise<PreparedRoleParticipantChange> {
    const role = await this.prepareRoleChange(request.roleRequest);
    const participant = await this.prepareParticipantChange(
      conversation,
      request.participantRequest,
      temporaryRolesForRoleRequest(role.request)
    );
    return {
      request: {
        kind: "role_participant_change",
        reason: request.reason,
        roleRequest: role.request,
        participantRequest: participant.request
      },
      role,
      participant,
      summary: `${role.summary}; ${participant.summary}`,
      managementEscalation: role.managementEscalation || participant.managementEscalation
    };
  }

  async applyPreparedRoleChange(prepared: PreparedRoleChange): Promise<ChatRoleConfig[]> {
    const applied: ChatRoleConfig[] = [];
    for (const operation of prepared.request.operations) {
      if (operation.type === "create_role") {
        const before = await this.deps.settings.getPublicSettings();
        const next = await this.deps.settings.saveChatRoleConfig({
          label: operation.role.label,
          instructions: operation.role.instructions,
          appToolCapabilities: operation.role.appToolCapabilities,
          participantDefaults: operation.role.participantDefaults
        });
        const created = next.chatRoleConfigs.find((role) =>
          !before.chatRoleConfigs.some((existing) => existing.id === role.id) &&
          role.label === operation.role.label
        ) ?? next.chatRoleConfigs[next.chatRoleConfigs.length - 1];
        if (created) {
          applied.push(created);
        }
      } else if (operation.type === "archive_role") {
        const next = await this.deps.settings.archiveChatRoleConfig(operation.role.roleConfigId);
        const archived = next.chatRoleConfigs.find((role) => role.id === operation.role.roleConfigId);
        if (archived) {
          applied.push(archived);
        }
      } else {
        const next = await this.deps.settings.saveChatRoleConfig({
          id: operation.role.roleConfigId,
          label: operation.role.label,
          instructions: operation.role.instructions,
          appToolCapabilities: operation.role.appToolCapabilities,
          participantDefaults: operation.role.participantDefaults
        });
        const updated = next.chatRoleConfigs.find((role) => role.id === operation.role.roleConfigId);
        if (updated) {
          applied.push(updated);
        }
      }
    }
    return applied;
  }

  async prepareParticipantChange(
    conversation: Conversation,
    request: ChatParticipantChangeRequest,
    temporaryRoles: ChatRoleConfig[] = []
  ): Promise<PreparedParticipantChange> {
    const settings = await this.deps.settings.getPublicSettings();
    const roles = [...settings.chatRoleConfigs, ...temporaryRoles];
    const roleById = new Map(roles.map((role) => [role.id, role]));
    const newParticipantRoles = [
      ...settings.chatRoleConfigs.filter((role) => !role.archivedAt),
      ...temporaryRoles
    ];
    const existingParticipants = chatParticipants(conversation);
    const participantInputs = request.operations.map((operation, index) => {
      if (operation.type === "add_existing_participant_to_chat") {
        const preset = settings.chatParticipantConfigs.find((participant) => participant.id === operation.participantConfigId);
        if (!preset) {
          throw new Error(`Unknown member preset in operation ${index + 1}.`);
        }
        // Chat-level overrides are authoritative when present (a field may be undefined,
        // meaning "CLI default"); the saved preset itself is never modified.
        const overrides = operation.overrides;
        return {
          participantConfigId: preset.id,
          handle: preset.handle,
          roleConfigId: preset.roleConfigId,
          behaviorRuleIds: preset.behaviorRuleIds,
          kind: preset.kind,
          model: overrides && "model" in overrides ? overrides.model : preset.model,
          reasoningEffort: overrides && "reasoningEffort" in overrides
            ? normalizeChatReasoningEffort(overrides.reasoningEffort, preset.kind)
            : preset.reasoningEffort,
          avatarId: preset.avatarId,
          hostId: preset.hostId,
          agentMode: overrides && "agentMode" in overrides ? normalizeChatAgentMode(overrides.agentMode) : preset.agentMode,
          permissions: overrides && "permissions" in overrides ? overrides.permissions : preset.permissions,
          remoteExecution: overrides && "remoteExecution" in overrides ? overrides.remoteExecution : preset.remoteExecution,
          homeMachineId: overrides && "homeMachineId" in overrides
            ? (typeof overrides.homeMachineId === "string" && overrides.homeMachineId.trim() ? overrides.homeMachineId.trim() : undefined)
            : preset.homeMachineId,
          cloudRun: overrides && "cloudRun" in overrides ? cloudRunSelection(overrides.cloudRun) : preset.cloudRun,
          skipToolchainPreflight: overrides && "skipToolchainPreflight" in overrides ? overrides.skipToolchainPreflight : preset.skipToolchainPreflight,
          autoWatch: overrides && "autoWatch" in overrides ? overrides.autoWatch : preset.autoWatchEnabled
        };
      }
      const role = newParticipantRoles.find((item) => item.id === operation.participant.roleConfigId);
      if (!role) {
        const archived = settings.chatRoleConfigs.find((item) => item.id === operation.participant.roleConfigId && item.archivedAt);
        if (archived) {
          throw new Error(`Deleted role "${archived.label}" cannot be used for a new member.`);
        }
      }
      return operation.participant;
    });
    const savedHandles = new Set(settings.chatParticipantConfigs.map((participant) => participant.handle.toLowerCase()));
    const presetParticipantConfigs: ChatParticipantConfig[] = [];
    const savedPresetIdByOperationIndex = new Map<number, string>();
    for (const [index, operation] of request.operations.entries()) {
      if (operation.type !== "add_new_participant_to_chat" || !operation.saveAsPreset) {
        continue;
      }
      const handle = operation.participant.handle.trim().replace(/^@/, "");
      if (savedHandles.has(handle.toLowerCase())) {
        throw new Error(`Saved member @${handle} already exists.`);
      }
      savedHandles.add(handle.toLowerCase());
      const id = randomUUID();
      savedPresetIdByOperationIndex.set(index, id);
    }
    const participants = (await this.chat.creation.validateParticipants(participantInputs, existingParticipants, false, roles)).map((participant, index) => ({
      ...participant,
      participantConfigId: participant.participantConfigId ?? savedPresetIdByOperationIndex.get(index)
    }));
    const agents = await this.chat.agentEnvironment.detectAgentsForReadiness();
    assertParticipantProvidersReady(participantInputs, agents, settings.providers ?? [], settings.cliProviderHosts ?? []);
    const managementEscalation = participants.some((participant, index) => {
      const operation = request.operations[index];
      const role = roleById.get(participant.roleConfigId);
      if (operation?.type === "add_existing_participant_to_chat") {
        const preset = settings.chatParticipantConfigs.find((item) => item.id === operation.participantConfigId);
        return participantManagementChangeEscalates(role, participant.permissions, preset?.permissions);
      }
      return participantManagementChangeEscalates(role, participant.permissions);
    });
    for (const [index, operation] of request.operations.entries()) {
      if (operation.type !== "add_new_participant_to_chat" || !operation.saveAsPreset) {
        continue;
      }
      const participant = participants[index];
      const id = savedPresetIdByOperationIndex.get(index);
      if (!participant || !id) {
        continue;
      }
      presetParticipantConfigs.push({
        id,
        handle: participant.handle,
        roleConfigId: participant.roleConfigId,
        behaviorRuleIds: participant.behaviorRuleIds,
        kind: participant.kind,
        model: participant.model,
        reasoningEffort: participant.reasoningEffort,
        avatarId: participant.avatarId,
        hostId: participant.hostId,
        agentMode: participant.agentMode,
        permissions: participant.permissions,
        remoteExecution: preservedRemoteExecution(participant.remoteExecution),
        skipToolchainPreflight: participant.skipToolchainPreflight === true,
        autoWatchEnabled: participant.autoWatch === true,
        updatedAt: new Date().toISOString()
      });
    }
    return {
      request: {
        reason: request.reason,
        operations: request.operations.map((operation, index) => {
          if (operation.type === "add_existing_participant_to_chat") {
            return operation;
          }
          const participant = participants[index];
          return {
            ...operation,
            participant: {
              ...participant,
              participantConfigId: savedPresetIdByOperationIndex.get(index),
              handle: participant.handle,
              permissions: normalizeChatAgentPermissions(participant.permissions),
              remoteExecution: preservedRemoteExecution(participant.remoteExecution),
              skipToolchainPreflight: participant.skipToolchainPreflight === true,
              autoWatch: participant.autoWatch === true
            }
          };
        })
      },
      participants,
      presetParticipantConfigs,
      summary: `Add ${formatHandleList(participants.map((participant) => `@${participant.handle}`))}`,
      managementEscalation
    };
  }

  async applyPreparedParticipantChange(conversation: Conversation, prepared: PreparedParticipantChange): Promise<ChatParticipant[]> {
    fitRosterAdditions(conversation, prepared.participants);
    for (const preset of prepared.presetParticipantConfigs) {
      await this.deps.settings.saveChatParticipantConfig({
        id: preset.id,
        handle: preset.handle,
        roleConfigId: preset.roleConfigId,
        behaviorRuleIds: preset.behaviorRuleIds,
        kind: preset.kind,
        model: preset.model,
        reasoningEffort: preset.reasoningEffort,
        avatarId: preset.avatarId,
        hostId: preset.hostId,
        agentMode: preset.agentMode,
        permissions: preset.permissions,
        remoteExecution: preservedRemoteExecution(preset.remoteExecution),
        skipToolchainPreflight: preset.skipToolchainPreflight === true,
        autoWatchEnabled: preset.autoWatchEnabled
      });
    }
    return this.applyPreparedRosterChange(conversation, {
      request: {
        reason: prepared.request.reason,
        operations: prepared.participants.map((participant) => ({
          type: "add",
          participant: {
            participantConfigId: participant.participantConfigId,
            handle: participant.handle,
            roleConfigId: participant.roleConfigId,
            behaviorRuleIds: participant.behaviorRuleIds,
            kind: participant.kind,
            model: participant.model,
            reasoningEffort: participant.reasoningEffort,
            avatarId: participant.avatarId,
            hostId: participant.hostId,
            agentMode: participant.agentMode,
            permissions: participant.permissions,
            remoteExecution: preservedRemoteExecution(participant.remoteExecution),
            skipToolchainPreflight: participant.skipToolchainPreflight === true,
            autoWatch: participant.autoWatch === true
          }
        }))
      },
      participants: prepared.participants,
      summary: prepared.summary,
      managementEscalation: prepared.managementEscalation
    });
  }

  async applyPreparedRoleParticipantChange(
    conversation: Conversation,
    prepared: PreparedRoleParticipantChange
  ): Promise<{ request: ChatRoleParticipantChangeRequest; participants: ChatParticipant[]; summary: string }> {
    fitRosterAdditions(conversation, prepared.participant.participants);
    const participantUpdates: ChatParticipantConfigUpdate[] = prepared.participant.presetParticipantConfigs.map((preset) => ({
      id: preset.id,
      handle: preset.handle,
      roleConfigId: preset.roleConfigId,
      behaviorRuleIds: preset.behaviorRuleIds,
      kind: preset.kind,
      model: preset.model,
      reasoningEffort: preset.reasoningEffort,
      avatarId: preset.avatarId,
      hostId: preset.hostId,
      agentMode: preset.agentMode,
      permissions: preset.permissions,
      remoteExecution: preservedRemoteExecution(preset.remoteExecution),
      skipToolchainPreflight: preset.skipToolchainPreflight === true,
      autoWatchEnabled: preset.autoWatchEnabled
    }));
    const saved = await this.deps.settings.saveChatRoleParticipantConfigBatch(prepared.role.request.operations, participantUpdates);
    const remapRoleId = (roleConfigId: string): string => saved.roleIdByDraftRoleRef[roleConfigId] ?? roleConfigId;
    const participants = prepared.participant.participants.map((participant) => ({
      ...participant,
      roleConfigId: remapRoleId(participant.roleConfigId)
    }));
    this.applyPreparedRosterChange(conversation, {
      request: {
        reason: prepared.participant.request.reason,
        operations: participants.map((participant) => ({
          type: "add",
          participant: {
            participantConfigId: participant.participantConfigId,
            handle: participant.handle,
            roleConfigId: participant.roleConfigId,
            behaviorRuleIds: participant.behaviorRuleIds,
            kind: participant.kind,
            model: participant.model,
            reasoningEffort: participant.reasoningEffort,
            avatarId: participant.avatarId,
            hostId: participant.hostId,
            agentMode: participant.agentMode,
            permissions: participant.permissions,
            remoteExecution: preservedRemoteExecution(participant.remoteExecution),
            skipToolchainPreflight: participant.skipToolchainPreflight === true,
            autoWatch: participant.autoWatch === true
          }
        }))
      },
      participants,
      summary: prepared.participant.summary,
      managementEscalation: prepared.managementEscalation
    });
    const participantRequest: ChatParticipantChangeRequest = {
      reason: prepared.participant.request.reason,
      operations: prepared.participant.request.operations.map((operation) => {
        if (operation.type === "add_existing_participant_to_chat") {
          return operation;
        }
        return {
          ...operation,
          participant: {
            ...operation.participant,
            roleConfigId: remapRoleId(operation.participant.roleConfigId)
          }
        };
      })
    };
    return {
      request: {
        kind: "role_participant_change",
        reason: prepared.request.reason,
        roleRequest: prepared.role.request,
        participantRequest
      },
      participants,
      summary: prepared.summary
    };
  }
}
