// AWS-managed Cloud Runs worker ownership and reconciliation. AWS tags are the
// source of truth; persisted handles are local caches, while guarded automatic
// stop is authorized by worker-side registered activity across upgraded apps.
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  AwsWorkerActualSpec,
  AwsWorkerAutoStop,
  AwsWorkerAutoStopProblem,
  SetAwsAutoStopRequest,
  AwsWorkerHandleInfo,
  AwsWorkerSpec,
  AwsWorkerSpecMismatch,
  AwsWorkerStatus,
  CloudRunWorkerSettings
} from "../../shared/types";
import { awsRootVolumeSizeError, normalizeAwsInstanceType, normalizeAwsRootVolumeSizeGb } from "../../shared/cloudRuns";
import { assertAwsMachinePowerConfig, machineIdleWarningKind, type AwsMachinePowerConfig } from "../../shared/machinePower";
import { isAutoUpgradeOf, isMachineInstallTerminalPhase, MACHINE_POWER_MAX_ATTEMPTS, type MachineInstallRecord } from "../../shared/machineInstall";
import type { MachineRecord } from "../../shared/machineLink";
import { buildBootstrapCommand, parseWorkerBlob } from "./awsWorkerProvisioning";
import type { AwsWorkerCredentials } from "./awsWorkerProvisioning";
import { AwsWorkerLifecycle } from "./awsWorkerLifecycle";

type StoredAwsWorkerOperation = Awaited<ReturnType<SettingsService["getAwsWorkerOperation"]>>;
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
  isAwsAuthorizationError,
  resolveAwsWorkerPrivateKeyPath,
  resolveCurrentPublicIp
} from "./awsEc2Client";
import { AwsWorkerAccess } from "./awsWorkerAccess";
import { buildCloudRunSshTarget, cloudRunSshOptionArgs } from "./cloudRunWorkers";
import { runCommand } from "./command";
import type { SettingsService } from "./settings";
import type {
  RemoteRunWorkerTarget,
  RemoteWorkerStopAuthorization,
  RemoteWorkerStopLease
} from "./remoteWorkerTarget";

const WORKER_SSH_USER = "ubuntu";
const WORKER_ROOT = "~/.accordagents/remote-runs";
const AWS_AUTHORIZATION_RETRY_DELAYS_MS = [250, 1_000, 2_500] as const;
/** How long a running instance's machine may take to connect before
 *  Diagnostics says it is not connected. */
const INSTANCE_BOOT_CONNECT_GRACE_MS = 5 * 60_000;

export interface CloudRunAwsServiceOptions {
  /** This desktop's version: an automatic update of it that already failed
   *  on a machine is not repeated by itself. */
  appVersion?: string;
  /** Whether the machine's runtime is connected to this desktop now;
   *  undefined while that is not known yet (the link is still starting). */
  machineConnected?: (machineId: string) => boolean | undefined;
  createEc2Client?: (credentials: AwsWorkerCredentials) => Ec2Client;
  generateKeyMaterial?: typeof generateAwsWorkerKeyMaterial;
  deleteKeyMaterial?: typeof deleteGeneratedAwsWorkerKeyMaterial;
  privateKeyPathForKeyName?: (keyName: string) => string;
  currentPublicIp?: () => Promise<string>;
  workerAccess?: AwsWorkerAccess;
  logger?: (event: string, payload: Record<string, unknown>) => void;
  idleStopMs?: number;
  idleStopRetryMs?: number;
  automaticStopGate?: {
    authorizeAutomaticWorkerStop(worker: RemoteRunWorkerTarget, ownerId: string): Promise<RemoteWorkerStopAuthorization>;
    renewAutomaticWorkerStopLease(worker: RemoteRunWorkerTarget, lease: RemoteWorkerStopLease): Promise<RemoteWorkerStopLease>;
    releaseAutomaticWorkerStopLease(worker: RemoteRunWorkerTarget, lease: RemoteWorkerStopLease): Promise<void>;
  };
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

interface PrepareAwsWorkerRequest {
  blob?: string;
  instanceType?: string;
  rootVolumeSizeGb?: number;
  operationId: string;
  clientToken?: string;
  expectedInstanceId?: string;
}

export class CloudRunAwsService {
  private readonly lifecycle: AwsWorkerLifecycle;
  private readonly createEc2Client: (credentials: AwsWorkerCredentials) => Ec2Client;
  private readonly generateKeyMaterial: typeof generateAwsWorkerKeyMaterial;
  private readonly workerAccess: AwsWorkerAccess;
  private readonly privateKeyPathForKeyName: (keyName: string) => string;
  private readonly logger?: (event: string, payload: Record<string, unknown>) => void;
  private readonly appVersion?: string;
  private readonly machineConnected?: (machineId: string) => boolean | undefined;
  private readonly automaticStopOwnerId = randomUUID();
  private readonly activeRunIds = new Set<string>();
  private readonly wait: (delayMs: number) => Promise<void>;
  private readonly sshExec: (worker: CloudRunWorkerSettings, command: string, timeoutMs: number) => Promise<void>;
  private prepareActive: Promise<PreparedAwsWorker> | undefined;
  private prepareRequest: PrepareAwsWorkerRequest | undefined;

