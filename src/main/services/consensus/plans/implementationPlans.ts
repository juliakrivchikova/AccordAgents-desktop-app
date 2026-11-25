import { randomUUID } from "node:crypto";
import type { Conversation, ParticipantConfig, PlanDecisionAnswer, ReviewRequest, StartReviewResult } from "../../../../shared/types";
import {
  mergePlanDecisionRequests, metadataNumber, metadataWarnings, pendingDecisionsFromMetadata, planDecisionRequestsFromMetadata,
  planItemReviewsFromMetadata, requiredPlanItemReviewFindings, serializeReviewRequest
} from "./planMetadata";
import { finalSummary } from "./planText";
import { parseLineProtocol } from "../points/lineProtocol";
import {
  createFinding, rawImplementationPlansFromResults, selectImplementationPlanExtractionPoints, sourceItemsForRawPlans
} from "../points/pointMatching";
import {
  buildImplementationPlanExtractionPrompt, buildImplementationPlanPrompt, formatDecisionAnswersForTimeline
} from "../prompts/planPrompts";
import { systemIntro } from "../prompts/reviewPrompts";
import { arbiterSessionKey, asArbiterParticipant, cliSessionContext, isCliParticipant, participantSessionKey } from "../runs/cliSessions";
import {
  consensusMessage, emitProgress, formatDuration, formatParticipantLabelList, throwIfAborted, titleFor
} from "../runs/reviewRecords";
import type { ProgressCallback, RawImplementationPlan } from "../types";
import type { ConsensusModules } from "../modules";
import type { ConsensusDependencies } from "../dependencies";

const MAX_DECISION_GATES = 2;

interface PlanResumeState {
  conversation: Conversation;
  answers: PlanDecisionAnswer[];
}

/** Implementation plans several participants write. */
export class ImplementationPlans {
  constructor(
    private readonly consensus: Pick<ConsensusModules, "conversationSaves" | "debate" | "participantRuns" | "planDecisions" | "planRevisions">,
    private readonly deps: Pick<ConsensusDependencies, "debugLogs">
  ) {}

