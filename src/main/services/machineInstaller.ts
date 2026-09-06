/**
 * Installs, upgrades and supervises the headless machine runtime on a Linux
 * computer, and bootstraps a project mirror there once.
 *
 * This is the only place in the app that opens an SSH connection to a machine
 * for setup, and it is setup only: Rule 1 of the signed cutover accord keeps
 * every message, turn, approval and Stop on the relay. Nothing here is reached
 * from a chat turn; `scripts/machine-install-transport-guard.test.mjs` fails
 * the build if a messaging module ever imports it.
 *
 * The order of an upgrade is deliberate:
 *   stage the new release → drain and PROVE the old runtime and its provider
 *   processes are gone → flip → start → wait for the machine to connect →
 *   roll back if it does not.
 * Staging first keeps the machine down for seconds rather than minutes;
 * proving the drain before the flip is what stops two runtimes from owning one
 * participant session. A drain that cannot be proven refuses the upgrade
 * instead of forcing it, because the alternative is a duplicate executor.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CloudRunWorkerDoctorReport, CloudRunWorkerSettings, CloudRunWorkerSetupProgress } from "../../shared/types";
import type {
  MachineInstallKind,
  MachineInstallPhase,
  MachineInstallRecord,
  MachineInstallRecovery,
  MachineInstallRequest,
  MachineInstallResult,
  MachineInstallSnapshot,
  MachineMirrorBootstrapRequest,
  MachineMirrorBootstrapResult,
  MachineMirrorInspection,
  MachineServiceScope,
  MachineSshTarget,
  MachineUpgradeRequest
} from "../../shared/machineInstall";
import { buildCloudRunSshTarget, cloudRunSshOptionArgs, shellQuotePosix } from "./cloudRunWorkers";
import { runCommand } from "./command";
import {
  DEFAULT_MACHINE_INSTALL_DIRNAME,
  DEFAULT_MACHINE_SERVICE_NAME,
  DEFAULT_MACHINE_USER_DATA_SUFFIX,
  machineActivateReleaseScript,
  machineDrainScript,
  machineInstallDependenciesScript,
  machineInstallLayout,
  machineInstallServiceScript,
  machineMirrorProbeScript,
  machinePrepareDirectoriesScript,
  machineProbeScript,
  machineServiceLogScript,
  machineServiceUnit,
  machineStartServiceScript,
  parseMachineDrainReport,
  parseMachineMirrorProbe,
  parseMachineProbe,
  writeFileFromStdinScript,
  type MachineInstallLayout,
  type ParsedMachineProbe
} from "./machineInstallScripts";
import {
  defaultRemoteMirrorSync,
  escapeRemoteRsyncPath,
  remoteMirrorPath,
  rsyncRshCommand,
  type RemoteMirrorSyncRunner
} from "./remoteMirrorSync";

const PROBE_TIMEOUT_MS = 40_000;
const SHORT_TIMEOUT_MS = 60_000;
const TRANSFER_TIMEOUT_MS = 20 * 60_000;
const DEPENDENCIES_TIMEOUT_MS = 15 * 60_000;
const DRAIN_TIMEOUT_MS = 5 * 60_000;
const CONNECT_TIMEOUT_MS = 3 * 60_000;
const MINIMUM_NODE_MAJOR = 20;

export interface MachineSshExecRequest {
  target: MachineSshTarget;
  script: string;
  timeoutMs: number;
  /** Written to the remote command's stdin. Carries the enrollment package,
   *  so it is never logged and never placed on a command line. */
  input?: string;
  onStdout?: (chunk: string) => void;
}

export type MachineSshExec = (request: MachineSshExecRequest) => Promise<string>;

