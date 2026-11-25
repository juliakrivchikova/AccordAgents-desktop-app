import { useEffect, useState } from "react";

import { normalizeCliStartDefaultsByKind, type CliStartDefaults } from "../../../shared/cliStartDefaults";
import type { CloudRunSelection } from "../../../shared/cloudRunPreparation";
import type { MachineListResult, MachineRecord } from "../../../shared/machineLink";
import type { ChatParticipant, ProviderModelCatalog } from "../../../shared/types";
import { memberModelCatalogFor, memberModelCatalogKnown, useMemberModelCatalog } from "./chat-member-model-name";

/** Where a member runs, as its start defaults are read: this computer, or a
 *  machine (its own, or the AWS instance's for Cloud run). */
export type StartDefaultsPlace = Pick<ChatParticipant, "kind"> & { homeMachineId?: string; cloudRun?: CloudRunSelection };

const NO_MACHINES: MachineListResult = { machines: [], status: [] };
/** How long a screen that shows start defaults trusts the list it has. */
const START_DEFAULTS_REUSE_MS = 15_000;

/** The start mode the New chat screen showed, for the provider and place it
 *  was shown for (startAccessKey). */
export interface NewChatStartAccess {
  key: string;
  access?: string;
}

/** Which provider and place a shown start mode belongs to. */
export function startAccessKey(providerKey: string, place: Pick<StartDefaultsPlace, "homeMachineId" | "cloudRun">): string {
  return [providerKey, place.homeMachineId ?? "", place.cloudRun ? place.cloudRun.instanceId ?? "cloud" : ""].join("\u0000");
}

/** A machine by its id, with its last hello (connected or not). */
export function machineOf(list: MachineListResult, machineId: string | undefined): { name?: string; lastHello?: MachineRecord["lastHello"] } | undefined {
  if (!machineId) return undefined;
  const record = list.machines.find((machine) => machine.id === machineId);
  const status = list.status.find((item) => item.machineId === machineId);
  return record || status ? { name: record?.name ?? status?.name, lastHello: status?.lastHello ?? record?.lastHello } : undefined;
}

/** The machine a member runs on: its own, or for Cloud run the one on the AWS
 *  instance it names (none while that machine is still to be set up). */
export function machineIdOf(place: Pick<StartDefaultsPlace, "homeMachineId" | "cloudRun">, list: MachineListResult): string | undefined {
  if (place.homeMachineId) return place.homeMachineId;
  const instanceId = place.cloudRun?.instanceId;
  return instanceId ? list.machines.find((machine) => machine.awsInstanceId === instanceId)?.id : undefined;
}

/**
 * What a member's CLI starts a new session in with the User's own config on
 * the device that runs it (src/shared/cliStartDefaults.ts): this computer's
 * from its CLI's list, a machine's from that machine's last hello (it reads
 * its own config). None when that device has not said.
 */
export function cliStartDefaultsOf(place: StartDefaultsPlace, localCatalog: ProviderModelCatalog | undefined, machines: MachineListResult): CliStartDefaults | undefined {
  if (place.homeMachineId || place.cloudRun) {
    const machineId = machineIdOf(place, machines);
    const hello = machineOf(machines, machineId)?.lastHello;
    return normalizeCliStartDefaultsByKind(hello?.cliStartDefaults)?.[place.kind];
  }
  return localCatalog?.startDefaults;
}

/** cliStartDefaultsOf for a composer, kept up to date with the CLI's list
 *  and the machines' hellos. */
export function useCliStartDefaults(place: StartDefaultsPlace | undefined, machines: MachineListResult): CliStartDefaults | undefined {
  // The CLI's own list (not an added provider's): her config is that CLI's.
  // Not asked when it runs on a machine (the machine says its own) or there
  // is nothing to ask about.
  // Asked again when shown after a while: the main process reads the list
  // anew once her CLI config file changed.
  const { catalog } = useMemberModelCatalog({ kind: place?.kind ?? "codex-cli" }, Boolean(place) && !place?.homeMachineId && !place?.cloudRun, START_DEFAULTS_REUSE_MS);
  return place ? cliStartDefaultsOf(place, catalog, machines) : undefined;
}

/** cliStartDefaultsOf when a chat is made: the CLI's list as the screen had
 *  it, else waited for a moment, then without. */
export async function cliStartDefaultsFor(place: StartDefaultsPlace, waitMs = 4_000): Promise<CliStartDefaults | undefined> {
  const bridge = typeof window === "undefined" ? undefined : window.consensus;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), waitMs); });
  try {
    if (place.homeMachineId || place.cloudRun) {
      const list = await Promise.race([bridge?.listMachines?.().catch(() => undefined), late]);
      return cliStartDefaultsOf(place, undefined, { machines: list?.machines ?? [], status: list?.status ?? [] });
    }
    // The list the New chat screen already read (as its controls showed it),
    // without waiting for a fresh read; read and waited for only when none.
    const catalog = memberModelCatalogKnown({ kind: place.kind }) ?? await Promise.race([memberModelCatalogFor({ kind: place.kind }), late]);
    return cliStartDefaultsOf(place, catalog, NO_MACHINES);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The machines set up (cloud machines, other computers) and their last
 *  hellos: only then does a composer offer where a member runs, a machine's
 *  program says what it can run, and its CLIs what they start in. Kept as it
 *  was when an update changes nothing the controls read. */
export function useMachineList(): MachineListResult {
  const [machines, setMachines] = useState<MachineListResult>(NO_MACHINES);
  useEffect(() => {
    const bridge = typeof window === "undefined" ? undefined : window.consensus;
    if (!bridge?.listMachines) return;
    let alive = true;
    const take = (answer: Partial<MachineListResult> | undefined): void => {
      const result: MachineListResult = { machines: answer?.machines ?? [], status: answer?.status ?? [] };
      setMachines((current) => machinesKey(current) === machinesKey(result) ? current : result);
    };
    void bridge.listMachines().then((result) => { if (alive) take(result); }).catch(() => undefined);
    const off = bridge.onMachinesUpdated?.((result) => take(result));
    return () => { alive = false; off?.(); };
  }, []);
  return machines;
}

function machinesKey(list: MachineListResult): string {
  const said = (hello: MachineRecord["lastHello"] | undefined): string =>
    `${hello?.cliModesSupported === true ? "1" : "0"}${hello?.liveModeChangeSupported === true ? "1" : "0"}${JSON.stringify(hello?.cliStartDefaults ?? null)}`;
  return [
    ...list.machines.map((machine) => `${machine.id}:${machine.name}:${machine.awsInstanceId ?? ""}:${said(machine.lastHello)}`),
    ...list.status.map((item) => `${item.machineId}:${item.name}:${said(item.lastHello)}`)
  ].join("|");
}
