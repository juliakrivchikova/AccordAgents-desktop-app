import type { AgentContextUsage, ChatRoleRuntime, ParticipantConfig, ProviderKind, ProviderModelCatalog } from "../../shared/types";

export interface ParticipantRunResult {
  participant: ParticipantConfig;
  content: string;
  ok: boolean;
  error?: string;
  durationMs?: number;
  sessionId?: string;
  sessionRestarted?: boolean;
  roleRuntime?: ChatRoleRuntime;
  contextUsage?: AgentContextUsage;
  warnings?: string[];
  appMcpClientFailed?: boolean;
}

export class ProviderRunner {
  async listModelCatalog(kind: ProviderKind): Promise<ProviderModelCatalog> {
    return {
      kind,
      models: [],
      authoritative: false,
      fetchedAt: new Date().toISOString(),
      error: "Hosted API providers are not supported. Use Codex CLI or Claude Code."
    };
  }

  async run(participant: ParticipantConfig, _prompt?: string, _signal?: AbortSignal): Promise<ParticipantRunResult> {
    const message = "Hosted API providers are not supported. Use Codex CLI or Claude Code.";
    return {
      participant,
      ok: false,
      content: `${participant.label} failed: ${message}`,
      error: message
    };
  }
}
