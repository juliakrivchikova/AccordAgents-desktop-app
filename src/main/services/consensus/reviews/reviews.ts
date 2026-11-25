import { randomUUID } from "node:crypto";
import type { ContinueReviewRequest, Conversation, ReviewRequest, StartReviewResult } from "../../../../shared/types";
import {
  implementationPlanAnswersFromMetadata, implementationPlanRequestFromMetadata, mergeDecisionAnswers, mergePlanDecisionRequests,
  metadataWarnings, pendingDecisionsFromMetadata, planDecisionRequestsFromMetadata
} from "../plans/planMetadata";
import { finalSummary } from "../plans/planText";
import { isAnsweredDecision, isMetaPoint, parseLineProtocol } from "../points/lineProtocol";
import { createFinding, localMergePoints, withInferredSources } from "../points/pointMatching";
import { buildArbiterPrompt, buildInitialPrompt, systemIntro } from "../prompts/reviewPrompts";
import { asArbiterParticipant, isCliParticipant } from "../runs/cliSessions";
import { consensusMessage, emitProgress, formatDuration, throwIfAborted, titleFor } from "../runs/reviewRecords";
import type { ProgressCallback } from "../types";
import type { ConsensusModules } from "../modules";
import type { ConsensusDependencies } from "../dependencies";

const MAX_POINTS = 8;

/** Reviews several participants make of one change. */
export class Reviews {
  constructor(
    private readonly consensus: Pick<
      ConsensusModules,
      | "conversationSaves" | "debate" | "implementationPlans" | "participantRuns" | "planDecisions"
    >,
    private readonly deps: Pick<ConsensusDependencies, "debugLogs" | "storage">
  ) {}

