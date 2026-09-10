import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { verifiedNativeHostReboot, type NativeHostIdentity } from "./nativeHostIdentity";
import { confirmNativeProcessClosed, spawnNativeProcess } from "./nativeProcess";
import { NativeProcessRegistry } from "./nativeProcessRegistry";
import type { MachinePowerStore } from "./machinePowerStore";
import { existsSync } from "node:fs";

/** A setup/rsync pipe owns its power hold until the same native guardian used
 * by participants has stored proof of closure. Disconnect and disk failure
 * therefore cannot turn a still-running remote install into "idle". */
export class MachineMaintenance {
  constructor(private readonly store: MachinePowerStore, private readonly registryPath: string, private readonly powerDbPath?: string) {}

  async run(options: {
    command: string; args: string[]; cwd?: string; env: NodeJS.ProcessEnv;
    stdin: Readable; stdout: Writable; stderr: Writable;
  }): Promise<number> {
    if (!this.powerDbPath) throw new Error("Maintenance requires its machine power database.");
    const scope = `maintenance:${randomUUID()}`;
    const child = await spawnNativeProcess({ command: options.command, args: options.args, cwd: options.cwd, env: options.env,
      scope, dbPath: this.registryPath, endInputWithoutStopping: true, maintenancePowerDbPath: this.powerDbPath });
    const exited = new Promise<number>((resolve, reject) => {
      child.once("close", code => resolve(code ?? 1));
      child.once("error", reject);
    });
    const inputController = new AbortController();
    const incoming = pipeline(options.stdin, child.stdin, { signal: inputController.signal });
    const outgoing = Promise.all([
      pipeline(child.stdout, options.stdout, { end: false }),
      pipeline(child.stderr, options.stderr, { end: false })
    ]);
    try {
      // Duplex clients such as rsync wait for the server to exit before they
      // close SSH stdin. Native closure is the completion boundary; waiting for
      // peer EOF as well deadlocks after the actual command has already exited.
      const code = await Promise.race([exited, incoming.then(() => exited), outgoing.then(() => exited)]);
      await outgoing;
      inputController.abort();
      await incoming.catch(() => undefined);
      return code;
    } finally {
      inputController.abort();
      // Also handles broken SSH output/input: first close native work, then
      // allow a future idle check. Never drop the hold on an unconfirmed kill.
      await confirmNativeProcessClosed(child);
    }
  }

  /** Bounded identity-only inspection. A missed heartbeat/TTL is never proof
   * of termination; only a guardian receipt or verified reboot releases it. */
  async recover(host: NativeHostIdentity): Promise<void> {
    if (!existsSync(this.registryPath)) throw new Error("The maintenance process registry is missing; closure cannot be inferred.");
    const registry = new NativeProcessRegistry(this.registryPath);
    await registry.init();
    let cursor = "";
    for (;;) {
      const receipts = await this.store.maintenanceReceipts(cursor);
      if (!receipts.length) return;
      for (const receipt of receipts) {
        cursor = receipt.leaseId;
        if (receipt.registryPath !== this.registryPath || receipt.scope !== receipt.leaseId || !receipt.scope.startsWith("maintenance:")) {
          throw new Error("The maintenance receipt belongs to an unexpected process registry.");
        }
        if (verifiedNativeHostReboot(receipt.host, host)) {
          await this.store.releaseMaintenance(receipt.leaseId, receipt.host.boot);
          continue;
        }
        if (receipt.host.machine !== host.machine || receipt.host.boot !== host.boot) {
          throw new Error("Maintenance belongs to an unverified host; its process IDs cannot be used for recovery.");
        }
        const native = await registry.get(receipt.scope);
        if (!native) throw new Error("A maintenance guardian receipt is missing; closure cannot be inferred.");
        if (native.phase === "closed") {
          await this.store.releaseMaintenance(receipt.leaseId, host.boot);
        }
      }
    }
  }
}
