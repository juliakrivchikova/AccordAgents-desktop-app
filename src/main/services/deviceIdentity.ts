import { createHash, generateKeyPairSync } from "node:crypto";
import type { DeviceIdentityRecord, StorageService } from "./storage";

/**
 * This device's own ed25519 identity, created once and kept in its database.
 * It signs the device's requests to the User's server (`Authorization:
 * Accord …`, signHubRequest) and what the device seals and signs in a
 * machine's room; the server admits it by the key the roster names. Nothing
 * a device writes to a chat carries a signature of its own: the server owns
 * the chats (agreements Д1, Д10).
 */
export class DeviceIdentityService {
  private deviceIdentity?: DeviceIdentityRecord;
  private deviceIdentityLoad?: Promise<DeviceIdentityRecord>;

  constructor(
    private readonly storage: Pick<StorageService, "getDeviceIdentityRecord" | "saveDeviceIdentityRecord">,
    private readonly now: () => Date = () => new Date()
  ) {}

  async getOrCreateDeviceIdentity(): Promise<DeviceIdentityRecord> {
    if (this.deviceIdentity) return this.deviceIdentity;
    this.deviceIdentityLoad ??= this.loadOrCreate().finally(() => {
      this.deviceIdentityLoad = undefined;
    });
    return this.deviceIdentityLoad;
  }

  private async loadOrCreate(): Promise<DeviceIdentityRecord> {
    const existing = await this.storage.getDeviceIdentityRecord();
    if (existing) {
      this.deviceIdentity = existing;
      return existing;
    }
    const created = createDeviceIdentity(this.now().toISOString());
    await this.storage.saveDeviceIdentityRecord(created);
    this.deviceIdentity = created;
    return created;
  }
}

export function createDeviceIdentity(createdAt: string): DeviceIdentityRecord {
  const pair = generateKeyPairSync("ed25519");
  const publicKeyDer = pair.publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const privateKeyDer = pair.privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const keyHash = createHash("sha256").update(publicKeyDer).digest("hex");
  return {
    originId: `device-${keyHash.slice(0, 32)}`,
    keyId: `ed25519-${keyHash.slice(0, 32)}`,
    publicKeyDerBase64: publicKeyDer.toString("base64"),
    privateKeyDerBase64: privateKeyDer.toString("base64"),
    createdAt
  };
}
