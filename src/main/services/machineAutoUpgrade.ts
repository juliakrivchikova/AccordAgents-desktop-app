import {
  compareVersions,
  isMachineInstallTerminalPhase,
  isAutoUpgradeOf,
  machineAutoUpgradeOperationPrefix,
  type MachineInstallRecord,
  type MachineInstallResult,
  type MachineInstallSnapshot,
  type MachineSshTarget,
  type MachineUpgradeRequest
} from "../../shared/machineInstall";
import { machineActivityIsBusy, type MachineActivity } from "./machineLink";

/**
 * Machines update together with the desktop.
 *
 * The desktop is the only thing that ever installs a machine's runtime, and
 * it ships that runtime in its own bundle, so a desktop that has just updated
 * is exactly the moment a machine's runtime became old. Nothing here asks the
 * User: a machine whose runtime is older than this desktop is upgraded as soon
 * as it is connected and idle, with the same progress the manual button
 * shows. The manual button stays for recovery — this makes one attempt per
 * machine per desktop version and, when that attempt fails, leaves the
 * failure on the machine's row rather than retrying into the same wall.
 *
 * "Idle" is asked from the machine itself (a fresh hello) rather than read
 * off the hello it sent when it connected: upgrading drains the runtime and
 * its provider processes, which would cut a member's turn short. While the
 * upgrade runs, turns for the machine are held rather than dispatched, and
 * the installer asks once more right before the drain.
 */
export interface MachineAutoUpgradeOptions {
  desktopVersion: string;
  listInstalls: () => Promise<MachineInstallRecord[]>;
  machineName: (machineId: string) => Promise<string | undefined>;
  /** Fresh activity of a connected machine; undefined when not connected. */
  machineActivity: (machineId: string) => Promise<MachineActivity | undefined>;
  /** Where the machine is reached right now. An AWS instance gets a new
   *  public address every stop/start, so the install record's address may
   *  be dead; undefined means the machine cannot be reached for an upgrade. */
  resolveTarget: (record: MachineInstallRecord) => Promise<MachineSshTarget | undefined>;
  /** Whether this desktop has a runtime payload to install at all. */
  payloadReady: () => { ok: true } | { ok: false; message: string };
  upgrade: (request: MachineUpgradeRequest, onProgress: (snapshot: MachineInstallSnapshot) => void) => Promise<MachineInstallResult>;
  /** The id of an AWS stop key this machine has not taken yet, if any. It is
   *  handed over by the same idle-gated update (the runtime reads it when it
   *  starts), once per key, even when the runtime is already current. */
  powerDue?: (record: MachineInstallRecord) => Promise<string | undefined>;
  /** How long after a temporary failure a stop key is tried again
   *  (MACHINE_POWER_RETRY_MS), and how many temporary failures end the
   *  automatic tries (MACHINE_POWER_MAX_ATTEMPTS); the installer's record
   *  enforces both. */
  powerRetryMs?: number;
  powerMaxAttempts?: number;
  /** Holds the machine's turns for the duration; returns the release. */
  holdTurns?: (machineId: string, reason: string) => () => void;
  /** Progress for Settings → Machines; the installer's own snapshots are
   *  persisted by the installer, the notices here are not. */
  onProgress: (snapshot: MachineInstallSnapshot) => void;
  onChanged?: () => Promise<void> | void;
  logger?: (event: string, payload: Record<string, unknown>) => void;
}

export class MachineAutoUpgradeService {
  /** Machines whose runtime version update this process already tried,
   *  whatever the outcome. */
  private readonly attempted = new Set<string>();
  /** `machineId:keyId` stop-key handovers this process already tried. */
  private readonly attemptedPower = new Set<string>();
  /** Stop-key retries waiting for their time, one per machine. */
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Set<string>();
  /** Machines told to wait for idle, so the notice is shown once. */
  private readonly waiting = new Set<string>();
  /** Machines told why nothing can be attempted, so the notice is shown once. */
  private readonly noticed = new Set<string>();
  /** Machines the User asked to try again: an update of this version that
   *  already failed on them is attempted once more. */
  private readonly retryRequested = new Set<string>();
  private evaluating: Promise<void> = Promise.resolve();

  constructor(private readonly options: MachineAutoUpgradeOptions) {}

  /** Re-checks every enrolled machine (or one). Calls are serialized so two
   *  triggers arriving together cannot start the same upgrade twice, and a
   *  trigger never rejects: a failure is logged. */
  evaluate(machineId?: string): Promise<void> {
    const run = this.evaluating.then(() => this.evaluateNow(machineId)).catch((error) => {
      this.log("machines.auto-upgrade.evaluate-error", { machineId: machineId ?? "", message: error instanceof Error ? error.message : String(error) });
    });
    this.evaluating = run;
    return run;
  }

