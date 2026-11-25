// What the AWS tests set up.
import type { AppSettings, AwsWorkerHandleInfo, AwsWorkerOperationSnapshot } from "../../../../shared/types";
import type { MachineInstallRecord } from "../../../../shared/machineInstall";
import { AWS_INSTANCE_GONE_NOTICE, CloudRunAwsService } from "../../cloudRunAws";
import type { CloudRunAwsServiceOptions } from "../../cloudRunAws";
import type { AwsWorkerCredentials } from "../../awsWorkerProvisioning";
import type { AwsWorkerInstanceInfo, Ec2Client } from "../../awsWorkerLifecycle";
import type { SettingsService } from "../../settings";

export const OLD_CREDS = { accessKeyId: "AKIAOLDKEY000000", secretAccessKey: "old-secret", region: "us-east-1" };

export const NEW_CREDS = { accessKeyId: "AKIANEWKEY000000", secretAccessKey: "new-secret", region: "us-east-1" };

export const OLD_HANDLE: AwsWorkerHandleInfo = {
  instanceId: "i-old",
  securityGroupId: "sg-old",
  keyName: "accordagents-worker-old",
  region: "us-east-1",
  instanceType: "t3.small",
  createdAt: "2026-07-03T00:00:00.000Z"
};

type LeavingEntry = { machineId: string; instanceId: string; at: string; unverified?: "refused" | "unreadable"; region?: string; accountId?: string };

export class FakeSettings {
  credentials: AwsWorkerCredentials | undefined;
  handle: AwsWorkerHandleInfo | undefined;
  mode: "ssh" | "aws" = "ssh";
  awsRootVolumeSizeGb = 8;
  deviceId = "device-a";
  volumeExpansion: { instanceId: string; volumeId: string; targetSizeGb: number; updatedAt: string } | undefined;
  provisioningToken: string | undefined;
  operation: AwsWorkerOperationSnapshot | undefined;
  machines: Array<{ id: string; awsInstanceId?: string; lastSeenAt?: string; lastHello?: { idleStopWarning?: string; autoStopEnabled?: boolean; keepAwakeScripts?: number } }> = [];
  installs: MachineInstallRecord[] = [];
  autoStopEnabled = true;
  changedAt: string | undefined;

  async getMachineAutoStopChangedAt(): Promise<string | undefined> {
    return this.changedAt;
  }

  async getMachineAutoStopEnabled(): Promise<boolean> {
    return this.autoStopEnabled;
  }

  async setMachineAutoStopEnabled(enabled: boolean): Promise<void> {
    this.autoStopEnabled = enabled;
  }

  async listMachines(): Promise<Array<{ id: string; awsInstanceId?: string; lastSeenAt?: string; lastHello?: { idleStopWarning?: string; autoStopEnabled?: boolean; keepAwakeScripts?: number } }>> {
    return this.machines;
  }

  async listMachineInstalls(): Promise<MachineInstallRecord[]> {
    return this.installs;
  }

  async getAwsWorkerCredentials(): Promise<AwsWorkerCredentials | undefined> {
    return this.credentials;
  }

  async getPublicSettings(): Promise<AppSettings> {
    return {
      betaUpdates: false,
      cloudRuns: {
        enabled: true,
        mode: this.mode,
        worker: {},
        hasAwsCredentials: Boolean(this.credentials),
        awsHandle: this.handle,
        awsInstanceType: "t3.small",
        awsRootVolumeSizeGb: this.awsRootVolumeSizeGb,
        maxRuntimeMs: 24 * 60 * 60_000,
        pollIntervalMs: 2_500
      }
    } as AppSettings;
  }

  async saveAwsWorkerCredentials(credentials: AwsWorkerCredentials): Promise<void> {
    this.credentials = credentials;
  }

  async saveAwsWorkerHandle(handle: AwsWorkerHandleInfo | undefined): Promise<void> {
    this.handle = handle;
  }

  async saveCloudRunsSettings(update: { awsRootVolumeSizeGb?: number }): Promise<AppSettings> {
    this.awsRootVolumeSizeGb = update.awsRootVolumeSizeGb ?? this.awsRootVolumeSizeGb;
    return this.getPublicSettings();
  }

  async clearAwsWorker(): Promise<void> {
    this.credentials = undefined;
    this.handle = undefined;
  }

  async setCloudRunsMode(mode: "ssh" | "aws"): Promise<void> {
    this.mode = mode;
  }

