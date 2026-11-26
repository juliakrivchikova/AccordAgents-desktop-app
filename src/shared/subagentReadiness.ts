import { CLI_PROVIDER_DISPLAY_ORDER, readinessForParticipant, readinessForProvider } from "./cliReadiness";
import { cliProviderHostForParticipant } from "./cliProviderHosts";
import type { AgentHealth, ChatProviderKind, CliProviderHost, ProviderSettings } from "./types";

// Which CLIs are ready for a chat's Agents list (shared/subagentProviders.ts):
// where the main session's members run, which is where the main session runs.

/** What says where a main session runs and on what. */
export interface SubagentMainPlace {
  kind: ChatProviderKind;
  hostId?: string;
  homeMachineId?: string;
  cloudRun?: unknown;
}

/** A machine as its record has it: its last greeting lists its CLIs. */
export interface SubagentMachine {
  id: string;
  awsInstanceId?: string;
  lastHello?: { providers?: ReadonlyArray<{ kind: string; installed: boolean }> };
}

/** Whether the main session runs on a machine, not on the device that asks. */
export function mainRunsOnMachine(main: SubagentMainPlace | undefined): boolean {
  return Boolean(main && (main.homeMachineId?.trim() || main.cloudRun));
}

/** The machine a main session runs on: its own, or for Cloud run the one on
 *  the AWS instance it names. */
export function subagentMachineOf(main: SubagentMainPlace, machines: readonly SubagentMachine[]): SubagentMachine | undefined {
  const id = main.homeMachineId?.trim();
  if (id) return machines.find((machine) => machine.id === id);
  const instanceId = (main.cloudRun as { instanceId?: unknown } | undefined)?.instanceId;
  return typeof instanceId === "string" && instanceId ? machines.find((machine) => machine.awsInstanceId === instanceId) : undefined;
}

/**
 * The CLIs ready on this device for the main session's members: those ready
 * here, and the main session's own CLI when it runs here through an added
 * provider with a key (Z.ai and the like): its agents with nothing set run
 * there too, as it does, though the CLI's own sign-in is not needed.
 */
export function subagentReadyHere(
  agents: AgentHealth[],
  providers: Array<Pick<ProviderSettings, "kind" | "enabled">>,
  hosts: ReadonlyArray<CliProviderHost>,
  main?: Pick<SubagentMainPlace, "kind" | "hostId">
): ChatProviderKind[] {
  const host = main ? cliProviderHostForParticipant(main.kind, main.hostId?.trim() || undefined, hosts) : undefined;
  return CLI_PROVIDER_DISPLAY_ORDER.filter((kind) => kind === main?.kind && host
    ? readinessForParticipant({ kind, host }, agents, providers) === "ready"
    : readinessForProvider(kind, agents, providers) === "ready");
}

/** The CLIs a machine said it has installed when it last greeted (whether
 *  they are signed in there is not known here: a task to one that is not is
 *  refused there). None while it has not greeted. */
export function subagentReadyOnMachine(machine: SubagentMachine | undefined): ChatProviderKind[] {
  const installed = new Set((machine?.lastHello?.providers ?? []).filter((item) => item.installed).map((item) => item.kind));
  return CLI_PROVIDER_DISPLAY_ORDER.filter((kind) => installed.has(kind));
}
