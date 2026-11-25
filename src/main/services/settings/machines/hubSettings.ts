import type { MobilePairingPackage } from "../../../../shared/mobilePairing";
import { isAcceptableHubUrl } from "../../../../shared/hubProtocol";
import type { HubLinkConfig } from "../../../../shared/hubSetup";
import type { SettingsModules } from "../modules";

/** The User's server as this computer knows it. */
export class HubSettings {
  constructor(private readonly settings: Pick<SettingsModules, "machineSnapshot" | "settingsStore">) {}

  async getMachinePairing(pairingKey: string): Promise<MobilePairingPackage | undefined> {
    const stored = await this.settings.settingsStore.readStored();
    return this.settings.machineSnapshot.readMachinePairings(stored)[pairingKey];
  }

  /** The hub this desktop syncs with. `ACCORDAGENTS_HUB_URL` points a local
   *  run at a test hub. An address that is neither HTTPS nor on this
   *  computer is not used. */
  async getHubConfig(): Promise<HubLinkConfig | undefined> {
    const override = process.env.ACCORDAGENTS_HUB_URL?.trim();
    if (override) return isAcceptableHubUrl(override) ? { url: override } : undefined;
    const stored = (await this.settings.settingsStore.readStored()).hub;
    return stored && typeof stored.url === "string" && isAcceptableHubUrl(stored.url) ? stored : undefined;
  }

  /** Setup writes this once the User's hub answers (the hub setup flow). */
  async saveHubConfig(config: HubLinkConfig | undefined): Promise<void> {
    if (config && !isAcceptableHubUrl(config.url)) throw new Error("A hub is reached over HTTPS.");
    const stored = await this.settings.settingsStore.readStored();
    if (this.settings.settingsStore.readError) throw new Error("Settings could not be read; nothing was changed.");
    if (config) stored.hub = { url: config.url, ...(config.hubId ? { hubId: config.hubId } : {}), ...(config.hubKey ? { hubKey: config.hubKey } : {}), ...(config.server ? { server: config.server } : {}) };
    else delete stored.hub;
    await this.settings.settingsStore.writeStored(stored, true);
  }
}
