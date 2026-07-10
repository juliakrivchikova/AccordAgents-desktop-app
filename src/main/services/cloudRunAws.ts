// Orchestrates the AWS-managed Cloud Runs worker: owns credential storage,
// the lifecycle, and turning "run a remote participant" into a reachable SSH
// worker target. The chat run path calls ensureWorkerForRun(); the coordinator
// calls noteRunStarted/noteRunEnded for idle auto-stop.
import { randomUUID } from "node:crypto";
import type {
  AwsWorkerHandleInfo,
  AwsWorkerStatus,
  CloudRunWorkerSettings
} from "../../shared/types";
import {
  buildBootstrapCommand,
  parseWorkerBlob
} from "./awsWorkerProvisioning";
import type { AwsWorkerCredentials } from "./awsWorkerProvisioning";
import { normalizeAwsRootVolumeSizeGb } from "../../shared/cloudRuns";
import { AwsWorkerLifecycle } from "./awsWorkerLifecycle";
import type { AwsWorkerDeleteResult, AwsWorkerHandle, Ec2Client } from "./awsWorkerLifecycle";
import {
  createAwsEc2Client,
  deleteGeneratedAwsWorkerKeyMaterial,
  generateAwsWorkerKeyMaterial,
  resolveAwsWorkerPrivateKeyPath,
  resolveCurrentPublicIp
} from "./awsEc2Client";
import type { SettingsService } from "./settings";
import type {
  RemoteRunWorkerTarget,
  RemoteWorkerStopAuthorization,
  RemoteWorkerStopLease
} from "./remoteRuns";

const WORKER_SSH_USER = "ubuntu";
const WORKER_ROOT = "~/.accordagents/remote-runs";

export interface CloudRunAwsServiceOptions {
  createEc2Client?: (credentials: AwsWorkerCredentials) => Ec2Client;
  generateKeyMaterial?: typeof generateAwsWorkerKeyMaterial;
  deleteKeyMaterial?: typeof deleteGeneratedAwsWorkerKeyMaterial;
  privateKeyPathForKeyName?: (keyName: string) => string;
  currentPublicIp?: () => Promise<string>;
  logger?: (event: string, payload: Record<string, unknown>) => void;
  randomSuffix?: () => string;
  idleStopMs?: number;
  idleStopRetryMs?: number;
  automaticStopGate?: {
    authorizeAutomaticWorkerStop(worker: RemoteRunWorkerTarget, ownerId: string): Promise<RemoteWorkerStopAuthorization>;
    renewAutomaticWorkerStopLease(worker: RemoteRunWorkerTarget, lease: RemoteWorkerStopLease): Promise<RemoteWorkerStopLease>;
    releaseAutomaticWorkerStopLease(worker: RemoteRunWorkerTarget, lease: RemoteWorkerStopLease): Promise<void>;
  };
}

export class CloudRunAwsService {
  private readonly lifecycle: AwsWorkerLifecycle;
  private readonly randomSuffix: () => string;
  private readonly privateKeyPathForKeyName: (keyName: string) => string;
  private readonly logger?: (event: string, payload: Record<string, unknown>) => void;
  private readonly automaticStopOwnerId = randomUUID();
  private readonly activeRunIds = new Set<string>();

  constructor(
    private readonly settings: SettingsService,
    options: CloudRunAwsServiceOptions = {}
  ) {
    this.logger = options.logger;
    this.lifecycle = new AwsWorkerLifecycle({
      createEc2Client: options.createEc2Client ?? createAwsEc2Client,
      generateKeyMaterial: options.generateKeyMaterial ?? generateAwsWorkerKeyMaterial,
      deleteKeyMaterial: async (keyName) => (options.deleteKeyMaterial ?? deleteGeneratedAwsWorkerKeyMaterial)(keyName),
      currentPublicIp: options.currentPublicIp ?? resolveCurrentPublicIp,
      authorizeAutomaticStop: async (info) => {
        const gate = options.automaticStopGate;
        if (!gate || !info.publicIp) {
          return undefined;
        }
        const publicSettings = await this.settings.getPublicSettings();
        const handle = publicSettings.cloudRuns.awsHandle;
        if (!handle) {
          return undefined;
        }
        const worker: RemoteRunWorkerTarget = {
          host: info.publicIp,
          user: WORKER_SSH_USER,
          identityFile: this.privateKeyPath(handle),
          workerRoot: WORKER_ROOT
        };
        const authorization = await gate.authorizeAutomaticWorkerStop(worker, this.automaticStopOwnerId);
        if (!authorization.allowed || !authorization.lease) {
          return undefined;
        }
        let lease = authorization.lease;
        return {
          renew: async () => {
            lease = await gate.renewAutomaticWorkerStopLease(worker, lease);
          },
          release: async () => {
            await gate.releaseAutomaticWorkerStopLease(worker, lease);
          }
        };
      },
      idleStopMs: options.idleStopMs,
      idleStopRetryMs: options.idleStopRetryMs,
      logger: options.logger
    });
    this.randomSuffix = options.randomSuffix ?? (() => Math.random().toString(36).slice(2, 10));
    this.privateKeyPathForKeyName = options.privateKeyPathForKeyName ?? resolveAwsWorkerPrivateKeyPath;
  }

