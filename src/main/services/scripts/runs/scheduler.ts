import { nextScriptDueAt, scriptLateGraceMs } from "../../../../shared/scriptSchedule";
import type { ScriptRecord } from "../../scriptStore";
import { STOP_WAIT_MS, UNAPPROVED_PROPOSAL_TTL_MS } from "../constants";
import { firstDueAt } from "../records/scriptRules";
import { errorMessage, iso, psStartedAt } from "../scriptText";
import type { ScriptModules } from "../modules";
import type { ScriptDependencies } from "../dependencies";

/** Wakes at each script's next time. */
export class Scheduler {
  /** Approved, switched-on scripts, as of the last tick: they need the host
   *  awake for their next run. */
  private readonly scheduledIds = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private ticking?: Promise<void>;
  /** Timers arm only after start(); runs are refused only after stop(). */
  private started = false;
  stopped = false;

  constructor(
    private readonly scripts: Pick<ScriptModules, "scriptHost" | "scriptRecords" | "scriptRuns">,
    private readonly deps: Pick<ScriptDependencies, "now" | "options" | "tickMs">
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    this.started = true;
    for (const id of await this.deps.options.store.listIds()) {
      await this.recoverLeftoverRun(id).catch((error) => {
        this.scripts.scriptHost.log("scripts.recover.error", { scriptId: id, message: errorMessage(error) });
      });
    }
    this.schedule(0);
  }

