import type { Conversation } from "../../shared/types";
import { CONVERSATION_MESSAGE_PAGE_SIZE, mergeLoadedMessagePage, prependMissingMessages } from "../lib/conversation-message-pages";
import {
  errorText,
  firstPendingPlanItemReview,
  mergeProgressIntoConversation,
  pendingDecisionResolutions,
  pendingDecisionSelections,
  pendingPlanDecisions
} from "../components/review/review-conversation-data";
import { defaultChatParticipantDraft } from "../components/chat/chat-participant-drafts";
import type { AppState } from "./app-state";
import { normalizeProjectPath, upsertConversationSummary } from "./conversation-summaries";
import { persistLastViewedAt } from "./storage";

export interface ConversationActions {
  refreshAll: () => Promise<void>;
  refreshConversations: () => Promise<void>;
  openConversation: (id: string) => Promise<void>;
  loadOlderConversationMessages: () => Promise<void>;
  loadConversationMessagePageForMessage: (messageId: string) => Promise<boolean>;
  jumpToParticipantLastMessage: (participantId: string) => void;
  selectRepo: () => Promise<void>;
  inspectRepo: (path?: string, options?: { remember?: boolean }) => Promise<void>;
  rememberRepoPath: (path: string) => Promise<void>;
  cancelReview: () => Promise<void>;
  newReview: () => void;
  newProjectSession: (projectRepoPath?: string) => Promise<void>;
  updateSelectedChatParticipantConfigIds: React.Dispatch<React.SetStateAction<Set<string>>>;
}

export function useConversationActions(state: AppState): ConversationActions {
  async function refreshConversations(): Promise<void> {
    state.setSummaries(await window.consensus.listConversations());
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
    const requestId = state.openConversationRequestRef.current + 1;
    state.openConversationRequestRef.current = requestId;
    state.setError(undefined);
    if (state.conversation?.id !== id) {
      state.setWarnings([]);
    }
    if (state.conversation?.id === id) {
      state.setOpeningConversationId(undefined);
      return;
    }
    state.setOpeningConversationId(id);
    try {
      await waitForNextFrame();
      const result = await window.consensus.openConversation(id, CONVERSATION_MESSAGE_PAGE_SIZE);
      if (requestId !== state.openConversationRequestRef.current) {
        return;
      }
      const next = result?.conversation;
      const nextPendingDecisions = pendingPlanDecisions(next);
      const nextPendingItem = firstPendingPlanItemReview(next);
      state.setConversation(next);
      state.setMessagePage(result?.messagePage);
      if (next) {
        state.setKind(next.kind);
        state.lastViewedAtRef.current = { ...state.lastViewedAtRef.current, [next.id]: next.updatedAt };
        persistLastViewedAt(state.lastViewedAtRef.current);
        state.setUnreadConversationIds((prev) => {
          if (!prev.has(next.id)) return prev;
          const ns = new Set(prev);
          ns.delete(next.id);
          return ns;
        });
      }
      state.setSelectedThreadId(nextPendingDecisions[0]?.id ?? nextPendingItem?.id);
      state.setFocusedThreadId(undefined);
      state.setDecisionAnswers(pendingDecisionSelections(next));
      state.setResolvedDecisionThreads(pendingDecisionResolutions(next));
      state.setClarificationDrafts({});
      state.setPendingClarifications({});
      state.setPlanItemReviewDrafts({});
      state.setPlanCorrectionDraft("");
    } catch (caught) {
      if (requestId === state.openConversationRequestRef.current) {
        state.setError(errorText(caught));
      }
    } finally {
      if (requestId === state.openConversationRequestRef.current) {
        state.setOpeningConversationId(undefined);
      }
    }
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

  function newReview(): void {
    if (state.busy) return;
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

  async function newProjectSession(projectRepoPath?: string): Promise<void> {
    if (state.busy) return;
    const nextRepoPath = normalizeProjectPath(projectRepoPath) ?? "";
    newReview();
    state.setRepoPath(nextRepoPath);
    state.setRepoInfo(undefined);
    if (nextRepoPath) {
      await inspectRepo(nextRepoPath);
    }
  }

  return {
    refreshAll, refreshConversations, openConversation, loadOlderConversationMessages,
    loadConversationMessagePageForMessage, jumpToParticipantLastMessage, selectRepo,
    inspectRepo, rememberRepoPath, cancelReview, newReview, newProjectSession,
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
