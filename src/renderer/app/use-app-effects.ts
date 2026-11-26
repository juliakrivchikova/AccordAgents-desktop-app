import { useEffect, useRef } from "react";
import type { AgentDetectionRequest } from "../../shared/types";
import { chatImportedAtMs } from "../../shared/mainSession";
import { SIDEBAR_COLLAPSED_STORAGE_KEY } from "./constants";
import { conversationTimeValue, upsertConversationSummary } from "./conversation-summaries";
import type { AppState } from "./app-state";
import { persistLastViewedAt } from "./storage";
import {
  conversationMatchesSnapshot,
  conversationRelevantRunIds,
  mergeProgressIntoConversation,
  threadExistsInConversation
} from "../components/review/review-conversation-data";
import {
  fullConversationMessagePageInfo
} from "../lib/conversation-message-pages";
import {
  applyConversationUpdate,
  conversationFromUpdate,
  messagePageAfterUpdate
} from "../../shared/conversationUpdates";
import {
  defaultChatParticipantDraft,
  normalizeChatParticipantDraftForSettings
} from "../components/chat/chat-participant-drafts";

export function useAppEffects(
  state: AppState,
  refreshAll: () => Promise<void>,
  refreshAgents: (request?: AgentDetectionRequest) => Promise<unknown>
): void {
  const deletedConversationIds = useRef(new Set<string>());
  // Each listed chat's time as the list last had it: an update that leaves it
  // where it was (a pin, here or from another device) is no news in the chat,
  // whether or not the chat was ever opened here. A save is announced before
  // a list read could see it, so news always moves the time first.
  const listedUpdatedAt = useRef(new Map<string, string>());
  useEffect(() => {
    listedUpdatedAt.current = new Map(state.summaries.map((summary) => [summary.id, summary.updatedAt]));
  }, [state.summaries]);

  useEffect(() => window.consensus.onConversationDeleted(conversationId => {
    deletedConversationIds.current.add(conversationId);
    state.activityRevisionByConversationRef.current = {
      ...state.activityRevisionByConversationRef.current,
      [conversationId]: (state.activityRevisionByConversationRef.current[conversationId] ?? 0) + 1
    };
    state.setUnreadConversationIds(current => { const next = new Set(current); next.delete(conversationId); return next; });
    const { [conversationId]: _removed, ...lastViewed } = state.lastViewedAtRef.current;
    state.lastViewedAtRef.current = lastViewed;
    persistLastViewedAt(lastViewed);
    state.setSummaries(current => current.filter(summary => summary.id !== conversationId));
    state.clearChatMessageDraft(conversationId);
    if (state.conversation?.id === conversationId) {
      state.setConversation(undefined);
      state.setMessagePage(undefined);
      state.setSelectedThreadId(undefined);
      state.setFocusedThreadId(undefined);
    }
  }), [state.conversation?.id]);

  useEffect(() => {
    void refreshAll();
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, state.sidebarCollapsed ? "true" : "false");
    } catch {
      // Local storage can be unavailable in restricted browser contexts.
    }
  }, [state.sidebarCollapsed]);

  useEffect(() => {
    let frameId: number | undefined;
    let timeoutId: number | undefined;
    let queued = false;

    const clearScheduledCommit = (): void => {
      if (frameId != null) {
        window.cancelAnimationFrame(frameId);
        frameId = undefined;
      }
      if (timeoutId != null) {
        window.clearTimeout(timeoutId);
        timeoutId = undefined;
      }
    };

    const commitProgressLog = (): void => {
      clearScheduledCommit();
      queued = false;
      state.setProgressLog([...state.progressLogRef.current]);
    };

    const scheduleProgressCommit = (): void => {
      if (queued) {
        return;
      }
      queued = true;
      if (document.visibilityState === "visible") {
        frameId = window.requestAnimationFrame(commitProgressLog);
        return;
      }
      timeoutId = window.setTimeout(commitProgressLog, 16);
    };

    const unsubscribe = window.consensus.onReviewProgress((progress) => {
      state.progressLogRef.current.push(progress);
      if (state.progressLogRef.current.length > 500) {
        state.progressLogRef.current.splice(0, state.progressLogRef.current.length - 500);
      }
      scheduleProgressCommit();
    });
    return () => {
      unsubscribe();
      clearScheduledCommit();
    };
  }, []);

  useEffect(() => {
    const updateInactiveState = (): void => {
      const inactive = document.visibilityState !== "visible" || !document.hasFocus();
      document.documentElement.classList.toggle("app-inactive", inactive);
    };
    const refreshReadinessOnFocus = (): void => {
      updateInactiveState();
      if (document.visibilityState === "visible" && document.hasFocus()) {
        void refreshAgents({ force: true, trigger: "focus" });
      }
    };
    updateInactiveState();
    document.addEventListener("visibilitychange", refreshReadinessOnFocus);
    window.addEventListener("blur", updateInactiveState);
    window.addEventListener("focus", refreshReadinessOnFocus);
    return () => {
      document.removeEventListener("visibilitychange", refreshReadinessOnFocus);
      window.removeEventListener("blur", updateInactiveState);
      window.removeEventListener("focus", refreshReadinessOnFocus);
      document.documentElement.classList.remove("app-inactive");
    };
  }, []);

  useEffect(() => {
    return window.consensus.onConversationUpdated((update) => {
      if (deletedConversationIds.current.has(update.id)) return;
      const listedAt = listedUpdatedAt.current.get(update.id);
      const timeMoved = listedAt === undefined || conversationTimeValue(update.updatedAt) > conversationTimeValue(listedAt);
      const updatedConversation = conversationFromUpdate(update);
      state.activityRevisionByConversationRef.current = {
        ...state.activityRevisionByConversationRef.current,
        [update.id]: (state.activityRevisionByConversationRef.current[update.id] ?? 0) + 1
      };
      // The update itself: a delta says whether the whole chat has a reply
      // not ended yet, which its few carried messages cannot.
      state.setSummaries((current) => upsertConversationSummary(current, update));
      state.setConversation((current) => {
        const isActive = current?.id === update.id;
        const matchesCurrentSnapshot = conversationMatchesSnapshot(current, updatedConversation, state.currentRunId);
        // A delta carries only the messages that changed plus the newest window,
        // so it is merged into the loaded chat when that chat is open; for any
        // other chat it only refreshes summaries and unread state.
        const applied = applyConversationUpdate(isActive ? current : undefined, update);
        const updated = applied.conversation;
        const canReplace = matchesCurrentSnapshot && (isActive || !update.messageDelta);
        // The loaded conversation counts as "being viewed" only while the chats
        // view is on screen: a chat left open behind Settings is not seen.
        const timelineVisible = conversationTimelineVisibleNow(state);
        if (!canReplace) {
          // An imported chat is news once something happens in it here.
          if (!isActive && timeMoved && conversationTimeValue(update.updatedAt) > chatImportedAtMs(update.metadata)) {
            const lastViewed = state.lastViewedAtRef.current[update.id];
            if (!lastViewed || conversationTimeValue(update.updatedAt) > conversationTimeValue(lastViewed)) {
              state.setUnreadConversationIds((prev) => {
                if (prev.has(update.id)) return prev;
                const next = new Set(prev);
                next.add(update.id);
                return next;
              });
            }
          }
          return current;
        }
        state.setSelectedThreadId((selected) => (selected && !threadExistsInConversation(updated, selected) ? undefined : selected));
        state.setFocusedThreadId((focused) => (focused && !threadExistsInConversation(updated, focused) ? undefined : focused));
        const relevantRunIds = conversationRelevantRunIds(updated);
        const merged = mergeProgressIntoConversation(updated, state.progressLogRef.current.filter((item) => relevantRunIds.has(item.runId)));
        state.setMessagePage((previous) => messagePageAfterUpdate(previous, merged === updated ? applied : { ...applied, conversation: merged }));
        if (isActive && timelineVisible) {
          state.lastViewedAtRef.current = { ...state.lastViewedAtRef.current, [update.id]: merged.updatedAt };
          persistLastViewedAt(state.lastViewedAtRef.current);
        }
        return merged;
      });
    });
  }, [state.currentRunId]);

  useEffect(() => {
    if (!state.conversation || !state.messagePage?.hasMoreBefore || state.conversation.messages.length < state.messagePage.totalMessages) {
      return;
    }
    state.setMessagePage(fullConversationMessagePageInfo(state.conversation));
  }, [state.conversation?.id, state.conversation?.messages.length, state.messagePage?.hasMoreBefore, state.messagePage?.totalMessages]);

  useEffect(() => {
    state.setChatAddParticipantDraft((current) =>
      normalizeChatParticipantDraftForSettings(current ?? defaultChatParticipantDraft(state.settings), state.settings)
    );
  }, [state.settings]);

  useEffect(() => {
    const availableIds = new Set(state.settings.chatParticipantConfigs.map((participant) => participant.id));
    state.setSelectedChatParticipantConfigIds((current) => new Set([...current].filter((id) => availableIds.has(id))));
  }, [state.settings.chatParticipantConfigs]);
}

function conversationTimelineVisibleNow(state: AppState): boolean {
  return state.railViewRef.current === "chats";
}
