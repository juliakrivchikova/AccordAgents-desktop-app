import { useEffect } from "react";
import type { Conversation } from "../../shared/types";
import {
  buildChatActivityItemsForConversationUpdate,
  mergeChatActivityItems,
  preservedRecentChatActivityItems
} from "../../shared/chatActivity";
import { SIDEBAR_COLLAPSED_STORAGE_KEY } from "./constants";
import { conversationTimeValue, upsertConversationSummary } from "./conversation-summaries";
import type { AppState } from "./app-state";
import { persistLastViewedAt } from "./storage";
import { activityItemsWithStoredPreferences } from "./activity-item-state";
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

export function useAppEffects(
  state: AppState,
  refreshAll: () => Promise<void>,
  refreshActivity: () => Promise<void>,
  markConversationViewed: (conversation: Conversation) => void
): void {
  useEffect(() => {
    void refreshAll();
  }, []);

  useEffect(() => {
    void refreshActivity();
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
      const archived = updated.archived === true || updated.metadata.archived === true;
      state.activityRevisionByConversationRef.current = {
        ...state.activityRevisionByConversationRef.current,
        [updated.id]: (state.activityRevisionByConversationRef.current[updated.id] ?? 0) + 1
      };
      const archivedConversationIds = new Set(state.archivedConversationIdsRef.current);
      if (archived) {
        archivedConversationIds.add(updated.id);
      } else {
        archivedConversationIds.delete(updated.id);
      }
      state.archivedConversationIdsRef.current = archivedConversationIds;
      state.setSummaries((current) => upsertConversationSummary(current, updated));
      if (archived) {
        state.setSelectedActivityItem((current) => current?.conversationId === updated.id ? undefined : current);
      }
      state.setConversation((current) => {
        const isActive = current?.id === updated.id;
        const matchesCurrentSnapshot = conversationMatchesSnapshot(current, updated, state.currentRunId);
        // The loaded conversation counts as "being viewed" only while its timeline is
        // actually on screen: the chats view, or the activity detail pane showing this
        // conversation. A chat left open behind the activity or settings views must not
        // silently mark new finished runs as read, or the rail badge never appears.
        const timelineVisible = conversationTimelineVisibleNow(state, updated.id);
        const viewedLive = isActive && matchesCurrentSnapshot && timelineVisible;
        const activityItems = activityItemsWithStoredPreferences(
          state,
          buildChatActivityItemsForConversationUpdate(updated, {
            lastViewedAt: state.lastViewedAtRef.current[updated.id],
            treatAsViewed: viewedLive
          })
        );
        state.setActivityItems((activityCurrent) => {
          const preservedReadItems = preservedRecentChatActivityItems(activityCurrent, updated.id, {
            archived,
            treatAsRead: isActive && timelineVisible
          });
          return mergeChatActivityItems(activityCurrent, [...activityItems, ...preservedReadItems], {
            replaceConversationId: updated.id
          });
        });
        if (!matchesCurrentSnapshot) {
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
        if (isActive && timelineVisible) {
          state.lastViewedAtRef.current = { ...state.lastViewedAtRef.current, [updated.id]: merged.updatedAt };
          persistLastViewedAt(state.lastViewedAtRef.current);
        }
        return merged;
      });
    });
  }, [state.currentRunId]);

  // Returning to the chats view puts the still-loaded conversation back on screen, so
  // catch up on the viewed-marking that was suppressed while it was hidden.
  useEffect(() => {
    if (state.railView === "chats" && state.conversation) {
      markConversationViewed(state.conversation);
    }
  }, [state.railView]);

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

function conversationTimelineVisibleNow(state: AppState, conversationId: string): boolean {
  const railView = state.railViewRef.current;
  if (railView === "chats") {
    return true;
  }
  return railView === "activity" && state.selectedActivityConversationIdRef.current === conversationId;
}
