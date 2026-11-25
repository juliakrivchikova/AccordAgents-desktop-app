import { isMachineAutoUpgradeOperation, isMachineInstallTerminalPhase } from "../../../shared/machineInstall";
import type { MachineMaintenanceTarget } from "../machineMaintenanceCommand";
import { MACHINE_POWER_HANDOVER_TIMEOUT_MS } from "../../../shared/machinePower";
import type {
  MachineInstallKind, MachineInstallPhase, MachineInstallRecovery, MachineInstallResult, MachineInstallSnapshot,
  MachineUpgradeRequest
} from "../../../shared/machineInstall";
import { shellQuotePosix } from "../cloudRunWorkers";
import { isDiskSpaceFailure } from "../command";
import {
  DEFAULT_MACHINE_INSTALL_DIRNAME, DEFAULT_MACHINE_SERVICE_NAME, DEFAULT_MACHINE_USER_DATA_SUFFIX, machineActivateReleaseScript,
  machinePowerScript, machineDeviceIdentityScript, machineDrainScript, machineInstallDependenciesScript, machineInstallLayout,
  machineInstallServiceScript, machinePrepareDirectoriesScript, machineServiceUnit, machineStartServiceScript,
  parseMachineDrainReport, parseSetupCommandJson, writeFileFromStdinScript
} from "../machineInstallScripts";
import { CONNECT_TIMEOUT_MS, DEPENDENCIES_TIMEOUT_MS, DRAIN_TIMEOUT_MS, SHORT_TIMEOUT_MS, TRANSFER_TIMEOUT_MS } from "./constants";
import { errorMessage, MACHINE_DISK_FULL_MESSAGE, remoteCommandFailure } from "./failureText";
import {
  machinePowerNeedsDelivery, maintenanceFor, maintenanceForStagedRelease, missingRequirements, releaseName, versionFence
} from "./installChecks";
import { readMachineBundle } from "./machineBundle";
import { workerSettingsFor } from "./sshTransport";
import type { MachineSshExecRequest } from "./types";
import type { MachineInstallerModules } from "./modules";
import type { MachineInstallerDependencies } from "./dependencies";

/** One install or upgrade, step by step. */
export class InstallRun {
  constructor(
    private readonly installer: Pick<
      MachineInstallerModules,
      | "environmentOwner" | "installRecords" | "installRecovery" | "machineProbe" | "runtimePayload"
    >,
    private readonly deps: Pick<MachineInstallerDependencies, "now" | "options" | "sshExec" | "uploadBundle">
  ) {}

