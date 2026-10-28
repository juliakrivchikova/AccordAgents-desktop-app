/**
 * The shared relay is gone. A machine enrolled with it and a phone paired
 * through it can never connect again: they are taken off this desktop at the
 * first start without the relay, the usual way (a machine as Remove in
 * Settings does it). The phones, their key files and the start keys handed
 * to them go at that start whatever happens to the machines; a machine that
 * cannot be removed is tried again at every start. Settings says nothing
 * about it (docs/machines/04-install-and-upgrade.md has the start-key steps).
 */

import type { MachineRecord } from "../../shared/machineLink";
import type { MachinePowerHandoffRecord } from "../../shared/machinePowerHandoff";
import type { RelayRemovalRecord } from "./settings";

export interface RelayRemovalOptions {
  settings: {
    relayRemoval(): Promise<RelayRemovalRecord | undefined>;
    relayEraMachines(): Promise<MachineRecord[]>;
    beginRelayRemoval(found: { machines: Array<{ id: string; name: string }>; startKeyHanded: boolean }): Promise<void>;
    noteRelayRemovalFailures(failures: Array<{ machineId: string; machine: string; message: string }>): Promise<void>;
    noteRelayMachinesRemoved(names: string[]): Promise<void>;
    finishRelayRemoval(notRemoved: string[]): Promise<RelayRemovalRecord | undefined>;
  };
  /** The usual removal of a machine (Settings > Remove). */
  removeMachine(machineId: string): Promise<unknown>;
  handoffs: {
    list(): Promise<MachinePowerHandoffRecord[]>;
    revoke(handoffId: string, reason: string): Promise<unknown>;
  };
  log?(event: string, payload: Record<string, unknown>): void;
}

/** Returns the record when this start took the relay's phones off (once). */
export async function removeRelayEraRecords(options: RelayRemovalOptions): Promise<RelayRemovalRecord | undefined> {
  const earlier = await options.settings.relayRemoval();
  // Machine enrollments that cannot be opened now (the system's secret
  // store) keep only the machines for a later start, not the phones.
  let machines: MachineRecord[] | undefined;
  try {
    machines = await options.settings.relayEraMachines();
  } catch (error) {
    options.log?.("relay.machines-unreadable", { message: error instanceof Error ? error.message : String(error) });
  }
  if (!earlier) {
    // A phone paired through the relay was handed the key that starts the
    // AWS machine. Read before any machine goes: removing a machine settles
    // its records, and the copy each phone keeps stays valid all the same.
    const live = (await options.handoffs.list()).filter((record) => !record.revokedAt);
    await options.settings.beginRelayRemoval({ machines: (machines ?? []).map((machine) => ({ id: machine.id, name: machine.name })), startKeyHanded: live.length > 0 });
  }
  // Each machine on its own: one that cannot be removed now does not keep
  // the others, nor the phones; it is tried again at the next start.
  const failures: Array<{ machineId: string; machine: string; message: string }> = [];
  const removed: string[] = [];
  for (const machine of machines ?? []) {
    try {
      await options.removeMachine(machine.id);
      removed.push(machine.name);
    } catch (error) {
      failures.push({ machineId: machine.id, machine: machine.name, message: plainReason(error instanceof Error ? error.message : String(error)) });
    }
  }
  if (earlier) {
    // Named before its failure goes: a stop in between leaves it named.
    await options.settings.noteRelayMachinesRemoved(removed);
    if (machines) await options.settings.noteRelayRemovalFailures(failures);
    return undefined;
  }
  if (machines) await options.settings.noteRelayRemovalFailures(failures);
  for (const record of await options.handoffs.list()) {
    if (!record.revokedAt) await options.handoffs.revoke(record.handoffId, "relay-removed");
  }
  return options.settings.finishRelayRemoval(failures.map((failure) => failure.machineId));
}

/** One clean line of an error, short, without its final stop. */
function plainReason(message: string): string {
  const line = message.split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? "unknown error";
  return (line.length > 200 ? `${line.slice(0, 197)}…` : line).replace(/[.!?]$/, "");
}
