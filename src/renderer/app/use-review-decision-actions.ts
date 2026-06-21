import type { PlanDecisionAnswer, PlanDecisionReply } from "../../shared/types";
import {
  decisionAnswerForDecision,
  decisionThreadAnswer,
  decisionThreadIsReady,
  errorText,
  firstPendingPlanItemReview,
  implementationPlanAnswers,
  mergePlanDecisionAnswers,
  mergePlanDecisionRequests,
  mergeProgressIntoConversation,
  pendingDecisionResolutions,
  pendingDecisionSelections,
  pendingPlanDecisions,
  planDecisionKey,
  planDecisionReplies,
  planDecisionRequests
} from "../components/review/review-conversation-data";
import type { AppState } from "./app-state";
import type { ConversationActions } from "./use-conversation-actions";

export interface ReviewDecisionActions {
  continueReview: () => Promise<void>;
  selectDecisionAnswer: (decisionId: string, optionId: string) => Promise<void>;
  resolveDecisionThread: (decisionId: string) => Promise<void>;
  askDecisionClarification: (decisionId: string) => Promise<void>;
  confirmPlanItem: (findingId: string) => Promise<void>;
  commentOnPlanItem: (findingId: string) => Promise<void>;
}

export function useReviewDecisionActions(state: AppState, conversationActions: ConversationActions): ReviewDecisionActions {
  async function continueReview(): Promise<void> {
    const pendingDecisions = pendingPlanDecisions(state.conversation);
    if (!state.conversation || pendingDecisions.length === 0) return;
    const decisionReplies = planDecisionReplies(state.conversation);
    const savedAnswers = implementationPlanAnswers(state.conversation);
    const currentDecisionAnswers = { ...pendingDecisionSelections(state.conversation), ...state.decisionAnswers };
    const currentDecisionResolutions = { ...pendingDecisionResolutions(state.conversation), ...state.resolvedDecisionThreads };
    const hasAnyDecisionInput = pendingDecisions.some((decision) =>
      decisionThreadIsReady(decision, currentDecisionAnswers, currentDecisionResolutions, savedAnswers)
    );
    if (!hasAnyDecisionInput) {
      state.setError("Choose an option or resolve at least one decision thread.");
      return;
    }

    const runId = crypto.randomUUID();
    const answers = buildPlanDecisionAnswers(pendingDecisions, currentDecisionAnswers, currentDecisionResolutions, decisionReplies, savedAnswers);
    const optimisticAnswers = mergePlanDecisionAnswers(savedAnswers, answers);
    const optimisticDecisionRequests = mergePlanDecisionRequests(planDecisionRequests(state.conversation), pendingDecisions);

    state.setError(undefined);
    state.setWarnings([]);
    state.setCurrentRunId(runId);
    state.progressLogRef.current = [];
    state.setProgressLog([]);
    state.setConversation((current) =>
      current?.id === state.conversation!.id
        ? {
            ...current,
            metadata: {
              ...current.metadata,
              implementationPlanAnswers: optimisticAnswers,
              planDecisionRequests: optimisticDecisionRequests,
              pendingDecisionSelections: undefined,
              pendingDecisionResolutions: undefined,
              pendingDecisions: undefined,
              running: true
            }
          }
        : current
    );
    state.setBusy(true);
    try {
      const result = await window.consensus.continueReview({ conversationId: state.conversation.id, runId, answers });
      state.setConversation(mergeProgressIntoConversation(result.conversation, state.progressLogRef.current.filter((item) => item.runId === runId)));
      state.setWarnings(result.warnings);
      clearReviewDraftState();
      const nextPendingDecisions = pendingPlanDecisions(result.conversation);
      const nextPendingItem = firstPendingPlanItemReview(result.conversation);
      state.setSelectedThreadId(nextPendingDecisions[0]?.id ?? nextPendingItem?.id);
      state.setFocusedThreadId(undefined);
      await conversationActions.refreshConversations();
    } catch (caught) {
      const message = errorText(caught);
      if (message.toLowerCase().includes("cancel")) {
        state.setWarnings((current) => [...current, "Review cancelled."]);
      } else {
        state.setError(message);
      }
      state.setConversation((current) =>
        current?.id === state.conversation!.id
          ? {
              ...current,
              metadata: {
                ...current.metadata,
                implementationPlanAnswers: optimisticAnswers,
                planDecisionRequests: optimisticDecisionRequests,
                pendingDecisionSelections: currentDecisionAnswers,
                pendingDecisionResolutions: currentDecisionResolutions,
                pendingDecisions,
                running: false
              }
            }
          : current
      );
    } finally {
      state.setBusy(false);
      state.setCurrentRunId(undefined);
      markConversationNotRunning();
    }
  }

  async function selectDecisionAnswer(decisionId: string, optionId: string): Promise<void> {
    if (!state.conversation) return;
    const nextAnswers = { ...pendingDecisionSelections(state.conversation), ...state.decisionAnswers, [decisionId]: optionId };
    state.setDecisionAnswers(nextAnswers);
    state.setConversation((current) => current?.id === state.conversation!.id
      ? { ...current, metadata: { ...current.metadata, pendingDecisionSelections: nextAnswers } }
      : current);
    try {
      const saved = await window.consensus.saveDecisionSelections(state.conversation.id, nextAnswers);
      if (saved) {
        state.setConversation((current) => current?.id === saved.id ? { ...saved, messages: current.messages, findings: current.findings } : current);
      }
      await conversationActions.refreshConversations();
    } catch (caught) {
      state.setError(`Could not save decision selection: ${errorText(caught)}`);
    }
  }

  async function resolveDecisionThread(decisionId: string): Promise<void> {
    if (!state.conversation) return;
    state.setError(undefined);
    const nextResolutions = { ...pendingDecisionResolutions(state.conversation), ...state.resolvedDecisionThreads, [decisionId]: true };
    state.setResolvedDecisionThreads(nextResolutions);
    state.setConversation((current) => current?.id === state.conversation!.id
      ? { ...current, metadata: { ...current.metadata, pendingDecisionResolutions: nextResolutions } }
      : current);
    try {
      const saved = await window.consensus.saveDecisionResolutions(state.conversation.id, nextResolutions);
      if (saved) {
        state.setConversation((current) => current?.id === saved.id ? { ...saved, messages: current.messages, findings: current.findings } : current);
      }
      await conversationActions.refreshConversations();
    } catch (caught) {
      state.setError(`Could not save decision resolution: ${errorText(caught)}`);
    }
  }

  async function askDecisionClarification(decisionId: string): Promise<void> {
    if (!state.conversation) return;
    const question = state.clarificationDrafts[decisionId]?.trim();
    if (!question) {
      state.setError("Enter a thread message.");
      return;
    }
    const runId = crypto.randomUUID();
    const pendingReply: PlanDecisionReply = {
      id: `pending:${runId}`,
      decisionId,
      role: "user",
      content: question,
      createdAt: new Date().toISOString(),
      status: "done"
    };
    state.setError(undefined);
    state.setCurrentRunId(runId);
    state.setSelectedThreadId(decisionId);
    state.setFocusedThreadId(decisionId);
    state.setClarificationDrafts((current) => ({ ...current, [decisionId]: "" }));
    state.setPendingClarifications((current) => ({ ...current, [decisionId]: pendingReply }));
    state.progressLogRef.current = [];
    state.setProgressLog([]);
    state.setBusy(true);
    try {
      const result = await window.consensus.askPlanDecisionClarification({ conversationId: state.conversation.id, decisionId, question, runId });
      state.setConversation(mergeProgressIntoConversation(result.conversation, state.progressLogRef.current.filter((item) => item.runId === runId)));
      state.setWarnings(result.warnings);
      state.setClarificationDrafts((current) => ({ ...current, [decisionId]: "" }));
      clearPendingClarification(decisionId);
      state.setSelectedThreadId(decisionId);
      state.setFocusedThreadId(decisionId);
      await conversationActions.refreshConversations();
    } catch (caught) {
      const message = errorText(caught);
      if (message.toLowerCase().includes("cancel")) {
        state.setWarnings((current) => [...current, "Clarification cancelled."]);
      } else {
        state.setError(message);
      }
      state.setClarificationDrafts((current) => ({ ...current, [decisionId]: question }));
    } finally {
      state.setBusy(false);
      state.setCurrentRunId(undefined);
      clearPendingClarification(decisionId);
    }
  }

  async function confirmPlanItem(findingId: string): Promise<void> {
    await savePlanItemReview(findingId, { confirmed: true });
  }

  async function commentOnPlanItem(findingId: string): Promise<void> {
    if (!state.conversation) return;
    const comment = state.planItemReviewDrafts[findingId]?.trim();
    if (!comment) {
      state.setError("Enter an item comment.");
      return;
    }
    const saved = await savePlanItemReview(findingId, { comment });
    if (saved) {
      state.setPlanItemReviewDrafts((current) => ({ ...current, [findingId]: "" }));
    }
  }

  async function savePlanItemReview(findingId: string, patch: { confirmed?: boolean; comment?: string }): Promise<boolean> {
    if (!state.conversation) return false;
    state.setError(undefined);
    try {
      const saved = await window.consensus.savePlanItemReview({ conversationId: state.conversation.id, findingId, ...patch });
      if (saved) state.setConversation(saved);
      await conversationActions.refreshConversations();
      return true;
    } catch (caught) {
      state.setError(errorText(caught));
      return false;
    }
  }

  function clearReviewDraftState(): void {
    state.setDecisionAnswers({});
    state.setResolvedDecisionThreads({});
    state.setClarificationDrafts({});
    state.setPendingClarifications({});
    state.setPlanItemReviewDrafts({});
    state.setPlanCorrectionDraft("");
  }

  function clearPendingClarification(decisionId: string): void {
    state.setPendingClarifications((current) => {
      const next = { ...current };
      delete next[decisionId];
      return next;
    });
  }

  function markConversationNotRunning(): void {
    const conversationId = state.conversation?.id;
    state.setConversation((current) => {
      if (!current || current.id !== conversationId || current.metadata.running !== true) {
        return current;
      }
      return { ...current, metadata: { ...current.metadata, running: false } };
    });
  }

  return { continueReview, selectDecisionAnswer, resolveDecisionThread, askDecisionClarification, confirmPlanItem, commentOnPlanItem };
}

