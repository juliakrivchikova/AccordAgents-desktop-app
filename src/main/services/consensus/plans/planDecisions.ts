import { randomUUID } from "node:crypto";
import type {
  Conversation, ParticipantConfig, PlanDecisionAnswer, PlanDecisionClarificationRequest, PlanDecisionRequest, PlanItemReview,
  PlanItemReviewRequest, ReviewRequest, StartReviewResult
} from "../../../../shared/types";
import {
  clarificationTargets, implementationPlanRequestFromMetadata, mergeDecisionAnswers, mergePlanDecisionRequests, metadataWarnings,
  pendingDecisionsFromMetadata, planDecisionRepliesFromMetadata, planDecisionReply, planDecisionRequestsFromMetadata,
  planItemReviewsFromMetadata
} from "./planMetadata";
import { decisionKey, isAnsweredDecision, parseAutomaticDecisionAnswer, parseDecisionProtocol } from "../points/lineProtocol";
import { buildAutomaticDecisionAnswerPrompt, buildDecisionClarificationPrompt, buildDecisionDiscoveryPrompt } from "../prompts/planPrompts";
import { arbiterSessionKey, asArbiterParticipant, cliSessionContext, participantSessionKey } from "../runs/cliSessions";
import { emitProgress, throwIfAborted } from "../runs/reviewRecords";
import type { ProgressCallback } from "../types";
import type { ConsensusModules } from "../modules";
import type { ConsensusDependencies } from "../dependencies";

const MAX_DECISIONS = 8;

/** Decisions and item reviews a plan waits for. */
export class PlanDecisions {
  constructor(
    private readonly consensus: Pick<ConsensusModules, "conversationSaves" | "participantRuns">,
    private readonly deps: Pick<ConsensusDependencies, "debugLogs" | "storage">
  ) {}

  async askPlanDecisionClarification(
    request: PlanDecisionClarificationRequest,
    signal?: AbortSignal,
    progress?: ProgressCallback
  ): Promise<StartReviewResult> {
    const conversation = await this.deps.storage.getConversation(request.conversationId);
    if (!conversation) {
      throw new Error("Conversation was not found.");
    }
    if (conversation.kind !== "implementation-plan") {
      throw new Error("Clarifications are only available for implementation-plan conversations.");
    }
    const originalRequest = implementationPlanRequestFromMetadata(conversation);
    if (!originalRequest) {
      throw new Error("The saved implementation-plan request is missing.");
    }
    const pendingDecisions = pendingDecisionsFromMetadata(conversation);
    const decisionRequests = mergePlanDecisionRequests(planDecisionRequestsFromMetadata(conversation), pendingDecisions);
    const decision = pendingDecisions.find((item) => item.id === request.decisionId);
    if (!decision) {
      throw new Error("The plan decision was not found.");
    }
    const question = request.question.trim();
    if (!question) {
      throw new Error("Enter a thread message.");
    }

    const warnings = metadataWarnings(conversation);
    const runId = request.runId ?? randomUUID();
    const replies = planDecisionRepliesFromMetadata(conversation);
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
    replies.push(planDecisionReply(decision.id, "user", question));
    conversation.metadata = {
      ...conversation.metadata,
      planDecisionRequests: decisionRequests,
      pendingDecisions,
      planDecisionReplies: replies,
      warnings,
      running: true
    };
    conversation.updatedAt = new Date().toISOString();
    this.consensus.conversationSaves.queueConversationSnapshot(conversation);
    emitProgress(runId, recordProgress, "decisions", `Sending thread message for "${decision.title}".`, {
      findingTitle: decision.title
    });

    const targets = clarificationTargets(originalRequest, decision);
    for (const participant of targets) {
      throwIfAborted(signal);
      emitProgress(runId, recordProgress, "decisions", `Waiting for ${participant.label} to reply in the thread.`, {
        participantLabel: participant.label,
        findingTitle: decision.title
      });
      const result = await this.consensus.participantRuns.runParticipant(
        participant,
        buildDecisionClarificationPrompt(originalRequest, decision, question, replies),
        originalRequest,
        signal,
        cliSessionContext(conversation, warnings, participantSessionKey(participant))
      );
      replies.push(
        planDecisionReply(
          decision.id,
          "participant",
          result.ok ? result.content : result.error ?? result.content,
          result.participant,
          result.ok ? "done" : "error"
        )
      );
      conversation.metadata = {
        ...conversation.metadata,
        planDecisionRequests: decisionRequests,
        pendingDecisions,
        planDecisionReplies: replies,
        warnings,
        running: true
      };
      conversation.updatedAt = new Date().toISOString();
      this.consensus.conversationSaves.queueConversationSnapshot(conversation);
      if (!result.ok) {
        warnings.push(`${participant.label}: ${result.error ?? "failed"} while replying in the decision thread.`);
      }
    }

    conversation.metadata = {
      ...conversation.metadata,
      planDecisionRequests: decisionRequests,
      pendingDecisions,
      planDecisionReplies: replies,
      warnings,
      running: false
    };
    conversation.updatedAt = new Date().toISOString();
    emitProgress(runId, recordProgress, "decisions", "Clarification replies added.");
    await this.consensus.conversationSaves.flushAndSaveConversation(conversation);
    return { conversation, warnings, pendingDecisions };
  }

