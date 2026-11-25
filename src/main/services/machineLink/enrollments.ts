import type { MobilePairingPackage } from "../../../shared/mobilePairing";
import { assertRecoverableMachineEnrollment } from "../../../shared/machineEnrollmentRecovery";
import type { MachineLinkModules } from "./modules";
import type { MachineLinkDependencies } from "./dependencies";

/** A machine's enrollment, and getting a lost one back. */
export class Enrollments {
  /** Restore this owner's existing remote connection. Never disconnects a
   *  machine that is working. */
  private enrollmentRecovery = new Map<string, { requested: string; installed: string; installedMachineId: string; task: Promise<string> }>();

  constructor(
    private readonly link: Pick<MachineLinkModules, "machineConnections">,
    private readonly deps: Pick<MachineLinkDependencies, "settings">
  ) {}

  /** The enrollment package for a machine, as the installer writes it to the
   *  machine. Read on demand and never held anywhere else. */
  async enrollmentJson(machineId: string): Promise<string> {
    const record = (await this.deps.settings.listMachines()).find((machine) => machine.id === machineId);
    if (!record) throw new Error("Machine not found.");
    const pairing = await this.deps.settings.getMachinePairing(record.pairingKey);
    if (!pairing) throw new Error("The machine's enrollment is missing; remove and add the machine again.");
    return JSON.stringify(pairing, null, 2);
  }

  restoreEnrollment(machineId: string, requestedJson: string, installedJson: string, installedMachineId = machineId): Promise<string> {
    const active = this.enrollmentRecovery.get(machineId);
    if (active) {
      if (active.requested === requestedJson && active.installed === installedJson && active.installedMachineId === installedMachineId) return active.task;
      return Promise.reject(new Error("Another connection recovery is running. Wait for it to finish, then try again."));
    }
    const task = this.restoreEnrollmentNow(machineId, requestedJson, installedJson, installedMachineId).finally(() => this.enrollmentRecovery.delete(machineId));
    this.enrollmentRecovery.set(machineId, { requested: requestedJson, installed: installedJson, installedMachineId, task });
    return task;
  }

  private async restoreEnrollmentNow(machineId: string, requestedJson: string, installedJson: string, installedMachineId: string): Promise<string> {
    const requested = JSON.parse(requestedJson) as MobilePairingPackage;
    const installed = JSON.parse(installedJson) as MobilePairingPackage;
    assertRecoverableMachineEnrollment(requested, installed);
    if (!this.deps.settings.restoreMachineEnrollment) throw new Error("Machine connection recovery is unavailable.");
    const connection = this.link.machineConnections.connections.get(machineId);
    if (machineId === installedMachineId && connection?.pairing.rendezvousId === installed.rendezvousId) return machineId;
    if (connection && (connection.machineDeviceId || (connection.record.lastHello?.activeRunIds?.length ?? 0) > 0)) {
      throw new Error("The machine still has an active connection or running work. Finish it before restoring its connection.");
    }
    await this.link.machineConnections.disconnectMachine(machineId);
    try {
      if (connection) {
        await connection.inbound;
        await connection.outbound;
        await connection.persist;
      }
      const restored = await this.deps.settings.restoreMachineEnrollment(machineId, requested, installed, installedMachineId);
      await this.link.machineConnections.connectMachine(restored);
      return restored.id;
    } catch (error) {
      // On disk failure restore the old route; after a committed save or a
      // process restart, this reads the new route and reconnects to it instead.
      const saved = (await this.deps.settings.listMachines()).find(machine => machine.id === machineId || machine.id === installedMachineId);
      if (saved) await this.link.machineConnections.connectMachine(saved).catch(() => undefined);
      throw error;
    }
  }
}
