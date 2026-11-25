import type { AwsWorkerHandleInfo } from "../../../../shared/types";
import type { AwsWorkerCredentials } from "../../awsWorkerProvisioning";
import type { AwsWorkerInstanceInfo } from "../../awsWorkerLifecycle";
import { awsAuthorizationErrorDetails, isAwsAuthorizationError } from "../../awsEc2Client";
import type { LeavingMachine } from "../../settings";
import { errorMessage, plainReason } from "../access/errorText";
import { safeAwsErrorLogFields } from "../access/handles";
import type { ForgetReason } from "../types";
import type { AwsModules } from "../modules";
import type { AwsDependencies } from "../dependencies";

/** How long a machine removal that failed waits before a look tries it again. */
const FORGET_RETRY_MS = 5 * 60_000;

/** Machines of an instance that was replaced or deleted, until each is removed. */
export class LeavingMachines {
  /** The last removal of a leaving machine that failed, and why. */
  leavingFailure: { at: number; error: string } | undefined;
  /** A background pass over the leaving machines, while one runs. */
  private leavingPass: Promise<unknown> | undefined;
  /** When old instances the app could not check were last looked at again. */
  private unverifiedCheckedAt: number | undefined;
  /** The AWS account the keys in use belong to, once AWS has said. */
  private keysAccount: { accessKeyId: string; accountId: string } | undefined;

  constructor(
    private readonly aws: Pick<AwsModules, "awsLog" | "ec2Access" | "goneInstances" | "installedPrograms" | "workerStatus">,
    private readonly deps: Pick<AwsDependencies, "machinesReady" | "now" | "removeMachine" | "settings">
  ) {}

  /**
   * The machines on an instance whose program can never come back leave this
   * desktop, each the way Settings → Remove removes one. They are recorded
   * first, so a removal cut short, by a failure or a restart, is finished on
   * a later look; nothing waits for that.
   */
  async machinesLeave(handle: AwsWorkerHandleInfo, reason: ForgetReason): Promise<{ machineIds: string[]; error?: string }> {
    const machineIds = await this.recordLeaving(handle);
    const error = await this.removeLeavingMachines();
    this.aws.awsLog.log("aws-worker.machines-leave", { instanceId: handle.instanceId, reason, machineIds, ...(error ? { error } : {}) });
    return { machineIds, ...(error ? { error } : {}) };
  }

  /** Records the machines on an instance as leaving; with `unverified`, as
   *  machines the app may not remove because it could not check the instance. */
  private async recordLeaving(handle: AwsWorkerHandleInfo, unverified?: "refused" | "unreadable", accountId?: string): Promise<string[]> {
    const machineIds = (await this.aws.installedPrograms.installsOnInstance(handle)).machines.map((machine) => machine.id);
    const at = new Date(this.deps.now()).toISOString();
    const dropped = await this.deps.settings.addLeavingMachines(machineIds.map((machineId) => ({
      machineId, instanceId: handle.instanceId, at,
      ...(unverified ? { unverified, region: handle.region, ...(accountId ? { accountId } : {}) } : {})
    })));
    if (dropped.length) {
      this.aws.awsLog.log("aws-worker.machine-leave.dropped", { machineIds: dropped.map((entry) => entry.machineId), instanceIds: dropped.map((entry) => entry.instanceId) });
    }
    return machineIds;
  }

