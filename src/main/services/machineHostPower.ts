/**
 * Host-wide coordination for automatic idle stop.
 *
 * Idle is measured per profile: every deployment on a machine has its own
 * user-data directory, its own SQLite and its own `MachineIdleScheduler`. The
 * instance they run on is shared. Without coordination one profile that has
 * been idle for three hours would stop the whole instance while another
 * profile is mid-turn or holding a maintenance lease, destroying work the
 * stopping profile cannot see.
 *
 * Each registered owner publishes one small claim file in the host directory,
 * and the directory carries two more things that make this a barrier rather
 * than a set of observations:
 *
 *   - **One lock.** Admitting work and committing a stop are the same
 *     critical section. Both take the kernel file lock, so a deployment can never start a
 *     turn in the window between another deployment deciding to stop and the
 *     stop becoming final. A read before the AWS call cannot do this: the
 *     answer is stale the moment it is read.
 *   - **One stop intent.** Once committed under the lock it is visible to
 *     every deployment, so admission refuses instead of starting work into a
 *     machine that is going away; until it is committed any admission wins
 *     and the intent is withdrawn.
 *
 * Idle is host-wide, not per profile: a claim carries when its owner was last
 * busy, so three hours of quiet here plus ten minutes of work next door is
 * ten minutes of host idle, not three hours.
 *
 * The observations themselves are deliberately conservative:
 *
 *   - A claim from another boot is stale: `/tmp` is cleared on boot and the
 *     boot id is checked as well, so a claim can never outlive its host.
 *   - A dead owner does not prove its native descendants are gone. Only an
 *     explicit release after shutdown or another host boot removes its claim.
 *   - A claim whose process is alive but has stopped refreshing counts as
 *     BUSY, not idle. A hung runtime that never stops is a visible cost; a
 *     stop that kills another profile's provider turn is lost work.
 *
 * The directory is `/tmp/accordagents-host-power`. Access is checked at use;
 * if a deployment's OS user cannot use it, automatic stop is suspended.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { withHostAdmissionLock } from "./hostAdmissionLock";

export const MACHINE_HOST_POWER_DIR = "/tmp/accordagents-host-power";
/** A live claim that has not been refreshed within this counts as busy. */
export const MACHINE_HOST_CLAIM_STALE_MS = 90_000;
const STOP_INTENT_FILE = "stop-intent.json";

export type MachineHostClaimKind = "runtime" | "maintenance";

export interface MachineHostClaim {
  /** v2 uses kernel admission locking; v1 neighbours cannot safely stop this host. */
  version: 1 | 2;
  /** Stable per user-data directory; each runtime has a distinct instance claim. */
  profileId: string;
  /** The profile's own directory, for a message the User can act on. */
  profilePath: string;
  bootId: string;
  pid: number;
  /** Host uptime when this claim was last refreshed. */
  uptimeMs: number;
  busy: boolean;
  kind: MachineHostClaimKind;
  /** Immutable runtime identity; legacy claims without it remain readable. */
  instanceId?: string;
  /** Host uptime when this owner was last doing work. The host is idle only
   *  since the most recent of these, so a neighbour's short turn between two
   *  polls is not swallowed by another profile's long quiet. */
  lastBusyUptimeMs?: number;
}

/** A stop one deployment has decided on, as every deployment can read it. */
export interface MachineHostStopIntent {
  version: 1;
  bootId: string;
  profileId: string;
  profilePath: string;
  instanceId: string;
  pid: number;
  uptimeMs: number;
  /** `pending` may still be withdrawn by an admission; `committed` may not. */
  phase: "pending" | "committed";
}

export type MachineHostAdmission =
  | { admitted: true }
  | { admitted: false; reason: string };

export interface MachineHostPowerOptions {
  profilePath: string;
  bootId: string;
  uptimeMs(): number;
  kind?: MachineHostClaimKind;
  dir?: string;
  pid?: number;
  staleAfterMs?: number;
  /** Injectable for tests; a live pid means the claim's owner still exists. */
  isAlive?(pid: number): boolean;
}

export function machineHostProfileId(profilePath: string): string {
  return createHash("sha256").update(path.resolve(profilePath)).digest("hex").slice(0, 16);
}

export class MachineHostPowerRegistry {
  private readonly dir: string;
  private readonly profileId: string;
  private readonly pid: number;
  private readonly staleAfterMs: number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly instanceId = randomUUID();
  private readonly claimPath: string;
  private released = false;
  /** When this owner was last doing work; starting counts as work. */
  private lastBusyUptimeMs: number;

