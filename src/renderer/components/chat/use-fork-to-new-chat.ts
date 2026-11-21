import { useEffect, useState } from "react";

import { forkToNewChatReasonInChat, forkToNewChatSupportFromHello, type ForkToNewChatMachineSupport } from "../../../shared/forkToNewChat";
import type { MachineListResult } from "../../../shared/machineLink";
import type { AgentHealth, AppSettings, ChatParticipant, Conversation } from "../../../shared/types";

/** Each machine's program, by the last hello it sent this computer: whether
 *  it starts a chat's main session from a copy of a member's session. */
export function machineForkSupportFrom(result: MachineListResult | undefined): Map<string, ForkToNewChatMachineSupport> {
  const support = new Map<string, ForkToNewChatMachineSupport>();
  for (const machine of result?.machines ?? []) {
    support.set(machine.id, forkToNewChatSupportFromHello(result?.status.find((item) => item.machineId === machine.id)?.lastHello ?? machine.lastHello));
  }
  return support;
}

/** What each machine's program can do for Fork to new chat, kept current. */
export function useMachineForkSupport(): ReadonlyMap<string, ForkToNewChatMachineSupport> {
  const [support, setSupport] = useState<ReadonlyMap<string, ForkToNewChatMachineSupport>>(() => new Map());
  useEffect(() => {
    const bridge = typeof window === "undefined" ? undefined : window.consensus;
    if (!bridge?.listMachines) return;
    let alive = true;
    void bridge.listMachines().then((result) => { if (alive) setSupport(machineForkSupportFrom(result)); }).catch(() => undefined);
    const off = bridge.onMachinesUpdated?.((result) => setSupport(machineForkSupportFrom(result)));
    return () => { alive = false; off?.(); };
  }, []);
  return support;
}

/** Why the menus offer Fork to new chat disabled for this member, in the
 *  words the service refuses it with; undefined when it can be chosen. */
export function forkToNewChatReasonFor(
  participant: ChatParticipant,
  conversation: Pick<Conversation, "metadata" | "messages">,
  agents: AgentHealth[],
  settings: Pick<AppSettings, "providers" | "cliProviderHosts">,
  machineSupport: ReadonlyMap<string, ForkToNewChatMachineSupport>
): string | undefined {
  return forkToNewChatReasonInChat({
    participant,
    conversation,
    agents,
    providers: settings.providers ?? [],
    hosts: settings.cliProviderHosts ?? [],
    machineSupport: (machineId) => machineSupport.get(machineId) ?? "unknown"
  });
}
