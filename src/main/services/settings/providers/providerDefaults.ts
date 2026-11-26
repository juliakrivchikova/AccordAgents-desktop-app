import { applyNewChatDefaultsUpdate, newChatDefaultsForProvider, normalizeNewChatDefaults } from "../../../../shared/newChatDefaults";
import type { AppSettings, AgentHealth, ChatProviderKind, NewChatDefaultsUpdate, ProviderSettingsUpdate, SubagentProviderChange } from "../../../../shared/types";
import { applySubagentProviderChange, normalizeSubagentProvidersByProject, subagentProjectKey } from "../../../../shared/subagentProviders";
import { preferredReadyAssistantProviderKind } from "../../../../shared/cliReadiness";
import { normalizeChatProviderKind } from "../stored/storedDefaults";
import type { SettingsModules } from "../modules";

/** Providers, the Assistant's provider and what a new chat starts with. */
export class ProviderDefaults {
  private assistantProviderMutation: Promise<void> = Promise.resolve();

  constructor(private readonly settings: Pick<SettingsModules, "publicSettings" | "settingsStore">) {}

  async updateProvider(update: ProviderSettingsUpdate): Promise<AppSettings> {
    const stored = await this.settings.settingsStore.readStored();
    const provider = stored.providers.find((item) => item.kind === update.kind);
    if (!provider) {
      throw new Error(`Unknown provider: ${update.kind}`);
    }

    if (typeof update.enabled === "boolean") {
      provider.enabled = update.enabled;
    }
    if (typeof update.model === "string") {
      provider.model = update.model.trim();
    }

    await this.settings.settingsStore.writeStored(stored);
    return this.settings.publicSettings.getPublicSettings();
  }

  async setAssistantProviderKind(kind: ChatProviderKind): Promise<AppSettings> {
    const normalized = normalizeChatProviderKind(kind);
    if (!normalized) {
      throw new Error(`Unknown Assistant provider: ${kind}`);
    }
    return this.withAssistantProviderMutation(async () => {
      const stored = await this.settings.settingsStore.readStored();
      if (stored.assistantProviderKind === normalized) {
        return this.settings.publicSettings.getPublicSettings();
      }
      stored.assistantProviderKind = normalized;
      // Another CLI: a new chat's model, effort and mode go back to its own.
      stored.newChatDefaults = newChatDefaultsForProvider(stored.newChatDefaults);
      await this.settings.settingsStore.writeStored(stored);
      return this.settings.publicSettings.getPublicSettings();
    });
  }

  /** How a new chat starts besides its CLI (Settings → General → New chats,
   *  shared/newChatDefaults.ts). */
  /** A change to a project's sub-agent providers (the side panel's Project scope). */
  async updateProjectSubagentProviders(repoPath: string, change: SubagentProviderChange): Promise<AppSettings> {
    const key = subagentProjectKey(repoPath);
    if (!key) {
      throw new Error("This chat has no project folder: change its own sub-agents instead.");
    }
    return this.withAssistantProviderMutation(async () => {
      const stored = await this.settings.settingsStore.readStored();
      const byProject = normalizeSubagentProvidersByProject(stored.subagentProvidersByProject) ?? {};
      const next = applySubagentProviderChange("project", byProject[key] ?? [], change);
      if (next.length > 0) {
        byProject[key] = next;
      } else {
        delete byProject[key];
      }
      stored.subagentProvidersByProject = byProject;
      await this.settings.settingsStore.writeStored(stored);
      return this.settings.publicSettings.getPublicSettings();
    });
  }

  async setNewChatDefaults(update: NewChatDefaultsUpdate): Promise<AppSettings> {
    if (!update || typeof update !== "object" || Array.isArray(update)) {
      throw new Error("Invalid new chat settings.");
    }
    if (update.kind !== undefined && !normalizeChatProviderKind(update.kind)) {
      throw new Error(`Unknown provider: ${String(update.kind)}`);
    }
    return this.withAssistantProviderMutation(async () => {
      const stored = await this.settings.settingsStore.readStored();
      const next = applyNewChatDefaultsUpdate(stored.newChatDefaults, update);
      if (JSON.stringify(next) === JSON.stringify(normalizeNewChatDefaults(stored.newChatDefaults))) {
        return this.settings.publicSettings.getPublicSettings();
      }
      stored.newChatDefaults = next;
      await this.settings.settingsStore.writeStored(stored);
      return this.settings.publicSettings.getPublicSettings();
    });
  }

  async ensureAssistantProviderDefault(agents: AgentHealth[]): Promise<AppSettings> {
    return this.withAssistantProviderMutation(async () => {
      const stored = await this.settings.settingsStore.readStored();
      const existing = normalizeChatProviderKind(stored.assistantProviderKind);
      if (existing) {
        return this.settings.publicSettings.getPublicSettings();
      }

      const migrated = normalizeChatProviderKind(stored.lastSuccessfulChatProviderKind);
      const selected = migrated ?? preferredReadyAssistantProviderKind(agents, stored.providers);
      if (!selected) {
        return this.settings.publicSettings.getPublicSettings();
      }

      if (normalizeChatProviderKind(stored.assistantProviderKind)) {
        return this.settings.publicSettings.getPublicSettings();
      }
      stored.assistantProviderKind = selected;
      await this.settings.settingsStore.writeStored(stored);
      return this.settings.publicSettings.getPublicSettings();
    });
  }

  async recordSuccessfulChatProvider(kind: ChatProviderKind): Promise<void> {
    const stored = await this.settings.settingsStore.readStored();
    if (stored.lastSuccessfulChatProviderKind === kind) {
      return;
    }
    stored.lastSuccessfulChatProviderKind = kind;
    await this.settings.settingsStore.writeStored(stored);
  }

  private withAssistantProviderMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const run = (this.assistantProviderMutation ?? Promise.resolve()).then(mutation);
    this.assistantProviderMutation = run.then(() => undefined, () => undefined);
    return run;
  }
}
