import type {
  ChatBehaviorRuleConfigUpdate,
  ChatParticipantConfigUpdate,
  ChatRoleConfigUpdate,
  ChatSavedPromptConfigUpdate,
  ProviderSettings,
  RepoFileOpenAction,
  UserProfileSettings
} from "../../shared/types";
import { errorText } from "../components/review/review-conversation-data";
import type { AppState } from "./app-state";

export interface SettingsActions {
  updateProvider: (provider: ProviderSettings, patch: { enabled?: boolean; model?: string }) => Promise<void>;
  setRepoFileOpenPreference: (action: RepoFileOpenAction | null) => Promise<void>;
  setCliAgentRunTimeoutMs: (timeoutMs: number) => Promise<void>;
  setChatParticipantRequestMaxDepth: (maxDepth: number) => Promise<void>;
  saveUserProfileSettings: (profile: UserProfileSettings) => Promise<void>;
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

  async function saveUserProfileSettings(profile: UserProfileSettings): Promise<void> {
    await updateSettings(() => window.consensus.saveUserProfileSettings(profile), { rethrow: true });
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

  return {
    updateProvider,
    setRepoFileOpenPreference,
    setCliAgentRunTimeoutMs,
    setChatParticipantRequestMaxDepth,
    saveUserProfileSettings,
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
