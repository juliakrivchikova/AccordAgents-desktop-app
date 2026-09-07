import { MACHINE_IDLE_STOP_MS } from "../../shared/machinePower";

export interface MachineIdleState {
  version: 1;
  bootId: string;
  /** Host monotonic uptime, not a wall clock or a process-local timer. */
  idleSinceMs: number | null;
}

export interface MachineIdleStateStore {
  read(): Promise<MachineIdleState | undefined>;
  write(state: MachineIdleState): Promise<void>;
}

/** One local owner measures idle independently of every desktop/phone.
 * prepareStop must atomically fence new native work, recheck durable commands
 * and maintenance, and return undefined when any of them won the race. */
export class MachineIdleScheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private checking?: Promise<void>;
  private queue: Promise<void> = Promise.resolve();
  private activityVersion = 0;
  private storedActivityVersion = 0;
  private closed = false;
  private stopping = false;

  constructor(private readonly options: {
    state: MachineIdleStateStore;
    bootId: string;
    uptimeMs(): number;
    isBusy(): Promise<boolean>;
    prepareStop(idleSinceMs: number): Promise<(() => Promise<void>) | undefined>;
    onError(error: unknown): void;
    onIdleChanged?(idleSinceMs: number | null): void;
    idleMs?: number;
    pollMs?: number;
  }) {
    if (!options.bootId.trim()) throw new Error("Automatic idle stop requires the host boot identity.");
  }

  start(): void { if (!this.closed) this.schedule(0); }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  check(): Promise<void> {
    if (this.checking) return this.checking;
    const work = this.enqueue(() => this.inspect());
    this.checking = work;
    void work.finally(() => { if (this.checking === work) this.checking = undefined; }).catch(() => undefined);
    return work;
  }

  /** Called before a native outcome is committed and before releasing a
   * maintenance lease. Even a complete short turn between timer ticks resets
   * idle, and the reset survives a process restart. */
  noteActivity(): Promise<void> {
    this.activityVersion++;
    return this.enqueue(async () => {
      if (this.closed || this.stopping) throw new Error("The machine is stopping; new activity cannot be admitted.");
      // Read first: activity must never overwrite corrupt/unreadable state.
      const previous = await this.options.state.read();
      const version = this.activityVersion;
      const next: MachineIdleState = { version: 1, bootId: this.options.bootId, idleSinceMs: null };
      if (previous?.bootId !== next.bootId || previous.idleSinceMs !== null) await this.options.state.write(next);
      this.storedActivityVersion = version;
      this.options.onIdleChanged?.(null);
    });
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const work = this.queue.then(action);
    this.queue = work.catch(() => undefined);
    return work;
  }

  private async inspect(): Promise<void> {
    if (this.closed || this.stopping) return;
    const now = this.options.uptimeMs();
    if (!Number.isFinite(now) || now < 0) throw new Error("Host uptime is unavailable; automatic stop is suspended.");
    // Maintenance can finish in another process between polls and reset this
    // state. Never let a cached old deadline authorize power-off.
    const stored = await this.options.state.read();
    const busy = await this.options.isBusy() || this.activityVersion !== this.storedActivityVersion;
    if (this.closed) return;
    const sameBoot = stored?.bootId === this.options.bootId;
    const idleSinceMs = busy ? null : sameBoot && stored?.idleSinceMs !== null && stored?.idleSinceMs !== undefined
      ? Math.min(stored.idleSinceMs, now) : now;
    const next: MachineIdleState = { version: 1, bootId: this.options.bootId, idleSinceMs };
    const activityVersion = this.activityVersion;
    if (!stored || !sameBoot || stored.idleSinceMs !== idleSinceMs) {
      await this.options.state.write(next);
      this.options.onIdleChanged?.(idleSinceMs);
    }
    // Only committed state can authorize stopping.
    if (idleSinceMs === null) this.storedActivityVersion = activityVersion;
    if (this.closed || busy || idleSinceMs === null || now - idleSinceMs < (this.options.idleMs ?? MACHINE_IDLE_STOP_MS)) return;
    const stop = await this.options.prepareStop(idleSinceMs);
    if (!stop || this.closed) return;
    this.stopping = true;
    // Once preparation fences admissions it owns recovery too. In particular,
    // an uncertain EC2 response must not silently re-open native execution.
    await stop();
  }

  private schedule(delay: number): void {
    if (this.closed || this.stopping || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.check().catch(error => this.options.onError(error)).finally(() => this.schedule(this.options.pollMs ?? 15_000));
    }, delay);
    this.timer.unref?.();
  }
}
