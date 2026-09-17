import type { AgentHealth, ChatParticipantEndpoint, ProviderSettings } from "../../../shared/types";
import {
  agentReadinessReason,
  cliProviderMetadata,
  readinessForParticipant
} from "../../../shared/cliReadiness";
import { chatParticipantEndpointFor } from "../../../shared/chatParticipantEndpoint";

export function validateChatCliAgents(
  drafts: Array<{ kind: AgentHealth["kind"]; endpoint?: ChatParticipantEndpoint; remoteExecution?: "local" | "remote" | "inherit" }>,
  agents: AgentHealth[],
  providers: Array<Pick<ProviderSettings, "kind" | "enabled">> = []
): string | undefined {
  for (const draft of drafts) {
    if (draft.remoteExecution === "remote") {
      continue;
    }
    const readiness = readinessForParticipant(
      { kind: draft.kind, endpoint: chatParticipantEndpointFor(draft.kind, draft.endpoint) },
      agents,
      providers
    );
    if (readiness !== "ready") {
      const label = cliProviderMetadata(draft.kind).label;
      return agentReadinessReason(readiness, label) ?? `${label} is not ready.`;
    }
  }
  return undefined;
}
