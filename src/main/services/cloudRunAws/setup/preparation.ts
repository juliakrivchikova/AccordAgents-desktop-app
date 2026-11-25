import { isDeepStrictEqual } from "node:util";
import type {
  AwsWorkerActualSpec, AwsWorkerHandleInfo, AwsWorkerSpec, AwsWorkerStatus, CloudRunWorkerSettings
} from "../../../../shared/types";
import { awsRootVolumeSizeError, normalizeAwsInstanceType, normalizeAwsRootVolumeSizeGb } from "../../../../shared/cloudRuns";
import { parseWorkerBlob } from "../../awsWorkerProvisioning";
import type { AwsWorkerCredentials } from "../../awsWorkerProvisioning";
import type { AwsWorkerInstanceInfo } from "../../awsWorkerLifecycle";
import type { SettingsService } from "../../settings";
import { errorMessage } from "../access/errorText";
import { credentialsForHandle, handleFromInfo } from "../access/handles";
import { actualSpecFrom, multipleWorkerError, replacementLaunchToken, specMismatch, withRetainedKeys, workerSettings } from "./workerSpec";
import type { PrepareAwsWorkerRequest, PreparedAwsWorker } from "../types";
import type { AwsModules } from "../modules";
import type { AwsDependencies } from "../dependencies";

/** Prepares the User's AWS machine, or replaces it. */
export class Preparation {
  prepareActive: Promise<PreparedAwsWorker> | undefined;
  private prepareRequest: PrepareAwsWorkerRequest | undefined;

  constructor(
    private readonly aws: Pick<AwsModules, "ec2Access" | "goneInstances" | "leavingMachines" | "workerStatus">,
    private readonly deps: Pick<AwsDependencies, "generateKeyMaterial" | "lifecycle" | "settings" | "wait" | "workerAccess">
  ) {}

