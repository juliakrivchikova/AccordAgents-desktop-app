import type { MachineRecord } from "../../shared/machineLink";

/**
 * Machines that stopped being used.
 *
 * While a machine is enrolled, this desktop keeps every chat change for it
 * until the machine confirms it, however long it stays away. Whether that
 * should end is the User's call: once every 10 days the machines are checked,
 * and about each one that has not been active for 10 days or more the User is
 * asked whether it is still in use. "No" removes it from the app; "yes" keeps
 * it, and it is asked about again at a later check if it is still inactive.
 *
 * The time of the last check is stored, so neither a restart nor an app left
 * open for weeks changes that rhythm.
 */

export const MACHINE_INACTIVITY_PERIOD_MS = 10 * 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export interface InactiveMachine {
  id: string;
  name: string;
  /** Whole days since the machine was last active. */
  inactiveDays: number;
  lastActiveAt: string;
}

export interface MachineInactivityCheckOptions {
  listMachines(): Promise<MachineRecord[]>;
  isConnected(machineId: string): boolean;
  /** When the machine last confirmed something this desktop sent it. */
  lastAcknowledgedAt(machine: MachineRecord): Promise<string | undefined>;
  lastCheckAt(): Promise<string | undefined>;
  saveLastCheckAt(at: string): Promise<void>;
  ask(machine: InactiveMachine): Promise<"keep" | "remove">;
  remove(machineId: string): Promise<void>;
  log(event: string, payload: Record<string, unknown>): void;
  now?: () => number;
}

export interface MachineInactivityCheckResult {
  checked: boolean;
  asked: string[];
  removed: string[];
}

export class MachineInactivityCheck {
  private first?: ReturnType<typeof setTimeout>;
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<MachineInactivityCheckResult>;

  constructor(private readonly options: MachineInactivityCheckOptions) {}

  /** Checks shortly after start, then looks every hour whether a check is due. */
  start(firstDelayMs = 2 * 60_000, everyMs = 60 * 60_000): void {
    const run = (): void => {
      void this.runIfDue().catch((error: unknown) => {
        this.options.log("machines.inactivity.error", { message: error instanceof Error ? error.message : String(error) });
      });
    };
    this.first = setTimeout(run, firstDelayMs);
    this.timer = setInterval(run, everyMs);
    this.first.unref?.();
    this.timer.unref?.();
  }

  stop(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = undefined;
    this.timer = undefined;
  }

  runIfDue(): Promise<MachineInactivityCheckResult> {
    this.running ??= this.check().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async check(): Promise<MachineInactivityCheckResult> {
    const now = this.options.now?.() ?? Date.now();
    const last = Date.parse((await this.options.lastCheckAt()) ?? "");
    if (Number.isFinite(last) && now - last < MACHINE_INACTIVITY_PERIOD_MS) return { checked: false, asked: [], removed: [] };
    const inactive: InactiveMachine[] = [];
    for (const machine of await this.options.listMachines()) {
      if (this.options.isConnected(machine.id)) continue;
      const times = [machine.createdAt, machine.lastSeenAt, await this.options.lastAcknowledgedAt(machine)]
        .map((value) => Date.parse(value ?? ""))
        .filter((value) => Number.isFinite(value));
      const lastActive = times.length ? Math.max(...times) : 0;
      if (now - lastActive < MACHINE_INACTIVITY_PERIOD_MS) continue;
      inactive.push({
        id: machine.id,
        name: machine.name,
        inactiveDays: Math.floor((now - lastActive) / DAY_MS),
        lastActiveAt: new Date(lastActive).toISOString()
      });
    }
    const removed: string[] = [];
    for (const machine of inactive) {
      const answer = await this.options.ask(machine);
      this.options.log("machines.inactivity.answered", { machineId: machine.id, inactiveDays: machine.inactiveDays, answer });
      if (answer !== "remove") continue;
      await this.options.remove(machine.id);
      removed.push(machine.id);
    }
    await this.options.saveLastCheckAt(new Date(now).toISOString());
    return { checked: true, asked: inactive.map((machine) => machine.id), removed };
  }
}
