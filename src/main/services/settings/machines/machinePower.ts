import { assertAwsMachinePowerConfig, type AwsMachinePowerConfig } from "../../../../shared/machinePower";
import type { MachinePowerHandoffRecord } from "../../../../shared/machinePowerHandoff";
import type { SettingsModules } from "../modules";

/** `encryptedMachinePowerPrevious` when the key a save replaced was none. */
const NO_MACHINE_POWER = "none";

/** When a machine stops by itself, and with which key. */
export class MachinePower {
  constructor(private readonly settings: Pick<SettingsModules, "secrets" | "settingsStore">) {}

  async getMachineInactivityCheckAt(): Promise<string | undefined> {
    return (await this.settings.settingsStore.readStored()).machineInactivityCheckAt;
  }

  async saveMachineInactivityCheckAt(at: string): Promise<void> {
    const stored = await this.settings.settingsStore.readStored();
    stored.machineInactivityCheckAt = at;
    await this.settings.settingsStore.writeStored(stored);
  }

  /** Whether the User left automatic stop on; the stop key is separate. */
  async getMachineAutoStopEnabled(): Promise<boolean> {
    const stored = await this.settings.settingsStore.readStored();
    // An unreadable file is not a switch left on: the machine must not stop
    // the instance on defaults the User never chose.
    if (this.settings.settingsStore.readError) throw new Error("Settings could not be read; automatic stop waits until they can.");
    return stored.machineAutoStopEnabled !== false;
  }

  async getMachineAutoStopChangedAt(): Promise<string | undefined> {
    return (await this.settings.settingsStore.readStored()).machineAutoStopChangedAt;
  }

  async setMachineAutoStopEnabled(enabled: boolean): Promise<void> {
    const stored = await this.settings.settingsStore.readStored();
    if (this.settings.settingsStore.readError) throw new Error("Settings could not be read; nothing was changed.");
    stored.machineAutoStopEnabled = enabled === true;
    stored.machineAutoStopChangedAt = new Date().toISOString();
    await this.settings.settingsStore.writeStored(stored, true);
  }

  async getMachinePower(): Promise<AwsMachinePowerConfig | undefined> {
    const stored = await this.settings.settingsStore.readStored();
    if (this.settings.settingsStore.readError) throw new Error("Machine power settings could not be read; an unreadable file is not an absent power key.");
    if (!stored.encryptedMachinePower) return undefined;
    const config: unknown = JSON.parse(this.settings.secrets.openJson(stored.encryptedMachinePower));
    assertAwsMachinePowerConfig(config);
    return config;
  }

  /** Start-key handoffs to devices (Rule 3). Records only; the key itself is
   *  the phone's start key in the AWS credentials, and reaches a device only
   *  inside its pairing link. */
  async listMachinePowerHandoffs(): Promise<MachinePowerHandoffRecord[]> {
    const stored = await this.settings.settingsStore.readStored();
    return (stored.machinePowerHandoffs ?? []).map((record) => ({ ...record }));
  }

  async saveMachinePowerHandoffs(records: MachinePowerHandoffRecord[]): Promise<void> {
    const stored = await this.settings.settingsStore.readStored();
    await this.settings.settingsStore.writeStored({ ...stored, machinePowerHandoffs: records.length ? records.map((r) => ({ ...r })) : undefined }, true);
  }

  /** Puts back the power key the last save replaced (none, if there was
   *  none): the runtime did not come back after a handover, and the key it
   *  ran with before is the one known to work. */
  async revertMachinePower(): Promise<void> {
    const stored = await this.settings.settingsStore.readStored();
    if (this.settings.settingsStore.readError) throw new Error("Machine power settings could not be read; the existing file was left untouched.");
    const previous = stored.encryptedMachinePowerPrevious;
    if (!previous) return;
    await this.settings.settingsStore.writeStored({ ...stored, encryptedMachinePower: previous === NO_MACHINE_POWER ? undefined : previous, encryptedMachinePowerPrevious: undefined }, true);
  }

  async saveMachinePower(config: AwsMachinePowerConfig): Promise<void> {
    assertAwsMachinePowerConfig(config);
    const stored = await this.settings.settingsStore.readStored();
    if (this.settings.settingsStore.readError) throw new Error("Machine power settings could not be read; the existing file was left untouched.");
    await this.settings.settingsStore.writeStored({
      ...stored,
      encryptedMachinePower: this.settings.secrets.sealJson(JSON.stringify(config)),
      encryptedMachinePowerPrevious: stored.encryptedMachinePower ?? NO_MACHINE_POWER
    }, true);
  }
}
