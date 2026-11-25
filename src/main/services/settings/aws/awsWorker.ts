import { hostPlatform } from "../../../platform";
import type {
  AwsWorkerHandleInfo, AwsWorkerOperationSnapshot, AwsWorkerSpec, AwsWorkerVolumeExpansion, CloudRunWorkerMode
} from "../../../../shared/types";
import type { AwsWorkerCredentials } from "../../awsWorkerProvisioning";
import {
  type AwsWorkerGoneNotice, LEAVING_MACHINES_LIMIT, type LeavingMachine, normalizeAwsWorkerGoneNotice, normalizeLeavingMachines
} from "./leavingMachines";
import { normalizeAwsWorkerOperation, normalizeAwsWorkerSpecAcceptance, normalizeAwsWorkerVolumeExpansion } from "./storedAws";
import type { SettingsModules } from "../modules";

/** The User's AWS machine as this computer knows it. */
export class AwsWorker {
  constructor(private readonly settings: Pick<SettingsModules, "settingsStore">) {}

  // AWS-managed worker credential storage. Credentials are encrypted with
  // Electron safeStorage (same protection as provider API keys) and never
  // leave the main process; only hasAwsCredentials + the handle are public.
  async saveAwsWorkerCredentials(credentials: AwsWorkerCredentials): Promise<void> {
    const stored = await this.settings.settingsStore.readStored();
    const json = JSON.stringify(credentials);
    stored.encryptedAwsCredentials = hostPlatform().secrets.isEncryptionAvailable()
      ? hostPlatform().secrets.encryptString(json).toString("base64")
      : Buffer.from(json, "utf8").toString("base64");
    stored.awsWorkerRegion = credentials.region;
    stored.cloudRunsMode = "aws";
    await this.settings.settingsStore.writeStored(stored);
  }