  async startReview(request: ReviewRequest, signal?: AbortSignal, progress?: ProgressCallback): Promise<StartReviewResult> {
    if (request.kind === "implementation-plan") {
      return this.consensus.implementationPlans.startImplementationPlan(request, signal, progress);
    }

    const warnings: string[] = [];
    const runId = request.runId ?? randomUUID();
    const now = new Date().toISOString();
    const arbiter = request.arbiter ?? request.participants[0];
    let conversation: Conversation | undefined;
    const recordProgress: ProgressCallback = (event) => {
      void this.deps.debugLogs.write("progress", {
        runId: event.runId,
        conversationId: conversation?.id,
        phase: event.phase,
        message: event.message,
        participantLabel: event.participantLabel,
        findingTitle: event.findingTitle,
        completed: event.completed,
        total: event.total
      });
      progress?.(event);
    };

    if (!arbiter) {
      throw new Error("Select an arbiter model.");
    }

    emitProgress(runId, recordProgress, "initial", "Preparing review context.");
    throwIfAborted(signal);
    const diff = await this.consensus.participantRuns.resolveDiff(request, warnings);
    const initialPrompt = buildInitialPrompt(request, diff, warnings);

    conversation = {
      id: randomUUID(),
      title: titleFor(request, diff),
      kind: request.kind,
      createdAt: now,
      updatedAt: now,
      repoPath: request.repoPath,
      messages: [
        consensusMessage("user", request.question || "Review the selected changes."),
        consensusMessage("system", systemIntro(request, diff, arbiter), asArbiterParticipant(arbiter, request.kind))
      ],
      findings: [],
      metadata: {
        runId,
        diffMode: request.diffMode,
        participantCount: request.participants.length,
        arbiter: { id: arbiter.id, kind: arbiter.kind, label: arbiter.label, model: arbiter.model },
        roundLimit: request.roundLimit
      }
    };
    this.consensus.conversationSaves.queueConversationSnapshot(conversation);

    const failedParticipantIds = new Set<string>();
    let completedInitial = 0;
    const initialResults = await Promise.all(
      request.participants.map(async (participant) => {
        emitProgress(runId, recordProgress, "initial", `Running independent answer from ${participant.label}.`, {
          participantLabel: participant.label,
          completed: completedInitial,
          total: request.participants.length
        });
        const result = await this.consensus.participantRuns.runParticipant(participant, initialPrompt, request, signal);
        completedInitial += 1;
        emitProgress(runId, recordProgress, "initial", `${participant.label} ${result.ok ? "finished" : "failed"} independent answer${formatDuration(result.durationMs)}.`, {
          participantLabel: participant.label,
          completed: completedInitial,
          total: request.participants.length
        });
        return result;
      })
    );
    throwIfAborted(signal);

    for (const result of initialResults) {
      conversation.messages.push(consensusMessage("participant", result.content, result.participant, result.ok ? "done" : "error"));
      if (!result.ok && result.error) {
        failedParticipantIds.add(result.participant.id);
        warnings.push(`${result.participant.label}: ${result.error}. Skipping this participant for the rest of the run.`);
      }
    }

    const healthyParticipants = request.participants.filter((participant) => !failedParticipantIds.has(participant.id));
    const participantPoints = await this.consensus.debate.collectParticipantPoints(
      request,
      arbiter,
      diff,
      initialResults,
      healthyParticipants,
      warnings,
      signal,
      recordProgress,
      runId
    );

    emitProgress(runId, recordProgress, "arbiter", `Arbiter ${arbiter.label} is merging points.`);
    const arbiterPrompt = buildArbiterPrompt(request, diff, healthyParticipants, participantPoints, warnings);
    const arbiterResult = await this.consensus.participantRuns.runParticipant(arbiter, arbiterPrompt, request, signal);
    conversation.messages.push(consensusMessage("participant", arbiterResult.content, asArbiterParticipant(arbiter, request.kind), arbiterResult.ok ? "done" : "error"));

    let canonicalPoints = arbiterResult.ok
      ? parseLineProtocol(arbiterResult.content, undefined, healthyParticipants)
      : [];
    if (!arbiterResult.ok) {
      warnings.push(`${arbiter.label} arbiter failed: ${arbiterResult.error ?? "unknown error"}. Falling back to local point merge.`);
    }
    if (canonicalPoints.length === 0) {
      canonicalPoints = localMergePoints(participantPoints);
      warnings.push("Arbiter did not return canonical points; used local line-protocol merge fallback.");
    }

    canonicalPoints = canonicalPoints
      .filter((point) => !isMetaPoint(point))
      .map((point) => withInferredSources(point, participantPoints, healthyParticipants));
    const untraceablePointCount = canonicalPoints.filter((point) => point.sourceParticipantIds.length === 0).length;
    if (untraceablePointCount > 0) {
      warnings.push(`${untraceablePointCount} arbiter point${untraceablePointCount === 1 ? "" : "s"} had no matching member source and were filtered out.`);
    }
    canonicalPoints = canonicalPoints
      .filter((point) => point.sourceParticipantIds.length > 0)
      .slice(0, MAX_POINTS);
    if (canonicalPoints.length === 0) {
      warnings.push("No actionable points were extracted from the independent answers.");
    }

    emitProgress(runId, recordProgress, "debate", `Extracted ${canonicalPoints.length} canonical point${canonicalPoints.length === 1 ? "" : "s"}.`);
    emitProgress(runId, recordProgress, "debate", `Opening ${canonicalPoints.length} consensus threads.`, {
      completed: 0,
      total: canonicalPoints.length
    });

    for (let index = 0; index < canonicalPoints.length; index += 1) {
      throwIfAborted(signal);
      const point = canonicalPoints[index];
      const finding = createFinding(point, healthyParticipants);
      if (finding.status !== "Confirmed") {
        await this.consensus.debate.debatePoint(finding, request, diff, warnings, signal, recordProgress, runId, index, canonicalPoints.length, failedParticipantIds);
      }
      conversation.findings.push(finding);
      emitProgress(runId, recordProgress, "debate", `Finished point ${index + 1} of ${canonicalPoints.length}.`, {
        findingTitle: finding.title,
        completed: index + 1,
        total: canonicalPoints.length
      });
    }

    emitProgress(runId, recordProgress, "summary", "Building final consensus summary.");
    conversation.finalSummary = finalSummary(conversation);
    conversation.messages.push(consensusMessage("summary", conversation.finalSummary));
    emitProgress(runId, recordProgress, "done", "Consensus review finished.");
    conversation.updatedAt = new Date().toISOString();
    await this.consensus.conversationSaves.flushAndSaveConversation(conversation);

    return { conversation, warnings };
  }

