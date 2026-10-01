import type { ChatSearchMessageMatch } from "../../shared/types";
import type { SettingsSection } from "../components/settings/settings-view";
import type { AppState, RailView } from "./app-state";
import type { ConversationActions } from "./use-conversation-actions";

export interface AppNavigation {
  showView: (view: RailView) => void;
  openSettingsSection: (section: SettingsSection) => void;
  returnToChats: () => void;
  leaveActivity: () => void;
  openChat: (conversationId: string) => void;
  openChatMessage: (match: ChatSearchMessageMatch) => void;
}

type NavigationState = Pick<
  AppState,
  | "railView"
  | "conversation"
  | "openingConversationId"
  | "chatBeforeActivityRef"
  | "setRailView"
  | "setSelectedActivityItem"
  | "setSidebarCollapsed"
  | "setActiveSettingsSection"
>;

type NavigationActions = Pick<
  ConversationActions,
  | "clearChatMessageFocus"
  | "markConversationViewed"
  | "openConversation"
  | "openConversationAndFocusMessage"
  | "returnToNewChatDraft"
>;

// How the sidebar, search, Activity and Settings switch views. Opening a chat
// marks what it shows as viewed. Back from Settings re-shows the conversation
// that stayed loaded; Back from Activity returns to the chat that was open
// before Activity, so an Activity preview stays unread. Activity's own Open
// in chat and approval actions open their chat directly.
export function useAppNavigation(state: NavigationState, actions: NavigationActions): AppNavigation {
  const showView = (nextView: RailView): void => {
    if (nextView === "activity" && state.railView !== "activity") {
      state.chatBeforeActivityRef.current = { conversationId: state.openingConversationId ?? state.conversation?.id };
    }
    if (nextView !== "activity") {
      state.chatBeforeActivityRef.current = undefined;
      actions.clearChatMessageFocus();
      state.setSelectedActivityItem(undefined);
    }
    state.setRailView(nextView);
    if (nextView === "settings") {
      state.setSidebarCollapsed(false);
    }
  };

  // Opening a different chat from Activity (Cmd+K) drops the preview first.
  const leavePreviewFor = (conversationId: string): void => {
    if (state.railView === "activity" && state.conversation && state.conversation.id !== conversationId) {
      actions.returnToNewChatDraft();
    }
  };

  return {
    showView,
    openSettingsSection: (section) => {
      state.setActiveSettingsSection(section);
      showView("settings");
    },
    returnToChats: () => {
      showView("chats");
      // A chat still loading when Settings opened is the one Chats will show;
      // open it again so it is marked once it arrives, and nothing else is.
      if (state.openingConversationId) {
        void actions.openConversation(state.openingConversationId);
      } else if (state.conversation) {
        actions.markConversationViewed(state.conversation);
      }
    },
    leaveActivity: () => {
      const conversationId = state.chatBeforeActivityRef.current?.conversationId;
      showView("chats");
      if (conversationId && conversationId === state.conversation?.id) {
        // Still loaded (a preview may still be loading; opening it again
        // cancels that): show it again, and it counts as viewed.
        void actions.openConversation(conversationId);
        return;
      }
      // Drop the preview first, so nothing counts it as on screen while the
      // earlier chat loads.
      actions.returnToNewChatDraft();
      if (conversationId) {
        void actions.openConversation(conversationId);
      }
    },
    openChat: (conversationId) => {
      leavePreviewFor(conversationId);
      showView("chats");
      void actions.openConversation(conversationId);
    },
    openChatMessage: (match) => {
      leavePreviewFor(match.conversationId);
      showView("chats");
      void actions.openConversationAndFocusMessage(match);
    }
  };
}
