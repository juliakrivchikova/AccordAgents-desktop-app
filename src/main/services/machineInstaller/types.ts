import type { MachineMaintenanceTarget } from "../machineMaintenanceCommand";
import type { CloudRunWorkerDoctorReport, CloudRunWorkerSettings, CloudRunWorkerSetupProgress } from "../../../shared/types";
import type { AwsMachinePowerConfig } from "../../../shared/machinePower";
import type { MachineInstallRecord, MachineRuntimePayloadSource, MachineSshTarget } from "../../../shared/machineInstall";
import type { RemoteMirrorSyncRunner } from "../remoteMirrorSync";

export interface MachineSshExecRequest {
  target: MachineSshTarget;
  script: string;
  timeoutMs: number;
  /** Written to the remote command's stdin. Carries the enrollment package,
   *  so it is never logged and never placed on a command line. */
  input?: string;
  onStdout?: (chunk: string) => void;
  signal?: AbortSignal;
  maintenance?: MachineMaintenanceTarget;
}

export type MachineSshExec = (request: MachineSshExecRequest) => Promise<string>;

export type MachineBundleUpload = (request: {
  target: MachineSshTarget;
  localDir: string;
  remoteDir: string;
  timeoutMs: number;
  maintenance?: MachineMaintenanceTarget;
}) => Promise<void>;

/** The slice of `SettingsService` this service needs. */
export interface MachineInstallStore {
  getMachineInstall(machineId: string): Promise<MachineInstallRecord | undefined>;
  saveMachineInstall(record: MachineInstallRecord): Promise<void>;
  listMachineInstalls(): Promise<MachineInstallRecord[]>;
}

/** The doctor already knows how to bring a Linux box to a state where the
 *  provider CLIs run and are signed in ON that box. Reused as-is so a machine
 *  and a worker cannot drift apart, and so provider credentials are never
 *  copied from this desktop: `setup` performs a native device-auth login. */
export interface MachineDoctor {
  diagnose(settings: CloudRunWorkerSettings, options?: { requiredProviderKinds?: ("codex-cli" | "claude-code")[]; maintenance?: MachineMaintenanceTarget; profileHome?: string }): Promise<CloudRunWorkerDoctorReport>;
  setup(
    settings: CloudRunWorkerSettings,
    onProgress?: (progress: CloudRunWorkerSetupProgress) => void,
    options?: { requiredProviderKinds?: ("codex-cli" | "claude-code")[]; maintenance?: MachineMaintenanceTarget; profileHome?: string }
  ): Promise<CloudRunWorkerDoctorReport>;
}

export interface MachineRuntimePayloadLocation {
  dir: string;
  source: MachineRuntimePayloadSource;
  /** The desktop's own version, when it must match the payload's. */
  expectVersion?: string;
}

export interface MachineBundle {
  dir: string;
  version: string;
  digest: string;
  /** What the payload contains, for the Machines screen. */
  files: number;
  bytes: number;
}

export interface MachineInstallerOptions {
  store: MachineInstallStore;
  doctor: MachineDoctor;
  /** Enrollment package for a machine, as Settings > Machines mints it. */
  getEnrollmentJson: (machineId: string) => Promise<string>;
  restoreEnrollment?: (machineId: string, requestedJson: string, installedJson: string, installedMachineId?: string) => Promise<string | void>;
  /** Resolves on the next hello from the machine that arrives AFTER the call
   *  started, reporting `expectAppVersion` when one is given. A link that is
   *  merely open does not count: after a restart it can still be the old
   *  process. */
  waitForConnected: (machineId: string, timeoutMs: number, expectAppVersion?: string) => Promise<boolean>;
  /** Where the runtime payload lives, resolved per operation so rebuilding it
   *  does not need an app restart, and so a packaged app can point at its own
   *  resources while a checkout points at `dist/machine`. */
  payload: MachineRuntimePayloadLocation | (() => MachineRuntimePayloadLocation);
  machineName?: (machineId: string) => Promise<string | undefined>;
  prepareProfile?: (record: MachineInstallRecord) => Promise<void>;
  /** Asked right before the drain, minutes after the preflight: a reason not
   *  to stop the runtime now (a member started work on the machine while the
   *  new release was being staged). The upgrade then ends with
   *  `needs-attention` / `machine-busy`, nothing replaced, and the staged
   *  files wait for the next attempt. */
  beforeDrain?: (record: MachineInstallRecord, operationId: string, purpose: "update" | "key") => Promise<string | undefined>;
  /** The AWS stop key for a machine that runs on this app's AWS instance, or
   *  undefined when it does not (or no stop key has been set up). Handed to
   *  the machine while its runtime is drained, so it can stop the instance
   *  itself after three idle hours even when this desktop is not running. */
  machinePower?: (machineId: string) => Promise<AwsMachinePowerConfig | undefined>;
  sshExec?: MachineSshExec;
  uploadBundle?: MachineBundleUpload;
  /** Records the identity the installed runtime reads for itself on this
   *  desktop: from then on the User's server admits it (the roster names it)
   *  and its settings can be sealed for it, before it first connects. */
  adoptIdentity?: (machineId: string, identity: { originId: string; publicKeyDerBase64: string }) => Promise<void>;
  /** Whether this desktop knows the machine's identity already (an update of
   *  a machine set up before then reads nothing). */
  identityKnown?: (machineId: string) => Promise<boolean>;
  mirrorSync?: RemoteMirrorSyncRunner;
  now?: () => Date;
  logger?: (event: string, payload: Record<string, unknown>) => void;
}
