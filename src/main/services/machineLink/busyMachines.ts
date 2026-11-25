import { type MachineActivity, machineActivityIsBusy } from "./activityState";
import { MACHINE_ACTIVITY_TIMEOUT_MS } from "./constants";
import type { MachineLinkModules } from "./modules";
import type { MachineLinkDependencies } from "./dependencies";

/** Whether a machine is busy. */
export class BusyMachines {
  constructor(
    private readonly link: Pick<MachineLinkModules, "machineConnections" | "machineMessages">,
    private readonly deps: Pick<MachineLinkDependencies, "debugLogs" | "options">
  ) {}

  /** What one machine is doing right now, from a hello it sends on request.
   *  Answered with the last known hello when the machine does not reply in
   *  time, and undefined when it is not enrolled or not connected. */
  async machineActivity(machineId: string, options: { fresh?: boolean; timeoutMs?: number } = {}): Promise<MachineActivity | undefined> {
    const connection = this.link.machineConnections.connections.get(machineId);
    if (!connection?.machineDeviceId) return undefined;
    let fresh = false;
    if (options.fresh !== false) {
      if (!connection.activityProbe) {
        const probe = new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => finish(false), options.timeoutMs ?? MACHINE_ACTIVITY_TIMEOUT_MS);
          timer.unref?.();
          const onHello = (event: { machineId: string }): void => { if (event.machineId === machineId) finish(true); };
          const finish = (value: boolean): void => {
            clearTimeout(timer);
            this.link.machineConnections.emitter.off("hello", onHello);
            if (connection.activityProbe === probe) connection.activityProbe = undefined;
            void this.deps.debugLogs.write("machine-link.activity", { machineId, fresh: value });
            resolve(value);
          };
          this.link.machineConnections.emitter.on("hello", onHello);
          void this.link.machineMessages.send(connection, { type: "machine.hello.request", desktopDeviceId: this.deps.options.desktopDeviceId }).catch(() => undefined);
        });
        connection.activityProbe = probe;
      }
      fresh = await connection.activityProbe;
    }
    const hello = connection.record.lastHello;
    return {
      machineId,
      connected: Boolean(connection.machineDeviceId),
      fresh,
      appVersion: hello?.appVersion,
      activeRunIds: [...(hello?.activeRunIds ?? [])]
    };
  }

  /** True while any connected machine is running a turn, asked afresh. */
  async anyMachineBusy(options: { timeoutMs?: number } = {}): Promise<boolean> {
    const activities = await Promise.all([...this.link.machineConnections.connections.keys()].map((machineId) => this.machineActivity(machineId, options)));
    // A connected machine that did not answer is not known to be idle.
    return activities.some((activity) => activity !== undefined && (!activity.fresh || machineActivityIsBusy(activity)));
  }
}