  async getAwsWorkerCredentials(): Promise<AwsWorkerCredentials | undefined> {
    const stored = await this.settings.settingsStore.readStored();
    if (!stored.encryptedAwsCredentials) {
      return undefined;
    }
    try {
      const buffer = Buffer.from(stored.encryptedAwsCredentials, "base64");
      const json = hostPlatform().secrets.isEncryptionAvailable()
        ? hostPlatform().secrets.decryptString(buffer)
        : buffer.toString("utf8");
      const parsed = JSON.parse(json) as Partial<AwsWorkerCredentials>;
      if (parsed.accessKeyId && parsed.secretAccessKey && parsed.region) {
        return parsed as AwsWorkerCredentials;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  async saveAwsWorkerHandle(handle: AwsWorkerHandleInfo | undefined): Promise<void> {
    const stored = await this.settings.settingsStore.readStored();
    stored.awsWorkerHandle = handle;
    await this.settings.settingsStore.writeStored(stored);
  }

  async saveAwsWorkerConnection(credentials: AwsWorkerCredentials, handle: AwsWorkerHandleInfo): Promise<void> {
    const stored = await this.settings.settingsStore.readStored();
    const json = JSON.stringify(credentials);
    stored.encryptedAwsCredentials = hostPlatform().secrets.isEncryptionAvailable()
      ? hostPlatform().secrets.encryptString(json).toString("base64")
      : Buffer.from(json, "utf8").toString("base64");
    stored.awsWorkerRegion = credentials.region;
    stored.awsWorkerHandle = handle;
    stored.cloudRunsMode = "aws";
    // Another instance is connected: the old one's removal is no longer news.
    stored.awsWorkerGoneNotice = undefined;
    await this.settings.settingsStore.writeStored(stored);
  }

  async saveAwsWorkerOperation(operation: AwsWorkerOperationSnapshot | undefined): Promise<void> {
    const stored = await this.settings.settingsStore.readStored();
    stored.awsWorkerOperation = operation;
    await this.settings.settingsStore.writeStored(stored);
  }

  async getAwsWorkerOperation(): Promise<AwsWorkerOperationSnapshot | undefined> {
    const stored = await this.settings.settingsStore.readStored();
    return normalizeAwsWorkerOperation(stored.awsWorkerOperation);
  }

  async saveAwsWorkerProvisioningToken(token: string | undefined): Promise<void> {
    const stored = await this.settings.settingsStore.readStored();
    stored.awsWorkerProvisioningToken = token?.trim().slice(0, 64) || undefined;
    await this.settings.settingsStore.writeStored(stored);
  }

  async getAwsWorkerProvisioningToken(): Promise<string | undefined> {
    const stored = await this.settings.settingsStore.readStored();
    return stored.awsWorkerProvisioningToken?.trim() || undefined;
  }

  async saveAwsWorkerVolumeExpansion(expansion: AwsWorkerVolumeExpansion | undefined): Promise<void> {
    const stored = await this.settings.settingsStore.readStored();
    stored.awsWorkerVolumeExpansion = expansion;
    await this.settings.settingsStore.writeStored(stored);
  }

  async getAwsWorkerVolumeExpansion(): Promise<AwsWorkerVolumeExpansion | undefined> {
    const stored = await this.settings.settingsStore.readStored();
    return normalizeAwsWorkerVolumeExpansion(stored.awsWorkerVolumeExpansion);
  }

  /** Forgets the AWS instance `instanceId` in one write, and only while it
   *  is still the saved one; false when another instance was saved meanwhile.
   *  Without `keepCredentials` this app's AWS keys go too (Delete). The
   *  notice, when given, is what the AWS page says about it; otherwise any
   *  earlier one ends. */
  async forgetAwsWorkerInstance(instanceId: string, options: {
    keepCredentials: boolean;
    notice?: AwsWorkerGoneNotice;
    mode?: CloudRunWorkerMode;
  }): Promise<boolean> {
    const stored = await this.settings.settingsStore.readStored();
    if (stored.awsWorkerHandle?.instanceId !== instanceId) return false;
    stored.awsWorkerHandle = undefined;
    stored.awsWorkerOperation = undefined;
    stored.awsWorkerSpecAcceptance = undefined;
    stored.awsWorkerVolumeExpansion = undefined;
    if (!options.keepCredentials) {
      stored.encryptedAwsCredentials = undefined;
      stored.awsWorkerRegion = undefined;
      stored.awsWorkerProvisioningToken = undefined;
    }
    if (options.mode) stored.cloudRunsMode = options.mode;
    stored.awsWorkerGoneNotice = normalizeAwsWorkerGoneNotice(options.notice);
    await this.settings.settingsStore.writeStored(stored);
    return true;
  }

  async getAwsWorkerGoneNotice(): Promise<AwsWorkerGoneNotice | undefined> {
    return normalizeAwsWorkerGoneNotice((await this.settings.settingsStore.readStored()).awsWorkerGoneNotice);
  }

  /** Records machines that leave with their instance, before any is
   *  removed. Returns the oldest entries the limit dropped, if any. */
  async addLeavingMachines(entries: LeavingMachine[]): Promise<LeavingMachine[]> {
    if (!entries.length) return [];
    const stored = await this.settings.settingsStore.readStored();
    // An entry already waiting for removal (its instance was seen gone) is
    // never turned into one the app may not remove.
    const waiting = new Set((stored.leavingMachines ?? []).filter((entry) => !entry.unverified).map((entry) => entry.machineId));
    const incoming = entries.filter((entry) => !(entry.unverified && waiting.has(entry.machineId)));
    const ids = new Set(incoming.map((entry) => entry.machineId));
    const all = normalizeLeavingMachines([...(stored.leavingMachines ?? []).filter((entry) => !ids.has(entry.machineId)),
      ...incoming.map((entry) => structuredClone(entry))], Number.MAX_SAFE_INTEGER) ?? [];
    const kept = all.slice(-LEAVING_MACHINES_LIMIT);
    // A new object: a write that fails leaves the settings in memory as the
    // disk has them.
    await this.settings.settingsStore.writeStored({ ...stored, leavingMachines: kept.length ? kept : undefined }, true);
    return all.slice(0, all.length - kept.length);
  }

  async listLeavingMachines(): Promise<LeavingMachine[]> {
    return (normalizeLeavingMachines((await this.settings.settingsStore.readStored()).leavingMachines) ?? []).map((entry) => ({ ...entry }));
  }

  async clearLeavingMachine(machineId: string): Promise<void> {
    const stored = await this.settings.settingsStore.readStored();
    if (!stored.leavingMachines?.some((entry) => entry.machineId === machineId)) return;
    stored.leavingMachines = normalizeLeavingMachines(stored.leavingMachines.filter((entry) => entry.machineId !== machineId));
    await this.settings.settingsStore.writeStored(stored);
  }

  async saveAwsWorkerSpecAcceptance(instanceId: string, desired: AwsWorkerSpec): Promise<void> {
    const stored = await this.settings.settingsStore.readStored();
    stored.awsWorkerSpecAcceptance = { instanceId, desired };
    await this.settings.settingsStore.writeStored(stored);
  }

  async hasAwsWorkerSpecAcceptance(instanceId: string, desired: AwsWorkerSpec): Promise<boolean> {
    const stored = await this.settings.settingsStore.readStored();
    const acceptance = normalizeAwsWorkerSpecAcceptance(stored.awsWorkerSpecAcceptance);
    return acceptance?.instanceId === instanceId
      && acceptance.desired.instanceType === desired.instanceType
      && acceptance.desired.rootVolumeSizeGb === desired.rootVolumeSizeGb;
  }

  async clearAwsWorker(): Promise<void> {
    const stored = await this.settings.settingsStore.readStored();
    stored.encryptedAwsCredentials = undefined;
    stored.awsWorkerHandle = undefined;
    stored.awsWorkerRegion = undefined;
    stored.awsWorkerOperation = undefined;
    stored.awsWorkerProvisioningToken = undefined;
    stored.awsWorkerSpecAcceptance = undefined;
    stored.awsWorkerVolumeExpansion = undefined;
    await this.settings.settingsStore.writeStored(stored);
  }
}
