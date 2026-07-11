import type { ChatActivityItem, ChatMessage, Conversation } from "../../shared/types";
import { buildChatActivityItems, reconcileChatActivityRefreshItems } from "../../shared/chatActivity";
import { executeChatActivityFocus } from "../../shared/chatActivityFocus";
import {
  CONVERSATION_MESSAGE_PAGE_SIZE,
  mergeLoadedMessagePage,
  mergeMissingMessagesByCreatedAt,
  prependMissingMessages
} from "../lib/conversation-message-pages";
import {
  errorText,
  firstPendingPlanItemReview,
  pendingDecisionResolutions,
  pendingDecisionSelections,
  pendingPlanDecisions
} from "../components/review/review-conversation-data";
import { defaultChatParticipantDraft } from "../components/chat/chat-participant-drafts";
import type { AppState } from "./app-state";
import { conversationTimeValue, normalizeProjectPath } from "./conversation-summaries";
import { persistLastViewedAt } from "./storage";
import { activityItemsWithStoredPreferences } from "./activity-item-state";

export interface ConversationActions {
  refreshAll: () => Promise<void>;
  refreshActivity: () => Promise<void>;
  refreshConversations: () => Promise<void>;
  openConversation: (id: string) => Promise<void>;
  openConversationAndFocusActivityItem: (item: ChatActivityItem, options?: { timelineOnly?: boolean; markViewed?: boolean }) => Promise<void>;
  markConversationViewed: (conversation: Conversation) => void;
  clearChatMessageFocus: () => void;
  loadOlderConversationMessages: () => Promise<void>;
  loadConversationMessagePageForMessage: (messageId: string) => Promise<boolean>;
  jumpToParticipantLastMessage: (participantId: string) => void;
  selectRepo: () => Promise<void>;
  inspectRepo: (path?: string, options?: { remember?: boolean }) => Promise<void>;
  rememberRepoPath: (path: string) => Promise<void>;
  cancelReview: () => Promise<void>;
  newChatSession: () => Promise<void>;
  newProjectSession: (projectRepoPath?: string) => Promise<void>;
  updateSelectedChatParticipantConfigIds: React.Dispatch<React.SetStateAction<Set<string>>>;
}

