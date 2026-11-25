import type { MachineRecord } from "../../../../shared/machineLink";
import type { MachineInstallRecord } from "../../../../shared/machineInstall";
import type { MobilePairingPackage } from "../../../../shared/mobilePairing";
import { assertRecoverableMachineEnrollment } from "../../../../shared/machineEnrollmentRecovery";
import { isDeepStrictEqual } from "node:util";
import type { SettingsModules } from "../modules";

/** The machines added to this computer and what is installed on them. */
export class MachineRegistry {
  private enrollmentRecovery: Promise<unknown> = Promise.resolve();

  constructor(private readonly settings: Pick<SettingsModules, "machineSnapshot" | "secrets" | "settingsStore">) {}

  // Machines transport: enrolled machines and their sealed pairing packages.
  async listMachines(): Promise<MachineRecord[]> {
    const stored = await this.settings.settingsStore.readStored();
    return (stored.machines ?? []).map((machine) => ({ ...machine }));
  }

  async saveMachine(record: MachineRecord, pairing?: MobilePairingPackage): Promise<MachineRecord[]> {
    const stored = await this.settings.settingsStore.readStored();
    const machines = (stored.machines ?? []).filter((machine) => machine.id !== record.id);
    machines.push({ ...record });
    stored.machines = machines;
    if (pairing) {
      const pairings = this.settings.machineSnapshot.readMachinePairings(stored);
      pairings[record.pairingKey] = pairing;
      stored.encryptedMachinePairings = this.settings.secrets.sealJson(JSON.stringify(pairings));
    }
    await this.settings.settingsStore.writeStored(stored);
    return machines.map((machine) => ({ ...machine }));
  }

  restoreMachineEnrollment(id: string, requested: MobilePairingPackage, installed: MobilePairingPackage, installedMachineId = id): Promise<MachineRecord> {
    const expected = structuredClone(requested), existing = structuredClone(installed);
    const task = this.enrollmentRecovery.then(() => this.commitMachineEnrollment(id, expected, existing, installedMachineId));
    this.enrollmentRecovery = task.catch(() => undefined);
    return task;
  }

  private async commitMachineEnrollment(id: string, requested: MobilePairingPackage, installed: MobilePairingPackage, installedMachineId: string): Promise<MachineRecord> {
    assertRecoverableMachineEnrollment(requested, installed);
    if (!installedMachineId.trim() || installedMachineId.length > 256) throw new Error("The saved machine identity is invalid.");
    const stored = await this.settings.settingsStore.readStored();
    if (this.settings.settingsStore.readError) throw new Error("Settings could not be read; the saved connection was left untouched.");
    const record = stored.machines?.find(machine => machine.id === id);
    const pairings = this.settings.machineSnapshot.readMachinePairings(stored);
    if (!record) {
      const restored = stored.machines?.find(machine => machine.id === installedMachineId);
      if (restored?.pairingKey === installed.rendezvousId && isDeepStrictEqual(pairings[restored.pairingKey], installed)) return { ...restored };
      throw new Error("Machine not found.");
    }
    if (record.id === installedMachineId && record.pairingKey === installed.rendezvousId && isDeepStrictEqual(pairings[record.pairingKey], installed)) return { ...record };
    if (record.lastHello?.activeRunIds?.length) {
      throw new Error("The machine has pending actions. Finish them before restoring its connection.");
    }
    if (record.pairingKey !== requested.rendezvousId || !isDeepStrictEqual(pairings[record.pairingKey], requested)) {
      throw new Error("The machine connection changed during setup. Try again.");
    }
    if (installedMachineId !== id && (record.deviceId || stored.machines?.some(machine => machine.id === installedMachineId))) {
      throw new Error("A connected machine identity cannot be replaced. The saved connection was kept.");
    }
    if (stored.machines?.some(machine => machine.id !== id && machine.pairingKey === installed.rendezvousId)) {
      throw new Error("This installation is already connected as another machine on this desktop.");
    }
    const restored = { ...record, id: installedMachineId, pairingKey: installed.rendezvousId };
    pairings[installed.rendezvousId] = installed;
    // Commit the route and its sealed capability together, before reconnecting.
    // Do not mutate readStored's object: a failed write must retain the old route.
    await this.settings.settingsStore.writeStored({ ...stored,
      machines: stored.machines!.map(machine => machine.id === id ? restored : machine),
      machineInstalls: stored.machineInstalls?.map(install => install.machineId === id ? { ...install, machineId: installedMachineId,
        lastOperation: install.lastOperation ? { ...install.lastOperation, machineId: installedMachineId } : undefined } : install),
      encryptedMachinePairings: this.settings.secrets.sealJson(JSON.stringify(pairings))
    }, true);
    return restored;
  }

  async removeMachine(id: string): Promise<MachineRecord[]> {
    const stored = await this.settings.settingsStore.readStored();
    const removed = (stored.machines ?? []).find((machine) => machine.id === id);
    stored.machines = (stored.machines ?? []).filter((machine) => machine.id !== id);
    // A removed machine must not leave this desktop's way into it behind.
    const installs = (stored.machineInstalls ?? []).filter((record) => record.machineId !== id);
    stored.machineInstalls = installs.length ? installs : undefined;
    if (removed) {
      const pairings = this.settings.machineSnapshot.readMachinePairings(stored);
      delete pairings[removed.pairingKey];
      stored.encryptedMachinePairings = this.settings.secrets.sealJson(JSON.stringify(pairings));
    }
    await this.settings.settingsStore.writeStored(stored);
    return (stored.machines ?? []).map((machine) => ({ ...machine }));
  }

  /** Machine install records (machines transport, install/upgrade). Kept next
   *  to the machine records but deliberately outside the settings snapshot a
   *  machine receives. */
  async listMachineInstalls(): Promise<MachineInstallRecord[]> {
    const stored = await this.settings.settingsStore.readStored();
    return (stored.machineInstalls ?? []).map((record) => ({ ...record }));
  }

  async getMachineInstall(machineId: string): Promise<MachineInstallRecord | undefined> {
    const stored = await this.settings.settingsStore.readStored();
    const found = (stored.machineInstalls ?? []).find((record) => record.machineId === machineId);
    return found ? { ...found } : undefined;
  }

  async saveMachineInstall(record: MachineInstallRecord): Promise<void> {
    const stored = await this.settings.settingsStore.readStored();
    const records = (stored.machineInstalls ?? []).filter((entry) => entry.machineId !== record.machineId);
    records.push({ ...record });
    stored.machineInstalls = records;
    await this.settings.settingsStore.writeStored(stored);
  }

  async removeMachineInstall(machineId: string): Promise<void> {
    const stored = await this.settings.settingsStore.readStored();
    const records = (stored.machineInstalls ?? []).filter((entry) => entry.machineId !== machineId);
    stored.machineInstalls = records.length ? records : undefined;
    await this.settings.settingsStore.writeStored(stored);
  }
}