  constructor(
    private readonly settings: SettingsService,
    options: CloudRunAwsServiceOptions = {}
  ) {
    this.appVersion = options.appVersion;
    this.machineConnected = options.machineConnected;
    this.logger = options.logger;
    this.createEc2Client = options.createEc2Client ?? createAwsEc2Client;
    this.generateKeyMaterial = options.generateKeyMaterial ?? generateAwsWorkerKeyMaterial;
    this.lifecycle = new AwsWorkerLifecycle({
      createEc2Client: this.createEc2Client,
      generateKeyMaterial: this.generateKeyMaterial,
      deleteKeyMaterial: async (keyName) => (options.deleteKeyMaterial ?? deleteGeneratedAwsWorkerKeyMaterial)(keyName),
      currentPublicIp: options.currentPublicIp ?? resolveCurrentPublicIp,
      // The User's switch governs this desktop's own idle stop too.
      automaticStopEnabled: () => this.autoStopSwitchedOn(),
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
          hostKeyAlias: `accordagents-${info.instanceId}`,
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
    this.workerAccess = options.workerAccess ?? new AwsWorkerAccess();
    this.privateKeyPathForKeyName = options.privateKeyPathForKeyName ?? resolveAwsWorkerPrivateKeyPath;
    this.wait = options.wait ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.sshExec = options.sshExec ?? defaultSshExec;
  }

  async bootstrapCommand(region: string, recoveryOperationId?: string): Promise<string> {
    const deviceId = await this.settings.getCloudRunsDeviceId();
    let targetUserName: string | undefined;
    if (recoveryOperationId !== undefined) {
      const operation = await this.settings.getAwsWorkerOperation();
      if (operation?.operationId !== recoveryOperationId || operation.phase !== "error" || operation.remediation !== "refresh-aws-authorization") {
        throw new Error("That AWS permission error is no longer current. Try again first; update permissions only from a current error.");
      }
      targetUserName = operation.awsPrincipalUserName;
    }
    if (targetUserName) return buildBootstrapCommand(region, deviceId, { targetUserName });
    // The stop and start keys belong to the instance's region: a command for
    // another region must not rewrite the policies of keys already in use.
    const handle = (await this.settings.getPublicSettings()).cloudRuns.awsHandle;
    const otherRegion = Boolean(handle && handle.region !== region.trim());
    return buildBootstrapCommand(region, deviceId, { ...await this.keysInUse(), ...(otherRegion ? { machineKeys: false } : {}) });
  }

  /** The keys a rerun of the setup command must leave valid: the app's own,
   *  the stop key it has not handed over yet, and the stop key each machine
   *  on its instance runs with. A read failure fails the command instead of
   *  producing one that could delete a key still in use. */
  private async keysInUse(): Promise<{ keepWorkerKeyId?: string; keepPowerKeyIds: string[]; keepWakeKeyId?: string }> {
    const credentials = await this.settings.getAwsWorkerCredentials();
    const handle = (await this.settings.getPublicSettings()).cloudRuns.awsHandle;
    const records = handle ? (await this.installsOnInstance(handle)).records : [];
    const held = records.flatMap((record) => record.power ? [record.power.keyId] : []);
    // A stop key a machine refused, and no machine holds, is not in use: the
    // rerun that sets automatic stop up again may replace it.
    const pending = credentials?.power?.accessKeyId;
    const refused = pending !== undefined && !held.includes(pending) && records.some((record) => record.powerError?.keyId === pending);
    return {
      keepWorkerKeyId: credentials?.accessKeyId,
      keepPowerKeyIds: [...(pending && !refused ? [pending] : []), ...held],
      keepWakeKeyId: credentials?.wake?.accessKeyId
    };
  }

  /** The phone's start key for this app's instance, as a paired phone uses it,
   *  with the machine it wakes; undefined when the setup command has not made
   *  one, or made it for another region. It only ever leaves this desktop
   *  inside a pairing link. */
  async deviceWakePower(): Promise<{ machineId?: string; config: AwsMachinePowerConfig } | undefined> {
    const credentials = await this.settings.getAwsWorkerCredentials();
    const handle = (await this.settings.getPublicSettings()).cloudRuns.awsHandle;
    if (!credentials?.wake || !handle) return undefined;
    const config = powerConfigFor({ ...credentials, power: credentials.wake }, handle);
    if (!config) return undefined;
    const { machines } = await this.installsOnInstance(handle);
    return { ...(machines.length === 1 ? { machineId: machines[0].id } : {}), config };
  }

  /** This app's machines on its instance, and their install records. A
   *  machine counts when its record names the instance, or when it was
   *  installed over the instance's own pinned host key. */
  private async installsOnInstance(handle: AwsWorkerHandleInfo): Promise<{ machines: MachineRecord[]; records: MachineInstallRecord[] }> {
    const [machines, installs] = await Promise.all([this.settings.listMachines(), this.settings.listMachineInstalls()]);
    const pinned = new Set(installs.filter((record) => record.target?.hostKeyAlias === `accordagents-${handle.instanceId}`).map((record) => record.machineId));
    const onInstance = machines.filter((machine) => machine.awsInstanceId === handle.instanceId || (!machine.awsInstanceId && pinned.has(machine.id)));
    const ids = new Set(onInstance.map((machine) => machine.id));
    return { machines: onInstance, records: installs.filter((record) => ids.has(record.machineId)) };
  }

  // Compatibility entry point for older renderer callers. The new UI calls
  // AwsWorkerSetupService, which continues through running + doctor setup.
  async connectWorker(blob: string, instanceType?: string, rootVolumeSizeGb?: number): Promise<AwsWorkerStatus> {
    await this.prepareWorker({ blob, instanceType, rootVolumeSizeGb, operationId: `legacy-${Date.now()}` });
    return this.status();
  }

  async prepareWorker(request: PrepareAwsWorkerRequest): Promise<PreparedAwsWorker> {
    if (this.prepareActive) {
      if (isDeepStrictEqual(this.prepareRequest, request)) return this.prepareActive;
      throw new Error("Another AWS preparation is still running. Wait for it to finish, then try again.");
    }
    this.prepareRequest = structuredClone(request);
    this.prepareActive = this.prepareWorkerUnlocked(this.prepareRequest).finally(() => {
      this.prepareActive = undefined;
      this.prepareRequest = undefined;
    });
    return this.prepareActive;
  }

  private async prepareWorkerUnlocked(request: PrepareAwsWorkerRequest): Promise<PreparedAwsWorker> {
    if (request.rootVolumeSizeGb !== undefined) {
      const invalidSize = awsRootVolumeSizeError(request.rootVolumeSizeGb);
      if (invalidSize) throw new Error(invalidSize);
    }
    const credentials = request.blob?.trim()
      ? withRetainedKeys(parseWorkerBlob(request.blob), await this.settings.getAwsWorkerCredentials())
      : await this.settings.getAwsWorkerCredentials();
    if (!credentials) {
      throw new Error("Connect the AWS account before starting the worker.");
    }
    const publicSettings = await this.settings.getPublicSettings();
    const desiredType = normalizeAwsInstanceType(request.instanceType ?? publicSettings.cloudRuns.awsInstanceType);
    const desiredDisk = normalizeAwsRootVolumeSizeGb(request.rootVolumeSizeGb ?? publicSettings.cloudRuns.awsRootVolumeSizeGb);
    let matches = await this.discoverWorkers(credentials, false);
    if (matches.length > 1) throw multipleWorkerError(matches);
    if (request.expectedInstanceId && matches[0]?.instanceId !== request.expectedInstanceId) {
      throw new Error("The instance changed after the size editor opened. Refresh and review it before applying.");
    }
    let replacedInstanceId: string | undefined;
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
        replacedInstanceId = previousHandle.instanceId;
      }
    }
    let created = false;
    let info = matches[0];
    let handle: AwsWorkerHandleInfo;
    if (!info) {
      const persistedToken = await (this.settings as SettingsService & {
        getAwsWorkerProvisioningToken?: () => Promise<string | undefined>;
        saveAwsWorkerProvisioningToken?: (token: string | undefined) => Promise<void>;
      }).getAwsWorkerProvisioningToken?.();
      const clientToken = replacedInstanceId
        ? replacementLaunchToken(request.operationId, replacedInstanceId)
        : persistedToken ?? request.clientToken ?? request.operationId;
      await (this.settings as SettingsService & {
        saveAwsWorkerProvisioningToken?: (token: string | undefined) => Promise<void>;
      }).saveAwsWorkerProvisioningToken?.(clientToken);
      const deviceId = await (this.settings as SettingsService & { getCloudRunsDeviceId?: () => Promise<string> }).getCloudRunsDeviceId?.() ?? "legacy";
      const createdHandle = await this.lifecycle.createWorker(credentials, {
        instanceType: desiredType,
        rootVolumeSizeGb: desiredDisk,
        clientToken: clientToken.slice(0, 64),
        deviceId
      });
      created = true;
      info = await this.reconcileCreatedWorker(credentials, createdHandle.instanceId);
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
    await (this.settings as SettingsService & {
      saveAwsWorkerProvisioningToken?: (token: string | undefined) => Promise<void>;
    }).saveAwsWorkerProvisioningToken?.(undefined);
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

  /** Keeping a size cancels the new request, not a reason to provision, enroll
   *  keys or resume a previously interrupted disk expansion. */
  async keepCurrentSize(expectedInstanceId: string): Promise<AwsWorkerActualSpec> {
    const { info, handle } = await this.existingWorker(expectedInstanceId);
    const actual = actualSpecFrom(info, handle);
    await this.settings.saveCloudRunsSettings({
      awsInstanceType: actual.instanceType,
      awsRootVolumeSizeGb: actual.rootVolumeSizeGb
    });
    return actual;
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
    return this.finishVolumeExpansion(prepared);
  }

  async resumePendingVolumeExpansion(prepared: PreparedAwsWorker): Promise<PreparedAwsWorker> {
    const marker = await (this.settings as SettingsService & {
      getAwsWorkerVolumeExpansion?: () => Promise<{ instanceId: string; volumeId: string; targetSizeGb: number } | undefined>;
    }).getAwsWorkerVolumeExpansion?.();
    if (!marker) return prepared;
    if (marker.instanceId !== prepared.info.instanceId) {
      await (this.settings as SettingsService & { saveAwsWorkerVolumeExpansion?: (value: undefined) => Promise<void> })
        .saveAwsWorkerVolumeExpansion?.(undefined);
      return prepared;
    }
    return this.finishVolumeExpansion(prepared, marker);
  }

  private async finishVolumeExpansion(
    prepared: PreparedAwsWorker,
    existingMarker?: { instanceId: string; volumeId: string; targetSizeGb: number }
  ): Promise<PreparedAwsWorker> {
    const volumeId = existingMarker?.volumeId ?? prepared.info.rootVolumeId ?? prepared.handle.rootVolumeId;
    if (!volumeId) throw new Error("Could not identify the AWS worker root volume.");
    const client = this.clientForRegion(prepared.credentials, prepared.handle.region);
    const targetSizeGb = existingMarker?.targetSizeGb ?? prepared.desiredSpec.rootVolumeSizeGb;
    await (this.settings as SettingsService & {
      saveAwsWorkerVolumeExpansion?: (value: { instanceId: string; volumeId: string; targetSizeGb: number; updatedAt: string } | undefined) => Promise<void>;
    }).saveAwsWorkerVolumeExpansion?.({
      instanceId: prepared.info.instanceId,
      volumeId,
      targetSizeGb,
      updatedAt: new Date().toISOString()
    });
    const before = await client.describeInstance(prepared.info.instanceId) ?? prepared.info;
    const requestedModification = (before.rootVolumeSizeGb ?? 0) < targetSizeGb;
    if (requestedModification) {
      if (!client.modifyVolumeSize) throw new Error("These AWS credentials cannot grow the worker disk. Re-run the AWS setup command.");
      await client.modifyVolumeSize(volumeId, targetSizeGb);
    }
    if (client.describeVolumeModification) {
      const deadline = Date.now() + 10 * 60_000;
      let expandable = false;
      while (Date.now() < deadline) {
        const state = await client.describeVolumeModification(volumeId);
        if (state === "optimizing" || state === "completed" || state === undefined && !requestedModification) {
          expandable = true;
          break;
        }
        if (state === "failed") throw new Error("AWS failed to grow the worker disk.");
        await this.wait(5_000);
      }
      if (!expandable) throw new Error("Timed out waiting for the enlarged AWS volume to become usable.");
    }
    const worker = await this.ensurePreparedRunning(prepared);
    await this.sshExec(worker, growRootFilesystemCommand(targetSizeGb), 5 * 60_000);
    const refreshed = await client.describeInstance(prepared.info.instanceId) ?? prepared.info;
    const handle = this.handleFromInfo(refreshed, {
      keyName: prepared.handle.accessKeyName ?? prepared.handle.keyName,
      privateKeyPath: this.privateKeyPath(prepared.handle),
      securityGroupId: prepared.handle.securityGroupId,
      created: !prepared.handle.adopted
    });
    await this.settings.saveAwsWorkerHandle(handle);
    await (this.settings as SettingsService & { saveAwsWorkerVolumeExpansion?: (value: undefined) => Promise<void> })
      .saveAwsWorkerVolumeExpansion?.(undefined);
    return {
      ...prepared,
      info: refreshed,
      handle,
      actualSpec: actualSpecFrom(refreshed, prepared.handle),
      mismatch: specMismatch(actualSpecFrom(refreshed, prepared.handle), prepared.desiredSpec)
    };
  }

  async recreateWorker(prepared: PreparedAwsWorker, expectedInstanceId: string, operationId: string): Promise<PreparedAwsWorker> {
    if (prepared.info.instanceId !== expectedInstanceId) {
      throw new Error("The shared worker changed after confirmation. Refresh and choose again.");
    }
    const result = await this.lifecycle.deleteWorker(this.credentialsForHandle(prepared.credentials, prepared.handle), this.toHandle(prepared.handle));
    if (result.terminateFailed || !result.terminationConfirmed) {
      throw new Error(`The existing shared worker could not be confirmed terminated: ${result.terminateFailed ?? "unknown termination state"}`);
    }
    await this.settings.saveAwsWorkerHandle(undefined);
    return this.prepareWorker({
      operationId,
      instanceType: prepared.desiredSpec.instanceType,
      rootVolumeSizeGb: prepared.desiredSpec.rootVolumeSizeGb
    });
  }

  async ensurePreparedRunning(prepared: PreparedAwsWorker): Promise<CloudRunWorkerSettings> {
    const deviceId = await (this.settings as SettingsService & { getCloudRunsDeviceId?: () => Promise<string> }).getCloudRunsDeviceId?.() ?? "legacy";
    const running = await this.lifecycle.ensureRunning(this.credentialsForHandle(prepared.credentials, prepared.handle), this.toHandle(prepared.handle), deviceId);
    const key = await this.keyForHandle(prepared.handle);
    await this.workerAccess.ensureAccess(this.clientForRegion(prepared.credentials, prepared.handle.region), running, key);
    const keyChanged = key.keyName !== prepared.handle.keyName;
    if (keyChanged) {
      prepared.handle.keyName = key.keyName;
      prepared.handle.accessKeyName = key.keyName;
    }
    // Record where the box actually is. Run and session handles keep the address
    // they were created with, and a stop/start hands out a new one; without this
    // the app keeps dialling dead addresses and pays an SSH timeout each time.
    const publicIp = typeof running.publicIp === "string" ? running.publicIp.trim() : "";
    const hostChanged = publicIp.length > 0 && prepared.handle.lastKnownHost !== publicIp;
    if (hostChanged) {
      prepared.handle.lastKnownHost = publicIp;
    }
    if (keyChanged || hostChanged) {
      await this.settings.saveAwsWorkerHandle(prepared.handle);
    }
    return workerSettings(running.publicIp as string, key.privateKeyPath, deviceId, running.instanceId);
  }

  async status(): Promise<AwsWorkerStatus> {
    const context = await this.workerContext();
    if (!context.credentials || !context.handle) return { configured: false, operation: context.operation };
    let status: AwsWorkerStatus;
    let launchedAt: string | undefined;
    try {
      ({ status, launchedAt } = await this.describeWorker(context.credentials, context.handle, context.operation));
    } catch (error) {
      status = { configured: true, handle: context.handle, operation: context.operation, message: errorMessage(error) };
    }
    // A settings read that fails leaves the switch unknown, never "on".
    const autoStop = await this.autoStopFor(context.credentials, context.handle, status.state, launchedAt).catch(() => undefined);
    return { ...status, ...(autoStop ? { autoStop } : {}) };
  }

  /** The stop key for a machine that runs on this app's instance, or
   *  undefined when the machine is elsewhere or no stop key was set up. The
   *  key only ever covers the instance's own region. */
  async machinePowerFor(machineId: string): Promise<AwsMachinePowerConfig | undefined> {
    const [credentials, publicSettings] = await Promise.all([this.settings.getAwsWorkerCredentials(), this.settings.getPublicSettings()]);
    const handle = publicSettings.cloudRuns.awsHandle;
    if (!credentials?.power || !handle) return undefined;
    const { machines } = await this.installsOnInstance(handle);
    if (!machines.some((machine) => machine.id === machineId)) return undefined;
    return powerConfigFor(credentials, handle);
  }

  private async autoStopFor(credentials: AwsWorkerCredentials, handle: AwsWorkerHandleInfo,
    state: AwsWorkerStatus["state"], launchedAt?: string): Promise<AwsWorkerAutoStop> {
    const power = powerConfigFor(credentials, handle);
    if (!power) return { enabled: false, needsSetup: true };
    if (!await this.settings.getMachineAutoStopEnabled()) {
      // Off must hold on the machine too: it is the one that stops.
      const problem = state === "running" ? await this.switchNotTaken(power, handle, false) : undefined;
      return { enabled: false, needsSetup: false, ...(problem ? { problem } : {}) };
    }
    // A stopped instance has nothing to stop; what keeps a running one up is
    // only worth showing while it runs.
    const problem = state === "running" ? await this.autoStopProblem(power, handle, launchedAt) : undefined;
    return { enabled: true, needsSetup: false, ...(problem ? { problem } : {}) };
  }

  /**
   * Why a running instance will not stop by itself although the switch is on,
   * for Diagnostics, or nothing. Agents working keep it up by design and are
   * not a problem. Each answer says what fixes it.
   */
  private async autoStopProblem(power: AwsMachinePowerConfig, handle: AwsWorkerHandleInfo,
    launchedAt?: string): Promise<AwsWorkerAutoStopProblem | undefined> {
    const keyId = power.credentials.accessKeyId;
    const { machines, records: all } = await this.installsOnInstance(handle);
    const records = all.filter((record) => record.installedVersion);
    if (!records.length) {
      return { message: "The program that stops the instance is not set up on it yet.", action: "reconnect", actionLabel: "Set it up" };
    }
    const machineOf = (machineId: string) => machines.find((machine) => machine.id === machineId);
    const warningOf = (machineId: string) => machineOf(machineId)?.lastHello?.idleStopWarning;
    const taken = records.find((record) => record.power?.keyId === keyId);
    const takenWarning = taken ? warningOf(taken.machineId) : undefined;
    const refused = records.find((record) => record.powerError?.keyId === keyId)
      ?? (takenWarning && machineIdleWarningKind(takenWarning) === "refused" ? taken : undefined);
    if (refused) {
      return { message: "AWS does not accept the automatic-stop key.", action: "set-up-again", actionLabel: "Set up again" };
    }
    const record = taken ?? records[0];
    // A machine that has just started needs a minute or two to connect.
    const launched = launchedAt ? Date.parse(launchedAt) : Number.NaN;
    const settled = !Number.isFinite(launched) || Date.now() - launched >= INSTANCE_BOOT_CONNECT_GRACE_MS;
    if (settled && this.machineConnected?.(record.machineId) === false) {
      return { message: "The program on the cloud machine is not connected, so it cannot stop the instance.", action: "reconnect",
        actionLabel: "Reconnect", machineId: record.machineId };
    }
    if (!taken) {
      // The key goes over by an update that waits for the machine to be idle.
      // Only an update that gave up needs the User; one that waits does not.
      const appVersion = this.appVersion;
      const stalled = appVersion ? records.find((item) => {
        const last = item.lastOperation;
        return last && last.phase !== "ready" && isMachineInstallTerminalPhase(last.phase) && last.recovery?.kind !== "machine-busy"
          && isAutoUpgradeOf(last.operationId, appVersion) && item.installedVersion !== appVersion;
      }) : undefined;
      const exhausted = records.find((item) => item.powerRetry?.keyId === keyId && (item.powerRetry.attempts ?? 1) >= MACHINE_POWER_MAX_ATTEMPTS);
      const failed = stalled ?? exhausted;
      if (failed) {
        return { message: "The cloud machine could not take its automatic-stop key.", action: "reconnect", actionLabel: "Try again",
          machineId: failed.machineId };
      }
      return undefined;
    }
    const notTaken = await this.switchNotTaken(power, handle, true);
    if (notTaken) return notTaken;
    const warning = warningOf(taken.machineId);
    const kind = warning ? machineIdleWarningKind(warning) : undefined;
    if (kind === "unconfirmed") {
      return { message: "The cloud machine is stopping the instance and has not finished yet; it keeps trying. Stop above stops it now." };
    }
    if (kind !== "fault") return undefined;
    return { message: "The cloud machine could not finish its check, so it stays on for now and tries again by itself. If this stays, stop the instance when you finish." };
  }

  /**
   * The machine holding the key reports a different switch than the User set,
   * in a report made after the change: the change did not arrive. A runtime
   * from before the switch reports none and always stops when idle, which
   * matters only while the switch is off.
   */
  private async switchNotTaken(power: AwsMachinePowerConfig, handle: AwsWorkerHandleInfo,
    enabled: boolean): Promise<AwsWorkerAutoStopProblem | undefined> {
    const { machines, records } = await this.installsOnInstance(handle);
    const holder = records.find((record) => record.power?.keyId === power.credentials.accessKeyId);
    const machine = holder ? machines.find((item) => item.id === holder.machineId) : undefined;
    if (!machine?.lastHello || this.machineConnected?.(machine.id) !== true) return undefined;
    const reported = machine.lastHello.autoStopEnabled;
    if (reported === undefined) {
      return enabled ? undefined : { message: "The program on the cloud machine is older and still stops the instance by itself; it takes the switch after its next update." };
    }
    const changedAt = Date.parse(await this.settings.getMachineAutoStopChangedAt() ?? "");
    const reportedAfterChange = !Number.isFinite(changedAt) || Date.parse(machine.lastSeenAt ?? "") > changedAt;
    if (reported === enabled || !reportedAfterChange) return undefined;
    return { message: enabled
      ? "The cloud machine still has automatic stop switched off. Switch it off and on again to send it once more."
      : "The cloud machine still has automatic stop switched on, so it may stop the instance. Switch it on and off again to send it once more." };
  }

  /** Saves the stop key from a pasted setup result. The result must carry
   *  one: a result from an older command would turn the switch on with
   *  nothing that can stop the instance. */
  async adoptAutoStopKey(blob: string): Promise<void> {
    if (!parseWorkerBlob(blob).power) {
      throw new Error("This result has no automatic-stop key. Copy the command shown here again and run it; it makes one.");
    }
    await this.adoptCredentials(blob);
  }

  /** The switch. On with a pasted result saves its stop key first; on
   *  without one needs a usable key already saved. Off keeps the key. */
  async setAutoStop(request: SetAwsAutoStopRequest): Promise<{ keyAdded: boolean }> {
    const enabled = request?.enabled === true;
    const blob = typeof request?.blob === "string" ? request.blob.trim() : "";
    if (blob) await this.adoptAutoStopKey(blob);
    else if (enabled && !await this.hasAutoStopKey()) {
      throw new Error("Run the setup command first: there is no automatic-stop key yet.");
    }
    await this.settings.setMachineAutoStopEnabled(enabled);
    return { keyAdded: Boolean(blob) };
  }

  /** The install record of the machine on this instance that holds, or is
   *  to take, the stop key: the one Diagnostics' fix acts on. */
  async autoStopMachineRecord(): Promise<MachineInstallRecord | undefined> {
    const [credentials, publicSettings] = await Promise.all([this.settings.getAwsWorkerCredentials(), this.settings.getPublicSettings()]);
    const handle = publicSettings.cloudRuns.awsHandle;
    if (!handle) return undefined;
    const records = (await this.installsOnInstance(handle)).records.filter((record) => record.installedVersion);
    const keyId = credentials?.power?.accessKeyId;
    return records.find((record) => keyId && record.power?.keyId === keyId) ?? records[0];
  }

  /** The install record of one machine on this instance. */
  async machineRecordOnInstance(machineId: string): Promise<MachineInstallRecord | undefined> {
    const handle = (await this.settings.getPublicSettings()).cloudRuns.awsHandle;
    if (!handle) return undefined;
    return (await this.installsOnInstance(handle)).records.find((record) => record.machineId === machineId && record.installedVersion);
  }

  /** A stop key for the instance's own region is saved. */
  async hasAutoStopKey(): Promise<boolean> {
    const [credentials, publicSettings] = await Promise.all([this.settings.getAwsWorkerCredentials(), this.settings.getPublicSettings()]);
    const handle = publicSettings.cloudRuns.awsHandle;
    return Boolean(credentials && handle && powerConfigFor(credentials, handle));
  }

  /** The switch reads on: a usable key, and the User left it on. */
  async autoStopSwitchedOn(): Promise<boolean> {
    return await this.hasAutoStopKey() && await this.settings.getMachineAutoStopEnabled();
  }

  /** The status read with AWS's refusal left intact: a caller that must tell a
   *  revoked permission from a network failure needs the raw error. Reads only. */
  async probeAccess(): Promise<AwsWorkerStatus> {
    const context = await this.workerContext();
    if (!context.credentials || !context.handle) return { configured: false, operation: context.operation };
    const { status, launchedAt } = await this.describeWorker(context.credentials, context.handle, context.operation);
    const autoStop = await this.autoStopFor(context.credentials, context.handle, status.state, launchedAt).catch(() => undefined);
    return { ...status, ...(autoStop ? { autoStop } : {}) };
  }

  /** Replace the saved credentials with pasted ones once they prove, read-only,
   *  that they can see the existing instance. Nothing else is touched. */
  async adoptCredentials(blob: string): Promise<void> {
    const credentials = withRetainedKeys(parseWorkerBlob(blob), await this.settings.getAwsWorkerCredentials());
    const handle = (await this.settings.getPublicSettings()).cloudRuns.awsHandle;
    if (!handle) throw new Error("Connect the AWS account before updating its credentials.");
    // The stop key only covers the region the command was run for.
    if (credentials.power && credentials.region !== handle.region) {
      throw new Error(`The setup command was run for ${credentials.region}, but the instance is in ${handle.region}. The pasted result was not used; run the command again with region ${handle.region}.`);
    }
    const info = await this.clientForRegion(credentials, handle.region).describeInstance(handle.instanceId);
    if (!info || info.instanceId !== handle.instanceId) {
      throw new Error(`These credentials cannot see the existing instance ${handle.instanceId} in ${handle.region}. The saved credentials were kept.`);
    }
    await this.settings.saveAwsWorkerCredentials(credentials);
  }

  private async workerContext(): Promise<{
    credentials: AwsWorkerCredentials | undefined;
    handle: AwsWorkerHandleInfo | undefined;
    operation: StoredAwsWorkerOperation;
  }> {
    const credentials = await this.settings.getAwsWorkerCredentials();
    const settings = await this.settings.getPublicSettings();
    const operation = await (this.settings as SettingsService & { getAwsWorkerOperation?: () => Promise<StoredAwsWorkerOperation> }).getAwsWorkerOperation?.();
    return { credentials, handle: settings.cloudRuns.awsHandle, operation };
  }

  private async describeWorker(
    credentials: AwsWorkerCredentials,
    handle: AwsWorkerHandleInfo,
    operation: StoredAwsWorkerOperation
  ): Promise<{ status: AwsWorkerStatus; launchedAt?: string }> {
    // Polling status intentionally describes only the cached worker. Account
    // fan-out is reserved for Start/recovery paths.
    const info = await this.clientForRegion(credentials, handle.region).describeInstance(handle.instanceId);
    return { launchedAt: info?.launchedAt, status: {
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
        : undefined,
      actualSpec: info ? actualSpecFrom(info, handle) : undefined,
      operation
    } };
  }

  async deleteWorker(): Promise<AwsWorkerStatus> {
    const credentials = await this.settings.getAwsWorkerCredentials();
    const settings = await this.settings.getPublicSettings();
    const handle = settings.cloudRuns.awsHandle;
    if (!credentials || !handle) return { configured: false };
    let result: AwsWorkerDeleteResult;
    try {
      result = await this.lifecycle.deleteWorker(this.credentialsForHandle(credentials, handle), this.toHandle(handle));
    } catch (error) {
      const current = await this.status();
      return {
        ...current,
        configured: true,
        handle,
        actionError: errorMessage(error),
        message: retainedActionFailure("deleted", current.state, errorMessage(error))
      };
    }
    if (result.terminateFailed || !result.terminationConfirmed) {
      const current = await this.status();
      return {
        ...current,
        configured: true,
        handle,
        actionError: result.terminateFailed ?? "Termination was not confirmed.",
        message: retainedActionFailure("deleted", current.state, result.terminateFailed ?? "Termination was not confirmed.")
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
    try {
      await this.lifecycle.stopWorker(this.credentialsForHandle(credentials, handle), this.toHandle(handle));
    } catch (error) {
      const current = await this.status();
      return {
        ...current,
        configured: true,
        handle,
        actionError: errorMessage(error),
        message: retainedActionFailure("stopped", current.state, errorMessage(error))
      };
    }
    return this.status();
  }

  async ensureExistingWorkerForRun(instanceId: string): Promise<CloudRunWorkerSettings> {
    return this.ensureWorkerForRun(instanceId);
  }

  /** Diagnostics must never wake or prepare an instance to inspect it. */
  async workerForInspection(): Promise<CloudRunWorkerSettings> {
    const { info, handle } = await this.existingWorker();
    if (info.state !== "running") {
      throw new Error(`The AWS instance is ${info.state}. Start the instance and wait until it is running before checking its runtime.`);
    }
    if (!info.publicIp?.trim()) throw new Error("No public IP address is available for the running instance. Refresh its status before checking the runtime.");
    const deviceId = await this.settings.getCloudRunsDeviceId();
    return workerSettings(info.publicIp.trim(), this.privateKeyPath(handle), deviceId, info.instanceId);
  }

  private async existingWorker(expectedInstanceId?: string): Promise<{ info: AwsWorkerInstanceInfo; handle: AwsWorkerHandleInfo }> {
    const { credentials, handle } = await this.workerContext();
    if (!credentials || !handle) throw new Error("The AWS instance is not configured. Connect it in Settings first.");
    if (expectedInstanceId && handle.instanceId !== expectedInstanceId) {
      throw new Error("The instance changed. Refresh and review it before continuing.");
    }
    const info = await this.clientForRegion(credentials, handle.region).describeInstance(handle.instanceId);
    if (!info || info.instanceId !== handle.instanceId || info.state === "terminated" || info.state === "absent") {
      throw new Error("The selected AWS instance is no longer available. Refresh its status in Settings.");
    }
    return { info, handle };
  }

  async ensureWorkerForRun(expectedInstanceId?: string): Promise<CloudRunWorkerSettings> {
    const credentials = await this.settings.getAwsWorkerCredentials();
    const settings = await this.settings.getPublicSettings();
    if (!credentials) throw new Error("The AWS worker is not configured. Start it in Settings first.");
    let handle = settings.cloudRuns.awsHandle;
    if (expectedInstanceId && handle?.instanceId !== expectedInstanceId) {
      throw new Error("The selected AWS instance changed. Select Cloud run again.");
    }
    let info = handle
      ? await this.clientForRegion(credentials, handle.region).describeInstance(handle.instanceId)
      : undefined;
    if (!handle || !info || info.state === "terminated") {
      if (expectedInstanceId) throw new Error("The selected AWS instance is no longer available. Check it in Settings.");
      const prepared = await this.resumePendingVolumeExpansion(
        await this.prepareWorker({ operationId: `run-${Date.now()}` })
      );
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
    const resumed = await this.resumePendingVolumeExpansion(prepared);
    if (resumed.mismatch && !await this.hasAcceptedMismatch(resumed)) {
      throw new Error("The shared AWS worker is smaller than the configured requirement. Open Settings and choose what to do.");
    }
    return this.ensurePreparedRunning(resumed);
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

  private async discoverWorkers(credentials: AwsWorkerCredentials, forceAll: boolean): Promise<AwsWorkerInstanceInfo[]> {
    const configured = this.createEc2Client(credentials);
    if (!configured.findWorkerInstances) return [];
    const local = await this.withAuthorizationRetry(
      "find-worker-instances",
      () => configured.findWorkerInstances?.() ?? Promise.resolve([])
    );
    if (!forceAll && local.length > 0) return local;
    const regions = await this.listEnabledRegions(configured, credentials.region);
    const others = await Promise.all(regions
      .filter((region) => region !== credentials.region)
      .map((region) => {
        const regional = this.clientForRegion(credentials, region);
        return this.withAuthorizationRetry(
          "find-worker-instances",
          () => regional.findWorkerInstances?.() ?? Promise.resolve([])
        );
      }));
    return [...local, ...others.flat()];
  }

  private async listEnabledRegions(client: Ec2Client, fallbackRegion: string): Promise<string[]> {
    if (!client.listEnabledRegions) return [fallbackRegion];
    return this.withAuthorizationRetry("list-enabled-regions", () => client.listEnabledRegions?.() ?? Promise.resolve([fallbackRegion]));
  }

  private async withAuthorizationRetry<T>(operation: string, action: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await action();
      } catch (error) {
        const delayMs = AWS_AUTHORIZATION_RETRY_DELAYS_MS[attempt];
        if (!isAwsAuthorizationError(error) || delayMs === undefined) throw error;
        this.log("aws-worker.discovery.authorization-retry", {
          operation,
          attempt: attempt + 1,
          delayMs,
          ...this.safeAwsErrorLogFields(error)
        });
        await this.wait(delayMs);
      }
    }
  }

  private safeAwsErrorLogFields(error: unknown): Record<string, unknown> {
    const record = error && typeof error === "object"
      ? error as { name?: unknown; code?: unknown; Code?: unknown; message?: unknown }
      : undefined;
    const message = error instanceof Error
      ? error.message
      : typeof record?.message === "string"
        ? record.message
        : String(error ?? "");
    return {
      errorName: typeof record?.name === "string" ? record.name : undefined,
      errorCode: typeof record?.code === "string" ? record.code : typeof record?.Code === "string" ? record.Code : undefined,
      errorMessage: message.slice(0, 500)
    };
  }

  private async reconcileCreatedWorker(
    credentials: AwsWorkerCredentials,
    instanceId: string
  ): Promise<AwsWorkerInstanceInfo> {
    let stableMatches = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const matches = await this.discoverWorkers(credentials, true);
      if (matches.length > 1) throw multipleWorkerError(matches);
      const created = matches.find((worker) => worker.instanceId === instanceId);
      if (created && matches.length === 1) {
        stableMatches += 1;
        if (stableMatches >= 2) return created;
      } else {
        stableMatches = 0;
      }
      await this.wait(5_000);
    }
    throw new Error("The new AWS worker was launched but could not be reconciled safely. Retry with the same operation.");
  }

  private async capacityFor(credentials: AwsWorkerCredentials, instanceType: string): Promise<{ vCpu?: number; memoryMiB?: number }> {
    try {
      const described = await this.createEc2Client(credentials).describeInstanceType?.(instanceType);
      if (described) return described;
    } catch (error) {
      if (!isAwsAuthorizationError(error)) throw error;
      this.log("aws-worker.capacity.authorization-fallback", {
        instanceType,
        ...this.safeAwsErrorLogFields(error)
      });
    }
    return knownInstanceCapacity(instanceType);
  }

  private clientForRegion(credentials: AwsWorkerCredentials, region: string): Ec2Client {
    return this.createEc2Client({ ...credentials, region });
  }

  private credentialsForHandle(credentials: AwsWorkerCredentials, handle: AwsWorkerHandleInfo): AwsWorkerCredentials {
    return { ...credentials, region: handle.region };
  }

  private handleFromInfo(info: AwsWorkerInstanceInfo, options: {
    keyName: string;
    privateKeyPath: string;
    securityGroupId?: string;
    created: boolean;
  }): AwsWorkerHandleInfo {
    const securityGroupId = info.securityGroupId ?? options.securityGroupId;
    if (!securityGroupId) {
      throw new Error("The tagged worker has no app-managed security group. Re-run the AWS setup command to migrate it safely, then retry.");
    }
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

function workerSettings(publicIp: string, identityFile: string, deviceId: string, instanceId: string): CloudRunWorkerSettings {
  const safeDeviceId = deviceId.replace(/[^A-Za-z0-9._-]/g, "_");
  return {
    host: publicIp,
    user: WORKER_SSH_USER,
    identityFile,
    hostKeyAlias: `accordagents-${instanceId}`,
    workerRoot: `${WORKER_ROOT}/devices/${safeDeviceId}`
  };
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

/** A pasted result without a stop key (the account refused to make one, or
 *  both slots were in use) keeps the one the app has: it is still valid, and
 *  the machine may run with it. The phone's start key is made only once, so a
 *  later result never carries it and the app keeps the one phones hold. */
function withRetainedKeys(pasted: AwsWorkerCredentials, saved: AwsWorkerCredentials | undefined): AwsWorkerCredentials {
  if (!saved || saved.region !== pasted.region) return pasted;
  return {
    ...pasted,
    ...(!pasted.power && saved.power ? { power: saved.power } : {}),
    ...(!pasted.wake && saved.wake ? { wake: saved.wake } : {})
  };
}

function powerConfigFor(credentials: AwsWorkerCredentials, handle: AwsWorkerHandleInfo): AwsMachinePowerConfig | undefined {
  if (!credentials.power || handle.region !== credentials.region) return undefined;
  const config: AwsMachinePowerConfig = {
    version: 1,
    instanceId: handle.instanceId,
    credentials: { accessKeyId: credentials.power.accessKeyId, secretAccessKey: credentials.power.secretAccessKey, region: handle.region }
  };
  try {
    assertAwsMachinePowerConfig(config);
  } catch {
    return undefined;
  }
  return config;
}

function multipleWorkerError(workers: AwsWorkerInstanceInfo[]): Error {
  const ids = workers.map((worker) => `${worker.instanceId} (${worker.region ?? "unknown region"})`).join(", ");
  return new Error(`Multiple tagged AccordAgents workers exist: ${ids}. Resolve the conflict in AWS before retrying; nothing was changed.`);
}

function growRootFilesystemCommand(targetSizeGb: number): string {
  const minimumBytes = Math.floor(targetSizeGb * 1024 * 1024 * 1024 * 0.85);
  return [
    "set -eu",
    "root=$(findmnt -n -o SOURCE /)",
    "parent=$(lsblk -n -o PKNAME \"$root\" | head -1 | tr -d '[:space:]')",
    "if [ -n \"$parent\" ]; then part=$(lsblk -n -o PARTN \"$root\" | head -1 | tr -d '[:space:]'); sudo -n env TMPDIR=/run growpart \"/dev/$parent\" \"$part\" || true; fi",
    "fstype=$(findmnt -n -o FSTYPE /)",
    "if [ \"$fstype\" = ext4 ]; then sudo -n resize2fs \"$root\"; elif [ \"$fstype\" = xfs ]; then sudo -n xfs_growfs -d /; else echo \"Unsupported root filesystem: $fstype\" >&2; exit 2; fi",
    `size=$(df -B1 --output=size / | tail -1 | tr -d ' '); [ \"$size\" -ge ${minimumBytes} ] || { echo \"Root filesystem did not reach the requested size.\" >&2; exit 3; }`
  ].join("; ");
}

async function defaultSshExec(worker: CloudRunWorkerSettings, command: string, timeoutMs: number): Promise<void> {
  const target = buildCloudRunSshTarget(worker as CloudRunWorkerSettings & { host: string });
  await runCommand("ssh", [...cloudRunSshOptionArgs(worker as CloudRunWorkerSettings & { host: string }), target, command], { timeoutMs });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function replacementLaunchToken(operationId: string, instanceId: string): string {
  return createHash("sha256")
    .update(`accordagents:replacement:${operationId}:${instanceId}`)
    .digest("hex");
}

function retainedActionFailure(
  action: "stopped" | "deleted",
  state: AwsWorkerStatus["state"],
  detail: string
): string {
  const observed = state ? ` Observed state: ${state}.` : " Observed state is unknown.";
  return `The shared worker was not ${action}; settings were retained.${observed} ${detail}`;
}
