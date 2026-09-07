import type { MachineIdleState } from "./machineIdle";
import type { CapturedPosixProcess } from "./processTermination";
import type { NativeHostIdentity } from "./nativeHostIdentity";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

export interface MachineMaintenanceReceipt {
  leaseId: string;
  host: NativeHostIdentity;
  owner: CapturedPosixProcess;
  registryPath: string;
  scope: string;
}

export const MACHINE_POWER_SCHEMA = `
  create table if not exists machine_power_state (
    singleton integer primary key check(singleton=1),
    boot_id text not null,
    idle_since_ms real check(idle_since_ms is null or idle_since_ms>=0),
    stop_fence text
  );
  create table if not exists machine_maintenance_leases (
    lease_id text primary key,
    boot_id text not null,
    expires_uptime_ms real not null check(expires_uptime_ms>=0)
  );
  create table if not exists machine_maintenance_receipts (
    lease_id text primary key,
    receipt text not null
  );
`;

interface Database {
  init(): Promise<void>;
  query<T>(sql: string): Promise<T[]>;
  execute(sql: string): Promise<void>;
}

/** Idle drain and installer/mirror leases share a local SQLite transaction.
 * A maintenance operation cannot start between the final idle check and EC2
 * Stop, and a new runtime cannot forget a stop with an uncertain response. */
export class MachinePowerStore {
  constructor(private readonly database: Database) {}

  async read(): Promise<MachineIdleState | undefined> {
    await this.database.init();
    return (await this.database.query<MachineIdleState>("select 1 as version,boot_id as bootId,idle_since_ms as idleSinceMs from machine_power_state where singleton=1;"))[0];
  }

  async write(state: MachineIdleState): Promise<void> {
    validateIdentity(state.bootId);
    if (state.idleSinceMs !== null) validateTime(state.idleSinceMs);
    await this.database.init();
    const rows = await this.database.query<{ saved: number }>(`pragma synchronous=FULL;
      insert into machine_power_state(singleton,boot_id,idle_since_ms) values(1,${q(state.bootId)},${state.idleSinceMs ?? "null"})
      on conflict(singleton) do update set boot_id=excluded.boot_id,idle_since_ms=excluded.idle_since_ms,
        stop_fence=case when boot_id!=excluded.boot_id then null else stop_fence end
      where stop_fence is null or boot_id!=excluded.boot_id returning 1 as saved;`);
    if (!rows.length) throw new Error("The machine has a retained idle-stop fence; new activity is held until that stop is resolved.");
  }

  async stopFence(bootId: string): Promise<string | undefined> {
    validateIdentity(bootId); await this.database.init();
    return (await this.database.query<{ fence: string }>(`select stop_fence as fence from machine_power_state where singleton=1 and boot_id=${q(bootId)} and stop_fence is not null;`))[0]?.fence;
  }

  async hasMaintenance(bootId: string, uptimeMs: number): Promise<boolean> {
    validateIdentity(bootId); validateTime(uptimeMs); await this.database.init();
    // Expiry proves a missed renewal, not that remote maintenance stopped.
    // Only its owner or verified process recovery may release this gate.
    return (await this.database.query<{ busy: number }>(`select exists(select 1 from machine_maintenance_leases where boot_id=${q(bootId)}) as busy;`))[0]?.busy === 1;
  }

  /** Runtime caller already fenced its in-process event/native admissions and
   * checked active continuations, approvals and background work. This final
   * shared guard checks durable commands and maintenance in the same commit. */
  async tryFence(bootId: string, uptimeMs: number, fenceId: string, expectedIdleSinceMs: number): Promise<boolean> {
    validateIdentity(bootId); validateIdentity(fenceId); validateTime(uptimeMs); validateTime(expectedIdleSinceMs); await this.database.init();
    const rows = await this.database.query<{ fence: string }>(`pragma synchronous=FULL; begin immediate;
      delete from machine_maintenance_leases where boot_id!=${q(bootId)};
      update machine_power_state set stop_fence=${q(fenceId)} where singleton=1 and boot_id=${q(bootId)}
        and stop_fence is null and idle_since_ms=${expectedIdleSinceMs}
        and not exists(select 1 from machine_maintenance_leases)
        and not exists(select 1 from native_commands where phase!='finished')
        and not exists(select 1 from device_event_inbox i join chat_events e on e.event_id=i.event_id
          where i.applied_at is null and e.kind in ('machine.turn.request','machine.approval.decision'))
      returning stop_fence as fence;
      commit;`);
    return rows.length === 1;
  }

  /** Called by install/upgrade/explicit mirror work before changing the
   * machine. Renewal fails once a lease expired instead of reviving it over
   * an idle-stop fence. A process that loses its lease must stop its work. */
  async maintenance(leaseId: string, bootId: string, uptimeMs: number, expiresUptimeMs: number, renew = false): Promise<boolean> {
    validateIdentity(leaseId); validateIdentity(bootId); validateTime(uptimeMs); validateTime(expiresUptimeMs);
    if (expiresUptimeMs <= uptimeMs) throw new Error("A maintenance lease must expire after it is acquired.");
    await this.database.init();
    const eligible = `not exists(select 1 from machine_power_state where singleton=1 and boot_id=${q(bootId)} and stop_fence is not null)`;
    const rows = await this.database.query<{ leaseId: string }>(`pragma synchronous=FULL;
      ${renew ? `update machine_maintenance_leases set expires_uptime_ms=${expiresUptimeMs}
        where lease_id=${q(leaseId)} and boot_id=${q(bootId)} and expires_uptime_ms>${uptimeMs} and ${eligible}`
        : `insert into machine_maintenance_leases(lease_id,boot_id,expires_uptime_ms)
        select ${q(leaseId)},${q(bootId)},${expiresUptimeMs} where ${eligible}
        on conflict(lease_id) do update set expires_uptime_ms=excluded.expires_uptime_ms
        where boot_id=excluded.boot_id and expires_uptime_ms>${uptimeMs} and ${eligible}`}
      returning lease_id as leaseId;`);
    return rows.length === 1;
  }

