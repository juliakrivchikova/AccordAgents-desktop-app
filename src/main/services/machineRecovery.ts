import type { MachineInstallRecord } from "../../shared/machineInstall";

/** How long the program may be out of touch before the machine is asked. */
export const MACHINE_RECOVERY_AFTER_MS = 5 * 60_000;
/** How long after its own start this desktop waits before judging. */
export const MACHINE_RECOVERY_LINK_GRACE_MS = 60_000;
/** Between two looks at one machine; doubled after each failed setup, up to
 *  MACHINE_RECOVERY_MAX_RETRY_MS, so a failing setup does not loop. */
export const MACHINE_RECOVERY_RETRY_MS = 15 * 60_000;
export const MACHINE_RECOVERY_MAX_RETRY_MS = 4 * 60 * 60_000;
/** A program that runs but stays out of touch this long is reported. */
export const MACHINE_RECOVERY_RUNNING_REPORT_MS = 30 * 60_000;
/** Timer ticks this far apart mean the desktop slept or hung, even in the
 *  middle of a check: what was seen before says nothing about now, so the
 *  watch starts again. A check that itself takes long is not such a gap: the
 *  timer keeps ticking through it. */
export const MACHINE_RECOVERY_WATCH_GAP_MS = 3 * 60_000;

/** What this desktop sees of a machine over the relay: there, missing while
 *  the relay is reachable, or unknown because this side cannot reach it. */
export type MachineRecoveryLinkState = "connected" | "out-of-touch" | "unknown";

/** What the machine itself says, asked over SSH. */
export interface MachineRecoveryInspection {
  /** Its service is active and the program's process is there. */
  programRunning: boolean;
  /** Agent processes of this desktop's deployment are there. */
  agentsRunning: boolean;
}

/** Why the program is still not back, for Settings → AWS → Diagnostics.
 *  - `check`: the machine could not be asked;
 *  - `setup`: setting the program up again failed;
 *  - `agents`: it is not running, but agents it started still are;
 *  - `running`: it runs, but has not reached this desktop for a long time. */
export interface MachineRecoveryFailure {
  kind: "check" | "setup" | "agents" | "running";
  reason?: string;
}

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
  /** Asks the machine over SSH; never starts the instance. */
  inspect(record: MachineInstallRecord): Promise<MachineRecoveryInspection>;
  /** Sets the program on the instance up again, as choosing Cloud run does,
   *  without starting the instance. */
  reinstall(machineId: string): Promise<void>;
  log(event: string, payload: Record<string, unknown>): void;
}

/**
 * Brings the program on the cloud machine back by itself.
 *
 * Without that program nothing works in the cloud: members cannot run there
 * and the instance never stops by itself. It used to wait for the User to
 * notice; after one interrupted update it stayed down for nine days. Here the
 * desktop notices instead. When the instance is running and the program has
 * been out of touch for five minutes while this desktop reaches the relay,
 * the machine itself is asked over SSH, and only a program that is not
 * running, with no agent of this deployment left, is set up again. One that
 * runs is never drained for being out of touch: that is the link, and setting
 * it up again would not fix it. The User is told only what did not come back.
 */
export class MachineRecoveryService {
  /** Since when, by this desktop's own observation, each machine has been
   *  out of touch. A machine this desktop has not watched yet starts now. */
  private readonly outOfTouchSince = new Map<string, number>();
  private readonly nextLookAt = new Map<string, number>();
  private readonly failedSetups = new Map<string, number>();
  private readonly waitedOnAgents = new Set<string>();
  private readonly failures = new Map<string, MachineRecoveryFailure>();
  private lastTickAt?: number;
  private slept = false;
  private running?: Promise<void>;

  constructor(private readonly options: MachineRecoveryOptions) {}

  /** Why the program is still not back, if this desktop knows. */
  failure(machineId: string): MachineRecoveryFailure | undefined {
    return this.failures.get(machineId);
  }

  /** One tick of the timer: a check, or the one in progress. Never rejects:
   *  it runs from a timer. */
  check(): Promise<void> {
    const now = this.options.now();
    if (this.lastTickAt !== undefined && now - this.lastTickAt > MACHINE_RECOVERY_WATCH_GAP_MS) this.slept = true;
    this.lastTickAt = now;
    this.running ??= this.checkNow()
      .catch((error) => { this.options.log("machines.recovery.error", { message: errorText(error) }); })
      .finally(() => { this.running = undefined; });
    return this.running;
  }

