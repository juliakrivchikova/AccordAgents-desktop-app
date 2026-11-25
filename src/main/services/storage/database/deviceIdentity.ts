import { DEVICE_IDENTITY_META_KEY } from "./schemaVersion";
import type { DeviceIdentityRecord } from "../types";
import type { StorageModules } from "../modules";

/** This device's identity record. */
export class DeviceIdentity {
  constructor(private readonly storage: Pick<StorageModules, "schema" | "sqlite">) {}

  async getDeviceIdentityRecord(): Promise<DeviceIdentityRecord | undefined> {
    await this.storage.schema.init();
    const raw = await this.storage.sqlite.getSchemaMeta(DEVICE_IDENTITY_META_KEY);
    if (!raw) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as DeviceIdentityRecord;
    this.assertValidDeviceIdentityRecord(parsed);
    return parsed;
  }

  async saveDeviceIdentityRecord(record: DeviceIdentityRecord): Promise<void> {
    await this.storage.schema.init();
    this.assertValidDeviceIdentityRecord(record);
    await this.storage.sqlite.setSchemaMeta(DEVICE_IDENTITY_META_KEY, JSON.stringify(record));
  }

  private assertValidDeviceIdentityRecord(record: DeviceIdentityRecord): void {
    const requiredStrings = [
      ["originId", record.originId],
      ["keyId", record.keyId],
      ["publicKeyDerBase64", record.publicKeyDerBase64],
      ["privateKeyDerBase64", record.privateKeyDerBase64],
      ["createdAt", record.createdAt]
    ] as const;
    for (const [field, value] of requiredStrings) {
      if (typeof value !== "string" || !value.trim()) {
        throw new Error(`This device's identity requires ${field}.`);
      }
    }
  }
}
