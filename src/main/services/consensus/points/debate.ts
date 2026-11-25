import { randomUUID } from "node:crypto";
import type { Conversation, Finding, GitDiffResult, ParticipantConfig, ReviewRequest } from "../../../../shared/types";
import { ParticipantRunResult } from "../../providers";
import { MAX_VERIFIERS_PER_POINT } from "../constants";
import { parseLineProtocol, parseSourceDecision, parseVerification } from "./lineProtocol";
import { statusFor } from "./pointMatching";
import {
  buildFinalResolutionPrompt, buildRepairPrompt, buildSourceResponsePrompt, buildVerificationPrompt
} from "../prompts/reviewPrompts";
import { cliSessionContext, participantSessionKey } from "../runs/cliSessions";
import { emitProgress, throwIfAborted } from "../runs/reviewRecords";
import type { LinePoint, ProgressCallback } from "../types";
import type { ConsensusModules } from "../modules";

/** The points participants raise and argue. */
export class Debate {
  constructor(private readonly consensus: Pick<ConsensusModules, "participantRuns">) {}

  async collectParticipantPoints(
    request: ReviewRequest,
    arbiter: ParticipantConfig,
    diff: GitDiffResult | undefined,
    initialResults: ParticipantRunResult[],
    healthyParticipants: ParticipantConfig[],
    warnings: string[],
    signal: AbortSignal | undefined,
    progress: ProgressCallback | undefined,
    runId: string,
    sessionContext?: { conversation: Conversation; warnings: string[]; arbiterSessionKey: string }
  ): Promise<Map<string, LinePoint[]>> {
    const pointsByParticipant = new Map<string, LinePoint[]>();

    for (const result of initialResults) {
      if (!result.ok) {
        continue;
      }
      let points = parseLineProtocol(result.content, result.participant, healthyParticipants);
      if (points.length === 0) {
        const arbiterRole = request.kind === "implementation-plan" ? "Planner" : "Arbiter";
        emitProgress(runId, progress, "arbiter", `${arbiterRole} ${arbiter.label} is repairing ${result.participant.label}'s answer.`);
        const repair = await this.consensus.participantRuns.runParticipant(
          arbiter,
          buildRepairPrompt(request, diff, result.participant, result.content, warnings),
          request,
          signal,
          sessionContext
            ? cliSessionContext(sessionContext.conversation, sessionContext.warnings, sessionContext.arbiterSessionKey)
            : undefined
        );
        if (repair.ok) {
          points = parseLineProtocol(repair.content, result.participant, healthyParticipants);
        } else {
          warnings.push(`${arbiter.label} could not repair ${result.participant.label}'s answer: ${repair.error ?? "unknown error"}.`);
        }
      }
      if (points.length === 0) {
        warnings.push(`${result.participant.label} produced no parseable points.`);
      }
      emitProgress(runId, progress, "extract", `Extracted ${points.length} point${points.length === 1 ? "" : "s"} from ${result.participant.label}.`, {
        participantLabel: result.participant.label
      });
      pointsByParticipant.set(result.participant.id, points);
    }

    return pointsByParticipant;
  }