export type MachineBundleUpload = (request: {
  target: MachineSshTarget;
  localDir: string;
  remoteDir: string;
  timeoutMs: number;
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
  diagnose(settings: CloudRunWorkerSettings, options?: { requiredProviderKind?: "codex-cli" | "claude-code" }): Promise<CloudRunWorkerDoctorReport>;
  setup(
    settings: CloudRunWorkerSettings,
    onProgress?: (progress: CloudRunWorkerSetupProgress) => void,
    options?: { requiredProviderKind?: "codex-cli" | "claude-code" }
  ): Promise<CloudRunWorkerDoctorReport>;
}

export interface MachineBundle {
  dir: string;
  version: string;
  digest: string;
}

export interface MachineInstallerOptions {
  store: MachineInstallStore;
  doctor: MachineDoctor;
  /** Enrollment package for a machine, as Settings > Machines mints it. */
  getEnrollmentJson: (machineId: string) => Promise<string>;
  /** Resolves when the machine's relay link reports it connected. */
  waitForConnected: (machineId: string, timeoutMs: number) => Promise<boolean>;
  /** Where `npm run build:machine` put the bundle. */
  bundleDir: string;
  machineName?: (machineId: string) => Promise<string | undefined>;
  sshExec?: MachineSshExec;
  uploadBundle?: MachineBundleUpload;
  mirrorSync?: RemoteMirrorSyncRunner;
  now?: () => Date;
  logger?: (event: string, payload: Record<string, unknown>) => void;
}

export class MachineInstallerService {
  private readonly active = new Map<string, Promise<MachineInstallResult>>();
  private readonly sshExec: MachineSshExec;
  private readonly uploadBundle: MachineBundleUpload;
  private readonly mirrorSync: RemoteMirrorSyncRunner;
  private readonly now: () => Date;

  constructor(private readonly options: MachineInstallerOptions) {
    this.sshExec = options.sshExec ?? defaultMachineSshExec;
    this.uploadBundle = options.uploadBundle ?? defaultBundleUpload;
    this.mirrorSync = options.mirrorSync ?? defaultRemoteMirrorSync;
    this.now = options.now ?? (() => new Date());
  }

  /** An install interrupted by the desktop closing left the machine in a known
   *  state (staged, drained, or started) but nobody watching it. The record is
   *  marked so the UI offers a retry instead of showing a step that will never
   *  finish. Nothing is retried automatically: a half-finished drain must be
   *  re-proven, not assumed. */
  async recoverInterruptedOperation(): Promise<void> {
    for (const record of await this.options.store.listMachineInstalls()) {
      const operation = record.lastOperation;
      if (!operation || isTerminalPhase(operation.phase)) continue;
      await this.options.store.saveMachineInstall({
        ...record,
        lastOperation: {
          ...operation,
          phase: "needs-attention",
          message: "The desktop closed while the machine was being set up.",
          error: "Setup was interrupted.",
          retryable: true,
          recovery: {
            kind: operation.completed.includes("activate")
              ? "new-runtime-installed-not-started"
              : "old-runtime-still-installed",
            detail: "Nothing was left running on this desktop's side. Check the machine and retry; the setup re-checks the machine before changing anything.",
            activeVersion: record.installedVersion
          },
          updatedAt: this.now().toISOString()
        }
      });
    }
  }

  async probe(target: MachineSshTarget, layout?: Partial<MachineInstallLayout>): Promise<ParsedMachineProbe> {
    const stdout = await this.sshExec({
      target,
      script: machineProbeScript({
        installRoot: layout?.installRoot,
        userDataDir: layout?.userDataDir,
        serviceName: layout?.serviceName
      }),
      timeoutMs: PROBE_TIMEOUT_MS
    });
    return parseMachineProbe(stdout);
  }

  install(request: MachineInstallRequest, onProgress?: (snapshot: MachineInstallSnapshot) => void): Promise<MachineInstallResult> {
    return this.enqueue("install", request, onProgress);
  }

  upgrade(request: MachineUpgradeRequest, onProgress?: (snapshot: MachineInstallSnapshot) => void): Promise<MachineInstallResult> {
    return this.enqueue("upgrade", request, onProgress);
  }

  private enqueue(
    kind: MachineInstallKind,
    request: MachineUpgradeRequest,
    onProgress?: (snapshot: MachineInstallSnapshot) => void
  ): Promise<MachineInstallResult> {
    const running = this.active.get(request.machineId);
    if (running) return running;
    const started = this.run(kind, request, onProgress).finally(() => {
      this.active.delete(request.machineId);
    });
    this.active.set(request.machineId, started);
    return started;
  }

  private async run(
    kind: MachineInstallKind,
    request: MachineUpgradeRequest,
    onProgress?: (snapshot: MachineInstallSnapshot) => void
  ): Promise<MachineInstallResult> {
    const completed: MachineInstallPhase[] = [];
    const warnings: string[] = [];
    // Set the moment the version switch is known to have been attempted, so a
    // failure afterwards reports what actually runs instead of guessing.
    let switchAttempted = false;
    let activated = false;
    let stagedVersion: string | undefined;
    let record = await this.recordFor(request);
    let snapshot: MachineInstallSnapshot = {
      machineId: request.machineId,
      operationId: request.operationId,
      kind,
      phase: "preflight",
      message: "Checking the machine…",
      updatedAt: this.now().toISOString(),
      completed: []
    };

    const emit = async (
      phase: MachineInstallPhase,
      message: string,
      extra: Partial<MachineInstallSnapshot> = {}
    ): Promise<MachineInstallSnapshot> => {
      // A phase counts as completed only when the next step actually starts.
      // A failure marks the phase it failed in as unfinished, so the UI shows
      // where the setup stopped rather than a full row of ticks.
      const advancing = phase === "ready" || !isTerminalPhase(phase);
      if (advancing && snapshot.phase !== phase && !isTerminalPhase(snapshot.phase) && !completed.includes(snapshot.phase)) {
        completed.push(snapshot.phase);
      }
      snapshot = {
        machineId: request.machineId,
        operationId: request.operationId,
        kind,
        phase,
        message,
        updatedAt: this.now().toISOString(),
        completed: [...completed],
        ...(warnings.length ? { warnings: [...warnings] } : {}),
        ...extra
      };
      record = { ...record, lastOperation: snapshot };
      await this.options.store.saveMachineInstall(record);
      onProgress?.(snapshot);
      this.options.logger?.("machines.install.progress", {
        machineId: request.machineId, kind, phase, message
      });
      return snapshot;
    };

    const fail = async (
      phase: MachineInstallPhase,
      message: string,
      recovery: MachineInstallRecovery,
      retryable = true
    ): Promise<MachineInstallResult> => {
      const terminal = phase === "needs-attention" ? "needs-attention" : "error";
      await emit(terminal, message, { error: message, retryable, recovery });
      return { snapshot, record };
    };

    try {
      const worker = workerSettingsFor(request.target);
      // 1. Preflight. The doctor installs node/git/sqlite3, fixes the Codex
      //    sandbox setting, and performs the provider sign-in ON the machine.
      await emit("preflight", "Checking the machine…");
      let report = await this.options.doctor.diagnose(worker, { requiredProviderKind: request.requiredProvider });
      if (!report.ok) {
        // Doctor progress is synchronous and each frame saves a snapshot, so
        // the writes are chained: an out-of-order save would leave the record
        // showing an earlier step than the one the User is looking at.
        let progressWrites: Promise<unknown> = Promise.resolve();
        report = await this.options.doctor.setup(worker, (progress) => {
          progressWrites = progressWrites.then(() => emit("preflight", progress.message, {
            authUrl: progress.authUrl,
            authCode: progress.authCode
          }));
        }, { requiredProviderKind: request.requiredProvider });
        await progressWrites;
      }
      if (!report.ok) {
        return await fail("error", report.message, {
          kind: "nothing-changed",
          detail: "The machine was not changed. Fix the failing checks and run the setup again."
        });
      }
      for (const check of report.checks) {
        if (check.status === "warn") warnings.push(`${check.id}: ${check.detail ?? "warning"}`);
      }

      const probe = await this.probe(request.target, {
        installRoot: request.installRoot,
        userDataDir: request.userDataDir,
        serviceName: request.serviceName ?? DEFAULT_MACHINE_SERVICE_NAME
      });
      const missing = missingRequirements(probe);
      if (missing.length) {
        return await fail("error", `The machine is missing ${missing.join(", ")}.`, {
          kind: "nothing-changed",
          detail: "The machine was not changed. Install the missing tools and run the setup again."
        });
      }

      const layout = machineInstallLayout({
        installRoot: request.installRoot ?? probe.installRoot ?? `${probe.home}/${DEFAULT_MACHINE_INSTALL_DIRNAME}`,
        userDataDir: request.userDataDir ?? probe.userDataDir ?? `${probe.home}/${DEFAULT_MACHINE_USER_DATA_SUFFIX}`,
        serviceName: request.serviceName ?? DEFAULT_MACHINE_SERVICE_NAME,
        serviceScope: probe.serviceScope ?? (probe.hasPasswordlessSudo ? "system" : "user")
      });
      record = {
        ...record,
        installRoot: layout.installRoot,
        userDataDir: layout.userDataDir,
        serviceName: layout.serviceName,
        serviceScope: layout.serviceScope,
        installedVersion: probe.installedVersion ?? record.installedVersion,
        installedDigest: probe.installedDigest ?? record.installedDigest
      };

      // 2. The bundle this desktop would install.
      await emit("bundle", "Reading the runtime bundle…");
      const bundle = readMachineBundle(this.options.bundleDir);
      stagedVersion = bundle.version;
      const fence = versionFence(kind, probe, bundle, request.allowDowngrade === true);
      if (fence) {
        return await fail("error", fence, {
          kind: "nothing-changed",
          detail: "The machine was not changed.",
          activeVersion: probe.installedVersion
        });
      }
      if (probe.installedDigest === bundle.digest && probe.serviceState === "active" && kind === "upgrade") {
        await emit("ready", `Machine already runs ${bundle.version}.`, {
          installedVersion: bundle.version, previousVersion: probe.installedVersion
        });
        return { snapshot, record };
      }
      const release = releaseName(bundle);
      const previousRelease = probe.activeRelease;

      // 3. Stage the new release beside the running one. Nothing that runs is
      //    touched yet, so a failure here leaves the machine exactly as it was.
      await this.sshExec({ target: request.target, script: machinePrepareDirectoriesScript(layout), timeoutMs: SHORT_TIMEOUT_MS });
      await emit("transfer", `Copying runtime ${bundle.version} to the machine…`);
      await this.uploadBundle({
        target: request.target,
        localDir: bundle.dir,
        remoteDir: `${layout.releasesDir}/${release}`,
        timeoutMs: TRANSFER_TIMEOUT_MS
      });

      await emit("dependencies", "Installing runtime dependencies on the machine…");
      try {
        await this.sshExec({
          target: request.target,
          script: machineInstallDependenciesScript(layout, release),
          timeoutMs: DEPENDENCIES_TIMEOUT_MS
        });
      } catch (error) {
        // The one native dependency (node-pty) is compiled on the machine, so
        // this is where a box without build tools or without network fails.
        throw new Error(
          `Installing the runtime's dependencies on the machine failed. The machine needs network access and build tools (python3, make, a C++ compiler) to compile node-pty. ${errorMessage(error)}`
        );
      }

      // 4. Enrollment. Written from stdin; the relay key never reaches a
      //    command line or a log. An upgrade keeps the pairing that is there.
      if (!probe.enrollmentPresent || kind === "install") {
        await emit("enroll", "Installing the enrollment…");
        const enrollmentJson = await this.options.getEnrollmentJson(request.machineId);
        await this.sshExec({
          target: request.target,
          script: writeFileFromStdinScript(layout.enrollmentPath, "600"),
          input: enrollmentJson,
          timeoutMs: SHORT_TIMEOUT_MS
        });
        if (kind === "upgrade") {
          warnings.push("The machine had no enrollment file; it was installed again from this desktop's record.");
        }
      }

      // 5. Drain. Everything that follows replaces what executes, so the old
      //    runtime, its native supervisor and any provider process it owns
      //    must be gone first — proven, not assumed.
      // The probe that said nothing was running is minutes old by now: the
      // transfer and `npm install` happen while the old runtime still serves
      // members. So the drain always runs. Skipping it on a stale reading
      // would flip the symlink under a live runtime, and the connect check
      // below would then see the OLD process answer and call the upgrade done.
      const wasRunning = probe.runtimePids.length > 0
        || probe.supervisorPids.length > 0
        || probe.providerPids.length > 0
        || (probe.serviceState !== undefined && probe.serviceState !== "absent" && probe.serviceState !== "inactive" && probe.serviceState !== "failed");
      await emit("drain", wasRunning
        ? "Stopping the running runtime and its provider processes…"
        : "Checking that nothing from an earlier install is still running…");
      const drain = parseMachineDrainReport(await this.sshExec({
        target: request.target,
        script: machineDrainScript(layout),
        timeoutMs: DRAIN_TIMEOUT_MS
      }));
      if (!drain.drained) {
        const blocking = [...drain.runtimePids, ...drain.supervisorPids, ...drain.providerPids];
        return await fail(
          "needs-attention",
          "The machine's current runtime did not stop, so it was not replaced.",
          {
            kind: "manual-drain-required",
            detail: [
              drain.detail,
              `Version ${probe.installedVersion ?? "(unknown)"} is still the one running and the machine keeps working.`,
              `The new files are staged in ${layout.releasesDir}/${release} and are not in use.`,
              "Replacing the runtime while the old one still owns a provider process would run the same member twice,",
              "so the upgrade stopped here. Stop the remaining processes on the machine and retry."
            ].filter(Boolean).join(" "),
            activeVersion: probe.installedVersion,
            blockingPids: blocking
          }
        );
      }

      // 6. Flip, install the unit, start.
      await emit("activate", `Switching the machine to ${bundle.version}…`);
      const installedAt = this.now().toISOString();
      switchAttempted = true;
      await this.sshExec({
        target: request.target,
        script: machineActivateReleaseScript(layout, release, {
          version: bundle.version, digest: bundle.digest, installedAt
        }),
        timeoutMs: SHORT_TIMEOUT_MS
      });
      activated = true;

      await emit("service", "Installing the machine service…");
      const machineName = (await this.options.machineName?.(request.machineId)) ?? request.machineName ?? request.machineId;
      const unit = machineServiceUnit({
        layout,
        machineName,
        home: probe.home,
        user: request.target.user ?? "ubuntu",
        nodePath: probe.nodePath ?? "/usr/bin/node",
        path: probe.loginPath
      });
      const serviceOutput = await this.sshExec({
        target: request.target,
        script: machineInstallServiceScript(layout, request.target.user ?? "ubuntu"),
        input: unit,
        timeoutMs: SHORT_TIMEOUT_MS
      });
      if (serviceOutput.includes("linger=missing")) {
        warnings.push("The runtime will stop when the last session on the machine closes: lingering could not be enabled.");
      }

      await emit("starting", "Starting the machine runtime…");
      await this.sshExec({
        target: request.target,
        script: machineStartServiceScript(layout),
        timeoutMs: SHORT_TIMEOUT_MS
      });

      // 7. The machine is installed when it says hello over the relay, not
      //    when systemd says the unit started.
      await emit("verify", "Waiting for the machine to connect…");
      const connected = await this.options.waitForConnected(request.machineId, CONNECT_TIMEOUT_MS);
      // A connection alone is not proof: a unit that failed to restart can
      // leave an older process connected. Read back which release the machine
      // actually runs before calling this done.
      const after = connected
        ? await this.probe(request.target, layout).catch(() => undefined)
        : undefined;
      const runningNewRelease = after === undefined
        ? connected
        : after.activeRelease === release && after.serviceState === "active";
      if (!connected || !runningNewRelease) {
        const serviceLog = await this.readServiceLog(request.target, layout);
        if (kind === "upgrade" && previousRelease && previousRelease !== release) {
          const rolledBack = await this.rollback(request.target, layout, previousRelease, probe);
          return await fail("needs-attention", "The new runtime did not connect; the machine was put back on its previous version.", {
            kind: rolledBack ? "rolled-back" : "new-runtime-installed-not-started",
            detail: rolledBack
              ? `The machine runs ${probe.installedVersion ?? previousRelease} again. The new release is still staged, so a retry does not copy it twice.`
              : "Putting the previous version back failed as well; the machine needs to be looked at directly.",
            activeVersion: rolledBack ? probe.installedVersion : bundle.version,
            serviceLog
          });
        }
        return await fail("needs-attention", "The machine runtime was installed but has not connected.", {
          kind: "new-runtime-installed-not-started",
          detail: "The service is installed and enabled. Check the log below, then retry; the setup does not copy the runtime again.",
          activeVersion: bundle.version,
          serviceLog
        });
      }

      record = {
        ...record,
        installedVersion: bundle.version,
        installedDigest: bundle.digest,
        installedAt
      };
      await emit("ready", `Machine is running ${bundle.version}.`, {
        installedVersion: bundle.version,
        previousVersion: probe.installedVersion
      });
      return { snapshot, record };
    } catch (error) {
      const message = errorMessage(error);
      return await fail("error", message, {
        kind: switchAttempted ? "new-runtime-installed-not-started" : "old-runtime-still-installed",
        detail: activated
          ? "The new version is the one installed on the machine but setup did not finish. Retry; nothing is copied again."
          : switchAttempted
            ? "The version switch was interrupted, so which release is active is unknown. The next attempt reads that from the machine before changing anything."
            : "The version that was running before is still the one installed. Retry when the cause is fixed.",
        activeVersion: activated ? stagedVersion : record.installedVersion
      });
    }
  }

  private async rollback(
    target: MachineSshTarget,
    layout: MachineInstallLayout,
    previousRelease: string,
    probe: ParsedMachineProbe
  ): Promise<boolean> {
    try {
      const drain = parseMachineDrainReport(await this.sshExec({
        target, script: machineDrainScript(layout), timeoutMs: DRAIN_TIMEOUT_MS
      }));
      if (!drain.drained) return false;
      await this.sshExec({
        target,
        script: machineActivateReleaseScript(layout, previousRelease, {
          version: probe.installedVersion ?? previousRelease,
          digest: probe.installedDigest ?? "",
          installedAt: this.now().toISOString()
        }),
        timeoutMs: SHORT_TIMEOUT_MS
      });
      await this.sshExec({ target, script: machineStartServiceScript(layout), timeoutMs: SHORT_TIMEOUT_MS });
      return true;
    } catch (error) {
      this.options.logger?.("machines.install.rollback-failed", { error: errorMessage(error) });
      return false;
    }
  }

  private async readServiceLog(target: MachineSshTarget, layout: MachineInstallLayout): Promise<string | undefined> {
    try {
      const output = await this.sshExec({ target, script: machineServiceLogScript(layout), timeoutMs: SHORT_TIMEOUT_MS });
      // This tail is stored in settings and shown to the User. A machine's log
      // should never print a key, but it is not this service's log to trust:
      // long key-shaped runs are replaced before anything is written down.
      return redactKeyLikeText(output).trim().split("\n").slice(-60).join("\n") || undefined;
    } catch {
      return undefined;
    }
  }

  private async recordFor(request: MachineInstallRequest): Promise<MachineInstallRecord> {
    const existing = await this.options.store.getMachineInstall(request.machineId);
    return {
      machineId: request.machineId,
      target: request.target,
      installRoot: request.installRoot ?? existing?.installRoot ?? "",
      userDataDir: request.userDataDir ?? existing?.userDataDir ?? "",
      serviceName: request.serviceName ?? existing?.serviceName ?? DEFAULT_MACHINE_SERVICE_NAME,
      serviceScope: existing?.serviceScope ?? "system",
      installedVersion: existing?.installedVersion,
      installedDigest: existing?.installedDigest,
      installedAt: existing?.installedAt
    };
  }

  // ---- project mirror -----------------------------------------------------

  /** Reads the mirror without changing it. */
  async inspectProjectMirror(machineId: string, localPath: string): Promise<MachineMirrorInspection> {
    const record = await this.requireRecord(machineId);
    const repoPath = remoteMirrorPath(`${record.installRoot}/workspace`, localPath);
    const stdout = await this.sshExec({
      target: record.target,
      script: machineMirrorProbeScript(repoPath),
      timeoutMs: PROBE_TIMEOUT_MS
    });
    return parseMachineMirrorProbe(stdout);
  }

  /**
   * Puts a project on the machine once. After that the mirror is the machine's
   * own working copy: the participant pulls, commits and opens pull requests
   * from it, exactly as `docs/cloud-runs-workspace-parity.md` requires.
   *
   * An existing mirror is never replaced — not a clean one, and certainly not a
   * dirty one. There is no automatic resync and no write-back to this desktop.
   */
  async bootstrapProjectMirror(request: MachineMirrorBootstrapRequest): Promise<MachineMirrorBootstrapResult> {
    const record = await this.requireRecord(request.machineId);
    const inspection = await this.inspectProjectMirror(request.machineId, request.localPath);
    if (inspection.state === "dirty") {
      return {
        inspection,
        action: "refused",
        message: `The machine's copy of this project has ${inspection.dirtyPaths.length} uncommitted change${inspection.dirtyPaths.length === 1 ? "" : "s"}. It was left untouched; commit or push them on the machine first.`
      };
    }
    if (inspection.state === "clean") {
      return {
        inspection,
        action: "reused",
        message: inspection.worktrees.length
          ? `The machine already has this project (${inspection.worktrees.length} worktree${inspection.worktrees.length === 1 ? "" : "s"} beside it). Nothing was copied.`
          : "The machine already has this project. Nothing was copied."
      };
    }
    if (inspection.state === "unknown") {
      return {
        inspection,
        action: "refused",
        message: "The machine's copy of this project could not be read; it was left untouched."
      };
    }
    const repoPath = remoteMirrorPath(`${record.installRoot}/workspace`, request.localPath);
    await this.mirrorSync.syncUp({
      worker: { ...record.target, host: record.target.host },
      localPath: request.localPath,
      remotePath: repoPath
    });
    return {
      inspection: await this.inspectProjectMirror(request.machineId, request.localPath),
      action: "created",
      message: "The project was copied to the machine. From now on it is the machine's own working copy: changes travel through git, never by copying again."
    };
  }

  private async requireRecord(machineId: string): Promise<MachineInstallRecord> {
    const record = await this.options.store.getMachineInstall(machineId);
    if (!record || !record.installRoot) {
      throw new Error("This machine has not been set up from this desktop yet.");
    }
    return record;
  }
}

// ---- helpers --------------------------------------------------------------

function isTerminalPhase(phase: MachineInstallPhase): boolean {
  return phase === "ready" || phase === "error" || phase === "needs-attention";
}

function missingRequirements(probe: ParsedMachineProbe): string[] {
  const missing: string[] = [];
  const major = Number.parseInt((probe.nodeVersion ?? "").replace(/^v/, "").split(".")[0] ?? "", 10);
  if (!probe.nodeVersion || !Number.isInteger(major) || major < MINIMUM_NODE_MAJOR) {
    missing.push(`Node ${MINIMUM_NODE_MAJOR}+`);
  }
  if (!probe.hasNpm) missing.push("npm");
  if (!probe.hasSqlite3) missing.push("the sqlite3 CLI");
  if (!probe.hasGit) missing.push("git");
  if (!probe.hasRsync) missing.push("rsync");
  if (!probe.hasSystemd) missing.push("systemd");
  return missing;
}

export function releaseName(bundle: MachineBundle): string {
  return `${bundle.version}-${bundle.digest.slice(0, 12)}`;
}

/** Installing an older runtime over a newer one opens the machine's SQLite
 *  with an old binary. The accord's upgrade rule makes rollback a whole-version
 *  restore, never a live downgrade, so this refuses unless the User asked. */
export function versionFence(
  kind: MachineInstallKind,
  probe: { installedVersion?: string },
  bundle: MachineBundle,
  allowDowngrade: boolean
): string | undefined {
  if (allowDowngrade || !probe.installedVersion) return undefined;
  if (compareVersions(bundle.version, probe.installedVersion) >= 0) return undefined;
  return `The machine runs ${probe.installedVersion}; this desktop would install the older ${bundle.version}. `
    + "Installing an older runtime over a newer one opens the machine's data with an old binary, so it was refused.";
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

/** Reads the bundle `npm run build:machine` produced and fingerprints it, so a
 *  release directory on the machine is named after exactly what it contains
 *  and an unchanged bundle is recognised instead of re-uploaded. */
export function readMachineBundle(bundleDir: string): MachineBundle {
  const dir = path.resolve(bundleDir);
  const entry = path.join(dir, "accordagents-machine.cjs");
  if (!fs.existsSync(entry)) {
    throw new Error(`No machine runtime bundle at ${dir}. Build it with \`npm run build:machine\` first.`);
  }
  if (!fs.existsSync(path.join(dir, "nativeProcessSupervisor.cjs"))) {
    // Without the supervisor the runtime cannot own or verifiably close a
    // provider process, which silently breaks Stop on that machine.
    throw new Error(`The machine bundle at ${dir} has no nativeProcessSupervisor.cjs; rebuild it with \`npm run build:machine\`.`);
  }
  let version = "0.0.0";
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version.trim()) version = pkg.version.trim();
  } catch {
    throw new Error(`The machine bundle at ${dir} has no readable package.json; rebuild it with \`npm run build:machine\`.`);
  }
  return { dir, version, digest: hashDirectory(dir) };
}

