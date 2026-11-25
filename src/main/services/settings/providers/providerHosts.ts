import { randomUUID } from "node:crypto";
import type { AppSettings, CliProviderHost, CliProviderHostUpdate } from "../../../../shared/types";
import {
  cliProviderHostDefaultModel, cliProviderHostValidationError, normalizeCliProviderHostBaseUrl, normalizeCliProviderHostLabel
} from "../../../../shared/cliProviderHosts";
import { normalizedCliProviderHosts, publicCliProviderHosts } from "./storedHosts";
import type { StoredCliProviderHost } from "../types";
import type { SettingsModules } from "../modules";

/** Providers the User added (an endpoint and its key). */
export class ProviderHosts {
  constructor(private readonly settings: Pick<SettingsModules, "publicSettings" | "secrets" | "settingsStore">) {}

  async listCliProviderHosts(): Promise<CliProviderHost[]> {
    return publicCliProviderHosts(await this.settings.settingsStore.readStored());
  }

  async saveCliProviderHost(update: CliProviderHostUpdate): Promise<AppSettings> {
    const error = cliProviderHostValidationError(update);
    if (error) {
      throw new Error(error);
    }
    const stored = await this.settings.settingsStore.readStored();
    const hosts = normalizedCliProviderHosts(stored);
    const normalizedId = update.id?.trim();
    const existing = normalizedId ? hosts.find((host) => host.id === normalizedId) : undefined;
    if (normalizedId && !existing) {
      throw new Error("That provider no longer exists.");
    }
    const label = normalizeCliProviderHostLabel(update.label);
    if (hosts.some((host) => host.id !== existing?.id && host.label.toLowerCase() === label.toLowerCase())) {
      throw new Error(`A provider named "${label}" already exists.`);
    }
    // Members bound to this provider run through its CLI; changing the CLI
    // underneath them would silently switch their runtime.
    if (existing && existing.cli !== update.cli && (stored.chatParticipantConfigs ?? []).some((config) => config.hostId === existing.id)) {
      throw new Error("Members are bound to this provider; remove them from it before changing its CLI.");
    }
    let encryptedApiKey = existing?.encryptedApiKey;
    let protection = existing?.protection;
    if (update.apiKey !== undefined) {
      const apiKey = update.apiKey.trim();
      if (apiKey) {
        const encoded = this.settings.secrets.encodeAgentEnvironmentValue(apiKey);
        encryptedApiKey = encoded.encryptedValue;
        protection = encoded.protection;
      } else {
        encryptedApiKey = undefined;
        protection = undefined;
      }
    }
    const next: StoredCliProviderHost = {
      id: existing?.id ?? randomUUID(),
      label,
      cli: update.cli,
      vendor: update.vendor,
      baseUrl: normalizeCliProviderHostBaseUrl(update.baseUrl) ?? "",
      encryptedApiKey,
      protection,
      updatedAt: new Date().toISOString()
    };
    stored.cliProviderHosts = existing
      ? hosts.map((host) => (host.id === existing.id ? next : host))
      : [...hosts, next];
    if (existing && existing.vendor !== next.vendor) {
      // A model id only exists on the vendor it came from; presets bound to this
      // provider take the new vendor's default (chat members are handled by
      // ChatService.syncCliProviderHost).
      stored.chatParticipantConfigs = (stored.chatParticipantConfigs ?? []).map((config) =>
        config.hostId === existing.id ? { ...config, model: cliProviderHostDefaultModel(next) } : config
      );
    }
    await this.settings.settingsStore.writeStored(stored);
    return this.settings.publicSettings.getPublicSettings();
  }

  async deleteCliProviderHost(id: string): Promise<AppSettings> {
    const stored = await this.settings.settingsStore.readStored();
    const hosts = normalizedCliProviderHosts(stored);
    const normalizedId = id.trim();
    if (!hosts.some((host) => host.id === normalizedId)) {
      return this.settings.publicSettings.getPublicSettings();
    }
    stored.cliProviderHosts = hosts.filter((host) => host.id !== normalizedId);
    // Presets and chat members keep their (now dangling) binding on purpose:
    // they fail with a clear "was removed" message until the user binds them
    // to another provider, instead of silently switching to the built-in CLI.
    await this.settings.settingsStore.writeStored(stored);
    return this.settings.publicSettings.getPublicSettings();
  }

  /** The host plus its decrypted key, for a run. Never crosses the bridge. */
  async getCliProviderHostSecret(id: string): Promise<{ host: CliProviderHost; apiKey: string | undefined } | undefined> {
    const stored = await this.settings.settingsStore.readStored();
    const host = normalizedCliProviderHosts(stored).find((item) => item.id === id.trim());
    if (!host) {
      return undefined;
    }
    const apiKey = host.encryptedApiKey
      ? this.settings.secrets.decodeAgentEnvironmentValue({ key: host.id, encryptedValue: host.encryptedApiKey, updatedAt: host.updatedAt, protection: host.protection })
      : undefined;
    return {
      host: { id: host.id, label: host.label, cli: host.cli, vendor: host.vendor, baseUrl: host.baseUrl, hasApiKey: Boolean(host.encryptedApiKey), updatedAt: host.updatedAt },
      apiKey: apiKey?.trim() || undefined
    };
  }
}
