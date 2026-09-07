import { useEffect, useRef } from "react";
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
  applyConversationUpdate,
  chatActivityItemsForUnknownMessages,
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
  refreshAgents: (request?: AgentDetectionRequest) => Promise<unknown>,
  refreshActivity: () => Promise<void>,
  markConversationViewed: (conversation: Conversation) => void
): void {
  const deletedConversationIds = useRef(new Set<string>());

  useEffect(() => window.consensus.onConversationDeleted(conversationId => {
    deletedConversationIds.current.add(conversationId);
    state.archivedConversationIdsRef.current.delete(conversationId);
    state.activityRevisionByConversationRef.current = {
      ...state.activityRevisionByConversationRef.current,
      [conversationId]: (state.activityRevisionByConversationRef.current[conversationId] ?? 0) + 1
    };
    state.setUnreadConversationIds(current => { const next = new Set(current); next.delete(conversationId); return next; });
    const { [conversationId]: _removed, ...lastViewed } = state.lastViewedAtRef.current;
    state.lastViewedAtRef.current = lastViewed;
    persistLastViewedAt(lastViewed);
    state.setSummaries(current => current.filter(summary => summary.id !== conversationId));
    state.setActivityItems(current => current.filter(item => item.conversationId !== conversationId));
    state.setSelectedActivityItem(current => current?.conversationId === conversationId ? undefined : current);
    if (state.conversation?.id === conversationId) {
      state.setConversation(undefined);
      state.setMessagePage(undefined);
      state.setSelectedThreadId(undefined);
      state.setFocusedThreadId(undefined);
      state.setChatMessageDraft("");
    }
  }), [state.conversation?.id]);

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
    return window.consensus.onConversationUpdated((update) => {
      if (deletedConversationIds.current.has(update.id)) return;
      const updatedConversation = conversationFromUpdate(update);
      const archived = update.archived === true || update.metadata.archived === true;
      state.activityRevisionByConversationRef.current = {
        ...state.activityRevisionByConversationRef.current,
        [update.id]: (state.activityRevisionByConversationRef.current[update.id] ?? 0) + 1
      };
      const archivedConversationIds = new Set(state.archivedConversationIdsRef.current);
      if (archived) {
        archivedConversationIds.add(update.id);
      } else {
        archivedConversationIds.delete(update.id);
      }
      state.archivedConversationIdsRef.current = archivedConversationIds;
      state.setSummaries((current) => upsertConversationSummary(current, updatedConversation));
      if (archived) {
        state.setSelectedActivityItem((current) => current?.conversationId === update.id ? undefined : current);
      }
      state.setConversation((current) => {
        const isActive = current?.id === update.id;
        const matchesCurrentSnapshot = conversationMatchesSnapshot(current, updatedConversation, state.currentRunId);
        // A delta carries only the messages that changed plus the newest window,
        // so it is merged into the loaded chat when that chat is open; for any
        // other chat it only refreshes summaries, activity and unread state.
        const applied = applyConversationUpdate(isActive ? current : undefined, update);
        const updated = applied.conversation;
        const canReplace = matchesCurrentSnapshot && (isActive || !update.messageDelta);
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
            lastViewedAt: state.lastViewedAtRef.current[update.id],
            treatAsViewed: viewedLive,
            preferences: state.activityItemPreferencesRef.current
          })
        );
        const knownMessageIds = new Set(updated.messages.map((message) => message.id));
        state.setActivityItems((activityCurrent) => {
          const preservedReadItems = preservedRecentChatActivityItems(activityCurrent, update.id, {
            archived,
            treatAsRead: isActive && timelineVisible
          });
          // Messages the delta did not carry cannot be recomputed here; keep what
          // an earlier full snapshot or activity refresh said about them.
          const preservedUnknownItems = update.messageDelta && !archived
            ? chatActivityItemsForUnknownMessages(activityCurrent, update.id, knownMessageIds, update.messageDelta.removedIds)
            : [];
          return mergeChatActivityItems(activityCurrent, [...preservedUnknownItems, ...activityItems, ...preservedReadItems], {
            replaceConversationId: update.id
          });
        });
        if (!canReplace) {
          if (!isActive) {
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
