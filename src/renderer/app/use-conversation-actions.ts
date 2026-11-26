import type { AgentDetectionRequest, AgentHealth, ChatMessage, ChatRunningMessageTarget, ChatSearchMessageMatch, Conversation, ConversationSummary } from "../../shared/types";
import { reconcileConversationSummaryRefresh } from "../../shared/conversationSummary";
import { runningParticipantTarget } from "./running-participant-target";
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
import { revokePendingImageUrls } from "../components/chat/use-chat-composer-images";
import { compareConversationSummaries, conversationTimeValue, normalizeProjectPath } from "./conversation-summaries";
import { persistLastViewedAt } from "./storage";
import { focusConversationMessage } from "./focus-conversation-message";
import { dropComposerFocusRequestsExcept } from "./composer-focus-request";

export interface ConversationActions {
  refreshAll: () => Promise<void>;
  refreshAgents: (request?: AgentDetectionRequest) => Promise<AgentHealth[]>;
  refreshConversations: () => Promise<void>;
  openConversation: (id: string) => Promise<void>;
  openConversationAndFocusMessage: (target: Pick<ChatSearchMessageMatch, "conversationId" | "messageId" | "threadRootId">) => Promise<void>;
  markConversationViewed: (conversation: Conversation) => void;
  clearChatMessageFocus: () => void;
  loadOlderConversationMessages: () => Promise<void>;
  loadConversationMessagePageForMessage: (messageId: string) => Promise<boolean>;
  jumpToParticipantLastMessage: (participantId: string) => void;
  selectRepo: () => Promise<void>;
  inspectRepo: (path?: string, options?: { remember?: boolean }) => Promise<void>;
  rememberRepoPath: (path: string) => Promise<void>;
  cancelReview: () => Promise<void>;
  // False when it did not take over the screen (busy, or a chat opened meanwhile).
  newChatSession: () => Promise<boolean>;
  newProjectSession: (projectRepoPath?: string) => Promise<void>;
  updateSelectedChatParticipantConfigIds: React.Dispatch<React.SetStateAction<Set<string>>>;
}

