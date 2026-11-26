import { normalizeNewChatDefaults } from "../../../../shared/newChatDefaults";
import { normalizeSubagentProviderEntries } from "../../../../shared/subagentProviders";
import { isTrustedDeviceRecord } from "../../../../shared/machineTrust";
import { normalizeMachinePowerHandoffRecords } from "../../../../shared/machinePowerHandoff";
import type { ChatProviderKind } from "../../../../shared/types";
import {
  normalizeChatParticipantRequestMaxDepth, normalizeChatParticipantRequestPromptMaxChars
} from "../../../../shared/chatParticipantRequests";
import { normalizeChatAutoWatchWakeLimit } from "../../../../shared/chatAutoWatch";
import { normalizeChatPromptContextSettings } from "../../../../shared/chatPromptContext";
import { normalizeCliAgentRunTimeoutMs } from "../../../../shared/cliAgentRunSettings";
import { normalizeCustomAvatars } from "../avatars/avatarFiles";
import { normalizeAwsWorkerGoneNotice, normalizeLeavingMachines } from "../aws/leavingMachines";
import {
  normalizeAwsWorkerHandle, normalizeAwsWorkerOperation, normalizeAwsWorkerSpecAcceptance, normalizeAwsWorkerVolumeExpansion,
  normalizeCloudRunsSettings
} from "../aws/storedAws";
import { normalizeRemovedAutomaticKeys } from "../environment/environmentKeys";
import { normalizeAgentEnvironmentVariables } from "../environment/storedEnvironment";
import { hubSettingField, isStoredHubPhoneInvite } from "../machines/hubSetting";
import { isRelayRemovalFailure, isRelayRemovalPending, isRelayRemovalRecord } from "../machines/relayRemovalRecords";
import { normalizeMachineInstalls, normalizeMachines } from "../machines/storedMachines";
import { normalizeParticipantConfigs, normalizeSeedState } from "../members/storedMembers";
import { mergeRepoFileOpenSettings, normalizeBetaUpdates } from "../preferences/storedPreferences";
import { canonicalProviderLabel, DEFAULT_PROVIDER_KINDS, DEFAULT_PROVIDERS } from "../providers/defaultProviders";
import { normalizedCliProviderHosts } from "../providers/storedHosts";
import { mergeDefaultRoles, shouldMigrateWorkflowManagerParticipantManagement } from "../roles/storedRoles";
import { normalizeBehaviorRules, normalizeSavedPrompts } from "../roles/storedRules";
import type { StoredSettings } from "../types";

