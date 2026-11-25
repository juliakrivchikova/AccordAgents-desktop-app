import type { SettingsService } from "../../settings";
import { handleFromInfo } from "../access/handles";
import { actualSpecFrom, growRootFilesystemCommand, specMismatch } from "./workerSpec";
import type { PreparedAwsWorker } from "../types";
import type { AwsModules } from "../modules";
import type { AwsDependencies } from "../dependencies";

/** Grows the machine's disk. */
export class DiskGrowth {
  constructor(
    private readonly aws: Pick<AwsModules, "ec2Access" | "preparation">,
    private readonly deps: Pick<AwsDependencies, "settings" | "sshExec" | "wait">
  ) {}

  async growDisk(prepared: PreparedAwsWorker): Promise<PreparedAwsWorker> {
    return this.finishVolumeExpansion(prepared);
  }

  async resumePendingVolumeExpansion(prepared: PreparedAwsWorker): Promise<PreparedAwsWorker> {
    const marker = await (this.deps.settings as SettingsService & {
      getAwsWorkerVolumeExpansion?: () => Promise<{ instanceId: string; volumeId: string; targetSizeGb: number } | undefined>;
    }).getAwsWorkerVolumeExpansion?.();
    if (!marker) return prepared;
    if (marker.instanceId !== prepared.info.instanceId) {
      await (this.deps.settings as SettingsService & { saveAwsWorkerVolumeExpansion?: (value: undefined) => Promise<void> })
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
    const client = this.aws.ec2Access.clientForRegion(prepared.credentials, prepared.handle.region);
    const targetSizeGb = existingMarker?.targetSizeGb ?? prepared.desiredSpec.rootVolumeSizeGb;
    await (this.deps.settings as SettingsService & {
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
        await this.deps.wait(5_000);
      }
      if (!expandable) throw new Error("Timed out waiting for the enlarged AWS volume to become usable.");
    }
    const worker = await this.aws.preparation.ensurePreparedRunning(prepared);
    await this.deps.sshExec(worker, growRootFilesystemCommand(targetSizeGb), 5 * 60_000);
    const refreshed = await client.describeInstance(prepared.info.instanceId) ?? prepared.info;
    const handle = handleFromInfo(refreshed, {
      keyName: prepared.handle.accessKeyName ?? prepared.handle.keyName,
      privateKeyPath: this.aws.ec2Access.privateKeyPath(prepared.handle),
      securityGroupId: prepared.handle.securityGroupId,
      created: !prepared.handle.adopted
    });
    await this.deps.settings.saveAwsWorkerHandle(handle);
    await (this.deps.settings as SettingsService & { saveAwsWorkerVolumeExpansion?: (value: undefined) => Promise<void> })
      .saveAwsWorkerVolumeExpansion?.(undefined);
    return {
      ...prepared,
      info: refreshed,
      handle,
      actualSpec: actualSpecFrom(refreshed, prepared.handle),
      mismatch: specMismatch(actualSpecFrom(refreshed, prepared.handle), prepared.desiredSpec)
    };
  }
}