  async run(
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
    let record = await this.installer.installRecords.recordFor(request);
    let maintenance: MachineMaintenanceTarget | undefined;
    const exec = (input: MachineSshExecRequest): Promise<string> => this.deps.sshExec({ ...input, maintenance });
    let snapshot: MachineInstallSnapshot = {
      machineId: request.machineId,
      operationId: request.operationId,
      kind,
      phase: "preflight",
      message: "Checking the machine…",
      updatedAt: this.deps.now().toISOString(),
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
      const advancing = phase === "ready" || !isMachineInstallTerminalPhase(phase);
      if (advancing && snapshot.phase !== phase && !isMachineInstallTerminalPhase(snapshot.phase) && !completed.includes(snapshot.phase)) {
        completed.push(snapshot.phase);
      }
      snapshot = {
        machineId: record.machineId,
        operationId: request.operationId,
        kind,
        phase,
        message,
        updatedAt: this.deps.now().toISOString(),
        completed: [...completed],
        ...(warnings.length ? { warnings: [...warnings] } : {}),
        ...extra
      };
      // The projects on the machine are recorded by their copies, not by
      // this setup: what was read when it began may be out of date by now.
      const stored = await this.deps.options.store.getMachineInstall(record.machineId);
      record = { ...record, projects: stored?.projects ?? record.projects, lastOperation: snapshot };
      await this.deps.options.store.saveMachineInstall(record);
      onProgress?.(snapshot);
      this.deps.options.logger?.("machines.install.progress", {
        machineId: request.machineId, kind, phase, message
      });
      return snapshot;
    };

    // A stop key this run set out to hand over and has not yet settled: if the
    // run fails, that is recorded too, so an automatic update does not try
    // again on every hello.
    let pendingPowerKey: string | undefined;
    const fail = async (
      phase: MachineInstallPhase,
      message: string,
      recovery: MachineInstallRecovery,
      retryable = true
    ): Promise<MachineInstallResult> => {
      if (pendingPowerKey && recovery.kind !== "machine-busy") {
        // The failure itself is the message; the key only waits for a retry.
        record = this.installer.installRecovery.powerNotTaken(record, pendingPowerKey, new Error(message));
        pendingPowerKey = undefined;
      }
      const terminal = phase === "needs-attention" ? "needs-attention" : "error";
      await emit(terminal, message, { error: message, retryable, recovery });
      return { snapshot, record };
    };

    try {
      const worker = workerSettingsFor(request.target);
      // Read once, before anything else: the key handed over below is the one
      // this decision saw, and a run that fails anywhere records it, so an
      // automatic update does not try it again on every hello. An automatic
      // update hands a key over once, and after a temporary failure again an
      // hour later, a few times at most; the button also retries a key the
      // machine refused before. A fresh install always gets it.
      const power = await this.installer.installRecovery.machinePowerFor(record.machineId, request.target);
      let deliverPower = power !== undefined && (kind === "install"
        || (isMachineAutoUpgradeOperation(request.operationId)
          ? machinePowerNeedsDelivery(record, power, this.deps.now())
          : record.power?.keyId !== power.credentials.accessKeyId));
      if (power && deliverPower) pendingPowerKey = power.credentials.accessKeyId;
      // 1. Preflight. The doctor installs node/git/sqlite3, fixes the Codex
      //    sandbox setting, and performs the provider sign-in ON the machine.
      await emit("preflight", "Checking the machine…");
      const initial = await this.installer.machineProbe.probe(request.target, { installRoot: record.installRoot || undefined,
        userDataDir: record.userDataDir || undefined, serviceName: record.installRoot ? record.serviceName : request.serviceName });
      const recovered = await this.installer.environmentOwner.enrollmentForEnvironment({ machineId: request.machineId, target: request.target, installRoot: initial.installRoot, userDataDir: initial.userDataDir }, false, undefined, true);
      record = { ...record, machineId: recovered.machineId };
      const enrollmentJson = recovered.enrollment;
      await this.installer.environmentOwner.claimEnvironmentOwner(request.target, initial.installRoot, enrollmentJson);
      record = { ...record, installRoot: initial.installRoot, userDataDir: initial.userDataDir,
        serviceName: initial.serviceName,
        profileHome: record.profileHome ?? (record.isolatedProfile ? `${initial.installRoot}/home` : undefined) };
      worker.workerRoot = record.installRoot;
      if (record.profileHome) {
        await this.deps.sshExec({ target: request.target,
          script: `umask 077; mkdir -p ${shellQuotePosix(record.profileHome)}`,
          timeoutMs: SHORT_TIMEOUT_MS });
      }
      // A release older than maintenance would be started, not asked to hold a
      // lease, so it is never used as the wrapper. The steps before staging
      // then run unwrapped — they only create a NEW release directory and
      // cannot disturb a running runtime or an existing stop fence — and
      // everything from the drain onward is wrapped by the release just
      // staged, which does understand it.
      maintenance = initial.maintenanceCapable ? maintenanceFor(initial) : undefined;
      // A setup for one provider needs that one signed in. Installing the
      // program alone (from Settings → AWS, a recovery or an update) needs no
      // provider: nobody may be there to approve a sign-in, and a provider the
      // User has not signed in must not stop the program from installing.
      const doctorOptions = { requiredProviderKinds: request.requiredProvider ? [request.requiredProvider] : [], maintenance, profileHome: record.profileHome };
      let report = await this.deps.options.doctor.diagnose(worker, doctorOptions);
      if (!report.ok) {
        // Each doctor frame saves a snapshot, so
        // the writes are chained: an out-of-order save would leave the record
        // showing an earlier step than the one the User is looking at.
        let progressWrites: Promise<unknown> = Promise.resolve();
        report = await this.deps.options.doctor.setup(worker, (progress) => {
          progressWrites = progressWrites.then(() => emit("preflight", progress.message, {
            authUrl: progress.authUrl,
            authCode: progress.authCode,
            authProvider: progress.authProvider,
            authRequestId: progress.authRequestId
          }));
          return progressWrites;
        }, doctorOptions);
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

      // Keep the first probe's resolved paths and unit name across setup.
      const probe = await this.installer.machineProbe.probe(request.target, {
        installRoot: record.installRoot,
        userDataDir: record.userDataDir,
        serviceName: record.serviceName
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
      if (this.deps.options.prepareProfile) {
        await emit("preflight", "Syncing your global skills to the machine…");
        await this.deps.options.prepareProfile(record);
      }

      // 2. The bundle this desktop would install.
      await emit("bundle", "Reading the runtime bundle…");
      const location = this.installer.runtimePayload.payloadLocation();
      const bundle = readMachineBundle(location.dir, {
        source: location.source,
        expectVersion: location.expectVersion
      });
      stagedVersion = bundle.version;
      const nodePath = probe.nodePath ?? "/usr/bin/node";
      let powerConfigured = false;
      const fence = versionFence(kind, probe, bundle, request.allowDowngrade === true);
      if (fence) {
        return await fail("error", fence, {
          kind: "nothing-changed",
          detail: "The machine was not changed.",
          activeVersion: probe.installedVersion
        });
      }
      const release = releaseName(bundle);
      const previousRelease = probe.activeRelease;
      const alreadyRuns = probe.installedDigest === bundle.digest && probe.serviceState === "active" && kind === "upgrade";
      if (alreadyRuns && !deliverPower) {
        await emit("ready", `Machine already runs ${bundle.version}.`, {
          installedVersion: bundle.version, previousVersion: probe.installedVersion
        });
        return { snapshot, record };
      }
      // Only the stop key is new: the release that runs is the one to keep, so
      // nothing is copied or rebuilt; the runtime is restarted to read the key.
      const restageRelease = !(alreadyRuns && previousRelease === release);

      // 3. Stage the new release beside the running one. Nothing that runs is
      //    touched yet, so a failure here leaves the machine exactly as it was.
      if (restageRelease) {
        await exec({ target: request.target, script: machinePrepareDirectoriesScript(layout), timeoutMs: SHORT_TIMEOUT_MS });
        await emit("transfer", `Copying runtime ${bundle.version} to the machine…`);
        await this.deps.uploadBundle({
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
          // A full disk fails here first and is not a build-tools problem.
          if (isDiskSpaceFailure(error)) throw new Error(MACHINE_DISK_FULL_MESSAGE);
          // The one native dependency (node-pty) is compiled on the machine, so
          // this is where a box without build tools or without network fails.
          throw new Error(
            `Installing the runtime's dependencies on the machine failed. The machine needs network access and build tools (python3, make, a C++ compiler) to compile node-pty. ${errorMessage(error)}`
          );
        }
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

      // The stop key is checked with AWS while the runtime still serves
      // members (a new IAM key can take up to a minute to be accepted), with
      // the release about to run. The drain below then only writes it.
      if (power && deliverPower) {
        await emit("enroll", "Checking the automatic-stop key with AWS…");
        const keyId = power.credentials.accessKeyId;
        try {
          await exec({
            target: request.target,
            script: machinePowerScript(layout, nodePath, "check", `${layout.releasesDir}/${release}`),
            input: JSON.stringify(power),
            // Outlasts the machine's own check with AWS, so its answer arrives.
            timeoutMs: MACHINE_POWER_HANDOVER_TIMEOUT_MS
          });
        } catch (error) {
          record = this.installer.installRecovery.powerNotTaken(record, keyId, error, warnings);
          pendingPowerKey = undefined;
          deliverPower = false;
          if (alreadyRuns) {
            // Only the key was due, and it is not handed over: nothing changes.
            await emit("ready", `Machine already runs ${bundle.version}.`, {
              installedVersion: bundle.version, previousVersion: probe.installedVersion
            });
            return { snapshot, record };
          }
        }
      }

      // 4. Enrollment. Written from stdin; the relay key never reaches a
      //    command line or a log. An upgrade keeps the pairing that is there.
      if (!probe.enrollmentPresent || kind === "install") {
        await emit("enroll", "Installing the enrollment…");
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
      // Only a stop key is due: a runtime that already runs this release is
      // stopped for it only when idle, whoever asked.
      const busyReason = await this.deps.options.beforeDrain?.(record, request.operationId, alreadyRuns ? "key" : "update").catch(() => undefined);
      if (busyReason) {
        return await fail(
          "needs-attention",
          busyReason,
          {
            kind: "machine-busy",
            detail: alreadyRuns
              ? "Nothing was changed: the machine keeps running. Its automatic-stop key is handed over once the machine is idle."
              : `Nothing was replaced: ${probe.installedVersion ?? "the installed version"} is still the one the machine runs, `
                + `and the new files are staged in ${layout.releasesDir}/${release} without being used. `
                + "The update is attempted again once the machine is idle.",
            activeVersion: probe.installedVersion
          }
        );
      }
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

      // 5b. Identity. The staged runtime says which key it signs with (made
      //     once, kept in the machine's own database), read while nothing
      //     runs here. A failure replaces nothing and puts the old runtime back.
      if (this.deps.options.adoptIdentity && (kind === "install" || !await this.deps.options.identityKnown?.(record.machineId).catch(() => false))) {
        await emit("identity", "Reading the machine's identity…");
        const runtimePath = `${layout.releasesDir}/${release}/accordagents-machine.cjs`;
        const nodePath = probe.nodePath ?? "node";
        try {
          const identity = parseSetupCommandJson<{ originId: string; publicKeyDerBase64: string }>(await exec({
            target: request.target,
            script: machineDeviceIdentityScript(layout, runtimePath, nodePath),
            timeoutMs: SHORT_TIMEOUT_MS
          }));
          if (typeof identity.originId !== "string" || !identity.originId || typeof identity.publicKeyDerBase64 !== "string") {
            throw new Error("The machine did not report its identity.");
          }
          await this.deps.options.adoptIdentity(record.machineId, identity);
          this.deps.options.logger?.("machines.install.identity", { machineId: record.machineId, deviceId: identity.originId });
        } catch (error) {
          if (wasRunning) {
            await exec({ target: request.target, script: machineStartServiceScript(layout), timeoutMs: SHORT_TIMEOUT_MS }).catch(() => undefined);
          }
          return await fail("error", `Reading the machine's identity failed: ${remoteCommandFailure(error)}`, {
            kind: "old-runtime-still-installed",
            detail: `Nothing was replaced: ${probe.installedVersion ?? "the installed version"} is still the one the machine runs`
              + `${wasRunning ? ", and it was started again" : ""}. The new files are staged in ${layout.releasesDir}/${release}. Retry when the cause is fixed.`,
            activeVersion: probe.installedVersion
          });
        }
      }

      // 6. Flip, install the unit, start.
      await emit("activate", `Switching the machine to ${bundle.version}…`);
      const installedAt = this.deps.now().toISOString();
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
      const machineName = (await this.deps.options.machineName?.(record.machineId)) ?? request.machineName ?? record.machineId;
      const unit = machineServiceUnit({
        layout,
        machineName,
        home: record.profileHome ?? probe.home,
        profileHome: record.profileHome,
        user: request.target.user ?? "ubuntu",
        nodePath,
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

      // The runtime is drained, so nothing else writes its settings, and it
      // reads the key when it starts below. AWS has already accepted the key;
      // this only seals it on the machine. A failure does not fail the update:
      // the machine runs as before and the key is handed over again later.
      // The key counts as taken only once the runtime has started with it.
      if (power && deliverPower) {
        await emit("service", "Setting up automatic stop after three idle hours…");
        try {
          await exec({
            target: request.target,
            script: machinePowerScript(layout, nodePath, "configure"),
            input: JSON.stringify(power),
            timeoutMs: SHORT_TIMEOUT_MS
          });
          powerConfigured = true;
          this.deps.options.logger?.("machines.install.power-configured", { machineId: record.machineId, keyId: power.credentials.accessKeyId });
        } catch (error) {
          record = this.installer.installRecovery.powerNotTaken(record, power.credentials.accessKeyId, error, warnings);
          pendingPowerKey = undefined;
        }
      }

      // 7. The machine is installed when it says hello over the relay, not
      //    when systemd says the unit started. A connection alone is not
      //    proof either: a unit that failed to restart can leave an older
      //    process connected, so read back which release actually runs.
      const startAndVerify = async (): Promise<boolean> => {
        await exec({ target: request.target, script: machineStartServiceScript(layout), timeoutMs: SHORT_TIMEOUT_MS });
        await emit("verify", "Waiting for the machine to connect…");
        if (!await this.deps.options.waitForConnected(record.machineId, CONNECT_TIMEOUT_MS, bundle.version)) return false;
        const after = await this.installer.machineProbe.probe(request.target, layout).catch(() => undefined);
        return after === undefined || (after.activeRelease === release && after.serviceState === "active");
      };
      await emit("starting", "Starting the machine runtime…");
      // With a new key sealed, a start that errors is a runtime that did not
      // come back: the key's previous setting is put back below.
      const started = powerConfigured ? await startAndVerify().catch(() => false) : await startAndVerify();
      if (!started) {
        const serviceLog = await this.installer.machineProbe.readServiceLog(request.target, layout);
        const rollsBack = kind === "upgrade" && Boolean(previousRelease) && previousRelease !== release;
        // The runtime did not come back after taking a new key. The cause is
        // as likely the relay or the release as the key (AWS accepted it), so
        // the key it ran with before (or none) is put back, the runtime is
        // started again either way, and the new key is tried again later
        // rather than marked refused.
        if (power && powerConfigured) {
          const { drain, reverted } = await this.installer.installRecovery.revertPower(record.machineId, request.target, layout, nodePath, maintenance);
          const drained = drain?.drained === true;
          const message = reverted
            ? "The machine did not come back after taking the new stop key, so its previous setting was put back."
            : "The machine did not come back after taking the new stop key, and putting its previous setting back failed.";
          // Reverted, the machine has the key its record already names; not
          // reverted, nothing is known about the key it has.
          record = this.installer.installRecovery.powerNotTaken({ ...record, ...(reverted ? {} : { power: undefined }) },
            power.credentials.accessKeyId, new Error(message), warnings);
          pendingPowerKey = undefined;
          // Started again only over a proven drain: something of the old
          // runtime still alive beside a new one would run a member twice.
          if (drain && !drained) {
            // Something of the runtime is still alive: starting another beside
            // it would run a member twice, so it is left stopped, as the main
            // drain does.
            return await fail("needs-attention", "The machine's runtime did not stop after the stop key was handed over, so it was not started again.", {
              kind: "manual-drain-required",
              detail: [drain.detail, "Stop the processes listed below on the machine, then retry."].filter(Boolean).join(" "),
              activeVersion: bundle.version,
              blockingPids: [...drain.runtimePids, ...drain.supervisorPids, ...drain.providerPids]
            });
          }
          if (drained && !rollsBack && await startAndVerify().catch(() => false)) {
            // A revert that did not confirm may still have run, so nothing is
            // claimed about the key: it is handed over again, which is harmless.
            record = { ...record, installedVersion: bundle.version, installedDigest: bundle.digest, installedAt };
            await emit("ready", reverted
              ? `Machine is running ${bundle.version} with its previous automatic-stop setting.`
              : `Machine is running ${bundle.version}.`, {
              installedVersion: bundle.version,
              previousVersion: probe.installedVersion
            });
            return { snapshot, record };
          }
        }
        if (rollsBack && previousRelease) {
          const rolledBack = await this.installer.installRecovery.rollback(request.target, layout, previousRelease, probe);
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
        installedAt,
        ...(power && powerConfigured
          ? { power: { keyId: power.credentials.accessKeyId, configuredAt: this.deps.now().toISOString() }, powerError: undefined, powerRetry: undefined }
          : {})
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
}