  // Compatibility entry point for older renderer callers. The new UI calls
  // AwsWorkerSetupService, which continues through running + doctor setup.
  async connectWorker(blob: string, instanceType?: string, rootVolumeSizeGb?: number): Promise<AwsWorkerStatus> {
    await this.prepareWorker({ blob, instanceType, rootVolumeSizeGb, operationId: `legacy-${Date.now()}` });
    return this.aws.workerStatus.status();
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
    // A gone instance being forgotten is finished first: its forget must not
    // land on the connection this preparation saves.
    await this.aws.goneInstances.forgetting;
    if (request.rootVolumeSizeGb !== undefined) {
      const invalidSize = awsRootVolumeSizeError(request.rootVolumeSizeGb);
      if (invalidSize) throw new Error(invalidSize);
    }
    const credentials = request.blob?.trim()
      ? withRetainedKeys(parseWorkerBlob(request.blob), await this.deps.settings.getAwsWorkerCredentials())
      : await this.deps.settings.getAwsWorkerCredentials();
    if (!credentials) {
      throw new Error("Connect the AWS account before starting the worker.");
    }
    const publicSettings = await this.deps.settings.getPublicSettings();
    const desiredType = normalizeAwsInstanceType(request.instanceType ?? publicSettings.cloudRuns.awsInstanceType);
    const desiredDisk = normalizeAwsRootVolumeSizeGb(request.rootVolumeSizeGb ?? publicSettings.cloudRuns.awsRootVolumeSizeGb);
    let matches = await this.aws.ec2Access.discoverWorkers(credentials, false);
    if (matches.length > 1) throw multipleWorkerError(matches);
    if (request.expectedInstanceId && matches[0]?.instanceId !== request.expectedInstanceId) {
      throw new Error("The instance changed after the size editor opened. Refresh and review it before applying.");
    }
    let replacedInstanceId: string | undefined;
    if (matches.length === 0 && request.blob?.trim()) {
      const previousCredentials = await this.deps.settings.getAwsWorkerCredentials();
      const previousHandle = publicSettings.cloudRuns.awsHandle;
      if (previousCredentials && previousHandle && previousCredentials.accessKeyId !== credentials.accessKeyId) {
        let previous: AwsWorkerInstanceInfo | undefined;
        try {
          previous = await this.aws.ec2Access.clientForRegion(previousCredentials, previousHandle.region).describeInstance(previousHandle.instanceId);
        } catch (error) {
          throw new Error(`Could not verify the existing AWS worker before replacing credentials: ${errorMessage(error)}. Delete the existing worker first.`);
        }
        if (previous && previous.state !== "terminated" && previous.state !== "absent") {
          throw new Error("An AWS worker is already configured but is not visible to the new credentials. Delete the existing worker first.");
        }
        replacedInstanceId = previousHandle.instanceId;
      }
    }
    // Another instance takes the saved one's place: its machines go first,
    // once AWS says it can never come back.
    const savedHandle = publicSettings.cloudRuns.awsHandle;
    if (savedHandle && matches[0]?.instanceId !== savedHandle.instanceId) {
      await this.aws.leavingMachines.replacedInstanceMachinesLeave(savedHandle, await this.deps.settings.getAwsWorkerCredentials(), credentials);
    }
    let created = false;
    let info = matches[0];
    let handle: AwsWorkerHandleInfo;
    if (!info) {
      const persistedToken = await (this.deps.settings as SettingsService & {
        getAwsWorkerProvisioningToken?: () => Promise<string | undefined>;
        saveAwsWorkerProvisioningToken?: (token: string | undefined) => Promise<void>;
      }).getAwsWorkerProvisioningToken?.();
      const clientToken = replacedInstanceId
        ? replacementLaunchToken(request.operationId, replacedInstanceId)
        : persistedToken ?? request.clientToken ?? request.operationId;
      await (this.deps.settings as SettingsService & {
        saveAwsWorkerProvisioningToken?: (token: string | undefined) => Promise<void>;
      }).saveAwsWorkerProvisioningToken?.(clientToken);
      const deviceId = await (this.deps.settings as SettingsService & { getCloudRunsDeviceId?: () => Promise<string> }).getCloudRunsDeviceId?.() ?? "legacy";
      const createdHandle = await this.deps.lifecycle.createWorker(credentials, {
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
      handle = handleFromInfo(info, {
        keyName: createdHandle.keyName,
        privateKeyPath: createdHandle.privateKeyPath,
        securityGroupId: createdHandle.securityGroupId,
        created: true
      });
    } else {
      const key = await this.deps.generateKeyMaterial();
      handle = handleFromInfo(info, {
        keyName: key.keyName,
        privateKeyPath: key.privateKeyPath,
        securityGroupId: info.securityGroupId,
        created: false
      });
    }
    await this.deps.settings.saveCloudRunsSettings({
      awsInstanceType: desiredType,
      awsRootVolumeSizeGb: desiredDisk
    });
    const connectionSaver = (this.deps.settings as SettingsService & {
      saveAwsWorkerConnection?: (nextCredentials: AwsWorkerCredentials, nextHandle: AwsWorkerHandleInfo) => Promise<void>;
    }).saveAwsWorkerConnection;
    if (connectionSaver) {
      await connectionSaver.call(this.deps.settings, credentials, handle);
    } else {
      await this.deps.settings.saveAwsWorkerCredentials(credentials);
      await this.deps.settings.saveAwsWorkerHandle(handle);
      await this.deps.settings.setCloudRunsMode("aws");
    }
    await (this.deps.settings as SettingsService & {
      saveAwsWorkerProvisioningToken?: (token: string | undefined) => Promise<void>;
    }).saveAwsWorkerProvisioningToken?.(undefined);
    const actualSpec = actualSpecFrom(info, handle);
    const desiredCapacity = await this.aws.ec2Access.capacityFor(credentials, desiredType);
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
    const { info, handle } = await this.aws.workerStatus.existingWorker(expectedInstanceId);
    const actual = actualSpecFrom(info, handle);
    await this.deps.settings.saveCloudRunsSettings({
      awsInstanceType: actual.instanceType,
      awsRootVolumeSizeGb: actual.rootVolumeSizeGb
    });
    return actual;
  }

  async acceptMismatch(prepared: PreparedAwsWorker): Promise<void> {
    await (this.deps.settings as SettingsService & {
      saveAwsWorkerSpecAcceptance?: (instanceId: string, desired: AwsWorkerSpec) => Promise<void>;
    }).saveAwsWorkerSpecAcceptance?.(prepared.info.instanceId, prepared.desiredSpec);
  }

  async hasAcceptedMismatch(prepared: PreparedAwsWorker): Promise<boolean> {
    return await (this.deps.settings as SettingsService & {
      hasAwsWorkerSpecAcceptance?: (instanceId: string, desired: AwsWorkerSpec) => Promise<boolean>;
    }).hasAwsWorkerSpecAcceptance?.(prepared.info.instanceId, prepared.desiredSpec) ?? false;
  }

  async recreateWorker(prepared: PreparedAwsWorker, expectedInstanceId: string, operationId: string): Promise<PreparedAwsWorker> {
    if (prepared.info.instanceId !== expectedInstanceId) {
      throw new Error("The shared worker changed after confirmation. Refresh and choose again.");
    }
    // The replacement owns the old instance until its handle is dropped: a
    // status read meanwhile must not forget the whole connection.
    await this.aws.goneInstances.whileDeleting(expectedInstanceId, async () => {
      const result = await this.deps.lifecycle.deleteWorker(credentialsForHandle(prepared.credentials, prepared.handle), this.aws.ec2Access.toHandle(prepared.handle));
      if (result.terminateFailed || !result.terminationConfirmed) {
        throw new Error(`The existing shared worker could not be confirmed terminated: ${result.terminateFailed ?? "unknown termination state"}`);
      }
      // The old instance's program can never come back: its machines leave
      // with it, and the new instance enrolls as a new machine. A removal cut
      // short is finished later; the replacement goes on.
      await this.aws.goneInstances.oneForgetAtATime(() => this.aws.leavingMachines.machinesLeave(prepared.handle, "replaced"));
      await this.deps.settings.saveAwsWorkerHandle(undefined);
    });
    return this.prepareWorker({
      operationId,
      instanceType: prepared.desiredSpec.instanceType,
      rootVolumeSizeGb: prepared.desiredSpec.rootVolumeSizeGb
    });
  }

  async ensurePreparedRunning(prepared: Pick<PreparedAwsWorker, "credentials" | "handle">,
    options: { start?: boolean } = {}): Promise<CloudRunWorkerSettings> {
    const deviceId = await (this.deps.settings as SettingsService & { getCloudRunsDeviceId?: () => Promise<string> }).getCloudRunsDeviceId?.() ?? "legacy";
    const running = await this.deps.lifecycle.ensureRunning(credentialsForHandle(prepared.credentials, prepared.handle), this.aws.ec2Access.toHandle(prepared.handle),
      deviceId, options);
    const key = await this.aws.ec2Access.keyForHandle(prepared.handle);
    await this.deps.workerAccess.ensureAccess(this.aws.ec2Access.clientForRegion(prepared.credentials, prepared.handle.region), running, key);
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
      await this.deps.settings.saveAwsWorkerHandle(prepared.handle);
    }
    return workerSettings(running.publicIp as string, key.privateKeyPath, deviceId, running.instanceId);
  }

  private async reconcileCreatedWorker(
    credentials: AwsWorkerCredentials,
    instanceId: string
  ): Promise<AwsWorkerInstanceInfo> {
    let stableMatches = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const matches = await this.aws.ec2Access.discoverWorkers(credentials, true);
      if (matches.length > 1) throw multipleWorkerError(matches);
      const created = matches.find((worker) => worker.instanceId === instanceId);
      if (created && matches.length === 1) {
        stableMatches += 1;
        if (stableMatches >= 2) return created;
      } else {
        stableMatches = 0;
      }
      await this.deps.wait(5_000);
    }
    throw new Error("The new AWS worker was launched but could not be reconciled safely. Retry with the same operation.");
  }
}
