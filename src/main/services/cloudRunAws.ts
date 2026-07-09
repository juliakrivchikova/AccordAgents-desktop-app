// AWS-managed Cloud Runs worker ownership and reconciliation. AWS tags are the
// source of truth; the persisted handle is only a fast local cache plus this
// device's SSH access key.
import type {
  AwsWorkerActualSpec,
  AwsWorkerHandleInfo,
  AwsWorkerSpec,
  AwsWorkerSpecMismatch,
  AwsWorkerStatus,
  CloudRunWorkerSettings
} from "../../shared/types";
import { normalizeAwsInstanceType, normalizeAwsRootVolumeSizeGb } from "../../shared/cloudRuns";
import { buildBootstrapCommand, parseWorkerBlob } from "./awsWorkerProvisioning";
import type { AwsWorkerCredentials } from "./awsWorkerProvisioning";
import { AwsWorkerLifecycle } from "./awsWorkerLifecycle";
import type {
  AwsWorkerDeleteResult,
  AwsWorkerHandle,
  AwsWorkerInstanceInfo,
  AwsWorkerKeyMaterial,
  Ec2Client
} from "./awsWorkerLifecycle";
import {
  createAwsEc2Client,
  deleteGeneratedAwsWorkerKeyMaterial,
  generateAwsWorkerKeyMaterial,
  resolveAwsWorkerPrivateKeyPath,
  resolveCurrentPublicIp
} from "./awsEc2Client";
import { AwsWorkerAccess } from "./awsWorkerAccess";
import { buildCloudRunSshTarget, cloudRunSshOptionArgs } from "./cloudRunWorkers";
import { runCommand } from "./command";
import type { SettingsService } from "./settings";

const WORKER_SSH_USER = "ubuntu";
const WORKER_ROOT = "~/.accordagents/remote-runs";

export interface CloudRunAwsServiceOptions {
  createEc2Client?: (credentials: AwsWorkerCredentials) => Ec2Client;
  generateKeyMaterial?: typeof generateAwsWorkerKeyMaterial;
  deleteKeyMaterial?: typeof deleteGeneratedAwsWorkerKeyMaterial;
  privateKeyPathForKeyName?: (keyName: string) => string;
  currentPublicIp?: () => Promise<string>;
  workerAccess?: AwsWorkerAccess;
  logger?: (event: string, payload: Record<string, unknown>) => void;
  randomSuffix?: () => string;
  wait?: (delayMs: number) => Promise<void>;
  sshExec?: (worker: CloudRunWorkerSettings, command: string, timeoutMs: number) => Promise<void>;
}

export interface PreparedAwsWorker {
  credentials: AwsWorkerCredentials;
  handle: AwsWorkerHandleInfo;
  info: AwsWorkerInstanceInfo;
  actualSpec: AwsWorkerActualSpec;
  desiredSpec: AwsWorkerSpec;
  mismatch?: AwsWorkerSpecMismatch;
  created: boolean;
}

export class CloudRunAwsService {
  private readonly lifecycle: AwsWorkerLifecycle;
  private readonly createEc2Client: (credentials: AwsWorkerCredentials) => Ec2Client;
  private readonly generateKeyMaterial: typeof generateAwsWorkerKeyMaterial;
  private readonly workerAccess: AwsWorkerAccess;
  private readonly randomSuffix: () => string;
  private readonly privateKeyPathForKeyName: (keyName: string) => string;
  private readonly logger?: (event: string, payload: Record<string, unknown>) => void;
  private readonly wait: (delayMs: number) => Promise<void>;
  private readonly sshExec: (worker: CloudRunWorkerSettings, command: string, timeoutMs: number) => Promise<void>;

  constructor(
    private readonly settings: SettingsService,
    options: CloudRunAwsServiceOptions = {}
  ) {
    this.logger = options.logger;
    this.createEc2Client = options.createEc2Client ?? createAwsEc2Client;
    this.generateKeyMaterial = options.generateKeyMaterial ?? generateAwsWorkerKeyMaterial;
    this.lifecycle = new AwsWorkerLifecycle({
      createEc2Client: this.createEc2Client,
      generateKeyMaterial: this.generateKeyMaterial,
      deleteKeyMaterial: async (keyName) => (options.deleteKeyMaterial ?? deleteGeneratedAwsWorkerKeyMaterial)(keyName),
      currentPublicIp: options.currentPublicIp ?? resolveCurrentPublicIp,
      logger: options.logger
    });
    this.workerAccess = options.workerAccess ?? new AwsWorkerAccess();
    this.randomSuffix = options.randomSuffix ?? (() => Math.random().toString(36).slice(2, 10));
    this.privateKeyPathForKeyName = options.privateKeyPathForKeyName ?? resolveAwsWorkerPrivateKeyPath;
    this.wait = options.wait ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.sshExec = options.sshExec ?? defaultSshExec;
  }

