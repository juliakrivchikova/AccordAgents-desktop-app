import assert from "node:assert/strict";
import test from "node:test";

import type { ChatSearchMessageMatch, Conversation } from "../../shared/types";
import type { RailView } from "./app-state";
import { useAppNavigation } from "./use-app-navigation";

function harness(options: { railView: RailView; conversation?: Conversation; openingConversationId?: string }) {
  const calls: string[] = [];
  const state = {
    chatBeforeActivityRef: { current: undefined as { conversationId?: string } | undefined },
    railView: options.railView,
    conversation: options.conversation,
    openingConversationId: options.openingConversationId,
    setRailView: (view: RailView | ((current: RailView) => RailView)) => { calls.push(`view:${String(view)}`); },
    setSelectedActivityItem: () => { calls.push("clearSelectedActivity"); },
    setSidebarCollapsed: (value: boolean | ((current: boolean) => boolean)) => { calls.push(`collapsed:${String(value)}`); },
    setActiveSettingsSection: (section: unknown) => { calls.push(`section:${String(section)}`); }
  };
  const actions = {
    clearChatMessageFocus: () => { calls.push("clearFocus"); },
    markConversationViewed: (conversation: Conversation) => { calls.push(`viewed:${conversation.id}`); },
    openConversation: async (id: string) => { calls.push(`open:${id}`); },
    openConversationAndFocusMessage: async (match: Pick<ChatSearchMessageMatch, "conversationId" | "messageId" | "threadRootId">) => {
      calls.push(`openMessage:${match.conversationId}/${match.messageId}`);
    },
    returnToNewChatDraft: () => { calls.push("newChatDraft"); }
  };
  const navigation = useAppNavigation(state as never, actions);
  return { calls, navigation, state };
}

const loaded = { id: "c1" } as Conversation;

test("Back to chats from Settings marks the conversation it shows again, and opening Activity does not", () => {
  const fromSettings = harness({ railView: "settings", conversation: loaded });
  fromSettings.navigation.returnToChats();
  assert.deepEqual(fromSettings.calls, ["clearFocus", "clearSelectedActivity", "view:chats", "viewed:c1"]);

  const empty = harness({ railView: "settings" });
  empty.navigation.returnToChats();
  assert.deepEqual(empty.calls, ["clearFocus", "clearSelectedActivity", "view:chats"]);

  // A chat still loading when Settings opened is opened again, so it is marked
  // on arrival and the stale one is not.
  const stillLoading = harness({ railView: "settings", conversation: loaded, openingConversationId: "c2" });
  stillLoading.navigation.returnToChats();
  assert.deepEqual(stillLoading.calls, ["clearFocus", "clearSelectedActivity", "view:chats", "open:c2"]);

  const toActivity = harness({ railView: "chats", conversation: loaded });
  toActivity.navigation.showView("activity");
  assert.deepEqual(toActivity.calls, ["view:activity"]);
});

test("Back from Activity returns to the chat open before it and leaves the previewed chat unread", () => {
  const nav = harness({ railView: "chats", conversation: loaded });
  nav.navigation.showView("activity");
  assert.deepEqual(nav.state.chatBeforeActivityRef.current, { conversationId: "c1" });
  // Previewing an Activity item loads another chat without marking it.
  nav.state.railView = "activity";
  nav.state.conversation = { id: "preview" } as Conversation;
  nav.navigation.showView("activity");
  assert.deepEqual(nav.state.chatBeforeActivityRef.current, { conversationId: "c1" }, "staying in Activity keeps the target");
  nav.calls.length = 0;
  nav.navigation.leaveActivity();
  // The preview is dropped before the earlier chat opens, so it is never on
  // screen in Chats while that one loads.
  assert.deepEqual(nav.calls, ["clearFocus", "clearSelectedActivity", "view:chats", "newChatDraft", "open:c1"]);
  assert.equal(nav.calls.some((call) => call.startsWith("viewed:")), false, "the preview is not marked read");
  assert.equal(nav.state.chatBeforeActivityRef.current, undefined);

  // Nothing previewed: the earlier chat is still loaded and is simply shown.
  const same = harness({ railView: "chats", conversation: loaded });
  same.navigation.showView("activity");
  same.state.railView = "activity";
  same.calls.length = 0;
  same.navigation.leaveActivity();
  assert.deepEqual(same.calls, ["clearFocus", "clearSelectedActivity", "view:chats", "open:c1"]);

  // A preview still loading over it: the earlier chat is still the loaded one,
  // so Back shows it again (opening it cancels the preview's load) rather than
  // dropping it for the new-chat screen.
  const loading = harness({ railView: "chats", conversation: loaded });
  loading.navigation.showView("activity");
  loading.state.railView = "activity";
  loading.state.openingConversationId = "preview";
  loading.calls.length = 0;
  loading.navigation.leaveActivity();
  assert.deepEqual(loading.calls, ["clearFocus", "clearSelectedActivity", "view:chats", "open:c1"]);
});

test("Back from Activity returns to the new-chat draft, or to the chat that was still opening", () => {
  const draft = harness({ railView: "chats" });
  draft.navigation.showView("activity");
  draft.state.railView = "activity";
  draft.state.conversation = { id: "preview" } as Conversation;
  draft.calls.length = 0;
  draft.navigation.leaveActivity();
  assert.deepEqual(draft.calls, ["clearFocus", "clearSelectedActivity", "view:chats", "newChatDraft"]);

  const opening = harness({ railView: "chats", conversation: loaded, openingConversationId: "c2" });
  opening.navigation.showView("activity");
  opening.state.railView = "activity";
  opening.calls.length = 0;
  opening.navigation.leaveActivity();
  assert.deepEqual(opening.calls, ["clearFocus", "clearSelectedActivity", "view:chats", "newChatDraft", "open:c2"]);
});

test("opening a chat or a search result from Activity drops a different preview first, then opens that chat", () => {
  const chat = harness({ railView: "activity", conversation: loaded });
  chat.state.chatBeforeActivityRef.current = { conversationId: "c0" };
  chat.navigation.openChat("c2");
  assert.deepEqual(chat.calls, ["newChatDraft", "clearFocus", "clearSelectedActivity", "view:chats", "open:c2"]);
  assert.equal(chat.state.chatBeforeActivityRef.current, undefined, "leaving Activity forgets the Back target");

  const message = harness({ railView: "activity", conversation: loaded });
  message.navigation.openChatMessage({ conversationId: "c3", messageId: "m1" } as ChatSearchMessageMatch);
  assert.deepEqual(message.calls, ["newChatDraft", "clearFocus", "clearSelectedActivity", "view:chats", "openMessage:c3/m1"]);

  const samePreview = harness({ railView: "activity", conversation: loaded });
  samePreview.navigation.openChat("c1");
  assert.deepEqual(samePreview.calls, ["clearFocus", "clearSelectedActivity", "view:chats", "open:c1"]);

  const fromChats = harness({ railView: "chats", conversation: loaded });
  fromChats.navigation.openChat("c2");
  assert.deepEqual(fromChats.calls, ["clearFocus", "clearSelectedActivity", "view:chats", "open:c2"]);
});

test("Settings opens expanded, on the requested section", () => {
  const settings = harness({ railView: "chats", conversation: loaded });
  settings.navigation.openSettingsSection("general");
  assert.deepEqual(settings.calls, ["section:general", "clearFocus", "clearSelectedActivity", "view:settings", "collapsed:false"]);
});
