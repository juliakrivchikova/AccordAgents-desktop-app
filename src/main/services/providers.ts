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
  /** A run that was to start a new session (a fork's copy, or a clean one)
   *  failed before the CLI took the message: no session was made, although
   *  the id it was given may have been reported. */
  sessionNotStarted?: boolean;
  /** Claude Code handed the User's next message to the step this reply was
   *  answering: the turn goes on in that message's reply. Like the CLI's
   *  transcript, this part has no "Worked for" of its own (the turn's one is
   *  on its last part). */
  turnContinues?: boolean;
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