  private async checkNow(): Promise<void> {
    const now = this.options.now();
    if (this.slept) {
      this.slept = false;
      this.forgetAll();
    }
    const linkStartedAt = this.options.linkStartedAt();
    if (linkStartedAt === undefined || now - linkStartedAt < MACHINE_RECOVERY_LINK_GRACE_MS) return;
    const record = await this.options.machineOnInstance();
    if (!record?.installedVersion) return;
    const id = record.machineId;
    const link = this.options.linkState(id);
    if (link === "connected") {
      if (this.failures.has(id)) this.options.log("machines.recovery.recovered", { machineId: id });
      this.forget(id);
      return;
    }
    // This side cannot reach the relay: the program may be fine, and nothing
    // known about it before still holds.
    if (link === "unknown") {
      this.forget(id);
      return;
    }
    const since = this.outOfTouchSince.get(id) ?? now;
    this.outOfTouchSince.set(id, since);
    if (now - since < MACHINE_RECOVERY_AFTER_MS || this.options.setupRunning(id)) return;
    if (now < (this.nextLookAt.get(id) ?? 0)) return;
    let runningSince: number | undefined;
    try {
      runningSince = await this.options.instanceRunningSince();
    } catch {
      return; // AWS did not answer; nothing new is known
    }
    // A stopped instance has no program to run, and what was known about the
    // last run no longer holds; one that just started is still bringing it up.
    if (runningSince === undefined) {
      this.forget(id);
      return;
    }
    if (now - runningSince < MACHINE_RECOVERY_AFTER_MS) return;
    this.nextLookAt.set(id, now + MACHINE_RECOVERY_RETRY_MS);
    let inspection: MachineRecoveryInspection;
    try {
      inspection = await this.options.inspect(record);
    } catch (error) {
      this.fail(id, { kind: "check", reason: errorText(error) });
      return;
    }
    if (inspection.programRunning) {
      this.waitedOnAgents.delete(id);
      this.options.log("machines.recovery.waiting", { machineId: id, reason: "program-running", outOfTouchMs: now - since });
      // Counted from the instance's start: before it, there was nothing to hear.
      if (now - Math.max(since, runningSince) >= MACHINE_RECOVERY_RUNNING_REPORT_MS) this.fail(id, { kind: "running" });
      else this.failures.delete(id);
      return;
    }
    if (inspection.agentsRunning) {
      this.options.log("machines.recovery.waiting", { machineId: id, reason: "agents-running" });
      // Said once the wait outlasts one look, not on the first.
      if (this.waitedOnAgents.has(id)) this.fail(id, { kind: "agents" });
      else this.failures.delete(id);
      this.waitedOnAgents.add(id);
      return;
    }
    this.waitedOnAgents.delete(id);
    this.options.log("machines.recovery.start", { machineId: id, outOfTouchMs: now - since });
    try {
      await this.options.reinstall(id);
      this.failedSetups.delete(id);
      this.failures.delete(id);
      this.options.log("machines.recovery.finished", { machineId: id });
    } catch (error) {
      const failed = (this.failedSetups.get(id) ?? 0) + 1;
      this.failedSetups.set(id, failed);
      this.nextLookAt.set(id, this.options.now() + Math.min(MACHINE_RECOVERY_RETRY_MS * 2 ** (failed - 1), MACHINE_RECOVERY_MAX_RETRY_MS));
      this.fail(id, { kind: "setup", reason: errorText(error) });
    }
  }

  private fail(machineId: string, failure: MachineRecoveryFailure): void {
    this.failures.set(machineId, failure);
    this.options.log("machines.recovery.failed", { machineId, ...failure });
  }

  private forget(machineId: string): void {
    this.outOfTouchSince.delete(machineId);
    this.nextLookAt.delete(machineId);
    this.failedSetups.delete(machineId);
    this.waitedOnAgents.delete(machineId);
    this.failures.delete(machineId);
  }

  private forgetAll(): void {
    for (const id of new Set([...this.outOfTouchSince.keys(), ...this.failures.keys(), ...this.nextLookAt.keys()])) this.forget(id);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