  constructor(private readonly options: MachineHostPowerOptions) {
    if (!options.bootId.trim()) throw new Error("Host-wide power coordination requires the host boot identity.");
    this.dir = options.dir ?? MACHINE_HOST_POWER_DIR;
    this.profileId = machineHostProfileId(options.profilePath);
    this.pid = options.pid ?? process.pid;
    this.claimPath = path.join(this.dir, `${this.profileId}-${this.instanceId}.json`);
    this.staleAfterMs = options.staleAfterMs ?? MACHINE_HOST_CLAIM_STALE_MS;
    this.isAlive = options.isAlive ?? defaultIsAlive;
    this.lastBusyUptimeMs = options.uptimeMs();
  }

  /** This registration's own identity, for a stop intent and for a restart
   *  that has to recognise the claims it left behind. */
  identity(): { profileId: string; instanceId: string; pid: number } {
    return { profileId: this.profileId, instanceId: this.instanceId, pid: this.pid };
  }

  /** Records what this profile is doing. Called on every idle poll and
   *  whenever activity is noted, so other profiles see a fresh reading. */
  publish(busy: boolean): void {
    if (this.released) throw new Error("This deployment's host-power registration has been released.");
    if (busy) this.lastBusyUptimeMs = this.options.uptimeMs();
    const claim: MachineHostClaim = {
      version: 2,
      profileId: this.profileId,
      profilePath: path.resolve(this.options.profilePath),
      bootId: this.options.bootId,
      pid: this.pid,
      uptimeMs: this.options.uptimeMs(),
      busy,
      kind: this.options.kind ?? "runtime",
      instanceId: this.instanceId,
      lastBusyUptimeMs: this.lastBusyUptimeMs
    };
    // 0777/0644 on purpose: profiles may run as different OS users and must be
    // able to publish into, and read, the same directory.
    mkdirSync(this.dir, { recursive: true, mode: 0o777 });
    const target = this.claimPath;
    const temporary = `${target}.${this.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(claim)}\n`, { mode: 0o644 });
    renameSync(temporary, target);
  }

  /** Claims other profiles on this host published, with stale ones pruned. */
  others(): MachineHostClaim[] {
    let names: string[];
    // A missing/unreadable directory is not evidence that the host is idle.
    names = readdirSync(this.dir);
    const now = this.options.uptimeMs();
    const live: MachineHostClaim[] = [];
    for (const name of names) {
      // The stop intent lives here too, and is not a claim.
      if (!name.endsWith(".json") || name === STOP_INTENT_FILE) continue;
      const full = path.join(this.dir, name);
      const claim = readClaim(full);
      const expectedName = claim && `${claim.profileId}${claim.instanceId ? `-${claim.instanceId}` : ""}.json`;
      if (!claim || name !== expectedName || machineHostProfileId(claim.profilePath) !== claim.profileId) {
        throw new Error(`Host-power claim ${name} cannot be verified; the host must remain awake.`);
      }
      // Only a verified boot change proves that every old native child is gone.
      if (claim.bootId !== this.options.bootId) {
        prune(full);
        continue;
      }
      if (full === this.claimPath) continue;
      // Alive but not refreshing: treated as busy, never as idle.
      live.push(claim.version !== 2 || !this.isAlive(claim.pid) || now < claim.uptimeMs || now - claim.uptimeMs > this.staleAfterMs
        ? { ...claim, busy: true } : claim);
    }
    return live;
  }

  /** Why this host may not be stopped, or undefined when nothing objects. */
  blockingReason(): string | undefined {
    const busy = this.others().filter((claim) => claim.busy);
    if (!busy.length) return undefined;
    const first = busy[0];
    if (first.version !== 2) return `Another deployment on this machine (${first.profilePath}) needs an upgrade before automatic stop can coordinate safely.`;
    const what = first.kind === "maintenance" ? "a maintenance command" : "work";
    const more = busy.length > 1 ? ` and ${busy.length - 1} more` : "";
    return `Another deployment on this machine (${first.profilePath}${more}) is running ${what}.`;
  }

  /**
   * Runs one critical section against the whole host.
   *
   * Admitting work and committing a stop are the same section: without it a
   * deployment can start a turn in the window between another deployment
   * finding the host idle and its stop becoming final, which is exactly the
   * work a stop must never destroy.
   */
  withLock<T>(action: () => T | Promise<T>): Promise<T> {
    return withHostAdmissionLock(this.dir, action);
  }

  /** The stop one deployment has decided on, if any. */
  stopIntent(): MachineHostStopIntent | undefined {
    const intent = readStopIntent(path.join(this.dir, STOP_INTENT_FILE));
    if (!intent) return undefined;
    // An intent from another boot cannot be acted on: the host restarted.
    if (intent.bootId !== this.options.bootId) return undefined;
    return intent;
  }

  /**
   * Says whether new work may start on this host, and records it if so.
   *
   * Taken by every entry point that begins native work — a turn command, a
   * compaction, background work, a maintenance command — before it starts.
   * Under the lock, so a stop cannot commit while this is deciding.
   */
  admit(what: string): Promise<MachineHostAdmission> {
    return this.withLock(() => {
      const intent = this.stopIntent();
      if (intent?.phase === "committed") {
        return {
          admitted: false,
          reason: `This machine is stopping after being idle (decided by ${intent.profilePath}); ${what} is held until it is awake again.`
        };
      }
      if (intent) {
        // Still withdrawable: work wins over a stop that has not committed.
        rmSync(path.join(this.dir, STOP_INTENT_FILE), { force: true });
      }
      this.publish(true);
      return { admitted: true };
    });
  }

  /**
   * Declares the intent to stop, or refuses when the host is not idle.
   *
   * The claim survey happens inside the same lock the admissions take, so the
   * answer cannot go stale between deciding and writing. Commit is a second
   * pass under the lock, after the caller's own drain: an admission in between
   * removes the intent and the commit then finds it gone.
   */
  beginStop(request: { minIdleMs: number; ownIdleSinceUptimeMs: number }): Promise<boolean> {
    return this.withLock(() => {
      if (this.stopIntent()) return false;
      if (this.blockingReason()) return false;
      if (this.hostIdleForMs(request.ownIdleSinceUptimeMs) < request.minIdleMs) return false;
      const intent: MachineHostStopIntent = {
        version: 1,
        bootId: this.options.bootId,
        profileId: this.profileId,
        profilePath: path.resolve(this.options.profilePath),
        instanceId: this.instanceId,
        pid: this.pid,
        uptimeMs: this.options.uptimeMs(),
        phase: "pending"
      };
      writeIntent(path.join(this.dir, STOP_INTENT_FILE), intent);
      return true;
    });
  }

  /** Makes this deployment's stop final, unless work was admitted meanwhile. */
  commitStop(prepareLocal: () => Promise<boolean> = async () => true): Promise<boolean> {
    return this.withLock(async () => {
      const intent = this.stopIntent();
      if (!intent || intent.instanceId !== this.instanceId || intent.phase !== "pending") return false;
      if (this.blockingReason()) {
        rmSync(path.join(this.dir, STOP_INTENT_FILE), { force: true });
        return false;
      }
      // Keep admission excluded while the caller commits its local SQLite
      // fence; a losing host intent must never leave that local fence behind.
      if (!await prepareLocal()) return false;
      writeIntent(path.join(this.dir, STOP_INTENT_FILE), { ...intent, phase: "committed" });
      return true;
    });
  }

  /** Withdraws this deployment's own intent; a committed one stays. */
  abandonStop(): Promise<void> {
    return this.withLock(() => {
      const intent = this.stopIntent();
      if (intent && intent.instanceId === this.instanceId && intent.phase === "pending") {
        rmSync(path.join(this.dir, STOP_INTENT_FILE), { force: true });
      }
    });
  }

  /**
   * How long every deployment on this host has been quiet.
   *
   * The caller passes its own idle-since, which its durable state owns; this
   * adds what the neighbours say. Zero while any of them is busy. Otherwise
   * it is measured from the most recent moment any deployment was working —
   * three hours of quiet here and a turn next door ten minutes ago is ten
   * minutes of host idle, not three hours.
   */
  hostIdleForMs(ownIdleSinceUptimeMs: number): number {
    const now = this.options.uptimeMs();
    let lastBusy = ownIdleSinceUptimeMs;
    for (const claim of this.others()) {
      if (claim.busy) return 0;
      // A claim written by an older release has no busy clock of its own; the
      // moment it was last seen is the youngest thing that can be proven.
      const busyAt = claim.lastBusyUptimeMs ?? claim.uptimeMs;
      if (busyAt > lastBusy) lastBusy = busyAt;
    }
    return Math.max(0, now - lastBusy);
  }

  /**
   * Clears claims this same profile left behind, once its own native work is
   * proven gone.
   *
   * A crash leaves a claim whose owner is dead, and a dead owner is not proof
   * that its providers died with it — so the claim keeps the host awake. That
   * is right until this profile starts again and can prove, from its own
   * guardian receipts, that nothing of its is running. Without this a single
   * crash would disable automatic stop until the host rebooted.
   */
  async adoptOwnStaleClaims(proveClosed: () => Promise<void>): Promise<number> {
    const intent = this.stopIntent();
    const ownDeadIntent = intent?.phase === "pending" && intent.profileId === this.profileId && !this.isAlive(intent.pid);
    const mine = this.others().filter((claim) => claim.profileId === this.profileId);
    if (!mine.length && !ownDeadIntent) return 0;
    await proveClosed();
    let cleared = 0;
    for (const claim of mine) {
      if (claim.instanceId === this.instanceId) continue;
      if (this.isAlive(claim.pid)) continue;
      prune(path.join(this.dir, `${claim.profileId}-${claim.instanceId}.json`));
      cleared += 1;
    }
    if (ownDeadIntent) {
      // An uncommitted attempt may be withdrawn after closure. A committed
      // stop must survive: AWS may already be processing it, and admitting
      // another profile now would start work into that unresolved stop.
      await this.withLock(() => {
        const current = this.stopIntent();
        if (current?.phase === "pending" && current.profileId === this.profileId && !this.isAlive(current.pid)) {
          rmSync(path.join(this.dir, STOP_INTENT_FILE), { force: true });
        }
      });
      cleared += 1;
    }
    return cleared;
  }

  release(): void {
    if (this.released) return;
    const target = this.claimPath;
    const claim = readClaim(target);
    // An old instance must not remove a replacement instance's registration.
    if (!claim || claim.instanceId !== this.instanceId || claim.pid !== this.pid || claim.bootId !== this.options.bootId) {
      throw new Error("This deployment no longer owns its host-power claim.");
    }
    rmSync(target);
    this.released = true;
  }
}