  bootstrapCommand(region: string): string {
    return buildBootstrapCommand(region, this.randomSuffix());
  }

  // Compatibility entry point for older renderer callers. The new UI calls
  // AwsWorkerSetupService, which continues through running + doctor setup.
  async connectWorker(blob: string, instanceType?: string, rootVolumeSizeGb?: number): Promise<AwsWorkerStatus> {
    await this.prepareWorker({ blob, instanceType, rootVolumeSizeGb, operationId: `legacy-${Date.now()}` });
    return this.status();
  }

  async prepareWorker(request: {
    blob?: string;
    instanceType?: string;
    rootVolumeSizeGb?: number;
    operationId: string;
  }): Promise<PreparedAwsWorker> {
    const credentials = request.blob?.trim()
      ? parseWorkerBlob(request.blob)
      : await this.settings.getAwsWorkerCredentials();
    if (!credentials) {
      throw new Error("Connect the AWS account before starting the worker.");
    }
    const publicSettings = await this.settings.getPublicSettings();
    const desiredType = normalizeAwsInstanceType(request.instanceType ?? publicSettings.cloudRuns.awsInstanceType);
    const desiredDisk = normalizeAwsRootVolumeSizeGb(request.rootVolumeSizeGb ?? publicSettings.cloudRuns.awsRootVolumeSizeGb);
    let matches = await this.discoverWorkers(credentials, false);
    if (matches.length > 1) throw multipleWorkerError(matches);
    if (matches.length === 0 && request.blob?.trim()) {
      const previousCredentials = await this.settings.getAwsWorkerCredentials();
      const previousHandle = publicSettings.cloudRuns.awsHandle;
      if (previousCredentials && previousHandle && previousCredentials.accessKeyId !== credentials.accessKeyId) {
        let previous: AwsWorkerInstanceInfo | undefined;
        try {
          previous = await this.clientForRegion(previousCredentials, previousHandle.region).describeInstance(previousHandle.instanceId);
        } catch (error) {
          throw new Error(`Could not verify the existing AWS worker before replacing credentials: ${errorMessage(error)}. Delete the existing worker first.`);
        }
        if (previous && previous.state !== "terminated" && previous.state !== "absent") {
          throw new Error("An AWS worker is already configured but is not visible to the new credentials. Delete the existing worker first.");
        }
      }
    }
    let created = false;
    let info = matches[0];
    let handle: AwsWorkerHandleInfo;
    if (!info) {
      const deviceId = await (this.settings as SettingsService & { getCloudRunsDeviceId?: () => Promise<string> }).getCloudRunsDeviceId?.() ?? "legacy";
      const createdHandle = await this.lifecycle.createWorker(credentials, {
        instanceType: desiredType,
        rootVolumeSizeGb: desiredDisk,
        clientToken: request.operationId.slice(0, 64),
        deviceId
      });
      created = true;
      info = await this.createEc2Client(credentials).describeInstance(createdHandle.instanceId) ?? {
        instanceId: createdHandle.instanceId,
        state: "pending",
        region: credentials.region,
        instanceType: desiredType,
        rootVolumeSizeGb: desiredDisk,
        securityGroupId: createdHandle.securityGroupId,
        keyName: createdHandle.keyName
      };
      info = {
        ...info,
        region: info.region ?? credentials.region,
        instanceType: info.instanceType ?? desiredType,
        rootVolumeSizeGb: info.rootVolumeSizeGb ?? desiredDisk,
        securityGroupId: info.securityGroupId ?? createdHandle.securityGroupId,
        keyName: info.keyName ?? createdHandle.keyName
      };
      handle = this.handleFromInfo(info, {
        keyName: createdHandle.keyName,
        privateKeyPath: createdHandle.privateKeyPath,
        securityGroupId: createdHandle.securityGroupId,
        created: true
      });
      matches = await this.discoverWorkers(credentials, true);
      if (matches.length > 1) throw multipleWorkerError(matches);
    } else {
      const key = await this.generateKeyMaterial();
      handle = this.handleFromInfo(info, {
        keyName: key.keyName,
        privateKeyPath: key.privateKeyPath,
        securityGroupId: info.securityGroupId,
        created: false
      });
    }
    await this.settings.saveCloudRunsSettings({
      awsInstanceType: desiredType,
      awsRootVolumeSizeGb: desiredDisk
    });
    const connectionSaver = (this.settings as SettingsService & {
      saveAwsWorkerConnection?: (nextCredentials: AwsWorkerCredentials, nextHandle: AwsWorkerHandleInfo) => Promise<void>;
    }).saveAwsWorkerConnection;
    if (connectionSaver) {
      await connectionSaver.call(this.settings, credentials, handle);
    } else {
      await this.settings.saveAwsWorkerCredentials(credentials);
      await this.settings.saveAwsWorkerHandle(handle);
      await this.settings.setCloudRunsMode("aws");
    }
    const actualSpec = actualSpecFrom(info, handle);
    const desiredCapacity = await this.capacityFor(credentials, desiredType);
    const desiredSpec: AwsWorkerSpec = {
      instanceType: desiredType,
      rootVolumeSizeGb: desiredDisk,
      ...desiredCapacity
    };
    const mismatch = specMismatch(actualSpec, desiredSpec);
    return { credentials, handle, info, actualSpec, desiredSpec, mismatch, created };
  }

