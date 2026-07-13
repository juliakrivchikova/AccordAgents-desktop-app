import type { AgentHealth, ProviderSettings } from "../../../shared/types";
import {
  agentReadinessReason,
  cliProviderMetadata,
  readinessForProvider
} from "../../../shared/cliReadiness";

export function validateChatCliAgents(
  drafts: Array<{ kind: AgentHealth["kind"] }>,
  agents: AgentHealth[],
  providers: Array<Pick<ProviderSettings, "kind" | "enabled">> = []
): string | undefined {
  for (const draft of drafts) {
    const readiness = readinessForProvider(draft.kind, agents, providers);
    if (readiness !== "ready") {
      const label = cliProviderMetadata(draft.kind).label;
      return agentReadinessReason(readiness, label) ?? `${label} is not ready.`;
    }
  }
  return undefined;
}