  async continueReview(request: ContinueReviewRequest, signal?: AbortSignal, progress?: ProgressCallback): Promise<StartReviewResult> {
    const conversation = await this.deps.storage.getConversation(request.conversationId);
    if (!conversation) {
      throw new Error("Conversation was not found.");
    }
    if (conversation.kind !== "implementation-plan") {
      throw new Error("Only implementation-plan conversations can be continued.");
    }
    const originalRequest = implementationPlanRequestFromMetadata(conversation);
    if (!originalRequest) {
      throw new Error("The saved implementation-plan request is missing.");
    }

    const previousAnswers = implementationPlanAnswersFromMetadata(conversation);
    let answers = mergeDecisionAnswers(previousAnswers, request.answers);
    const runId = request.runId ?? originalRequest.runId ?? randomUUID();
    const warnings = metadataWarnings(conversation);
    const pendingDecisions = pendingDecisionsFromMetadata(conversation);
    const decisionRequests = mergePlanDecisionRequests(planDecisionRequestsFromMetadata(conversation), pendingDecisions);
    const arbiter = originalRequest.arbiter ?? originalRequest.participants[0];
    const recordProgress: ProgressCallback = (event) => {
      void this.deps.debugLogs.write("progress", {
        runId: event.runId,
        conversationId: conversation.id,
        phase: event.phase,
        message: event.message,
        participantLabel: event.participantLabel,
        findingTitle: event.findingTitle,
        completed: event.completed,
        total: event.total
      });
      progress?.(event);
    };

    if (pendingDecisions.length > 0 && arbiter && isCliParticipant(arbiter)) {
      const automatic = await this.consensus.planDecisions.autoAnswerPendingDecisions(
        originalRequest,
        conversation,
        arbiter,
        pendingDecisions,
        answers,
        warnings,
        signal,
        recordProgress,
        runId
      );
      answers = automatic.answers;
      if (automatic.pendingDecisions.length > 0) {
        conversation.metadata = {
          ...conversation.metadata,
          implementationPlanAnswers: answers,
          planDecisionRequests: mergePlanDecisionRequests(decisionRequests, automatic.pendingDecisions),
          pendingDecisionSelections: undefined,
          pendingDecisionResolutions: undefined,
          pendingDecisions: automatic.pendingDecisions,
          warnings,
          running: false
        };
        conversation.updatedAt = new Date().toISOString();
        emitProgress(runId, recordProgress, "decisions", `${automatic.pendingDecisions.length} decision thread${automatic.pendingDecisions.length === 1 ? "" : "s"} still need input.`);
        await this.consensus.conversationSaves.flushAndSaveConversation(conversation);
        return { conversation, warnings, pendingDecisions: automatic.pendingDecisions };
      }
    }

    const stillPendingDecisions = pendingDecisions.filter((decision) => !isAnsweredDecision(decision, answers));
    if (stillPendingDecisions.length > 0) {
      conversation.metadata = {
        ...conversation.metadata,
        implementationPlanAnswers: answers,
        planDecisionRequests: mergePlanDecisionRequests(decisionRequests, stillPendingDecisions),
        pendingDecisionSelections: undefined,
        pendingDecisionResolutions: undefined,
        pendingDecisions: stillPendingDecisions,
        warnings,
        running: false
      };
      conversation.updatedAt = new Date().toISOString();
      await this.consensus.conversationSaves.flushAndSaveConversation(conversation);
      return { conversation, warnings, pendingDecisions: stillPendingDecisions };
    }

    const resumedRequest = { ...originalRequest, runId };
    try {
      return await this.consensus.implementationPlans.startImplementationPlan(resumedRequest, signal, progress, { conversation, answers });
    } catch (error) {
      const latest = (await this.deps.storage.getConversation(request.conversationId)) ?? conversation;
      latest.metadata = {
        ...latest.metadata,
        implementationPlanAnswers: answers,
        planDecisionRequests: mergePlanDecisionRequests(planDecisionRequestsFromMetadata(latest), pendingDecisions),
        running: false
      };
      latest.updatedAt = new Date().toISOString();
      await this.consensus.conversationSaves.flushAndSaveConversation(latest);
      throw error;
    }
  }
}
