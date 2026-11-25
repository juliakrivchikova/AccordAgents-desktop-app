import { randomUUID } from "node:crypto";
import type { GitDiffResult, ParticipantConfig, ReviewRequest } from "../../../../shared/types";
import { ParticipantRunResult } from "../../providers";
import { cliAgentSessionId, upsertCliAgentSession } from "./cliSessions";
import { throwIfAborted } from "./reviewRecords";
import type { CliSessionContext } from "./types";
import type { ConsensusDependencies } from "../dependencies";

/** One participant's answer, from its CLI or provider. */
export class ParticipantRuns {
  constructor(private readonly deps: Pick<ConsensusDependencies, "cliRunner" | "debugLogs" | "git" | "providerRunner">) {}

  async resolveDiff(request: ReviewRequest, warnings: string[]): Promise<GitDiffResult | undefined> {
    if (request.kind !== "code-review") {
      return undefined;
    }

    if (!request.diffMode) {
      warnings.push("No diff mode was selected.");
      return undefined;
    }

    const diff = await this.deps.git.getDiff({
      repoPath: request.repoPath ?? "",
      mode: request.diffMode,
      baseBranch: request.baseBranch,
      compareBranch: request.compareBranch,
      commit: request.commit,
      pastedDiff: request.pastedDiff
    });

    if (!diff.diff.trim()) {
      warnings.push("The selected diff is empty.");
    }
    return diff;
  }

  async runParticipant(
    participant: ParticipantConfig,
    prompt: string,
    request: ReviewRequest,
    signal?: AbortSignal,
    sessionContext?: CliSessionContext
  ): Promise<ParticipantRunResult> {
    throwIfAborted(signal);
    const interactionId = randomUUID();
    const startedAt = new Date().toISOString();
    const conversationId = sessionContext?.conversation.id;
    const sessionId = sessionContext ? cliAgentSessionId(sessionContext.conversation, sessionContext.sessionKey) : undefined;
    await this.deps.debugLogs.write("agent.input", {
      interactionId,
      runId: request.runId,
      conversationId,
      conversationKind: request.kind,
      participantId: participant.id,
      participantKind: participant.kind,
      participantLabel: participant.label,
      model: participant.model,
      repoPath: request.repoPath,
      sessionKey: sessionContext?.sessionKey,
      sessionId,
      prompt
    });
    let result: ParticipantRunResult;
    if (participant.kind === "codex-cli" || participant.kind === "claude-code" || participant.kind === "gemini-cli") {
      result = await this.deps.cliRunner.run(
        participant,
        prompt,
        request.repoPath,
        request.diffMode,
        request.kind,
        signal,
        {
          persistSession: Boolean(sessionContext && request.kind === "implementation-plan"),
          sessionId
        }
      );
      if (sessionContext && result.sessionId) {
        upsertCliAgentSession(sessionContext.conversation, sessionContext.sessionKey, result.participant, result.sessionId);
      }
      if (sessionContext && result.ok && !result.sessionId && !sessionId) {
        sessionContext.warnings.push(`${participant.label}: CLI session id was not reported, so later rounds may need to rebuild context from the saved thread transcript.`);
      }
      if (sessionContext && result.sessionRestarted) {
        sessionContext.warnings.push(`${participant.label}: previous CLI session was unavailable, so a new session was started from saved conversation context.`);
      }
    } else {
      result = await this.deps.providerRunner.run(participant, prompt, signal);
    }
    await this.deps.debugLogs.write("agent.output", {
      interactionId,
      runId: request.runId,
      conversationId,
      conversationKind: request.kind,
      participantId: result.participant.id,
      participantKind: result.participant.kind,
      participantLabel: result.participant.label,
      model: result.participant.model,
      ok: result.ok,
      error: result.error,
      durationMs: result.durationMs,
      sessionId: result.sessionId,
      sessionRestarted: result.sessionRestarted,
      startedAt,
      content: result.content
    });
    return result;
  }
}
