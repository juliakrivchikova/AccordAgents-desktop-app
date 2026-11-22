import { useMemo } from "react";
import type { Conversation } from "../../shared/types";
import { buildChatParticipantStatusMap, chatMemberIdsWithLiveWork } from "../../shared/chatRosterStatus";
import { useChatBackgroundTasks } from "../components/chat/use-chat-background-tasks";
import { chatParticipants } from "../components/chat/chat-conversation-data";
import {
  canRecoverImplementationPlan,
  conversationRelevantRunIds,
  pendingDecisionResolutions,
  pendingDecisionSelections,
  pendingPlanDecisions,
  pendingPlanItemReview,
  planItemReviewForFinding,
  planItemReviews,
  requiredPlanItemReviewFindings
} from "../components/review/review-conversation-data";
import { buildProjectSessionGroups, compareConversationSummaries, pinnedChatSummaries, recentChatSummaries } from "./conversation-summaries";
import type { AppState } from "./app-state";
import { useDelayedFlag } from "@/components/ui/delayed";
import { warningDismissScope, warningNoticeEntries } from "./warnings";
import { sessionsViewNamesOf, sessionsViewText, type SessionsViewNames } from "../../shared/sessionsViewText";

export function useAppViewModel(state: AppState) {
  const openingConversation = state.openingConversationId
    ? state.summaries.find((summary) => summary.id === state.openingConversationId)
    : undefined;
  const isOpeningConversation = Boolean(state.openingConversationId);
  // A chat being opened takes the screen once it is in, or once the wait
  // lasts: a quick open keeps what was there (the New chat screen, say)
  // instead of a blank panel for a tenth of a second.
  const openingSlow = useDelayedFlag(isOpeningConversation);
  // A new chat still checking its CLIs (no run id yet) keeps New chat on
  // screen, its send button busy and its choices in place.
  const startCheckingClis = state.busy && state.startingChatRef.current && !state.currentRunId && !state.conversation;
  const hasResultContext = Boolean(state.conversation) || (state.busy && !startCheckingClis) || (isOpeningConversation && openingSlow);
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
  // The open chat's view words the notices: the sessions view names nobody
  // by handle (shared/sessionsViewText.ts); the classic view as written.
  // The names are read from the chat only when a notice names someone.
  const noticeText = useMemo(() => {
    const conversation = state.conversation;
    let names: SessionsViewNames | undefined | null = null;
    return (text: string): string => {
      if (!text.includes("@")) return text;
      if (names === null) names = conversation?.kind === "chat" ? sessionsViewNamesOf(conversation, state.settings.defaultChatView) : undefined;
      return sessionsViewText(text, names);
    };
  }, [state.conversation, state.settings.defaultChatView]);
  const visibleWarnings = warningNoticeEntries([...state.warnings, ...conversationMetadataWarnings], dismissedWarningKeys, noticeText);
  const chatSummaries = useMemo(() => state.summaries.filter((summary) => summary.kind === "chat"), [state.summaries]);
  const projectSessionGroups = useMemo(() => buildProjectSessionGroups(chatSummaries), [chatSummaries]);
  const pinnedSessions = useMemo(() => pinnedChatSummaries(chatSummaries), [chatSummaries]);
  const recentSessions = useMemo(() => recentChatSummaries(chatSummaries), [chatSummaries]);
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
  const participantBackgroundTasksById = useChatBackgroundTasks(activeChatConversation?.id);
  const participantStatusById = useMemo(
    () => buildChatParticipantStatusMap(activeChatConversation, participantBackgroundTasksById),
    [activeChatConversation, participantBackgroundTasksById]
  );
  const participantHasRunById = useMemo(() => buildParticipantHasRunMap(activeChatConversation), [activeChatConversation]);
  // Only a busy member's removal waits; the others can be removed meanwhile.
  const busyParticipantIds = useMemo<ReadonlySet<string>>(
    () => activeChatConversation ? chatMemberIdsWithLiveWork(activeChatConversation) : new Set(),
    [activeChatConversation]
  );

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
    noticeText,
    projectSessionGroups,
    pinnedSessions,
    recentSessions,
    archivedSessions,
    visibleProgressLog,
    activeChatConversation,
    activeChatParticipants,
    participantStatusById,
    participantBackgroundTasksById,
    participantHasRunById,
    busyParticipantIds
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