  /** Removes the machines recorded as leaving. One that fails stays recorded
   *  and the others go on; returns why the first failed, in plain words. A
   *  machine already gone (the User removed it) is no longer recorded. One
   *  whose old instance the app could not check stays until AWS confirms
   *  that instance is gone (`confirmedGone`); the confirmation is saved
   *  before anything is removed, so a removal that fails keeps it. */
  private async removeLeavingMachines(confirmedGone: ReadonlySet<string> = new Set()): Promise<string | undefined> {
    let leaving = await this.deps.settings.listLeavingMachines();
    if (!leaving.length) {
      this.leavingFailure = undefined;
      return undefined;
    }
    const saved = await this.aws.workerStatus.savedInstanceId();
    const confirmed = leaving.filter((entry) => entry.unverified && confirmedGone.has(entry.instanceId) && entry.instanceId !== saved);
    if (confirmed.length) {
      await this.deps.settings.addLeavingMachines(confirmed.map((entry) => ({ machineId: entry.machineId, instanceId: entry.instanceId, at: entry.at })));
      leaving = await this.deps.settings.listLeavingMachines();
    }
    await this.deps.machinesReady?.();
    const present = new Set((await this.deps.settings.listMachines()).map((machine) => machine.id));
    let first: string | undefined;
    for (const entry of leaving) {
      // One the app could not check stays, unless its instance is the saved
      // one again (then it is no longer leaving), AWS now confirms it gone,
      // or its machine is gone.
      if (entry.unverified && entry.instanceId === saved) {
        await this.deps.settings.clearLeavingMachine(entry.machineId).catch(() => undefined);
        continue;
      }
      if (entry.unverified && present.has(entry.machineId)) continue;
      try {
        if (present.has(entry.machineId)) await this.deps.removeMachine?.(entry.machineId);
        await this.deps.settings.clearLeavingMachine(entry.machineId);
      } catch (error) {
        first ??= plainReason(errorMessage(error)).replace(/[.!?…]$/, "");
        this.aws.awsLog.log("aws-worker.machine-leave.error", { machineId: entry.machineId, instanceId: entry.instanceId, message: errorMessage(error).slice(0, 500) });
      }
    }
    this.leavingFailure = first ? { at: this.deps.now(), error: first } : undefined;
    return first;
  }

  /**
   * Looks again at old instances the app could not check, with the keys in
   * use, at most every five minutes. One is gone when AWS says terminated,
   * or says it has no such instance to keys of the account it belongs to;
   * keys of another account are told the same about any instance, so that
   * alone proves nothing. Any other answer, or an error, keeps it listed.
   */
  private async recheckUnverifiedInstances(): Promise<Set<string>> {
    const gone = new Set<string>();
    if (this.unverifiedCheckedAt !== undefined && this.deps.now() - this.unverifiedCheckedAt < FORGET_RETRY_MS) return gone;
    const leaving = await this.deps.settings.listLeavingMachines().catch((): LeavingMachine[] => []);
    if (!leaving.some((entry) => entry.unverified)) return gone;
    const present = new Set((await this.deps.settings.listMachines().catch(() => [])).map((machine) => machine.id));
    const { credentials, handle } = await this.aws.workerStatus.workerContext();
    const waiting = leaving.filter((entry) => entry.unverified && entry.instanceId !== handle?.instanceId && present.has(entry.machineId));
    if (!waiting.length) return gone;
    this.unverifiedCheckedAt = this.deps.now();
    if (!credentials) return gone;
    // Which account these keys belong to is learned from the saved instance
    // first, so a look right after start-up can already use it.
    if (handle && this.keysAccount?.accessKeyId !== credentials.accessKeyId) {
      try {
        this.noteKeysAccount(credentials, await this.aws.ec2Access.clientForRegion(credentials, handle.region).describeInstance(handle.instanceId));
      } catch (error) {
        this.aws.awsLog.log("aws-worker.unconfirmed.account-error", { ...safeAwsErrorLogFields(error) });
      }
    }
    for (const instanceId of new Set(waiting.map((entry) => entry.instanceId))) {
      const entry = waiting.find((item) => item.instanceId === instanceId)!;
      if (!entry.region) continue;
      let info: AwsWorkerInstanceInfo | undefined;
      try {
        info = await this.aws.ec2Access.clientForRegion(credentials, entry.region).describeInstance(instanceId);
      } catch (error) {
        this.aws.awsLog.log("aws-worker.unconfirmed.check-error", { instanceId, ...safeAwsErrorLogFields(error) });
        continue;
      }
      this.noteKeysAccount(credentials, info);
      const sameAccount = Boolean(entry.accountId) && this.keysAccount?.accessKeyId === credentials.accessKeyId
        && this.keysAccount.accountId === entry.accountId;
      const confirmed = info ? info.state === "terminated" : sameAccount;
      this.aws.awsLog.log("aws-worker.unconfirmed.checked", { instanceId, state: info?.state ?? "not-found", sameAccount, confirmed });
      if (confirmed) gone.add(instanceId);
    }
    return gone;
  }