function hashDirectory(dir: string): string {
  const hash = createHash("sha256");
  const walk = (current: string, prefix: string): void => {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .filter((entry) => entry.name !== "node_modules")
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        hash.update(`d:${relative}\0`);
        walk(full, relative);
      } else if (entry.isFile()) {
        hash.update(`f:${relative}\0`);
        hash.update(createHash("sha256").update(fs.readFileSync(full)).digest());
      }
    }
  };
  walk(dir, "");
  return hash.digest("hex");
}

function workerSettingsFor(target: MachineSshTarget): CloudRunWorkerSettings {
  return {
    host: target.host,
    user: target.user,
    port: target.port,
    identityFile: target.identityFile,
    hostKeyAlias: target.hostKeyAlias
  };
}

async function defaultMachineSshExec(request: MachineSshExecRequest): Promise<string> {
  const worker = workerSettingsFor(request.target) as CloudRunWorkerSettings & { host: string };
  // With no payload the script itself is stdin, so it never reaches `ps` on the
  // machine. With a payload the script (paths only, never a secret) goes as one
  // argument and stdin carries the payload — the enrollment's relay key.
  const remoteCommand = request.input === undefined
    ? "bash -s"
    : `bash -c ${shellQuotePosix(request.script)}`;
  const result = await runCommand("ssh", [
    ...cloudRunSshOptionArgs(worker),
    buildCloudRunSshTarget(worker),
    remoteCommand
  ], {
    input: request.input ?? request.script,
    timeoutMs: request.timeoutMs,
    onStdout: request.onStdout
  });
  return result.stdout;
}