  async acceptMismatch(prepared: PreparedAwsWorker): Promise<void> {
    await (this.settings as SettingsService & {
      saveAwsWorkerSpecAcceptance?: (instanceId: string, desired: AwsWorkerSpec) => Promise<void>;
    }).saveAwsWorkerSpecAcceptance?.(prepared.info.instanceId, prepared.desiredSpec);
  }

  async hasAcceptedMismatch(prepared: PreparedAwsWorker): Promise<boolean> {
    return await (this.settings as SettingsService & {
      hasAwsWorkerSpecAcceptance?: (instanceId: string, desired: AwsWorkerSpec) => Promise<boolean>;
    }).hasAwsWorkerSpecAcceptance?.(prepared.info.instanceId, prepared.desiredSpec) ?? false;
  }

  async growDisk(prepared: PreparedAwsWorker): Promise<PreparedAwsWorker> {
    const volumeId = prepared.info.rootVolumeId ?? prepared.handle.rootVolumeId;
    if (!volumeId) throw new Error("Could not identify the AWS worker root volume.");
    const client = this.clientForRegion(prepared.credentials, prepared.handle.region);
    if ((prepared.info.rootVolumeSizeGb ?? 0) < prepared.desiredSpec.rootVolumeSizeGb) {
      if (!client.modifyVolumeSize) throw new Error("These AWS credentials cannot grow the worker disk. Re-run the AWS setup command.");
      await client.modifyVolumeSize(volumeId, prepared.desiredSpec.rootVolumeSizeGb);
    }
    if (client.describeVolumeModification) {
      const deadline = Date.now() + 10 * 60_000;
      let expandable = false;
      while (Date.now() < deadline) {
        const state = await client.describeVolumeModification(volumeId);
        if (state === "optimizing" || state === "completed" || state === undefined) {
          expandable = true;
          break;
        }
        if (state === "failed") throw new Error("AWS failed to grow the worker disk.");
        await this.wait(5_000);
      }
      if (!expandable) throw new Error("Timed out waiting for the enlarged AWS volume to become usable.");
    }
    const worker = await this.ensurePreparedRunning(prepared);
    await this.sshExec(worker, growRootFilesystemCommand(), 5 * 60_000);
    const refreshed = await client.describeInstance(prepared.info.instanceId) ?? prepared.info;
    return {
      ...prepared,
      info: refreshed,
      handle: this.handleFromInfo(refreshed, {
        keyName: prepared.handle.accessKeyName ?? prepared.handle.keyName,
        privateKeyPath: this.privateKeyPath(prepared.handle),
        securityGroupId: prepared.handle.securityGroupId,
        created: !prepared.handle.adopted
      }),
      actualSpec: actualSpecFrom(refreshed, prepared.handle),
      mismatch: specMismatch(actualSpecFrom(refreshed, prepared.handle), prepared.desiredSpec)
    };
  }

