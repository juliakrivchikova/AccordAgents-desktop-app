import type { ChatSearchMessageMatch } from "../../shared/types";
import type { SettingsSection } from "../components/settings/settings-view";
import type { AppState, RailView } from "./app-state";
import type { ConversationActions } from "./use-conversation-actions";

export interface AppNavigation {
  showView: (view: RailView) => void;
  openSettingsSection: (section: SettingsSection) => void;
  returnToChats: () => void;
  openChat: (conversationId: string) => void;
  openChatMessage: (match: ChatSearchMessageMatch) => void;
}

type NavigationState = Pick<
  AppState,
  | "conversation"
  | "openingConversationId"
  | "setRailView"
  | "setSidebarCollapsed"
  | "setActiveSettingsSection"
>;

type NavigationActions = Pick<
  ConversationActions,
  | "clearChatMessageFocus"
  | "markConversationViewed"
  | "openConversation"
  | "openConversationAndFocusMessage"
>;

// How the sidebar, search and Settings switch views. Opening a chat marks what
// it shows as viewed. Back from Settings re-shows the conversation that stayed
// loaded.
export function useAppNavigation(state: NavigationState, actions: NavigationActions): AppNavigation {
  const showView = (nextView: RailView): void => {
    actions.clearChatMessageFocus();
    state.setRailView(nextView);
    if (nextView === "settings") {
      state.setSidebarCollapsed(false);
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
    openChat: (conversationId) => {
      showView("chats");
      void actions.openConversation(conversationId);
    },
    openChatMessage: (match) => {
      showView("chats");
      void actions.openConversationAndFocusMessage(match);
    }
  };
}
