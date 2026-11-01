import type { AgentHealth, CliProviderHost, ProviderSettings } from "../../../shared/types";
import {
  agentReadinessReason,
  cliProviderMetadata,
  readinessForParticipant
} from "../../../shared/cliReadiness";
import { cliProviderHostForParticipant } from "../../../shared/cliProviderHosts";

export interface ChatRunLocation {
  remoteExecution?: "local" | "remote" | "inherit";
  homeMachineId?: string;
  cloudRun?: unknown;
}

/** On a machine or in the cloud the member's CLI there runs it, so this
 *  computer's CLI does not matter. */
function runsOnThisComputer(location: ChatRunLocation): boolean {
  return !location.cloudRun && !location.homeMachineId && location.remoteExecution !== "remote";
}

/** Why a saved member cannot be added where it would run now: `runtime` is
 *  what the picker chose, over what the member was saved with. */
export function participantOptionInvalidReason(
  option: { configReason?: string; localCliReason?: string; config: ChatRunLocation },
  runtime?: ChatRunLocation
): string | undefined {
  if (option.configReason) return option.configReason;
  return runsOnThisComputer({ ...option.config, ...runtime }) ? option.localCliReason : undefined;
}

export function validateChatCliAgents(
  drafts: Array<ChatRunLocation & { kind: AgentHealth["kind"]; hostId?: string }>,
  agents: AgentHealth[],
  providers: Array<Pick<ProviderSettings, "kind" | "enabled">> = [],
  hosts: ReadonlyArray<CliProviderHost> = []
): string | undefined {
  for (const draft of drafts) {
    if (!runsOnThisComputer(draft)) {
      continue;
    }
    const host = cliProviderHostForParticipant(draft.kind, draft.hostId, hosts);
    if (draft.hostId && !host) {
      return "That provider no longer exists. Pick another provider for the member.";
    }
    const readiness = readinessForParticipant({ kind: draft.kind, host }, agents, providers);
    if (readiness === "sign-in-required" && host) {
      return `${host.label} has no API key. Add one under Local CLI setup in Settings.`;
    }
    if (readiness !== "ready") {
      const label = cliProviderMetadata(draft.kind).label;
      return agentReadinessReason(readiness, label) ?? `${label} is not ready.`;
    }
  }
  return undefined;
}
