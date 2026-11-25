import { randomUUID } from "node:crypto";
import type {
  ComposeImplementationPlanRequest, Conversation, ParticipantConfig, RecoverImplementationPlanRequest,
  ReviseImplementationPlanRequest, RetryImplementationPlanSynthesisRequest, ReviewRequest, StartReviewResult
} from "../../../../shared/types";
import {
  hasStoredImplementationPlan, implementationPlanAnswersFromMetadata, implementationPlanRequestFromMetadata, metadataNumber,
  metadataText, metadataWarnings, pendingDecisionsFromMetadata, planItemReviewForFinding, planItemReviewsFromMetadata,
  rawImplementationPlansFromMetadata, requiredPlanItemReviewFindings, serializeReviewRequest
} from "./planMetadata";
import {
  fallbackImplementationPlanSynthesis, implementationPlanSynthesis, localImplementationPlanDebateSummary, markdownSection,
  parseImplementationPlanSynthesis, removeMarkdownSection
} from "./planText";
import type { ImplementationPlanSynthesis } from "./types";
import { buildImplementationPlanRevisionPrompt, buildImplementationPlanSynthesisPrompt } from "../prompts/planPrompts";
import { arbiterSessionKey, cliSessionContext, isCliParticipant } from "../runs/cliSessions";
import { consensusMessage, emitProgress, throwIfAborted } from "../runs/reviewRecords";
import type { ProgressCallback } from "../types";
import type { ConsensusModules } from "../modules";
import type { ConsensusDependencies } from "../dependencies";

/** Plans composed, retried, recovered and revised. */
export class PlanRevisions {
  constructor(
    private readonly consensus: Pick<ConsensusModules, "conversationSaves" | "implementationPlans" | "participantRuns">,
    private readonly deps: Pick<ConsensusDependencies, "debugLogs" | "storage">
  ) {}

  async composeImplementationPlan(
    request: ComposeImplementationPlanRequest,
    signal?: AbortSignal,
    progress?: ProgressCallback
  ): Promise<StartReviewResult> {
    const conversation = await this.deps.storage.getConversation(request.conversationId);
    if (!conversation) {
      throw new Error("Conversation was not found.");
    }
    if (conversation.kind !== "implementation-plan") {
      throw new Error("Only implementation-plan conversations can compose an implementation plan.");
    }
    if (conversation.metadata.pendingPlanItemReview !== true) {
      throw new Error("This implementation plan is not waiting for item review.");
    }
    const originalRequest = implementationPlanRequestFromMetadata(conversation);
    if (!originalRequest) {
      throw new Error("The saved implementation-plan request is missing.");
    }
    const arbiter = originalRequest.arbiter ?? originalRequest.participants[0];
    if (!arbiter || !isCliParticipant(arbiter)) {
      throw new Error("The saved implementation-plan planner is missing or unavailable.");
    }

    const warnings = metadataWarnings(conversation);
    const reviews = planItemReviewsFromMetadata(conversation);
    const missingReviews = requiredPlanItemReviewFindings(conversation).filter((finding) => !planItemReviewForFinding(finding, reviews));
    if (missingReviews.length > 0) {
      throw new Error(`${missingReviews.length} confirmed plan item${missingReviews.length === 1 ? "" : "s"} still need review.`);
    }

    const runId = request.runId ?? originalRequest.runId ?? randomUUID();
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

    conversation.metadata = {
      ...conversation.metadata,
      pendingPlanItemReview: true,
      warnings,
      running: true
    };
    conversation.updatedAt = new Date().toISOString();
    this.consensus.conversationSaves.queueConversationSnapshot(conversation);

    try {
      emitProgress(runId, recordProgress, "summary", "Building final approved implementation plan from reviewed items.");
      const synthesis = await this.synthesizeImplementationPlan(
        { ...originalRequest, runId },
        conversation,
        arbiter,
        warnings,
        signal,
        recordProgress,
        runId
      );
      throwIfAborted(signal);

      conversation.finalSummary = synthesis.combined;
      conversation.messages.push(consensusMessage("summary", conversation.finalSummary));
      emitProgress(runId, recordProgress, "done", "Implementation-plan consensus finished.");
      conversation.metadata = {
        ...conversation.metadata,
        implementationPlanFinalMarkdown: synthesis.fullPlan,
        implementationPlanDebateSummaryMarkdown: synthesis.debateSummary,
        implementationPlanSynthesisSource: synthesis.source,
        pendingPlanItemReview: undefined,
        warnings,
        running: false
      };
      conversation.updatedAt = new Date().toISOString();
      await this.consensus.conversationSaves.flushAndSaveConversation(conversation);
      return { conversation, warnings };
    } catch (error) {
      const latest = (await this.deps.storage.getConversation(request.conversationId)) ?? conversation;
      latest.metadata = {
        ...latest.metadata,
        pendingPlanItemReview: true,
        warnings,
        running: false
      };
      latest.updatedAt = new Date().toISOString();
      await this.consensus.conversationSaves.flushAndSaveConversation(latest);
      throw error;
    }
  }