  /** Remembers which account the keys in use belong to, from an instance
   *  AWS described to them. */
  noteKeysAccount(credentials: AwsWorkerCredentials, info: AwsWorkerInstanceInfo | undefined): void {
    if (info?.ownerId) this.keysAccount = { accessKeyId: credentials.accessKeyId, accountId: info.ownerId };
  }

  /** One pass over the leaving machines: old instances the app could not
   *  check are looked at again outside the one-at-a-time queue, so nothing
   *  waits on AWS; only the removal itself runs in it. */
  private async leavingPassOnce(): Promise<string | undefined> {
    const confirmedGone = await this.recheckUnverifiedInstances();
    return this.aws.goneInstances.oneForgetAtATime(() => this.removeLeavingMachines(confirmedGone));
  }

  /** A look finishes, in the background, what a removal left unfinished: at
   *  most every five minutes after a failure, and one pass at a time. */
  finishLeavingMachines(): void {
    if (this.leavingPass || this.leavingFailure && this.deps.now() - this.leavingFailure.at < FORGET_RETRY_MS) return;
    this.sharedLeavingPass();
  }

  /** The pass in flight, or a new one: never two at once. */
  sharedLeavingPass(): Promise<unknown> {
    if (this.leavingPass) return this.leavingPass;
    this.leavingPass = this.leavingPassOnce()
      .catch((error: unknown) => { this.aws.awsLog.log("aws-worker.machine-leave.error", { message: errorMessage(error).slice(0, 500) }); return undefined; })
      .finally(() => { this.leavingPass = undefined; });
    return this.leavingPass;
  }

  /**
   * A new instance takes the place of the saved one: the machines on the
   * old one leave first, once AWS says it is terminated or no longer has it.
   * A stopped or running old instance keeps them, as do keys this computer
   * can no longer read. When the old instance cannot be checked, nothing is
   * replaced: a new instance would leave its machines behind for good.
   */
  async replacedInstanceMachinesLeave(previous: AwsWorkerHandleInfo, saved: AwsWorkerCredentials | undefined,
    current: AwsWorkerCredentials): Promise<void> {
    // The old instance belongs to keys this computer cannot use any more:
    // its machines are kept and shown, never judged by other keys.
    const keep = async (why: "refused" | "unreadable", accountId?: string): Promise<void> => {
      const machineIds = await this.aws.goneInstances.oneForgetAtATime(() => this.recordLeaving(previous, why, accountId));
      this.aws.awsLog.log("aws-worker.replaced.kept", { instanceId: previous.instanceId, state: `keys-${why}`, machineIds, accountKnown: Boolean(accountId) });
    };
    if (!saved) return keep("unreadable");
    let info: AwsWorkerInstanceInfo | undefined;
    try {
      info = await this.aws.ec2Access.clientForRegion(saved, previous.region).describeInstance(previous.instanceId);
    } catch (error) {
      this.aws.awsLog.log("aws-worker.replaced.check-error", { instanceId: previous.instanceId, ...safeAwsErrorLogFields(error) });
      // New keys were pasted and AWS refuses the old ones: the new keys work,
      // so the replacement goes on as it always did.
      if (isAwsAuthorizationError(error) && saved.accessKeyId !== current.accessKeyId) {
        // The refusal names the old keys' user, and with it their account.
        return keep("refused", /^arn:aws:iam::(\d{12}):/.exec(awsAuthorizationErrorDetails(error).principalArn ?? "")?.[1]);
      }
      if (isAwsAuthorizationError(error)) throw error;
      throw new Error(`Could not check the previous instance ${previous.instanceId} in AWS: ${plainReason(errorMessage(error)).replace(/[.!?…]$/, "")}. Nothing was changed; try again.`);
    }
    if (!info && !this.aws.goneInstances.instanceGone(info, previous)) {
      throw new Error(`AWS does not show the previous instance ${previous.instanceId} yet. Nothing was changed; try again in a few minutes.`);
    }
    if (!this.aws.goneInstances.instanceGone(info, previous)) {
      this.aws.awsLog.log("aws-worker.replaced.kept", { instanceId: previous.instanceId, state: info?.state });
      return;
    }
    await this.aws.goneInstances.oneForgetAtATime(() => this.machinesLeave(previous, "replaced"));
  }
}
