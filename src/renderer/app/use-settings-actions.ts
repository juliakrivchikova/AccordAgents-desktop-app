import type {
  AgentEnvironmentSnapshot,
  ChatBehaviorRuleConfigUpdate,
  ChatParticipantConfigUpdate,
  ChatPromptContextSettings,
  ChatRoleConfigUpdate,
  ChatSavedPromptConfigUpdate,
  CloudRunsSettingsUpdate,
  DeleteAgentEnvironmentVariableRequest,
  ProviderSettings,
  RepoFileOpenAction,
  SaveAgentEnvironmentVariableRequest
} from "../../shared/types";
import { errorText } from "../components/review/review-conversation-data";
import type { AppState } from "./app-state";

export interface SettingsActions {
  updateProvider: (provider: ProviderSettings, patch: { enabled?: boolean; model?: string }) => Promise<void>;
  setRepoFileOpenPreference: (action: RepoFileOpenAction | null) => Promise<void>;
  setCliAgentRunTimeoutMs: (timeoutMs: number) => Promise<void>;
  setChatParticipantRequestMaxDepth: (maxDepth: number) => Promise<void>;
  setChatParticipantRequestPromptMaxChars: (maxChars: number) => Promise<void>;
  setChatAutoWatchWakeLimit: (limit: number) => Promise<void>;
  setChatPromptContext: (settings: ChatPromptContextSettings) => Promise<void>;
  saveCloudRunsSettings: (update: CloudRunsSettingsUpdate) => Promise<void>;
  getAgentEnvironment: () => Promise<AgentEnvironmentSnapshot>;
  saveAgentEnvironmentVariable: (request: SaveAgentEnvironmentVariableRequest) => Promise<AgentEnvironmentSnapshot>;
  deleteAgentEnvironmentVariable: (request: DeleteAgentEnvironmentVariableRequest) => Promise<AgentEnvironmentSnapshot>;
  saveChatRoleConfig: (update: ChatRoleConfigUpdate) => Promise<void>;
  archiveChatRoleConfig: (id: string) => Promise<void>;
  saveChatBehaviorRuleConfig: (update: ChatBehaviorRuleConfigUpdate) => Promise<void>;
  deleteChatBehaviorRuleConfig: (id: string) => Promise<void>;
  saveChatSavedPromptConfig: (update: ChatSavedPromptConfigUpdate) => Promise<void>;
  deleteChatSavedPromptConfig: (id: string) => Promise<void>;
  saveChatParticipantConfig: (update: ChatParticipantConfigUpdate) => Promise<void>;
  deleteChatParticipantConfig: (id: string) => Promise<void>;
}