  async retryImplementationPlanSynthesis(
    request: RetryImplementationPlanSynthesisRequest,
    signal?: AbortSignal,
    progress?: ProgressCallback
  ): Promise<StartReviewResult> {
    const conversation = await this.deps.storage.getConversation(request.conversationId);
    if (!conversation) {
      throw new Error("Conversation was not found.");
    }
    if (conversation.kind !== "implementation-plan") {
      throw new Error("Only implementation-plan conversations can retry final plan synthesis.");
    }
    if (conversation.metadata.pendingPlanItemReview === true) {
      throw new Error("Review all confirmed plan items before retrying final plan synthesis.");
    }
    const originalRequest = implementationPlanRequestFromMetadata(conversation);
    if (!originalRequest) {
      throw new Error("The saved implementation-plan request is missing.");
    }
    const arbiter = originalRequest.arbiter ?? originalRequest.participants[0];
    if (!arbiter || !isCliParticipant(arbiter)) {
      throw new Error("The saved implementation-plan planner is missing or unavailable.");
    }
    if (!conversation.findings.some((finding) => finding.status === "Confirmed")) {
      throw new Error("There are no approved plan items to synthesize.");
    }

    const warnings = metadataWarnings(conversation);
    const runId = request.runId ?? originalRequest.runId ?? randomUUID();
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

    conversation.metadata = {
      ...conversation.metadata,
      pendingPlanItemReview: undefined,
      warnings,
      running: true
    };
    conversation.updatedAt = new Date().toISOString();
    this.consensus.conversationSaves.queueConversationSnapshot(conversation);

    try {
      emitProgress(runId, recordProgress, "summary", "Retrying final plan synthesis from approved items.");
      const synthesis = await this.synthesizeImplementationPlan(
        { ...originalRequest, runId },
        conversation,
        arbiter,
        warnings,
        signal,
        recordProgress,
        runId,
        { fallbackWarning: false }
      );
      throwIfAborted(signal);

      if (synthesis.source === "fallback") {
        const warning = "Final plan synthesis timed out or failed. Keeping the existing fallback plan.";
        if (!warnings.includes(warning)) {
          warnings.push(warning);
        }
        emitProgress(runId, recordProgress, "done", "Final plan retry kept the existing fallback plan.");
        conversation.metadata = {
          ...conversation.metadata,
          implementationPlanSynthesisSource: conversation.metadata.implementationPlanSynthesisSource ?? "fallback",
          pendingPlanItemReview: undefined,
          warnings,
          running: false
        };
      } else {
        conversation.finalSummary = synthesis.combined;
        conversation.messages.push(consensusMessage("summary", conversation.finalSummary));
        emitProgress(runId, recordProgress, "done", "Final plan synthesis retry finished.");
        conversation.metadata = {
          ...conversation.metadata,
          implementationPlanFinalMarkdown: synthesis.fullPlan,
          implementationPlanDebateSummaryMarkdown: synthesis.debateSummary,
          implementationPlanSynthesisSource: synthesis.source,
          pendingPlanItemReview: undefined,
          warnings,
          running: false
        };
      }
      conversation.updatedAt = new Date().toISOString();
      await this.consensus.conversationSaves.flushAndSaveConversation(conversation);
      return { conversation, warnings };
    } catch (error) {
      const latest = (await this.deps.storage.getConversation(request.conversationId)) ?? conversation;
      latest.metadata = {
        ...latest.metadata,
        pendingPlanItemReview: undefined,
        warnings,
        running: false
      };
      latest.updatedAt = new Date().toISOString();
      await this.consensus.conversationSaves.flushAndSaveConversation(latest);
      throw error;
    }
  }