function buildPlanDecisionAnswers(
  pendingDecisions: ReturnType<typeof pendingPlanDecisions>,
  currentDecisionAnswers: Record<string, string>,
  currentDecisionResolutions: Record<string, boolean>,
  decisionReplies: PlanDecisionReply[],
  savedAnswers: PlanDecisionAnswer[]
): PlanDecisionAnswer[] {
  return pendingDecisions.flatMap((decision) => {
    const savedAnswer = decisionAnswerForDecision(decision, savedAnswers);
    const selectedOptionId = currentDecisionAnswers[decision.id] ?? savedAnswer?.selectedOptionId;
    const option = decision.options.find((item) => item.id === selectedOptionId);
    const hasFreshInput = decisionThreadIsReady(decision, currentDecisionAnswers, currentDecisionResolutions);
    if (!hasFreshInput && savedAnswer) return [savedAnswer];
    if (!hasFreshInput) return [];
    const answerSelection = selectedOptionId ? { ...currentDecisionAnswers, [decision.id]: selectedOptionId } : currentDecisionAnswers;
    const generatedAnswer = decisionThreadAnswer(decision, answerSelection, decisionReplies);
    return [{
      decisionId: decision.id,
      decisionKey: planDecisionKey(decision),
      selectedOptionId: option ? selectedOptionId : undefined,
      answer: generatedAnswer,
      answerSource: "user"
    }];
  });
}