  async recreateWorker(prepared: PreparedAwsWorker, expectedInstanceId: string, operationId: string): Promise<PreparedAwsWorker> {
    if (prepared.info.instanceId !== expectedInstanceId) {
      throw new Error("The shared worker changed after confirmation. Refresh and choose again.");
    }
    const result = await this.lifecycle.deleteWorker(prepared.credentials, this.toHandle(prepared.handle));
    if (result.terminateFailed) throw new Error(`The existing shared worker could not be terminated: ${result.terminateFailed}`);
    await this.settings.saveAwsWorkerHandle(undefined);
    return this.prepareWorker({
      operationId,
      instanceType: prepared.desiredSpec.instanceType,
      rootVolumeSizeGb: prepared.desiredSpec.rootVolumeSizeGb
    });
  }

  async ensurePreparedRunning(prepared: PreparedAwsWorker): Promise<CloudRunWorkerSettings> {
    const deviceId = await (this.settings as SettingsService & { getCloudRunsDeviceId?: () => Promise<string> }).getCloudRunsDeviceId?.() ?? "legacy";
    const running = await this.lifecycle.ensureRunning(prepared.credentials, this.toHandle(prepared.handle), deviceId);
    const key = await this.keyForHandle(prepared.handle);
    await this.workerAccess.ensureAccess(this.clientForRegion(prepared.credentials, prepared.handle.region), running, key);
    if (key.keyName !== prepared.handle.keyName) {
      prepared.handle.keyName = key.keyName;
      prepared.handle.accessKeyName = key.keyName;
      await this.settings.saveAwsWorkerHandle(prepared.handle);
    }
    return workerSettings(running.publicIp as string, key.privateKeyPath, deviceId);
  }

  async status(): Promise<AwsWorkerStatus> {
    const credentials = await this.settings.getAwsWorkerCredentials();
    const settings = await this.settings.getPublicSettings();
    const handle = settings.cloudRuns.awsHandle;
    const operation = await (this.settings as SettingsService & { getAwsWorkerOperation?: () => Promise<Awaited<ReturnType<SettingsService["getAwsWorkerOperation"]>>> }).getAwsWorkerOperation?.();
    if (!credentials || !handle) return { configured: false, operation };
    try {
      // Polling status intentionally describes only the cached worker. Account
      // fan-out is reserved for Start/recovery paths.
      const info = await this.clientForRegion(credentials, handle.region).describeInstance(handle.instanceId);
      return {
        configured: true,
        handle,
        state: info?.state ?? "absent",
        publicIp: info?.publicIp,
        actualSpec: info ? actualSpecFrom(info, handle) : undefined,
        operation
      };
    } catch (error) {
      return { configured: true, handle, operation, message: errorMessage(error) };
    }
  }

  async deleteWorker(): Promise<AwsWorkerStatus> {
    const credentials = await this.settings.getAwsWorkerCredentials();
    const settings = await this.settings.getPublicSettings();
    const handle = settings.cloudRuns.awsHandle;
    if (!credentials || !handle) return { configured: false };
    let result: AwsWorkerDeleteResult;
    try {
      result = await this.lifecycle.deleteWorker(credentials, this.toHandle(handle));
    } catch (error) {
      return { configured: true, handle, message: errorMessage(error) };
    }
    if (result.terminateFailed) {
      return {
        configured: true,
        handle,
        message: `The shared worker was not deleted; settings were retained. ${result.terminateFailed}`
      };
    }
    await this.settings.clearAwsWorker();
    await this.settings.setCloudRunsMode("ssh");
    return {
      configured: false,
      message: result.cleanupFailures.length > 0
        ? `Worker terminated with ${result.cleanupFailures.length} cleanup warning(s).`
        : undefined
    };
  }

  async stopWorker(): Promise<AwsWorkerStatus> {
    const credentials = await this.settings.getAwsWorkerCredentials();
    const settings = await this.settings.getPublicSettings();
    const handle = settings.cloudRuns.awsHandle;
    if (!credentials || !handle) return { configured: false };
    await this.lifecycle.stopWorker(credentials, this.toHandle(handle));
    return this.status();
  }

