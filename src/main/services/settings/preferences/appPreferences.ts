import { userDataPath } from "../../../platform";
import type { AppSettings, ChatPromptContextSettings, RepoFileExternalOpenAction, RepoFileOpenAction } from "../../../../shared/types";
import {
  normalizeChatParticipantRequestMaxDepth, normalizeChatParticipantRequestPromptMaxChars
} from "../../../../shared/chatParticipantRequests";
import { normalizeChatAutoWatchWakeLimit } from "../../../../shared/chatAutoWatch";
import { normalizeChatPromptContextSettings } from "../../../../shared/chatPromptContext";
import { normalizeCliAgentRunTimeoutMs } from "../../../../shared/cliAgentRunSettings";
import { markCrashReportsNoticeSeen, writeCrashReportsChoice } from "../../crashReportPreferences";
import { normalizeBetaUpdates, normalizeChatShowMemberActions, normalizeRepoFileExternalOpenAction, normalizeRepoFileOpenAction } from "./storedPreferences";
import type { SettingsModules } from "../modules";

/** Preferences of the app itself. */
export class AppPreferences {
  constructor(private readonly settings: Pick<SettingsModules, "publicSettings" | "settingsStore">) {}

  async updateLastRepoPath(repoPath: string): Promise<AppSettings> {
    const stored = await this.settings.settingsStore.readStored();
    const normalized = repoPath.trim();
    stored.lastRepoPath = normalized || undefined;
    await this.settings.settingsStore.writeStored(stored);
    return this.settings.publicSettings.getPublicSettings();
  }

  async getRepoFileOpenAction(): Promise<RepoFileOpenAction | undefined> {
    const stored = await this.settings.settingsStore.readStored();
    return stored.repoFileOpenAction;
  }

  async setRepoFileOpenAction(action: RepoFileOpenAction | null): Promise<AppSettings> {
    const stored = await this.settings.settingsStore.readStored();
    stored.repoFileOpenAction = normalizeRepoFileOpenAction(action);
    stored.repoFileOpenPanelMigrated = true;
    await this.settings.settingsStore.writeStored(stored);
    return this.settings.publicSettings.getPublicSettings();
  }

  /** Undefined until the User chose (or had chosen before the panel): files the panel does not show then ask. */
  async getRepoFileExternalOpenAction(): Promise<RepoFileExternalOpenAction | undefined> {
    const stored = await this.settings.settingsStore.readStored();
    return stored.repoFileExternalOpenAction;
  }

  async setRepoFileExternalOpenAction(action: unknown): Promise<AppSettings> {
    const normalized = normalizeRepoFileExternalOpenAction(action);
    if (!normalized && action !== null) throw new Error("Choose IntelliJ IDEA, the default app, or to be asked.");
    const stored = await this.settings.settingsStore.readStored();
    stored.repoFileExternalOpenAction = normalized;
    stored.repoFileOpenPanelMigrated = true;
    await this.settings.settingsStore.writeStored(stored);
    return this.settings.publicSettings.getPublicSettings();
  }

  async getBetaUpdatesEnabled(): Promise<boolean> {
    const stored = await this.settings.settingsStore.readStored();
    return normalizeBetaUpdates(stored.betaUpdates);
  }

  async setBetaUpdates(enabled: boolean): Promise<AppSettings> {
    const stored = await this.settings.settingsStore.readStored();
    stored.betaUpdates = normalizeBetaUpdates(enabled);
    await this.settings.settingsStore.writeStored(stored);
    return this.settings.publicSettings.getPublicSettings();
  }

  /** Stored only when off: a settings file without it shows them. */
  async setChatShowMemberActions(shown: boolean): Promise<AppSettings> {
    const stored = await this.settings.settingsStore.readStored();
    stored.chatShowMemberActions = normalizeChatShowMemberActions(shown) ? undefined : false;
    await this.settings.settingsStore.writeStored(stored);
    return this.settings.publicSettings.getPublicSettings();
  }

  /** Kept in a marker file next to settings.json, not in it; see
   *  CRASH_REPORTS_OFF_MARKER. */
  async setCrashReports(enabled: boolean): Promise<AppSettings> {
    writeCrashReportsChoice(userDataPath(), enabled);
    try {
      markCrashReportsNoticeSeen(userDataPath());
    } catch {
      // The choice is saved; the notice may only show once more.
    }
    return this.settings.publicSettings.getPublicSettings();
  }

  /** The notice that reports are sent was closed, or the choice was made. */
  async dismissCrashReportsNotice(): Promise<AppSettings> {
    markCrashReportsNoticeSeen(userDataPath());
    return this.settings.publicSettings.getPublicSettings();
  }

  async getCliAgentRunTimeoutMs(): Promise<number> {
    const stored = await this.settings.settingsStore.readStored();
    return normalizeCliAgentRunTimeoutMs(stored.cliAgentRunTimeoutMs);
  }

  async setCliAgentRunTimeoutMs(timeoutMs: number): Promise<AppSettings> {
    const stored = await this.settings.settingsStore.readStored();
    stored.cliAgentRunTimeoutMs = normalizeCliAgentRunTimeoutMs(timeoutMs);
    await this.settings.settingsStore.writeStored(stored);
    return this.settings.publicSettings.getPublicSettings();
  }

  async getChatParticipantRequestMaxDepth(): Promise<number> {
    const stored = await this.settings.settingsStore.readStored();
    return normalizeChatParticipantRequestMaxDepth(stored.chatParticipantRequestMaxDepth);
  }

  async setChatParticipantRequestMaxDepth(maxDepth: number): Promise<AppSettings> {
    const stored = await this.settings.settingsStore.readStored();
    stored.chatParticipantRequestMaxDepth = normalizeChatParticipantRequestMaxDepth(maxDepth);
    await this.settings.settingsStore.writeStored(stored);
    return this.settings.publicSettings.getPublicSettings();
  }

  async getChatParticipantRequestPromptMaxChars(): Promise<number> {
    const stored = await this.settings.settingsStore.readStored();
    return normalizeChatParticipantRequestPromptMaxChars(stored.chatParticipantRequestPromptMaxChars);
  }

  async setChatParticipantRequestPromptMaxChars(maxChars: number): Promise<AppSettings> {
    const stored = await this.settings.settingsStore.readStored();
    stored.chatParticipantRequestPromptMaxChars = normalizeChatParticipantRequestPromptMaxChars(maxChars);
    await this.settings.settingsStore.writeStored(stored);
    return this.settings.publicSettings.getPublicSettings();
  }

  async setChatAutoWatchWakeLimit(limit: number): Promise<AppSettings> {
    const stored = await this.settings.settingsStore.readStored();
    stored.chatAutoWatchWakeLimit = normalizeChatAutoWatchWakeLimit(limit);
    await this.settings.settingsStore.writeStored(stored);
    return this.settings.publicSettings.getPublicSettings();
  }

  async setChatPromptContext(settings: ChatPromptContextSettings): Promise<AppSettings> {
    const stored = await this.settings.settingsStore.readStored();
    stored.chatPromptContext = normalizeChatPromptContextSettings(settings);
    await this.settings.settingsStore.writeStored(stored);
    return this.settings.publicSettings.getPublicSettings();
  }
}