  async savePlanItemReview(request: PlanItemReviewRequest): Promise<Conversation | undefined> {
    const conversation = await this.deps.storage.getConversation(request.conversationId);
    if (!conversation || conversation.kind !== "implementation-plan") {
      return conversation;
    }
    if (conversation.metadata.pendingPlanItemReview !== true) {
      throw new Error("This implementation plan is not waiting for item review.");
    }
    const finding = conversation.findings.find((item) => item.id === request.findingId);
    if (!finding || finding.status !== "Confirmed") {
      throw new Error("The confirmed plan item was not found.");
    }

    const comment = request.comment?.trim() ?? "";
    if (!comment && !request.confirmed) {
      throw new Error("Confirm the item or enter a comment.");
    }

    const existingReviews = planItemReviewsFromMetadata(conversation);
    const existing = existingReviews.find((review) => review.findingId === finding.id);
    const now = new Date().toISOString();
    const review: PlanItemReview = {
      findingId: finding.id,
      status: comment ? "commented" : "confirmed",
      comment: comment || undefined,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    const reviews = [...existingReviews.filter((item) => item.findingId !== finding.id), review];
    conversation.metadata = {
      ...conversation.metadata,
      planItemReviews: reviews,
      pendingPlanItemReview: true,
      running: false
    };
    conversation.updatedAt = now;
    await this.consensus.conversationSaves.flushAndSaveConversation(conversation);
    return conversation;
  }

  async collectImplementationPlanDecisions(
    request: ReviewRequest,
    conversation: Conversation,
    participants: ParticipantConfig[],
    answers: PlanDecisionAnswer[],
    warnings: string[],
    signal: AbortSignal | undefined,
    progress: ProgressCallback | undefined,
    runId: string,
    failedParticipantIds: Set<string>
  ): Promise<{ pendingDecisions: PlanDecisionRequest[] }> {
    const decisionsByParticipant = new Map<string, PlanDecisionRequest[]>();

    for (const participant of participants) {
      throwIfAborted(signal);
      emitProgress(runId, progress, "decisions", `Checking blocking decisions with ${participant.label}.`, {
        participantLabel: participant.label
      });
      const result = await this.consensus.participantRuns.runParticipant(
        participant,
        buildDecisionDiscoveryPrompt(request, participant, answers),
        request,
        signal,
        cliSessionContext(conversation, warnings, participantSessionKey(participant))
      );
      if (!result.ok) {
        failedParticipantIds.add(participant.id);
        warnings.push(`${participant.label}: ${result.error ?? "failed"} during decision discovery.`);
        continue;
      }
      const decisions = parseDecisionProtocol(result.content, participant, participants);
      decisionsByParticipant.set(participant.id, decisions);
      emitProgress(runId, progress, "decisions", `${participant.label} found ${decisions.length} blocking decision${decisions.length === 1 ? "" : "s"}.`, {
        participantLabel: participant.label
      });
    }

    const allDecisions = Array.from(decisionsByParticipant.values()).flat();
    if (allDecisions.length === 0) {
      return { pendingDecisions: [] };
    }

    const pendingDecisions = allDecisions
      .filter((decision) => !isAnsweredDecision(decision, answers))
      .slice(0, MAX_DECISIONS);
    return { pendingDecisions };
  }

  async autoAnswerPendingDecisions(
    request: ReviewRequest,
    conversation: Conversation,
    arbiter: ParticipantConfig,
    pendingDecisions: PlanDecisionRequest[],
    answers: PlanDecisionAnswer[],
    warnings: string[],
    signal: AbortSignal | undefined,
    progress: ProgressCallback | undefined,
    runId: string
  ): Promise<{ answers: PlanDecisionAnswer[]; pendingDecisions: PlanDecisionRequest[] }> {
    let mergedAnswers = mergeDecisionAnswers([], answers);
    const remaining: PlanDecisionRequest[] = [];
    const replies = planDecisionRepliesFromMetadata(conversation);

    for (const decision of pendingDecisions) {
      throwIfAborted(signal);
      if (isAnsweredDecision(decision, mergedAnswers)) {
        continue;
      }
      if (mergedAnswers.length === 0) {
        remaining.push(decision);
        continue;
      }

      emitProgress(runId, progress, "decisions", `Checking whether previous answers cover "${decision.title}".`, {
        findingTitle: decision.title
      });
      const result = await this.consensus.participantRuns.runParticipant(
        arbiter,
        buildAutomaticDecisionAnswerPrompt(decision, mergedAnswers),
        request,
        signal,
        cliSessionContext(conversation, warnings, arbiterSessionKey(arbiter))
      );
      if (!result.ok) {
        warnings.push(`${arbiter.label} could not check automatic answer for "${decision.title}": ${result.error ?? "unknown error"}.`);
        remaining.push(decision);
        continue;
      }

      const parsed = parseAutomaticDecisionAnswer(result.content);
      const selectedOptionId = parsed.selectedOptionId && decision.options.some((option) => option.id === parsed.selectedOptionId)
        ? parsed.selectedOptionId
        : undefined;
      if (!parsed.applies || !parsed.answer.trim()) {
        remaining.push(decision);
        continue;
      }

      const automaticAnswer: PlanDecisionAnswer = {
        decisionId: decision.id,
        decisionKey: decisionKey(decision),
        selectedOptionId,
        answer: [
          `Decision: ${decision.title}`,
          `Question: ${decision.question}`,
          selectedOptionId ? `Selected option: ${decision.options.find((option) => option.id === selectedOptionId)?.label ?? selectedOptionId}` : "",
          `Automatic answer: ${parsed.answer}`,
          parsed.reason ? `Reason: ${parsed.reason}` : ""
        ].filter(Boolean).join("\n"),
        answerSource: "automatic",
        sourceDecisionId: parsed.sourceDecisionId
      };
      mergedAnswers = mergeDecisionAnswers(mergedAnswers, [automaticAnswer]);
      replies.push(
        planDecisionReply(
          decision.id,
          "participant",
          [
            parsed.sourceDecisionId ? `Automatic answer based on previous decision ${parsed.sourceDecisionId}.` : "Automatic answer based on previous decision context.",
            parsed.answer,
            parsed.reason ? `Reason: ${parsed.reason}` : ""
          ].filter(Boolean).join("\n\n"),
          asArbiterParticipant(arbiter, request.kind),
          "done",
          { answerSource: "automatic", sourceDecisionId: parsed.sourceDecisionId }
        )
      );
      conversation.metadata = {
        ...conversation.metadata,
        implementationPlanAnswers: mergedAnswers,
        planDecisionRequests: mergePlanDecisionRequests(planDecisionRequestsFromMetadata(conversation), pendingDecisions),
        planDecisionReplies: replies,
        pendingDecisionSelections: undefined,
        pendingDecisionResolutions: undefined,
        warnings,
        running: true
      };
      conversation.updatedAt = new Date().toISOString();
      this.consensus.conversationSaves.queueConversationSnapshot(conversation);
    }

    return { answers: mergedAnswers, pendingDecisions: remaining };
  }
}