export function mergeDefaults(settings: StoredSettings): StoredSettings {
  const providers = DEFAULT_PROVIDERS.map((fallback) => {
    const existing = settings.providers?.find((item) => item.kind === fallback.kind);
    return {
      kind: fallback.kind,
      label: canonicalProviderLabel(fallback.kind, fallback.label),
      enabled: typeof existing?.enabled === "boolean" ? existing.enabled : fallback.enabled,
      model: typeof existing?.model === "string" ? existing.model.trim() || fallback.model : fallback.model
    };
  });
  const migrateWorkflowManagerParticipantManagement = shouldMigrateWorkflowManagerParticipantManagement(settings.chatRoleConfigs);
  const chatRoleConfigs = mergeDefaultRoles(settings.chatRoleConfigs);
  return {
    settingsVersion: 1,
    roundLimitDefault: defaultRoundLimit(settings),
    betaUpdates: normalizeBetaUpdates(settings.betaUpdates),
    cliAgentRunTimeoutMs: normalizeCliAgentRunTimeoutMs(settings.cliAgentRunTimeoutMs),
    chatParticipantRequestMaxDepth: normalizeChatParticipantRequestMaxDepth(settings.chatParticipantRequestMaxDepth),
    chatParticipantRequestPromptMaxChars: normalizeChatParticipantRequestPromptMaxChars(settings.chatParticipantRequestPromptMaxChars),
    chatAutoWatchWakeLimit: normalizeChatAutoWatchWakeLimit(settings.chatAutoWatchWakeLimit),
    chatPromptContext: normalizeChatPromptContextSettings(settings.chatPromptContext),
    cloudRuns: normalizeCloudRunsSettings(settings),
    cloudRunsMode: settings.cloudRunsMode === "aws" ? "aws" : "ssh",
    encryptedAwsCredentials: typeof settings.encryptedAwsCredentials === "string" ? settings.encryptedAwsCredentials : undefined,
    awsWorkerHandle: normalizeAwsWorkerHandle(settings.awsWorkerHandle),
    awsWorkerRegion: typeof settings.awsWorkerRegion === "string" ? settings.awsWorkerRegion.trim() || undefined : undefined,
    cloudRunsDeviceId: typeof settings.cloudRunsDeviceId === "string" && settings.cloudRunsDeviceId.trim()
      ? settings.cloudRunsDeviceId.trim()
      : undefined,
    awsWorkerOperation: normalizeAwsWorkerOperation(settings.awsWorkerOperation),
    awsWorkerProvisioningToken: typeof settings.awsWorkerProvisioningToken === "string" && settings.awsWorkerProvisioningToken.trim()
      ? settings.awsWorkerProvisioningToken.trim().slice(0, 64)
      : undefined,
    awsWorkerSpecAcceptance: normalizeAwsWorkerSpecAcceptance(settings.awsWorkerSpecAcceptance),
    awsWorkerVolumeExpansion: normalizeAwsWorkerVolumeExpansion(settings.awsWorkerVolumeExpansion),
    awsWorkerGoneNotice: normalizeAwsWorkerGoneNotice(settings.awsWorkerGoneNotice),
    leavingMachines: normalizeLeavingMachines(settings.leavingMachines),
    agentEnvironment: {
      variables: normalizeAgentEnvironmentVariables(settings.agentEnvironment?.variables),
      removedAutomaticKeys: normalizeRemovedAutomaticKeys(settings.agentEnvironment?.removedAutomaticKeys)
    },
    cliProviderHosts: normalizedCliProviderHosts(settings),
    assistantProviderKind: normalizeChatProviderKind(settings.assistantProviderKind),
    newChatDefaults: settings.newChatDefaults === undefined ? undefined : normalizeNewChatDefaults(settings.newChatDefaults),
    // An emptied list stays ([]): a machine importing the snapshot clears its own.
    subagentDefaults: settings.subagentDefaults === undefined ? undefined : normalizeSubagentProviderEntries(settings.subagentDefaults, false),
    // Not read (Settings' defaults replaced the projects' lists); kept as
    // stored for a downgrade.
    ...(settings.subagentProvidersByProject !== undefined ? { subagentProvidersByProject: settings.subagentProvidersByProject } : {}),
    // Not read (every new chat opens in the sessions view); kept as stored
    // for a downgrade.
    ...(settings.defaultChatView === "classic" || settings.defaultChatView === "sessions" ? { defaultChatView: settings.defaultChatView } : {}),
    lastSuccessfulChatProviderKind: normalizeChatProviderKind(settings.lastSuccessfulChatProviderKind),
    lastRepoPath: typeof settings.lastRepoPath === "string" ? settings.lastRepoPath.trim() || undefined : undefined,
    ...mergeRepoFileOpenSettings(settings),
    providers,
    chatRoleConfigs,
    chatBehaviorRules: normalizeBehaviorRules(settings.chatBehaviorRules),
    chatSavedPrompts: normalizeSavedPrompts(settings.chatSavedPrompts),
    chatParticipantConfigs: normalizeParticipantConfigs(
      settings.chatParticipantConfigs,
      chatRoleConfigs,
      { migrateWorkflowManagerParticipantManagement }
    ),
    chatCustomAvatars: normalizeCustomAvatars(settings.chatCustomAvatars),
    chatParticipantSeedState: normalizeSeedState(settings.chatParticipantSeedState),
    machines: normalizeMachines(settings.machines),
    machineInstalls: normalizeMachineInstalls(settings.machineInstalls),
    encryptedMachinePower: typeof settings.encryptedMachinePower === "string" && settings.encryptedMachinePower.trim()
      ? settings.encryptedMachinePower : undefined,
    encryptedMachinePowerPrevious: typeof settings.encryptedMachinePowerPrevious === "string" && settings.encryptedMachinePowerPrevious.trim()
      ? settings.encryptedMachinePowerPrevious : undefined,
    ...(typeof settings.machineAutoStopEnabled === "boolean" ? { machineAutoStopEnabled: settings.machineAutoStopEnabled } : {}),
    ...(typeof settings.machineAutoStopChangedAt === "string" ? { machineAutoStopChangedAt: settings.machineAutoStopChangedAt } : {}),
    ...hubSettingField(settings.hub),
    machinePowerHandoffs: normalizeMachinePowerHandoffRecords(settings.machinePowerHandoffs).length
      ? normalizeMachinePowerHandoffRecords(settings.machinePowerHandoffs)
      : undefined,
    encryptedMachinePairings: typeof settings.encryptedMachinePairings === "string" && settings.encryptedMachinePairings.trim()
      ? settings.encryptedMachinePairings
      : undefined,
    // Read back, not rebuilt. This function returns an explicit object, so a
    // field missing from it is dropped every time settings are read from
    // disk -- and these four were. The roster was written and then forgotten
    // on the next start: every device the owner trusted stopped being
    // trusted, machines were handed an empty roster, and a revocation the
    // owner made was forgotten just as completely.
    trustedDevices: (settings.trustedDevices ?? []).filter(isTrustedDeviceRecord).map(record => ({ ...record })),
    hubPhoneInvites: Array.isArray(settings.hubPhoneInvites)
      ? settings.hubPhoneInvites.filter(isStoredHubPhoneInvite).map((invite) => ({ ...invite }))
      : undefined,
    machineDeviceRevocations: settings.machineDeviceRevocations && typeof settings.machineDeviceRevocations === "object"
      ? { ...settings.machineDeviceRevocations } : undefined,
    relayRemoval: isRelayRemovalRecord(settings.relayRemoval) ? { ...settings.relayRemoval } : undefined,
    relayRemovalPending: isRelayRemovalPending(settings.relayRemovalPending)
      ? { machines: settings.relayRemovalPending.machines.map((machine) => ({ id: machine.id, name: machine.name })), startKeyHanded: settings.relayRemovalPending.startKeyHanded } : undefined,
    relayRemovalFailures: Array.isArray(settings.relayRemovalFailures)
      ? settings.relayRemovalFailures.filter(isRelayRemovalFailure).map((failure) => ({
        ...failure, ...(failure.dismissedMessages ? { dismissedMessages: [...failure.dismissedMessages] } : {})
      })) : undefined,
    // Read back too: dropped here, the 10-day rhythm of the question about
    // unused machines restarted with every launch.
    machineInactivityCheckAt: typeof settings.machineInactivityCheckAt === "string" ? settings.machineInactivityCheckAt : undefined
  };
}

export function normalizeChatProviderKind(value: unknown): ChatProviderKind | undefined {
  return value === "codex-cli" || value === "claude-code" || value === "gemini-cli" ? value : undefined;
}

export function hasLegacyProviderData(settings: StoredSettings): boolean {
  if (!Array.isArray(settings.providers)) {
    return false;
  }
  return settings.providers.some((provider) =>
    !DEFAULT_PROVIDER_KINDS.has(provider.kind) ||
    "encryptedApiKey" in provider ||
    provider.label !== canonicalProviderLabel(provider.kind, provider.label)
  );
}

function defaultRoundLimit(settings: StoredSettings): number {
  if (!Number.isFinite(settings.roundLimitDefault)) {
    return 1;
  }
  if (!settings.settingsVersion && settings.roundLimitDefault === 2) {
    return 1;
  }
  return Math.max(1, Math.floor(settings.roundLimitDefault));
}
