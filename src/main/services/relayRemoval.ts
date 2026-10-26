/**
 * The shared relay is gone. A machine enrolled with it and a phone paired
 * through it can never connect again: they are taken off this desktop at the
 * first start without the relay, the usual way (a machine as Remove in
 * Settings does it), and Settings says so in one line until it is dismissed.
 * The phones, their key files and the start keys handed to them go at that
 * start whatever happens to the machines; a machine that cannot be removed
 * is named in a line of its own and tried again at every start.
 */

import type { MachineRecord } from "../../shared/machineLink";
import type { MachinePowerHandoffRecord } from "../../shared/machinePowerHandoff";
import type { RelayRemovalFailure, RelayRemovalRecord } from "./settings";

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

/** The relay's lines in Settings: what its removal took off this desktop,
 *  and the machines that could not be removed yet. Each is left out once
 *  dismissed (a machine's, until it fails for another reason). */
export function relayRemovalNotices(removed: RelayRemovalRecord | undefined, now: {
  hasServer: boolean; serverPhones: number; failures?: RelayRemovalFailure[]; leftToRemove?: string[];
}): Array<{ id: string; text: string }> {
  const notice = relayRemovalNotice(removed, now);
  const failing = failureNotice(now.failures ?? [], now.leftToRemove);
  return [...(notice ? [notice] : []), ...(failing ? [failing] : [])];
}

function failureNotice(failures: RelayRemovalFailure[], leftToRemove: string[] | undefined): { id: string; text: string } | undefined {
  // Removed since (Settings), a machine is no longer there to be tried again.
  const shown = failures.filter((failure) => !failure.dismissedMessages?.includes(failure.message)
    && (!leftToRemove || leftToRemove.includes(failure.machineId)));
  if (shown.length === 0) return undefined;
  const latest = shown.map((failure) => failure.at).sort().pop();
  const named = joinList(shown.map((failure) => `${failure.machine} (${failure.message})`));
  return {
    id: `relay-removed:failed:${latest}`,
    text: shown.length === 1
      ? `AccordAgents no longer uses its shared relay. The machine ${named}, set up through it, could not be removed from this computer yet; it is tried again at each start.`
      : `AccordAgents no longer uses its shared relay. The machines ${named}, set up through it, could not be removed from this computer yet; they are tried again at each start.`
  };
}

/** The one line about what the relay's removal took off this desktop, or
 *  undefined when there is nothing to say (or it was dismissed). */
export function relayRemovalNotice(removed: RelayRemovalRecord | undefined, now: { hasServer: boolean; serverPhones: number }): { id: string; text: string } | undefined {
  if (!removed || removed.dismissedAt) return undefined;
  const listed = [
    ...removed.machines.map((name) => `the machine ${name}`),
    ...(removed.phones.length ? [removed.phones.length === 1 ? "a phone pairing" : `${removed.phones.length} phone pairings`] : [])
  ];
  if (listed.length === 0 && !removed.startKeyHanded) return undefined;
  // A phone already paired with the server since is not told to pair again.
  const steps = [
    ...(removed.phones.length && now.serverPhones === 0 ? ["pair your phone again from Device Pairing"] : []),
    ...(removed.machines.length ? ["choose Cloud run in a member's settings to set a machine up again"] : [])
  ].join(" and ");
  const next = !steps ? "" : now.hasServer ? ` ${steps.charAt(0).toUpperCase()}${steps.slice(1)}.` : ` Set up your server, then ${steps}.`;
  const what = listed.length
    ? `AccordAgents no longer uses its shared relay, so what was set up through it was removed from this computer: ${joinList(listed)}.`
    : "AccordAgents no longer uses its shared relay.";
  const key = removed.startKeyHanded
    ? " Phones paired through it keep a copy of the key that can start your AWS machine; to end that, delete the access key of the accordagents-wake user in AWS IAM, then run the AWS setup command again and paste its result."
    : "";
  return { id: `relay-removed:${removed.removedAt}`, text: `${what}${next}${key}` };
}

/** One clean line of an error, short, without its final stop. */
function plainReason(message: string): string {
  const line = message.split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? "unknown error";
  return (line.length > 200 ? `${line.slice(0, 197)}…` : line).replace(/[.!?]$/, "");
}

function joinList(parts: string[]): string {
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
}
