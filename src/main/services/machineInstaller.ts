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
import { machineMaintenanceCommand, type MachineMaintenanceTarget } from "./machineMaintenanceCommand";
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
  MachineRuntimePayloadInfo,
  MachineRuntimePayloadSource,
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
  diagnose(settings: CloudRunWorkerSettings, options?: { requiredProviderKind?: "codex-cli" | "claude-code"; maintenance?: MachineMaintenanceTarget }): Promise<CloudRunWorkerDoctorReport>;
  setup(
    settings: CloudRunWorkerSettings,
    onProgress?: (progress: CloudRunWorkerSetupProgress) => void,
    options?: { requiredProviderKind?: "codex-cli" | "claude-code"; maintenance?: MachineMaintenanceTarget }
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

  private payloadLocation(): MachineRuntimePayloadLocation {
    return typeof this.options.payload === "function" ? this.options.payload() : this.options.payload;
  }

  /** What this desktop would install, or why it cannot. Reading it costs one
   *  pass over the payload (~30 ms for 6 MB) and touches no machine. */
  readPayload(): MachineRuntimePayloadInfo {
    const location = this.payloadLocation();
    try {
      const bundle = readMachineBundle(location.dir, { source: location.source, expectVersion: location.expectVersion });
      return {
        ok: true,
        source: location.source,
        dir: bundle.dir,
        version: bundle.version,
        digest: bundle.digest,
        files: bundle.files,
        bytes: bundle.bytes
      };
    } catch (error) {
      return { ok: false, source: location.source, dir: location.dir, message: errorMessage(error) };
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
    let maintenance: MachineMaintenanceTarget | undefined;
    const exec = (input: MachineSshExecRequest): Promise<string> => this.sshExec({ ...input, maintenance });
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
      const initial = await this.probe(request.target, { installRoot: record.installRoot || undefined,
        userDataDir: record.userDataDir || undefined, serviceName: request.serviceName });
      // A release older than maintenance would be started, not asked to hold a
      // lease, so it is never used as the wrapper. The steps before staging
      // then run unwrapped — they only create a NEW release directory and
      // cannot disturb a running runtime or an existing stop fence — and
      // everything from the drain onward is wrapped by the release just
      // staged, which does understand it.
      maintenance = initial.maintenanceCapable ? maintenanceFor(initial) : undefined;
      let report = await this.options.doctor.diagnose(worker, { requiredProviderKind: request.requiredProvider, maintenance });
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
        }, { requiredProviderKind: request.requiredProvider, maintenance });
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

      // Only what the caller actually asked for. Passing the default service
      // name here would override the name the machine derives from the install
      // directory, and a second deployment would take over the first one's
      // unit — the collision this derivation exists to prevent.
      const probe = await this.probe(request.target, {
        installRoot: request.installRoot,
        userDataDir: request.userDataDir,
        serviceName: request.serviceName
      });
      const missing = missingRequirements(probe);
      if (missing.length) {
        return await fail("error", `The machine is missing ${missing.join(", ")}.`, {
          kind: "nothing-changed",
          detail: "The machine was not changed. Install the missing tools and run the setup again."
        });
      }

      // The machine resolved `~`, the data directory and the unit name in the
      // probe, so both sides agree on exactly one layout.
      const layout = machineInstallLayout({
        installRoot: probe.installRoot || `${probe.home}/${DEFAULT_MACHINE_INSTALL_DIRNAME}`,
        userDataDir: probe.userDataDir || `${probe.home}/${DEFAULT_MACHINE_USER_DATA_SUFFIX}`,
        serviceName: probe.serviceName || DEFAULT_MACHINE_SERVICE_NAME,
        serviceScope: probe.serviceScope ?? (probe.hasPasswordlessSudo ? "system" : "user")
      });
      maintenance = maintenanceFor(layout);
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
      const location = this.payloadLocation();
      const bundle = readMachineBundle(location.dir, {
        source: location.source,
        expectVersion: location.expectVersion
      });
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
      await exec({ target: request.target, script: machinePrepareDirectoriesScript(layout), timeoutMs: SHORT_TIMEOUT_MS });
      await emit("transfer", `Copying runtime ${bundle.version} to the machine…`);
      await this.uploadBundle({
        target: request.target,
        localDir: bundle.dir,
        remoteDir: `${layout.releasesDir}/${release}`,
        timeoutMs: TRANSFER_TIMEOUT_MS,
        maintenance
      });

      await emit("dependencies", "Installing runtime dependencies on the machine…");
      try {
        await exec({
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

      // The staged release is on disk and complete. From here everything
      // mutates what runs, so it is wrapped by that release's runtime — which
      // always understands `--maintenance`, even when the installed one does
      // not.
      if (!probe.maintenanceCapable) {
        warnings.push(
          "The installed runtime is older than machine maintenance, so the checks before the copy ran without a maintenance lease. "
          + "Everything that replaces the runtime is protected by the release just copied."
        );
      }
      maintenance = maintenanceForStagedRelease(layout, release);

      // 4. Enrollment. Written from stdin; the relay key never reaches a
      //    command line or a log. An upgrade keeps the pairing that is there.
      if (!probe.enrollmentPresent || kind === "install") {
        await emit("enroll", "Installing the enrollment…");
        const enrollmentJson = await this.options.getEnrollmentJson(request.machineId);
        await exec({
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
      const drain = parseMachineDrainReport(await exec({
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
              `Nothing was replaced: ${probe.installedVersion ?? "the installed version"} is still the one the machine would run,`,
              `and the new files are staged in ${layout.releasesDir}/${release} without being used.`,
              drain.serviceState === "active"
                ? "The runtime is still running."
                : "The runtime was stopped for the upgrade and has deliberately NOT been started again:"
                  + " something this installation owns is still alive, and starting a second runtime beside it"
                  + " would run the same member twice. The machine hosts no members until that is resolved.",
              "Stop the processes listed below on the machine, then retry — the retry re-checks before changing anything."
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
      await exec({
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
      const serviceOutput = await exec({
        target: request.target,
        script: machineInstallServiceScript(layout, request.target.user ?? "ubuntu"),
        input: unit,
        timeoutMs: SHORT_TIMEOUT_MS
      });
      if (serviceOutput.includes("linger=missing")) {
        warnings.push("The runtime will stop when the last session on the machine closes: lingering could not be enabled.");
      }

      await emit("starting", "Starting the machine runtime…");
      await exec({
        target: request.target,
        script: machineStartServiceScript(layout),
        timeoutMs: SHORT_TIMEOUT_MS
      });

      // 7. The machine is installed when it says hello over the relay, not
      //    when systemd says the unit started.
      await emit("verify", "Waiting for the machine to connect…");
      const connected = await this.options.waitForConnected(request.machineId, CONNECT_TIMEOUT_MS, bundle.version);
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
      const maintenance = { ...maintenanceFor(layout), runtimePath: `${layout.releasesDir}/${previousRelease}/accordagents-machine.cjs` };
      const drain = parseMachineDrainReport(await this.sshExec({
        target, script: machineDrainScript(layout), timeoutMs: DRAIN_TIMEOUT_MS, maintenance
      }));
      if (!drain.drained) return false;
      await this.sshExec({
        target,
        maintenance,
        script: machineActivateReleaseScript(layout, previousRelease, {
          version: probe.installedVersion ?? previousRelease,
          digest: probe.installedDigest ?? "",
          installedAt: this.now().toISOString()
        }),
        timeoutMs: SHORT_TIMEOUT_MS
      });
      await this.sshExec({ target, script: machineStartServiceScript(layout), timeoutMs: SHORT_TIMEOUT_MS, maintenance });
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
      remotePath: repoPath,
      maintenance: maintenanceFor(record)
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

function maintenanceFor(layout: { installRoot: string; userDataDir: string }): MachineMaintenanceTarget {
  if (!layout.installRoot || !layout.userDataDir) throw new Error("The machine did not report its maintenance paths.");
  return {
    runtimePath: `${layout.installRoot}/current/accordagents-machine.cjs`,
    userDataDir: layout.userDataDir,
    capabilityPath: `${layout.installRoot}/current/maintenance-v1`
  };
}

/** The release just staged, used as the maintenance runtime for everything
 *  from the drain onward. It always understands `--maintenance`, so an upgrade
 *  from a release that predates maintenance is still protected. */
function maintenanceForStagedRelease(
  layout: { releasesDir: string; userDataDir: string },
  release: string
): MachineMaintenanceTarget {
  return {
    runtimePath: `${layout.releasesDir}/${release}/accordagents-machine.cjs`,
    userDataDir: layout.userDataDir,
    capabilityPath: `${layout.releasesDir}/${release}/maintenance-v1`
  };
}

function missingRequirements(probe: ParsedMachineProbe): string[] {
  const missing: string[] = [];
  const major = Number.parseInt((probe.nodeVersion ?? "").replace(/^v/, "").split(".")[0] ?? "", 10);
  if (!probe.nodeVersion || !Number.isInteger(major) || major < MINIMUM_NODE_MAJOR) {
    missing.push(`Node ${MINIMUM_NODE_MAJOR}+`);
  }
  if (!probe.hasNpm) missing.push("npm");
  if (!probe.hasPython3) missing.push("python3 (host admission locking)");
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

/** Where the runtime payload the desktop would install came from. It decides
 *  what a failure means: a checkout can rebuild, an installed application
 *  cannot. */
export type MachineBundleSource = MachineRuntimePayloadSource;

export interface ReadMachineBundleOptions {
  source?: MachineBundleSource;
  /** The desktop's own version. A payload built for a different version would
   *  put a runtime on the machine that this desktop was never built against. */
  expectVersion?: string;
}

const PAYLOAD_MANIFEST = "payload.json";

interface PayloadManifest {
  manifestVersion: number;
  version: string;
  generatedAt?: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
}

/**
 * Reads and verifies the runtime payload this desktop would install.
 *
 * A packaged application ships this inside its own resources and cannot
 * rebuild it, so every file is checked against the manifest the build wrote:
 * exact set, exact size, exact hash. A payload truncated by a partial download
 * or a half-finished copy is refused here rather than installed on a machine
 * as a runtime that cannot start. The bundle digest — which names the release
 * directory on the machine — is computed from the same pass.
 */
export function readMachineBundle(bundleDir: string, options: ReadMachineBundleOptions = {}): MachineBundle {
  const dir = path.resolve(bundleDir);
  const source = options.source ?? "checkout";
  const rebuild = rebuildHint(source, dir);
  if (!fs.existsSync(path.join(dir, "accordagents-machine.cjs"))) {
    throw new Error(`The machine runtime payload is missing from ${dir}. ${rebuild}`);
  }
  if (!fs.existsSync(path.join(dir, "nativeProcessSupervisor.cjs"))) {
    // Without the supervisor the runtime cannot own or verifiably close a
    // provider process, which silently breaks Stop on that machine.
    throw new Error(`The machine runtime payload in ${dir} has no nativeProcessSupervisor.cjs. ${rebuild}`);
  }
  let version: string;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { version?: unknown };
    if (typeof pkg.version !== "string" || !pkg.version.trim()) throw new Error("no version");
    version = pkg.version.trim();
  } catch {
    throw new Error(`The machine runtime payload in ${dir} has no readable package.json. ${rebuild}`);
  }

  const scan = scanBundle(dir, rebuild);
  const manifest = readPayloadManifest(dir, rebuild);
  verifyPayload(manifest, scan.files, dir, rebuild);
  if (manifest.version !== version) {
    throw new Error(
      `The machine runtime payload in ${dir} is inconsistent: its manifest says ${manifest.version} and its package.json says ${version}. ${rebuild}`
    );
  }
  if (options.expectVersion && options.expectVersion !== version) {
    throw new Error(
      `This desktop is ${options.expectVersion} but its machine runtime payload is ${version}. `
      + `Installing it would put a runtime on the machine that this desktop was not built against. ${rebuild}`
    );
  }
  return {
    dir,
    version,
    digest: scan.digest,
    files: scan.files.length,
    bytes: scan.files.reduce((total, file) => total + file.bytes, 0)
  };
}

function rebuildHint(source: MachineBundleSource, dir: string): string {
  if (source === "packaged") {
    return "This copy of AccordAgents is incomplete; reinstall it from the release you downloaded.";
  }
  if (source === "override") {
    return `ACCORDAGENTS_MACHINE_BUNDLE_DIR points at ${dir}; build a bundle there with \`npm run build:machine\`.`;
  }
  return "Build it with `npm run build:machine` first.";
}

function readPayloadManifest(dir: string, rebuild: string): PayloadManifest {
  const manifestPath = path.join(dir, PAYLOAD_MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`The machine runtime payload in ${dir} has no ${PAYLOAD_MANIFEST}. ${rebuild}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error(`The machine runtime payload manifest in ${dir} could not be read. ${rebuild}`);
  }
  const manifest = parsed as Partial<PayloadManifest>;
  if (!manifest || manifest.manifestVersion !== 1 || typeof manifest.version !== "string" || !Array.isArray(manifest.files)) {
    throw new Error(`The machine runtime payload manifest in ${dir} is not one this version understands. ${rebuild}`);
  }
  for (const file of manifest.files) {
    if (!file || typeof file.path !== "string" || typeof file.bytes !== "number" || typeof file.sha256 !== "string") {
      throw new Error(`The machine runtime payload manifest in ${dir} is damaged. ${rebuild}`);
    }
  }
  return manifest as PayloadManifest;
}

function verifyPayload(
  manifest: PayloadManifest,
  found: readonly BundleFile[],
  dir: string,
  rebuild: string
): void {
  const byPath = new Map(found.map((file) => [file.path, file]));
  for (const expected of manifest.files) {
    const actual = byPath.get(expected.path);
    if (!actual) {
      throw new Error(`The machine runtime payload in ${dir} is missing ${expected.path}. ${rebuild}`);
    }
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
      throw new Error(`The machine runtime payload in ${dir} is damaged: ${expected.path} does not match the build. ${rebuild}`);
    }
    byPath.delete(expected.path);
  }
  const extra = [...byPath.keys()].sort();
  if (extra.length) {
    throw new Error(`The machine runtime payload in ${dir} has files the build did not produce (${extra.slice(0, 3).join(", ")}). ${rebuild}`);
  }
}

interface BundleFile {
  path: string;
  bytes: number;
  sha256: string;
}

/** One pass over the payload: per-file hashes for the manifest check and the
 *  tree digest that names the release directory on the machine. `node_modules`
 *  (installed on the machine) and the manifest itself are excluded, so adding
 *  the manifest did not change how existing releases are identified. Anything
 *  that is not a regular file or a directory is refused, not skipped. */
function scanBundle(dir: string, rebuild: string): { files: BundleFile[]; digest: string } {
  const hash = createHash("sha256");
  const files: BundleFile[] = [];
  const walk = (current: string, prefix: string): void => {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .filter((entry) => entry.name !== "node_modules" && !(prefix === "" && entry.name === PAYLOAD_MANIFEST))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        hash.update(`d:${relative}\0`);
        walk(full, relative);
      } else if (entry.isFile()) {
        const contents = fs.readFileSync(full);
        const digest = createHash("sha256").update(contents).digest();
        hash.update(`f:${relative}\0`);
        hash.update(digest);
        files.push({ path: relative, bytes: contents.byteLength, sha256: digest.toString("hex") });
      } else {
        // Anything else is refused rather than skipped. `rsync -a` copies a
        // symbolic link to the machine as a link, so a payload that merely
        // ignored one would put content there that the manifest never
        // described and the digest never covered — verified on a real machine:
        // a link named appSkills/escape.md arrived and resolved to /etc/hosts.
        throw new Error(
          `The machine runtime payload in ${dir} contains ${relative}, which is ${describeEntry(entry)}. `
          + "A payload may only contain regular files and directories, because anything else is copied to the "
          + `machine without being covered by the manifest. ${rebuild}`
        );
      }
    }
  };
  walk(dir, "");
  return { files, digest: hash.digest("hex") };
}

function describeEntry(entry: fs.Dirent): string {
  if (entry.isSymbolicLink()) return "a symbolic link";
  if (entry.isFIFO()) return "a named pipe";
  if (entry.isSocket()) return "a socket";
  if (entry.isBlockDevice() || entry.isCharacterDevice()) return "a device file";
  return "not a regular file";
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
    machineMaintenanceCommand(request.maintenance, remoteCommand)
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
  maintenance?: MachineMaintenanceTarget;
}): Promise<void> {
  const worker = workerSettingsFor(request.target) as CloudRunWorkerSettings & { host: string };
  const sshArgs = cloudRunSshOptionArgs(worker);
  const target = buildCloudRunSshTarget(worker);
  await runCommand("ssh", [...sshArgs, target, machineMaintenanceCommand(request.maintenance,
    `bash -c ${shellQuotePosix(`umask 077; mkdir -p ${shellQuotePosix(request.remoteDir)}`)}`)], {
    timeoutMs: 60_000
  });
  await runCommand("rsync", [
    "-az",
    "--delete",
    // Dependencies are installed inside the release directory on the machine;
    // deleting them on every re-upload would reinstall them for nothing.
    "--exclude=node_modules",
    ...(request.maintenance ? ["--rsync-path", machineMaintenanceCommand(request.maintenance, "rsync")] : []),
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
