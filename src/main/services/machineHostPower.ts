/**
 * Host-wide coordination for automatic idle stop.
 *
 * Idle is measured per profile: every deployment on a machine has its own
 * user-data directory, its own SQLite and its own `MachineIdleScheduler`. The
 * instance they run on is shared. Without coordination one profile that has
 * been idle for three hours would stop the whole instance while another
 * profile is mid-turn or holding a maintenance lease, destroying work the
 * stopping profile cannot see. That is the hole this closes.
 *
 * Every runtime and every maintenance command publishes one small claim file
 * in a directory shared by the whole host, refreshes it while it lives, and
 * reads the others before it allows a stop. The rules are deliberately
 * conservative:
 *
 *   - A claim from another boot is stale: `/tmp` is cleared on boot and the
 *     boot id is checked as well, so a claim can never outlive its host.
 *   - A claim whose process is gone is stale.
 *   - A claim whose process is alive but has stopped refreshing counts as
 *     BUSY, not idle. A hung runtime that never stops is a visible cost; a
 *     stop that kills another profile's provider turn is lost work.
 *
 * The directory is `/tmp/accordagents-host-power`, so profiles running as
 * different OS users still see each other. If it cannot be used, automatic
 * stop is suspended rather than taken without coordination.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export const MACHINE_HOST_POWER_DIR = "/tmp/accordagents-host-power";
/** A live claim that has not been refreshed within this counts as busy. */
export const MACHINE_HOST_CLAIM_STALE_MS = 90_000;

export type MachineHostClaimKind = "runtime" | "maintenance";

export interface MachineHostClaim {
  version: 1;
  /** Stable per user-data directory, so one profile has exactly one claim. */
  profileId: string;
  /** The profile's own directory, for a message the User can act on. */
  profilePath: string;
  bootId: string;
  pid: number;
  /** Host uptime when this claim was last refreshed. */
  uptimeMs: number;
  busy: boolean;
  kind: MachineHostClaimKind;
}

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
  private released = false;

  constructor(private readonly options: MachineHostPowerOptions) {
    if (!options.bootId.trim()) throw new Error("Host-wide power coordination requires the host boot identity.");
    this.dir = options.dir ?? MACHINE_HOST_POWER_DIR;
    this.profileId = machineHostProfileId(options.profilePath);
    this.pid = options.pid ?? process.pid;
    this.staleAfterMs = options.staleAfterMs ?? MACHINE_HOST_CLAIM_STALE_MS;
    this.isAlive = options.isAlive ?? defaultIsAlive;
  }

  /** Records what this profile is doing. Called on every idle poll and
   *  whenever activity is noted, so other profiles see a fresh reading. */
  publish(busy: boolean): void {
    if (this.released) return;
    const claim: MachineHostClaim = {
      version: 1,
      profileId: this.profileId,
      profilePath: path.resolve(this.options.profilePath),
      bootId: this.options.bootId,
      pid: this.pid,
      uptimeMs: this.options.uptimeMs(),
      busy,
      kind: this.options.kind ?? "runtime"
    };
    // 0777/0644 on purpose: profiles may run as different OS users and must be
    // able to publish into, and read, the same directory.
    mkdirSync(this.dir, { recursive: true, mode: 0o777 });
    const target = path.join(this.dir, `${this.profileId}.json`);
    const temporary = `${target}.${this.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(claim)}\n`, { mode: 0o644 });
    renameSync(temporary, target);
  }

  /** Claims other profiles on this host published, with stale ones pruned. */
  others(): MachineHostClaim[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const now = this.options.uptimeMs();
    const live: MachineHostClaim[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const full = path.join(this.dir, name);
      const claim = readClaim(full);
      if (!claim || claim.profileId === this.profileId) {
        if (!claim) prune(full);
        continue;
      }
      // Another boot, or an owner that is gone: the claim cannot be about work
      // that is still running.
      if (claim.bootId !== this.options.bootId || !this.isAlive(claim.pid)) {
        prune(full);
        continue;
      }
      // Alive but not refreshing: treated as busy, never as idle.
      live.push(now - claim.uptimeMs > this.staleAfterMs ? { ...claim, busy: true } : claim);
    }
    return live;
  }

  /** Why this host may not be stopped, or undefined when nothing objects. */
  blockingReason(): string | undefined {
    const busy = this.others().filter((claim) => claim.busy);
    if (!busy.length) return undefined;
    const first = busy[0];
    const what = first.kind === "maintenance" ? "a maintenance command" : "work";
    const more = busy.length > 1 ? ` and ${busy.length - 1} more` : "";
    return `Another deployment on this machine (${first.profilePath}${more}) is running ${what}.`;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    prune(path.join(this.dir, `${this.profileId}.json`));
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
  if (!claim || claim.version !== 1 || typeof claim.profileId !== "string" || !claim.profileId
    || typeof claim.bootId !== "string" || !claim.bootId || typeof claim.pid !== "number"
    || typeof claim.uptimeMs !== "number" || typeof claim.busy !== "boolean") {
    return undefined;
  }
  return {
    version: 1,
    profileId: claim.profileId,
    profilePath: typeof claim.profilePath === "string" ? claim.profilePath : "(unknown)",
    bootId: claim.bootId,
    pid: claim.pid,
    uptimeMs: claim.uptimeMs,
    busy: claim.busy,
    kind: claim.kind === "maintenance" ? "maintenance" : "runtime"
  };
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
