import type { WarmAgentEntry } from "../types";
import { warmKeyAgentEnvKey } from "./warmKeys";

/** How long a member process must have held no work before it is replaced
 *  for a changed environment: the CLI still finishes its turn after its
 *  result (the transcript, a prompt suggestion a few seconds later), and a
 *  finished background task's notification may come right after the list
 *  that dropped the task (the CLI then answers it on its own). */
export const ENVIRONMENT_REPLACEMENT_SETTLE_MS = 10_000;
/** How long a member's next process waits for its replaced one to exit, at
 *  most (a close is bounded on its own; this keeps a hung one from holding
 *  the member's next turn). */
const CLOSING_WAIT_MAX_MS = 10_000;

export interface WarmEnvironmentHost {
  readonly entries: Map<string, WarmAgentEntry>;
  readonly warmPreparations: Set<{ key: string }>;
  readonly closingWarmAgents: () => Map<WarmAgentEntry, Promise<void>>;
  /** The environment members get now, read as their turns read it. */
  readonly readVersion: () => Promise<string | undefined>;
  readonly close: (entry: WarmAgentEntry, reason: string) => Promise<void>;
  readonly log: (event: string, payload: Record<string, unknown>) => void;
}

/**
 * Settings → Environment changed while members' processes live (the User,
 * 2026-11-27): a process started with other values is closed once it holds no
 * work, so the member's next message starts a new one that resumes the same
 * session with the new values, as one restarts a dedicated CLI between turns.
 * A turn in progress finishes on the process it started on, and messages sent
 * meanwhile join it (WarmAgents.withBusyMemberEnvironment). Background tasks
 * are waited for, not stopped; meanwhile the member shows that new values are
 * waiting (`pending`, sent with its background tasks).
 *
 * The app sees the background work of a Claude Code process only: a process
 * of a CLI whose leftovers it cannot see (Codex) is replaced when the change
 * finds it idle, otherwise at the member's next turn, as before.
 */
export class WarmEnvironment {
  /** What members get now, as last read; undefined until a change was told
   *  (or when the reading failed: nothing is judged outdated then, and a
   *  member's next turn still replaces a process whose values differ). */
  private version?: string;
  /** Counts the changes told: a process started before the latest one may be
   *  outdated, one started after it is judged by its next turn only. */
  private generation = 0;
  /** Replacements waiting for their process to have stayed free: `due` moves
   *  on with every sign of life, `anyProvider` when a change found it. */
  private readonly timers = new Map<WarmAgentEntry, { due: number; anyProvider: boolean }>();
  settleMs = ENVIRONMENT_REPLACEMENT_SETTLE_MS;

  constructor(private readonly host: WarmEnvironmentHost) {}

  /** The latest change, for a process that starts now. */
  currentGeneration(): number {
    return this.generation;
  }

  /** The environment changed (a save, or a machine's imported settings).
   *  Reads what members get now; of two changes told at once, the later
   *  reading wins. */
  async changed(): Promise<void> {
    const generation = ++this.generation;
    let version: string | undefined;
    try {
      version = await this.host.readVersion();
    } catch (error) {
      this.host.log("cli.agent-environment-read-failed", { message: error instanceof Error ? error.message : String(error) });
    }
    if (generation !== this.generation) return;
    this.version = version;
    for (const entry of Array.from(this.host.entries.values())) {
      if (this.outdated(entry)) this.schedule(entry, true);
      // Those kept by their background tasks say so with them; one whose
      // values were put back stops saying it.
      entry.refreshBackgroundReport?.();
    }
  }

  /** Whether this live member process still runs with the environment it
   *  started with while members get other values now. */
  pending(entry: WarmAgentEntry): boolean {
    return this.host.entries.get(entry.key) === entry && this.outdated(entry);
  }

  /** The process may hold no work any more (a run on it settled, it went
   *  idle, a turn routed into it is over): an outdated one is replaced once
   *  it has stayed so for a moment. Called on every line a Claude process
   *  prints: the cheap checks come first, the key is parsed last. */
  mayBeFree(entry: WarmAgentEntry): void {
    if (this.version === undefined || !entry.hasLiveBackgroundWork) return;
    const scheduled = this.timers.get(entry);
    if (scheduled) {
      scheduled.due = Date.now() + this.settleMs;
      return;
    }
    if (this.host.entries.get(entry.key) !== entry || !this.free(entry) || !this.outdated(entry)) return;
    this.schedule(entry, false);
  }

  /** A turn routed into the member's busy process holds it until the turn is
   *  over (`release`), so it is not replaced under the turn before the turn
   *  reaches it. */
  hold(entry: WarmAgentEntry): () => void {
    entry.environmentHolds = (entry.environmentHolds ?? 0) + 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.environmentHolds = Math.max(0, (entry.environmentHolds ?? 1) - 1);
      this.mayBeFree(entry);
    };
  }

  /** A process of this member still closing: the next one starts once it has
   *  gone, so two processes never hold the member's session at once. */
  async waitForClosing(scopeKey: string): Promise<void> {
    const closing = Array.from(this.host.closingWarmAgents()).filter(([entry]) => entry.scopeKey === scopeKey).map(([, done]) => done);
    if (closing.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(closing),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CLOSING_WAIT_MAX_MS);
        timer.unref();
      })
    ]);
    if (timer) clearTimeout(timer);
  }

  private schedule(entry: WarmAgentEntry, anyProvider: boolean): void {
    const scheduled = this.timers.get(entry);
    if (scheduled) {
      scheduled.anyProvider ||= anyProvider;
      scheduled.due = Date.now() + this.settleMs;
      return;
    }
    const record = { due: Date.now() + this.settleMs, anyProvider };
    this.timers.set(entry, record);
    const fire = (): void => {
      const wait = record.due - Date.now();
      if (wait > 0) {
        setTimeout(fire, wait).unref();
        return;
      }
      this.timers.delete(entry);
      // Everything again: a turn may have started on it meanwhile, or the
      // values may have been put back.
      if (this.host.entries.get(entry.key) !== entry || !this.outdated(entry) || !this.free(entry)) return;
      if (!entry.hasLiveBackgroundWork && !record.anyProvider) return;
      this.host.entries.delete(entry.key);
      this.host.log("cli.agent-environment-replaced", { providerKind: entry.providerKind, scopeKey: entry.scopeKey });
      void this.host.close(entry, "environment-changed").catch(() => undefined);
    };
    setTimeout(fire, this.settleMs).unref();
  }

  /** Started before the latest change, with other values than members get
   *  now. Its key carries the version it started with; a member on an added
   *  provider has the provider's own part after a `|`. */
  private outdated(entry: WarmAgentEntry): boolean {
    if (this.version === undefined || entry.closed || (entry.environmentGeneration ?? 0) >= this.generation) return false;
    const started = warmKeyAgentEnvKey(entry.key);
    return Boolean(started) && started!.split("|")[0] !== this.version;
  }

  /** Nothing would be lost by closing the process now: no run is admitted or
   *  being prepared on it, no turn was routed into it, no reply is waiting,
   *  running or about to start on its own, and no background task runs (the
   *  User, 2026-11-27: they are waited for, not stopped). */
  private free(entry: WarmAgentEntry): boolean {
    if (entry.closed || entry.activeRuns || entry.environmentHolds) return false;
    if (Array.from(this.host.warmPreparations).some((value) => value.key === entry.key)) return false;
    return entry.isIdle?.() !== false && !entry.hasLiveBackgroundWork?.();
  }
}