export function useSettingsActions(state: AppState): SettingsActions {
  async function updateProvider(provider: ProviderSettings, patch: { enabled?: boolean; model?: string }): Promise<void> {
    await updateSettings(() => window.consensus.updateProviderSettings({ kind: provider.kind, ...patch }));
    if (typeof patch.enabled === "boolean") {
      if (patch.enabled) {
        state.setAgents((current) => current.map((agent) => ({ ...agent, checking: true })));
      }
      try {
        state.setAgents(await window.consensus.detectAgents({
          force: patch.enabled,
          trigger: patch.enabled ? "provider-enabled" : "service"
        }));
      } catch (caught) {
        state.setAgents((current) => current.map((agent) => ({ ...agent, checking: false })));
        state.setError(errorText(caught));
      }
    }
  }

  async function setRepoFileOpenPreference(action: RepoFileOpenAction | null): Promise<void> {
    await updateSettings(() => window.consensus.setRepoFileOpenPreference(action));
  }

  async function setCliAgentRunTimeoutMs(timeoutMs: number): Promise<void> {
    await updateSettings(() => window.consensus.setCliAgentRunTimeoutMs(timeoutMs));
  }

  async function setChatParticipantRequestMaxDepth(maxDepth: number): Promise<void> {
    await updateSettings(() => window.consensus.setChatParticipantRequestMaxDepth(maxDepth));
  }

  async function setChatParticipantRequestPromptMaxChars(maxChars: number): Promise<void> {
    await updateSettings(() => window.consensus.setChatParticipantRequestPromptMaxChars(maxChars));
  }

  async function setChatAutoWatchWakeLimit(limit: number): Promise<void> {
    await updateSettings(() => window.consensus.setChatAutoWatchWakeLimit(limit));
  }

  async function setChatPromptContext(settings: ChatPromptContextSettings): Promise<void> {
    await updateSettings(() => window.consensus.setChatPromptContext(settings));
  }

  async function saveCloudRunsSettings(update: CloudRunsSettingsUpdate): Promise<void> {
    await updateSettings(() => window.consensus.saveCloudRunsSettings(update));
  }

  async function getAgentEnvironment(): Promise<AgentEnvironmentSnapshot> {
    return loadSettingResult(() => window.consensus.getAgentEnvironment());
  }

  async function saveAgentEnvironmentVariable(request: SaveAgentEnvironmentVariableRequest): Promise<AgentEnvironmentSnapshot> {
    return loadSettingResult(() => window.consensus.saveAgentEnvironmentVariable(request));
  }

  async function deleteAgentEnvironmentVariable(request: DeleteAgentEnvironmentVariableRequest): Promise<AgentEnvironmentSnapshot> {
    return loadSettingResult(() => window.consensus.deleteAgentEnvironmentVariable(request));
  }

  async function saveChatRoleConfig(update: ChatRoleConfigUpdate): Promise<void> {
    await updateSettings(() => window.consensus.saveChatRoleConfig(update));
  }

  async function archiveChatRoleConfig(id: string): Promise<void> {
    await updateSettings(() => window.consensus.archiveChatRoleConfig(id), { rethrow: true });
  }

  async function saveChatBehaviorRuleConfig(update: ChatBehaviorRuleConfigUpdate): Promise<void> {
    await updateSettings(() => window.consensus.saveChatBehaviorRuleConfig(update));
  }

  async function deleteChatBehaviorRuleConfig(id: string): Promise<void> {
    await updateSettings(() => window.consensus.deleteChatBehaviorRuleConfig(id));
  }

  async function saveChatSavedPromptConfig(update: ChatSavedPromptConfigUpdate): Promise<void> {
    await updateSettings(() => window.consensus.saveChatSavedPromptConfig(update));
  }

  async function deleteChatSavedPromptConfig(id: string): Promise<void> {
    await updateSettings(() => window.consensus.deleteChatSavedPromptConfig(id));
  }

  async function saveChatParticipantConfig(update: ChatParticipantConfigUpdate): Promise<void> {
    state.setError(undefined);
    try {
      const next = await window.consensus.saveChatParticipantConfig(update);
      state.setSettings(next);
      if (!update.id) {
        const created = next.chatParticipantConfigs.find((participant) =>
          participant.handle.toLowerCase() === update.handle.trim().replace(/^@/, "").toLowerCase()
        );
        if (created) {
          state.setSelectedChatParticipantConfigIds((current) => new Set([...current, created.id]));
        }
      }
    } catch (caught) {
      state.setError(errorText(caught));
    }
  }

  async function deleteChatParticipantConfig(id: string): Promise<void> {
    state.setError(undefined);
    try {
      const next = await window.consensus.deleteChatParticipantConfig(id);
      state.setSettings(next);
      state.setSelectedChatParticipantConfigIds((current) => {
        const nextIds = new Set(current);
        nextIds.delete(id);
        return nextIds;
      });
    } catch (caught) {
      const message = errorText(caught);
      state.setError(message);
      throw new Error(message);
    }
  }

  async function updateSettings(load: () => Promise<typeof state.settings>, options: { rethrow?: boolean } = {}): Promise<void> {
    state.setError(undefined);
    try {
      state.setSettings(await load());
    } catch (caught) {
      const message = errorText(caught);
      state.setError(message);
      if (options.rethrow) {
        throw new Error(message);
      }
    }
  }

  async function loadSettingResult<T>(load: () => Promise<T>): Promise<T> {
    state.setError(undefined);
    try {
      return await load();
    } catch (caught) {
      const message = errorText(caught);
      state.setError(message);
      throw new Error(message);
    }
  }

  return {
    updateProvider,
    setRepoFileOpenPreference,
    setCliAgentRunTimeoutMs,
    setChatParticipantRequestMaxDepth,
    setChatParticipantRequestPromptMaxChars,
    setChatAutoWatchWakeLimit,
    setChatPromptContext,
    saveCloudRunsSettings,
    getAgentEnvironment,
    saveAgentEnvironmentVariable,
    deleteAgentEnvironmentVariable,
    saveChatRoleConfig,
    archiveChatRoleConfig,
    saveChatBehaviorRuleConfig,
    deleteChatBehaviorRuleConfig,
    saveChatSavedPromptConfig,
    deleteChatSavedPromptConfig,
    saveChatParticipantConfig,
    deleteChatParticipantConfig
  };
}