  async ensureWorkerForRun(): Promise<CloudRunWorkerSettings> {
    const credentials = await this.settings.getAwsWorkerCredentials();
    const settings = await this.settings.getPublicSettings();
    if (!credentials) throw new Error("The AWS worker is not configured. Start it in Settings first.");
    let handle = settings.cloudRuns.awsHandle;
    let info = handle
      ? await this.clientForRegion(credentials, handle.region).describeInstance(handle.instanceId)
      : undefined;
    if (!handle || !info || info.state === "terminated") {
      const prepared = await this.prepareWorker({ operationId: `run-${Date.now()}` });
      handle = prepared.handle;
      info = prepared.info;
      if (prepared.mismatch && !await this.hasAcceptedMismatch(prepared)) {
        throw new Error("The shared AWS worker is smaller than the configured requirement. Open Settings and choose Keep, Grow disk, or Recreate.");
      }
      return this.ensurePreparedRunning(prepared);
    }
    const prepared: PreparedAwsWorker = {
      credentials,
      handle,
      info,
      actualSpec: actualSpecFrom(info, handle),
      desiredSpec: {
        instanceType: settings.cloudRuns.awsInstanceType,
        rootVolumeSizeGb: settings.cloudRuns.awsRootVolumeSizeGb,
        ...await this.capacityFor(credentials, settings.cloudRuns.awsInstanceType)
      },
      mismatch: undefined,
      created: false
    };
    prepared.mismatch = specMismatch(prepared.actualSpec, prepared.desiredSpec);
    if (prepared.mismatch && !await this.hasAcceptedMismatch(prepared)) {
      throw new Error("The shared AWS worker is smaller than the configured requirement. Open Settings and choose what to do.");
    }
    return this.ensurePreparedRunning(prepared);
  }

  noteRunStarted(): void {
    this.lifecycle.runStarted();
  }

  async noteRunEnded(): Promise<void> {
    // No per-desktop auto-stop for a worker shared by multiple machines.
  }

  private async discoverWorkers(credentials: AwsWorkerCredentials, forceAll: boolean): Promise<AwsWorkerInstanceInfo[]> {
    const configured = this.createEc2Client(credentials);
    if (!configured.findWorkerInstances) return [];
    const local = await configured.findWorkerInstances();
    if (!forceAll && local.length > 0) return local;
    const regions = configured.listEnabledRegions
      ? await configured.listEnabledRegions()
      : [credentials.region];
    const others = await Promise.all(regions
      .filter((region) => region !== credentials.region)
      .map((region) => this.clientForRegion(credentials, region).findWorkerInstances?.() ?? Promise.resolve([])));
    return [...local, ...others.flat()];
  }

  private async capacityFor(credentials: AwsWorkerCredentials, instanceType: string): Promise<{ vCpu?: number; memoryMiB?: number }> {
    const described = await this.createEc2Client(credentials).describeInstanceType?.(instanceType);
    if (described) return described;
    return knownInstanceCapacity(instanceType);
  }

  private clientForRegion(credentials: AwsWorkerCredentials, region: string): Ec2Client {
    return this.createEc2Client({ ...credentials, region });
  }

  private handleFromInfo(info: AwsWorkerInstanceInfo, options: {
    keyName: string;
    privateKeyPath: string;
    securityGroupId?: string;
    created: boolean;
  }): AwsWorkerHandleInfo {
    const securityGroupId = info.securityGroupId ?? options.securityGroupId;
    if (!securityGroupId) throw new Error("The tagged worker has no manageable security group.");
    return {
      instanceId: info.instanceId,
      securityGroupId,
      keyName: options.keyName,
      accessKeyName: options.keyName,
      launchKeyName: info.keyName,
      region: info.region ?? "us-east-1",
      instanceType: normalizeAwsInstanceType(info.instanceType),
      rootVolumeSizeGb: info.rootVolumeSizeGb,
      rootVolumeId: info.rootVolumeId,
      availabilityZone: info.availabilityZone,
      vCpu: info.vCpu,
      memoryMiB: info.memoryMiB,
      adopted: !options.created,
      createdAt: info.launchedAt ?? new Date().toISOString()
    };
  }

  private toHandle(info: AwsWorkerHandleInfo): AwsWorkerHandle {
    return {
      instanceId: info.instanceId,
      securityGroupId: info.securityGroupId,
      keyName: info.accessKeyName ?? info.keyName,
      privateKeyPath: this.privateKeyPath(info),
      region: info.region
    };
  }

  private async keyForHandle(handle: AwsWorkerHandleInfo): Promise<AwsWorkerKeyMaterial> {
    const key = await this.generateKeyMaterial();
    if ((handle.accessKeyName ?? handle.keyName) === key.keyName) return key;
    return key;
  }

