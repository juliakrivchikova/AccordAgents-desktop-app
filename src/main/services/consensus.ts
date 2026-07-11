import { randomUUID } from "node:crypto";
import type {
  ChatMessage,
  ComposeImplementationPlanRequest,
  ContinueReviewRequest,
  Conversation,
  ConversationKind,
  DebateRound,
  DebateStance,
  Finding,
  FindingSourceItem,
  FindingSeverity,
  FindingStatus,
  GitDiffResult,
  ParticipantConfig,
  PlanDecisionAnswer,
  PlanDecisionClarificationRequest,
  PlanDecisionOption,
  PlanDecisionReply,
  PlanDecisionRequest,
  PlanItemReview,
  PlanItemReviewRequest,
  RecoverImplementationPlanRequest,
  ReviseImplementationPlanRequest,
  RetryImplementationPlanSynthesisRequest,
  ReviewProgress,
  ReviewRequest,
  StartReviewResult
} from "../../shared/types";
import { CliAgentRunner } from "./cliAgents";
import { DebugLogService } from "./debugLogs";
import { GitService } from "./git";
import { ParticipantRunResult, ProviderRunner } from "./providers";
import { StorageService } from "./storage";
import { DEFAULT_NOTICE_CHARS, sanitizeWarningList } from "../../shared/warnings";

const MAX_CONTEXT_CHARS = 90_000;
const MAX_POINTS = 8;
const MAX_VERIFIERS_PER_POINT = 2;
const MAX_DECISIONS = 8;
const MAX_DECISION_GATES = 2;
const MAX_STORED_WARNING_CHARS = DEFAULT_NOTICE_CHARS;
const MIN_POINT_MATCH_TOKENS = 3;
const MIN_POINT_MATCH_RATIO = 0.5;
const SEVERITY_ORDER: FindingSeverity[] = ["Critical", "High", "Medium", "Low", "Info"];
type ProgressCallback = (progress: ReviewProgress) => void;

interface LinePoint {
  id: string;
  title: string;
  claim: string;
  evidence: string;
  action: string;
  severity: FindingSeverity;
  sourceParticipantIds: string[];
}

interface RawImplementationPlan {
  participantId: string;
  participantLabel: string;
  content: string;
  createdAt: string;
}

interface ParsedVerification {
  stance: "confirmed" | "rejected" | "unclear";
  severity?: FindingSeverity;
  reason: string;
}

interface ParsedSourceDecision {
  decision: "accept" | "reject" | "unclear";
  reason: string;
}

interface ParsedAutomaticDecisionAnswer {
  applies: boolean;
  selectedOptionId?: string;
  sourceDecisionId?: string;
  answer: string;
  reason: string;
}

interface ImplementationPlanSynthesis {
  fullPlan: string;
  debateSummary: string;
  combined: string;
  source: "arbiter" | "fallback";
}

interface PlanResumeState {
  conversation: Conversation;
  answers: PlanDecisionAnswer[];
}

interface CliAgentSessionMetadata {
  key: string;
  participantId: string;
  participantKind: ParticipantConfig["kind"];
  participantLabel: string;
  sessionId: string;
  updatedAt: string;
}

interface CliSessionContext {
  conversation: Conversation;
  warnings: string[];
  sessionKey: string;
}

