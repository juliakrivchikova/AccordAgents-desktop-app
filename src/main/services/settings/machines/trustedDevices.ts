import { createHash } from "node:crypto";
import { isTrustedDeviceRecord, trustedDeviceIdMatchesKey, type TrustedDeviceRecord } from "../../../../shared/machineTrust";
import { removeDeviceTrust } from "./storedMachines";
import type { SettingsModules } from "../modules";

/** Devices the User trusts. */
export class TrustedDevices {
  private trustedDeviceQueue?: Promise<void>;

  constructor(private readonly settings: Pick<SettingsModules, "settingsStore">) {}

  /** The devices the User trusts with their machines. */
  async listTrustedDevices(): Promise<TrustedDeviceRecord[]> {
    const stored = await this.settings.settingsStore.readStored();
    if (this.settings.settingsStore.readError) throw new Error("Trusted devices could not be read; the stored list was left untouched.");
    return (stored.trustedDevices ?? []).filter(isTrustedDeviceRecord).map(({ channelSealKeyBase64: _legacyKey, ...record }) => record);
  }

  serializeDeviceTrust<T>(work: () => Promise<T>): Promise<T> {
    const next = (this.trustedDeviceQueue ?? Promise.resolve()).then(work);
    this.trustedDeviceQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  /**
   * Adds or replaces a trusted device.
   *
   * The id has to be the one its key produces: a device is identified by its
   * signing key, and accepting a mismatched pair would trust a name rather
   * than a key.
   */
  saveTrustedDevice(record: TrustedDeviceRecord): Promise<TrustedDeviceRecord[]> {
    return this.serializeDeviceTrust(async () => {
      if (!isTrustedDeviceRecord(record) || !trustedDeviceIdMatchesKey(record, bytes => createHash("sha256").update(bytes).digest("hex"))) {
        throw new Error("The trusted device identity does not match its signing key.");
      }
      const stored = await this.settings.settingsStore.readStored();
      if (this.settings.settingsStore.readError) throw new Error("Trusted devices could not be read; the stored list was left untouched.");
      const records = (stored.trustedDevices ?? []).filter(entry => entry.deviceId !== record.deviceId);
      const { channelSealKeyBase64: _legacyKey, ...publicRecord } = record;
      records.push(publicRecord);
      stored.trustedDevices = records;
      await this.settings.settingsStore.writeStored(stored, true);
      return records.map(entry => ({ ...entry }));
    });
  }

  removeTrustedDevice(deviceId: string): Promise<TrustedDeviceRecord[]> {
    return this.serializeDeviceTrust(async () => {
      const stored = await this.settings.settingsStore.readStored();
      if (this.settings.settingsStore.readError) throw new Error("Trusted devices could not be read; the stored list was left untouched.");
      removeDeviceTrust(stored, deviceId);
      // The invite it enrolled with is settled as revoked: it can never bring
      // the phone back, on the server or on a machine.
      stored.hubPhoneInvites = (stored.hubPhoneInvites ?? []).map((invite) =>
        invite.deviceId === deviceId ? { ...invite, state: "revoked" as const, settledAt: new Date().toISOString() } : invite);
      await this.settings.settingsStore.writeStored(stored, true);
      return (stored.trustedDevices ?? []).map(entry => ({ ...entry }));
    });
  }
}