function readClaim(file: string): MachineHostClaim | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  const claim = parsed as Partial<MachineHostClaim>;
  if (!claim || (claim.version !== 1 && claim.version !== 2) || typeof claim.profileId !== "string" || !claim.profileId
    || typeof claim.profilePath !== "string" || !path.isAbsolute(claim.profilePath)
    || typeof claim.bootId !== "string" || !claim.bootId || !Number.isSafeInteger(claim.pid) || claim.pid! <= 0
    || typeof claim.uptimeMs !== "number" || !Number.isFinite(claim.uptimeMs) || claim.uptimeMs < 0
    || (claim.instanceId !== undefined && (typeof claim.instanceId !== "string" || !/^[a-f0-9-]{36}$/.test(claim.instanceId)))
    || (claim.lastBusyUptimeMs !== undefined && (typeof claim.lastBusyUptimeMs !== "number" || !Number.isFinite(claim.lastBusyUptimeMs) || claim.lastBusyUptimeMs < 0))
    || typeof claim.busy !== "boolean" || (claim.kind !== "runtime" && claim.kind !== "maintenance")) {
    return undefined;
  }
  return {
    version: claim.version,
    profileId: claim.profileId,
    profilePath: typeof claim.profilePath === "string" ? claim.profilePath : "(unknown)",
    bootId: claim.bootId,
    pid: claim.pid!,
    uptimeMs: claim.uptimeMs,
    busy: claim.busy,
    kind: claim.kind === "maintenance" ? "maintenance" : "runtime",
    ...(claim.instanceId ? { instanceId: claim.instanceId } : {}),
    ...(claim.lastBusyUptimeMs !== undefined ? { lastBusyUptimeMs: claim.lastBusyUptimeMs } : {})
  };
}