  async releaseMaintenance(leaseId: string, bootId: string): Promise<void> {
    validateIdentity(leaseId); validateIdentity(bootId); await this.database.init();
    // Ending even a sub-tick maintenance operation resets idle atomically.
    await this.database.execute(`pragma synchronous=FULL; begin immediate;
      update machine_power_state set idle_since_ms=null where singleton=1 and boot_id=${q(bootId)} and stop_fence is null
        and exists(select 1 from machine_maintenance_leases where lease_id=${q(leaseId)} and boot_id=${q(bootId)});
      delete from machine_maintenance_leases where lease_id=${q(leaseId)} and boot_id=${q(bootId)};
      delete from machine_maintenance_receipts where lease_id=${q(leaseId)}
        and not exists(select 1 from machine_maintenance_leases where lease_id=${q(leaseId)});
      commit;`);
  }

  /** The receipt names only an OS owner and its guardian scope, never argv,
   * output, environment or enrollment. It commits before any child can start. */
  async acquireGuardedMaintenance(receipt: MachineMaintenanceReceipt): Promise<boolean> {
    readMaintenanceReceipt(JSON.stringify(receipt));
    await this.database.init();
    const rows = await this.database.query<{ leaseId: string }>(`pragma synchronous=FULL; begin immediate;
      insert into machine_maintenance_leases(lease_id,boot_id,expires_uptime_ms)
        select ${q(receipt.leaseId)},${q(receipt.host.boot)},${Number.MAX_SAFE_INTEGER}
        where not exists(select 1 from machine_power_state where singleton=1 and boot_id=${q(receipt.host.boot)} and stop_fence is not null);
      insert into machine_maintenance_receipts(lease_id,receipt)
        select ${q(receipt.leaseId)},${q(JSON.stringify(receipt))}
        where exists(select 1 from machine_maintenance_leases where lease_id=${q(receipt.leaseId)});
      select lease_id as leaseId from machine_maintenance_receipts where lease_id=${q(receipt.leaseId)};
      commit;`);
    return rows.length === 1;
  }

  async maintenanceReceipts(afterLeaseId = ""): Promise<MachineMaintenanceReceipt[]> {
    await this.database.init();
    const rows = await this.database.query<{ leaseId: string; receipt: string }>(`select lease_id as leaseId,receipt from machine_maintenance_receipts
      where lease_id>${q(afterLeaseId)} order by lease_id limit 100;`);
    return rows.map(row => {
      const receipt = readMaintenanceReceipt(row.receipt);
      if (receipt.leaseId !== row.leaseId) throw new Error("The maintenance receipt identity is inconsistent.");
      return receipt;
    });
  }
}

/** The guardian needs only the already-created local power tables, not the
 * application's platform, settings or complete conversation store. */
export function openMachinePowerStore(dbPath: string, sqliteExecutable = "sqlite3"): MachinePowerStore {
  const query = <T>(sql: string): Promise<T[]> => new Promise((resolve, reject) => {
    if (!existsSync(dbPath)) { reject(new Error("The maintenance power database disappeared; no operation can be admitted.")); return; }
    const child = execFile(sqliteExecutable, ["-batch", "-bail", "-json", "-cmd", ".timeout 5000", dbPath],
      { encoding: "utf8", maxBuffer: 512 * 1024 }, (error, stdout) => {
        if (error) { reject(new Error(`Maintenance power persistence failed: ${error.message}`)); return; }
        try { resolve(stdout.trim() ? JSON.parse(stdout) as T[] : []); } catch { reject(new Error("Maintenance power persistence returned invalid data.")); }
      });
    child.stdin?.on("error", reject);
    child.stdin?.end(`pragma synchronous=FULL; pragma fullfsync=on; ${sql}`);
  });
  return new MachinePowerStore({ init: async () => { await query(MACHINE_POWER_SCHEMA); }, query,
    execute: async sql => { await query(sql); } });
}

function readMaintenanceReceipt(json: string): MachineMaintenanceReceipt {
  const value = JSON.parse(json) as MachineMaintenanceReceipt;
  if (!value || typeof value.leaseId !== "string" || !value.leaseId || typeof value.scope !== "string" || !value.scope ||
      typeof value.registryPath !== "string" || !value.registryPath || !value.host ||
      !/^[a-f0-9]{64}$/.test(value.host.machine) || !/^[a-f0-9-]{32,36}$/.test(value.host.boot) ||
      !value.owner || !Number.isSafeInteger(value.owner.pid) || value.owner.pid < 1 ||
      typeof value.owner.startedAt !== "string" || !value.owner.startedAt) {
    throw new Error("The maintenance process receipt is unreadable; automatic stop must wait for recovery.");
  }
  return value;
}

function validateIdentity(value: string): void { if (typeof value !== "string" || !value.trim()) throw new Error("Machine power operations require an identity."); }
function validateTime(value: number): void { if (!Number.isFinite(value) || value < 0) throw new Error("Machine power operations require host uptime."); }
function q(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
