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
import type { RelayRemovalRecord } from "./settings";

export interface RelayRemovalOptions {
  settings: {
    relayRemoval(): Promise<RelayRemovalRecord | undefined>;
    relayEraMachines(): Promise<MachineRecord[]>;
    beginRelayRemoval(found: { machines: string[]; startKeyHanded: boolean }): Promise<void>;
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
  for (const machine of machines) await options.removeMachine(machine.id);
  for (const record of await options.handoffs.list()) {
    if (!record.revokedAt) await options.handoffs.revoke(record.handoffId, "relay-removed");
  }
  return options.settings.finishRelayRemoval();
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

function joinList(parts: string[]): string {
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
}