  // The user runs this in their own terminal (AWS auth) to mint the scoped key.
  bootstrapCommand(region: string): string {
    return buildBootstrapCommand(region, this.randomSuffix());
  }

  async connectWorker(blob: string, instanceType?: string, rootVolumeSizeGb?: number): Promise<AwsWorkerStatus> {
    const credentials = parseWorkerBlob(blob);
    await this.assertCanCreateWorker();
    const settings = await this.settings.getPublicSettings();
    const normalizedRootVolumeSizeGb = normalizeAwsRootVolumeSizeGb(
      rootVolumeSizeGb ?? settings.cloudRuns.awsRootVolumeSizeGb
    );
    const handle = await this.lifecycle.createWorker(credentials, {
      instanceType,
      rootVolumeSizeGb: normalizedRootVolumeSizeGb
    });
    const info: AwsWorkerHandleInfo = {
      instanceId: handle.instanceId,
      securityGroupId: handle.securityGroupId,
      keyName: handle.keyName,
      region: handle.region,
      instanceType: instanceType?.trim() || "t3.small",
      rootVolumeSizeGb: normalizedRootVolumeSizeGb,
      createdAt: new Date().toISOString()
    };
    await this.settings.saveAwsWorkerCredentials(credentials);
    await this.settings.saveCloudRunsSettings({ awsRootVolumeSizeGb: normalizedRootVolumeSizeGb });
    await this.settings.saveAwsWorkerHandle(info);
    await this.settings.setCloudRunsMode("aws");
    return this.status();
  }