function writeIntent(file: string, intent: MachineHostStopIntent): void {
  const temporary = `${file}.${intent.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(intent)}\n`, { mode: 0o644 });
  renameSync(temporary, file);
}

function readStopIntent(file: string): MachineHostStopIntent | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    // Only an absent file means "nobody is stopping". A file that exists and
    // cannot be read is coordination this host cannot see through, and is
    // neither permission to start work nor permission to stop.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`The host stop intent cannot be read; this machine stays awake: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("The host stop intent cannot be read; this machine stays awake.");
  }
  const intent = parsed as Partial<MachineHostStopIntent>;
  if (!intent || intent.version !== 1 || typeof intent.bootId !== "string" || !intent.bootId
    || typeof intent.profileId !== "string" || !intent.profileId
    || typeof intent.profilePath !== "string" || !path.isAbsolute(intent.profilePath)
    || typeof intent.instanceId !== "string" || !intent.instanceId
    || !Number.isSafeInteger(intent.pid) || intent.pid! <= 0
    || typeof intent.uptimeMs !== "number" || !Number.isFinite(intent.uptimeMs) || intent.uptimeMs < 0
    || (intent.phase !== "pending" && intent.phase !== "committed")) {
    // An unreadable intent is not permission to start work, and not permission
    // to stop either: both callers treat it as "someone else is deciding".
    throw new Error("The host stop intent cannot be read; this machine stays awake.");
  }
  return intent as MachineHostStopIntent;
}

function prune(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // A claim owned by another user cannot be removed here; treating it as
    // gone is enough, and the directory is cleared on the next boot.
  }
}

function defaultIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists under another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
