import type { CloudRunWorkerDoctorReport } from "./cloudRuns";

export interface AwsWorkerHandleInfo {
  instanceId: string;
  securityGroupId: string;
  // keyName is retained for stored-settings compatibility and mirrors the
  // device-local access key name for new handles.
  keyName: string;
  accessKeyName?: string;
  launchKeyName?: string;
  region: string;
  instanceType: string;
  rootVolumeSizeGb?: number;
  rootVolumeId?: string;
  availabilityZone?: string;
  vCpu?: number;
  memoryMiB?: number;
  adopted?: boolean;
  // The public address the instance had when it was last seen running. An AWS
  // box gets a new one on every stop/start, so stored run/session handles go
  // stale; this is the one place that tracks where the machine is NOW.
  lastKnownHost?: string;
  createdAt: string;
}

export interface AwsWorkerSpec {
  instanceType: string;
  rootVolumeSizeGb: number;
  vCpu?: number;
  memoryMiB?: number;
}

export interface AwsWorkerActualSpec extends AwsWorkerSpec {
  instanceId: string;
  region: string;
  availabilityZone?: string;
  rootVolumeId?: string;
}

export interface AwsWorkerSpecMismatch {
  instanceId: string;
  actual: AwsWorkerActualSpec;
  desired: AwsWorkerSpec;
  diskTooSmall: boolean;
  computeTooSmall: boolean;
}

export type AwsWorkerLifecycleState =
  | "absent"
  | "pending"
  | "running"
  | "stopping"
  | "stopped"
  | "terminated";

export interface AwsWorkerStatus {
  configured: boolean;
  handle?: AwsWorkerHandleInfo;
  state?: AwsWorkerLifecycleState;
  publicIp?: string;
  message?: string;
  /** Failure of the requested mutation, independent of the observed EC2 state. */
  actionError?: string;
  /** Lines the AWS page tells the User about what the app did by itself,
   *  each only while it holds: the instance AWS no longer has was removed
   *  with its machine; an old cloud machine could not be removed from this
   *  computer yet; or the app could not confirm an old one is gone. */
  notices?: string[];
  persistentStorage?: {
    rootVolumeBackedByEbs: boolean;
    rootDeviceName?: string;
    rootVolumeId?: string;
  };
  actualSpec?: AwsWorkerActualSpec;
  specMismatch?: AwsWorkerSpecMismatch;
  operation?: AwsWorkerOperationSnapshot;
  /** The automatic-stop switch and, while it is on, anything that keeps the
   *  instance from stopping by itself. Absent when it could not be read. */
  autoStop?: AwsWorkerAutoStop;
  /** The program on the running instance is still not back although the
   *  app tried to bring it back itself, in plain words; shown in the Cloud
   *  program section's Connection row. */
  machineProblem?: string;
}

/** Automatic stop as Settings → AWS shows it: one switch, and, when the
 *  switch is on but the instance will not stop by itself, why. */
export interface AwsWorkerAutoStop {
  /** The switch: a stop key is saved and the User left automatic stop on. */
  enabled: boolean;
  /** Turning the switch on first needs the setup command: there is no stop key. */
  needsSetup: boolean;
  /** Shown in the Automatic stop row. Agents working is not a problem. */
  problem?: AwsWorkerAutoStopProblem;
  /** Switched-on scheduled scripts on the instance: they keep it running so
   *  each run finds it awake. */
  keptOnByScripts?: number;
}

export interface AwsWorkerAutoStopProblem {
  /** What is wrong, in plain words. */
  message: string;
  /** What fixes it: the setup command again, or setting up the program on
   *  the cloud machine again. Without one, the message says what to do. */
  action?: "set-up-again" | "reconnect";
  actionLabel?: string;
  /** The machine the fix acts on. */
  machineId?: string;
}

/** The automatic-stop switch. Turning it on with a pasted setup result also
 *  saves the result's stop key; without one, a saved key must exist. */
export interface SetAwsAutoStopRequest {
  enabled: boolean;
  blob?: string;
}

export interface ConnectAwsWorkerRequest {
  blob: string;
  instanceType?: string;
  rootVolumeSizeGb?: number;
}

export type AwsWorkerStartPhase =
  | "starting"
  | "waiting-running"
  | "setting-up"
  | "ready"
  | "needs-decision"
  | "error";

export type AwsWorkerSpecResolution = "keep" | "grow-disk" | "recreate";

/** The parts of setting the AWS instance up, in the order they run. */
export type AwsSetupStepId = "instance" | "tools" | "sign-in-codex" | "sign-in-claude" | "program";

/** One part of the setup as the User sees it: what it is doing now, or how
 *  it ended. Kept with the operation, so a reopened page shows the same. */
export interface AwsSetupStep {
  id: AwsSetupStepId;
  state: "pending" | "current" | "done" | "skipped" | "failed";
  detail?: string;
  /** When the step began, so a long one visibly keeps moving. */
  startedAt?: string;
}

export interface AwsWorkerStartRequest {
  operationId: string;
  /** "check" is read-only: it probes AWS access and classifies a refusal
   *  into recovery steps; it never creates, starts or sets anything up. */
  intent?: "setup" | "resize" | "check";
  clientToken?: string;
  blob?: string;
  instanceType?: string;
  rootVolumeSizeGb?: number;
  resolution?: AwsWorkerSpecResolution;
  expectedInstanceId?: string;
  expectedDesiredSpec?: AwsWorkerSpec;
  expectedActualSpec?: AwsWorkerSpec;
}

export interface AwsWorkerOperationSnapshot {
  operationId: string;
  intent?: "setup" | "resize" | "check";
  clientToken?: string;
  phase: AwsWorkerStartPhase;
  message: string;
  updatedAt: string;
  retryable?: boolean;
  remediation?: "refresh-aws-authorization";
  error?: string;
  authUrl?: string;
  authCode?: string;
  authProvider?: "codex-cli" | "claude-code";
  authRequestId?: string;
  /** Present for a start or setup: every step with its state. */
  setupSteps?: AwsSetupStep[];
  status?: AwsWorkerStatus;
  specMismatch?: AwsWorkerSpecMismatch;
  missingAwsActions?: string[];
  awsPrincipalArn?: string;
  awsPrincipalUserName?: string;
}

export interface AwsWorkerVolumeExpansion {
  instanceId: string;
  volumeId: string;
  targetSizeGb: number;
  updatedAt: string;
}

export interface AwsWorkerStartResult {
  operation: AwsWorkerOperationSnapshot;
  status: AwsWorkerStatus;
  report?: CloudRunWorkerDoctorReport;
}
