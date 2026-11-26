import assert from "node:assert/strict";
import test from "node:test";

import type { ChatSearchMessageMatch, Conversation } from "../../shared/types";
import type { RailView } from "./app-state";
import { useAppNavigation } from "./use-app-navigation";

function harness(options: { conversation?: Conversation; openingConversationId?: string }) {
  const calls: string[] = [];
  const state = {
    conversation: options.conversation,
    openingConversationId: options.openingConversationId,
    setRailView: (view: RailView | ((current: RailView) => RailView)) => { calls.push(`view:${String(view)}`); },
    setSidebarCollapsed: (value: boolean | ((current: boolean) => boolean)) => { calls.push(`collapsed:${String(value)}`); },
    setActiveSettingsSection: (section: unknown) => { calls.push(`section:${String(section)}`); }
  };
  const actions = {
    clearChatMessageFocus: () => { calls.push("clearFocus"); },
    markConversationViewed: (conversation: Conversation) => { calls.push(`viewed:${conversation.id}`); },
    openConversation: async (id: string) => { calls.push(`open:${id}`); },
    openConversationAndFocusMessage: async (match: Pick<ChatSearchMessageMatch, "conversationId" | "messageId" | "threadRootId">) => {
      calls.push(`openMessage:${match.conversationId}/${match.messageId}`);
    }
  };
  const navigation = useAppNavigation(state as never, actions);
  return { calls, navigation, state };
}

const loaded = { id: "c1" } as Conversation;

test("Back to chats from Settings marks the conversation it shows again", () => {
  const fromSettings = harness({ conversation: loaded });
  fromSettings.navigation.returnToChats();
  assert.deepEqual(fromSettings.calls, ["clearFocus", "view:chats", "viewed:c1"]);

  const empty = harness({});
  empty.navigation.returnToChats();
  assert.deepEqual(empty.calls, ["clearFocus", "view:chats"]);

  // A chat still loading when Settings opened is opened again, so it is marked
  // on arrival and the stale one is not.
  const stillLoading = harness({ conversation: loaded, openingConversationId: "c2" });
  stillLoading.navigation.returnToChats();
  assert.deepEqual(stillLoading.calls, ["clearFocus", "view:chats", "open:c2"]);
});

test("opening a chat or a search result shows Chats, then opens that chat", () => {
  const chat = harness({ conversation: loaded });
  chat.navigation.openChat("c2");
  assert.deepEqual(chat.calls, ["clearFocus", "view:chats", "open:c2"]);

  const message = harness({ conversation: loaded });
  message.navigation.openChatMessage({ conversationId: "c3", messageId: "m1" } as ChatSearchMessageMatch);
  assert.deepEqual(message.calls, ["clearFocus", "view:chats", "openMessage:c3/m1"]);
});

test("Settings opens expanded, on the requested section", () => {
  const settings = harness({ conversation: loaded });
  settings.navigation.openSettingsSection("general");
  assert.deepEqual(settings.calls, ["section:general", "clearFocus", "view:settings", "collapsed:false"]);
});
