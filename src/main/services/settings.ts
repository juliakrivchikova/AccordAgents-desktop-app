import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, safeStorage } from "electron";
import type { AppSettings, ProviderKind, ProviderSettings, ProviderSettingsUpdate } from "../../shared/types";

interface StoredSettings {
  settingsVersion?: number;
  roundLimitDefault: number;
  lastRepoPath?: string;
  providers: Array<Omit<ProviderSettings, "hasApiKey"> & { encryptedApiKey?: string }>;
}

const DEFAULT_PROVIDERS: ProviderSettings[] = [
  { kind: "openai", label: "OpenAI", enabled: false, model: "gpt-5.2" },
  { kind: "anthropic", label: "Anthropic", enabled: false, model: "claude-sonnet-4-6" },
  { kind: "gemini", label: "Gemini", enabled: false, model: "gemini-2.5-pro" },
  { kind: "codex-cli", label: "Codex CLI", enabled: true },
  { kind: "claude-code", label: "Claude Code", enabled: true }
];

export class SettingsService {
  private readonly settingsPath: string;

  constructor() {
    this.settingsPath = path.join(app.getPath("userData"), "settings.json");
  }

  async getPublicSettings(): Promise<AppSettings> {
    const stored = await this.readStored();
    return {
      roundLimitDefault: stored.roundLimitDefault,
      lastRepoPath: stored.lastRepoPath,
      providers: stored.providers.map((provider) => ({
        kind: provider.kind,
        label: provider.label,
        enabled: provider.enabled,
        model: provider.model,
        hasApiKey: Boolean(provider.encryptedApiKey)
      }))
    };
  }

  async updateProvider(update: ProviderSettingsUpdate): Promise<AppSettings> {
    const stored = await this.readStored();
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
    if (update.clearApiKey) {
      provider.encryptedApiKey = undefined;
    }
    if (typeof update.apiKey === "string" && update.apiKey.trim()) {
      provider.encryptedApiKey = this.encryptSecret(update.apiKey.trim());
    }

    await this.writeStored(stored);
    return this.getPublicSettings();
  }

  async updateLastRepoPath(repoPath: string): Promise<AppSettings> {
    const stored = await this.readStored();
    const normalized = repoPath.trim();
    stored.lastRepoPath = normalized || undefined;
    await this.writeStored(stored);
    return this.getPublicSettings();
  }

  async getApiKey(kind: ProviderKind): Promise<string | undefined> {
    const stored = await this.readStored();
    const encrypted = stored.providers.find((provider) => provider.kind === kind)?.encryptedApiKey;
    if (!encrypted) {
      return undefined;
    }
    return this.decryptSecret(encrypted);
  }

  private async readStored(): Promise<StoredSettings> {
    try {
      const raw = await readFile(this.settingsPath, "utf8");
      const parsed = JSON.parse(raw) as StoredSettings;
      return this.mergeDefaults(parsed);
    } catch {
      return this.mergeDefaults({ settingsVersion: 1, roundLimitDefault: 1, providers: DEFAULT_PROVIDERS });
    }
  }

  private async writeStored(settings: StoredSettings): Promise<void> {
    await mkdir(path.dirname(this.settingsPath), { recursive: true });
    await writeFile(this.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  }

  private mergeDefaults(settings: StoredSettings): StoredSettings {
    const providers = DEFAULT_PROVIDERS.map((fallback) => {
      const existing = settings.providers?.find((item) => item.kind === fallback.kind);
      return { ...fallback, ...existing };
    });
    return {
      settingsVersion: 1,
      roundLimitDefault: this.defaultRoundLimit(settings),
      lastRepoPath: typeof settings.lastRepoPath === "string" ? settings.lastRepoPath.trim() || undefined : undefined,
      providers
    };
  }

  private defaultRoundLimit(settings: StoredSettings): number {
    if (!Number.isFinite(settings.roundLimitDefault)) {
      return 1;
    }
    if (!settings.settingsVersion && settings.roundLimitDefault === 2) {
      return 1;
    }
    return Math.max(1, Math.floor(settings.roundLimitDefault));
  }

  private encryptSecret(secret: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("OS-backed secret encryption is not available on this machine.");
    }
    return safeStorage.encryptString(secret).toString("base64");
  }

  private decryptSecret(secret: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("OS-backed secret encryption is not available on this machine.");
    }
    return safeStorage.decryptString(Buffer.from(secret, "base64"));
  }
}