  /**
   * The User asked to try again. What this process already tried for the
   * machine, and an update of this version that failed on it, no longer hold
   * it back; the attempt still waits for the machine to be idle and holds new
   * turns, as every automatic update does.
   */
  retry(machineId: string): Promise<void> {
    this.attempted.delete(machineId);
    for (const attempt of [...this.attemptedPower]) if (attempt.startsWith(`${machineId}:`)) this.attemptedPower.delete(attempt);
    this.noticed.delete(machineId);
    this.retryRequested.add(machineId);
    return this.evaluate(machineId);
  }

  /** Whether a machine still waits for idle to be upgraded; the periodic
   *  re-check runs only while one does. */
  hasWaiting(): boolean {
    return this.waiting.size > 0;
  }

  private async evaluateNow(machineId?: string): Promise<void> {
    const all = await this.options.listInstalls();
    // A machine removed while it waited must not keep the re-check alive.
    const known = new Set(all.map((record) => record.machineId));
    for (const id of [...this.waiting]) if (!known.has(id)) this.waiting.delete(id);
    for (const record of all.filter((record) => !machineId || record.machineId === machineId)) {
      await this.evaluateRecord(record);
    }
  }

  private async evaluateRecord(record: MachineInstallRecord): Promise<void> {
    const id = record.machineId;
    if (this.inFlight.has(id)) return;
    // Never installed from here: there is no target to upgrade over.
    if (!record.installedVersion || !record.target?.host) return this.settle(id);
    const last = record.lastOperation;
    if (last && !isMachineInstallTerminalPhase(last.phase)) return; // a setup action is running
    // This desktop version already failed on this machine; the row shows why
    // and the manual button is the way forward.
    const versionFailed = Boolean(last && last.phase !== "ready" && isAutoUpgradeOf(last.operationId, this.options.desktopVersion)
      && last.recovery?.kind !== "machine-busy") && !this.retryRequested.has(id);
    // The stored version is what this desktop last installed; only a machine
    // it says is behind is asked what it actually runs.
    const versionDue = !this.attempted.has(id) && !versionFailed
      && compareVersions(this.options.desktopVersion, record.installedVersion) > 0;
    // Handing over a key reinstalls this desktop's runtime, so it never goes
    // to a machine this desktop knows runs a newer one.
    const powerKey = compareVersions(this.options.desktopVersion, record.installedVersion) >= 0
      ? await this.options.powerDue?.(record).catch(() => undefined)
      : undefined;
    // One attempt per key and per state of its record: a temporary failure the
    // installer records makes a new state, which may be tried once it is due
    // again; a run that changed nothing is not repeated on every hello.
    const retryStamp = powerKey !== undefined && record.powerRetry?.keyId === powerKey ? record.powerRetry.failedAt : "";
    const powerAttempt = powerKey === undefined ? undefined : `${id}:${powerKey}:${retryStamp}`;
    const powerDue = powerAttempt !== undefined && !this.attemptedPower.has(powerAttempt);
    if (!versionDue && !powerDue) {
      // A key that failed for a temporary reason before this process (or by
      // the button) waits for its time with nothing else to bring it back.
      const retry = record.powerRetry;
      if (retry && !this.retries.has(id) && (retry.attempts ?? 1) < (this.options.powerMaxAttempts ?? 3)) {
        const dueAt = Date.parse(retry.failedAt) + (this.options.powerRetryMs ?? 60 * 60_000);
        if (Number.isFinite(dueAt) && dueAt > Date.now()) this.scheduleRetry(id, dueAt - Date.now());
      }
      return this.settle(id);
    }
    const activity = await this.options.machineActivity(id);
    if (!activity?.connected) return this.settle(id);
    const running = activity.appVersion ?? record.installedVersion;
    const versionOrder = compareVersions(this.options.desktopVersion, running);
    const upgrade = versionDue && versionOrder > 0;
    // Nor does a key re-run an update of this version that already failed here.
    const power = powerDue && versionOrder >= 0 && !(versionOrder > 0 && versionFailed);
    if (!upgrade && !power) {
      // Asked once per key: a machine that cannot take it now is not probed again.
      if (powerAttempt) this.attemptedPower.add(powerAttempt);
      return this.settle(id);
    }
    const name = (await this.options.machineName(id)) ?? id;
    const purpose = upgrade ? `updating its runtime to ${this.options.desktopVersion}` : "setting up its automatic stop after three idle hours";
    const payload = this.options.payloadReady();
    if (!payload.ok) {
      if (!this.noticed.has(id)) {
        this.noticed.add(id);
        this.log("machines.auto-upgrade.no-payload", { machineId: id, running, desktop: this.options.desktopVersion, message: payload.message });
        this.options.onProgress(this.notice(id, "error", upgrade
          ? `The runtime on ${name} cannot be updated from this desktop: ${payload.message}`
          : `Automatic stop cannot be set up on ${name} from this desktop: ${payload.message}`, { error: payload.message }));
      }
      return;
    }
    if (!activity.fresh || machineActivityIsBusy(activity)) {
      if (!this.waiting.has(id)) {
        this.waiting.add(id);
        this.log("machines.auto-upgrade.waiting", { machineId: id, running, desktop: this.options.desktopVersion, fresh: activity.fresh,
          power, activeRunIds: activity.activeRunIds, dispatchedRunIds: activity.dispatchedRunIds });
        this.options.onProgress(this.notice(id, "preflight", activity.fresh
          ? `Waiting for ${name} to finish its current work before ${purpose}.`
          : `Waiting for ${name} to report what it is doing before ${purpose}.`));
      }
      return;
    }
    const target = await this.options.resolveTarget(record);
    if (!target?.host) {
      // Its address is not known right now (AWS throttled, instance state
      // changing); the periodic re-check asks again.
      if (!this.waiting.has(id)) {
        this.waiting.add(id);
        this.log("machines.auto-upgrade.unreachable", { machineId: id, running, desktop: this.options.desktopVersion });
      }
      return;
    }
    this.waiting.delete(id);
    this.retryRequested.delete(id);
    if (upgrade) this.attempted.add(id);
    if (power && powerAttempt) this.attemptedPower.add(powerAttempt);
    this.inFlight.add(id);
    this.log("machines.auto-upgrade.start", { machineId: id, running, desktop: this.options.desktopVersion, upgrade, power });
    const release = this.options.holdTurns?.(id, upgrade
      ? `updating the runtime to ${this.options.desktopVersion}; the turn starts when the update is done`
      : "setting up automatic stop on the machine; the turn starts when that is done");
    try {
      const result = await this.options.upgrade({
        machineId: id,
        operationId: `${this.operationPrefix()}-${Date.now()}`,
        target,
        installRoot: record.installRoot || undefined,
        userDataDir: record.userDataDir || undefined,
        serviceName: record.serviceName || undefined,
        isolatedProfile: record.isolatedProfile,
        machineName: name
      }, this.options.onProgress);
      this.log("machines.auto-upgrade.finished", { machineId: id, phase: result.snapshot.phase,
        installedVersion: result.record.installedVersion, message: result.snapshot.message });
      if (result.snapshot.recovery?.kind === "machine-busy") {
        // The machine started work while the release was being staged and
        // the installer left its runtime alone: not a failure, try again when
        // it is idle.
        this.attempted.delete(id);
        if (powerAttempt) this.attemptedPower.delete(powerAttempt);
        this.waiting.add(id);
      } else if (power && powerKey && result.record.powerRetry?.keyId === powerKey && result.record.powerRetry.failedAt !== retryStamp
        && (result.record.powerRetry.attempts ?? 1) < (this.options.powerMaxAttempts ?? 3)) {
        // A temporary failure this run recorded: the record says when the key
        // may be tried again, and powerDue reads it. Nothing else may come
        // along at the right time, so come back then.
        this.scheduleRetry(id);
      }
    } catch (error) {
      // The installer records its own failures on the machine; this is the
      // case where it refused to start (another setup action was running).
      this.log("machines.auto-upgrade.error", { machineId: id, message: error instanceof Error ? error.message : String(error) });
    } finally {
      release?.();
      this.inFlight.delete(id);
      await Promise.resolve(this.options.onChanged?.()).catch(() => undefined);
    }
  }

  /** One pending retry per machine, however many attempts ended. */
  private scheduleRetry(id: string, delayMs = this.options.powerRetryMs ?? 60 * 60_000): void {
    clearTimeout(this.retries.get(id));
    const timer = setTimeout(() => { this.retries.delete(id); void this.evaluate(id); }, Math.max(0, delayMs));
    timer.unref?.();
    this.retries.set(id, timer);
  }

  /** Nothing to wait for on this machine any more. */
  private settle(id: string): void {
    this.waiting.delete(id);
  }

  private notice(machineId: string, phase: MachineInstallSnapshot["phase"], message: string, extra: Partial<MachineInstallSnapshot> = {}): MachineInstallSnapshot {
    return { machineId, operationId: this.operationPrefix(), kind: "upgrade", phase, message, updatedAt: new Date().toISOString(), completed: [], ...extra };
  }

  private operationPrefix(): string {
    return machineAutoUpgradeOperationPrefix(this.options.desktopVersion);
  }

  private log(event: string, payload: Record<string, unknown>): void {
    this.options.logger?.(event, payload);
  }
}
