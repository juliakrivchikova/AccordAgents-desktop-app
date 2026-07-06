import { useMemo } from "react";
import type { Conversation, ConversationSummary } from "../../shared/types";
import { buildChatParticipantStatusMap } from "../../shared/chatRosterStatus";
import { chatParticipants } from "../components/chat/chat-conversation-data";
import {
  canRecoverImplementationPlan,
  conversationRelevantRunIds,
  firstPendingPlanItemReview,
  pendingDecisionResolutions,
  pendingDecisionSelections,
  pendingPlanDecisions,
  pendingPlanItemReview,
  planItemReviewForFinding,
  planItemReviews,
  requiredPlanItemReviewFindings
} from "../components/review/review-conversation-data";
import { buildProjectSessionGroups, compareConversationSummaries } from "./conversation-summaries";
import type { AppState } from "./app-state";
import { warningDismissScope, warningNoticeEntries } from "./warnings";

export function useAppViewModel(state: AppState) {
  const openingConversation = state.openingConversationId
    ? state.summaries.find((summary) => summary.id === state.openingConversationId)
    : undefined;
  const isOpeningConversation = Boolean(state.openingConversationId);
  const hasResultContext = Boolean(state.conversation) || state.busy || isOpeningConversation;
  const pendingDecisions = pendingPlanDecisions(state.conversation);
  const reviewablePlanItems = requiredPlanItemReviewFindings(state.conversation);
  const reviewedPlanItemCount = reviewablePlanItems.filter((finding) => planItemReviewForFinding(finding, planItemReviews(state.conversation))).length;
  const isPendingPlanItemReview = pendingPlanItemReview(state.conversation);
  const canComposePlan = isPendingPlanItemReview && reviewedPlanItemCount === reviewablePlanItems.length;
  const canRecoverPlan = canRecoverImplementationPlan(state.conversation, state.busy);
  const visibleDecisionAnswers = { ...pendingDecisionSelections(state.conversation), ...state.decisionAnswers };
  const visibleDecisionResolutions = { ...pendingDecisionResolutions(state.conversation), ...state.resolvedDecisionThreads };
  const conversationKind = state.conversation?.kind ?? openingConversation?.kind ?? state.kind;
  const conversationRunning = state.busy || Boolean(state.conversation?.metadata.running);
  const conversationMetadataWarnings = Array.isArray(state.conversation?.metadata?.warnings)
    ? (state.conversation!.metadata.warnings as unknown[]).filter((w): w is string => typeof w === "string")
    : [];
  const warningScope = warningDismissScope(state.conversation);
  const dismissedWarningKeys = new Set(state.dismissedWarningKeysByScope[warningScope] ?? []);
  const visibleWarnings = warningNoticeEntries([...state.warnings, ...conversationMetadataWarnings], dismissedWarningKeys);
  const chatSummaries = useMemo(() => state.summaries.filter((summary) => summary.kind === "chat"), [state.summaries]);
  const projectSessionGroups = useMemo(() => buildProjectSessionGroups(chatSummaries), [chatSummaries]);
  const archivedSessions = useMemo(
    () => chatSummaries.filter((summary) => summary.archived).sort(compareConversationSummaries),
    [chatSummaries]
  );
  const visibleProgressLog = useMemo(() => {
    if (!state.conversation) {
      return state.progressLog;
    }
    const relevantRunIds = conversationRelevantRunIds(state.conversation);
    if (relevantRunIds.size === 0) {
      return [];
    }
    return state.progressLog.filter((item) => relevantRunIds.has(item.runId));
  }, [state.conversation, state.progressLog]);
  const activeChatConversation = state.conversation?.kind === "chat" ? state.conversation : undefined;
  const activeChatParticipants = useMemo(() => activeChatConversation ? chatParticipants(activeChatConversation) : [], [activeChatConversation]);
  const participantStatusById = useMemo(() => buildChatParticipantStatusMap(activeChatConversation), [activeChatConversation]);
  const participantHasRunById = useMemo(() => buildParticipantHasRunMap(activeChatConversation), [activeChatConversation]);

  return {
    openingConversation,
    isOpeningConversation,
    hasResultContext,
    pendingDecisions,
    reviewablePlanItems,
    reviewedPlanItemCount,
    canComposePlan,
    canRecoverPlan,
    visibleDecisionAnswers,
    visibleDecisionResolutions,
    conversationKind,
    conversationRunning,
    warningScope,
    visibleWarnings,
    projectSessionGroups,
    archivedSessions,
    visibleProgressLog,
    activeChatConversation,
    activeChatParticipants,
    participantStatusById,
    participantHasRunById
  };
}

function buildParticipantHasRunMap(activeChatConversation: Conversation | undefined): Map<string, boolean> {
  const markers = new Map<string, boolean>();
  if (!activeChatConversation) {
    return markers;
  }
  const participantIds = new Set(chatParticipants(activeChatConversation).map((participant) => participant.id));
  const sessions = Array.isArray(activeChatConversation.metadata.participantSessions)
    ? activeChatConversation.metadata.participantSessions
    : [];
  for (const session of sessions) {
    if (participantIds.has(session.participantId)) {
      markers.set(session.participantId, true);
    }
  }
  const handles = activeChatConversation.metadata.remoteRunHandles;
  if (handles && typeof handles === "object" && !Array.isArray(handles)) {
    for (const handle of Object.values(handles)) {
      if (handle && typeof handle === "object" && !Array.isArray(handle)) {
        const participantId = (handle as { participantId?: unknown }).participantId;
        if (typeof participantId === "string" && participantIds.has(participantId)) {
          markers.set(participantId, true);
        }
      }
    }
  }
  for (const message of activeChatConversation.messages) {
    if (message.role === "participant" && message.participantId && participantIds.has(message.participantId)) {
      markers.set(message.participantId, true);
    }
  }
  return markers;
}