  async status(): Promise<AwsWorkerStatus> {
    const credentials = await this.settings.getAwsWorkerCredentials();
    const settings = await this.settings.getPublicSettings();
    const handle = settings.cloudRuns.awsHandle;
    if (!credentials || !handle) {
      return { configured: false };
    }
    try {
      const info = await this.lifecycle.describe(credentials, this.toHandle(handle));
      return {
        configured: true,
        handle,
        state: info?.state ?? "absent",
        publicIp: info?.publicIp,
        persistentStorage: info
          ? {
              rootVolumeBackedByEbs: info.rootVolumeBackedByEbs === true,
              rootDeviceName: info.rootDeviceName,
              rootVolumeId: info.rootVolumeId
            }
          : undefined,
        message: info?.rootVolumeBackedByEbs === false
          ? "Worker root storage is not backed by EBS; remote session continuity is unsafe."
          : undefined
      };
    } catch (error) {
      return {
        configured: true,
        handle,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async deleteWorker(): Promise<AwsWorkerStatus> {
    const credentials = await this.settings.getAwsWorkerCredentials();
    const settings = await this.settings.getPublicSettings();
    const handle = settings.cloudRuns.awsHandle;
    let deleteResult: AwsWorkerDeleteResult | undefined;
    let deleteError: string | undefined;
    try {
      if (credentials && handle) {
        deleteResult = await this.lifecycle.deleteWorker(credentials, this.toHandle(handle));
      }
    } catch (error) {
      deleteError = error instanceof Error ? error.message : String(error);
      this.log("cloud-runs.aws.delete.error", {
        message: deleteError
      });
    }
    await this.settings.clearAwsWorker();
    await this.settings.setCloudRunsMode("ssh");
    return {
      configured: false,
      message: this.deleteWarningMessage(handle, deleteResult, deleteError)
    };
  }

  async stopWorker(): Promise<AwsWorkerStatus> {
    const credentials = await this.settings.getAwsWorkerCredentials();
    const settings = await this.settings.getPublicSettings();
    const handle = settings.cloudRuns.awsHandle;
    if (!credentials || !handle) {
      return { configured: false };
    }
    await this.lifecycle.stopWorker(credentials, this.toHandle(handle));
    return this.status();
  }

  // Called by the chat run path in AWS mode: guarantees the instance is running,
  // refreshes ingress to the current IP, and returns a ready SSH worker target
  // (no remoteCwd, so the mirror transport takes over).
  async ensureWorkerForRun(): Promise<CloudRunWorkerSettings> {
    const credentials = await this.settings.getAwsWorkerCredentials();
    const settings = await this.settings.getPublicSettings();
    const handle = settings.cloudRuns.awsHandle;
    if (!credentials || !handle) {
      throw new Error("The AWS worker is not configured. Connect a worker in Cloud Runs settings.");
    }
    const publicIp = await this.lifecycle.ensureRunning(credentials, this.toHandle(handle));
    return {
      host: publicIp,
      user: WORKER_SSH_USER,
      identityFile: this.privateKeyPath(handle),
      workerRoot: WORKER_ROOT
    };
  }

  noteRunStarted(runId: string): void {
    if (!runId || this.activeRunIds.has(runId)) {
      return;
    }
    this.activeRunIds.add(runId);
    this.lifecycle.runStarted();
  }

  async noteRunEnded(runId: string): Promise<void> {
    if (!this.activeRunIds.delete(runId)) {
      return;
    }
    const credentials = await this.settings.getAwsWorkerCredentials();
    const settings = await this.settings.getPublicSettings();
    const handle = settings.cloudRuns.awsHandle;
    if (credentials && handle) {
      this.lifecycle.runEnded(credentials, this.toHandle(handle));
    }
  }

  async withRunReference<T>(runId: string, action: () => Promise<T>): Promise<T> {
    this.noteRunStarted(runId);
    try {
      return await action();
    } finally {
      await this.noteRunEnded(runId);
    }
  }

  private toHandle(info: AwsWorkerHandleInfo): AwsWorkerHandle {
    return {
      instanceId: info.instanceId,
      securityGroupId: info.securityGroupId,
      keyName: info.keyName,
      privateKeyPath: this.privateKeyPath(info),
      region: info.region
    };
  }

  private privateKeyPath(info: AwsWorkerHandleInfo): string {
    return this.privateKeyPathForKeyName(info.keyName);
  }

  private async assertCanCreateWorker(): Promise<void> {
    const credentials = await this.settings.getAwsWorkerCredentials();
    const settings = await this.settings.getPublicSettings();
    const handle = settings.cloudRuns.awsHandle;
    if (!handle) {
      return;
    }
    if (!credentials) {
      throw new Error("An AWS worker is already configured but its credentials are missing. Delete the existing worker before connecting a new one.");
    }
    let existing: Awaited<ReturnType<AwsWorkerLifecycle["describe"]>>;
    try {
      existing = await this.lifecycle.describe(credentials, this.toHandle(handle));
    } catch (error) {
      throw new Error(`Could not verify the existing AWS worker before reconnecting: ${error instanceof Error ? error.message : String(error)}. Delete the existing worker first.`);
    }
    if (existing && existing.state !== "terminated" && existing.state !== "absent") {
      throw new Error("An AWS worker is already configured. Delete the existing worker before connecting a new one.");
    }
    await this.lifecycle.deleteWorker(credentials, this.toHandle(handle));
  }

  private log(event: string, payload: Record<string, unknown>): void {
    this.logger?.(event, payload);
  }

  private deleteWarningMessage(
    handle: AwsWorkerHandleInfo | undefined,
    result: AwsWorkerDeleteResult | undefined,
    deleteError: string | undefined
  ): string | undefined {
    const reason = result?.terminateFailed ?? deleteError;
    if (!handle || !reason) {
      return undefined;
    }
    return `Settings cleared, but AWS instance ${handle.instanceId} may still exist. Check the EC2 console. (${reason})`;
  }
}