  async debatePoint(
    finding: Finding,
    request: ReviewRequest,
    diff: GitDiffResult | undefined,
    warnings: string[],
    signal: AbortSignal | undefined,
    progress: ProgressCallback | undefined,
    runId: string,
    pointIndex: number,
    totalPoints: number,
    failedParticipantIds: Set<string>,
    sessionContext?: { conversation: Conversation; warnings: string[] }
  ): Promise<void> {
    const missingParticipants = request.participants
      .filter((participant) => !failedParticipantIds.has(participant.id))
      .filter((participant) => finding.missingParticipantIds?.includes(participant.id))
      .slice(0, MAX_VERIFIERS_PER_POINT);
    const totalMissing = finding.missingParticipantIds?.length ?? 0;
    if (totalMissing > missingParticipants.length) {
      warnings.push(`Point "${finding.title}" was checked with ${MAX_VERIFIERS_PER_POINT} missing members to keep the run bounded.`);
    }

    for (const participant of missingParticipants) {
      throwIfAborted(signal);
      emitProgress(runId, progress, "debate", `Asking ${participant.label} about point ${pointIndex + 1} of ${totalPoints}.`, {
        participantLabel: participant.label,
        findingTitle: finding.title,
        completed: pointIndex,
        total: totalPoints
      });
      const result = await this.consensus.participantRuns.runParticipant(
        participant,
        buildVerificationPrompt(request, finding, diff, warnings),
        request,
        signal,
        sessionContext
          ? cliSessionContext(sessionContext.conversation, sessionContext.warnings, participantSessionKey(participant))
          : undefined
      );
      if (!result.ok) {
        failedParticipantIds.add(participant.id);
        warnings.push(`${participant.label}: ${result.error ?? "failed"}. Skipping this participant for the rest of the run.`);
      }
      const parsed = result.ok ? parseVerification(result.content) : { stance: "unclear" as const, reason: result.content };
      finding.rounds.push({
        id: randomUUID(),
        roundIndex: 1,
        participantId: participant.id,
        participantLabel: participant.label,
        stance: parsed.stance,
        severity: parsed.severity,
        content: parsed.reason,
        createdAt: new Date().toISOString()
      });
    }

    finding.status = statusFor(finding, request.participants.filter((participant) => !failedParticipantIds.has(participant.id)));

    const dissentingRound = finding.rounds.find((round) => round.roundIndex === 1 && round.stance !== "confirmed");
    if (request.roundLimit <= 1 || !dissentingRound) {
      return;
    }

    const source = request.participants.find((participant) => participant.id === finding.sourceParticipantId && !failedParticipantIds.has(participant.id));
    if (!source) {
      return;
    }

    emitProgress(runId, progress, "debate", `Asking ${source.label} to evaluate the counterargument.`);
    const sourceResult = await this.consensus.participantRuns.runParticipant(
      source,
      buildSourceResponsePrompt(request, finding, dissentingRound, diff, warnings),
      request,
      signal,
      sessionContext ? cliSessionContext(sessionContext.conversation, sessionContext.warnings, participantSessionKey(source)) : undefined
    );
    if (!sourceResult.ok) {
      failedParticipantIds.add(source.id);
      warnings.push(`${source.label}: ${sourceResult.error ?? "failed"}. Skipping this member for the rest of the run.`);
      return;
    }

    const sourceDecision = parseSourceDecision(sourceResult.content);
    finding.rounds.push({
      id: randomUUID(),
      roundIndex: 2,
      participantId: source.id,
      participantLabel: source.label,
      stance: "originator-rebuttal",
      severity: finding.severity,
      content: sourceDecision.reason,
      createdAt: new Date().toISOString()
    });

    if (sourceDecision.decision === "accept") {
      finding.status = "Rejected";
      return;
    }
    if (sourceDecision.decision !== "reject") {
      finding.status = "Unresolved";
      return;
    }

    const finalResolver = request.participants.find((participant) => participant.id === dissentingRound.participantId && !failedParticipantIds.has(participant.id));
    if (!finalResolver) {
      finding.status = "Unresolved";
      return;
    }

    emitProgress(runId, progress, "debate", `Asking ${finalResolver.label} for final resolution.`);
    const finalResult = await this.consensus.participantRuns.runParticipant(
      finalResolver,
      buildFinalResolutionPrompt(request, finding, sourceDecision.reason, diff, warnings),
      request,
      signal,
      sessionContext
        ? cliSessionContext(sessionContext.conversation, sessionContext.warnings, participantSessionKey(finalResolver))
        : undefined
    );
    const parsedFinal = finalResult.ok ? parseVerification(finalResult.content) : { stance: "unclear" as const, reason: finalResult.content };
    finding.rounds.push({
      id: randomUUID(),
      roundIndex: 3,
      participantId: finalResolver.id,
      participantLabel: finalResolver.label,
      stance: "final-resolution",
      severity: parsedFinal.severity,
      content: parsedFinal.reason,
      createdAt: new Date().toISOString()
    });
    finding.status = parsedFinal.stance === "confirmed" ? "Confirmed" : parsedFinal.stance === "rejected" ? "Rejected" : "Unresolved";
  }
}