async function defaultBundleUpload(request: {
  target: MachineSshTarget;
  localDir: string;
  remoteDir: string;
  timeoutMs: number;
}): Promise<void> {
  const worker = workerSettingsFor(request.target) as CloudRunWorkerSettings & { host: string };
  const sshArgs = cloudRunSshOptionArgs(worker);
  const target = buildCloudRunSshTarget(worker);
  await runCommand("ssh", [...sshArgs, target, `umask 077; mkdir -p ${shellQuotePosix(request.remoteDir)}`], {
    timeoutMs: 60_000
  });
  await runCommand("rsync", [
    "-az",
    "--delete",
    // Dependencies are installed inside the release directory on the machine;
    // deleting them on every re-upload would reinstall them for nothing.
    "--exclude=node_modules",
    "-e",
    rsyncRshCommand(sshArgs),
    `${path.resolve(request.localDir)}/`,
    `${target}:${escapeRemoteRsyncPath(request.remoteDir)}/`
  ], { timeoutMs: request.timeoutMs });
}

/** Replaces base64/base64url/hex runs long enough to be a key. Deliberately
 *  blunt: a redacted log line is recoverable, a leaked key is not. */
export function redactKeyLikeText(value: string): string {
  return value
    .replace(/[A-Za-z0-9_-]{40,}={0,2}/g, "[redacted]")
    .replace(/[0-9a-fA-F]{40,}/g, "[redacted]");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
