import type { MachineInstallRecord } from "../../shared/machineInstall";

/** How long the program may be out of touch before it is set up again. */
export const MACHINE_RECOVERY_AFTER_MS = 5 * 60_000;
/** How long after its own start this desktop waits before judging. */
export const MACHINE_RECOVERY_LINK_GRACE_MS = 60_000;
/** Between two attempts on one machine, so a failing setup does not loop. */
export const MACHINE_RECOVERY_RETRY_MS = 15 * 60_000;
/** Checks further apart than this mean the desktop slept or hung: what was
 *  seen before says nothing about now, so the watch starts again. */
export const MACHINE_RECOVERY_WATCH_GAP_MS = 3 * 60_000;

/** What this desktop sees of a machine over the relay: there, missing while
 *  the relay is reachable, or unknown because this side cannot reach it. */
export type MachineRecoveryLinkState = "connected" | "out-of-touch" | "unknown";

export interface MachineRecoveryOptions {
  now(): number;
  /** When this desktop started connecting to its machines; unknown before. */
  linkStartedAt(): number | undefined;
  linkState(machineId: string): MachineRecoveryLinkState;
  /** The machine on this app's AWS instance, as this desktop installed it. */
  machineOnInstance(): Promise<MachineInstallRecord | undefined>;
  /** When the instance last started, while it runs; undefined otherwise. */
  instanceRunningSince(): Promise<number | undefined>;
  /** A setup of this machine is already running. */
  setupRunning(machineId: string): boolean;
  /** Whether agents of this deployment are running on the machine, asked
   *  over SSH: its program being out of touch says nothing about them. */
  agentsRunning(record: MachineInstallRecord): Promise<boolean>;
  /** Sets the program on the instance up again, as choosing Cloud run does. */
  reinstall(): Promise<void>;
  log(event: string, payload: Record<string, unknown>): void;
}

/**
 * Brings the program on the cloud machine back by itself.
 *
 * Without that program nothing works in the cloud: members cannot run there
 * and the instance never stops by itself. It used to wait for the User to
 * notice; after one interrupted update it stayed down for nine days. Here the
 * desktop notices instead: the instance is running, the program has been out
 * of touch for five minutes while this desktop reaches the relay, and no
 * agent of this deployment is running on the machine. Only when setting it up again fails is the User told, and it
 * keeps being tried.
 */
export class MachineRecoveryService {
  /** Since when, by this desktop's own observation, each machine has been
   *  out of touch. A machine this desktop has not watched yet starts now. */
  private readonly outOfTouchSince = new Map<string, number>();
  private readonly lastAttemptAt = new Map<string, number>();
  private readonly failures = new Map<string, string>();
  private lastCheckAt?: number;
  private running?: Promise<void>;

  constructor(private readonly options: MachineRecoveryOptions) {}

  /** Why the program could not be brought back, if the last attempt failed. */
  failure(machineId: string): string | undefined {
    return this.failures.get(machineId);
  }

  /** One check; overlapping calls share the check in progress. */
  check(): Promise<void> {
    this.running ??= this.checkNow().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async checkNow(): Promise<void> {
    const now = this.options.now();
    const previousCheckAt = this.lastCheckAt;
    this.lastCheckAt = now;
    if (previousCheckAt !== undefined && now - previousCheckAt > MACHINE_RECOVERY_WATCH_GAP_MS) this.outOfTouchSince.clear();
    const linkStartedAt = this.options.linkStartedAt();
    if (linkStartedAt === undefined || now - linkStartedAt < MACHINE_RECOVERY_LINK_GRACE_MS) return;
    const record = await this.options.machineOnInstance();
    if (!record?.installedVersion) return;
    const id = record.machineId;
    const link = this.options.linkState(id);
    if (link === "connected") {
      this.outOfTouchSince.delete(id);
      if (this.failures.delete(id)) this.options.log("machines.recovery.recovered", { machineId: id });
      return;
    }
    // This side cannot reach the relay: the program may be fine, and setting
    // it up again would not bring the relay back.
    if (link === "unknown") {
      this.outOfTouchSince.delete(id);
      return;
    }
    const since = this.outOfTouchSince.get(id) ?? now;
    this.outOfTouchSince.set(id, since);
    if (now - since < MACHINE_RECOVERY_AFTER_MS || this.options.setupRunning(id)) return;
    const lastAttempt = this.lastAttemptAt.get(id);
    if (lastAttempt !== undefined && now - lastAttempt < MACHINE_RECOVERY_RETRY_MS) return;
    // A stopped instance has no program to run; one that just started is
    // still bringing it up.
    const runningSince = await this.options.instanceRunningSince().catch(() => undefined);
    if (runningSince === undefined || now - runningSince < MACHINE_RECOVERY_AFTER_MS) return;
    this.lastAttemptAt.set(id, now);
    try {
      if (await this.options.agentsRunning(record)) {
        this.options.log("machines.recovery.waiting", { machineId: id, reason: "agents-running" });
        return;
      }
      this.options.log("machines.recovery.start", { machineId: id, outOfTouchMs: now - since });
      await this.options.reinstall();
      this.failures.delete(id);
      this.options.log("machines.recovery.finished", { machineId: id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.failures.set(id, message);
      this.options.log("machines.recovery.failed", { machineId: id, message });
    }
  }
}
