import type {
  ComposeImplementationPlanRequest, ContinueReviewRequest, Conversation, PlanDecisionClarificationRequest, PlanItemReviewRequest,
  RecoverImplementationPlanRequest, ReviseImplementationPlanRequest, RetryImplementationPlanSynthesisRequest, ReviewRequest,
  StartReviewResult
} from "../../shared/types";
import { CliAgentRunner } from "./cliAgents";
import { DebugLogService } from "./debugLogs";
import { GitService } from "./git";
import { ProviderRunner } from "./providers";
import { StorageService } from "./storage";
import type { ProgressCallback } from "./consensus/types";
import { createConsensusModules, type ConsensusModules } from "./consensus/modules";

/** Legacy reviews and implementation plans. The work is done by the parts in ./consensus. */
export class ConsensusService {
  private readonly modules: ConsensusModules;

  constructor(
    git: GitService,
    storage: StorageService,
    providerRunner: ProviderRunner,
    cliRunner: CliAgentRunner,
    debugLogs: DebugLogService,
    onConversationSnapshot?: (conversation: Conversation) => void
  ) {
    this.modules = createConsensusModules({ git, storage, providerRunner, cliRunner, debugLogs, onConversationSnapshot });
  }

  startReview(request: ReviewRequest, signal?: AbortSignal, progress?: ProgressCallback): Promise<StartReviewResult> {
    return this.modules.reviews.startReview(request, signal, progress);
  }

  continueReview(request: ContinueReviewRequest, signal?: AbortSignal, progress?: ProgressCallback): Promise<StartReviewResult> {
    return this.modules.reviews.continueReview(request, signal, progress);
  }

  askPlanDecisionClarification(
    request: PlanDecisionClarificationRequest,
    signal?: AbortSignal,
    progress?: ProgressCallback
  ): Promise<StartReviewResult> {
    return this.modules.planDecisions.askPlanDecisionClarification(request, signal, progress);
  }

  savePlanItemReview(request: PlanItemReviewRequest): Promise<Conversation | undefined> {
    return this.modules.planDecisions.savePlanItemReview(request);
  }

  composeImplementationPlan(
    request: ComposeImplementationPlanRequest,
    signal?: AbortSignal,
    progress?: ProgressCallback
  ): Promise<StartReviewResult> {
    return this.modules.planRevisions.composeImplementationPlan(request, signal, progress);
  }

  retryImplementationPlanSynthesis(
    request: RetryImplementationPlanSynthesisRequest,
    signal?: AbortSignal,
    progress?: ProgressCallback
  ): Promise<StartReviewResult> {
    return this.modules.planRevisions.retryImplementationPlanSynthesis(request, signal, progress);
  }

  recoverImplementationPlan(
    request: RecoverImplementationPlanRequest,
    signal?: AbortSignal,
    progress?: ProgressCallback
  ): Promise<StartReviewResult> {
    return this.modules.planRevisions.recoverImplementationPlan(request, signal, progress);
  }

  reviseImplementationPlan(
    request: ReviseImplementationPlanRequest,
    signal?: AbortSignal,
    progress?: ProgressCallback
  ): Promise<StartReviewResult> {
    return this.modules.planRevisions.reviseImplementationPlan(request, signal, progress);
  }
}
