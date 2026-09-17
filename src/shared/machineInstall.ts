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

/** Provider state stays beside its environment even when the desktop uses
 * custom native configuration paths. These are host paths, not credentials. */
export function machineProfileVariables(profileHome: string): Record<string, string> {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(profileHome) || profileHome.split("/").includes("..")) {
    throw new Error("Invalid machine profile directory.");
  }
  return {
    HOME: profileHome, CODEX_HOME: `${profileHome}/.codex`, CLAUDE_CONFIG_DIR: `${profileHome}/.claude`,
    XDG_CONFIG_HOME: `${profileHome}/.config`, XDG_DATA_HOME: `${profileHome}/.local/share`,
    XDG_CACHE_HOME: `${profileHome}/.cache`
  };
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
  | "manual-drain-required"
  /** The machine started work while the new release was being staged, so the
   *  runtime was not stopped; the staged files wait for the next attempt. */
  | "machine-busy";

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
  authProvider?: "codex-cli" | "claude-code";
  authRequestId?: string;
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
  /** Keep provider profiles in this installation's own home directory. */
  isolatedProfile?: boolean;
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
  /** Absent on legacy installs, whose existing CLI sessions stay in place. */
  profileHome?: string;
  /** Persist the choice even when the first SSH probe fails before resolving HOME. */
  isolatedProfile?: boolean;
  installedVersion?: string;
  installedDigest?: string;
  installedAt?: string;
  /** Desktop project path to this machine's own checkout; never a write-back. */
  projects?: Record<string, string>;
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

/** Where the runtime payload the desktop would install comes from. */
export type MachineRuntimePayloadSource = "override" | "packaged" | "checkout";

/** What the desktop would install, or why it cannot. Shown in Settings so the
 *  User can see the machine payload is present and which version it is before
 *  starting a setup that would otherwise fail halfway. */
export type MachineRuntimePayloadInfo =
  | {
    ok: true;
    source: MachineRuntimePayloadSource;
    dir: string;
    version: string;
    digest: string;
    files: number;
    bytes: number;
  }
  | {
    ok: false;
    source: MachineRuntimePayloadSource;
    dir: string;
    message: string;
  };

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

export type MachineMirrorState = "absent" | "directory" | "clean" | "dirty" | "unknown";

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

/** Semver precedence, because this app ships betas: `1.10.4-beta.2` must be
 *  older than `1.10.4`, not newer. Getting this backwards would make the
 *  version fence refuse the one upgrade a beta tester needs most. */
export function compareVersions(a: string, b: string): number {
  const left = splitVersion(a);
  const right = splitVersion(b);
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] < right.core[index] ? -1 : 1;
  }
  if (!left.pre.length && !right.pre.length) return 0;
  // A version with a prerelease tag has lower precedence than one without.
  if (!left.pre.length) return 1;
  if (!right.pre.length) return -1;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const x = left.pre[index];
    const y = right.pre[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const numeric = typeof x === "number" && typeof y === "number";
    if (numeric) {
      if (x !== y) return x < y ? -1 : 1;
      continue;
    }
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function splitVersion(value: string): { core: [number, number, number]; pre: Array<string | number> } {
  const [head, ...rest] = value.trim().replace(/^v/, "").split("+")[0].split("-");
  const core = head.split(".").map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isInteger(parsed) ? parsed : 0;
  });
  const pre = rest.join("-").split(".").filter(Boolean).map((part) => {
    const parsed = Number.parseInt(part, 10);
    return /^\d+$/.test(part) && Number.isInteger(parsed) ? parsed : part;
  });
  return { core: [core[0] ?? 0, core[1] ?? 0, core[2] ?? 0], pre };
}

/** A setup or update that has ended, one way or another. */
export function isMachineInstallTerminalPhase(phase: MachineInstallPhase): boolean {
  return phase === "ready" || phase === "error" || phase === "needs-attention";
}

/** Operation id prefix of the automatic upgrade this desktop version runs on a
 *  machine; the bare prefix is the "waiting for idle" notice, a suffixed id is
 *  an attempt. */
export function machineAutoUpgradeOperationPrefix(desktopVersion: string): string {
  return `auto-upgrade-${desktopVersion}`;
}

export function isMachineAutoUpgradeOperation(operationId: string): boolean {
  return operationId.startsWith("auto-upgrade-");
}

export interface MachineRuntimeStatus {
  state: "updating" | "failed" | "pending";
  text: string;
}

/**
 * What a machine's runtime is doing relative to this desktop, for its row in
 * Settings → Machines: an update in progress (automatic or from the button),
 * the last update's failure, or an update the desktop still owes the machine.
 * Nothing when the runtime is current, so a healthy row stays quiet.
 *
 * `live` is the latest progress snapshot streamed for the machine; the
 * automatic upgrade's "waiting for idle" notice is only believed while the
 * machine is connected and behind, because the notice is not withdrawn when
 * the machine goes away or turns out to be current.
 */
export function machineRuntimeStatus(input: {
  install: MachineInstallRecord | undefined;
  live: MachineInstallSnapshot | undefined;
  connected: boolean;
  runningVersion: string | undefined;
  desktopVersion: string | undefined;
}): MachineRuntimeStatus | undefined {
  const { install, live, connected, desktopVersion } = input;
  const running = input.runningVersion ?? install?.installedVersion;
  const behind = Boolean(install?.installedVersion && running && desktopVersion && compareVersions(desktopVersion, running) > 0);
  const waitingNotice = Boolean(live && desktopVersion && live.operationId === machineAutoUpgradeOperationPrefix(desktopVersion));
  if (live && !isMachineInstallTerminalPhase(live.phase) && (!waitingNotice || (connected && behind))) {
    return { state: "updating", text: live.message };
  }
  const last = install?.lastOperation;
  if (last && !isMachineInstallTerminalPhase(last.phase)) {
    // Settings opened while an update was already running: its progress is
    // on the record until the next snapshot arrives.
    return { state: "updating", text: last.message };
  }
  if (live?.phase === "error" && waitingNotice) {
    // The automatic upgrade could not be attempted at all (no payload).
    return { state: "failed", text: live.error ?? live.message };
  }
  if (last && last.recovery?.kind === "machine-busy" && behind && desktopVersion) {
    // Not a failure: the update stepped back for a member's work and waits.
    return { state: "pending", text: `Runtime update to ${desktopVersion} waits for the machine to be idle; a member started work while the update was being staged.` };
  }
  if (last && (last.phase === "error" || last.phase === "needs-attention")) {
    return { state: "failed", text: `${last.kind === "upgrade" ? "Runtime update" : "Runtime setup"} failed: ${last.error ?? last.message}` };
  }
  if (behind && desktopVersion) {
    return { state: "pending", text: `Runtime update to ${desktopVersion} pending; it starts when the machine is connected and idle.` };
  }
  return undefined;
}