  async recoverImplementationPlan(
    request: RecoverImplementationPlanRequest,
    signal?: AbortSignal,
    progress?: ProgressCallback
  ): Promise<StartReviewResult> {
    const conversation = await this.deps.storage.getConversation(request.conversationId);
    if (!conversation) {
      throw new Error("Conversation was not found.");
    }
    if (conversation.kind !== "implementation-plan") {
      throw new Error("Only implementation-plan conversations can be recovered.");
    }
    if (pendingDecisionsFromMetadata(conversation).length > 0) {
      throw new Error("Resolve pending plan decisions before recovering the implementation plan.");
    }
    if (conversation.metadata.pendingPlanItemReview === true) {
      throw new Error("Review confirmed plan items before recovering the implementation plan.");
    }
    if (hasStoredImplementationPlan(conversation)) {
      throw new Error("This conversation already has a final implementation plan.");
    }

    const originalRequest = implementationPlanRequestFromMetadata(conversation);
    if (!originalRequest) {
      throw new Error("The saved implementation-plan request is missing.");
    }
    const arbiter = originalRequest.arbiter ?? originalRequest.participants[0];
    if (!arbiter || !isCliParticipant(arbiter)) {
      throw new Error("The saved implementation-plan planner is missing or unavailable.");
    }
    const answers = implementationPlanAnswersFromMetadata(conversation);
    const rawPlans = rawImplementationPlansFromMetadata(conversation);
    const runId = request.runId ?? randomUUID();
    const recoveredRequest = { ...originalRequest, runId };
    const warnings = metadataWarnings(conversation);
    const warning = "Recovering interrupted implementation-plan run from saved context.";
    if (!warnings.includes(warning)) {
      warnings.push(warning);
    }
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

    try {
      if (rawPlans.length >= 2) {
        const healthyParticipantIds = new Set(rawPlans.map((plan) => plan.participantId));
        const healthyParticipants = originalRequest.participants.filter((participant) => healthyParticipantIds.has(participant.id));
        if (healthyParticipants.length < 2) {
          throw new Error("Fewer than two saved member plans are available for recovery.");
        }
        conversation.findings = [];
        conversation.finalSummary = undefined;
        conversation.metadata = {
          ...conversation.metadata,
          implementationPlanRequest: serializeReviewRequest(recoveredRequest),
          implementationPlanAnswers: answers,
          implementationPlanRawPlans: rawPlans,
          implementationPlanFinalMarkdown: undefined,
          implementationPlanDebateSummaryMarkdown: undefined,
          implementationPlanSynthesisSource: undefined,
          pendingDecisionSelections: undefined,
          pendingDecisionResolutions: undefined,
          pendingDecisions: undefined,
          pendingPlanItemReview: undefined,
          warnings,
          running: true
        };
        conversation.updatedAt = new Date().toISOString();
        this.consensus.conversationSaves.queueConversationSnapshot(conversation);
        emitProgress(runId, recordProgress, "initial", "Recovering implementation plan from saved member plans.");
        return await this.consensus.implementationPlans.processImplementationPlanRawPlans(
          recoveredRequest,
          conversation,
          healthyParticipants,
          rawPlans,
          arbiter,
          answers,
          warnings,
          signal,
          recordProgress,
          runId
        );
      }

      emitProgress(runId, recordProgress, "initial", "Recovering implementation plan by rerunning saved request.");
      return await this.consensus.implementationPlans.startImplementationPlan(recoveredRequest, signal, progress, { conversation, answers });
    } catch (error) {
      const latest = (await this.deps.storage.getConversation(request.conversationId)) ?? conversation;
      latest.metadata = {
        ...latest.metadata,
        warnings,
        running: false
      };
      latest.updatedAt = new Date().toISOString();
      await this.consensus.conversationSaves.flushAndSaveConversation(latest);
      throw error;
    }
  }

