import type { AwsWorkerHandleInfo, AwsWorkerOperationSnapshot } from "../../../../shared/types";
import type { AwsWorkerInstanceInfo } from "../../awsWorkerLifecycle";
import { errorMessage } from "../access/errorText";
import { safeAwsErrorLogFields } from "../access/handles";
import { INSTANCE_VISIBILITY_GRACE_MS } from "../constants";
import type { ForgetOutcome, ForgetReason, ForgetResult } from "../types";
import type { AwsModules } from "../modules";
import type { AwsDependencies } from "../dependencies";

/** A setup or check that is running owns the instance meanwhile. */
const RUNNING_OPERATION_PHASES: ReadonlySet<AwsWorkerOperationSnapshot["phase"]> = new Set(["starting", "waiting-running", "setting-up"]);

/** Forgets an instance that is gone from AWS. */
export class GoneInstances {
  /** Instances Delete or Recreate is taking down, with how many of each. */
  private readonly deleting = new Map<string, number>();
  /** Forgetting an instance, one at a time; a preparation waits for it. */
  forgetting: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly aws: Pick<
      AwsModules,
      | "awsLog" | "ec2Access" | "instanceRemoval" | "leavingMachines" | "preparation" | "workerStatus"
    >,
    private readonly deps: Pick<AwsDependencies, "now" | "settings">
  ) {}

  /** At start-up, once the desktop's machines are up: what a removal left
   *  unfinished is finished, then one look whether AWS still has this app's
   *  instance; one it terminated or no longer has is forgotten with the
   *  machines on it. An AWS error changes nothing. */
  async forgetInstanceIfGone(): Promise<boolean> {
    await this.aws.leavingMachines.sharedLeavingPass();
    const { credentials, handle } = await this.aws.workerStatus.workerContext();
    if (!credentials || !handle) return false;
    let info: AwsWorkerInstanceInfo | undefined;
    try {
      info = await this.aws.ec2Access.clientForRegion(credentials, handle.region).describeInstance(handle.instanceId);
    } catch (error) {
      this.aws.awsLog.log("aws-worker.gone-check.error", { instanceId: handle.instanceId, ...safeAwsErrorLogFields(error) });
      return false;
    }
    return (await this.forgetIfObservedGone(handle, info)).kind === "forgotten";
  }

  /** AWS says the instance can never come back: it is terminated, or AWS no
   *  longer has it at all. A stopped or stopping instance is not gone, and a
   *  failed look never reaches here. */
  instanceGone(info: AwsWorkerInstanceInfo | undefined, handle: AwsWorkerHandleInfo): boolean {
    if (info) return info.state === "terminated";
    const since = Date.parse(handle.createdAt);
    return Number.isFinite(since) && this.deps.now() - since >= INSTANCE_VISIBILITY_GRACE_MS;
  }

  /** What one look at the instance means for this desktop: nothing while
   *  AWS has it; otherwise it is forgotten, waited for at most `waitMs`. */
  async forgetIfObservedGone(handle: AwsWorkerHandleInfo, info: AwsWorkerInstanceInfo | undefined,
    waitMs?: number): Promise<ForgetOutcome | { kind: "present" }> {
    if (!this.instanceGone(info, handle)) return { kind: "present" };
    const forgetting = this.forgetGoneInstance(handle, info ? "terminated" : "not-found");
    if (waitMs === undefined) return forgetting;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = new Promise<ForgetOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "pending" }), waitMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([forgetting, later]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The app saw by itself that its instance is gone: the instance is
   *  forgotten with its machines, and the AWS page says so. Not while Delete,
   *  a setup or a new instance owns it, and not when the instance changed
   *  since the look. */
  private forgetGoneInstance(observed: AwsWorkerHandleInfo, observation: "terminated" | "not-found"): Promise<ForgetOutcome> {
    return this.oneForgetAtATime(async (): Promise<ForgetOutcome> => {
      if (this.deleting.has(observed.instanceId) || this.aws.preparation.prepareActive) return { kind: "kept" };
      const { credentials, handle, operation } = await this.aws.workerStatus.workerContext();
      if (!credentials || !handle || handle.instanceId !== observed.instanceId || handle.region !== observed.region) return { kind: "changed" };
      if (operation && RUNNING_OPERATION_PHASES.has(operation.phase)) return { kind: "kept" };
      // The User's own Delete that could not finish ends the way she asked
      // for: keys and all, and with nothing to tell her.
      const reason: ForgetReason = this.aws.instanceRemoval.deletedByUser.has(handle.instanceId) ? "deleted" : "gone";
      this.aws.awsLog.log("aws-worker.instance-gone", { instanceId: handle.instanceId, region: handle.region, observed: observation, reason });
      return (await this.forgetInstance(handle, reason)).forgotten ? { kind: "forgotten" } : { kind: "changed" };
    }).catch((error: unknown): ForgetOutcome => {
      this.aws.awsLog.log("aws-worker.instance-gone.error", { instanceId: observed.instanceId, message: errorMessage(error).slice(0, 500) });
      return { kind: "kept" };
    });
  }

  /**
   * What this desktop keeps for an instance that can never come back: its
   * machines leave (see `machinesLeave`), then the instance is forgotten in
   * one settings write, only while it is still the saved one. Delete forgets
   * this app's AWS keys with it, as it always did. An instance the app found
   * gone by itself leaves the keys: they still work for a new instance, and
   * dropping them would mean running the administrator's setup command again.
   */
  async forgetInstance(handle: AwsWorkerHandleInfo, reason: ForgetReason): Promise<ForgetResult> {
    const machines = await this.aws.leavingMachines.machinesLeave(handle, reason);
    const forgotten = await this.deps.settings.forgetAwsWorkerInstance(handle.instanceId, reason === "deleted"
      ? { keepCredentials: false, mode: "ssh" }
      : { keepCredentials: true, ...(reason === "gone" ? { notice: { instanceId: handle.instanceId, at: new Date(this.deps.now()).toISOString() } } : {}) });
    this.aws.awsLog.log("aws-worker.forgotten", { instanceId: handle.instanceId, region: handle.region, reason, machineIds: machines.machineIds, forgotten });
    return { ...machines, forgotten };
  }

  oneForgetAtATime<T>(action: () => Promise<T>): Promise<T> {
    const run = this.forgetting.then(action);
    this.forgetting = run.catch(() => undefined);
    return run;
  }

  /** Delete and Recreate take their instance down; nothing forgets it by
   *  itself meanwhile. Counted, so overlapping ones do not end each other's. */
  async whileDeleting<T>(instanceId: string, action: () => Promise<T>): Promise<T> {
    this.deleting.set(instanceId, (this.deleting.get(instanceId) ?? 0) + 1);
    try {
      return await action();
    } finally {
      const left = (this.deleting.get(instanceId) ?? 1) - 1;
      if (left > 0) this.deleting.set(instanceId, left);
      else this.deleting.delete(instanceId);
    }
  }
}
