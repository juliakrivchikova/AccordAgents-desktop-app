import { useEffect, useState } from "react";

import { chatParticipantHome } from "../../../shared/chatParticipantHome";
import {
  forkToNewChatUnavailableReason,
  localProviderUnavailableReason,
  memberHasForkableSession,
  type ForkToNewChatMachineSupport
} from "../../../shared/forkToNewChat";
import type { MachineListResult } from "../../../shared/machineLink";
import type { AgentHealth, AppSettings, ChatParticipant, Conversation } from "../../../shared/types";

/** Each machine's program, by the last hello it sent this computer: whether
 *  it starts a chat's main session from a copy of a member's session. */
export function machineForkSupportFrom(result: MachineListResult | undefined): Map<string, ForkToNewChatMachineSupport> {
  const support = new Map<string, ForkToNewChatMachineSupport>();
  for (const machine of result?.machines ?? []) {
    const hello = result?.status.find((item) => item.machineId === machine.id)?.lastHello ?? machine.lastHello;
    support.set(machine.id, !hello ? "unknown" : hello.forkToNewChatSupported === true ? "supported" : "outdated");
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
  const home = chatParticipantHome(participant);
  return forkToNewChatUnavailableReason({
    participant,
    hasSession: memberHasForkableSession(conversation.metadata, participant, conversation.messages),
    providerUnavailable: home.kind === "this-machine"
      ? localProviderUnavailableReason(participant, agents, settings.providers ?? [], settings.cliProviderHosts ?? [])
      : undefined,
    machineSupport: home.kind === "machine" ? machineSupport.get(home.machineId) ?? "unknown" : undefined
  });
}
