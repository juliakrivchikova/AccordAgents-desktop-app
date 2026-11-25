import type { AwsWorkerHandleInfo, AwsWorkerStatus } from "../../../../shared/types";
import type { AwsWorkerCredentials } from "../../awsWorkerProvisioning";
import type { AwsWorkerDeleteResult } from "../../awsWorkerLifecycle";
import { errorMessage, plainReason } from "../access/errorText";
import { credentialsForHandle } from "../access/handles";
import { retainedActionFailure } from "../setup/workerSpec";
import type { AwsModules } from "../modules";
import type { AwsDependencies } from "../dependencies";

/** Stops and deletes the instance. */
export class InstanceRemoval {
  /** Instances the User deleted in this session. */
  readonly deletedByUser = new Set<string>();

  constructor(
    private readonly aws: Pick<AwsModules, "ec2Access" | "goneInstances" | "workerStatus">,
    private readonly deps: Pick<AwsDependencies, "lifecycle" | "settings">
  ) {}

  /** Settings → AWS → Delete: the instance is terminated (or found already
   *  gone), what the app made for it is removed, and so are the machines on
   *  it and the AWS connection. */
  async deleteWorker(): Promise<AwsWorkerStatus> {
    const credentials = await this.deps.settings.getAwsWorkerCredentials();
    const settings = await this.deps.settings.getPublicSettings();
    const handle = settings.cloudRuns.awsHandle;
    if (!credentials || !handle) return { configured: false };
    return this.aws.goneInstances.whileDeleting(handle.instanceId, () => this.deleteInstance(credentials, handle));
  }

  private async deleteInstance(credentials: AwsWorkerCredentials, handle: AwsWorkerHandleInfo): Promise<AwsWorkerStatus> {
    // An instance AWS already terminated or no longer has is deleted as it
    // is. A look that fails is not "gone": the terminate below answers then.
    const alreadyGone = await this.aws.ec2Access.clientForRegion(credentials, handle.region).describeInstance(handle.instanceId)
      .then((info) => this.aws.goneInstances.instanceGone(info, handle), () => false);
    let result: AwsWorkerDeleteResult;
    try {
      result = await this.deps.lifecycle.deleteWorker(credentialsForHandle(credentials, handle), this.aws.ec2Access.toHandle(handle), { alreadyGone });
    } catch (error) {
      const current = await this.aws.workerStatus.status();
      return {
        ...current,
        configured: true,
        handle,
        actionError: errorMessage(error),
        message: retainedActionFailure("deleted", current.state, errorMessage(error))
      };
    }
    if (result.terminateFailed || !result.terminationConfirmed) {
      const current = await this.aws.workerStatus.status();
      return {
        ...current,
        configured: true,
        handle,
        actionError: result.terminateFailed ?? "Termination was not confirmed.",
        message: retainedActionFailure("deleted", current.state, result.terminateFailed ?? "Termination was not confirmed.")
      };
    }
    this.deletedByUser.add(handle.instanceId);
    try {
      await this.aws.goneInstances.oneForgetAtATime(() => this.aws.goneInstances.forgetInstance(handle, "deleted"));
    } catch (error) {
      // Terminated, but this computer could not record it: the instance stays
      // saved, and the next look at it finishes the Delete.
      return { configured: true, handle, state: "terminated", actionError: errorMessage(error),
        message: `The instance is terminated, but this computer could not forget it yet: ${plainReason(errorMessage(error)).replace(/[.!?…]$/, "")}. The app tries again by itself.` };
    }
    // An old machine that could not be removed yet is said by the page's
    // notice, as on every later look.
    const notices = await this.aws.workerStatus.leavingNotices();
    return {
      configured: false,
      message: result.cleanupFailures.length > 0 ? `Worker terminated with ${result.cleanupFailures.length} cleanup warning(s).` : undefined,
      ...(notices.length ? { notices } : {})
    };
  }

  async stopWorker(): Promise<AwsWorkerStatus> {
    const credentials = await this.deps.settings.getAwsWorkerCredentials();
    const settings = await this.deps.settings.getPublicSettings();
    const handle = settings.cloudRuns.awsHandle;
    if (!credentials || !handle) return { configured: false };
    try {
      await this.deps.lifecycle.stopWorker(credentialsForHandle(credentials, handle), this.aws.ec2Access.toHandle(handle));
    } catch (error) {
      const current = await this.aws.workerStatus.status();
      return {
        ...current,
        configured: true,
        handle,
        actionError: errorMessage(error),
        message: retainedActionFailure("stopped", current.state, errorMessage(error))
      };
    }
    return this.aws.workerStatus.status();
  }
}