export function useConversationActions(state: AppState): ConversationActions {
  async function refreshConversations(): Promise<void> {
    const summaries = await window.consensus.listConversations();
    state.archivedConversationIdsRef.current = new Set(
      summaries.filter((summary) => summary.archived === true).map((summary) => summary.id)
    );
    state.setSummaries(summaries);
  }

  async function refreshActivity(): Promise<void> {
    const requestId = state.activityRefreshRequestRef.current + 1;
    state.activityRefreshRequestRef.current = requestId;
    const revisionsAtStart = { ...state.activityRevisionByConversationRef.current };
    state.setActivityLoading(true);
    state.setActivityError(undefined);
    try {
      const result = await window.consensus.listChatActivity({
        lastViewedAtByConversationId: state.lastViewedAtRef.current,
        excludedItemIds: [...state.activityItemPreferencesRef.current.clearedItemIds]
      });
      if (requestId !== state.activityRefreshRequestRef.current) {
        return;
      }
      state.setActivityItems((current) => {
        return reconcileChatActivityRefreshItems(current, activityItemsWithStoredPreferences(state, result.items), {
          revisionsAtStart,
          revisionsNow: state.activityRevisionByConversationRef.current,
          archivedConversationIds: state.archivedConversationIdsRef.current
        });
      });
      state.setSelectedActivityItem((current) =>
        current && state.archivedConversationIdsRef.current.has(current.conversationId) ? undefined : current
      );
    } catch (caught) {
      if (requestId === state.activityRefreshRequestRef.current) {
        state.setActivityError(errorText(caught));
      }
    } finally {
      if (requestId === state.activityRefreshRequestRef.current) {
        state.setActivityLoading(false);
      }
    }
  }

  async function refreshAll(): Promise<void> {
    state.setError(undefined);
    state.setHistoryLoading(true);
    try {
      const [nextSettings, nextAgents, nextSummaries] = await Promise.all([
        window.consensus.getSettings(),
        window.consensus.detectAgents(),
        window.consensus.listConversations()
      ]);
      const seededSettings = await window.consensus.getSettings();
      state.setSettings(seededSettings);
      state.setAgents(nextAgents);
      state.archivedConversationIdsRef.current = new Set(
        nextSummaries.filter((summary) => summary.archived === true).map((summary) => summary.id)
      );
      state.setSummaries(nextSummaries);
      const explicitRepoPath = (seededSettings.lastRepoPath ?? nextSettings.lastRepoPath)?.trim();
      const rememberedRepoPath = explicitRepoPath || nextSummaries.find((summary) => summary.repoPath?.trim())?.repoPath?.trim();
      if (!state.repoPath.trim() && rememberedRepoPath) {
        state.setRepoPath(rememberedRepoPath);
        await inspectRepo(rememberedRepoPath, { remember: !explicitRepoPath });
      }
    } catch (caught) {
      state.setError(errorText(caught));
    } finally {
      state.setInitializing(false);
      state.setHistoryLoading(false);
    }
  }

  async function openConversation(id: string): Promise<void> {
    clearChatMessageFocus();
    await openConversationForSelection(id);
  }

  async function openConversationForSelection(id: string, options: { markViewed?: boolean } = {}): Promise<Conversation | undefined> {
    const markViewed = options.markViewed !== false;
    const requestId = state.openConversationRequestRef.current + 1;
    state.openConversationRequestRef.current = requestId;
    state.setError(undefined);
    if (state.conversation?.id !== id) {
      state.setWarnings([]);
    }
    if (state.conversation?.id === id) {
      state.setOpeningConversationId(undefined);
      if (markViewed) {
        markConversationViewed(state.conversation);
      }
      return state.conversation;
    }
    state.setOpeningConversationId(id);
    try {
      await waitForNextFrame();
      const result = await window.consensus.openConversation(id, CONVERSATION_MESSAGE_PAGE_SIZE);
      if (requestId !== state.openConversationRequestRef.current) {
        return undefined;
      }
      const next = result?.conversation;
      const nextPendingDecisions = pendingPlanDecisions(next);
      const nextPendingItem = firstPendingPlanItemReview(next);
      state.setConversation(next);
      state.setMessagePage(result?.messagePage);
      if (next) {
        state.setKind(next.kind);
        if (markViewed) {
          markConversationViewed(next);
        }
      }
      state.setSelectedThreadId(nextPendingDecisions[0]?.id ?? nextPendingItem?.id);
      state.setFocusedThreadId(undefined);
      state.setDecisionAnswers(pendingDecisionSelections(next));
      state.setResolvedDecisionThreads(pendingDecisionResolutions(next));
      state.setClarificationDrafts({});
      state.setPendingClarifications({});
      state.setPlanItemReviewDrafts({});
      state.setPlanCorrectionDraft("");
      return next;
    } catch (caught) {
      if (requestId === state.openConversationRequestRef.current) {
        state.setError(errorText(caught));
      }
      return undefined;
    } finally {
      if (requestId === state.openConversationRequestRef.current) {
        state.setOpeningConversationId(undefined);
      }
    }
  }

  async function openConversationAndFocusActivityItem(item: ChatActivityItem, options: { timelineOnly?: boolean; markViewed?: boolean } = {}): Promise<void> {
    const initialTarget = activityFocusTarget(item, options);
    const pendingFocusNonce = state.chatMessageFocusNonceRef.current + 1;
    state.chatMessageFocusNonceRef.current = pendingFocusNonce;
    state.setActivityFocusError(undefined);
    state.setChatMessageFocusRequest({
      conversationId: item.conversationId,
      messageId: initialTarget.messageId,
      threadRootId: initialTarget.threadRootId,
      nonce: pendingFocusNonce,
      pending: true
    });
    let conversationRequestId: number | undefined;
    const isCurrent = (): boolean =>
      state.chatMessageFocusNonceRef.current === pendingFocusNonce &&
      (conversationRequestId === undefined || state.openConversationRequestRef.current === conversationRequestId);

    await executeChatActivityFocus<Conversation, ChatActivityItem>({
      isCurrent,
      openConversation: async () => {
        const conversation = await openConversationForSelection(item.conversationId, { markViewed: options.markViewed });
        conversationRequestId = state.openConversationRequestRef.current;
        return conversation;
      },
      resolveTarget: (conversation) => {
        const resolvedItem = resolveLoadedActivityItemTarget(item, conversation);
        const target = activityFocusTarget(resolvedItem, options);
        return target.messageId ? resolvedItem : undefined;
      },
      onTargetResolved: (resolvedItem) => {
        state.setSelectedActivityItem((current) => current?.id === item.id ? resolvedItem : current);
      },
      ensureTargetLoaded: (conversation, resolvedItem) => {
        const target = activityFocusTarget(resolvedItem, options);
        return ensureActivityTargetMessagesLoaded(conversation, target.messageId, target.threadRootId, isCurrent);
      },
      beforeCommit: waitForNextFrame,
      commit: (resolvedItem) => {
        const target = activityFocusTarget(resolvedItem, options);
        state.setChatMessageFocusRequest({
          conversationId: item.conversationId,
          messageId: target.messageId,
          threadRootId: target.threadRootId,
          nonce: pendingFocusNonce
        });
      },
      clear: () => clearPendingActivityFocus(pendingFocusNonce),
      fail: (caught) => {
        state.setActivityFocusError(errorText(caught));
      }
    });
  }

  function activityFocusTarget(
    item: ChatActivityItem,
    options: { timelineOnly?: boolean }
  ): { messageId: string; threadRootId?: string } {
    const messageId = item.target.messageId?.trim() ?? "";
    const threadRootId = item.target.threadRootId?.trim() || undefined;
    if (options.timelineOnly && threadRootId) {
      return { messageId: threadRootId };
    }
    return { messageId, threadRootId };
  }

  function clearChatMessageFocus(): void {
    state.chatMessageFocusNonceRef.current += 1;
    state.setChatMessageFocusRequest(undefined);
    state.setActivityFocusError(undefined);
  }

  function clearPendingActivityFocus(nonce: number): void {
    state.setChatMessageFocusRequest((current) => current?.nonce === nonce ? undefined : current);
  }

  function resolveLoadedActivityItemTarget(item: ChatActivityItem, conversation: Conversation): ChatActivityItem {
    if (item.target.messageId?.trim()) {
      return item;
    }
    const candidates = buildChatActivityItems(conversation, {
      lastViewedAt: state.lastViewedAtRef.current[conversation.id]
    });
    return candidates.find((candidate) => candidate.id === item.id && candidate.target.messageId?.trim())
      ?? candidates.find((candidate) =>
        candidate.kind === item.kind &&
        candidate.target.messageId?.trim() &&
        candidate.target.runId &&
        candidate.target.runId === item.target.runId
      )
      ?? resolveRunActivityItemFromLoadedMessages(item, conversation)
      ?? item;
  }

  function resolveRunActivityItemFromLoadedMessages(item: ChatActivityItem, conversation: Conversation): ChatActivityItem | undefined {
    if (item.status !== "running" && item.kind !== "run") {
      return undefined;
    }
    const runId = item.target.runId?.trim();
    const message = runId
      ? [...conversation.messages].reverse().find((candidate) => {
        const metadata = candidate.metadata as Record<string, unknown> | undefined;
        return metadata?.runId === runId || metadata?.remoteRunId === runId;
      })
      : undefined;
    const fallbackMessage = message ?? [...conversation.messages].reverse().find((candidate) =>
      candidate.role === "participant" &&
      candidate.status === "pending"
    );
    if (!fallbackMessage) {
      return undefined;
    }
    return {
      ...item,
      target: {
        ...item.target,
        messageId: fallbackMessage.id,
        threadRootId: loadedMessageThreadRootId(fallbackMessage) ?? item.target.threadRootId
      }
    };
  }

  function loadedMessageThreadRootId(message: ChatMessage): string | undefined {
    const metadata = message.metadata as Record<string, unknown> | undefined;
    const value = metadata?.chatThreadRootId ?? metadata?.parentMessageId ?? metadata?.threadId;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  async function ensureActivityTargetMessagesLoaded(
    conversation: Conversation,
    messageId: string,
    threadRootId: string | undefined,
    isCurrent: () => boolean
  ): Promise<boolean> {
    let loadedMessages = conversation.messages;
    const targetIds = [...new Set([messageId, threadRootId].filter((id): id is string => Boolean(id)))];
    for (const targetId of targetIds) {
      if (!isCurrent()) {
        return false;
      }
      if (loadedMessages.some((message) => message.id === targetId)) {
        continue;
      }
      const page = await window.consensus.listConversationMessages({
        conversationId: conversation.id,
        aroundMessageId: targetId,
        limit: CONVERSATION_MESSAGE_PAGE_SIZE
      });
      if (!isCurrent()) {
        return false;
      }
      if (page.messages.length === 0) {
        throw new Error("The selected activity message is no longer available.");
      }
      loadedMessages = mergeMissingMessagesByCreatedAt(loadedMessages, page.messages);
      state.setConversation((current) => current?.id === conversation.id
        ? { ...current, messages: mergeMissingMessagesByCreatedAt(current.messages, page.messages) }
        : current);
      state.setMessagePage((current) => mergeLoadedMessagePage(current, page));
    }
    return targetIds.every((targetId) => loadedMessages.some((message) => message.id === targetId));
  }

  function markConversationViewed(conversation: Conversation): void {
    state.lastViewedAtRef.current = { ...state.lastViewedAtRef.current, [conversation.id]: conversation.updatedAt };
    persistLastViewedAt(state.lastViewedAtRef.current);
    state.setUnreadConversationIds((prev) => {
      if (!prev.has(conversation.id)) return prev;
      const ns = new Set(prev);
      ns.delete(conversation.id);
      return ns;
    });
    state.setActivityItems((current) =>
      current.map((item) => item.conversationId === conversation.id && item.status === "recent"
        ? { ...item, read: true }
        : item)
    );
    state.setSelectedActivityItem((current) => current?.conversationId === conversation.id && current.status === "recent"
      ? { ...current, read: true }
      : current);
  }

  async function loadOlderConversationMessages(): Promise<void> {
    if (!state.conversation || !state.messagePage?.hasMoreBefore || state.olderMessagesLoading || state.messagePage.oldestSequence === undefined) {
      return;
    }
    const conversationId = state.conversation.id;
    state.setOlderMessagesLoading(true);
    state.setError(undefined);
    try {
      const page = await window.consensus.listConversationMessages({
        conversationId,
        beforeSequence: state.messagePage.oldestSequence,
        limit: CONVERSATION_MESSAGE_PAGE_SIZE
      });
      state.setConversation((current) => current?.id === conversationId
        ? { ...current, messages: prependMissingMessages(current.messages, page.messages) }
        : current);
      state.setMessagePage((current) => mergeLoadedMessagePage(current, page));
    } catch (caught) {
      state.setError(errorText(caught));
    } finally {
      state.setOlderMessagesLoading(false);
    }
  }

  async function loadConversationMessagePageForMessage(messageId: string): Promise<boolean> {
    if (!state.conversation || !state.messagePage?.hasMoreBefore || state.messagePage.oldestSequence === undefined || state.olderMessagesLoading) {
      return false;
    }
    if (state.conversation.messages.some((message) => message.id === messageId)) {
      return true;
    }
    const conversationId = state.conversation.id;
    const loadedMessages: Conversation["messages"] = [];
    state.setOlderMessagesLoading(true);
    state.setError(undefined);
    try {
      const targetPage = await window.consensus.listConversationMessages({ conversationId, aroundMessageId: messageId, limit: 1 });
      const targetSequence = targetPage.newestSequence;
      if (targetSequence === undefined || targetSequence >= state.messagePage.oldestSequence) {
        return false;
      }
      let beforeSequence: number | undefined = state.messagePage.oldestSequence;
      let lastPage = targetPage;
      let found = false;
      while (beforeSequence !== undefined && beforeSequence > targetSequence) {
        const page = await window.consensus.listConversationMessages({ conversationId, beforeSequence, limit: CONVERSATION_MESSAGE_PAGE_SIZE });
        if (page.messages.length === 0) break;
        loadedMessages.unshift(...page.messages);
        lastPage = page;
        if (page.messages.some((message) => message.id === messageId)) {
          found = true;
          break;
        }
        if (!page.hasMoreBefore || page.oldestSequence === undefined) break;
        beforeSequence = page.oldestSequence;
      }
      if (!found) return false;
      state.setConversation((current) => current?.id === conversationId
        ? { ...current, messages: prependMissingMessages(current.messages, loadedMessages) }
        : current);
      state.setMessagePage((current) => mergeLoadedMessagePage(current, lastPage));
      return true;
    } catch (caught) {
      state.setError(errorText(caught));
      return false;
    } finally {
      state.setOlderMessagesLoading(false);
    }
  }

  function jumpToParticipantLastMessage(participantId: string): void {
    const entry = state.conversation?.metadata.lastMessageByParticipant?.[participantId];
    if (!entry || typeof entry.messageId !== "string" || !entry.messageId.trim()) {
      return;
    }
    state.chatMessageFocusNonceRef.current += 1;
    state.setChatMessageFocusRequest({
      conversationId: state.conversation?.id,
      messageId: entry.messageId,
      threadRootId: typeof entry.threadRootId === "string" && entry.threadRootId.trim() ? entry.threadRootId : undefined,
      nonce: state.chatMessageFocusNonceRef.current
    });
  }

  async function selectRepo(): Promise<void> {
    const selected = await window.consensus.selectRepoDirectory();
    if (!selected) return;
    state.setRepoPath(selected);
    await inspectRepo(selected);
  }

  async function inspectRepo(path: string = state.repoPath, options: { remember?: boolean } = {}): Promise<void> {
    if (!path.trim()) return;
    state.setError(undefined);
    try {
      const info = await window.consensus.inspectRepo(path.trim());
      state.setRepoInfo(info);
      if (info.isRepo && options.remember !== false) {
        await rememberRepoPath(info.repoPath || path.trim());
      }
    } catch (caught) {
      state.setError(errorText(caught));
    }
  }

  async function rememberRepoPath(path: string): Promise<void> {
    const normalized = path.trim();
    if (!normalized) return;
    try {
      await window.consensus.updateLastRepoPath(normalized);
      state.setSettings((current) => ({ ...current, lastRepoPath: normalized }));
    } catch (caught) {
      state.setError(errorText(caught));
    }
  }

  async function cancelReview(): Promise<void> {
    if (state.currentRunId) {
      await window.consensus.cancelReview(state.currentRunId);
    }
  }

  async function newChatSession(): Promise<void> {
    if (state.busy) return;
    const nextRepoPath = preferredNewChatRepoPath();
    resetNewChatState();
    await applyNewChatRepoPath(nextRepoPath);
  }

  async function newProjectSession(projectRepoPath?: string): Promise<void> {
    if (state.busy) return;
    const nextRepoPath = normalizeProjectPath(projectRepoPath) ?? "";
    resetNewChatState();
    await applyNewChatRepoPath(nextRepoPath);
  }

  function resetNewChatState(): void {
    clearChatMessageFocus();
    state.setConversation(undefined);
    state.setMessagePage(undefined);
    state.setOlderMessagesLoading(false);
    state.progressLogRef.current = [];
    state.setProgressLog([]);
    state.setSelectedThreadId(undefined);
    state.setFocusedThreadId(undefined);
    state.setWarnings([]);
    state.setDecisionAnswers({});
    state.setResolvedDecisionThreads({});
    state.setClarificationDrafts({});
    state.setPendingClarifications({});
    state.setPlanItemReviewDrafts({});
    state.setPlanCorrectionDraft("");
    state.setChatMessageDraft("");
    state.setChatAddParticipantDraft(defaultChatParticipantDraft(state.settings));
    state.setSelectedChatParticipantConfigIds(defaultSelectedChatParticipantConfigIds());
    state.setSelectedChatParticipantRunLocations({});
    state.setKind("chat");
    state.setQuestion("");
    state.setRepoPath("");
    state.setRepoInfo(undefined);
    state.setError(undefined);
  }

  async function applyNewChatRepoPath(nextRepoPath: string): Promise<void> {
    state.setRepoPath(nextRepoPath);
    state.setRepoInfo(undefined);
    if (nextRepoPath) {
      await inspectRepo(nextRepoPath);
    }
  }

  function preferredNewChatRepoPath(): string {
    return normalizeProjectPath(state.conversation?.repoPath)
      ?? normalizeProjectPath(state.repoPath)
      ?? normalizeProjectPath(state.settings.lastRepoPath)
      ?? newestSummaryRepoPath()
      ?? "";
  }

  function newestSummaryRepoPath(): string | undefined {
    let newest: { repoPath: string; updatedAt: string } | undefined;
    for (const summary of state.summaries) {
      const repoPath = normalizeProjectPath(summary.repoPath);
      if (!repoPath) continue;
      if (!newest || conversationTimeValue(summary.updatedAt) > conversationTimeValue(newest.updatedAt)) {
        newest = { repoPath, updatedAt: summary.updatedAt };
      }
    }
    return newest?.repoPath;
  }

  return {
    refreshAll, refreshActivity, refreshConversations, openConversation, openConversationAndFocusActivityItem, markConversationViewed, clearChatMessageFocus, loadOlderConversationMessages,
    loadConversationMessagePageForMessage, jumpToParticipantLastMessage, selectRepo,
    inspectRepo, rememberRepoPath, cancelReview, newChatSession, newProjectSession,
    updateSelectedChatParticipantConfigIds: state.setSelectedChatParticipantConfigIds
  };

  function defaultSelectedChatParticipantConfigIds(): Set<string> {
    return new Set();
  }
}

function waitForNextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}