  async startImplementationPlan(
    request: ReviewRequest,
    signal?: AbortSignal,
    progress?: ProgressCallback,
    resume?: PlanResumeState
  ): Promise<StartReviewResult> {
    const warnings = resume?.conversation ? metadataWarnings(resume.conversation) : [];
    const runId = request.runId ?? randomUUID();
    const now = new Date().toISOString();
    const arbiter = request.arbiter ?? request.participants[0];
    const participants = request.participants.filter((participant) => isCliParticipant(participant));
    let conversation: Conversation | undefined = resume?.conversation;
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

    if (!request.repoPath?.trim()) {
      throw new Error("Select a repository for an implementation plan.");
    }
    if (!arbiter || !isCliParticipant(arbiter)) {
      throw new Error("Select a local CLI planner for implementation plans.");
    }
    if (participants.length < 2) {
      throw new Error("Select at least two local CLI members for an implementation plan.");
    }

    try {
      emitProgress(runId, recordProgress, "initial", "Preparing implementation-plan context.");
      throwIfAborted(signal);

      const answers = resume?.answers ?? [];
      if (!conversation) {
        conversation = {
          id: randomUUID(),
          title: titleFor(request, undefined),
          kind: request.kind,
          createdAt: now,
          updatedAt: now,
          repoPath: request.repoPath,
          messages: [
            consensusMessage("user", request.question || "Create an implementation plan for this repository."),
            consensusMessage("system", systemIntro(request, undefined, arbiter), asArbiterParticipant(arbiter, request.kind))
          ],
          findings: [],
          metadata: {
            runId,
            repoPath: request.repoPath,
            participantCount: participants.length,
            arbiter: { id: arbiter.id, kind: arbiter.kind, label: arbiter.label, model: arbiter.model },
            roundLimit: request.roundLimit,
            implementationPlanRequest: serializeReviewRequest(request),
            implementationPlanAnswers: [],
            implementationPlanDecisionGateCount: 0,
            planDecisionRequests: [],
            running: true
          }
        };
        this.consensus.conversationSaves.queueConversationSnapshot(conversation);
      } else {
        const decisionRequests = mergePlanDecisionRequests(
          planDecisionRequestsFromMetadata(conversation),
          pendingDecisionsFromMetadata(conversation)
        );
        conversation.messages.push(consensusMessage("user", formatDecisionAnswersForTimeline(answers)));
        conversation.metadata = {
          ...conversation.metadata,
          implementationPlanAnswers: answers,
          planDecisionRequests: decisionRequests,
          pendingDecisionSelections: undefined,
          pendingDecisionResolutions: undefined,
          pendingDecisions: undefined,
          running: true
        };
        conversation.updatedAt = now;
        await this.consensus.conversationSaves.flushAndSaveConversation(conversation);
      }

      const decisionGateCount = metadataNumber(conversation.metadata.implementationPlanDecisionGateCount);
      const decisionFailedParticipantIds = new Set<string>();
      if (decisionGateCount < MAX_DECISION_GATES) {
        const decisionResult = await this.consensus.planDecisions.collectImplementationPlanDecisions(
          request,
          conversation,
          participants,
          answers,
          warnings,
          signal,
          recordProgress,
          runId,
          decisionFailedParticipantIds
        );

        if (decisionResult.pendingDecisions.length > 0) {
          conversation.metadata = {
            ...conversation.metadata,
            implementationPlanRequest: serializeReviewRequest(request),
            implementationPlanAnswers: answers,
            implementationPlanDecisionGateCount: decisionGateCount + 1,
            planDecisionRequests: mergePlanDecisionRequests(
              planDecisionRequestsFromMetadata(conversation),
              decisionResult.pendingDecisions
            ),
            pendingDecisionSelections: undefined,
            pendingDecisionResolutions: undefined,
            pendingDecisions: decisionResult.pendingDecisions,
            warnings,
            running: false
          };
          conversation.updatedAt = new Date().toISOString();
          emitProgress(runId, recordProgress, "decisions", "Implementation plan paused for user decisions.");
          await this.consensus.conversationSaves.flushAndSaveConversation(conversation);
          return { conversation, warnings, pendingDecisions: decisionResult.pendingDecisions };
        }
      }

      const failedParticipantIds = new Set(decisionFailedParticipantIds);
      emitProgress(runId, recordProgress, "initial", "Running independent implementation plans.");
      const initialPrompt = buildImplementationPlanPrompt(request, answers, warnings);
      let completedInitial = 0;
      const completedInitialLabels = new Set<string>();
      const initialResults = await Promise.all(
        participants.map(async (participant) => {
          emitProgress(runId, recordProgress, "initial", `Running implementation plan from ${participant.label}.`, {
            participantLabel: participant.label,
            completed: completedInitial,
            total: participants.length
          });
          const result = await this.consensus.participantRuns.runParticipant(
            participant,
            initialPrompt,
            request,
            signal,
            cliSessionContext(conversation!, warnings, participantSessionKey(participant))
          );
          completedInitial += 1;
          completedInitialLabels.add(participant.label);
          emitProgress(runId, recordProgress, "initial", `${participant.label} ${result.ok ? "finished" : "failed"} implementation plan${formatDuration(result.durationMs)}.`, {
            participantLabel: participant.label,
            completed: completedInitial,
            total: participants.length
          });
          const remaining = participants.filter((item) => !completedInitialLabels.has(item.label));
          if (remaining.length > 0) {
            emitProgress(
              runId,
              recordProgress,
              "initial",
              `Waiting for ${formatParticipantLabelList(remaining.map((item) => item.label))} to finish implementation plan${remaining.length === 1 ? "" : "s"}.`,
              {
                participantLabel: remaining.length === 1 ? remaining[0].label : undefined,
                completed: completedInitial,
                total: participants.length
              }
            );
          }
          return result;
        })
      );
      throwIfAborted(signal);

      for (const result of initialResults) {
        conversation.messages.push(consensusMessage("participant", result.content, result.participant, result.ok ? "done" : "error"));
        if (!result.ok && result.error) {
          failedParticipantIds.add(result.participant.id);
          warnings.push(`${result.participant.label}: ${result.error}. Skipping this member for the rest of the run.`);
        }
      }

      const healthyParticipants = participants.filter((participant) => !failedParticipantIds.has(participant.id));
      if (healthyParticipants.length < 2) {
        warnings.push("Fewer than two local members completed successfully, so no implementation plan can be marked approved by both models.");
        conversation.findings = [];
        conversation.finalSummary = finalSummary(conversation);
        conversation.messages.push(consensusMessage("summary", conversation.finalSummary));
        conversation.metadata = { ...conversation.metadata, pendingDecisions: undefined, warnings, running: false };
        conversation.updatedAt = new Date().toISOString();
        await this.consensus.conversationSaves.flushAndSaveConversation(conversation);
        return { conversation, warnings };
      }

      const rawPlans = rawImplementationPlansFromResults(initialResults, healthyParticipants);
      conversation.metadata = {
        ...conversation.metadata,
        implementationPlanRawPlans: rawPlans
      };
      conversation.updatedAt = new Date().toISOString();
      this.consensus.conversationSaves.queueConversationSnapshot(conversation);

      return await this.processImplementationPlanRawPlans(
        request,
        conversation,
        healthyParticipants,
        rawPlans,
        arbiter,
        answers,
        warnings,
        signal,
        recordProgress,
        runId,
        failedParticipantIds
      );
    } catch (error) {
      if (conversation?.metadata.running === true) {
        conversation.metadata = {
          ...conversation.metadata,
          warnings,
          running: false
        };
        conversation.updatedAt = new Date().toISOString();
        await this.consensus.conversationSaves.flushAndSaveConversation(conversation);
      }
      throw error;
    }
  }

