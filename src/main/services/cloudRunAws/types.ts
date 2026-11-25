import type {
  AwsWorkerActualSpec, AwsWorkerHandleInfo, AwsWorkerSpec, AwsWorkerSpecMismatch, CloudRunWorkerSettings
} from "../../../shared/types";
import type { AwsWorkerCredentials } from "../awsWorkerProvisioning";
import type { WorkerHostKey } from "../awsWorkerHostKeys";
import type { AwsWorkerInstanceInfo, Ec2Client } from "../awsWorkerLifecycle";
import { deleteGeneratedAwsWorkerKeyMaterial, generateAwsWorkerKeyMaterial } from "../awsEc2Client";
import { AwsWorkerAccess } from "../awsWorkerAccess";
import type { SettingsService } from "../settings";
import type { MachineRecoveryFailure } from "../machineRecovery";
import type { RemoteRunWorkerTarget, RemoteWorkerStopAuthorization, RemoteWorkerStopLease } from "../remoteWorkerTarget";

export type StoredAwsWorkerOperation = Awaited<ReturnType<SettingsService["getAwsWorkerOperation"]>>;

/** What a look that found the instance gone came to. */
export type ForgetOutcome = { kind: "forgotten" } | { kind: "kept" } | { kind: "changed" } | { kind: "pending" };

export type ForgetResult = { forgotten: boolean; machineIds: string[]; error?: string };

/** Why an instance's machines leave: the User deleted it, she replaced it
 *  with a new one, or the app found it gone by itself. */
export type ForgetReason = "deleted" | "replaced" | "gone";

export interface CloudRunAwsServiceOptions {
  /** This desktop's version: an automatic update of it that already failed
   *  on a machine is not repeated by itself. */
  appVersion?: string;
  /** Whether the machine's runtime is connected to this desktop now;
   *  undefined while that is not known yet (the link is still starting). */
  machineConnected?: (machineId: string) => boolean | undefined;
  /** Why the machine's program is still not back, after the app tried. */
  machineRecoveryFailure?: (machineId: string) => MachineRecoveryFailure | undefined;
  createEc2Client?: (credentials: AwsWorkerCredentials) => Ec2Client;
  generateKeyMaterial?: typeof generateAwsWorkerKeyMaterial;
  deleteKeyMaterial?: typeof deleteGeneratedAwsWorkerKeyMaterial;
  privateKeyPathForKeyName?: (keyName: string) => string;
  currentPublicIp?: () => Promise<string>;
  /** Tests: a new machine's host key is made and pinned by these instead. */
  workerHostKey?: { generate: (launchToken?: string) => Promise<WorkerHostKey>; pin: (alias: string, publicKey: string, launchToken?: string) => Promise<void> };
  workerAccess?: AwsWorkerAccess;
  logger?: (event: string, payload: Record<string, unknown>) => void;
  /** Removes a machine from this desktop the way Settings → Remove does. An
   *  instance that can never come back takes the machines on it along. */
  removeMachine?: (machineId: string) => Promise<void>;
  /** Resolves once the desktop's machine link has started (or could not):
   *  a machine is removed only after the link knows its machines, so a look
   *  in the first moments after start does not race the link's own start. */
  machinesReady?: () => Promise<void>;
  now?: () => number;
  idleStopMs?: number;
  idleStopRetryMs?: number;
  automaticStopGate?: {
    authorizeAutomaticWorkerStop(worker: RemoteRunWorkerTarget, ownerId: string): Promise<RemoteWorkerStopAuthorization>;
    renewAutomaticWorkerStopLease(worker: RemoteRunWorkerTarget, lease: RemoteWorkerStopLease): Promise<RemoteWorkerStopLease>;
    releaseAutomaticWorkerStopLease(worker: RemoteRunWorkerTarget, lease: RemoteWorkerStopLease): Promise<void>;
  };
  wait?: (delayMs: number) => Promise<void>;
  sshExec?: (worker: CloudRunWorkerSettings, command: string, timeoutMs: number) => Promise<void>;
  /** Whose Terminal the setup command is spelled for. */
  platform?: NodeJS.Platform;
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

export interface PrepareAwsWorkerRequest {
  blob?: string;
  instanceType?: string;
  rootVolumeSizeGb?: number;
  operationId: string;
  clientToken?: string;
  expectedInstanceId?: string;
}