  async reviseImplementationPlan(
    request: ReviseImplementationPlanRequest,
    signal?: AbortSignal,
    progress?: ProgressCallback
  ): Promise<StartReviewResult> {
    const conversation = await this.deps.storage.getConversation(request.conversationId);
    if (!conversation) {
      throw new Error("Conversation was not found.");
    }
    if (conversation.kind !== "implementation-plan") {
      throw new Error("Only implementation-plan conversations can revise a final plan.");
    }
    if (conversation.metadata.pendingPlanItemReview === true) {
      throw new Error("Review all confirmed plan items before revising the final plan.");
    }
    if (pendingDecisionsFromMetadata(conversation).length > 0) {
      throw new Error("Resolve pending plan decisions before revising the final plan.");
    }
    if (!conversation.findings.some((finding) => finding.status === "Confirmed")) {
      throw new Error("There is no approved final plan to revise.");
    }
    const instruction = request.instruction.trim();
    if (!instruction) {
      throw new Error("Enter a plan correction.");
    }
    const originalRequest = implementationPlanRequestFromMetadata(conversation);
    if (!originalRequest) {
      throw new Error("The saved implementation-plan request is missing.");
    }
    const planner = originalRequest.arbiter ?? originalRequest.participants[0];
    if (!planner || !isCliParticipant(planner)) {
      throw new Error("The saved implementation-plan planner is missing or unavailable.");
    }

    const previousPlan =
      metadataText(conversation.metadata.implementationPlanFinalMarkdown) ||
      markdownSection(conversation.finalSummary ?? "", "Plan") ||
      removeMarkdownSection(conversation.finalSummary ?? "", "Debate Summary") ||
      fallbackImplementationPlanSynthesis(conversation).fullPlan;
    if (!previousPlan.trim()) {
      throw new Error("There is no final implementation plan to revise.");
    }

    const existingDebateSummary =
      metadataText(conversation.metadata.implementationPlanDebateSummaryMarkdown) ||
      markdownSection(conversation.finalSummary ?? "", "Debate Summary") ||
      localImplementationPlanDebateSummary(conversation);
    const warnings = metadataWarnings(conversation);
    const runId = request.runId ?? originalRequest.runId ?? randomUUID();
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

    conversation.messages.push(consensusMessage("user", instruction));
    conversation.metadata = {
      ...conversation.metadata,
      pendingPlanItemReview: undefined,
      warnings,
      running: true
    };
    conversation.updatedAt = new Date().toISOString();
    await this.consensus.conversationSaves.flushAndSaveConversation(conversation);

    try {
      emitProgress(runId, recordProgress, "summary", `Planner ${planner.label} is revising the final plan.`);
      const result = await this.consensus.participantRuns.runParticipant(
        planner,
        buildImplementationPlanRevisionPrompt(
          { ...originalRequest, runId },
          conversation,
          previousPlan,
          existingDebateSummary,
          instruction,
          warnings
        ),
        { ...originalRequest, runId },
        signal,
        cliSessionContext(conversation, warnings, arbiterSessionKey(planner))
      );
      throwIfAborted(signal);

      if (!result.ok) {
        const warning = `${planner.label} could not revise the final implementation plan: ${result.error ?? "unknown error"}. Keeping the existing plan.`;
        if (!warnings.includes(warning)) {
          warnings.push(warning);
        }
        emitProgress(runId, recordProgress, "done", "Final plan revision kept the existing plan.");
        conversation.metadata = {
          ...conversation.metadata,
          pendingPlanItemReview: undefined,
          warnings,
          running: false
        };
        conversation.updatedAt = new Date().toISOString();
        await this.consensus.conversationSaves.flushAndSaveConversation(conversation);
        return { conversation, warnings };
      }

      const parsed = parseImplementationPlanSynthesis(result.content, conversation);
      if (parsed.source === "fallback") {
        const warning = `${planner.label} did not return a usable revised implementation plan. Keeping the existing plan.`;
        if (!warnings.includes(warning)) {
          warnings.push(warning);
        }
        emitProgress(runId, recordProgress, "done", "Final plan revision kept the existing plan.");
        conversation.metadata = {
          ...conversation.metadata,
          pendingPlanItemReview: undefined,
          warnings,
          running: false
        };
        conversation.updatedAt = new Date().toISOString();
        await this.consensus.conversationSaves.flushAndSaveConversation(conversation);
        return { conversation, warnings };
      }

      const synthesis = implementationPlanSynthesis(parsed.fullPlan, parsed.debateSummary || existingDebateSummary, "arbiter");
      conversation.finalSummary = synthesis.combined;
      conversation.messages.push(consensusMessage("summary", conversation.finalSummary));
      emitProgress(runId, recordProgress, "done", "Final plan revision finished.");
      conversation.metadata = {
        ...conversation.metadata,
        implementationPlanFinalMarkdown: synthesis.fullPlan,
        implementationPlanDebateSummaryMarkdown: synthesis.debateSummary,
        implementationPlanSynthesisSource: synthesis.source,
        implementationPlanRevisionCount: metadataNumber(conversation.metadata.implementationPlanRevisionCount) + 1,
        pendingPlanItemReview: undefined,
        warnings,
        running: false
      };
      conversation.updatedAt = new Date().toISOString();
      await this.consensus.conversationSaves.flushAndSaveConversation(conversation);
      return { conversation, warnings };
    } catch (error) {
      const latest = (await this.deps.storage.getConversation(request.conversationId)) ?? conversation;
      latest.metadata = {
        ...latest.metadata,
        pendingPlanItemReview: undefined,
        warnings,
        running: false
      };
      latest.updatedAt = new Date().toISOString();
      await this.consensus.conversationSaves.flushAndSaveConversation(latest);
      throw error;
    }
  }