  private privateKeyPath(info: AwsWorkerHandleInfo): string {
    return this.privateKeyPathForKeyName(info.accessKeyName ?? info.keyName);
  }

  private log(event: string, payload: Record<string, unknown>): void {
    this.logger?.(event, payload);
  }
}

function actualSpecFrom(info: AwsWorkerInstanceInfo, handle: AwsWorkerHandleInfo): AwsWorkerActualSpec {
  return {
    instanceId: info.instanceId,
    region: info.region ?? handle.region,
    availabilityZone: info.availabilityZone ?? handle.availabilityZone,
    rootVolumeId: info.rootVolumeId ?? handle.rootVolumeId,
    instanceType: normalizeAwsInstanceType(info.instanceType ?? handle.instanceType),
    rootVolumeSizeGb: normalizeAwsRootVolumeSizeGb(info.rootVolumeSizeGb ?? handle.rootVolumeSizeGb),
    vCpu: info.vCpu ?? handle.vCpu,
    memoryMiB: info.memoryMiB ?? handle.memoryMiB
  };
}

function specMismatch(actual: AwsWorkerActualSpec, desired: AwsWorkerSpec): AwsWorkerSpecMismatch | undefined {
  const diskTooSmall = actual.rootVolumeSizeGb < desired.rootVolumeSizeGb;
  const computeTooSmall = typeof actual.vCpu === "number" && typeof actual.memoryMiB === "number"
    && typeof desired.vCpu === "number" && typeof desired.memoryMiB === "number"
    ? actual.vCpu < desired.vCpu || actual.memoryMiB < desired.memoryMiB
    : actual.instanceType !== desired.instanceType;
  return diskTooSmall || computeTooSmall
    ? { instanceId: actual.instanceId, actual, desired, diskTooSmall, computeTooSmall }
    : undefined;
}

function workerSettings(publicIp: string, identityFile: string, deviceId: string): CloudRunWorkerSettings {
  const safeDeviceId = deviceId.replace(/[^A-Za-z0-9._-]/g, "_");
  return { host: publicIp, user: WORKER_SSH_USER, identityFile, workerRoot: `${WORKER_ROOT}/devices/${safeDeviceId}` };
}

function knownInstanceCapacity(instanceType: string): { vCpu?: number; memoryMiB?: number } {
  const known: Record<string, { vCpu: number; memoryMiB: number }> = {
    "t3.small": { vCpu: 2, memoryMiB: 2048 },
    "t3.medium": { vCpu: 2, memoryMiB: 4096 },
    "t3.large": { vCpu: 2, memoryMiB: 8192 },
    "t3.xlarge": { vCpu: 4, memoryMiB: 16384 }
  };
  return known[instanceType] ?? {};
}

function multipleWorkerError(workers: AwsWorkerInstanceInfo[]): Error {
  const ids = workers.map((worker) => `${worker.instanceId} (${worker.region ?? "unknown region"})`).join(", ");
  return new Error(`Multiple tagged AccordAgents workers exist: ${ids}. Resolve the conflict in AWS before retrying; nothing was changed.`);
}

function growRootFilesystemCommand(): string {
  return [
    "set -eu",
    "root=$(findmnt -n -o SOURCE /)",
    "parent=$(lsblk -n -o PKNAME \"$root\" | head -1)",
    "if [ -n \"$parent\" ]; then part=$(lsblk -n -o PARTN \"$root\" | head -1); sudo -n env TMPDIR=/run growpart \"/dev/$parent\" \"$part\" || true; fi",
    "fstype=$(findmnt -n -o FSTYPE /)",
    "if [ \"$fstype\" = ext4 ]; then sudo -n resize2fs \"$root\"; elif [ \"$fstype\" = xfs ]; then sudo -n xfs_growfs -d /; else echo \"Unsupported root filesystem: $fstype\" >&2; exit 2; fi"
  ].join("; ");
}

async function defaultSshExec(worker: CloudRunWorkerSettings, command: string, timeoutMs: number): Promise<void> {
  const target = buildCloudRunSshTarget(worker as CloudRunWorkerSettings & { host: string });
  await runCommand("ssh", [...cloudRunSshOptionArgs(worker as CloudRunWorkerSettings & { host: string }), target, command], { timeoutMs });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
