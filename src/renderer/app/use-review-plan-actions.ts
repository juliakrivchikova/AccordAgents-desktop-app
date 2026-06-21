import {
  errorText,
  firstPendingPlanItemReview,
  mergeProgressIntoConversation,
  pendingPlanDecisions
} from "../components/review/review-conversation-data";
import type { AppState } from "./app-state";
import type { ConversationActions } from "./use-conversation-actions";

export interface ReviewPlanActions {
  composeImplementationPlan: () => Promise<void>;
  retryFinalPlanSynthesis: () => Promise<void>;
  recoverImplementationPlan: () => Promise<void>;
  reviseImplementationPlan: () => Promise<void>;
}

type ReviewRun =
  | "composeImplementationPlan"
  | "retryImplementationPlanSynthesis"
  | "recoverImplementationPlan"
  | "reviseImplementationPlan";

export function useReviewPlanActions(state: AppState, conversationActions: ConversationActions): ReviewPlanActions {
  async function composeImplementationPlan(): Promise<void> {
    await runPlanAction("composeImplementationPlan", "Plan composition cancelled.");
  }

  async function retryFinalPlanSynthesis(): Promise<void> {
    await runPlanAction("retryImplementationPlanSynthesis", "Final plan retry cancelled.");
  }

  async function recoverImplementationPlan(): Promise<void> {
    await runPlanAction("recoverImplementationPlan", "Plan recovery cancelled.", { selectPendingAfterRun: true });
  }

  async function reviseImplementationPlan(): Promise<void> {
    const instruction = state.planCorrectionDraft.trim();
    if (!instruction) {
      state.setError("Enter a plan correction.");
      return;
    }
    await runPlanAction("reviseImplementationPlan", "Final plan revision cancelled.", { instruction, clearPlanCorrectionDraft: true });
  }

  async function runPlanAction(
    action: ReviewRun,
    cancelWarning: string,
    options: { instruction?: string; selectPendingAfterRun?: boolean; clearPlanCorrectionDraft?: boolean } = {}
  ): Promise<void> {
    if (!state.conversation) return;
    const conversationId = state.conversation.id;
    const runId = crypto.randomUUID();
    state.setError(undefined);
    state.setWarnings([]);
    state.setCurrentRunId(runId);
    state.progressLogRef.current = [];
    state.setProgressLog([]);
    state.setBusy(true);
    state.setConversation((current) =>
      current?.id === conversationId
        ? { ...current, metadata: { ...current.metadata, running: true } }
        : current
    );
    try {
      const result = await callPlanAction(action, conversationId, runId, options.instruction);
      state.setConversation(mergeProgressIntoConversation(result.conversation, state.progressLogRef.current.filter((item) => item.runId === runId)));
      state.setWarnings(result.warnings);
      if (options.clearPlanCorrectionDraft) {
        state.setPlanCorrectionDraft("");
      }
      if (options.selectPendingAfterRun) {
        const nextPendingDecisions = pendingPlanDecisions(result.conversation);
        const nextPendingItem = firstPendingPlanItemReview(result.conversation);
        state.setSelectedThreadId(nextPendingDecisions[0]?.id ?? nextPendingItem?.id);
        state.setFocusedThreadId(undefined);
      } else if (action === "composeImplementationPlan") {
        state.setSelectedThreadId(undefined);
        state.setFocusedThreadId(undefined);
      }
      await conversationActions.refreshConversations();
    } catch (caught) {
      const message = errorText(caught);
      if (message.toLowerCase().includes("cancel")) {
        state.setWarnings((current) => [...current, cancelWarning]);
      } else {
        state.setError(message);
      }
      markConversationNotRunning(conversationId);
    } finally {
      state.setBusy(false);
      state.setCurrentRunId(undefined);
      markConversationNotRunning(conversationId);
    }
  }

  function callPlanAction(action: ReviewRun, conversationId: string, runId: string, instruction?: string) {
    if (action === "composeImplementationPlan") {
      return window.consensus.composeImplementationPlan({ conversationId, runId });
    }
    if (action === "retryImplementationPlanSynthesis") {
      return window.consensus.retryImplementationPlanSynthesis({ conversationId, runId });
    }
    if (action === "recoverImplementationPlan") {
      return window.consensus.recoverImplementationPlan({ conversationId, runId });
    }
    return window.consensus.reviseImplementationPlan({ conversationId, instruction: instruction ?? "", runId });
  }

  function markConversationNotRunning(conversationId: string): void {
    state.setConversation((current) =>
      current?.id === conversationId && current.metadata.running === true
        ? { ...current, metadata: { ...current.metadata, running: false } }
        : current
    );
  }

  return { composeImplementationPlan, retryFinalPlanSynthesis, recoverImplementationPlan, reviseImplementationPlan };
}
