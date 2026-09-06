/**
 * Machine install and upgrade contract (machines transport, work item 2:
 * "install/upgrade through doctor/setup, enrollment").
 *
 * SSH is used here and only here for a machine: installing the runtime,
 * upgrading it, and bootstrapping a project mirror once. Rule 1 of the signed
 * cutover accord ("relay only") governs everything else — no message, turn,
 * approval or Stop travels over SSH.
 *
 * These types are the whole surface the Settings > Machines UI needs: one
 * phase per visible step, one message per phase, and, when something fails,
 * what is true on the machine right now so the User can recover.
 */

/** How the desktop reaches a machine for setup only. Structurally compatible
 *  with the SSH helpers in `cloudRunWorkers.ts`, without depending on the
 *  worker-specific fields of `CloudRunWorkerSettings`. */
export interface MachineSshTarget {
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  hostKeyAlias?: string;
}

export type MachineInstallKind = "install" | "upgrade";

/** Visible steps, in the order they run. `ready`, `needs-attention` and
 *  `error` are terminal. */
export type MachineInstallPhase =
  | "preflight"
  | "bundle"
  | "transfer"
  | "dependencies"
  | "enroll"
  | "drain"
  | "activate"
  | "service"
  | "starting"
  | "verify"
  | "ready"
  | "needs-attention"
  | "error";

export const MACHINE_INSTALL_PHASE_ORDER: readonly MachineInstallPhase[] = [
  "preflight", "bundle", "transfer", "dependencies", "enroll",
  "drain", "activate", "service", "starting", "verify", "ready"
];

/** What is true on the machine after a failure. Every failure path names one
 *  of these, so the UI never has to guess whether a retry is safe. */
export type MachineInstallRecoveryKind =
  /** Nothing on the machine changed; the previous runtime is untouched. */
  | "nothing-changed"
  /** The new files are on the machine but the old version is still the one
   *  that runs; retrying resumes from the transfer. */
  | "old-runtime-still-installed"
  /** The upgrade was undone: the previous version is active again. */
  | "rolled-back"
  /** The new version is installed and active but did not connect. */
  | "new-runtime-installed-not-started"
  /** The old runtime or a provider process it owns is still alive; nothing
   *  was replaced, because two runtimes on one user-data directory would be
   *  two executors for the same participant session. */
  | "manual-drain-required";

export interface MachineInstallRecovery {
  kind: MachineInstallRecoveryKind;
  detail: string;
  /** Version that is active on the machine right now, when known. */
  activeVersion?: string;
  /** Processes that had to exit and did not (upgrade drain). */
  blockingPids?: number[];
  /** Last lines of the service log, when a start or connect failed. */
  serviceLog?: string;
}

export interface MachineInstallSnapshot {
  machineId: string;
  operationId: string;
  kind: MachineInstallKind;
  phase: MachineInstallPhase;
  message: string;
  updatedAt: string;
  /** Phases finished so far, for the UI checklist. */
  completed: MachineInstallPhase[];
  /** Provider sign-in happening on the machine itself. Never a credential
   *  copied from this desktop: the machine logs in natively and these are the
   *  verification URL and code the User approves. */
  authUrl?: string;
  authCode?: string;
  /** Conditions that do not stop the install (for example: the runtime will
   *  not survive logout because lingering could not be enabled). */
  warnings?: string[];
  error?: string;
  retryable?: boolean;
  recovery?: MachineInstallRecovery;
  installedVersion?: string;
  previousVersion?: string;
}

export interface MachineInstallRequest {
  machineId: string;
  /** Stable per attempt; a retry with the same id resumes the same record. */
  operationId: string;
  target: MachineSshTarget;
  /** Defaults to `~/accordagents-machine`. */
  installRoot?: string;
  /** Defaults to `~/.accordagents/machine`. Never touched by an upgrade. */
  userDataDir?: string;
  /** Defaults to `accordagents-machine`. */
  serviceName?: string;
  /** Name shown by the runtime in its hello; defaults to the machine record. */
  machineName?: string;
  /** The provider the members on this machine will use. Its sign-in is
   *  required and is performed on the machine. */
  requiredProvider?: "codex-cli" | "claude-code";
}

export interface MachineUpgradeRequest extends MachineInstallRequest {
  /** Installing an older bundle over a newer one opens this machine's user
   *  data with an old binary. Refused unless the User asked for it. */
  allowDowngrade?: boolean;
}

export interface MachineInstallResult {
  snapshot: MachineInstallSnapshot;
  record: MachineInstallRecord;
}

/** What the desktop remembers about an installed machine. Kept out of the
 *  settings snapshot sent to machines: it carries this desktop's SSH access. */
export interface MachineInstallRecord {
  machineId: string;
  target: MachineSshTarget;
  installRoot: string;
  userDataDir: string;
  serviceName: string;
  serviceScope: MachineServiceScope;
  installedVersion?: string;
  installedDigest?: string;
  installedAt?: string;
  lastOperation?: MachineInstallSnapshot;
}

export type MachineServiceScope = "system" | "user";

/** What the machine reports about itself before anything is changed. */
export interface MachineRuntimeProbe {
  nodeVersion?: string;
  hasSqlite3: boolean;
  hasGit: boolean;
  hasRsync: boolean;
  hasSystemd: boolean;
  hasPasswordlessSudo: boolean;
  installedVersion?: string;
  installedDigest?: string;
  activeRelease?: string;
  releases: string[];
  enrollmentPresent: boolean;
  serviceScope?: MachineServiceScope;
  serviceState?: string;
  /** Runtime, supervisor and provider processes belonging to this install. */
  runtimePids: number[];
  supervisorPids: number[];
  providerPids: number[];
}

export interface MachineDrainReport {
  drained: boolean;
  /** What the service manager reports after the drain attempt. */
  serviceState?: string;
  runtimePids: number[];
  supervisorPids: number[];
  providerPids: number[];
  /** Set when the service manager refused or timed out. */
  detail?: string;
}

export type MachineMirrorState = "absent" | "clean" | "dirty" | "unknown";

export interface MachineMirrorInspection {
  path: string;
  state: MachineMirrorState;
  /** Participant-created worktrees found beside the mirror. Never removed. */
  worktrees: string[];
  dirtyPaths: string[];
  branch?: string;
  head?: string;
}

export interface MachineMirrorBootstrapRequest {
  machineId: string;
  localPath: string;
}

export interface MachineMirrorBootstrapResult {
  inspection: MachineMirrorInspection;
  /** `created` only ever happens when nothing was there before. */
  action: "created" | "reused" | "refused";
  message: string;
}

export function machineInstallPhaseLabel(phase: MachineInstallPhase): string {
  switch (phase) {
    case "preflight": return "Checking the machine";
    case "bundle": return "Preparing the runtime";
    case "transfer": return "Copying the runtime";
    case "dependencies": return "Installing dependencies";
    case "enroll": return "Installing the enrollment";
    case "drain": return "Stopping the running version";
    case "activate": return "Switching version";
    case "service": return "Installing the service";
    case "starting": return "Starting the runtime";
    case "verify": return "Waiting for the machine to connect";
    case "ready": return "Ready";
    case "needs-attention": return "Needs attention";
    case "error": return "Failed";
  }
}