export function useConversationActions(state: AppState): ConversationActions {
  async function refreshAgents(request?: AgentDetectionRequest): Promise<AgentHealth[]> {
    const requestId = state.agentRefreshRequestRef.current + 1;
    state.agentRefreshRequestRef.current = requestId;
    if (request?.force) {
      state.setAgents((current) => current.map((agent) => ({ ...agent, checking: true })));
    }
    try {
      const agents = await window.consensus.detectAgents(request);
      const settings = await window.consensus.getSettings();
      if (requestId === state.agentRefreshRequestRef.current) {
        state.setAgents(agents);
        state.setSettings(settings);
      }
      return agents;
    } catch (error) {
      if (requestId === state.agentRefreshRequestRef.current) {
        state.setAgents((current) => current.map((agent) => ({ ...agent, checking: false })));
      }
      throw error;
    }
  }

  async function refreshConversations(): Promise<void> {
    const requestId = ++state.summaryRefreshRequestRef.current;
    const revisionsAtStart = { ...state.activityRevisionByConversationRef.current };
    const summaries = await window.consensus.listConversations();
    applySummaryRefresh(summaries, requestId, revisionsAtStart);
  }

  function applySummaryRefresh(summaries: ConversationSummary[], requestId: number, revisionsAtStart: Record<string, number>): void {
    state.setSummaries(current => {
      if (requestId !== state.summaryRefreshRequestRef.current) return current;
      const merged = reconcileConversationSummaryRefresh(current, summaries, revisionsAtStart, state.activityRevisionByConversationRef.current);
      return merged.sort(compareConversationSummaries);
    });
  }

  async function refreshAll(): Promise<void> {
    const summaryRequestId = ++state.summaryRefreshRequestRef.current;
    const revisionsAtStart = { ...state.activityRevisionByConversationRef.current };
    state.setError(undefined);
    state.setHistoryLoading(true);
    try {
      const [nextSettings, nextAgents, nextSummaries] = await Promise.all([
        window.consensus.getSettings(),
        refreshAgents({ trigger: "initial" }),
        window.consensus.listConversations()
      ]);
      const seededSettings = await window.consensus.getSettings();
      state.setSettings(seededSettings);
      state.setAgents(nextAgents);
      applySummaryRefresh(nextSummaries, summaryRequestId, revisionsAtStart);
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

  async function openConversationForSelection(id: string): Promise<Conversation | undefined> {
    const requestId = state.openConversationRequestRef.current + 1;
    state.openConversationRequestRef.current = requestId;
    state.openConversationTargetRef.current = id;
    dropComposerFocusRequestsExcept(id);
    state.setError(undefined);
    if (state.conversation?.id !== id) {
      state.setWarnings([]);
    }
    if (state.conversation?.id === id) {
      state.setOpeningConversationId(undefined);
      markConversationViewed(state.conversation);
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
        markConversationViewed(next);
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

  async function openConversationAndFocusMessage(
    target: Pick<ChatSearchMessageMatch, "conversationId" | "messageId" | "threadRootId">
  ): Promise<void> {
    await focusConversationMessage({
      state,
      target,
      openConversation: (conversationId) => openConversationForSelection(conversationId),
      ensureTargetMessagesLoaded: (conversation, messageId, threadRootId, isCurrent) =>
        ensureTargetMessagesLoaded(
          conversation,
          messageId,
          threadRootId,
          isCurrent,
          "The selected search result is no longer available."
        )
    });
  }

  function clearChatMessageFocus(): void {
    state.chatMessageFocusNonceRef.current += 1;
    state.setChatMessageFocusRequest(undefined);
  }

  async function ensureTargetMessagesLoaded(
    conversation: Conversation,
    messageId: string,
    threadRootId: string | undefined,
    isCurrent: () => boolean,
    missingMessageError: string
  ): Promise<boolean> {
    return Boolean(await loadTargetMessages(conversation, [messageId, threadRootId], isCurrent, missingMessageError));
  }

  /** Loads the page around each target not loaded yet; gives the loaded messages
   *  once every target is among them, else undefined. */
  async function loadTargetMessages(
    conversation: Conversation,
    ids: Array<string | undefined>,
    isCurrent: () => boolean,
    missingMessageError: string
  ): Promise<ChatMessage[] | undefined> {
    let loadedMessages = conversation.messages;
    const targetIds = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    for (const targetId of targetIds) {
      if (!isCurrent()) {
        return undefined;
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
        return undefined;
      }
      if (page.messages.length === 0) {
        throw new Error(missingMessageError);
      }
      loadedMessages = mergeMissingMessagesByCreatedAt(loadedMessages, page.messages);
      state.setConversation((current) => current?.id === conversation.id
        ? { ...current, messages: mergeMissingMessagesByCreatedAt(current.messages, page.messages) }
        : current);
      state.setMessagePage((current) => mergeLoadedMessagePage(current, page));
    }
    return targetIds.every((targetId) => loadedMessages.some((message) => message.id === targetId)) ? loadedMessages : undefined;
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

  /** Opens a member from the chat (Running members, the members list): a
   *  running member at its turn in progress, any other at its last message.
   *  Whether it is running is the whole chat's answer, not the open page's. */
  function jumpToParticipantLastMessage(participantId: string): void {
    const conversation = state.conversation;
    if (!conversation) {
      return;
    }
    const nonceAtClick = state.chatMessageFocusNonceRef.current;
    const openRequest = state.openConversationRequestRef.current;
    const entry = conversation.metadata.lastMessageByParticipant?.[participantId];
    const lastMessage: ChatRunningMessageTarget | undefined = entry && typeof entry.messageId === "string" && entry.messageId.trim()
      ? {
        messageId: entry.messageId,
        threadRootId: typeof entry.threadRootId === "string" && entry.threadRootId.trim() ? entry.threadRootId : undefined
      }
      : undefined;
    void runningParticipantTarget(conversation, participantId).then((running) => {
      // Another chat opened or another message was asked for meanwhile.
      if (state.chatMessageFocusNonceRef.current !== nonceAtClick || state.openConversationRequestRef.current !== openRequest) {
        return;
      }
      const target = running ?? lastMessage;
      if (!target) {
        return;
      }
      const nonce = nonceAtClick + 1;
      state.chatMessageFocusNonceRef.current = nonce;
      state.setChatMessageFocusRequest({
        conversationId: conversation.id,
        messageId: target.messageId,
        threadRootId: target.threadRootId,
        nonce
      });
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
      if (!info.error && options.remember !== false) {
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
    // Stop may arrive after creation saved but before its IPC reply. Do not
    // send the first message when that reply subsequently reaches the UI.
    state.chatCreationRef.current?.abort(new Error("Chat creation cancelled."));
    if (state.chatCreationRef.current) state.setProgressLog(current => [...current]);
    // A start still checking the CLIs has no run in the main process yet
    // (its run id is set when the chat is asked for): nothing to stop there.
    if (state.currentRunId) {
      await window.consensus.cancelReview(state.currentRunId);
    }
  }

  async function newChatSession(): Promise<boolean> {
    if (state.busy) return false;
    const openRequestAtClick = state.openConversationRequestRef.current;
    await refreshSettingsForNewChat();
    // A chat opened after New chat was clicked is the User's later choice.
    if (state.openConversationRequestRef.current !== openRequestAtClick) return false;
    const nextRepoPath = preferredNewChatRepoPath();
    resetNewChatState();
    await applyNewChatRepoPath(nextRepoPath);
    return true;
  }

  async function newProjectSession(projectRepoPath?: string): Promise<void> {
    if (state.busy) return;
    const openRequestAtClick = state.openConversationRequestRef.current;
    await refreshSettingsForNewChat();
    if (state.openConversationRequestRef.current !== openRequestAtClick) return;
    const nextRepoPath = normalizeProjectPath(projectRepoPath) ?? "";
    resetNewChatState();
    await applyNewChatRepoPath(nextRepoPath);
  }

  // Takes the conversation on screen, or one still loading, off screen.
  function dropLoadedConversation(): void {
    clearChatMessageFocus();
    // A chat still loading must not land on top of what replaces it once its
    // load finishes.
    state.openConversationRequestRef.current += 1;
    state.openConversationTargetRef.current = undefined;
    dropComposerFocusRequestsExcept(undefined);
    state.setOpeningConversationId(undefined);
    state.setConversation(undefined);
    state.setMessagePage(undefined);
    state.setOlderMessagesLoading(false);
    state.setSelectedThreadId(undefined);
    state.setFocusedThreadId(undefined);
    state.setWarnings([]);
    state.setKind("chat");
  }

  function resetNewChatState(): void {
    dropLoadedConversation();
    state.progressLogRef.current = [];
    state.setProgressLog([]);
    state.setDecisionAnswers({});
    state.setResolvedDecisionThreads({});
    state.setClarificationDrafts({});
    state.setPendingClarifications({});
    state.setPlanItemReviewDrafts({});
    state.setPlanCorrectionDraft("");
    // Unsent text stays with its chat: leaving for a new chat must not erase it.
    state.setChatAddParticipantDraft(defaultChatParticipantDraft(state.settings));
    state.setSelectedChatParticipantConfigIds(defaultSelectedChatParticipantConfigIds());
    state.setQuestion("");
    state.setNewChatPendingImages((current) => {
      revokePendingImageUrls(current);
      return [];
    });
    state.setNewChatRepoFileMentions([]);
    state.setNewChatSkillMentions([]);
    state.setNewChatPluginMentions([]);
    state.setRepoPath("");
    state.setRepoInfo(undefined);
    state.setError(undefined);
  }

  async function refreshSettingsForNewChat(): Promise<void> {
    try {
      state.setSettings(await window.consensus.getSettings());
    } catch {
      // Keep the existing settings snapshot if the preference refresh fails.
    }
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
    refreshAll, refreshAgents, refreshConversations, openConversation, openConversationAndFocusMessage, markConversationViewed, clearChatMessageFocus, loadOlderConversationMessages,
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
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };
    requestAnimationFrame(finish);
    window.setTimeout(finish, 50);
  });
}
