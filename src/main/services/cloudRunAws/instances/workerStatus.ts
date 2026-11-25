import type { AwsWorkerHandleInfo, AwsWorkerStatus, CloudRunWorkerSettings } from "../../../../shared/types";
import type { AwsWorkerCredentials } from "../../awsWorkerProvisioning";
import type { AwsWorkerInstanceInfo } from "../../awsWorkerLifecycle";
import type { SettingsService } from "../../settings";
import { errorMessage } from "../access/errorText";
import { AWS_INSTANCE_GONE_NOTICE, OLD_MACHINE_NOT_REMOVED, OLD_MACHINE_UNCONFIRMED, UNVERIFIED_REASON } from "../constants";
import { actualSpecFrom, workerSettings } from "../setup/workerSpec";
import type { StoredAwsWorkerOperation } from "../types";
import type { AwsModules } from "../modules";
import type { AwsDependencies } from "../dependencies";

/** How long a status read waits for the removal of a gone instance. */
const STATUS_FORGET_WAIT_MS = 10_000;

/** How the machine is doing, as Settings shows it. */
export class WorkerStatus {
  constructor(
    private readonly aws: Pick<AwsModules, "autoStop" | "ec2Access" | "goneInstances" | "leavingMachines">,
    private readonly deps: Pick<AwsDependencies, "settings">
  ) {}

  async status(): Promise<AwsWorkerStatus> {
    return this.readStatus(true);
  }

  private async readStatus(again: boolean): Promise<AwsWorkerStatus> {
    // Machines of an instance that can never come back, whose removal was
    // cut short, are finished in the background whatever this look finds.
    this.aws.leavingMachines.finishLeavingMachines();
    const context = await this.workerContext();
    if (!context.credentials || !context.handle) return this.notConfigured(context.operation);
    let status: AwsWorkerStatus;
    let info: AwsWorkerInstanceInfo | undefined;
    try {
      ({ status, info } = await this.describeWorker(context.credentials, context.handle, context.operation));
    } catch (error) {
      status = { configured: true, handle: context.handle, operation: context.operation, message: errorMessage(error) };
      return this.withLeavingNotices(await this.aws.autoStop.withMachineState(context.credentials, context.handle, status));
    }
    // Removing the machines can take a while on a long chat history: the
    // page is answered meanwhile, and its next look shows the result.
    const outcome = await this.aws.goneInstances.forgetIfObservedGone(context.handle, info, STATUS_FORGET_WAIT_MS);
    if (outcome.kind === "forgotten") return this.notConfigured(undefined);
    // Another look, Delete or a new instance got there first: what is saved
    // now is the answer, not this look.
    if (outcome.kind === "changed" && again) return this.readStatus(false);
    return this.withLeavingNotices(await this.aws.autoStop.withMachineState(context.credentials, context.handle, status));
  }

  async savedInstanceId(): Promise<string | undefined> {
    return (await this.deps.settings.getPublicSettings().catch(() => undefined))?.cloudRuns.awsHandle?.instanceId;
  }

  /** A running instance's page says too when an old machine is still here. */
  async withLeavingNotices(status: AwsWorkerStatus): Promise<AwsWorkerStatus> {
    const notices = await this.leavingNotices();
    return notices.length ? { ...status, notices } : status;
  }

  /** The lines about old cloud machines still on this computer, counting
   *  only machines that still exist: ones whose removal failed, and ones
   *  whose old instance the app could not confirm is gone. */
  async leavingNotices(): Promise<string[]> {
    const leaving = await this.deps.settings.listLeavingMachines().catch(() => []);
    if (!leaving.length) return [];
    const present = new Set((await this.deps.settings.listMachines().catch(() => [])).map((machine) => machine.id));
    const saved = await this.savedInstanceId();
    // An instance the app could not check that is the saved one again is not
    // an old instance: its machines are this computer's current ones.
    const left = leaving.filter((entry) => present.has(entry.machineId) && !(entry.unverified && entry.instanceId === saved));
    const notices: string[] = [];
    if (this.aws.leavingMachines.leavingFailure && left.some((entry) => !entry.unverified)) {
      notices.push(`${OLD_MACHINE_NOT_REMOVED}: ${this.aws.leavingMachines.leavingFailure.error}. The app tries again by itself.`);
    }
    const unverified = left.find((entry) => entry.unverified)?.unverified;
    if (unverified) notices.push(`${OLD_MACHINE_UNCONFIRMED}: ${UNVERIFIED_REASON[unverified]}.`);
    return notices;
  }