  async processImplementationPlanRawPlans(
    request: ReviewRequest,
    conversation: Conversation,
    healthyParticipants: ParticipantConfig[],
    rawPlans: RawImplementationPlan[],
    arbiter: ParticipantConfig,
    answers: PlanDecisionAnswer[],
    warnings: string[],
    signal: AbortSignal | undefined,
    progress: ProgressCallback | undefined,
    runId: string,
    failedParticipantIds = new Set<string>(
      request.participants.filter((participant) => !healthyParticipants.some((healthy) => healthy.id === participant.id)).map((participant) => participant.id)
    )
  ): Promise<StartReviewResult> {
    emitProgress(runId, progress, "arbiter", `Planner ${arbiter.label} is extracting implementation-plan items.`);
    const arbiterPrompt = buildImplementationPlanExtractionPrompt(request, healthyParticipants, rawPlans, warnings);
    const arbiterResult = await this.consensus.participantRuns.runParticipant(
      arbiter,
      arbiterPrompt,
      request,
      signal,
      cliSessionContext(conversation, warnings, arbiterSessionKey(arbiter))
    );

    let canonicalPoints = arbiterResult.ok
      ? parseLineProtocol(arbiterResult.content, undefined, healthyParticipants)
      : [];
    if (!arbiterResult.ok) {
      warnings.push(`${arbiter.label} planner failed while extracting implementation-plan items: ${arbiterResult.error ?? "unknown error"}.`);
    }
    if (canonicalPoints.length === 0) {
      warnings.push("Planner did not return parseable canonical plan items, so no implementation-plan consensus threads were opened.");
    }

    canonicalPoints = selectImplementationPlanExtractionPoints(canonicalPoints, healthyParticipants, warnings);

    emitProgress(runId, progress, "debate", `Opening ${canonicalPoints.length} implementation-plan consensus threads.`, {
      completed: 0,
      total: canonicalPoints.length
    });

    for (let index = 0; index < canonicalPoints.length; index += 1) {
      throwIfAborted(signal);
      const point = canonicalPoints[index];
      const sourceItems = sourceItemsForRawPlans(point, rawPlans, healthyParticipants);
      const finding = createFinding(point, healthyParticipants, sourceItems);
      if (finding.status !== "Confirmed") {
        await this.consensus.debate.debatePoint(
          finding,
          request,
          undefined,
          warnings,
          signal,
          progress,
          runId,
          index,
          canonicalPoints.length,
          failedParticipantIds,
          { conversation, warnings }
        );
      }
      conversation.findings.push(finding);
      emitProgress(runId, progress, "debate", `Finished plan item ${index + 1} of ${canonicalPoints.length}.`, {
        findingTitle: finding.title,
        completed: index + 1,
        total: canonicalPoints.length
      });
    }

    if (!conversation.findings.some((finding) => finding.status === "Confirmed")) {
      conversation.finalSummary = finalSummary(conversation);
      conversation.messages.push(consensusMessage("summary", conversation.finalSummary));
      emitProgress(runId, progress, "done", "No implementation-plan items were approved.");
      conversation.metadata = {
        ...conversation.metadata,
        implementationPlanRequest: serializeReviewRequest(request),
        implementationPlanAnswers: answers,
        implementationPlanFinalMarkdown: undefined,
        implementationPlanDebateSummaryMarkdown: undefined,
        implementationPlanSynthesisSource: undefined,
        pendingDecisionSelections: undefined,
        pendingDecisionResolutions: undefined,
        pendingDecisions: undefined,
        pendingPlanItemReview: undefined,
        warnings,
        running: false
      };
      conversation.updatedAt = new Date().toISOString();
      await this.consensus.conversationSaves.flushAndSaveConversation(conversation);
      return { conversation, warnings };
    }

    const reviewableItems = requiredPlanItemReviewFindings(conversation);
    if (reviewableItems.length > 0) {
      conversation.finalSummary = undefined;
      conversation.metadata = {
        ...conversation.metadata,
        implementationPlanRequest: serializeReviewRequest(request),
        implementationPlanAnswers: answers,
        implementationPlanFinalMarkdown: undefined,
        implementationPlanDebateSummaryMarkdown: undefined,
        implementationPlanSynthesisSource: undefined,
        pendingDecisionSelections: undefined,
        pendingDecisionResolutions: undefined,
        pendingDecisions: undefined,
        pendingPlanItemReview: true,
        planItemReviews: planItemReviewsFromMetadata(conversation).filter((review) =>
          reviewableItems.some((finding) => finding.id === review.findingId)
        ),
        warnings,
        running: false
      };
      conversation.updatedAt = new Date().toISOString();
      emitProgress(runId, progress, "decisions", "Implementation plan paused for item review.", {
        completed: 0,
        total: reviewableItems.length
      });
      await this.consensus.conversationSaves.flushAndSaveConversation(conversation);
      return { conversation, warnings };
    }

    emitProgress(runId, progress, "summary", "Building final approved implementation plan.");
    const synthesis = await this.consensus.planRevisions.synthesizeImplementationPlan(
      request,
      conversation,
      arbiter,
      warnings,
      signal,
      progress,
      runId
    );
    conversation.finalSummary = synthesis.combined;
    conversation.messages.push(consensusMessage("summary", conversation.finalSummary));
    emitProgress(runId, progress, "done", "Implementation-plan consensus finished.");
    conversation.metadata = {
      ...conversation.metadata,
      implementationPlanRequest: serializeReviewRequest(request),
      implementationPlanAnswers: answers,
      implementationPlanFinalMarkdown: synthesis.fullPlan,
      implementationPlanDebateSummaryMarkdown: synthesis.debateSummary,
      implementationPlanSynthesisSource: synthesis.source,
      pendingDecisionSelections: undefined,
      pendingDecisionResolutions: undefined,
      pendingDecisions: undefined,
      pendingPlanItemReview: undefined,
      warnings,
      running: false
    };
    conversation.updatedAt = new Date().toISOString();
    await this.consensus.conversationSaves.flushAndSaveConversation(conversation);

    return { conversation, warnings };
  }
}
