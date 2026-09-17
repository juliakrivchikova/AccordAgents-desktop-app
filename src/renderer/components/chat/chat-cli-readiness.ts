import type { AgentHealth, CliProviderHost, ProviderSettings } from "../../../shared/types";
import {
  agentReadinessReason,
  cliProviderMetadata,
  readinessForParticipant
} from "../../../shared/cliReadiness";
import { cliProviderHostForParticipant } from "../../../shared/cliProviderHosts";

export function validateChatCliAgents(
  drafts: Array<{ kind: AgentHealth["kind"]; hostId?: string; remoteExecution?: "local" | "remote" | "inherit"; homeMachineId?: string; cloudRun?: unknown }>,
  agents: AgentHealth[],
  providers: Array<Pick<ProviderSettings, "kind" | "enabled">> = [],
  hosts: ReadonlyArray<CliProviderHost> = []
): string | undefined {
  for (const draft of drafts) {
    if (draft.cloudRun || draft.homeMachineId || draft.remoteExecution === "remote") {
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