export class ConsensusService {
  private readonly conversationSaveQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly git: GitService,
    private readonly storage: StorageService,
    private readonly providerRunner: ProviderRunner,
    private readonly cliRunner: CliAgentRunner,
    private readonly debugLogs: DebugLogService,
    private readonly onConversationSnapshot?: (conversation: Conversation) => void
  ) {}

  async startReview(request: ReviewRequest, signal?: AbortSignal, progress?: ProgressCallback): Promise<StartReviewResult> {
    if (request.kind === "implementation-plan") {
      return this.startImplementationPlan(request, signal, progress);
    }

    const warnings: string[] = [];
    const runId = request.runId ?? randomUUID();
    const now = new Date().toISOString();
    const arbiter = request.arbiter ?? request.participants[0];
    let conversation: Conversation | undefined;
    const recordProgress: ProgressCallback = (event) => {
      void this.debugLogs.write("progress", {
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

    this.emitProgress(runId, recordProgress, "initial", "Preparing review context.");
    this.throwIfAborted(signal);
    const diff = await this.resolveDiff(request, warnings);
    const initialPrompt = this.buildInitialPrompt(request, diff, warnings);

    conversation = {
      id: randomUUID(),
      title: this.titleFor(request, diff),
      kind: request.kind,
      createdAt: now,
      updatedAt: now,
      repoPath: request.repoPath,
      messages: [
        this.message("user", request.question || "Review the selected changes."),
        this.message("system", this.systemIntro(request, diff, arbiter), this.asArbiterParticipant(arbiter, request.kind))
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
    this.queueConversationSnapshot(conversation);

    const failedParticipantIds = new Set<string>();
    let completedInitial = 0;
    const initialResults = await Promise.all(
      request.participants.map(async (participant) => {
        this.emitProgress(runId, recordProgress, "initial", `Running independent answer from ${participant.label}.`, {
          participantLabel: participant.label,
          completed: completedInitial,
          total: request.participants.length
        });
        const result = await this.runParticipant(participant, initialPrompt, request, signal);
        completedInitial += 1;
        this.emitProgress(runId, recordProgress, "initial", `${participant.label} ${result.ok ? "finished" : "failed"} independent answer${this.formatDuration(result.durationMs)}.`, {
          participantLabel: participant.label,
          completed: completedInitial,
          total: request.participants.length
        });
        return result;
      })
    );
    this.throwIfAborted(signal);

    for (const result of initialResults) {
      conversation.messages.push(this.message("participant", result.content, result.participant, result.ok ? "done" : "error"));
      if (!result.ok && result.error) {
        failedParticipantIds.add(result.participant.id);
        warnings.push(`${result.participant.label}: ${result.error}. Skipping this participant for the rest of the run.`);
      }
    }

    const healthyParticipants = request.participants.filter((participant) => !failedParticipantIds.has(participant.id));
    const participantPoints = await this.collectParticipantPoints(
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

    this.emitProgress(runId, recordProgress, "arbiter", `Arbiter ${arbiter.label} is merging points.`);
    const arbiterPrompt = this.buildArbiterPrompt(request, diff, healthyParticipants, participantPoints, warnings);
    const arbiterResult = await this.runParticipant(arbiter, arbiterPrompt, request, signal);
    conversation.messages.push(this.message("participant", arbiterResult.content, this.asArbiterParticipant(arbiter, request.kind), arbiterResult.ok ? "done" : "error"));

    let canonicalPoints = arbiterResult.ok
      ? this.parseLineProtocol(arbiterResult.content, undefined, healthyParticipants)
      : [];
    if (!arbiterResult.ok) {
      warnings.push(`${arbiter.label} arbiter failed: ${arbiterResult.error ?? "unknown error"}. Falling back to local point merge.`);
    }
    if (canonicalPoints.length === 0) {
      canonicalPoints = this.localMergePoints(participantPoints);
      warnings.push("Arbiter did not return canonical points; used local line-protocol merge fallback.");
    }

    canonicalPoints = canonicalPoints
      .filter((point) => !this.isMetaPoint(point))
      .map((point) => this.withInferredSources(point, participantPoints, healthyParticipants));
    const untraceablePointCount = canonicalPoints.filter((point) => point.sourceParticipantIds.length === 0).length;
    if (untraceablePointCount > 0) {
      warnings.push(`${untraceablePointCount} arbiter point${untraceablePointCount === 1 ? "" : "s"} had no matching participant source and were filtered out.`);
    }
    canonicalPoints = canonicalPoints
      .filter((point) => point.sourceParticipantIds.length > 0)
      .slice(0, MAX_POINTS);
    if (canonicalPoints.length === 0) {
      warnings.push("No actionable points were extracted from the independent answers.");
    }

    this.emitProgress(runId, recordProgress, "debate", `Extracted ${canonicalPoints.length} canonical point${canonicalPoints.length === 1 ? "" : "s"}.`);
    this.emitProgress(runId, recordProgress, "debate", `Opening ${canonicalPoints.length} consensus threads.`, {
      completed: 0,
      total: canonicalPoints.length
    });

    for (let index = 0; index < canonicalPoints.length; index += 1) {
      this.throwIfAborted(signal);
      const point = canonicalPoints[index];
      const finding = this.createFinding(point, healthyParticipants);
      if (finding.status !== "Confirmed") {
        await this.debatePoint(finding, request, diff, warnings, signal, recordProgress, runId, index, canonicalPoints.length, failedParticipantIds);
      }
      conversation.findings.push(finding);
      this.emitProgress(runId, recordProgress, "debate", `Finished point ${index + 1} of ${canonicalPoints.length}.`, {
        findingTitle: finding.title,
        completed: index + 1,
        total: canonicalPoints.length
      });
    }

    this.emitProgress(runId, recordProgress, "summary", "Building final consensus summary.");
    conversation.finalSummary = this.finalSummary(conversation);
    conversation.messages.push(this.message("summary", conversation.finalSummary));
    this.emitProgress(runId, recordProgress, "done", "Consensus review finished.");
    conversation.updatedAt = new Date().toISOString();
    await this.flushAndSaveConversation(conversation);

    return { conversation, warnings };
  }

  async continueReview(request: ContinueReviewRequest, signal?: AbortSignal, progress?: ProgressCallback): Promise<StartReviewResult> {
    const conversation = await this.storage.getConversation(request.conversationId);
    if (!conversation) {
      throw new Error("Conversation was not found.");
    }
    if (conversation.kind !== "implementation-plan") {
      throw new Error("Only implementation-plan conversations can be continued.");
    }
    const originalRequest = this.implementationPlanRequestFromMetadata(conversation);
    if (!originalRequest) {
      throw new Error("The saved implementation-plan request is missing.");
    }

    const previousAnswers = this.implementationPlanAnswersFromMetadata(conversation);
    let answers = this.mergeDecisionAnswers(previousAnswers, request.answers);
    const runId = request.runId ?? originalRequest.runId ?? randomUUID();
    const warnings = this.metadataWarnings(conversation);
    const pendingDecisions = this.pendingDecisionsFromMetadata(conversation);
    const decisionRequests = this.mergePlanDecisionRequests(this.planDecisionRequestsFromMetadata(conversation), pendingDecisions);
    const arbiter = originalRequest.arbiter ?? originalRequest.participants[0];
    const recordProgress: ProgressCallback = (event) => {
      void this.debugLogs.write("progress", {
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

    if (pendingDecisions.length > 0 && arbiter && this.isCliParticipant(arbiter)) {
      const automatic = await this.autoAnswerPendingDecisions(
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
          planDecisionRequests: this.mergePlanDecisionRequests(decisionRequests, automatic.pendingDecisions),
          pendingDecisionSelections: undefined,
          pendingDecisionResolutions: undefined,
          pendingDecisions: automatic.pendingDecisions,
          warnings,
          running: false
        };
        conversation.updatedAt = new Date().toISOString();
        this.emitProgress(runId, recordProgress, "decisions", `${automatic.pendingDecisions.length} decision thread${automatic.pendingDecisions.length === 1 ? "" : "s"} still need input.`);
        await this.flushAndSaveConversation(conversation);
        return { conversation, warnings, pendingDecisions: automatic.pendingDecisions };
      }
    }

    const stillPendingDecisions = pendingDecisions.filter((decision) => !this.isAnsweredDecision(decision, answers));
    if (stillPendingDecisions.length > 0) {
      conversation.metadata = {
        ...conversation.metadata,
        implementationPlanAnswers: answers,
        planDecisionRequests: this.mergePlanDecisionRequests(decisionRequests, stillPendingDecisions),
        pendingDecisionSelections: undefined,
        pendingDecisionResolutions: undefined,
        pendingDecisions: stillPendingDecisions,
        warnings,
        running: false
      };
      conversation.updatedAt = new Date().toISOString();
      await this.flushAndSaveConversation(conversation);
      return { conversation, warnings, pendingDecisions: stillPendingDecisions };
    }

    const resumedRequest = { ...originalRequest, runId };
    try {
      return await this.startImplementationPlan(resumedRequest, signal, progress, { conversation, answers });
    } catch (error) {
      const latest = (await this.storage.getConversation(request.conversationId)) ?? conversation;
      latest.metadata = {
        ...latest.metadata,
        implementationPlanAnswers: answers,
        planDecisionRequests: this.mergePlanDecisionRequests(this.planDecisionRequestsFromMetadata(latest), pendingDecisions),
        running: false
      };
      latest.updatedAt = new Date().toISOString();
      await this.flushAndSaveConversation(latest);
      throw error;
    }
  }

  async askPlanDecisionClarification(
    request: PlanDecisionClarificationRequest,
    signal?: AbortSignal,
    progress?: ProgressCallback
  ): Promise<StartReviewResult> {
    const conversation = await this.storage.getConversation(request.conversationId);
    if (!conversation) {
      throw new Error("Conversation was not found.");
    }
    if (conversation.kind !== "implementation-plan") {
      throw new Error("Clarifications are only available for implementation-plan conversations.");
    }
    const originalRequest = this.implementationPlanRequestFromMetadata(conversation);
    if (!originalRequest) {
      throw new Error("The saved implementation-plan request is missing.");
    }
    const pendingDecisions = this.pendingDecisionsFromMetadata(conversation);
    const decisionRequests = this.mergePlanDecisionRequests(this.planDecisionRequestsFromMetadata(conversation), pendingDecisions);
    const decision = pendingDecisions.find((item) => item.id === request.decisionId);
    if (!decision) {
      throw new Error("The plan decision was not found.");
    }
    const question = request.question.trim();
    if (!question) {
      throw new Error("Enter a thread message.");
    }

    const warnings = this.metadataWarnings(conversation);
    const runId = request.runId ?? randomUUID();
    const replies = this.planDecisionRepliesFromMetadata(conversation);
    const recordProgress: ProgressCallback = (event) => {
      void this.debugLogs.write("progress", {
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
    replies.push(this.planDecisionReply(decision.id, "user", question));
    conversation.metadata = {
      ...conversation.metadata,
      planDecisionRequests: decisionRequests,
      pendingDecisions,
      planDecisionReplies: replies,
      warnings,
      running: true
    };
    conversation.updatedAt = new Date().toISOString();
    this.queueConversationSnapshot(conversation);
    this.emitProgress(runId, recordProgress, "decisions", `Sending thread message for "${decision.title}".`, {
      findingTitle: decision.title
    });

    const targets = this.clarificationTargets(originalRequest, decision);
    for (const participant of targets) {
      this.throwIfAborted(signal);
      this.emitProgress(runId, recordProgress, "decisions", `Waiting for ${participant.label} to reply in the thread.`, {
        participantLabel: participant.label,
        findingTitle: decision.title
      });
      const result = await this.runParticipant(
        participant,
        this.buildDecisionClarificationPrompt(originalRequest, decision, question, replies),
        originalRequest,
        signal,
        this.sessionContext(conversation, warnings, this.participantSessionKey(participant))
      );
      replies.push(
        this.planDecisionReply(
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
      this.queueConversationSnapshot(conversation);
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
    this.emitProgress(runId, recordProgress, "decisions", "Clarification replies added.");
    await this.flushAndSaveConversation(conversation);
    return { conversation, warnings, pendingDecisions };
  }

  async savePlanItemReview(request: PlanItemReviewRequest): Promise<Conversation | undefined> {
    const conversation = await this.storage.getConversation(request.conversationId);
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

    const existingReviews = this.planItemReviewsFromMetadata(conversation);
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
    await this.flushAndSaveConversation(conversation);
    return conversation;
  }

  async composeImplementationPlan(
    request: ComposeImplementationPlanRequest,
    signal?: AbortSignal,
    progress?: ProgressCallback
  ): Promise<StartReviewResult> {
    const conversation = await this.storage.getConversation(request.conversationId);
    if (!conversation) {
      throw new Error("Conversation was not found.");
    }
    if (conversation.kind !== "implementation-plan") {
      throw new Error("Only implementation-plan conversations can compose an implementation plan.");
    }
    if (conversation.metadata.pendingPlanItemReview !== true) {
      throw new Error("This implementation plan is not waiting for item review.");
    }
    const originalRequest = this.implementationPlanRequestFromMetadata(conversation);
    if (!originalRequest) {
      throw new Error("The saved implementation-plan request is missing.");
    }
    const arbiter = originalRequest.arbiter ?? originalRequest.participants[0];
    if (!arbiter || !this.isCliParticipant(arbiter)) {
      throw new Error("The saved implementation-plan planner is missing or unavailable.");
    }

    const warnings = this.metadataWarnings(conversation);
    const reviews = this.planItemReviewsFromMetadata(conversation);
    const missingReviews = this.requiredPlanItemReviewFindings(conversation).filter((finding) => !this.planItemReviewForFinding(finding, reviews));
    if (missingReviews.length > 0) {
      throw new Error(`${missingReviews.length} confirmed plan item${missingReviews.length === 1 ? "" : "s"} still need review.`);
    }

    const runId = request.runId ?? originalRequest.runId ?? randomUUID();
    const recordProgress: ProgressCallback = (event) => {
      void this.debugLogs.write("progress", {
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
    this.queueConversationSnapshot(conversation);

    try {
      this.emitProgress(runId, recordProgress, "summary", "Building final approved implementation plan from reviewed items.");
      const synthesis = await this.synthesizeImplementationPlan(
        { ...originalRequest, runId },
        conversation,
        arbiter,
        warnings,
        signal,
        recordProgress,
        runId
      );
      this.throwIfAborted(signal);

      conversation.finalSummary = synthesis.combined;
      conversation.messages.push(this.message("summary", conversation.finalSummary));
      this.emitProgress(runId, recordProgress, "done", "Implementation-plan consensus finished.");
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
      await this.flushAndSaveConversation(conversation);
      return { conversation, warnings };
    } catch (error) {
      const latest = (await this.storage.getConversation(request.conversationId)) ?? conversation;
      latest.metadata = {
        ...latest.metadata,
        pendingPlanItemReview: true,
        warnings,
        running: false
      };
      latest.updatedAt = new Date().toISOString();
      await this.flushAndSaveConversation(latest);
      throw error;
    }
  }

  async retryImplementationPlanSynthesis(
    request: RetryImplementationPlanSynthesisRequest,
    signal?: AbortSignal,
    progress?: ProgressCallback
  ): Promise<StartReviewResult> {
    const conversation = await this.storage.getConversation(request.conversationId);
    if (!conversation) {
      throw new Error("Conversation was not found.");
    }
    if (conversation.kind !== "implementation-plan") {
      throw new Error("Only implementation-plan conversations can retry final plan synthesis.");
    }
    if (conversation.metadata.pendingPlanItemReview === true) {
      throw new Error("Review all confirmed plan items before retrying final plan synthesis.");
    }
    const originalRequest = this.implementationPlanRequestFromMetadata(conversation);
    if (!originalRequest) {
      throw new Error("The saved implementation-plan request is missing.");
    }
    const arbiter = originalRequest.arbiter ?? originalRequest.participants[0];
    if (!arbiter || !this.isCliParticipant(arbiter)) {
      throw new Error("The saved implementation-plan planner is missing or unavailable.");
    }
    if (!conversation.findings.some((finding) => finding.status === "Confirmed")) {
      throw new Error("There are no approved plan items to synthesize.");
    }

    const warnings = this.metadataWarnings(conversation);
    const runId = request.runId ?? originalRequest.runId ?? randomUUID();
    const recordProgress: ProgressCallback = (event) => {
      void this.debugLogs.write("progress", {
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
    this.queueConversationSnapshot(conversation);

    try {
      this.emitProgress(runId, recordProgress, "summary", "Retrying final plan synthesis from approved items.");
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
      this.throwIfAborted(signal);

      if (synthesis.source === "fallback") {
        const warning = "Final plan synthesis timed out or failed. Keeping the existing fallback plan.";
        if (!warnings.includes(warning)) {
          warnings.push(warning);
        }
        this.emitProgress(runId, recordProgress, "done", "Final plan retry kept the existing fallback plan.");
        conversation.metadata = {
          ...conversation.metadata,
          implementationPlanSynthesisSource: conversation.metadata.implementationPlanSynthesisSource ?? "fallback",
          pendingPlanItemReview: undefined,
          warnings,
          running: false
        };
      } else {
        conversation.finalSummary = synthesis.combined;
        conversation.messages.push(this.message("summary", conversation.finalSummary));
        this.emitProgress(runId, recordProgress, "done", "Final plan synthesis retry finished.");
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
      await this.flushAndSaveConversation(conversation);
      return { conversation, warnings };
    } catch (error) {
      const latest = (await this.storage.getConversation(request.conversationId)) ?? conversation;
      latest.metadata = {
        ...latest.metadata,
        pendingPlanItemReview: undefined,
        warnings,
        running: false
      };
      latest.updatedAt = new Date().toISOString();
      await this.flushAndSaveConversation(latest);
      throw error;
    }
  }

  async recoverImplementationPlan(
    request: RecoverImplementationPlanRequest,
    signal?: AbortSignal,
    progress?: ProgressCallback
  ): Promise<StartReviewResult> {
    const conversation = await this.storage.getConversation(request.conversationId);
    if (!conversation) {
      throw new Error("Conversation was not found.");
    }
    if (conversation.kind !== "implementation-plan") {
      throw new Error("Only implementation-plan conversations can be recovered.");
    }
    if (this.pendingDecisionsFromMetadata(conversation).length > 0) {
      throw new Error("Resolve pending plan decisions before recovering the implementation plan.");
    }
    if (conversation.metadata.pendingPlanItemReview === true) {
      throw new Error("Review confirmed plan items before recovering the implementation plan.");
    }
    if (this.hasStoredImplementationPlan(conversation)) {
      throw new Error("This conversation already has a final implementation plan.");
    }

    const originalRequest = this.implementationPlanRequestFromMetadata(conversation);
    if (!originalRequest) {
      throw new Error("The saved implementation-plan request is missing.");
    }
    const arbiter = originalRequest.arbiter ?? originalRequest.participants[0];
    if (!arbiter || !this.isCliParticipant(arbiter)) {
      throw new Error("The saved implementation-plan planner is missing or unavailable.");
    }
    const answers = this.implementationPlanAnswersFromMetadata(conversation);
    const rawPlans = this.rawImplementationPlansFromMetadata(conversation);
    const runId = request.runId ?? randomUUID();
    const recoveredRequest = { ...originalRequest, runId };
    const warnings = this.metadataWarnings(conversation);
    const warning = "Recovering interrupted implementation-plan run from saved context.";
    if (!warnings.includes(warning)) {
      warnings.push(warning);
    }
    const recordProgress: ProgressCallback = (event) => {
      void this.debugLogs.write("progress", {
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
          throw new Error("Fewer than two saved participant plans are available for recovery.");
        }
        conversation.findings = [];
        conversation.finalSummary = undefined;
        conversation.metadata = {
          ...conversation.metadata,
          implementationPlanRequest: this.serializeReviewRequest(recoveredRequest),
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
        this.queueConversationSnapshot(conversation);
        this.emitProgress(runId, recordProgress, "initial", "Recovering implementation plan from saved participant plans.");
        return await this.processImplementationPlanRawPlans(
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

      this.emitProgress(runId, recordProgress, "initial", "Recovering implementation plan by rerunning saved request.");
      return await this.startImplementationPlan(recoveredRequest, signal, progress, { conversation, answers });
    } catch (error) {
      const latest = (await this.storage.getConversation(request.conversationId)) ?? conversation;
      latest.metadata = {
        ...latest.metadata,
        warnings,
        running: false
      };
      latest.updatedAt = new Date().toISOString();
      await this.flushAndSaveConversation(latest);
      throw error;
    }
  }

  async reviseImplementationPlan(
    request: ReviseImplementationPlanRequest,
    signal?: AbortSignal,
    progress?: ProgressCallback
  ): Promise<StartReviewResult> {
    const conversation = await this.storage.getConversation(request.conversationId);
    if (!conversation) {
      throw new Error("Conversation was not found.");
    }
    if (conversation.kind !== "implementation-plan") {
      throw new Error("Only implementation-plan conversations can revise a final plan.");
    }
    if (conversation.metadata.pendingPlanItemReview === true) {
      throw new Error("Review all confirmed plan items before revising the final plan.");
    }
    if (this.pendingDecisionsFromMetadata(conversation).length > 0) {
      throw new Error("Resolve pending plan decisions before revising the final plan.");
    }
    if (!conversation.findings.some((finding) => finding.status === "Confirmed")) {
      throw new Error("There is no approved final plan to revise.");
    }
    const instruction = request.instruction.trim();
    if (!instruction) {
      throw new Error("Enter a plan correction.");
    }
    const originalRequest = this.implementationPlanRequestFromMetadata(conversation);
    if (!originalRequest) {
      throw new Error("The saved implementation-plan request is missing.");
    }
    const planner = originalRequest.arbiter ?? originalRequest.participants[0];
    if (!planner || !this.isCliParticipant(planner)) {
      throw new Error("The saved implementation-plan planner is missing or unavailable.");
    }

    const previousPlan =
      this.metadataText(conversation.metadata.implementationPlanFinalMarkdown) ||
      this.markdownSection(conversation.finalSummary ?? "", "Plan") ||
      this.removeMarkdownSection(conversation.finalSummary ?? "", "Debate Summary") ||
      this.fallbackImplementationPlanSynthesis(conversation).fullPlan;
    if (!previousPlan.trim()) {
      throw new Error("There is no final implementation plan to revise.");
    }

    const existingDebateSummary =
      this.metadataText(conversation.metadata.implementationPlanDebateSummaryMarkdown) ||
      this.markdownSection(conversation.finalSummary ?? "", "Debate Summary") ||
      this.localImplementationPlanDebateSummary(conversation);
    const warnings = this.metadataWarnings(conversation);
    const runId = request.runId ?? originalRequest.runId ?? randomUUID();
    const recordProgress: ProgressCallback = (event) => {
      void this.debugLogs.write("progress", {
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

    conversation.messages.push(this.message("user", instruction));
    conversation.metadata = {
      ...conversation.metadata,
      pendingPlanItemReview: undefined,
      warnings,
      running: true
    };
    conversation.updatedAt = new Date().toISOString();
    await this.flushAndSaveConversation(conversation);

    try {
      this.emitProgress(runId, recordProgress, "summary", `Planner ${planner.label} is revising the final plan.`);
      const result = await this.runParticipant(
        planner,
        this.buildImplementationPlanRevisionPrompt(
          { ...originalRequest, runId },
          conversation,
          previousPlan,
          existingDebateSummary,
          instruction,
          warnings
        ),
        { ...originalRequest, runId },
        signal,
        this.sessionContext(conversation, warnings, this.arbiterSessionKey(planner))
      );
      this.throwIfAborted(signal);

      if (!result.ok) {
        const warning = `${planner.label} could not revise the final implementation plan: ${result.error ?? "unknown error"}. Keeping the existing plan.`;
        if (!warnings.includes(warning)) {
          warnings.push(warning);
        }
        this.emitProgress(runId, recordProgress, "done", "Final plan revision kept the existing plan.");
        conversation.metadata = {
          ...conversation.metadata,
          pendingPlanItemReview: undefined,
          warnings,
          running: false
        };
        conversation.updatedAt = new Date().toISOString();
        await this.flushAndSaveConversation(conversation);
        return { conversation, warnings };
      }

      const parsed = this.parseImplementationPlanSynthesis(result.content, conversation);
      if (parsed.source === "fallback") {
        const warning = `${planner.label} did not return a usable revised implementation plan. Keeping the existing plan.`;
        if (!warnings.includes(warning)) {
          warnings.push(warning);
        }
        this.emitProgress(runId, recordProgress, "done", "Final plan revision kept the existing plan.");
        conversation.metadata = {
          ...conversation.metadata,
          pendingPlanItemReview: undefined,
          warnings,
          running: false
        };
        conversation.updatedAt = new Date().toISOString();
        await this.flushAndSaveConversation(conversation);
        return { conversation, warnings };
      }

      const synthesis = this.implementationPlanSynthesis(parsed.fullPlan, parsed.debateSummary || existingDebateSummary, "arbiter");
      conversation.finalSummary = synthesis.combined;
      conversation.messages.push(this.message("summary", conversation.finalSummary));
      this.emitProgress(runId, recordProgress, "done", "Final plan revision finished.");
      conversation.metadata = {
        ...conversation.metadata,
        implementationPlanFinalMarkdown: synthesis.fullPlan,
        implementationPlanDebateSummaryMarkdown: synthesis.debateSummary,
        implementationPlanSynthesisSource: synthesis.source,
        implementationPlanRevisionCount: this.metadataNumber(conversation.metadata.implementationPlanRevisionCount) + 1,
        pendingPlanItemReview: undefined,
        warnings,
        running: false
      };
      conversation.updatedAt = new Date().toISOString();
      await this.flushAndSaveConversation(conversation);
      return { conversation, warnings };
    } catch (error) {
      const latest = (await this.storage.getConversation(request.conversationId)) ?? conversation;
      latest.metadata = {
        ...latest.metadata,
        pendingPlanItemReview: undefined,
        warnings,
        running: false
      };
      latest.updatedAt = new Date().toISOString();
      await this.flushAndSaveConversation(latest);
      throw error;
    }
  }

  private async startImplementationPlan(
    request: ReviewRequest,
    signal?: AbortSignal,
    progress?: ProgressCallback,
    resume?: PlanResumeState
  ): Promise<StartReviewResult> {
    const warnings = resume?.conversation ? this.metadataWarnings(resume.conversation) : [];
    const runId = request.runId ?? randomUUID();
    const now = new Date().toISOString();
    const arbiter = request.arbiter ?? request.participants[0];
    const participants = request.participants.filter((participant) => this.isCliParticipant(participant));
    let conversation: Conversation | undefined = resume?.conversation;
    const recordProgress: ProgressCallback = (event) => {
      void this.debugLogs.write("progress", {
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
    if (!arbiter || !this.isCliParticipant(arbiter)) {
      throw new Error("Select a local CLI planner for implementation plans.");
    }
    if (participants.length < 2) {
      throw new Error("Select at least two local CLI participants for an implementation plan.");
    }

    try {
      this.emitProgress(runId, recordProgress, "initial", "Preparing implementation-plan context.");
      this.throwIfAborted(signal);

      const answers = resume?.answers ?? [];
      if (!conversation) {
        conversation = {
          id: randomUUID(),
          title: this.titleFor(request, undefined),
          kind: request.kind,
          createdAt: now,
          updatedAt: now,
          repoPath: request.repoPath,
          messages: [
            this.message("user", request.question || "Create an implementation plan for this repository."),
            this.message("system", this.systemIntro(request, undefined, arbiter), this.asArbiterParticipant(arbiter, request.kind))
          ],
          findings: [],
          metadata: {
            runId,
            repoPath: request.repoPath,
            participantCount: participants.length,
            arbiter: { id: arbiter.id, kind: arbiter.kind, label: arbiter.label, model: arbiter.model },
            roundLimit: request.roundLimit,
            implementationPlanRequest: this.serializeReviewRequest(request),
            implementationPlanAnswers: [],
            implementationPlanDecisionGateCount: 0,
            planDecisionRequests: [],
            running: true
          }
        };
        this.queueConversationSnapshot(conversation);
      } else {
        const decisionRequests = this.mergePlanDecisionRequests(
          this.planDecisionRequestsFromMetadata(conversation),
          this.pendingDecisionsFromMetadata(conversation)
        );
        conversation.messages.push(this.message("user", this.formatDecisionAnswersForTimeline(answers)));
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
        await this.flushAndSaveConversation(conversation);
      }

      const decisionGateCount = this.metadataNumber(conversation.metadata.implementationPlanDecisionGateCount);
      const decisionFailedParticipantIds = new Set<string>();
      if (decisionGateCount < MAX_DECISION_GATES) {
        const decisionResult = await this.collectImplementationPlanDecisions(
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
            implementationPlanRequest: this.serializeReviewRequest(request),
            implementationPlanAnswers: answers,
            implementationPlanDecisionGateCount: decisionGateCount + 1,
            planDecisionRequests: this.mergePlanDecisionRequests(
              this.planDecisionRequestsFromMetadata(conversation),
              decisionResult.pendingDecisions
            ),
            pendingDecisionSelections: undefined,
            pendingDecisionResolutions: undefined,
            pendingDecisions: decisionResult.pendingDecisions,
            warnings,
            running: false
          };
          conversation.updatedAt = new Date().toISOString();
          this.emitProgress(runId, recordProgress, "decisions", "Implementation plan paused for user decisions.");
          await this.flushAndSaveConversation(conversation);
          return { conversation, warnings, pendingDecisions: decisionResult.pendingDecisions };
        }
      }

      const failedParticipantIds = new Set(decisionFailedParticipantIds);
      this.emitProgress(runId, recordProgress, "initial", "Running independent implementation plans.");
      const initialPrompt = this.buildImplementationPlanPrompt(request, answers, warnings);
      let completedInitial = 0;
      const completedInitialLabels = new Set<string>();
      const initialResults = await Promise.all(
        participants.map(async (participant) => {
          this.emitProgress(runId, recordProgress, "initial", `Running implementation plan from ${participant.label}.`, {
            participantLabel: participant.label,
            completed: completedInitial,
            total: participants.length
          });
          const result = await this.runParticipant(
            participant,
            initialPrompt,
            request,
            signal,
            this.sessionContext(conversation!, warnings, this.participantSessionKey(participant))
          );
          completedInitial += 1;
          completedInitialLabels.add(participant.label);
          this.emitProgress(runId, recordProgress, "initial", `${participant.label} ${result.ok ? "finished" : "failed"} implementation plan${this.formatDuration(result.durationMs)}.`, {
            participantLabel: participant.label,
            completed: completedInitial,
            total: participants.length
          });
          const remaining = participants.filter((item) => !completedInitialLabels.has(item.label));
          if (remaining.length > 0) {
            this.emitProgress(
              runId,
              recordProgress,
              "initial",
              `Waiting for ${this.formatParticipantLabelList(remaining.map((item) => item.label))} to finish implementation plan${remaining.length === 1 ? "" : "s"}.`,
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
      this.throwIfAborted(signal);

      for (const result of initialResults) {
        conversation.messages.push(this.message("participant", result.content, result.participant, result.ok ? "done" : "error"));
        if (!result.ok && result.error) {
          failedParticipantIds.add(result.participant.id);
          warnings.push(`${result.participant.label}: ${result.error}. Skipping this participant for the rest of the run.`);
        }
      }

      const healthyParticipants = participants.filter((participant) => !failedParticipantIds.has(participant.id));
      if (healthyParticipants.length < 2) {
        warnings.push("Fewer than two local participants completed successfully, so no implementation plan can be marked approved by both models.");
        conversation.findings = [];
        conversation.finalSummary = this.finalSummary(conversation);
        conversation.messages.push(this.message("summary", conversation.finalSummary));
        conversation.metadata = { ...conversation.metadata, pendingDecisions: undefined, warnings, running: false };
        conversation.updatedAt = new Date().toISOString();
        await this.flushAndSaveConversation(conversation);
        return { conversation, warnings };
      }

      const rawPlans = this.rawImplementationPlansFromResults(initialResults, healthyParticipants);
      conversation.metadata = {
        ...conversation.metadata,
        implementationPlanRawPlans: rawPlans
      };
      conversation.updatedAt = new Date().toISOString();
      this.queueConversationSnapshot(conversation);

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
        await this.flushAndSaveConversation(conversation);
      }
      throw error;
    }
  }

  private async processImplementationPlanRawPlans(
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
    this.emitProgress(runId, progress, "arbiter", `Planner ${arbiter.label} is extracting implementation-plan items.`);
    const arbiterPrompt = this.buildImplementationPlanExtractionPrompt(request, healthyParticipants, rawPlans, warnings);
    const arbiterResult = await this.runParticipant(
      arbiter,
      arbiterPrompt,
      request,
      signal,
      this.sessionContext(conversation, warnings, this.arbiterSessionKey(arbiter))
    );

    let canonicalPoints = arbiterResult.ok
      ? this.parseLineProtocol(arbiterResult.content, undefined, healthyParticipants)
      : [];
    if (!arbiterResult.ok) {
      warnings.push(`${arbiter.label} planner failed while extracting implementation-plan items: ${arbiterResult.error ?? "unknown error"}.`);
    }
    if (canonicalPoints.length === 0) {
      warnings.push("Planner did not return parseable canonical plan items, so no implementation-plan consensus threads were opened.");
    }

    canonicalPoints = this.selectImplementationPlanExtractionPoints(canonicalPoints, healthyParticipants, warnings);

    this.emitProgress(runId, progress, "debate", `Opening ${canonicalPoints.length} implementation-plan consensus threads.`, {
      completed: 0,
      total: canonicalPoints.length
    });

    for (let index = 0; index < canonicalPoints.length; index += 1) {
      this.throwIfAborted(signal);
      const point = canonicalPoints[index];
      const sourceItems = this.sourceItemsForRawPlans(point, rawPlans, healthyParticipants);
      const finding = this.createFinding(point, healthyParticipants, sourceItems);
      if (finding.status !== "Confirmed") {
        await this.debatePoint(
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
      this.emitProgress(runId, progress, "debate", `Finished plan item ${index + 1} of ${canonicalPoints.length}.`, {
        findingTitle: finding.title,
        completed: index + 1,
        total: canonicalPoints.length
      });
    }

    if (!conversation.findings.some((finding) => finding.status === "Confirmed")) {
      conversation.finalSummary = this.finalSummary(conversation);
      conversation.messages.push(this.message("summary", conversation.finalSummary));
      this.emitProgress(runId, progress, "done", "No implementation-plan items were approved.");
      conversation.metadata = {
        ...conversation.metadata,
        implementationPlanRequest: this.serializeReviewRequest(request),
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
      await this.flushAndSaveConversation(conversation);
      return { conversation, warnings };
    }

    const reviewableItems = this.requiredPlanItemReviewFindings(conversation);
    if (reviewableItems.length > 0) {
      conversation.finalSummary = undefined;
      conversation.metadata = {
        ...conversation.metadata,
        implementationPlanRequest: this.serializeReviewRequest(request),
        implementationPlanAnswers: answers,
        implementationPlanFinalMarkdown: undefined,
        implementationPlanDebateSummaryMarkdown: undefined,
        implementationPlanSynthesisSource: undefined,
        pendingDecisionSelections: undefined,
        pendingDecisionResolutions: undefined,
        pendingDecisions: undefined,
        pendingPlanItemReview: true,
        planItemReviews: this.planItemReviewsFromMetadata(conversation).filter((review) =>
          reviewableItems.some((finding) => finding.id === review.findingId)
        ),
        warnings,
        running: false
      };
      conversation.updatedAt = new Date().toISOString();
      this.emitProgress(runId, progress, "decisions", "Implementation plan paused for item review.", {
        completed: 0,
        total: reviewableItems.length
      });
      await this.flushAndSaveConversation(conversation);
      return { conversation, warnings };
    }

    this.emitProgress(runId, progress, "summary", "Building final approved implementation plan.");
    const synthesis = await this.synthesizeImplementationPlan(
      request,
      conversation,
      arbiter,
      warnings,
      signal,
      progress,
      runId
    );
    conversation.finalSummary = synthesis.combined;
    conversation.messages.push(this.message("summary", conversation.finalSummary));
    this.emitProgress(runId, progress, "done", "Implementation-plan consensus finished.");
    conversation.metadata = {
      ...conversation.metadata,
      implementationPlanRequest: this.serializeReviewRequest(request),
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
    await this.flushAndSaveConversation(conversation);

    return { conversation, warnings };
  }

  private async collectParticipantPoints(
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
      let points = this.parseLineProtocol(result.content, result.participant, healthyParticipants);
      if (points.length === 0) {
        const arbiterRole = request.kind === "implementation-plan" ? "Planner" : "Arbiter";
        this.emitProgress(runId, progress, "arbiter", `${arbiterRole} ${arbiter.label} is repairing ${result.participant.label}'s answer.`);
        const repair = await this.runParticipant(
          arbiter,
          this.buildRepairPrompt(request, diff, result.participant, result.content, warnings),
          request,
          signal,
          sessionContext
            ? this.sessionContext(sessionContext.conversation, sessionContext.warnings, sessionContext.arbiterSessionKey)
            : undefined
        );
        if (repair.ok) {
          points = this.parseLineProtocol(repair.content, result.participant, healthyParticipants);
        } else {
          warnings.push(`${arbiter.label} could not repair ${result.participant.label}'s answer: ${repair.error ?? "unknown error"}.`);
        }
      }
      if (points.length === 0) {
        warnings.push(`${result.participant.label} produced no parseable points.`);
      }
      this.emitProgress(runId, progress, "extract", `Extracted ${points.length} point${points.length === 1 ? "" : "s"} from ${result.participant.label}.`, {
        participantLabel: result.participant.label
      });
      pointsByParticipant.set(result.participant.id, points);
    }

    return pointsByParticipant;
  }

  private rawImplementationPlansFromResults(initialResults: ParticipantRunResult[], healthyParticipants: ParticipantConfig[]): RawImplementationPlan[] {
    const healthyIds = new Set(healthyParticipants.map((participant) => participant.id));
    const createdAt = new Date().toISOString();
    return initialResults
      .filter((result) => result.ok && healthyIds.has(result.participant.id) && result.content.trim())
      .map((result) => ({
        participantId: result.participant.id,
        participantLabel: result.participant.label,
        content: result.content.trim(),
        createdAt
      }));
  }

  private async collectImplementationPlanDecisions(
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
      this.throwIfAborted(signal);
      this.emitProgress(runId, progress, "decisions", `Checking blocking decisions with ${participant.label}.`, {
        participantLabel: participant.label
      });
      const result = await this.runParticipant(
        participant,
        this.buildDecisionDiscoveryPrompt(request, participant, answers),
        request,
        signal,
        this.sessionContext(conversation, warnings, this.participantSessionKey(participant))
      );
      if (!result.ok) {
        failedParticipantIds.add(participant.id);
        warnings.push(`${participant.label}: ${result.error ?? "failed"} during decision discovery.`);
        continue;
      }
      const decisions = this.parseDecisionProtocol(result.content, participant, participants);
      decisionsByParticipant.set(participant.id, decisions);
      this.emitProgress(runId, progress, "decisions", `${participant.label} found ${decisions.length} blocking decision${decisions.length === 1 ? "" : "s"}.`, {
        participantLabel: participant.label
      });
    }

    const allDecisions = Array.from(decisionsByParticipant.values()).flat();
    if (allDecisions.length === 0) {
      return { pendingDecisions: [] };
    }

    const pendingDecisions = allDecisions
      .filter((decision) => !this.isAnsweredDecision(decision, answers))
      .slice(0, MAX_DECISIONS);
    return { pendingDecisions };
  }

  private async synthesizeImplementationPlan(
    request: ReviewRequest,
    conversation: Conversation,
    arbiter: ParticipantConfig,
    warnings: string[],
    signal: AbortSignal | undefined,
    progress: ProgressCallback | undefined,
    runId: string,
    options: { fallbackWarning?: boolean } = {}
  ): Promise<ImplementationPlanSynthesis> {
    this.throwIfAborted(signal);
    this.emitProgress(runId, progress, "summary", `Planner ${arbiter.label} is synthesizing the final plan.`);
    const result = await this.runParticipant(
      arbiter,
      this.buildImplementationPlanSynthesisPrompt(request, conversation, warnings),
      request,
      signal,
      this.sessionContext(conversation, warnings, this.arbiterSessionKey(arbiter))
    );
    if (!result.ok) {
      if (options.fallbackWarning !== false) {
        warnings.push(`${arbiter.label} could not synthesize the final implementation plan: ${result.error ?? "unknown error"}. Used local summary fallback.`);
      }
      return this.fallbackImplementationPlanSynthesis(conversation);
    }

    const synthesis = this.parseImplementationPlanSynthesis(result.content, conversation);
    if (synthesis.source === "fallback" && options.fallbackWarning !== false) {
      warnings.push("Planner synthesis did not include a usable final plan; used local summary fallback.");
    }
    return synthesis;
  }

  private async autoAnswerPendingDecisions(
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
    let mergedAnswers = this.mergeDecisionAnswers([], answers);
    const remaining: PlanDecisionRequest[] = [];
    const replies = this.planDecisionRepliesFromMetadata(conversation);

    for (const decision of pendingDecisions) {
      this.throwIfAborted(signal);
      if (this.isAnsweredDecision(decision, mergedAnswers)) {
        continue;
      }
      if (mergedAnswers.length === 0) {
        remaining.push(decision);
        continue;
      }

      this.emitProgress(runId, progress, "decisions", `Checking whether previous answers cover "${decision.title}".`, {
        findingTitle: decision.title
      });
      const result = await this.runParticipant(
        arbiter,
        this.buildAutomaticDecisionAnswerPrompt(decision, mergedAnswers),
        request,
        signal,
        this.sessionContext(conversation, warnings, this.arbiterSessionKey(arbiter))
      );
      if (!result.ok) {
        warnings.push(`${arbiter.label} could not check automatic answer for "${decision.title}": ${result.error ?? "unknown error"}.`);
        remaining.push(decision);
        continue;
      }

      const parsed = this.parseAutomaticDecisionAnswer(result.content);
      const selectedOptionId = parsed.selectedOptionId && decision.options.some((option) => option.id === parsed.selectedOptionId)
        ? parsed.selectedOptionId
        : undefined;
      if (!parsed.applies || !parsed.answer.trim()) {
        remaining.push(decision);
        continue;
      }

      const automaticAnswer: PlanDecisionAnswer = {
        decisionId: decision.id,
        decisionKey: this.decisionKey(decision),
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
      mergedAnswers = this.mergeDecisionAnswers(mergedAnswers, [automaticAnswer]);
      replies.push(
        this.planDecisionReply(
          decision.id,
          "participant",
          [
            parsed.sourceDecisionId ? `Automatic answer based on previous decision ${parsed.sourceDecisionId}.` : "Automatic answer based on previous decision context.",
            parsed.answer,
            parsed.reason ? `Reason: ${parsed.reason}` : ""
          ].filter(Boolean).join("\n\n"),
          this.asArbiterParticipant(arbiter, request.kind),
          "done",
          { answerSource: "automatic", sourceDecisionId: parsed.sourceDecisionId }
        )
      );
      conversation.metadata = {
        ...conversation.metadata,
        implementationPlanAnswers: mergedAnswers,
        planDecisionRequests: this.mergePlanDecisionRequests(this.planDecisionRequestsFromMetadata(conversation), pendingDecisions),
        planDecisionReplies: replies,
        pendingDecisionSelections: undefined,
        pendingDecisionResolutions: undefined,
        warnings,
        running: true
      };
      conversation.updatedAt = new Date().toISOString();
      this.queueConversationSnapshot(conversation);
    }

    return { answers: mergedAnswers, pendingDecisions: remaining };
  }

  private async resolveDiff(request: ReviewRequest, warnings: string[]): Promise<GitDiffResult | undefined> {
    if (request.kind !== "code-review") {
      return undefined;
    }

    if (!request.diffMode) {
      warnings.push("No diff mode was selected.");
      return undefined;
    }

    const diff = await this.git.getDiff({
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

  private async runParticipant(
    participant: ParticipantConfig,
    prompt: string,
    request: ReviewRequest,
    signal?: AbortSignal,
    sessionContext?: CliSessionContext
  ): Promise<ParticipantRunResult> {
    this.throwIfAborted(signal);
    const interactionId = randomUUID();
    const startedAt = new Date().toISOString();
    const conversationId = sessionContext?.conversation.id;
    const sessionId = sessionContext ? this.cliAgentSessionId(sessionContext.conversation, sessionContext.sessionKey) : undefined;
    await this.debugLogs.write("agent.input", {
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
      result = await this.cliRunner.run(
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
        this.upsertCliAgentSession(sessionContext.conversation, sessionContext.sessionKey, result.participant, result.sessionId);
      }
      if (sessionContext && result.ok && !result.sessionId && !sessionId) {
        sessionContext.warnings.push(`${participant.label}: CLI session id was not reported, so later rounds may need to rebuild context from the saved thread transcript.`);
      }
      if (sessionContext && result.sessionRestarted) {
        sessionContext.warnings.push(`${participant.label}: previous CLI session was unavailable, so a new session was started from saved conversation context.`);
      }
    } else {
      result = await this.providerRunner.run(participant, prompt, signal);
    }
    await this.debugLogs.write("agent.output", {
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

  private async debatePoint(
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
      warnings.push(`Point "${finding.title}" was checked with ${MAX_VERIFIERS_PER_POINT} missing participants to keep the run bounded.`);
    }

    for (const participant of missingParticipants) {
      this.throwIfAborted(signal);
      this.emitProgress(runId, progress, "debate", `Asking ${participant.label} about point ${pointIndex + 1} of ${totalPoints}.`, {
        participantLabel: participant.label,
        findingTitle: finding.title,
        completed: pointIndex,
        total: totalPoints
      });
      const result = await this.runParticipant(
        participant,
        this.buildVerificationPrompt(request, finding, diff, warnings),
        request,
        signal,
        sessionContext
          ? this.sessionContext(sessionContext.conversation, sessionContext.warnings, this.participantSessionKey(participant))
          : undefined
      );
      if (!result.ok) {
        failedParticipantIds.add(participant.id);
        warnings.push(`${participant.label}: ${result.error ?? "failed"}. Skipping this participant for the rest of the run.`);
      }
      const parsed = result.ok ? this.parseVerification(result.content) : { stance: "unclear" as const, reason: result.content };
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

    finding.status = this.statusFor(finding, request.participants.filter((participant) => !failedParticipantIds.has(participant.id)));

    const dissentingRound = finding.rounds.find((round) => round.roundIndex === 1 && round.stance !== "confirmed");
    if (request.roundLimit <= 1 || !dissentingRound) {
      return;
    }

    const source = request.participants.find((participant) => participant.id === finding.sourceParticipantId && !failedParticipantIds.has(participant.id));
    if (!source) {
      return;
    }

    this.emitProgress(runId, progress, "debate", `Asking ${source.label} to evaluate the counterargument.`);
    const sourceResult = await this.runParticipant(
      source,
      this.buildSourceResponsePrompt(request, finding, dissentingRound, diff, warnings),
      request,
      signal,
      sessionContext ? this.sessionContext(sessionContext.conversation, sessionContext.warnings, this.participantSessionKey(source)) : undefined
    );
    if (!sourceResult.ok) {
      failedParticipantIds.add(source.id);
      warnings.push(`${source.label}: ${sourceResult.error ?? "failed"}. Skipping this participant for the rest of the run.`);
      return;
    }

    const sourceDecision = this.parseSourceDecision(sourceResult.content);
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

    this.emitProgress(runId, progress, "debate", `Asking ${finalResolver.label} for final resolution.`);
    const finalResult = await this.runParticipant(
      finalResolver,
      this.buildFinalResolutionPrompt(request, finding, sourceDecision.reason, diff, warnings),
      request,
      signal,
      sessionContext
        ? this.sessionContext(sessionContext.conversation, sessionContext.warnings, this.participantSessionKey(finalResolver))
        : undefined
    );
    const parsedFinal = finalResult.ok ? this.parseVerification(finalResult.content) : { stance: "unclear" as const, reason: finalResult.content };
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

  private buildDecisionDiscoveryPrompt(
    request: ReviewRequest,
    participant: ParticipantConfig,
    answers: PlanDecisionAnswer[]
  ): string {
    return [
      "You are one independent participant in an implementation-plan workflow.",
      "You are in plan mode. Inspect the repository read-only as needed, but do not edit files, run mutating commands, or ask interactive terminal questions.",
      "Before producing a plan, identify only blocking user decisions that materially change architecture, data model, scope, rollout, or compatibility.",
      "If no blocking decision is needed, return exactly: NO_DECISIONS",
      "If decisions are needed, return only compact decision blocks. Do not add prose, JSON, Markdown, bullets, or text outside the blocks.",
      "Use at most 3 decisions.",
      "Format:",
      "D1|T:short decision title",
      "Q:question the user must answer",
      "I:why this blocks the implementation plan",
      "O1:recommended option text",
      "O2:alternative option text",
      "R:O1",
      "Options must be mutually exclusive. Put the recommended option in R.",
      `Participant: ${participant.id} (${participant.label})`,
      answers.length ? `Existing decision-thread context:\n${this.formatDecisionAnswers(answers)}` : "Existing decision-thread context: none",
      `Repository: ${request.repoPath}`,
      request.question ? `User request:\n${request.question}` : "User request:\nCreate an implementation plan."
    ].join("\n\n");
  }

  private buildAutomaticDecisionAnswerPrompt(decision: PlanDecisionRequest, answers: PlanDecisionAnswer[]): string {
    return [
      "You are the planner for implementation-plan decision threads.",
      "Decide whether the user's previous answers fully answer this separate agent decision request.",
      "Do not merge or rewrite the decision. Return YES only if the previous answer is enough for the agent to proceed without asking the user again.",
      "Return only this protocol:",
      "AUTO|V:YES|O:O1|SRC:decision-id",
      "A:short answer to apply to this target decision",
      "E:why the previous answer fully covers this target",
      "Or return:",
      "AUTO|V:NO",
      "E:why the target still needs direct user input",
      `Target decision:\nD|T:${decision.title}\nID:${decision.id}\nQ:${decision.question}\nI:${decision.impact}\n${decision.options.map((option) => `${option.id}:${option.label}`).join("\n")}`,
      `Previous answers:\n${this.formatDecisionAnswersForAutomaticReuse(answers)}`
    ].join("\n\n");
  }

  private buildImplementationPlanPrompt(request: ReviewRequest, answers: PlanDecisionAnswer[], warnings: string[]): string {
    return [
      "You are one independent participant in an implementation-plan consensus workflow.",
      "You are in plan mode. Inspect the repository read-only as needed. Do not edit files, run mutating commands, or ask interactive questions.",
      "Produce an engineer-ready implementation plan for the user's requested feature, bug, or error log.",
      "Return the plan as natural Markdown in whatever structure best fits the task. Do not use a required template or machine protocol.",
      "Make it decision-complete for another engineer: include the intended approach, important interfaces/data flow, edge cases, and focused verification.",
      "Use repo-specific file names, modules, commands, and constraints where inspection supports them.",
      "Keep the plan concise enough to be scanned in the timeline, but do not omit important implementation decisions.",
      "If an unresolved blocker remains, state it clearly in the plan and explain what cannot be decided yet.",
      `Repository: ${request.repoPath}`,
      answers.length ? `User decision-thread context:\n${this.formatDecisionAnswers(answers)}` : "User decision-thread context: none",
      request.question ? `User request:\n${request.question}` : "User request:\nCreate an implementation plan.",
      this.limitText("Use repo inspection for file names and interfaces. Keep output concise.", warnings)
    ].join("\n\n");
  }

  private buildDecisionClarificationPrompt(
    request: ReviewRequest,
    decision: PlanDecisionRequest,
    question: string,
    replies: PlanDecisionReply[]
  ): string {
    return [
      "You are replying inside an implementation-plan decision thread.",
      "You are in plan mode. Inspect the repository read-only if needed. Do not edit files, run mutating commands, or ask interactive terminal questions.",
      "Reply to the user's latest message directly and concisely. Do not choose for the user unless the answer is technically forced.",
      `Decision: ${decision.title}`,
      `Original question: ${decision.question}`,
      `Impact: ${decision.impact}`,
      `Options:\n${decision.options.map((option) => `${option.id}: ${option.label}`).join("\n")}`,
      `Thread so far:\n${this.formatDecisionRepliesForPrompt(replies.filter((reply) => reply.decisionId === decision.id))}`,
      `Latest user message:\n${question}`,
      `Repository: ${request.repoPath}`,
      request.question ? `Original user request:\n${request.question}` : ""
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private buildInitialPrompt(request: ReviewRequest, diff: GitDiffResult | undefined, warnings: string[]): string {
    const context = diff
      ? this.limitText(
          [
            `Diff title: ${diff.title}`,
            diff.repoPath ? `Repository: ${diff.repoPath}` : "",
            "Diff:",
            diff.diff || "(empty diff)"
          ]
            .filter(Boolean)
            .join("\n"),
          warnings
        )
      : "";

    return [
      "You are one independent participant in a consensus workflow.",
      "Return only compact point blocks. Do not add prose before or after.",
      "IMPORTANT: The output format is mandatory. Do not return JSON, Markdown, bullets, explanations, or any text outside the blocks.",
      "Points must be concise, practical, and directly useful to the user. Avoid broad background, generic advice, and over-explaining.",
      "Return all concrete, non-duplicate, actionable points. Do not create source/citation-only points.",
      "Format:",
      "P1|S:High|T:short title",
      "C:claim or recommendation",
      "E:evidence/reasoning",
      "A:action or fix guidance",
      "Severity S must be one of Critical, High, Medium, Low, Info.",
      request.kind === "code-review"
        ? "For code review, each point must be a concrete bug, risk, regression, or fix recommendation."
        : "For general questions, each point must be an actionable recommendation, caution, or directly useful conclusion.",
      request.question ? `User request:\n${request.question}` : "User request:\nReview the selected changes.",
      context
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private buildRepairPrompt(
    request: ReviewRequest,
    diff: GitDiffResult | undefined,
    participant: ParticipantConfig,
    content: string,
    warnings: string[]
  ): string {
    if (request.kind === "implementation-plan") {
      return [
        "Convert this participant answer into the compact implementation-plan item protocol.",
        "Return only plan-item blocks. Keep only concrete implementation steps, risks, unresolved blockers, and test guidance.",
        "IMPORTANT: The output format is mandatory. Do not return JSON, Markdown, bullets, explanations, or any text outside the blocks.",
        "Format:",
        "P1|S:Info|T:short implementation step title",
        "C:goal or decision for this step",
        "E:repo evidence, likely files/modules, dependencies, or reasoning",
        "A:concrete implementation guidance plus tests/verification",
        `Participant: ${participant.id} (${participant.label})`,
        request.question ? `User request:\n${request.question}` : "",
        `Repository: ${request.repoPath}`,
        `Raw answer:\n${content}`
      ]
        .filter(Boolean)
        .join("\n\n");
    }

    return [
      "Convert this participant answer into the compact point protocol.",
      "Return only point blocks. Keep only actionable user-facing points. Remove source/citation-only and meta points.",
      "IMPORTANT: The output format is mandatory. Do not return JSON, Markdown, bullets, explanations, or any text outside the blocks.",
      "Points must be concise, practical, and directly useful to the user. Preserve only concrete claims and actions.",
      "Format:",
      "P1|S:Info|T:short title",
      "C:claim or recommendation",
      "E:evidence/reasoning",
      "A:action or fix guidance",
      `Participant: ${participant.id} (${participant.label})`,
      request.question ? `User request:\n${request.question}` : "",
      diff ? this.limitText(`Diff:\n${diff.diff || "(empty diff)"}`, warnings) : "",
      `Raw answer:\n${content}`
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private buildImplementationPlanExtractionPrompt(
    request: ReviewRequest,
    participants: ParticipantConfig[],
    rawPlans: RawImplementationPlan[],
    warnings: string[]
  ): string {
    return [
      "You are the private planner for implementation-plan consensus extraction.",
      "Compare the independent participant plans below and extract only the canonical items needed for confirmation or debate.",
      "Classify work by source coverage before emitting items: common items appear in every healthy participant plan, needs-confirmation items appear in only a subset, and conflict items cover the same area with incompatible recommendations.",
      "Do not write the final plan. Do not add new facts beyond the participant plans and user request.",
      "Merge equivalent work into one item. Preserve practical needs-confirmation items and each incompatible conflict alternative so other participants can evaluate them.",
      "Use participant ids exactly in SRC. Put all participant ids in SRC only when equivalent work appears in every healthy participant plan. Put only actual source participant ids in SRC for subset or conflict items.",
      "Return only this internal protocol. No Markdown, prose, JSON, or text outside the blocks:",
      "K1|S:Info|T:short implementation item title|SRC:codex-cli,claude-code",
      "C:canonical goal or decision for this item",
      "E:repo evidence, source-plan evidence, likely files/modules, dependencies, or reasoning",
      "A:concrete implementation guidance plus tests/verification",
      "Severity S should usually be Info; use Medium or High only for risky migration, compatibility, or data-loss concerns.",
      `Participants: ${participants.map((participant) => `${participant.id}=${participant.label}`).join(", ")}`,
      `Repository: ${request.repoPath}`,
      request.question ? `User request:\n${request.question}` : "User request:\nCreate an implementation plan.",
      this.limitText(`Participant plans:\n${this.formatRawImplementationPlansForPrompt(rawPlans)}`, warnings)
    ].join("\n\n");
  }

  private buildArbiterPrompt(
    request: ReviewRequest,
    diff: GitDiffResult | undefined,
    participants: ParticipantConfig[],
    pointsByParticipant: Map<string, LinePoint[]>,
    warnings: string[]
  ): string {
    return [
      "You are the arbiter. Merge participant point lists into canonical consensus points.",
      "Do not add new facts. Merge duplicates. Remove source/citation-only and meta points.",
      "Use participant ids exactly in SRC. A point can have multiple SRC ids if equivalent points appear in multiple answers.",
      "IMPORTANT: The output format is mandatory. If you return prose, JSON, Markdown, bullets, or any text outside the blocks, the result will be rejected.",
      "Canonical points must be concise, practical, and directly useful to the user. Prefer fewer, sharper points over broad or repetitive ones.",
      "Return only canonical blocks:",
      "K1|S:High|T:short title|SRC:codex-cli,claude-code",
      "C:canonical claim/recommendation",
      "E:shared evidence/reasoning",
      "A:user-facing action or fix guidance",
      `Mode: ${request.kind}`,
      `Participants: ${participants.map((participant) => `${participant.id}=${participant.label}`).join(", ")}`,
      request.question ? `User request:\n${request.question}` : "",
      diff ? this.limitText(`Diff summary/source:\n${diff.title}\n${diff.diff || "(empty diff)"}`, warnings) : "",
      `Participant points:\n${this.formatParticipantPoints(pointsByParticipant)}`
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private buildImplementationPlanSynthesisPrompt(request: ReviewRequest, conversation: Conversation, warnings: string[]): string {
    const answers = this.implementationPlanAnswersFromMetadata(conversation);
    return [
      "You are the planner for the final implementation-plan synthesis.",
      "Use the consensus item threads below to produce one engineer-ready implementation plan.",
      "Return only the final plan as natural Markdown. Do not use a required template and do not include a debate summary.",
      "The plan must include only confirmed/common items and confirmed-after-debate items. Do not include rejected or unresolved items as implementation steps.",
      "Apply user item-review comments as final guidance for wording, caveats, ordering, and refinements.",
      "Keep the plan decision-complete and concise enough to hand to another engineer.",
      `Repository: ${request.repoPath}`,
      request.question ? `User request:\n${request.question}` : "User request:\nCreate an implementation plan.",
      answers.length ? `User decision-thread context:\n${this.formatDecisionAnswers(answers)}` : "User decision-thread context: none",
      `User item review context:\n${this.formatPlanItemReviewsForPrompt(conversation)}`,
      this.limitText(`Consensus item threads:\n${this.formatImplementationPlanThreadsForPrompt(conversation.findings)}`, warnings)
    ].join("\n\n");
  }

  private buildImplementationPlanRevisionPrompt(
    request: ReviewRequest,
    conversation: Conversation,
    previousPlan: string,
    debateSummary: string,
    instruction: string,
    warnings: string[]
  ): string {
    const answers = this.implementationPlanAnswersFromMetadata(conversation);
    return [
      "You are the planner revising an existing final implementation plan.",
      "Use the user's correction plus the saved consensus context to produce a complete replacement final plan.",
      "Return only the revised final plan as natural Markdown. Do not include a debate summary, acknowledgements, or commentary outside the plan.",
      "Keep the plan compatible with confirmed consensus items and explicit user decisions. If the correction conflicts with saved consensus, include the feasible correction and state the remaining blocker in the plan.",
      "Do not edit files or run mutating commands.",
      `Repository: ${request.repoPath}`,
      request.question ? `Original user request:\n${request.question}` : "Original user request:\nCreate an implementation plan.",
      `User correction:\n${instruction}`,
      answers.length ? `User decision-thread context:\n${this.formatDecisionAnswers(answers)}` : "User decision-thread context: none",
      `User item review context:\n${this.formatPlanItemReviewsForPrompt(conversation)}`,
      debateSummary ? `Existing debate summary for context:\n${debateSummary}` : "Existing debate summary for context: none",
      this.limitText(`Previous final plan:\n${previousPlan}`, warnings),
      this.limitText(`Consensus item threads:\n${this.formatImplementationPlanThreadsForPrompt(conversation.findings)}`, warnings)
    ].join("\n\n");
  }

  private buildVerificationPrompt(
    request: ReviewRequest,
    finding: Finding,
    diff: GitDiffResult | undefined,
    warnings: string[]
  ): string {
    if (request.kind === "implementation-plan") {
      return [
        "You did not clearly include this implementation-plan item in your initial plan.",
        "Evaluate whether it should be included in the final approved plan. Return only:",
        "IMPORTANT: The output format is mandatory. Do not return prose, JSON, Markdown, or bullets.",
        "Be skeptical. Agree only if the item is practical, repo-appropriate, actionable, and compatible with the user decision-thread context.",
        "R|V:AGREE|S:Info",
        "E:short reason",
        "Use V:AGREE if the item should stand, V:REJECT if it is wrong/unhelpful, V:UNCLEAR if evidence is insufficient or a blocker remains.",
        this.formatFindingForPrompt(finding),
        request.question ? `User request:\n${request.question}` : "",
        `Repository: ${request.repoPath}`
      ]
        .filter(Boolean)
        .join("\n\n");
    }

    return [
      "You missed or did not clearly include this point in your initial answer.",
      "Evaluate whether you agree with the point. Return only:",
      "IMPORTANT: The output format is mandatory. Do not return prose, JSON, Markdown, or bullets.",
      "Be skeptical. Do not agree just because another model proposed it; reject or mark unclear if the point is unsupported, overstated, impractical, or not actionable.",
      "R|V:AGREE|S:Info",
      "E:short reason",
      "Use V:AGREE if the point should stand, V:REJECT if it is wrong/unhelpful, V:UNCLEAR if evidence is insufficient.",
      this.formatFindingForPrompt(finding),
      request.question ? `User request:\n${request.question}` : "",
      diff ? this.limitText(`Diff:\n${diff.diff || "(empty diff)"}`, warnings) : ""
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private buildSourceResponsePrompt(
    request: ReviewRequest,
    finding: Finding,
    dissentingRound: DebateRound,
    diff: GitDiffResult | undefined,
    warnings: string[]
  ): string {
    if (request.kind === "implementation-plan") {
      return [
        "You were a source for this implementation-plan item. Another participant challenged it.",
        "Return only:",
        "IMPORTANT: The output format is mandatory. Do not return prose, JSON, Markdown, or bullets.",
        "Be skeptical of your original item. Accept the challenge if the item is unsupported, impractical, wrong for this repo, or blocked by unresolved decisions.",
        "D|V:ACCEPT",
        "E:short reason",
        "Use V:ACCEPT if you accept/withdraw/narrow due to the challenge. Use V:REJECT if the original item should still stand. Use V:UNCLEAR if unresolved.",
        this.formatFindingForPrompt(finding),
        `Challenge from ${dissentingRound.participantLabel}: ${dissentingRound.content}`,
        request.question ? `User request:\n${request.question}` : "",
        `Repository: ${request.repoPath}`
      ]
        .filter(Boolean)
        .join("\n\n");
    }

    return [
      "You were a source for this point. Another participant challenged it.",
      "Return only:",
      "IMPORTANT: The output format is mandatory. Do not return prose, JSON, Markdown, or bullets.",
      "Be skeptical of your own original point. Accept the challenge if the point is unsupported, overstated, impractical, or not actionable.",
      "D|V:ACCEPT",
      "E:short reason",
      "Use V:ACCEPT if you accept/withdraw/narrow due to the challenge. Use V:REJECT if the original point should still stand. Use V:UNCLEAR if unresolved.",
      this.formatFindingForPrompt(finding),
      `Challenge from ${dissentingRound.participantLabel}: ${dissentingRound.content}`,
      request.question ? `User request:\n${request.question}` : "",
      diff ? this.limitText(`Diff:\n${diff.diff || "(empty diff)"}`, warnings) : ""
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private buildFinalResolutionPrompt(
    request: ReviewRequest,
    finding: Finding,
    sourceReason: string,
    diff: GitDiffResult | undefined,
    warnings: string[]
  ): string {
    if (request.kind === "implementation-plan") {
      return [
        "Resolve this implementation-plan thread after reading the original item and source rebuttal.",
        "Return only:",
        "IMPORTANT: The output format is mandatory. Do not return prose, JSON, Markdown, or bullets.",
        "Keep the item only if it remains well-supported, practical, actionable, and compatible with the user decision-thread context.",
        "F|V:AGREE|S:Info",
        "E:short final reason",
        "Use V:AGREE if the original item should stand; V:REJECT if it should be rejected; V:UNCLEAR if still unresolved.",
        this.formatFindingForPrompt(finding),
        `Source rebuttal: ${sourceReason}`,
        request.question ? `User request:\n${request.question}` : "",
        `Repository: ${request.repoPath}`
      ]
        .filter(Boolean)
        .join("\n\n");
    }

    return [
      "Resolve this thread after reading the original point and source rebuttal.",
      "Return only:",
      "IMPORTANT: The output format is mandatory. Do not return prose, JSON, Markdown, or bullets.",
      "Be skeptical. Keep the point only if it remains well-supported, practical, and actionable after the rebuttal.",
      "F|V:AGREE|S:Info",
      "E:short final reason",
      "Use V:AGREE if the original point should stand; V:REJECT if it should be rejected; V:UNCLEAR if still unresolved.",
      this.formatFindingForPrompt(finding),
      `Source rebuttal: ${sourceReason}`,
      request.question ? `User request:\n${request.question}` : "",
      diff ? this.limitText(`Diff:\n${diff.diff || "(empty diff)"}`, warnings) : ""
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private systemIntro(request: ReviewRequest, diff: GitDiffResult | undefined, arbiter: ParticipantConfig): string {
    const participantNames = request.participants.map((participant) => participant.label).join(", ");
    const arbiterRole = request.kind === "implementation-plan" ? "Planner" : "Arbiter";
    return [
      `Participants: ${participantNames || "none"}.`,
      `${arbiterRole}: ${arbiter.label}.`,
      `Round limit per point: ${request.roundLimit}.`,
      request.kind === "implementation-plan"
        ? `Implementation-plan repository: ${request.repoPath}.`
        : diff
          ? `Review source: ${diff.title}.`
          : "Free-form validation conversation."
    ].join("\n");
  }

  private parseLineProtocol(content: string, participant: ParticipantConfig | undefined, knownParticipants: ParticipantConfig[]): LinePoint[] {
    const points: LinePoint[] = [];
    let current: Partial<LinePoint> | undefined;
    let currentField: "claim" | "evidence" | "action" | undefined;

    const push = () => {
      if (!current) {
        return;
      }
      const normalized = this.normalizeLinePoint(current, participant, knownParticipants);
      if (normalized && !this.isMetaPoint(normalized)) {
        points.push(normalized);
      }
    };

    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      const header = line.match(/^[PK]\d+\|/i) ? line : undefined;
      if (header) {
        push();
        current = this.parsePointHeader(header, participant, knownParticipants);
        currentField = undefined;
        continue;
      }
      if (!current) {
        continue;
      }
      const field = line.match(/^(C|E|A|T|S|SRC):\s*(.*)$/i);
      if (field) {
        const key = field[1].toUpperCase();
        const value = field[2].trim();
        if (key === "C") {
          current.claim = value;
          currentField = "claim";
        } else if (key === "E") {
          current.evidence = value;
          currentField = "evidence";
        } else if (key === "A") {
          current.action = value;
          currentField = "action";
        } else if (key === "T") {
          current.title = value;
          currentField = undefined;
        } else if (key === "S") {
          current.severity = this.asSeverity(value) ?? current.severity;
          currentField = undefined;
        } else if (key === "SRC") {
          current.sourceParticipantIds = this.resolveParticipantIds(value, knownParticipants);
          currentField = undefined;
        }
      } else if (currentField) {
        current[currentField] = [current[currentField], line].filter(Boolean).join(" ");
      }
    }
    push();
    return points;
  }

  private parseDecisionProtocol(content: string, participant: ParticipantConfig | undefined, knownParticipants: ParticipantConfig[]): PlanDecisionRequest[] {
    if (/^\s*NO_DECISIONS\s*$/i.test(content.trim())) {
      return [];
    }

    const decisions: PlanDecisionRequest[] = [];
    let current: Partial<PlanDecisionRequest> & { options?: PlanDecisionOption[] } | undefined;
    let currentField: "question" | "impact" | "option" | undefined;
    let currentOptionId: string | undefined;

    const push = () => {
      if (!current) {
        return;
      }
      const normalized = this.normalizePlanDecision(current, participant, knownParticipants);
      if (normalized) {
        decisions.push(normalized);
      }
    };

    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      const header = line.match(/^D\d+\|/i) ? line : undefined;
      if (header) {
        push();
        current = this.parseDecisionHeader(header, participant, knownParticipants);
        currentField = undefined;
        currentOptionId = undefined;
        continue;
      }
      if (!current) {
        continue;
      }
      const option = line.match(/^O(\d+):\s*(.*)$/i);
      if (option) {
        const id = `O${option[1]}`;
        current.options = [...(current.options ?? []), { id, label: option[2].trim() }];
        currentField = "option";
        currentOptionId = id;
        continue;
      }
      const field = line.match(/^(Q|I|R|T|SRC):\s*(.*)$/i);
      if (field) {
        const key = field[1].toUpperCase();
        const value = field[2].trim();
        if (key === "Q") {
          current.question = value;
          currentField = "question";
          currentOptionId = undefined;
        } else if (key === "I") {
          current.impact = value;
          currentField = "impact";
          currentOptionId = undefined;
        } else if (key === "R") {
          current.recommendedOptionId = value.toUpperCase();
          currentField = undefined;
          currentOptionId = undefined;
        } else if (key === "T") {
          current.title = value;
          currentField = undefined;
          currentOptionId = undefined;
        } else if (key === "SRC") {
          current.sourceParticipantIds = this.resolveParticipantIds(value, knownParticipants);
          currentField = undefined;
          currentOptionId = undefined;
        }
      } else if (currentField === "question") {
        current.question = [current.question, line].filter(Boolean).join(" ");
      } else if (currentField === "impact") {
        current.impact = [current.impact, line].filter(Boolean).join(" ");
      } else if (currentField === "option" && currentOptionId) {
        current.options = (current.options ?? []).map((item) =>
          item.id === currentOptionId ? { ...item, label: [item.label, line].filter(Boolean).join(" ") } : item
        );
      }
    }
    push();
    return decisions;
  }

  private parsePointHeader(header: string, participant: ParticipantConfig | undefined, knownParticipants: ParticipantConfig[]): Partial<LinePoint> {
    const [prefix, ...parts] = header.split("|");
    const point: Partial<LinePoint> = {
      id: prefix.trim(),
      sourceParticipantIds: participant ? [participant.id] : []
    };
    for (const part of parts) {
      const [rawKey, ...rawValue] = part.split(":");
      const key = rawKey.trim().toUpperCase();
      const value = rawValue.join(":").trim();
      if (key === "S") {
        point.severity = this.asSeverity(value);
      } else if (key === "T") {
        point.title = value;
      } else if (key === "SRC") {
        point.sourceParticipantIds = this.resolveParticipantIds(value, knownParticipants);
      }
    }
    return point;
  }

  private parseDecisionHeader(
    header: string,
    participant: ParticipantConfig | undefined,
    knownParticipants: ParticipantConfig[]
  ): Partial<PlanDecisionRequest> & { options?: PlanDecisionOption[] } {
    const [prefix, ...parts] = header.split("|");
    const decision: Partial<PlanDecisionRequest> & { options?: PlanDecisionOption[] } = {
      id: prefix.trim(),
      sourceParticipantIds: participant ? [participant.id] : [],
      options: []
    };
    for (const part of parts) {
      const [rawKey, ...rawValue] = part.split(":");
      const key = rawKey.trim().toUpperCase();
      const value = rawValue.join(":").trim();
      if (key === "T") {
        decision.title = value;
      } else if (key === "SRC") {
        decision.sourceParticipantIds = this.resolveParticipantIds(value, knownParticipants);
      }
    }
    return decision;
  }

  private normalizeLinePoint(point: Partial<LinePoint>, participant: ParticipantConfig | undefined, knownParticipants: ParticipantConfig[]): LinePoint | undefined {
    const sourceParticipantIds = point.sourceParticipantIds?.length
      ? Array.from(new Set(point.sourceParticipantIds))
      : participant
        ? [participant.id]
        : [];
    const claim = (point.claim ?? "").trim();
    const action = (point.action ?? "").trim();
    const title = (point.title || claim || action).trim().slice(0, 160);
    if (!title || (!claim && !action)) {
      return undefined;
    }
    return {
      id: point.id || `P${randomUUID().slice(0, 8)}`,
      title,
      claim,
      evidence: (point.evidence ?? "").trim(),
      action,
      severity: point.severity ?? (participant ? this.severityFromText(`${title} ${claim} ${action}`) : "Info"),
      sourceParticipantIds: sourceParticipantIds.filter((id) => knownParticipants.some((known) => known.id === id))
    };
  }

  private normalizePlanDecision(
    decision: Partial<PlanDecisionRequest> & { options?: PlanDecisionOption[] },
    participant: ParticipantConfig | undefined,
    knownParticipants: ParticipantConfig[]
  ): PlanDecisionRequest | undefined {
    const question = (decision.question ?? "").trim();
    const title = (decision.title || question).trim().slice(0, 120);
    const options = (decision.options ?? []).map((option) => ({ ...option, label: option.label.trim() })).filter((option) => option.label);
    if (!question || options.length < 2) {
      return undefined;
    }
    const sourceParticipantIds = (decision.sourceParticipantIds?.length ? decision.sourceParticipantIds : participant ? [participant.id] : [])
      .filter((id) => knownParticipants.some((known) => known.id === id));
    const sourceParticipantLabels = sourceParticipantIds.map((id) => knownParticipants.find((known) => known.id === id)?.label ?? id);
    const recommendedOptionId = options.some((option) => option.id === decision.recommendedOptionId) ? decision.recommendedOptionId : options[0]?.id;
    const decisionKey = this.decisionKeyFromText(title, question);
    const ownerKey = participant
      ? this.decisionIdFromKey(this.normalizeId(participant.id || participant.label))
      : sourceParticipantIds.length
        ? this.decisionIdFromKey(sourceParticipantIds.join(" "))
        : "shared";
    return {
      id: `decision-${ownerKey}-${this.decisionIdFromKey(decisionKey)}`,
      title,
      question,
      impact: (decision.impact ?? "").trim() || "This choice materially changes the implementation plan.",
      options,
      recommendedOptionId,
      sourceParticipantIds,
      sourceParticipantLabels,
      createdAt: new Date().toISOString()
    };
  }

  private resolveParticipantIds(value: string, participants: ParticipantConfig[]): string[] {
    const tokens = value.split(",").map((token) => token.trim()).filter(Boolean);
    const resolved: string[] = [];
    for (const token of tokens) {
      const normalized = this.normalizeId(token);
      const match = participants.find((participant) => participant.id === token || this.normalizeId(participant.label) === normalized || this.normalizeId(participant.id) === normalized);
      if (match) {
        resolved.push(match.id);
      }
    }
    return Array.from(new Set(resolved));
  }

  private localMergePoints(pointsByParticipant: Map<string, LinePoint[]>): LinePoint[] {
    const merged = new Map<string, LinePoint>();
    for (const points of pointsByParticipant.values()) {
      for (const point of points) {
        const key = this.pointKey(point);
        const existing = merged.get(key);
        if (existing) {
          existing.sourceParticipantIds = Array.from(new Set([...existing.sourceParticipantIds, ...point.sourceParticipantIds]));
          existing.evidence = existing.evidence || point.evidence;
          existing.action = existing.action || point.action;
        } else {
          merged.set(key, { ...point, sourceParticipantIds: [...point.sourceParticipantIds] });
        }
      }
    }
    return Array.from(merged.values());
  }

  private selectImplementationPlanPoints(
    points: LinePoint[],
    pointsByParticipant: Map<string, LinePoint[]>,
    participants: ParticipantConfig[],
    warnings: string[]
  ): LinePoint[] {
    const normalizedPoints = points
      .filter((point) => !this.isMetaPoint(point))
      .map((point) => this.withVerifiedSources(point, pointsByParticipant, participants));
    const untraceablePointCount = normalizedPoints.filter((point) => point.sourceParticipantIds.length === 0).length;
    if (untraceablePointCount > 0) {
      warnings.push(`${untraceablePointCount} implementation-plan item${untraceablePointCount === 1 ? "" : "s"} had no matching participant source and were filtered out.`);
    }

    return normalizedPoints.filter((point) => point.sourceParticipantIds.length > 0);
  }

  private selectImplementationPlanExtractionPoints(points: LinePoint[], participants: ParticipantConfig[], warnings: string[]): LinePoint[] {
    const participantIds = new Set(participants.map((participant) => participant.id));
    const normalizedPoints = points
      .filter((point) => !this.isMetaPoint(point))
      .map((point) => ({
        ...point,
        sourceParticipantIds: Array.from(new Set(point.sourceParticipantIds.filter((id) => participantIds.has(id))))
      }));
    const untraceablePointCount = normalizedPoints.filter((point) => point.sourceParticipantIds.length === 0).length;
    if (untraceablePointCount > 0) {
      warnings.push(`${untraceablePointCount} implementation-plan item${untraceablePointCount === 1 ? "" : "s"} had no valid participant source and were filtered out.`);
    }

    return normalizedPoints.filter((point) => point.sourceParticipantIds.length > 0);
  }

  private withInferredSources(
    point: LinePoint,
    pointsByParticipant: Map<string, LinePoint[]>,
    participants: ParticipantConfig[]
  ): LinePoint {
    const participantIds = new Set(participants.map((participant) => participant.id));
    const sourceParticipantIds = new Set(point.sourceParticipantIds.filter((id) => participantIds.has(id)));

    for (const [participantId, points] of pointsByParticipant.entries()) {
      if (!participantIds.has(participantId) || sourceParticipantIds.has(participantId)) {
        continue;
      }
      if (points.some((candidate) => this.pointsLikelyMatch(point, candidate))) {
        sourceParticipantIds.add(participantId);
      }
    }

    return { ...point, sourceParticipantIds: Array.from(sourceParticipantIds) };
  }

  private withVerifiedSources(
    point: LinePoint,
    pointsByParticipant: Map<string, LinePoint[]>,
    participants: ParticipantConfig[]
  ): LinePoint {
    const participantIds = new Set(participants.map((participant) => participant.id));
    const declaredSourceIds = new Set(point.sourceParticipantIds.filter((id) => participantIds.has(id)));
    const sourceParticipantIds = new Set<string>();

    for (const [participantId, points] of pointsByParticipant.entries()) {
      if (!participantIds.has(participantId)) {
        continue;
      }
      const hasSourceMatch = declaredSourceIds.has(participantId)
        ? Boolean(this.bestSourcePointForParticipant(point, points))
        : declaredSourceIds.size === 0 && points.some((candidate) => this.pointsLikelyMatch(point, candidate));
      if (hasSourceMatch) {
        sourceParticipantIds.add(participantId);
      }
    }

    return { ...point, sourceParticipantIds: Array.from(sourceParticipantIds) };
  }

  private sourceItemsForPoint(
    point: LinePoint,
    pointsByParticipant: Map<string, LinePoint[]>,
    participants: ParticipantConfig[]
  ): FindingSourceItem[] {
    const participantById = new Map(participants.map((participant) => [participant.id, participant]));
    const sourceItems: FindingSourceItem[] = [];
    for (const participantId of point.sourceParticipantIds) {
      const participant = participantById.get(participantId);
      if (!participant) {
        continue;
      }
      const sourcePoint = this.bestSourcePointForParticipant(point, pointsByParticipant.get(participantId) ?? []) ?? point;
      sourceItems.push({
        participantId,
        participantLabel: participant.label,
        title: sourcePoint.title,
        claim: sourcePoint.claim,
        evidence: sourcePoint.evidence,
        action: sourcePoint.action
      });
    }
    return sourceItems;
  }

  private sourceItemsForRawPlans(
    point: LinePoint,
    rawPlans: RawImplementationPlan[],
    participants: ParticipantConfig[]
  ): FindingSourceItem[] {
    const participantById = new Map(participants.map((participant) => [participant.id, participant]));
    const rawPlanByParticipantId = new Map(rawPlans.map((plan) => [plan.participantId, plan]));
    const sourceItems: FindingSourceItem[] = [];
    for (const participantId of point.sourceParticipantIds) {
      const participant = participantById.get(participantId);
      const rawPlan = rawPlanByParticipantId.get(participantId);
      if (!participant || !rawPlan) {
        continue;
      }
      sourceItems.push({
        participantId,
        participantLabel: participant.label,
        title: "Initial implementation plan",
        claim: "",
        evidence: "",
        action: "",
        rawContent: rawPlan.content
      });
    }
    return sourceItems;
  }

  private bestSourcePointForParticipant(point: LinePoint, candidates: LinePoint[]): LinePoint | undefined {
    const pointKey = this.pointKey(point);
    const pointTokens = this.pointTokens(point);
    let best: { point: LinePoint; score: number } | undefined;
    for (const candidate of candidates) {
      if (pointKey && pointKey === this.pointKey(candidate)) {
        return candidate;
      }
      const candidateTokens = this.pointTokens(candidate);
      if (pointTokens.size === 0 || candidateTokens.size === 0) {
        continue;
      }
      const common = Array.from(pointTokens).filter((token) => candidateTokens.has(token)).length;
      const smaller = Math.min(pointTokens.size, candidateTokens.size);
      const score = common / smaller;
      if (common < MIN_POINT_MATCH_TOKENS || score < MIN_POINT_MATCH_RATIO) {
        continue;
      }
      if (!best || score > best.score) {
        best = { point: candidate, score };
      }
    }
    return best?.point;
  }

  private createFinding(point: LinePoint, healthyParticipants: ParticipantConfig[], sourceItems: FindingSourceItem[] = []): Finding {
    const includedParticipantIds = point.sourceParticipantIds.filter((id) => healthyParticipants.some((participant) => participant.id === id));
    const missingParticipantIds = healthyParticipants.map((participant) => participant.id).filter((id) => !includedParticipantIds.includes(id));
    const sourceParticipantId = includedParticipantIds[0] ?? healthyParticipants[0]?.id ?? "unknown";
    const sourceParticipantLabel = healthyParticipants.find((participant) => participant.id === sourceParticipantId)?.label ?? sourceParticipantId;
    const sourceParticipantLabels = includedParticipantIds.map((id) => healthyParticipants.find((participant) => participant.id === id)?.label ?? id);

    return {
      id: randomUUID(),
      title: point.title,
      description: point.claim || point.action || point.title,
      sourceParticipantId,
      sourceParticipantLabel,
      sourceParticipantIds: includedParticipantIds,
      sourceParticipantLabels,
      includedParticipantIds,
      missingParticipantIds,
      claim: point.claim,
      evidence: point.evidence,
      action: point.action,
      sourceItems,
      severity: point.severity,
      status: missingParticipantIds.length === 0 && includedParticipantIds.length > 0 ? "Confirmed" : "Unresolved",
      rounds: [],
      createdAt: new Date().toISOString()
    };
  }

  private parseVerification(content: string): ParsedVerification {
    const value = content.match(/\bV:\s*(AGREE|REJECT|UNCLEAR)\b/i)?.[1]?.toUpperCase();
    const severityText = content.match(/\bS:\s*(Critical|High|Medium|Low|Info)\b/i)?.[1];
    const reason = content.match(/\bE:\s*([\s\S]*)/i)?.[1]?.trim() || content.trim();
    return {
      stance: value === "AGREE" ? "confirmed" : value === "REJECT" ? "rejected" : "unclear",
      severity: this.asSeverity(severityText),
      reason
    };
  }

  private parseSourceDecision(content: string): ParsedSourceDecision {
    const value = content.match(/\bV:\s*(ACCEPT|REJECT|UNCLEAR)\b/i)?.[1]?.toUpperCase();
    const reason = content.match(/\bE:\s*([\s\S]*)/i)?.[1]?.trim() || content.trim();
    return {
      decision: value === "ACCEPT" ? "accept" : value === "REJECT" ? "reject" : "unclear",
      reason
    };
  }

  private parseAutomaticDecisionAnswer(content: string): ParsedAutomaticDecisionAnswer {
    const value = content.match(/\bV:\s*(YES|NO)\b/i)?.[1]?.toUpperCase();
    const selectedOptionId = content.match(/\bO:\s*(O\d+)\b/i)?.[1]?.toUpperCase();
    const sourceDecisionId = content.match(/\bSRC:\s*([^\s|]+)/i)?.[1]?.trim();
    const answer = content.match(/\bA:\s*([\s\S]*?)(?:\nE:|$)/i)?.[1]?.trim() ?? "";
    const reason = content.match(/\bE:\s*([\s\S]*)/i)?.[1]?.trim() || content.trim();
    return {
      applies: value === "YES",
      selectedOptionId,
      sourceDecisionId,
      answer,
      reason
    };
  }

  private statusFor(finding: Finding, healthyParticipants: ParticipantConfig[]): FindingStatus {
    const finalRound = finding.rounds.find((round) => round.stance === "final-resolution");
    if (finalRound) {
      const parsed = this.parseVerification(finalRound.content);
      return parsed.stance === "confirmed" ? "Confirmed" : parsed.stance === "rejected" ? "Rejected" : "Unresolved";
    }

    const supportIds = new Set(finding.includedParticipantIds ?? [finding.sourceParticipantId]);
    const rejectIds = new Set<string>();
    let hasUnclear = false;
    for (const round of finding.rounds) {
      if (round.stance === "confirmed") {
        supportIds.add(round.participantId);
      } else if (round.stance === "rejected") {
        rejectIds.add(round.participantId);
      } else if (round.stance === "unclear") {
        hasUnclear = true;
      }
    }

    if (healthyParticipants.length > 0 && healthyParticipants.every((participant) => supportIds.has(participant.id))) {
      return "Confirmed";
    }
    if (rejectIds.size > 0 && rejectIds.size >= supportIds.size) {
      return "Rejected";
    }
    return hasUnclear || rejectIds.size > 0 ? "Unresolved" : "Unresolved";
  }

  private finalSummary(conversation: Conversation): string {
    if (conversation.kind === "implementation-plan") {
      return this.finalImplementationPlanSummary(conversation);
    }

    if (conversation.findings.length === 0) {
      return conversation.kind === "code-review"
        ? "No concrete review findings were confirmed."
        : "No actionable consensus points were extracted.";
    }

    const title = conversation.kind === "code-review" ? "Final review consensus" : "Final answer consensus";
    const lines: string[] = [title];
    for (const status of ["Confirmed", "Unresolved", "Rejected"] as FindingStatus[]) {
      const group = conversation.findings.filter((finding) => finding.status === status);
      if (group.length === 0) {
        continue;
      }
      lines.push(`\n${status}`);
      for (const severity of SEVERITY_ORDER) {
        for (const finding of group.filter((item) => item.severity === severity)) {
          const text = finding.action || finding.claim || finding.description || finding.title;
          lines.push(`- [${severity}] ${text}`);
        }
      }
    }
    return lines.join("\n");
  }

  private finalImplementationPlanSummary(conversation: Conversation): string {
    const approved = conversation.findings.filter((finding) => finding.status === "Confirmed");
    const unresolved = conversation.findings.filter((finding) => finding.status === "Unresolved");
    const rejected = conversation.findings.filter((finding) => finding.status === "Rejected");
    const reviews = this.planItemReviewsFromMetadata(conversation);
    if (conversation.findings.length === 0) {
      return "No implementation-plan items were approved by all healthy participants.";
    }

    const lines: string[] = approved.length > 0 ? ["Approved implementation plan"] : ["No implementation-plan items were approved by all healthy participants."];
    for (const [index, finding] of approved.entries()) {
      const action = finding.action || finding.claim || finding.description || finding.title;
      lines.push(`${index + 1}. ${finding.title}`);
      lines.push(`   ${action}`);
      if (finding.evidence) {
        lines.push(`   Context: ${finding.evidence}`);
      }
      const review = this.planItemReviewForFinding(finding, reviews);
      if (review?.status === "commented" && review.comment?.trim()) {
        lines.push(`   User guidance: ${review.comment.trim()}`);
      }
    }
    if (unresolved.length > 0) {
      lines.push("\nUnresolved differences");
      for (const finding of unresolved) {
        lines.push(`- ${finding.title}: ${finding.action || finding.claim || finding.description}`);
      }
    }
    if (rejected.length > 0) {
      lines.push("\nRejected differences");
      for (const finding of rejected) {
        lines.push(`- ${finding.title}: ${finding.action || finding.claim || finding.description}`);
      }
    }
    return lines.join("\n");
  }

  private parseImplementationPlanSynthesis(content: string, conversation: Conversation): ImplementationPlanSynthesis {
    const fallback = this.fallbackImplementationPlanSynthesis(conversation);
    const legacyFullPlan = this.markdownSection(content, "Full Plan");
    const fullPlan = legacyFullPlan || this.removeMarkdownSection(content, "Debate Summary");
    if (!fullPlan.trim()) {
      return fallback;
    }
    const debateSummary = this.markdownSection(content, "Debate Summary") || fallback.debateSummary;
    return this.implementationPlanSynthesis(fullPlan, debateSummary, "arbiter");
  }

  private fallbackImplementationPlanSynthesis(conversation: Conversation): ImplementationPlanSynthesis {
    return this.implementationPlanSynthesis(
      this.finalImplementationPlanSummary(conversation),
      this.localImplementationPlanDebateSummary(conversation),
      "fallback"
    );
  }

  private implementationPlanSynthesis(fullPlan: string, debateSummary: string, source: ImplementationPlanSynthesis["source"]): ImplementationPlanSynthesis {
    const cleanFullPlan = fullPlan.trim();
    const cleanDebateSummary = debateSummary.trim();
    return {
      fullPlan: cleanFullPlan,
      debateSummary: cleanDebateSummary,
      combined: [cleanFullPlan, cleanDebateSummary ? `## Debate Summary\n${cleanDebateSummary}` : ""].filter(Boolean).join("\n\n"),
      source
    };
  }

  private markdownSection(content: string, title: string): string {
    const lines = content.replace(/\r\n/g, "\n").split("\n");
    const normalizedTitle = title.trim().toLowerCase();
    let start = -1;
    for (const [index, line] of lines.entries()) {
      const heading = line.match(/^#{1,3}\s+(.+?)\s*$/);
      if (heading?.[1].trim().toLowerCase() === normalizedTitle) {
        start = index;
        break;
      }
    }
    if (start < 0) {
      return "";
    }
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
      if (/^#{1,3}\s+/.test(lines[index])) {
        end = index;
        break;
      }
    }
    return lines.slice(start + 1, end).join("\n").trim();
  }

  private removeMarkdownSection(content: string, title: string): string {
    const lines = content.replace(/\r\n/g, "\n").split("\n");
    const normalizedTitle = title.trim().toLowerCase();
    let start = -1;
    for (const [index, line] of lines.entries()) {
      const heading = line.match(/^#{1,3}\s+(.+?)\s*$/);
      if (heading?.[1].trim().toLowerCase() === normalizedTitle) {
        start = index;
        break;
      }
    }
    if (start < 0) {
      return content.trim();
    }
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
      if (/^#{1,3}\s+/.test(lines[index])) {
        end = index;
        break;
      }
    }
    return [...lines.slice(0, start), ...lines.slice(end)].join("\n").trim();
  }

  private localImplementationPlanDebateSummary(conversation: Conversation): string {
    const debated = conversation.findings.filter((finding) => finding.rounds.length > 0 || finding.status !== "Confirmed");
    if (debated.length === 0) {
      return "All approved items were common across the healthy participants; no non-common plan items required debate.";
    }

    const lines: string[] = [];
    for (const finding of debated) {
      const latestRound = finding.rounds.at(-1);
      const outcome = finding.status.toLowerCase();
      const reason = latestRound?.content || finding.action || finding.claim || finding.description;
      lines.push(`- ${finding.title}: ${outcome}. ${reason}`);
    }
    return lines.join("\n");
  }

  private formatImplementationPlanThreadsForPrompt(findings: Finding[]): string {
    if (findings.length === 0) {
      return "No implementation-plan items were extracted.";
    }

    const lines: string[] = [];
    for (const [index, finding] of findings.entries()) {
      lines.push(`ITEM ${index + 1}|STATUS:${finding.status}|S:${finding.severity}|T:${finding.title}`);
      lines.push(`C:${finding.claim || finding.description}`);
      if (finding.evidence) {
        lines.push(`E:${finding.evidence}`);
      }
      if (finding.action) {
        lines.push(`A:${finding.action}`);
      }
      lines.push(`Sources:${(finding.sourceParticipantLabels ?? [finding.sourceParticipantLabel]).join(", ") || "none"}`);
      if (finding.sourceItems?.length) {
        lines.push("Initial source items:");
        for (const sourceItem of finding.sourceItems) {
          lines.push(`- ${sourceItem.participantLabel}: ${sourceItem.title}`);
          if (sourceItem.claim) {
            lines.push(`  C:${sourceItem.claim}`);
          }
          if (sourceItem.evidence) {
            lines.push(`  E:${sourceItem.evidence}`);
          }
          if (sourceItem.action) {
            lines.push(`  A:${sourceItem.action}`);
          }
        }
      }
      if (finding.rounds.length) {
        lines.push("Debate rounds:");
        for (const round of finding.rounds) {
          lines.push(`- ${round.participantLabel} ${round.stance}: ${round.content}`);
        }
      }
      lines.push("");
    }
    return lines.join("\n").trim();
  }

  private formatPlanItemReviewsForPrompt(conversation: Conversation): string {
    const reviews = this.planItemReviewsFromMetadata(conversation);
    const reviewable = this.requiredPlanItemReviewFindings(conversation);
    if (reviewable.length === 0) {
      return "No confirmed implementation-plan items required user review.";
    }

    const lines: string[] = [];
    for (const [index, finding] of reviewable.entries()) {
      const review = this.planItemReviewForFinding(finding, reviews);
      lines.push(`ITEM ${index + 1}|T:${finding.title}`);
      if (!review) {
        lines.push("User review: missing");
      } else if (review.status === "commented") {
        lines.push(`User review: commented`);
        lines.push(`Comment:${review.comment ?? ""}`);
      } else {
        lines.push("User review: confirmed as-is");
      }
      lines.push("");
    }
    return lines.join("\n").trim();
  }

  private formatParticipantPoints(pointsByParticipant: Map<string, LinePoint[]>): string {
    const lines: string[] = [];
    for (const [participantId, points] of pointsByParticipant.entries()) {
      lines.push(`## ${participantId}`);
      for (const [index, point] of points.entries()) {
        lines.push(`P${index + 1}|S:${point.severity}|T:${point.title}`);
        if (point.claim) {
          lines.push(`C:${point.claim}`);
        }
        if (point.evidence) {
          lines.push(`E:${point.evidence}`);
        }
        if (point.action) {
          lines.push(`A:${point.action}`);
        }
      }
    }
    return lines.join("\n");
  }

  private formatRawImplementationPlansForPrompt(rawPlans: RawImplementationPlan[]): string {
    if (rawPlans.length === 0) {
      return "No participant plans were available.";
    }

    return rawPlans
      .map((plan) =>
        [
          `--- PARTICIPANT ${plan.participantId} (${plan.participantLabel}) ---`,
          plan.content || "(empty plan)"
        ].join("\n")
      )
      .join("\n\n");
  }

  private formatDecisionAnswers(answers: PlanDecisionAnswer[]): string {
    if (answers.length === 0) {
      return "none";
    }
    return answers.map((answer, index) => `${index + 1}. ${answer.answer}`).join("\n");
  }

  private formatDecisionAnswersForAutomaticReuse(answers: PlanDecisionAnswer[]): string {
    if (answers.length === 0) {
      return "none";
    }
    return answers
      .map((answer) => [
        `ID:${answer.decisionId}`,
        answer.answerSource ? `Source:${answer.answerSource}` : "Source:user",
        answer.selectedOptionId ? `Selected:${answer.selectedOptionId}` : "",
        answer.answer
      ].filter(Boolean).join("\n"))
      .join("\n\n");
  }

  private formatDecisionAnswersForTimeline(answers: PlanDecisionAnswer[]): string {
    return `Implementation-plan decision threads continued:\n${this.formatDecisionAnswers(answers)}`;
  }

  private formatDecisionRepliesForPrompt(replies: PlanDecisionReply[]): string {
    if (replies.length === 0) {
      return "none";
    }
    return replies
      .map((reply) => {
        const author = reply.role === "user" ? "User" : reply.participantLabel ?? "Participant";
        return `${author}: ${reply.content}`;
      })
      .join("\n");
  }

  private formatFindingForPrompt(finding: Finding): string {
    return [
      `POINT|S:${finding.severity}|T:${finding.title}`,
      finding.claim ? `C:${finding.claim}` : "",
      finding.evidence ? `E:${finding.evidence}` : "",
      finding.action ? `A:${finding.action}` : "",
      finding.sourceParticipantLabels?.length ? `Sources:${finding.sourceParticipantLabels.join(", ")}` : ""
    ]
      .filter(Boolean)
      .join("\n");
  }

  private asArbiterParticipant(arbiter: ParticipantConfig, kind: ConversationKind = "code-review"): ParticipantConfig {
    const role = kind === "implementation-plan" ? "planner" : "arbiter";
    return { ...arbiter, id: `arbiter:${arbiter.id}`, label: `${arbiter.label} (${role})` };
  }

  private isMetaPoint(point: LinePoint): boolean {
    const text = `${point.title} ${point.claim} ${point.action}`.toLowerCase();
    if (/^(sources?|references?|источники|ссылки)\b/i.test(point.title.trim())) {
      return true;
    }
    return !point.claim && !point.action || /\b(niddk|mayo clinic|source|reference|источник)\b/i.test(text) && point.action.length < 20 && point.claim.length < 40;
  }

  private pointKey(point: LinePoint): string {
    return this.normalizeId(`${point.title} ${point.claim || point.action}`).split(/\s+/).slice(0, 14).join(" ");
  }

  private pointsLikelyMatch(left: LinePoint, right: LinePoint): boolean {
    const leftKey = this.pointKey(left);
    const rightKey = this.pointKey(right);
    if (leftKey && rightKey && leftKey === rightKey) {
      return true;
    }

    const leftTokens = this.pointTokens(left);
    const rightTokens = this.pointTokens(right);
    if (leftTokens.size === 0 || rightTokens.size === 0) {
      return false;
    }

    const common = Array.from(leftTokens).filter((token) => rightTokens.has(token)).length;
    const smaller = Math.min(leftTokens.size, rightTokens.size);
    return common >= MIN_POINT_MATCH_TOKENS && common / smaller >= MIN_POINT_MATCH_RATIO;
  }

  private isAnsweredDecision(decision: PlanDecisionRequest, answers: PlanDecisionAnswer[]): boolean {
    return answers.some((answer) => answer.decisionId === decision.id);
  }

  private decisionKey(decision: PlanDecisionRequest): string {
    return this.decisionKeyFromText(decision.title, decision.question);
  }

  private decisionKeyFromText(title: string, question: string): string {
    return this.normalizeId(`${title} ${question}`).split(/\s+/).slice(0, 12).join(" ");
  }

  private decisionIdFromKey(key: string): string {
    const slug = key.replace(/\s+/g, "-").slice(0, 96);
    return slug || randomUUID();
  }

  private decisionAnswerKey(answer: PlanDecisionAnswer): string {
    if (answer.decisionKey?.trim()) {
      return answer.decisionKey.trim();
    }
    const title = answer.answer.match(/^Decision:\s*(.+)$/m)?.[1] ?? "";
    const question = answer.answer.match(/^Question:\s*(.+)$/m)?.[1] ?? "";
    return title || question ? this.decisionKeyFromText(title, question) : "";
  }

  private pointTokens(point: LinePoint): Set<string> {
    return new Set(
      this.normalizeId(`${point.title} ${point.claim} ${point.evidence} ${point.action}`)
        .split(/\s+/)
        .filter((token) => token.length > 2)
    );
  }

  private normalizeId(value: string): string {
    return value
      .toLowerCase()
      .replace(/`[^`]+`/g, "")
      .replace(/[^a-zа-яё0-9\s-]/gi, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2 && !["critical", "high", "medium", "low", "info", "severity"].includes(word))
      .join(" ");
  }

  private severityFromText(text: string): FindingSeverity {
    return this.asSeverity(text.match(/\b(Critical|High|Medium|Low|Info)\b/i)?.[1]) ?? "Medium";
  }

  private asSeverity(value: string | undefined): FindingSeverity | undefined {
    if (!value) {
      return undefined;
    }
    const normalized = value.toLowerCase();
    return SEVERITY_ORDER.find((severity) => severity.toLowerCase() === normalized);
  }

  private isCliParticipant(participant: ParticipantConfig): boolean {
    return participant.kind === "codex-cli" || participant.kind === "claude-code" || participant.kind === "gemini-cli";
  }

  private clarificationTargets(request: ReviewRequest, decision: PlanDecisionRequest): ParticipantConfig[] {
    const sourceIds = new Set(decision.sourceParticipantIds);
    const sources = request.participants.filter((participant) => sourceIds.has(participant.id) && this.isCliParticipant(participant));
    const fallback = request.participants.filter((participant) => this.isCliParticipant(participant));
    return (sources.length ? sources : fallback).slice(0, MAX_VERIFIERS_PER_POINT);
  }

  private planDecisionReply(
    decisionId: string,
    role: PlanDecisionReply["role"],
    content: string,
    participant?: ParticipantConfig,
    status: PlanDecisionReply["status"] = "done",
    metadata: Pick<PlanDecisionReply, "answerSource" | "sourceDecisionId"> = {}
  ): PlanDecisionReply {
    return {
      id: randomUUID(),
      decisionId,
      role,
      participantId: participant?.id,
      participantLabel: participant?.label,
      content,
      createdAt: new Date().toISOString(),
      status,
      ...metadata
    };
  }

  private participantSessionKey(participant: ParticipantConfig): string {
    return `participant:${participant.kind}:${participant.id}`;
  }

  private arbiterSessionKey(arbiter: ParticipantConfig): string {
    return `arbiter:${arbiter.kind}:${arbiter.id}`;
  }

  private sessionContext(conversation: Conversation, warnings: string[], sessionKey: string): CliSessionContext {
    return { conversation, warnings, sessionKey };
  }

  private serializeReviewRequest(request: ReviewRequest): ReviewRequest {
    return {
      ...request,
      participants: request.participants.map((participant) => ({ ...participant })),
      arbiter: request.arbiter ? { ...request.arbiter } : undefined
    };
  }

  private implementationPlanRequestFromMetadata(conversation: Conversation): ReviewRequest | undefined {
    const value = conversation.metadata.implementationPlanRequest;
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const request = value as ReviewRequest;
    return request.kind === "implementation-plan" ? request : undefined;
  }

  private implementationPlanAnswersFromMetadata(conversation: Conversation): PlanDecisionAnswer[] {
    const value = conversation.metadata.implementationPlanAnswers;
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((item): item is PlanDecisionAnswer => {
      const candidate = item as Partial<PlanDecisionAnswer>;
      return typeof candidate.decisionId === "string" && typeof candidate.answer === "string";
    });
  }

  private rawImplementationPlansFromMetadata(conversation: Conversation): RawImplementationPlan[] {
    const value = conversation.metadata.implementationPlanRawPlans;
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((item): item is RawImplementationPlan => {
      const candidate = item as Partial<RawImplementationPlan>;
      return (
        typeof candidate.participantId === "string" &&
        typeof candidate.participantLabel === "string" &&
        typeof candidate.content === "string" &&
        candidate.content.trim().length > 0 &&
        typeof candidate.createdAt === "string"
      );
    });
  }

  private pendingDecisionsFromMetadata(conversation: Conversation): PlanDecisionRequest[] {
    const value = conversation.metadata.pendingDecisions;
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((item): item is PlanDecisionRequest => {
      const candidate = item as Partial<PlanDecisionRequest>;
      return (
        typeof candidate.id === "string" &&
        typeof candidate.title === "string" &&
        typeof candidate.question === "string" &&
        Array.isArray(candidate.options)
      );
    });
  }

  private planDecisionRequestsFromMetadata(conversation: Conversation): PlanDecisionRequest[] {
    const value = conversation.metadata.planDecisionRequests;
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((item): item is PlanDecisionRequest => {
      const candidate = item as Partial<PlanDecisionRequest>;
      return typeof candidate.id === "string" && typeof candidate.question === "string" && Array.isArray(candidate.options);
    });
  }

  private mergePlanDecisionRequests(existing: PlanDecisionRequest[], next: PlanDecisionRequest[]): PlanDecisionRequest[] {
    const merged = new Map<string, PlanDecisionRequest>();
    for (const decision of [...existing, ...next]) {
      if (decision.id && decision.question.trim()) {
        merged.set(decision.id, decision);
      }
    }
    return Array.from(merged.values());
  }

  private planDecisionRepliesFromMetadata(conversation: Conversation): PlanDecisionReply[] {
    const value = conversation.metadata.planDecisionReplies;
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((item): item is PlanDecisionReply => {
      const candidate = item as Partial<PlanDecisionReply>;
      return (
        typeof candidate.id === "string" &&
        typeof candidate.decisionId === "string" &&
        typeof candidate.role === "string" &&
        typeof candidate.content === "string" &&
        typeof candidate.createdAt === "string"
      );
    });
  }

  private planItemReviewsFromMetadata(conversation: Conversation): PlanItemReview[] {
    const value = conversation.metadata.planItemReviews;
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((item): item is PlanItemReview => {
      const candidate = item as Partial<PlanItemReview>;
      const status = candidate.status;
      return (
        typeof candidate.findingId === "string" &&
        (status === "confirmed" || status === "commented") &&
        typeof candidate.createdAt === "string" &&
        typeof candidate.updatedAt === "string" &&
        (candidate.comment === undefined || typeof candidate.comment === "string")
      );
    });
  }

  private requiredPlanItemReviewFindings(conversation: Conversation): Finding[] {
    return conversation.findings.filter((finding) => finding.status === "Confirmed" && this.planItemRequiresReview(finding));
  }

  private planItemRequiresReview(finding: Finding): boolean {
    return finding.rounds.some((round) => round.stance !== "confirmed");
  }

  private planItemReviewForFinding(finding: Finding, reviews: PlanItemReview[]): PlanItemReview | undefined {
    const review = reviews.find((item) => item.findingId === finding.id);
    if (!review) {
      return undefined;
    }
    if (review.status === "confirmed") {
      return review;
    }
    return review.comment?.trim() ? review : undefined;
  }

  private cliAgentSessionsFromMetadata(conversation: Conversation): CliAgentSessionMetadata[] {
    const value = conversation.metadata.cliAgentSessions;
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((item): item is CliAgentSessionMetadata => {
      const candidate = item as Partial<CliAgentSessionMetadata>;
      return (
        typeof candidate.key === "string" &&
        typeof candidate.participantId === "string" &&
        typeof candidate.participantKind === "string" &&
        typeof candidate.participantLabel === "string" &&
        typeof candidate.sessionId === "string" &&
        typeof candidate.updatedAt === "string"
      );
    });
  }

  private cliAgentSessionId(conversation: Conversation, key: string): string | undefined {
    return this.cliAgentSessionsFromMetadata(conversation).find((session) => session.key === key)?.sessionId;
  }

  private upsertCliAgentSession(conversation: Conversation, key: string, participant: ParticipantConfig, sessionId: string): void {
    const sessions = this.cliAgentSessionsFromMetadata(conversation).filter((session) => session.key !== key);
    sessions.push({
      key,
      participantId: participant.id,
      participantKind: participant.kind,
      participantLabel: participant.label,
      sessionId,
      updatedAt: new Date().toISOString()
    });
    conversation.metadata = { ...conversation.metadata, cliAgentSessions: sessions };
  }

  private mergeDecisionAnswers(existing: PlanDecisionAnswer[], next: PlanDecisionAnswer[]): PlanDecisionAnswer[] {
    const merged = new Map<string, PlanDecisionAnswer>();
    for (const answer of [...existing, ...next]) {
      if (answer.decisionId && answer.answer.trim()) {
        const normalized = { ...answer, answer: answer.answer.trim(), decisionKey: this.decisionAnswerKey(answer) || undefined };
        merged.set(normalized.decisionId, normalized);
      }
    }
    return Array.from(merged.values());
  }

  private metadataText(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
  }

  private metadataWarnings(conversation: Conversation): string[] {
    return sanitizeWarningList(conversation.metadata.warnings, MAX_STORED_WARNING_CHARS);
  }

  private metadataNumber(value: unknown): number {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value as number)) : 0;
  }

  private hasStoredImplementationPlan(conversation: Conversation): boolean {
    return Boolean(
      this.metadataText(conversation.metadata.implementationPlanFinalMarkdown) ||
      conversation.finalSummary?.trim() ||
      conversation.messages.some((message) => message.role === "summary" && message.content.trim())
    );
  }

  private limitText(text: string, warnings: string[]): string {
    if (text.length <= MAX_CONTEXT_CHARS) {
      return text;
    }
    warnings.push(`Context was truncated to ${MAX_CONTEXT_CHARS.toLocaleString()} characters.`);
    return `${text.slice(0, MAX_CONTEXT_CHARS)}\n\n[Context truncated]`;
  }

  private titleFor(request: ReviewRequest, diff: GitDiffResult | undefined): string {
    if (request.question.trim()) {
      return request.question.trim().slice(0, 80);
    }
    if (request.kind === "implementation-plan") {
      return "Implementation plan";
    }
    return diff?.title ?? "Consensus conversation";
  }

  private message(
    role: ChatMessage["role"],
    content: string,
    participant?: ParticipantConfig,
    status: ChatMessage["status"] = "done"
  ): ChatMessage {
    return {
      id: randomUUID(),
      role,
      participantId: participant?.id,
      participantLabel: participant?.label,
      content,
      createdAt: new Date().toISOString(),
      status
    };
  }

  private queueConversationSnapshot(conversation: Conversation): void {
    const snapshot = this.cloneConversation(conversation);
    this.onConversationSnapshot?.(snapshot);
    const previous = this.conversationSaveQueues.get(conversation.id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.storage.saveConversation(snapshot))
      .catch((error) => {
        void this.debugLogs.write("persistence.error", {
          conversationId: conversation.id,
          message: error instanceof Error ? error.message : String(error)
        });
      });
    this.conversationSaveQueues.set(conversation.id, next);
    void next.finally(() => {
      if (this.conversationSaveQueues.get(conversation.id) === next) {
        this.conversationSaveQueues.delete(conversation.id);
      }
    });
  }

  private async flushAndSaveConversation(conversation: Conversation): Promise<void> {
    const pending = this.conversationSaveQueues.get(conversation.id);
    if (pending) {
      await pending.catch(() => undefined);
    }
    const snapshot = this.cloneConversation(conversation);
    await this.storage.saveConversation(snapshot);
    this.onConversationSnapshot?.(snapshot);
  }

  private cloneConversation(conversation: Conversation): Conversation {
    return JSON.parse(JSON.stringify(conversation)) as Conversation;
  }

  private emitProgress(
    runId: string,
    progress: ProgressCallback | undefined,
    phase: ReviewProgress["phase"],
    message: string,
    details: Partial<Omit<ReviewProgress, "runId" | "phase" | "message" | "createdAt">> = {}
  ): void {
    progress?.({
      runId,
      phase,
      message,
      createdAt: new Date().toISOString(),
      ...details
    });
  }

  private throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
      throw new Error("Review cancelled.");
    }
  }

  private formatDuration(durationMs: number | undefined): string {
    if (durationMs === undefined) {
      return "";
    }
    return ` in ${(durationMs / 1000).toFixed(1)}s`;
  }

  private formatParticipantLabelList(labels: string[]): string {
    if (labels.length === 0) {
      return "participants";
    }
    if (labels.length === 1) {
      return labels[0];
    }
    if (labels.length === 2) {
      return `${labels[0]} and ${labels[1]}`;
    }
    return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
  }
}
