import { execFile } from "node:child_process";
import type { CapturedPosixProcess } from "./processTermination";
import type { NativeHostIdentity } from "./nativeHostIdentity";

export interface NativeProcessLease {
  scope: string;
  generation: number;
  token: string;
  supervisor: CapturedPosixProcess;
  parent: CapturedPosixProcess;
  phase: "launching" | "running" | "closed";
  provider?: CapturedPosixProcess;
  descendants: CapturedPosixProcess[];
  host?: NativeHostIdentity;
  /** A shell gate cannot exec the provider before the running receipt commits. */
  launchGate?: 1;
  shutdownReason?: "processes-gone" | "host-rebooted" | "never-started";
}

/** A process receipt contains identities only, never CLI arguments, environment,
 * prompts or output. SQLite arbitrates competing processes; timeouts never
 * release ownership. The supervisor is responsible for proving termination. */
export class NativeProcessRegistry {
  constructor(readonly dbPath: string, readonly sqliteExecutable = "sqlite3") {}

  async init(): Promise<void> {
    await this.query(`pragma journal_mode = wal;
      create table if not exists native_provider_processes (
        scope text primary key, generation integer not null, token text not null,
        phase text not null check(phase in ('launching','running','closed')), receipt text not null
      );`);
  }

  async get(scope: string): Promise<NativeProcessLease | undefined> {
    const rows = await this.query<{ receipt: string }>(`select receipt from native_provider_processes where scope = ${quote(scope)};`);
    return rows[0] ? readLease(rows[0].receipt) : undefined;
  }

  async acquire(input: Omit<NativeProcessLease, "generation" | "phase" | "descendants" | "provider">): Promise<NativeProcessLease | undefined> {
    const receipt = JSON.stringify({ ...input, phase: "launching", descendants: [] });
    const rows = await this.query<{ receipt: string }>(`begin immediate;
      insert into native_provider_processes(scope,generation,token,phase,receipt)
      values (${quote(input.scope)},1,${quote(input.token)},'launching',json_set(${quote(receipt)},'$.generation',1))
      on conflict(scope) do update set generation = generation + 1, token = excluded.token,
        phase = excluded.phase, receipt = json_set(excluded.receipt,'$.generation',generation + 1)
        where phase = 'closed'
      returning receipt;
      commit;`);
    return rows[0] ? readLease(rows[0].receipt) : undefined;
  }

  async update(lease: NativeProcessLease): Promise<void> {
    const rows = await this.query<{ scope: string }>(`update native_provider_processes
      set phase = ${quote(lease.phase)}, receipt = ${quote(JSON.stringify(lease))}
      where scope = ${quote(lease.scope)} and token = ${quote(lease.token)} and generation = ${lease.generation}
        and phase != 'closed' returning scope;`);
    if (!rows.length) throw new Error("The native process lease changed before its receipt could be stored.");
  }

  private query<T>(sql: string): Promise<T[]> {
    return new Promise((resolve, reject) => {
      const child = execFile(this.sqliteExecutable, ["-batch", "-json", "-cmd", ".timeout 5000", this.dbPath],
        { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
          if (error) { reject(new Error(`The native process receipt could not be stored: ${error.message}`)); return; }
          try { resolve(stdout.trim() ? JSON.parse(stdout) as T[] : []); } catch { reject(new Error("The native process receipt query returned invalid data.")); }
        });
      child.stdin?.on("error", reject);
      child.stdin?.end(`pragma synchronous = full; pragma fullfsync = on; ${sql}`);
    });
  }
}

function readLease(json: string): NativeProcessLease {
  const value = JSON.parse(json) as NativeProcessLease;
  const identity = (item: CapturedPosixProcess | undefined): boolean => Boolean(item && Number.isSafeInteger(item.pid) && item.pid > 0 && typeof item.startedAt === "string" && item.startedAt);
  if (!value || typeof value.scope !== "string" || typeof value.token !== "string" || !value.token ||
      !Number.isSafeInteger(value.generation) || value.generation < 1 || !identity(value.supervisor) || !identity(value.parent) ||
      !["launching", "running", "closed"].includes(value.phase) || !Array.isArray(value.descendants) || !value.descendants.every(identity) ||
      (value.provider !== undefined && !identity(value.provider)) || (value.phase === "running" && !value.provider)) {
    throw new Error("The native process receipt is corrupt; ownership cannot be inferred.");
  }
  if (value.host && (!/^[a-f0-9]{64}$/.test(value.host.machine) || !/^[a-f0-9-]{32,36}$/.test(value.host.boot))) {
    throw new Error("The native process host identity is corrupt.");
  }
  if ((value.launchGate !== undefined && value.launchGate !== 1) || (value.shutdownReason !== undefined &&
      !["processes-gone", "host-rebooted", "never-started"].includes(value.shutdownReason))) {
    throw new Error("The native process shutdown receipt is corrupt.");
  }
  return value;
}

function quote(value: string): string { return `'${value.replace(/'/g, "''")}'`; }
