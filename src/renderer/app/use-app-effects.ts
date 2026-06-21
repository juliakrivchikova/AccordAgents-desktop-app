import { useEffect } from "react";
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
  defaultChatParticipantDraft,
  normalizeChatParticipantDraftForSettings
} from "../components/chat/chat-participant-drafts";

export function useAppEffects(state: AppState, refreshAll: () => Promise<void>): void {
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
    return window.consensus.onReviewProgress((progress) => {
      state.setProgressLog((current) => {
        const appended = [...current, progress];
        const next = appended.length > 500 ? appended.slice(appended.length - 500) : appended;
        state.progressLogRef.current = next;
        return next;
      });
    });
  }, []);

  useEffect(() => {
    return window.consensus.onConversationUpdated((updated) => {
      state.setSummaries((current) => upsertConversationSummary(current, updated));
      state.setConversation((current) => {
        const isActive = current?.id === updated.id;
        if (!conversationMatchesSnapshot(current, updated, state.currentRunId)) {
          if (!isActive) {
            const lastViewed = state.lastViewedAtRef.current[updated.id];
            if (!lastViewed || conversationTimeValue(updated.updatedAt) > conversationTimeValue(lastViewed)) {
              state.setUnreadConversationIds((prev) => {
                if (prev.has(updated.id)) return prev;
                const next = new Set(prev);
                next.add(updated.id);
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
        state.setMessagePage(fullConversationMessagePageInfo(merged));
        if (isActive) {
          state.lastViewedAtRef.current = { ...state.lastViewedAtRef.current, [updated.id]: merged.updatedAt };
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
