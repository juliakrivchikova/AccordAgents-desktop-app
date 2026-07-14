import { useEffect } from "react";
import type { AgentDetectionRequest, Conversation } from "../../shared/types";
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
  refreshAgents: (request?: AgentDetectionRequest) => Promise<unknown>,
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
        // The loaded conversation counts as "being viewed" only while the chats view is
        // on screen. A chat left open behind the activity or settings views must not
        // silently mark new finished runs as read, or the rail badge never appears.
        // The activity view (including an open detail pane) never auto-reads items:
        // there, unread state clears only through the explicit "Mark read" action.
        const timelineVisible = conversationTimelineVisibleNow(state);
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

function conversationTimelineVisibleNow(state: AppState): boolean {
  return state.railViewRef.current === "chats";
}
