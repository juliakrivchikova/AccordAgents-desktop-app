import { randomUUID } from "node:crypto";
import type { MachineScriptsOperation } from "../../../shared/machineLink";
import { SCRIPTS_REQUEST_TIMEOUT_MS } from "./constants";
import type { MachineConnection, MachineScriptHost } from "./types";
import type { MachineLinkModules } from "./modules";
import type { MachineLinkDependencies } from "./dependencies";

/** Scheduled scripts on machines. */
export class MachineScripts {
  readonly scriptsChangedListeners: Array<(machineId: string) => void> = [];

  constructor(
    private readonly link: Pick<MachineLinkModules, "machineConnections" | "machineMessages">,
    private readonly deps: Pick<MachineLinkDependencies, "now" | "options">
  ) {}

  /** Ask a machine to do something with its scheduled scripts and wait for
   *  the answer. Ephemeral and sealed to that machine: a key value travels
   *  only here, never on the server or in settings. */
  async scriptsRequest(machineId: string, operation: MachineScriptsOperation, timeoutMs = SCRIPTS_REQUEST_TIMEOUT_MS): Promise<unknown> {
    const connection = this.link.machineConnections.connections.get(machineId);
    if (!connection) throw new Error("That machine is not set up on this computer.");
    if (!this.managesScripts(connection)) {
      throw new Error(`Scheduled tasks on ${connection.record.name} are managed from the desktop that set it up.`);
    }
    if (!connection.machineDeviceId) throw new Error(`${connection.record.name} is not connected right now.`);
    const hello = connection.record.lastHello;
    if (!hello) throw new Error(`${connection.record.name} has not greeted this desktop yet; try again in a moment.`);
    if (hello.scriptsSupported !== true) {
      throw new Error(`${connection.record.name} runs an older runtime without scheduled tasks; upgrade it in Settings → Machines.`);
    }
    const requestId = randomUUID();
    const answer = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.pendingScripts.delete(requestId);
        reject(new Error(`${connection.record.name} did not answer in time.`));
      }, timeoutMs);
      timer.unref?.();
      connection.pendingScripts.set(requestId, { resolve, reject, timer });
    });
    try {
      await this.link.machineMessages.send(connection, { type: "machine.scripts.request", requestId,
        ...(hello.instanceId ? { instanceId: hello.instanceId } : {}),
        expiresAt: new Date(this.deps.now().getTime() + timeoutMs).toISOString(), operation });
    } catch (error) {
      const pending = connection.pendingScripts.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        connection.pendingScripts.delete(requestId);
      }
      throw error;
    }
    return answer;
  }

  /** Every machine whose scripts this desktop manages, with whether it is
   *  connected now and runs a runtime that hosts scripts. */
  scriptHosts(): MachineScriptHost[] {
    return [...this.link.machineConnections.connections.values()].filter((connection) => this.managesScripts(connection)).map((connection) => ({
      machineId: connection.record.id,
      name: connection.record.name,
      connected: Boolean(connection.machineDeviceId),
      supported: connection.record.lastHello?.scriptsSupported === true
    }));
  }

  /** A machine takes script requests only from the desktop that set it up. */
  private managesScripts(connection: MachineConnection): boolean {
    return this.deps.options.desktopDeviceId === connection.pairing.issuer.originId;
  }

  onScriptsChanged(listener: (machineId: string) => void): () => void {
    this.scriptsChangedListeners.push(listener);
    return () => {
      const index = this.scriptsChangedListeners.indexOf(listener);
      if (index >= 0) this.scriptsChangedListeners.splice(index, 1);
    };
  }
}