  async getCloudRunsDeviceId(): Promise<string> {
    return this.deviceId;
  }

  async saveAwsWorkerVolumeExpansion(value: typeof this.volumeExpansion): Promise<void> {
    this.volumeExpansion = value;
  }

  async getAwsWorkerVolumeExpansion(): Promise<typeof this.volumeExpansion> {
    return this.volumeExpansion;
  }

  async saveAwsWorkerProvisioningToken(token: string | undefined): Promise<void> {
    this.provisioningToken = token;
  }

  async getAwsWorkerProvisioningToken(): Promise<string | undefined> {
    return this.provisioningToken;
  }

  async getAwsWorkerOperation(): Promise<AwsWorkerOperationSnapshot | undefined> {
    return this.operation;
  }

  goneNotice: { instanceId: string; at: string } | undefined;

  async getAwsWorkerGoneNotice(): Promise<{ instanceId: string; at: string } | undefined> {
    return this.goneNotice;
  }

  leaving: LeavingEntry[] = [];

  async addLeavingMachines(entries: LeavingEntry[]): Promise<LeavingEntry[]> {
    const waiting = new Set(this.leaving.filter((entry) => !entry.unverified).map((entry) => entry.machineId));
    const incoming = entries.filter((entry) => !(entry.unverified && waiting.has(entry.machineId)));
    const ids = new Set(incoming.map((entry) => entry.machineId));
    const all = [...this.leaving.filter((entry) => !ids.has(entry.machineId)), ...incoming];
    this.leaving = all.slice(-50);
    return all.slice(0, all.length - this.leaving.length);
  }

  async listLeavingMachines(): Promise<LeavingEntry[]> {
    return this.leaving.map((entry) => ({ ...entry }));
  }

  async clearLeavingMachine(machineId: string): Promise<void> {
    this.leaving = this.leaving.filter((entry) => entry.machineId !== machineId);
  }

  async saveAwsWorkerConnection(credentials: AwsWorkerCredentials, handle: AwsWorkerHandleInfo): Promise<void> {
    this.credentials = credentials;
    this.handle = handle;
    this.mode = "aws";
    this.goneNotice = undefined;
  }

  async forgetAwsWorkerInstance(instanceId: string, options: { keepCredentials: boolean; notice?: { instanceId: string; at: string }; mode?: "ssh" | "aws" }): Promise<boolean> {
    if (this.handle?.instanceId !== instanceId) return false;
    this.handle = undefined;
    this.operation = undefined;
    this.volumeExpansion = undefined;
    if (!options.keepCredentials) {
      this.credentials = undefined;
      this.provisioningToken = undefined;
    }
    if (options.mode) this.mode = options.mode;
    this.goneNotice = options.notice;
    return true;
  }
}

export class FakeEc2Client implements Ec2Client {
  importedKeyPairs: string[] = [];
  terminatedInstances: string[] = [];
  deletedKeyPairs: string[] = [];
  deletedSecurityGroups: string[] = [];
  securityGroupNames: string[] = [];
  authorizedCidrs: string[] = [];
  revokedSecurityGroups: string[] = [];
  importError: Error | undefined;
  describeError: Error | undefined;
  describeTypeError: Error | undefined;
  terminateError: Error | undefined;
  stopError: Error | undefined;
  findErrors: Error[] = [];
  listRegionErrors: Error[] = [];
  discovered: AwsWorkerInstanceInfo[] = [];
  runCount = 0;
  describeCalls = 0;
  stopCount = 0;
  runTokens: Array<string | undefined> = [];
  modifiedSizes: number[] = [];
  enabledRegions = ["us-east-1"];
  findCalls = 0;
  listRegionCalls = 0;

  constructor(public state: AwsWorkerInstanceInfo | undefined = { instanceId: "i-new", state: "running", publicIp: "198.51.100.5" }) {}

  async resolveUbuntuImage(): Promise<{ imageId: string; rootDeviceName: string }> {
    return { imageId: "ami-ubuntu", rootDeviceName: "/dev/sda1" };
  }

  async listEnabledRegions(): Promise<string[]> {
    this.listRegionCalls += 1;
    const error = this.listRegionErrors.shift();
    if (error) throw error;
    return this.enabledRegions;
  }

  async findWorkerInstances(): Promise<AwsWorkerInstanceInfo[]> {
    this.findCalls += 1;
    const error = this.findErrors.shift();
    if (error) throw error;
    return this.discovered;
  }

