import {
  compareVersions,
  isMachineInstallTerminalPhase,
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
  /** Holds the machine's turns for the duration; returns the release. */
  holdTurns?: (machineId: string, reason: string) => () => void;
  /** Progress for Settings → Machines; the installer's own snapshots are
   *  persisted by the installer, the notices here are not. */
  onProgress: (snapshot: MachineInstallSnapshot) => void;
  onChanged?: () => Promise<void> | void;
  logger?: (event: string, payload: Record<string, unknown>) => void;
}

export class MachineAutoUpgradeService {
  /** Machines this process already tried, whatever the outcome. */
  private readonly attempted = new Set<string>();
  private readonly inFlight = new Set<string>();
  /** Machines told to wait for idle, so the notice is shown once. */
  private readonly waiting = new Set<string>();
  /** Machines told why nothing can be attempted, so the notice is shown once. */
  private readonly noticed = new Set<string>();
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
    if (this.attempted.has(id) || this.inFlight.has(id)) return;
    // Never installed from here: there is no target to upgrade over.
    if (!record.installedVersion || !record.target?.host) return this.settle(id);
    const last = record.lastOperation;
    if (last && !isMachineInstallTerminalPhase(last.phase)) return; // a setup action is running
    if (last && last.phase !== "ready" && last.operationId.startsWith(this.operationPrefix()) && last.recovery?.kind !== "machine-busy") {
      // This desktop version already failed on this machine; the row shows
      // why and the manual button is the way forward.
      return this.settle(id);
    }
    // The stored version is what this desktop last installed; only a machine
    // it says is behind is asked what it actually runs.
    if (compareVersions(this.options.desktopVersion, record.installedVersion) <= 0) return this.settle(id);
    const activity = await this.options.machineActivity(id);
    if (!activity?.connected) return this.settle(id);
    const running = activity.appVersion ?? record.installedVersion;
    if (compareVersions(this.options.desktopVersion, running) <= 0) return this.settle(id);
    const name = (await this.options.machineName(id)) ?? id;
    const payload = this.options.payloadReady();
    if (!payload.ok) {
      if (!this.noticed.has(id)) {
        this.noticed.add(id);
        this.log("machines.auto-upgrade.no-payload", { machineId: id, running, desktop: this.options.desktopVersion, message: payload.message });
        this.options.onProgress(this.notice(id, "error", `The runtime on ${name} cannot be updated from this desktop: ${payload.message}`, { error: payload.message }));
      }
      return;
    }
    if (!activity.fresh || machineActivityIsBusy(activity)) {
      if (!this.waiting.has(id)) {
        this.waiting.add(id);
        this.log("machines.auto-upgrade.waiting", { machineId: id, running, desktop: this.options.desktopVersion, fresh: activity.fresh,
          activeRunIds: activity.activeRunIds, dispatchedRunIds: activity.dispatchedRunIds });
        this.options.onProgress(this.notice(id, "preflight", activity.fresh
          ? `Waiting for ${name} to finish its current work before updating its runtime to ${this.options.desktopVersion}.`
          : `Waiting for ${name} to report what it is doing before updating its runtime to ${this.options.desktopVersion}.`));
      }
      return;
    }
    const target = await this.options.resolveTarget(record);
    if (!target?.host) {
      if (!this.noticed.has(id)) {
        this.noticed.add(id);
        this.log("machines.auto-upgrade.unreachable", { machineId: id, running, desktop: this.options.desktopVersion });
      }
      return;
    }
    this.waiting.delete(id);
    this.attempted.add(id);
    this.inFlight.add(id);
    this.log("machines.auto-upgrade.start", { machineId: id, running, desktop: this.options.desktopVersion });
    const release = this.options.holdTurns?.(id, `updating the runtime to ${this.options.desktopVersion}; the turn starts when the update is done`);
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
        this.waiting.add(id);
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
