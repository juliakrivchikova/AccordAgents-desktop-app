import { normalizeNewChatDefaults } from "../../../../shared/newChatDefaults";
import { userDataPath } from "../../../platform";
import type { AppSettings } from "../../../../shared/types";
import {
  normalizeChatParticipantRequestMaxDepth, normalizeChatParticipantRequestPromptMaxChars
} from "../../../../shared/chatParticipantRequests";
import { normalizeChatAutoWatchWakeLimit } from "../../../../shared/chatAutoWatch";
import { normalizeChatPromptContextSettings } from "../../../../shared/chatPromptContext";
import { normalizeCliAgentRunTimeoutMs } from "../../../../shared/cliAgentRunSettings";
import { mobileControlSettingsFromEnvironment } from "../../../../shared/mobilePairing";
import { readCrashReportsChoice } from "../../crashReportPreferences";
import { normalizeCustomAvatars } from "../avatars/avatarFiles";
import { normalizeCloudRunsSettings } from "../aws/storedAws";
import { normalizeBetaUpdates } from "../preferences/storedPreferences";
import { canonicalProviderLabel } from "../providers/defaultProviders";
import { publicCliProviderHosts } from "../providers/storedHosts";
import { DEFAULT_CHAT_ROLES } from "../roles/defaultRoles";
import { normalizeChatProviderKind } from "./storedDefaults";
import type { SettingsModules } from "../modules";

/** The settings the renderer may see. */
export class PublicSettings {
  constructor(private readonly settings: Pick<SettingsModules, "settingsStore">) {}

  async getPublicSettings(): Promise<AppSettings> {
    const stored = await this.settings.settingsStore.readStored();
    return {
      roundLimitDefault: stored.roundLimitDefault,
      betaUpdates: normalizeBetaUpdates(stored.betaUpdates),
      crashReports: readCrashReportsChoice(userDataPath()),
      cliAgentRunTimeoutMs: normalizeCliAgentRunTimeoutMs(stored.cliAgentRunTimeoutMs),
      chatParticipantRequestMaxDepth: normalizeChatParticipantRequestMaxDepth(stored.chatParticipantRequestMaxDepth),
      chatParticipantRequestPromptMaxChars: normalizeChatParticipantRequestPromptMaxChars(stored.chatParticipantRequestPromptMaxChars),
      chatAutoWatchWakeLimit: normalizeChatAutoWatchWakeLimit(stored.chatAutoWatchWakeLimit),
      chatPromptContext: normalizeChatPromptContextSettings(stored.chatPromptContext),
      cloudRuns: normalizeCloudRunsSettings(stored),
      mobileControl: mobileControlSettingsFromEnvironment(process.env),
      assistantProviderKind: normalizeChatProviderKind(stored.assistantProviderKind),
      newChatDefaults: normalizeNewChatDefaults(stored.newChatDefaults),
      lastSuccessfulChatProviderKind: normalizeChatProviderKind(stored.lastSuccessfulChatProviderKind),
      lastRepoPath: stored.lastRepoPath,
      repoFileOpenAction: stored.repoFileOpenAction,
      repoFileExternalOpenAction: stored.repoFileExternalOpenAction,
      chatRoleConfigs: stored.chatRoleConfigs ?? DEFAULT_CHAT_ROLES,
      chatBehaviorRules: stored.chatBehaviorRules ?? [],
      chatSavedPrompts: stored.chatSavedPrompts ?? [],
      chatParticipantConfigs: stored.chatParticipantConfigs ?? [],
      chatCustomAvatars: normalizeCustomAvatars(stored.chatCustomAvatars),
      chatParticipantSeedState: stored.chatParticipantSeedState,
      cliProviderHosts: publicCliProviderHosts(stored),
      providers: stored.providers.map((provider) => ({
        kind: provider.kind,
        label: canonicalProviderLabel(provider.kind, provider.label),
        enabled: provider.enabled,
        model: provider.model
      }))
    };
  }
}