  /** Stop the scheduler and every running script; their runs are recorded
   *  as interrupted. Bounded: quitting never waits on a slow tick. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms).unref());
    if (this.ticking) await Promise.race([this.ticking.catch(() => undefined), wait(STOP_WAIT_MS)]);
    const runs = [...this.scripts.scriptRuns.running.values()];
    for (const run of runs) {
      run.stopReason = "interrupted";
      run.controller.abort();
    }
    await Promise.race([Promise.allSettled(runs.map((run) => run.done)), wait(STOP_WAIT_MS)]);
  }

  /** A run that was going when the host crashed: kill what is left of its
   *  process group, but only after proving the pid is still that run's
   *  process (same boot, same start time), and record it, before any new run
   *  of that script can start. */
  private async recoverLeftoverRun(id: string): Promise<void> {
    const pid = await this.deps.options.store.readPid(id);
    if (!pid) return;
    const valid = Number.isInteger(pid.pid) && pid.pid > 1 && process.platform !== "win32";
    const sameBoot = Math.abs(pid.bootAt - this.scripts.scriptHost.bootAt()) < 120_000;
    if (valid && sameBoot) {
      const startedAt = await (this.deps.options.processStartedAt ?? psStartedAt)(pid.pid);
      const recordedAt = Date.parse(pid.startedAt);
      // ps reports whole seconds; a reused pid started at another time.
      if (startedAt !== undefined && Number.isFinite(recordedAt) && Math.abs(startedAt - recordedAt) < 3000) {
        try {
          process.kill(-pid.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
    await this.deps.options.store.clearPid(id);
    await this.scripts.scriptRuns.recordRun(id, {
      status: "interrupted",
      at: this.deps.now(),
      messagesSent: 0,
      detail: "The app quit or crashed while this run was going."
    });
  }

  schedule(delayMs: number): void {
    if (!this.started || this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, Math.max(0, delayMs));
    this.timer.unref?.();
  }

  /** Run whatever is due now. Also called on wake from sleep. */
  async tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    const work = this.tickOnce().finally(() => {
      this.ticking = undefined;
    });
    this.ticking = work;
    return work;
  }

  private async tickOnce(): Promise<void> {
    let nextDelay = this.deps.tickMs;
    try {
      const now = this.deps.now();
      const ids = await this.deps.options.store.listIds();
      // A script deleted while this pass read it must not keep the host awake.
      for (const id of [...this.scheduledIds]) if (!ids.includes(id)) this.noteScheduled(id, undefined);
      for (const id of ids) {
        // One broken script (a corrupt file, a full disk) must not stop the others.
        try {
          const nextAt = await this.tickScript(id, now);
          if (nextAt !== undefined) nextDelay = Math.min(nextDelay, Math.max(250, nextAt - now));
        } catch (error) {
          this.scripts.scriptHost.log("scripts.tick.script-error", { scriptId: id, message: errorMessage(error) });
        }
      }
    } catch (error) {
      this.scripts.scriptHost.log("scripts.tick.error", { message: errorMessage(error) });
    } finally {
      this.schedule(nextDelay);
    }
  }

  /** True while a switched-on script needs this host awake for its next
   *  run, or a script is running. A cloud machine does not stop when idle then. */
  keepsHostAwake(): boolean {
    return this.scheduledIds.size > 0 || this.scripts.scriptRuns.running.size > 0 || this.scripts.scriptRuns.starting.size > 0;
  }

  /** How many switched-on scripts keep the host awake, for "Kept on by …". */
  scheduledCount(): number {
    return this.scheduledIds.size;
  }

  /** Keeps the set behind keepsHostAwake in step with a record; a change is
   *  announced, so a machine tells the desktop at once whether it may stop. */
  noteScheduled(id: string, record: Pick<ScriptRecord, "approvedHash" | "enabled"> | undefined): void {
    const before = this.scheduledIds.has(id);
    const after = Boolean(record?.approvedHash && record.enabled);
    if (after) this.scheduledIds.add(id);
    else this.scheduledIds.delete(id);
    if (before !== after) this.scripts.scriptHost.changed();
  }

  /** Handle one script at `now`; returns when it is next due, if it is scheduled. */
  private async tickScript(id: string, now: number): Promise<number | undefined> {
    const record = await this.deps.options.store.readRecord(id);
    this.noteScheduled(id, record);
    if (!record) return undefined;
    if (!record.approvedHash) {
      if (now - Date.parse(record.createdAt) > UNAPPROVED_PROPOSAL_TTL_MS) {
        // Never approved and the card is long gone: drop it with its keys.
        await this.scripts.scriptRecords.deleteScript(id).catch(() => undefined);
      }
      return undefined;
    }
    if (!record.enabled) return undefined;
    const due = await this.deps.options.store.withScript(id, async () => {
      const runtime = await this.deps.options.store.readRuntime(id);
      let dueAt = runtime.nextDueAt ? Date.parse(runtime.nextDueAt) : Number.NaN;
      if (!Number.isFinite(dueAt)) {
        dueAt = firstDueAt(record.schedule, now);
        runtime.nextDueAt = iso(dueAt);
        await this.deps.options.store.writeRuntime(id, runtime);
      }
      if (dueAt > now) return { run: false as const, nextAt: dueAt };
      const next = nextScriptDueAt(record.schedule, dueAt, now);
      runtime.nextDueAt = iso(next);
      await this.deps.options.store.writeRuntime(id, runtime);
      return { run: true as const, dueAt, nextAt: next };
    });
    if (!due.run) return due.nextAt;
    const lateBy = now - due.dueAt;
    if (lateBy > scriptLateGraceMs(record.schedule)) {
      await this.scripts.scriptRuns.recordRun(id, { status: "missed", at: now, messagesSent: 0, detail: "The host was asleep or the app was closed when it was due." });
      this.scripts.scriptHost.changed();
      return due.nextAt;
    }
    if (this.scripts.scriptRuns.running.has(id) || this.scripts.scriptRuns.starting.has(id)) {
      await this.scripts.scriptRuns.recordRun(id, { status: "skipped", at: now, messagesSent: 0, detail: "The previous run was still going." });
      this.scripts.scriptHost.changed();
      return due.nextAt;
    }
    this.scripts.scriptRuns.launch(id, lateBy > 60_000 ? `Started ${Math.round(lateBy / 60_000)} min late.` : undefined);
    return due.nextAt;
  }
}
