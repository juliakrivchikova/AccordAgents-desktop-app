import { app, ipcMain } from "electron";
import type {
  CliProviderHostUpdate, DeleteAgentEnvironmentVariableRequest, ChatBehaviorRuleConfigUpdate, ChatProviderKind,
  NewChatDefaultsUpdate, SubagentDefaultUpdate, ChatPromptContextSettings, ChatSavedPromptConfigUpdate, ChatParticipantConfigUpdate,
  ChatRoleConfigUpdate, ProviderKind, ProviderSettingsUpdate, SaveAgentEnvironmentVariableRequest
} from "../../../shared/types";
import { stopCrashReporting } from "../../services/crashReporting";
import { detectAgentsWithAppSkills } from "../agentDetection";
import type { DesktopApp } from "../desktopApp";

export function registerSettingsIpc(desktopApp: DesktopApp): void {
  ipcMain.handle("settings:get", () => desktopApp.settingsService.getPublicSettings());
  ipcMain.handle("settings:set-repo-file-open-preference", (_event, action: unknown) => desktopApp.localFileOpenerService.setOpenPreference(action));
  ipcMain.handle("settings:set-repo-file-external-open-preference", (_event, action: unknown) => desktopApp.settingsService.setRepoFileExternalOpenAction(action));

  ipcMain.handle("settings:set-beta-updates", (_event, enabled: boolean) => {
    return desktopApp.settingsService.setBetaUpdates(enabled);
  });
  ipcMain.handle("settings:set-chat-show-member-actions", (_event, shown: unknown) => {
    return desktopApp.settingsService.setChatShowMemberActions(shown !== false);
  });

  ipcMain.handle("settings:set-crash-reports", async (_event, enabled: unknown) => {
    // Off stops first, so a failed write cannot leave reports running.
    if (enabled === false) {
      desktopApp.usageMilestones?.pause();
      await stopCrashReporting(app.getPath("userData"));
      void desktopApp.debugLogService.write("crash-reports.stopped", {});
    }
    return desktopApp.settingsService.setCrashReports(enabled !== false);
  });
  ipcMain.handle("settings:dismiss-crash-reports-notice", () => desktopApp.settingsService.dismissCrashReportsNotice());

  ipcMain.handle("settings:set-cli-agent-run-timeout", async (_event, timeoutMs: number) => {
    const next = await desktopApp.settingsService.setCliAgentRunTimeoutMs(timeoutMs);
    desktopApp.cliAgentRunner.setRunTimeoutMs(next.cliAgentRunTimeoutMs);
    return next;
  });

  ipcMain.handle("settings:set-chat-participant-request-max-depth", (_event, maxDepth: number) => {
    return desktopApp.settingsService.setChatParticipantRequestMaxDepth(maxDepth);
  });

  ipcMain.handle("settings:set-chat-participant-request-prompt-max-chars", (_event, maxChars: number) => {
    return desktopApp.settingsService.setChatParticipantRequestPromptMaxChars(maxChars);
  });

  ipcMain.handle("settings:set-chat-auto-watch-wake-limit", (_event, limit: number) => {
    return desktopApp.settingsService.setChatAutoWatchWakeLimit(limit);
  });

  ipcMain.handle("settings:set-chat-prompt-context", (_event, settings: ChatPromptContextSettings) => {
    return desktopApp.settingsService.setChatPromptContext(settings);
  });

  ipcMain.handle("settings:get-agent-environment", () => desktopApp.agentEnvironmentService.snapshot());

  ipcMain.handle("settings:save-agent-environment-variable", async (_event, request: SaveAgentEnvironmentVariableRequest) => {
    const snapshot = await desktopApp.agentEnvironmentService.save(request);
    // Work in progress keeps running with the values it started with; each
    // member gets the new ones once its process is idle (retireIdleWarmAgents).
    await desktopApp.cliAgentRunner.retireIdleWarmAgents("environment-changed");
    desktopApp.cliAgentRunner.invalidateAgentReadiness();
    return snapshot;
  });

  ipcMain.handle("settings:refresh-agent-environment", () => desktopApp.agentEnvironmentService.refresh());

  ipcMain.handle("settings:save-cli-provider-host", async (_event, update: CliProviderHostUpdate) => {
    const settings = await desktopApp.settingsService.saveCliProviderHost(update);
    const saved = update.id?.trim() ? settings.cliProviderHosts.find((host) => host.id === update.id?.trim()) : undefined;
    if (saved) {
      await desktopApp.chatService.syncCliProviderHost(saved);
    }
    return settings;
  });

  ipcMain.handle("settings:delete-cli-provider-host", async (_event, id: string) => {
    const settings = await desktopApp.settingsService.deleteCliProviderHost(id);
    await desktopApp.chatService.retireCliProviderHost(id);
    return settings;
  });

  ipcMain.handle("settings:delete-agent-environment-variable", async (_event, request: DeleteAgentEnvironmentVariableRequest) => {
    const snapshot = await desktopApp.agentEnvironmentService.delete(request);
    await desktopApp.cliAgentRunner.retireIdleWarmAgents("environment-changed");
    desktopApp.cliAgentRunner.invalidateAgentReadiness();
    return snapshot;
  });

  ipcMain.handle("settings:update-provider", async (_event, update: ProviderSettingsUpdate) => {
    const next = await desktopApp.settingsService.updateProvider(update);
    if (typeof update.enabled === "boolean") {
      desktopApp.cliAgentRunner.invalidateAgentReadiness();
      if (update.enabled) {
        void detectAgentsWithAppSkills(desktopApp, { force: true, trigger: "provider-enabled" }).catch(() => undefined);
      }
    }
    return next;
  });

  ipcMain.handle("settings:set-assistant-provider", (_event, kind: ChatProviderKind) =>
    desktopApp.settingsService.setAssistantProviderKind(kind));

  ipcMain.handle("settings:set-new-chat-defaults", (_event, update: NewChatDefaultsUpdate) =>
    desktopApp.settingsService.setNewChatDefaults(update));
  ipcMain.handle("settings:set-subagent-default", (_event, update: SubagentDefaultUpdate) =>
    desktopApp.settingsService.setSubagentDefault(update));

  ipcMain.handle("settings:save-chat-role", (_event, update: ChatRoleConfigUpdate) => desktopApp.settingsService.saveChatRoleConfig(update));
  ipcMain.handle("settings:archive-chat-role", (_event, id: string) => desktopApp.settingsService.archiveChatRoleConfig(id));
  ipcMain.handle("settings:save-chat-behavior-rule", (_event, update: ChatBehaviorRuleConfigUpdate) => desktopApp.settingsService.saveChatBehaviorRuleConfig(update));

  ipcMain.handle("settings:delete-chat-behavior-rule", async (_event, id: string) => {
    const nextSettings = await desktopApp.settingsService.deleteChatBehaviorRuleConfig(id);
    await desktopApp.chatService.removeBehaviorRuleFromChatParticipants(id);
    return nextSettings;
  });

  ipcMain.handle("settings:save-chat-saved-prompt", (_event, update: ChatSavedPromptConfigUpdate) => desktopApp.settingsService.saveChatSavedPromptConfig(update));
  ipcMain.handle("settings:delete-chat-saved-prompt", (_event, id: string) => desktopApp.settingsService.deleteChatSavedPromptConfig(id));

  ipcMain.handle("settings:save-chat-participant", async (_event, update: ChatParticipantConfigUpdate) => {
    const previousSettings = await desktopApp.settingsService.getPublicSettings();
    const previous = update.id?.trim()
      ? previousSettings.chatParticipantConfigs.find((participant) => participant.id === update.id?.trim())
      : undefined;
    const nextSettings = await desktopApp.settingsService.saveChatParticipantConfig(update);
    const saved = (previous?.id
      ? nextSettings.chatParticipantConfigs.find((participant) => participant.id === previous.id)
      : undefined);
    if (previous && saved) {
      await desktopApp.chatService.syncSavedParticipantConfig(previous, saved);
    }
    return nextSettings;
  });

  ipcMain.handle("settings:delete-chat-participant", (_event, id: string) => {
    return desktopApp.settingsService.deleteChatParticipantConfig(id);
  });

  ipcMain.handle("settings:update-last-repo-path", (_event, repoPath: string) => desktopApp.settingsService.updateLastRepoPath(repoPath));

  ipcMain.handle("settings:list-provider-models", async (_event, kind: ProviderKind, hostId?: unknown) => {
    if (kind === "codex-cli" || kind === "claude-code" || kind === "gemini-cli") {
      // Only Antigravity lists other models on a key than on its sign-in.
      if (kind === "gemini-cli" && typeof hostId === "string" && hostId.trim()) {
        const secret = await desktopApp.settingsService.getCliProviderHostSecret(hostId);
        return desktopApp.cliAgentRunner.listHostModelCatalog(secret && secret.host.cli === kind ? secret : undefined);
      }
      const settings = await desktopApp.settingsService.getPublicSettings();
      const configuredModel = settings.providers.find((provider) => provider.kind === kind)?.model;
      return desktopApp.cliAgentRunner.listModelCatalog(kind, configuredModel, settings.lastRepoPath);
    }
    return desktopApp.providerRunner.listModelCatalog(kind);
  });

  ipcMain.handle("claude-chrome:get", async () => desktopApp.cliAgentRunner.claudeChromeSetting());

  ipcMain.handle("claude-chrome:set", async (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") throw new Error("Claude in Chrome takes on or off.");
    return desktopApp.cliAgentRunner.setClaudeChromeEnabledByDefault(enabled);
  });
}
