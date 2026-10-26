/**
 * The shared relay is gone. A machine enrolled with it and a phone paired
 * through it can never connect again: they are taken off this desktop once,
 * at the first start without the relay, the usual way (a machine as Remove
 * in Settings does it), and Settings says so in one line until it is
 * dismissed. A start that fails half way tries again at the next one, and
 * the notice still names everything found.
 */

import type { MachineRecord } from "../../shared/machineLink";
import type { MachinePowerHandoffRecord } from "../../shared/machinePowerHandoff";
import type { RelayRemovalPending, RelayRemovalRecord } from "./settings";

export interface RelayRemovalOptions {
  settings: {
    relayRemoval(): Promise<RelayRemovalRecord | undefined>;
    relayEraMachines(): Promise<MachineRecord[]>;
    beginRelayRemoval(found: { machines: string[]; startKeyHanded: boolean }): Promise<void>;
    noteRelayRemovalFailure(failure: { machine: string; message: string }): Promise<void>;
    finishRelayRemoval(): Promise<RelayRemovalRecord | undefined>;
  };
  /** The usual removal of a machine (Settings > Remove). */
  removeMachine(machineId: string): Promise<unknown>;
  handoffs: {
    list(): Promise<MachinePowerHandoffRecord[]>;
    revoke(handoffId: string, reason: string): Promise<unknown>;
  };
}

export async function removeRelayEraRecords(options: RelayRemovalOptions): Promise<RelayRemovalRecord | undefined> {
  if (await options.settings.relayRemoval()) return undefined;
  const machines = await options.settings.relayEraMachines();
  // A phone paired through the relay was handed the key that starts the AWS
  // machine. Read before any machine goes: removing a machine settles its
  // records, and the copy each phone keeps stays valid all the same.
  const live = (await options.handoffs.list()).filter((record) => !record.revokedAt);
  await options.settings.beginRelayRemoval({ machines: machines.map((machine) => machine.name), startKeyHanded: live.length > 0 });
  // Each machine on its own: one that cannot be removed now does not keep
  // the others; it is named in the notice and tried again at the next start.
  let failed: { machine: string; message: string } | undefined;
  for (const machine of machines) {
    try {
      await options.removeMachine(machine.id);
    } catch (error) {
      failed ??= { machine: machine.name, message: plainReason(error instanceof Error ? error.message : String(error)) };
    }
  }
  if (failed) await options.settings.noteRelayRemovalFailure(failed);
  for (const record of await options.handoffs.list()) {
    if (!record.revokedAt) await options.handoffs.revoke(record.handoffId, "relay-removed");
  }
  if (failed) return undefined;
  return options.settings.finishRelayRemoval();
}

/** The one line about what the relay's removal took off this desktop, or
 *  undefined when there is nothing to say (or it was dismissed). */
export function relayRemovalNotice(removed: RelayRemovalRecord | undefined, now: { hasServer: boolean; serverPhones: number; pending?: RelayRemovalPending; leftToRemove?: string[] }): { id: string; text: string } | undefined {
  if (!removed) {
    const failed = now.pending?.failed;
    if (!failed || now.pending?.failedDismissedAt) return undefined;
    // Removed since (Settings), it is no longer there to be tried again.
    if (now.leftToRemove && !now.leftToRemove.includes(failed.machine)) return undefined;
    return {
      id: `relay-removed:failed:${failed.at}`,
      text: `AccordAgents no longer uses its shared relay. The machine ${failed.machine}, set up through it, could not be removed from this computer yet (${failed.message}); it is tried again at the next start.`
    };
  }
  if (removed.dismissedAt) return undefined;
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
