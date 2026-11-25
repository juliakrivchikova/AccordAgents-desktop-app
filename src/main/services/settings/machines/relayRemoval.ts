import { rm } from "node:fs/promises";
import path from "node:path";
import { userDataPath } from "../../../platform";
import type { MachineRecord } from "../../../../shared/machineLink";
import type { RelayRemovalFailure, RelayRemovalRecord } from "./relayRemovalRecords";
import type { SettingsModules } from "../modules";

/** Moving off the old relay. */
export class RelayRemoval {
  constructor(private readonly settings: Pick<SettingsModules, "machineSnapshot" | "settingsStore" | "trustedDevices">) {}

  /**
   * The machines that were enrolled with the shared relay: their enrollment
   * names no server of the User's, so they can never connect again. Every
   * machine set up since names the server, so this empties as they go.
   */
  async relayEraMachines(): Promise<MachineRecord[]> {
    const stored = await this.settings.settingsStore.readStored();
    if (this.settings.settingsStore.readError) throw new Error("Settings could not be read; nothing was changed.");
    const pairings = this.settings.machineSnapshot.readMachinePairings(stored);
    return (stored.machines ?? []).filter((machine) => {
      const pairing = pairings[machine.pairingKey];
      return Boolean(pairing) && !pairing.hubUrl;
    }).map((machine) => ({ ...machine }));
  }

  /** What a removal found before it takes anything off, merged with what an
   *  earlier, unfinished one found: the record names all of it. */
  beginRelayRemoval(found: { machines: Array<{ id: string; name: string }>; startKeyHanded: boolean }): Promise<void> {
    return this.settings.trustedDevices.serializeDeviceTrust(async () => {
      const stored = await this.settings.settingsStore.readStored();
      if (this.settings.settingsStore.readError) throw new Error("Settings could not be read; nothing was changed.");
      if (stored.relayRemoval) return;
      const before = stored.relayRemovalPending;
      stored.relayRemovalPending = {
        machines: [...(before?.machines ?? []), ...found.machines.filter((machine) => !before?.machines.some((known) => known.id === machine.id))]
          .map((machine) => ({ id: machine.id, name: machine.name })),
        startKeyHanded: Boolean(before?.startKeyHanded) || found.startKeyHanded
      };
      await this.settings.settingsStore.writeStored(stored, true);
    });
  }

  /**
   * Takes what was set up through the shared relay off this desktop, once:
   * the phones paired through it (a phone paired with the User's server has
   * the invite it enrolled with), and the files the relay's pairings kept.
   * The machines went first, through the usual removal (relayEraMachines);
   * what was found is recorded, but for the machines whose ids
   * are in `notRemoved` (their removal failed; tried again at each start).
   * Returns the record, or undefined when this was done before.
   */
  finishRelayRemoval(notRemoved: string[] = []): Promise<RelayRemovalRecord | undefined> {
    return this.settings.trustedDevices.serializeDeviceTrust(async () => {
      const stored = await this.settings.settingsStore.readStored();
      if (this.settings.settingsStore.readError) throw new Error("Settings could not be read; nothing was changed.");
      if (stored.relayRemoval) return undefined;
      const phones = (stored.trustedDevices ?? []).filter((device) => device.role === "phone" && !device.inviteId);
      stored.trustedDevices = (stored.trustedDevices ?? []).filter((device) => !phones.includes(device));
      // The files only the relay's phone pairings used; they hold its keys.
      for (const name of ["mobile-paired-devices.json", "pending-mailbox-revocations.json"]) {
        await rm(path.join(userDataPath(), name), { force: true });
      }
      stored.relayRemoval = {
        removedAt: new Date().toISOString(),
        machines: (stored.relayRemovalPending?.machines ?? []).filter((machine) => !notRemoved.includes(machine.id)).map((machine) => machine.name),
        phones: phones.map((phone) => phone.name),
        startKeyHanded: stored.relayRemovalPending?.startKeyHanded ?? false
      };
      delete stored.relayRemovalPending;
      await this.settings.settingsStore.writeStored(stored, true);
      return { ...stored.relayRemoval };
    });
  }

  /** Relay machines a later start removed (after failing before): added to
   *  the record. */
  noteRelayMachinesRemoved(names: string[]): Promise<void> {
    return this.settings.trustedDevices.serializeDeviceTrust(async () => {
      if (names.length === 0) return;
      const stored = await this.settings.settingsStore.readStored();
      if (this.settings.settingsStore.readError) throw new Error("Settings could not be read; nothing was changed.");
      if (!stored.relayRemoval) return;
      stored.relayRemoval = { ...stored.relayRemoval, machines: [...stored.relayRemoval.machines, ...names] };
      await this.settings.settingsStore.writeStored(stored, true);
    });
  }

  /** The relay machines whose removal failed at this start, replacing the
   *  last start's; one removed (or gone) is dropped. */
  noteRelayRemovalFailures(failures: Array<{ machineId: string; machine: string; message: string }>): Promise<void> {
    return this.settings.trustedDevices.serializeDeviceTrust(async () => {
      const stored = await this.settings.settingsStore.readStored();
      if (this.settings.settingsStore.readError) throw new Error("Settings could not be read; nothing was changed.");
      const before = stored.relayRemovalFailures ?? [];
      if (failures.length === 0 && before.length === 0) return;
      const at = new Date().toISOString();
      const next = failures.map((failure): RelayRemovalFailure => {
        const earlier = before.find((entry) => entry.machineId === failure.machineId);
        return {
          ...failure,
          at: earlier && earlier.message === failure.message ? earlier.at : at
        };
      });
      if (JSON.stringify(next) === JSON.stringify(before)) return;
      if (next.length) stored.relayRemovalFailures = next;
      else delete stored.relayRemovalFailures;
      await this.settings.settingsStore.writeStored(stored, true);
    });
  }

  async relayRemovalFailures(): Promise<RelayRemovalFailure[]> {
    const stored = await this.settings.settingsStore.readStored();
    return (stored.relayRemovalFailures ?? []).map((failure) => ({ ...failure }));
  }

  async relayRemoval(): Promise<RelayRemovalRecord | undefined> {
    const stored = await this.settings.settingsStore.readStored();
    return stored.relayRemoval ? { ...stored.relayRemoval } : undefined;
  }
}