  async synthesizeImplementationPlan(
    request: ReviewRequest,
    conversation: Conversation,
    arbiter: ParticipantConfig,
    warnings: string[],
    signal: AbortSignal | undefined,
    progress: ProgressCallback | undefined,
    runId: string,
    options: { fallbackWarning?: boolean } = {}
  ): Promise<ImplementationPlanSynthesis> {
    throwIfAborted(signal);
    emitProgress(runId, progress, "summary", `Planner ${arbiter.label} is synthesizing the final plan.`);
    const result = await this.consensus.participantRuns.runParticipant(
      arbiter,
      buildImplementationPlanSynthesisPrompt(request, conversation, warnings),
      request,
      signal,
      cliSessionContext(conversation, warnings, arbiterSessionKey(arbiter))
    );
    if (!result.ok) {
      if (options.fallbackWarning !== false) {
        warnings.push(`${arbiter.label} could not synthesize the final implementation plan: ${result.error ?? "unknown error"}. Used local summary fallback.`);
      }
      return fallbackImplementationPlanSynthesis(conversation);
    }

    const synthesis = parseImplementationPlanSynthesis(result.content, conversation);
    if (synthesis.source === "fallback" && options.fallbackWarning !== false) {
      warnings.push("Planner synthesis did not include a usable final plan; used local summary fallback.");
    }
    return synthesis;
  }
}
