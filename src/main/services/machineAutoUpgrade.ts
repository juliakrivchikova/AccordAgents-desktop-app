import type { MachineInstallRecord, MachineInstallResult, MachineInstallSnapshot, MachineUpgradeRequest } from "../../shared/machineInstall";
import { compareVersions } from "./machineInstaller";
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
 * its provider processes, which would cut a member's turn short.
 */
export interface MachineAutoUpgradeOptions {
  desktopVersion: string;
  listInstalls: () => Promise<MachineInstallRecord[]>;
  machineName: (machineId: string) => Promise<string | undefined>;
  /** Fresh activity of a connected machine; undefined when not connected. */
  machineActivity: (machineId: string) => Promise<MachineActivity | undefined>;
  /** Whether this desktop has a runtime payload to install at all. */
  payloadReady: () => boolean;
  upgrade: (request: MachineUpgradeRequest, onProgress: (snapshot: MachineInstallSnapshot) => void) => Promise<MachineInstallResult>;
  /** Progress for Settings → Machines; the installer's own snapshots are
   *  persisted by the installer, the waiting notice here is not. */
  onProgress: (snapshot: MachineInstallSnapshot) => void;
  onChanged?: () => Promise<void> | void;
  logger?: (event: string, payload: Record<string, unknown>) => void;
  now?: () => Date;
}

export class MachineAutoUpgradeService {
  /** Machines this process already tried, whatever the outcome. */
  private readonly attempted = new Set<string>();
  private readonly inFlight = new Set<string>();
  /** Machines told to wait for idle, so the notice is shown once. */
  private readonly waiting = new Set<string>();
  private evaluating: Promise<void> = Promise.resolve();

  constructor(private readonly options: MachineAutoUpgradeOptions) {}

  /** Re-checks every enrolled machine (or one). Calls are serialized so two
   *  triggers arriving together cannot start the same upgrade twice. */
  evaluate(machineId?: string): Promise<void> {
    const run = this.evaluating.then(() => this.evaluateNow(machineId));
    this.evaluating = run.catch(() => undefined);
    return run;
  }

  /** Whether a machine still waits for idle to be upgraded; the periodic
   *  re-check runs only while one does. */
  hasWaiting(): boolean {
    return this.waiting.size > 0;
  }

  private async evaluateNow(machineId?: string): Promise<void> {
    const records = (await this.options.listInstalls()).filter((record) => !machineId || record.machineId === machineId);
    for (const record of records) {
      await this.evaluateRecord(record);
    }
  }

  private async evaluateRecord(record: MachineInstallRecord): Promise<void> {
    const id = record.machineId;
    if (this.attempted.has(id) || this.inFlight.has(id)) return;
    // Never installed from here: there is no target to upgrade over.
    if (!record.installedVersion || !record.target?.host) return;
    const last = record.lastOperation;
    if (last && !isTerminalPhase(last.phase)) return; // a setup action is running
    if (last && last.phase !== "ready" && last.operationId.startsWith(this.operationPrefix())) {
      // This desktop version already failed on this machine; the row shows
      // why and the manual button is the way forward.
      return;
    }
    // The stored version is what this desktop last installed; only a machine
    // it says is behind is asked what it actually runs.
    if (compareVersions(this.options.desktopVersion, record.installedVersion) <= 0) {
      this.waiting.delete(id);
      return;
    }
    const activity = await this.options.machineActivity(id);
    if (!activity?.connected) {
      this.waiting.delete(id);
      return;
    }
    const running = activity.appVersion ?? record.installedVersion;
    if (compareVersions(this.options.desktopVersion, running) <= 0) {
      this.waiting.delete(id);
      return;
    }
    if (!this.options.payloadReady()) {
      this.log("machines.auto-upgrade.no-payload", { machineId: id, running, desktop: this.options.desktopVersion });
      return;
    }
    const name = (await this.options.machineName(id)) ?? id;
    if (machineActivityIsBusy(activity)) {
      if (!this.waiting.has(id)) {
        this.waiting.add(id);
        this.log("machines.auto-upgrade.waiting", { machineId: id, running, desktop: this.options.desktopVersion,
          activeRunIds: activity.activeRunIds, dispatchedRunIds: activity.dispatchedRunIds });
        this.options.onProgress({
          machineId: id,
          operationId: this.operationPrefix(),
          kind: "upgrade",
          phase: "preflight",
          message: `Waiting for ${name} to finish its current work before updating its runtime to ${this.options.desktopVersion}.`,
          updatedAt: this.now().toISOString(),
          completed: []
        });
      }
      return;
    }
    this.waiting.delete(id);
    this.attempted.add(id);
    this.inFlight.add(id);
    this.log("machines.auto-upgrade.start", { machineId: id, running, desktop: this.options.desktopVersion });
    try {
      const result = await this.options.upgrade({
        machineId: id,
        operationId: `${this.operationPrefix()}-${this.now().getTime()}`,
        target: record.target,
        installRoot: record.installRoot || undefined,
        userDataDir: record.userDataDir || undefined,
        serviceName: record.serviceName || undefined,
        isolatedProfile: record.isolatedProfile,
        machineName: name
      }, this.options.onProgress);
      this.log("machines.auto-upgrade.finished", { machineId: id, phase: result.snapshot.phase,
        installedVersion: result.record.installedVersion, message: result.snapshot.message });
    } catch (error) {
      // The installer records its own failures on the machine; this is the
      // case where it refused to start (another setup action was running).
      this.log("machines.auto-upgrade.error", { machineId: id, message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.inFlight.delete(id);
      await Promise.resolve(this.options.onChanged?.()).catch(() => undefined);
    }
  }

  private operationPrefix(): string {
    return `auto-upgrade-${this.options.desktopVersion}`;
  }

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  private log(event: string, payload: Record<string, unknown>): void {
    this.options.logger?.(event, payload);
  }
}

function isTerminalPhase(phase: MachineInstallSnapshot["phase"]): boolean {
  return phase === "ready" || phase === "error" || phase === "needs-attention";
}
