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
  /** Where the CLI session stood when this turn ended (Claude Code: its last
   *  assistant message's uuid; Codex: the turn's id), for Fork to new chat. */
  sessionCut?: string;
  /** A fork asked to end at a point (CliAgentRunOptions.forkCut) copied the
   *  whole session instead: why. */
  forkCutMissed?: string;
  /** A fork's first turn (CliAgentRunOptions.forkFromSessionId) failed while
   *  the CLI made the copy, before it took the message: no session of the
   *  member's own exists. Whether the CLI said why in its own words (the
   *  source is gone) is isForkSourceMissingError(error). */
  forkCopyFailed?: boolean;
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