  async describeInstanceType(instanceType: string): Promise<{ vCpu: number; memoryMiB: number }> {
    if (this.describeTypeError) {
      throw this.describeTypeError;
    }
    return instanceType === "t3.medium" ? { vCpu: 2, memoryMiB: 4096 } : { vCpu: 2, memoryMiB: 2048 };
  }

  async keyPairExists(): Promise<boolean> {
    return false;
  }

  async importKeyPair(name: string): Promise<void> {
    this.importedKeyPairs.push(name);
    if (this.importError) {
      throw this.importError;
    }
  }

  async deleteKeyPair(name: string): Promise<void> {
    this.deletedKeyPairs.push(name);
  }

  async ensureSecurityGroup(name: string): Promise<string> {
    this.securityGroupNames.push(name);
    return "sg-new";
  }

  async deleteSecurityGroup(securityGroupId: string): Promise<void> {
    this.deletedSecurityGroups.push(securityGroupId);
  }

  async authorizeSshIngress(_securityGroupId: string, cidr: string): Promise<void> {
    this.authorizedCidrs.push(cidr);
  }

  async revokeAllSshIngress(securityGroupId: string): Promise<void> {
    this.revokedSecurityGroups.push(securityGroupId);
  }

  async runInstance(spec: Parameters<Ec2Client["runInstance"]>[0]): Promise<string> {
    this.runCount += 1;
    this.runTokens.push(spec.clientToken);
    const info = this.state ?? { instanceId: "i-new", state: "pending" as const };
    this.discovered = [{
      ...info,
      instanceId: "i-new",
      region: "us-east-1",
      securityGroupId: "sg-new",
      keyName: "accordagents-worker-new",
      instanceType: "t3.small",
      rootVolumeSizeGb: 8
    }];
    return "i-new";
  }

  async describeInstance(): Promise<AwsWorkerInstanceInfo | undefined> {
    this.describeCalls += 1;
    if (this.describeError) {
      throw this.describeError;
    }
    return this.state;
  }

  async startInstance(): Promise<void> {
    this.state = { instanceId: this.state?.instanceId ?? "i-new", state: "running", publicIp: "198.51.100.5" };
  }

  async stopInstance(): Promise<void> {
    this.stopCount += 1;
    if (this.stopError) throw this.stopError;
    this.state = { instanceId: this.state?.instanceId ?? "i-new", state: "stopped" };
  }

  async terminateInstance(instanceId: string): Promise<void> {
    this.terminatedInstances.push(instanceId);
    if (this.terminateError) {
      throw this.terminateError;
    }
    this.state = { instanceId, state: "terminated" };
  }

  async modifyVolumeSize(_volumeId: string, sizeGb: number): Promise<void> {
    this.modifiedSizes.push(sizeGb);
    if (this.state) this.state = { ...this.state, rootVolumeSizeGb: sizeGb };
  }

  async describeVolumeModification(): Promise<"completed"> {
    return "completed";
  }
}

export function serviceWith(
  settings: FakeSettings,
  clients: Map<string, FakeEc2Client>,
  overrides: Partial<CloudRunAwsServiceOptions> = {}
): CloudRunAwsService {
  return new CloudRunAwsService(settings as unknown as SettingsService, {
    // The command's text is read below as the bash one macOS gets.
    platform: "darwin",
    createEc2Client: (credentials) => {
      const client = clients.get(`${credentials.accessKeyId}:${credentials.region}`) ?? clients.get(credentials.accessKeyId);
      if (!client) {
        throw new Error(`missing fake client for ${credentials.accessKeyId}`);
      }
      return client;
    },
    generateKeyMaterial: async () => ({
      keyName: "accordagents-worker-new",
      publicKeyOpenSsh: "ssh-ed25519 AAAA",
      privateKeyPath: "/keys/accordagents-worker-new.pem"
    }),
    deleteKeyMaterial: async () => undefined,
    currentPublicIp: async () => "203.0.113.9",
    privateKeyPathForKeyName: (keyName) => `/keys/${keyName}.pem`,
    workerAccess: { ensureAccess: async () => undefined } as any,
    wait: async () => undefined,
    ...overrides
  });
}

export async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for AWS lifecycle state.");
}

// ---- automatic stop key ----------------------------------------------------

export const POWER_HANDLE: AwsWorkerHandleInfo = { ...OLD_HANDLE, instanceId: "i-0943b28f7231ab93c" };

