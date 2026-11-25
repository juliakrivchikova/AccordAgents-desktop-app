import type { AwsWorkerActualSpec, SetAwsAutoStopRequest, AwsWorkerStatus, CloudRunWorkerSettings } from "../../shared/types";
import type { AwsMachinePowerConfig } from "../../shared/machinePower";
import type { MachineInstallRecord } from "../../shared/machineInstall";
import type { PrepareAwsWorkerRequest, PreparedAwsWorker } from "./cloudRunAws/types";
import { randomUUID } from "node:crypto";
import { createAwsEc2Client, generateAwsWorkerKeyMaterial, resolveAwsWorkerPrivateKeyPath } from "./awsEc2Client";
import { AwsWorkerAccess } from "./awsWorkerAccess";
import type { SettingsService } from "./settings";
import { defaultSshExec } from "./cloudRunAws/access/sshExec";
import { createWorkerLifecycle } from "./cloudRunAws/access/workerLifecycle";
import type { CloudRunAwsServiceOptions } from "./cloudRunAws/types";
import { createAwsModules, type AwsModules } from "./cloudRunAws/modules";

export { AWS_INSTANCE_GONE_NOTICE } from "./cloudRunAws/constants";
export type { CloudRunAwsServiceOptions, PreparedAwsWorker } from "./cloudRunAws/types";

/** The User's own AWS machine. The work is done by the parts in ./cloudRunAws. */
export class CloudRunAwsService {
  private readonly modules: AwsModules;

