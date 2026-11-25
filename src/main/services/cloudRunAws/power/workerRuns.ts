import type { CloudRunWorkerSettings } from "../../../../shared/types";
import { actualSpecFrom, specMismatch } from "../setup/workerSpec";
import type { PreparedAwsWorker } from "../types";
import type { AwsModules } from "../modules";
import type { AwsDependencies } from "../dependencies";

/** Keeps the machine up while members run on it. */
export class WorkerRuns {
  private readonly activeRunIds = new Set<string>();

  constructor(
    private readonly aws: Pick<AwsModules, "diskGrowth" | "ec2Access" | "preparation" | "workerStatus">,
    private readonly deps: Pick<AwsDependencies, "lifecycle" | "settings">
  ) {}

  /** With `start: false`, the way to a running instance only, for looking
   *  at or setting up the program on it: this device's SSH access is renewed,
   *  as its address may have changed, and nothing is started, grown or held
   *  to the configured size. Bringing a program back must never undo a stop. */
  async ensureExistingWorkerForRun(instanceId: string, options: { start?: boolean } = {}): Promise<CloudRunWorkerSettings> {
    if (options.start !== false) return this.ensureWorkerForRun(instanceId);
    const { credentials, handle } = await this.aws.workerStatus.workerContext();
    if (!credentials || !handle) throw new Error("The AWS instance is not configured. Connect it in Settings first.");
    if (handle.instanceId !== instanceId) throw new Error("The selected AWS instance changed. Select Cloud run again.");
    return this.aws.preparation.ensurePreparedRunning({ credentials, handle }, { start: false });
  }

  async ensureWorkerForRun(expectedInstanceId?: string): Promise<CloudRunWorkerSettings> {
    const credentials = await this.deps.settings.getAwsWorkerCredentials();
    const settings = await this.deps.settings.getPublicSettings();
    if (!credentials) throw new Error("The AWS worker is not configured. Start it in Settings first.");
    let handle = settings.cloudRuns.awsHandle;
    if (expectedInstanceId && handle?.instanceId !== expectedInstanceId) {
      throw new Error("The selected AWS instance changed. Select Cloud run again.");
    }
    let info = handle
      ? await this.aws.ec2Access.clientForRegion(credentials, handle.region).describeInstance(handle.instanceId)
      : undefined;
    if (!handle || !info || info.state === "terminated") {
      if (expectedInstanceId) throw new Error("The selected AWS instance is no longer available. Check it in Settings.");
      const prepared = await this.aws.diskGrowth.resumePendingVolumeExpansion(
        await this.aws.preparation.prepareWorker({ operationId: `run-${Date.now()}` })
      );
      handle = prepared.handle;
      info = prepared.info;
      if (prepared.mismatch && !await this.aws.preparation.hasAcceptedMismatch(prepared)) {
        throw new Error("The shared AWS worker is smaller than the configured requirement. Open Settings and choose Keep, Grow disk, or Recreate.");
      }
      return this.aws.preparation.ensurePreparedRunning(prepared);
    }
    const prepared: PreparedAwsWorker = {
      credentials,
      handle,
      info,
      actualSpec: actualSpecFrom(info, handle),
      desiredSpec: {
        instanceType: settings.cloudRuns.awsInstanceType,
        rootVolumeSizeGb: settings.cloudRuns.awsRootVolumeSizeGb,
        ...await this.aws.ec2Access.capacityFor(credentials, settings.cloudRuns.awsInstanceType)
      },
      mismatch: undefined,
      created: false
    };
    prepared.mismatch = specMismatch(prepared.actualSpec, prepared.desiredSpec);
    const resumed = await this.aws.diskGrowth.resumePendingVolumeExpansion(prepared);
    if (resumed.mismatch && !await this.aws.preparation.hasAcceptedMismatch(resumed)) {
      throw new Error("The shared AWS worker is smaller than the configured requirement. Open Settings and choose what to do.");
    }
    return this.aws.preparation.ensurePreparedRunning(resumed);
  }

  noteRunStarted(runId: string): void {
    if (!runId || this.activeRunIds.has(runId)) {
      return;
    }
    this.activeRunIds.add(runId);
    this.deps.lifecycle.runStarted();
  }

  async noteRunEnded(runId: string): Promise<void> {
    if (!this.activeRunIds.delete(runId)) {
      return;
    }
    const credentials = await this.deps.settings.getAwsWorkerCredentials();
    const settings = await this.deps.settings.getPublicSettings();
    const handle = settings.cloudRuns.awsHandle;
    if (credentials && handle) {
      this.deps.lifecycle.runEnded(credentials, this.aws.ec2Access.toHandle(handle));
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
}