  /** No instance, and what the AWS page says about the last one: that AWS
   *  no longer had it, and any old machine of it still on this computer. */
  private async notConfigured(operation: StoredAwsWorkerOperation): Promise<AwsWorkerStatus> {
    const [gone, leaving] = await Promise.all([
      this.deps.settings.getAwsWorkerGoneNotice().catch(() => undefined),
      this.leavingNotices()
    ]);
    // Both lines, each while it holds.
    const notices = [...(gone ? [AWS_INSTANCE_GONE_NOTICE] : []), ...leaving];
    return { configured: false, operation, ...(notices.length ? { notices } : {}) };
  }

  /** When the instance last started, while it is running; 0 when it runs
   *  but AWS does not say since when. Reads only. */
  async instanceRunningSince(): Promise<number | undefined> {
    const context = await this.workerContext();
    if (!context.credentials || !context.handle) return undefined;
    const { status, info } = await this.describeWorker(context.credentials, context.handle, context.operation);
    if (status.state !== "running") return undefined;
    const launched = info?.launchedAt ? Date.parse(info.launchedAt) : Number.NaN;
    return Number.isFinite(launched) ? launched : 0;
  }

  async workerContext(): Promise<{
    credentials: AwsWorkerCredentials | undefined;
    handle: AwsWorkerHandleInfo | undefined;
    operation: StoredAwsWorkerOperation;
  }> {
    const credentials = await this.deps.settings.getAwsWorkerCredentials();
    const settings = await this.deps.settings.getPublicSettings();
    const operation = await (this.deps.settings as SettingsService & { getAwsWorkerOperation?: () => Promise<StoredAwsWorkerOperation> }).getAwsWorkerOperation?.();
    return { credentials, handle: settings.cloudRuns.awsHandle, operation };
  }

  async describeWorker(
    credentials: AwsWorkerCredentials,
    handle: AwsWorkerHandleInfo,
    operation: StoredAwsWorkerOperation
  ): Promise<{ status: AwsWorkerStatus; info?: AwsWorkerInstanceInfo }> {
    // Polling status intentionally describes only the cached worker. Account
    // fan-out is reserved for Start/recovery paths.
    const info = await this.aws.ec2Access.clientForRegion(credentials, handle.region).describeInstance(handle.instanceId);
    this.aws.leavingMachines.noteKeysAccount(credentials, info);
    return { info, status: {
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

  /** Inspecting an instance (its setup, its disk) must never wake or prepare it. */
  async workerForInspection(): Promise<CloudRunWorkerSettings> {
    const { info, handle } = await this.existingWorker();
    if (info.state !== "running") {
      throw new Error(`The AWS instance is ${info.state}. Start the instance and wait until it is running before checking its runtime.`);
    }
    if (!info.publicIp?.trim()) throw new Error("No public IP address is available for the running instance. Refresh its status before checking the runtime.");
    const deviceId = await this.deps.settings.getCloudRunsDeviceId();
    return workerSettings(info.publicIp.trim(), this.aws.ec2Access.privateKeyPath(handle), deviceId, info.instanceId);
  }

  async existingWorker(expectedInstanceId?: string): Promise<{ info: AwsWorkerInstanceInfo; handle: AwsWorkerHandleInfo }> {
    const { credentials, handle } = await this.workerContext();
    if (!credentials || !handle) throw new Error("The AWS instance is not configured. Connect it in Settings first.");
    if (expectedInstanceId && handle.instanceId !== expectedInstanceId) {
      throw new Error("The instance changed. Refresh and review it before continuing.");
    }
    const info = await this.aws.ec2Access.clientForRegion(credentials, handle.region).describeInstance(handle.instanceId);
    if (!info || info.instanceId !== handle.instanceId || info.state === "terminated" || info.state === "absent") {
      throw new Error("The selected AWS instance is no longer available. Refresh its status in Settings.");
    }
    return { info, handle };
  }
}