export const POWER_KEY = { accessKeyId: "AKIAPOWERKEY000000001", secretAccessKey: "power-secret" };

export function powerSettings(): FakeSettings {
  const settings = new FakeSettings();
  settings.credentials = { ...OLD_CREDS, power: POWER_KEY };
  settings.handle = POWER_HANDLE;
  settings.machines = [{ id: "cloud", awsInstanceId: POWER_HANDLE.instanceId }, { id: "desk-box" }];
  return settings;
}

export function installFor(machineId: string, extra: Partial<MachineInstallRecord> = {}): MachineInstallRecord {
  return { machineId, target: { host: "203.0.113.9", user: "ubuntu" }, installRoot: "/r", userDataDir: "/d", serviceName: "s",
    serviceScope: "system", installedVersion: "1.11.1", ...extra };
}

// ---- an instance that can never come back -----------------------------------

export const GONE_NOTICE = AWS_INSTANCE_GONE_NOTICE;

/** This app's instance with the machine on it, one from an older version
 *  matched by its pinned host key, and one machine elsewhere. */
export function instanceWithMachines(): { settings: FakeSettings; removed: string[]; removeMachine: (machineId: string) => Promise<void> } {
  const settings = new FakeSettings();
  settings.credentials = OLD_CREDS;
  settings.handle = OLD_HANDLE;
  settings.mode = "aws";
  settings.machines = [{ id: "cloud", awsInstanceId: OLD_HANDLE.instanceId }, { id: "older" }, { id: "elsewhere", awsInstanceId: "i-other" }];
  settings.installs = [installFor("older", { target: { host: "203.0.113.9", user: "ubuntu", hostKeyAlias: `accordagents-${OLD_HANDLE.instanceId}` } }),
    installFor("elsewhere")];
  const removed: string[] = [];
  const removeMachine = async (machineId: string): Promise<void> => {
    removed.push(machineId);
    settings.machines = settings.machines.filter((machine) => machine.id !== machineId);
    settings.installs = settings.installs.filter((record) => record.machineId !== machineId);
  };
  return { settings, removed, removeMachine };
}

export const notAuthorized = (): Error => Object.assign(new Error("You are not authorized to perform this operation."), { name: "UnauthorizedOperation" });

// ---- an instance replaced by a new one ---------------------------------------

/** Each instance answers for itself; a launch makes a new running one. */
export class InstancesEc2Client extends FakeEc2Client {
  readonly instances = new Map<string, AwsWorkerInstanceInfo>();
  readonly events: string[] = [];

  constructor(...initial: AwsWorkerInstanceInfo[]) {
    super(undefined);
    for (const info of initial) this.instances.set(info.instanceId, info);
    this.discovered = initial.filter((info) => info.state !== "terminated");
  }

  override async describeInstance(instanceId?: string): Promise<AwsWorkerInstanceInfo | undefined> {
    this.describeCalls += 1;
    if (this.describeError) throw this.describeError;
    return instanceId ? this.instances.get(instanceId) : undefined;
  }

  override async runInstance(spec: Parameters<Ec2Client["runInstance"]>[0]): Promise<string> {
    this.runCount += 1;
    const instanceId = `i-new${this.runCount}`;
    const info: AwsWorkerInstanceInfo = { instanceId, state: "running", publicIp: "198.51.100.20", region: "us-east-1",
      securityGroupId: "sg-new", keyName: "accordagents-worker-new", instanceType: spec.instanceType, rootVolumeSizeGb: 8 };
    this.instances.set(instanceId, info);
    this.discovered = [info];
    this.events.push(`launch:${instanceId}`);
    return instanceId;
  }

  override async terminateInstance(instanceId: string): Promise<void> {
    this.terminatedInstances.push(instanceId);
    if (this.terminateError) throw this.terminateError;
    const info = this.instances.get(instanceId);
    if (info) this.instances.set(instanceId, { ...info, state: "terminated" });
    this.discovered = this.discovered.filter((item) => item.instanceId !== instanceId);
    this.events.push(`terminate:${instanceId}`);
  }
}

export const OLD_RUNNING: AwsWorkerInstanceInfo = { instanceId: OLD_HANDLE.instanceId, state: "running", publicIp: "198.51.100.10", region: "us-east-1",
  securityGroupId: OLD_HANDLE.securityGroupId, keyName: OLD_HANDLE.keyName, instanceType: "t3.small", rootVolumeSizeGb: 8 };