  constructor(settings: SettingsService, options: CloudRunAwsServiceOptions = {}) {
    const createEc2Client = options.createEc2Client ?? createAwsEc2Client;
    const generateKeyMaterial = options.generateKeyMaterial ?? generateAwsWorkerKeyMaterial;
    const automaticStopOwnerId = randomUUID();
    this.modules = createAwsModules({
      settings,
      appVersion: options.appVersion,
      machineConnected: options.machineConnected,
      machineRecoveryFailure: options.machineRecoveryFailure,
      logger: options.logger,
      removeMachine: options.removeMachine,
      machinesReady: options.machinesReady,
      now: options.now ?? (() => Date.now()),
      createEc2Client,
      generateKeyMaterial,
      automaticStopOwnerId,
      lifecycle: createWorkerLifecycle({ settings, options, createEc2Client, generateKeyMaterial, automaticStopOwnerId, parts: () => this.modules }),
      workerAccess: options.workerAccess ?? new AwsWorkerAccess(),
      privateKeyPathForKeyName: options.privateKeyPathForKeyName ?? resolveAwsWorkerPrivateKeyPath,
      wait: options.wait ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))),
      sshExec: options.sshExec ?? defaultSshExec,
      platform: options.platform ?? process.platform
    });
  }

  bootstrapCommand(region: string, recoveryOperationId?: string): Promise<string> {
    return this.modules.bootstrap.bootstrapCommand(region, recoveryOperationId);
  }

  /** The phone's start key for this app's instance, as a paired phone uses it,
   *  with the machine it wakes; undefined when the setup command has not made
   *  one, or made it for another region. It only ever leaves this desktop
   *  inside a pairing link. */
  deviceWakePower(): Promise<{ machineId?: string; config: AwsMachinePowerConfig } | undefined> {
    return this.modules.autoStop.deviceWakePower();
  }

  /** Whether this desktop's cloud program is on that instance and has
   *  connected at least once: one installed that never reached this desktop
   *  is not set up yet. */
  programInstalledOn(instanceId: string): Promise<boolean> {
    return this.modules.installedPrograms.programInstalledOn(instanceId);
  }

  // Compatibility entry point for older renderer callers. The new UI calls
  // AwsWorkerSetupService, which continues through running + doctor setup.
  connectWorker(blob: string, instanceType?: string, rootVolumeSizeGb?: number): Promise<AwsWorkerStatus> {
    return this.modules.preparation.connectWorker(blob, instanceType, rootVolumeSizeGb);
  }

  prepareWorker(request: PrepareAwsWorkerRequest): Promise<PreparedAwsWorker> {
    return this.modules.preparation.prepareWorker(request);
  }

  /** Keeping a size cancels the new request, not a reason to provision, enroll
   *  keys or resume a previously interrupted disk expansion. */
  keepCurrentSize(expectedInstanceId: string): Promise<AwsWorkerActualSpec> {
    return this.modules.preparation.keepCurrentSize(expectedInstanceId);
  }

  acceptMismatch(prepared: PreparedAwsWorker): Promise<void> {
    return this.modules.preparation.acceptMismatch(prepared);
  }

  hasAcceptedMismatch(prepared: PreparedAwsWorker): Promise<boolean> {
    return this.modules.preparation.hasAcceptedMismatch(prepared);
  }

  growDisk(prepared: PreparedAwsWorker): Promise<PreparedAwsWorker> {
    return this.modules.diskGrowth.growDisk(prepared);
  }

  resumePendingVolumeExpansion(prepared: PreparedAwsWorker): Promise<PreparedAwsWorker> {
    return this.modules.diskGrowth.resumePendingVolumeExpansion(prepared);
  }

  recreateWorker(prepared: PreparedAwsWorker, expectedInstanceId: string, operationId: string): Promise<PreparedAwsWorker> {
    return this.modules.preparation.recreateWorker(prepared, expectedInstanceId, operationId);
  }

  ensurePreparedRunning(prepared: Pick<PreparedAwsWorker, "credentials" | "handle">,
    options: { start?: boolean } = {}): Promise<CloudRunWorkerSettings> {
    return this.modules.preparation.ensurePreparedRunning(prepared, options);
  }

  status(): Promise<AwsWorkerStatus> {
    return this.modules.workerStatus.status();
  }

  /** At start-up, once the desktop's machines are up: what a removal left
   *  unfinished is finished, then one look whether AWS still has this app's
   *  instance; one it terminated or no longer has is forgotten with the
   *  machines on it. An AWS error changes nothing. */
  forgetInstanceIfGone(): Promise<boolean> {
    return this.modules.goneInstances.forgetInstanceIfGone();
  }

  /** The stop key for a machine that runs on this app's instance, or
   *  undefined when the machine is elsewhere or no stop key was set up. The
   *  key only ever covers the instance's own region. */
  machinePowerFor(machineId: string): Promise<AwsMachinePowerConfig | undefined> {
    return this.modules.autoStop.machinePowerFor(machineId);
  }

  /** When the instance last started, while it is running; 0 when it runs
   *  but AWS does not say since when. Reads only. */
  instanceRunningSince(): Promise<number | undefined> {
    return this.modules.workerStatus.instanceRunningSince();
  }

  /** Saves the stop key from a pasted setup result. The result must carry
   *  one: a result from an older command would turn the switch on with
   *  nothing that can stop the instance. */
  adoptAutoStopKey(blob: string): Promise<void> {
    return this.modules.autoStop.adoptAutoStopKey(blob);
  }

  /** The switch. On with a pasted result saves its stop key first; on
   *  without one needs a usable key already saved. Off keeps the key. */
  setAutoStop(request: SetAwsAutoStopRequest): Promise<{ keyAdded: boolean }> {
    return this.modules.autoStop.setAutoStop(request);
  }

  /** The install record of the machine on this instance that holds, or is
   *  to take, the stop key: the one the Automatic stop row's fix acts on. */
  autoStopMachineRecord(): Promise<MachineInstallRecord | undefined> {
    return this.modules.autoStop.autoStopMachineRecord();
  }

  /** Where this desktop's program and its data live on the instance, as
   *  its setup recorded them; undefined before the first setup. */
  programFoldersOnInstance(): Promise<{ installRoot: string; userDataDir?: string } | undefined> {
    return this.modules.installedPrograms.programFoldersOnInstance();
  }

  /** This desktop's cloud program on the instance, as its setup recorded
   *  it: the machine whose project copies Settings manages. */
  programRecordOnInstance(): Promise<MachineInstallRecord | undefined> {
    return this.modules.installedPrograms.programRecordOnInstance();
  }

  /** The install record of one machine on this instance. */
  machineRecordOnInstance(machineId: string): Promise<MachineInstallRecord | undefined> {
    return this.modules.installedPrograms.machineRecordOnInstance(machineId);
  }

  /** A stop key for the instance's own region is saved. */
  hasAutoStopKey(): Promise<boolean> {
    return this.modules.autoStop.hasAutoStopKey();
  }

  /** The switch reads on: a usable key, and the User left it on. */
  autoStopSwitchedOn(): Promise<boolean> {
    return this.modules.autoStop.autoStopSwitchedOn();
  }

  /** The status read with AWS's refusal left intact: a caller that must tell a
   *  revoked permission from a network failure needs the raw error. Reads only. */
  probeAccess(): Promise<AwsWorkerStatus> {
    return this.modules.bootstrap.probeAccess();
  }

  /** Replace the saved credentials with pasted ones once they prove, read-only,
   *  that they can see the existing instance. Nothing else is touched. */
  adoptCredentials(blob: string): Promise<void> {
    return this.modules.bootstrap.adoptCredentials(blob);
  }

  /** Settings → AWS → Delete: the instance is terminated (or found already
   *  gone), what the app made for it is removed, and so are the machines on
   *  it and the AWS connection. */
  deleteWorker(): Promise<AwsWorkerStatus> {
    return this.modules.instanceRemoval.deleteWorker();
  }

  stopWorker(): Promise<AwsWorkerStatus> {
    return this.modules.instanceRemoval.stopWorker();
  }

  /** With `start: false`, the way to a running instance only, for looking
   *  at or setting up the program on it: this device's SSH access is renewed,
   *  as its address may have changed, and nothing is started, grown or held
   *  to the configured size. Bringing a program back must never undo a stop. */
  ensureExistingWorkerForRun(instanceId: string, options: { start?: boolean } = {}): Promise<CloudRunWorkerSettings> {
    return this.modules.workerRuns.ensureExistingWorkerForRun(instanceId, options);
  }

  /** Inspecting an instance (its setup, its disk) must never wake or prepare it. */
  workerForInspection(): Promise<CloudRunWorkerSettings> {
    return this.modules.workerStatus.workerForInspection();
  }

  ensureWorkerForRun(expectedInstanceId?: string): Promise<CloudRunWorkerSettings> {
    return this.modules.workerRuns.ensureWorkerForRun(expectedInstanceId);
  }

  noteRunStarted(runId: string): void {
    this.modules.workerRuns.noteRunStarted(runId);
  }

  noteRunEnded(runId: string): Promise<void> {
    return this.modules.workerRuns.noteRunEnded(runId);
  }

  withRunReference<T>(runId: string, action: () => Promise<T>): Promise<T> {
    return this.modules.workerRuns.withRunReference(runId, action);
  }
}
