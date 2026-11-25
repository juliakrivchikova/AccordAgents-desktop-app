import { selectedConversationId } from "../chats/openChat.js";
import { activeChatRecord, syncHeaderSpacer } from "../members/membersSheet.js";
import { chatMembers } from "../members/mentions.js";
import { forkFromItem, forkMenuKey, forkToNewChatState, readForkPlan, renderTitleMenuFork } from "./forkToNewChat.js";
import {
  CHAT_VIEW_SWITCH_DISABLED_REASON, chatCanSwitchView, chatViewOf, openMemberSessionId, sessionsMainSessionIdOf,
  sessionsStateState, setChatViewFromPhone
} from "./sessionsState.js";

export const titleMenuState = {
  chatTitleMenuOpen: false
};

/** The chat header's two views. A chat made before main sessions shows
 *  the switch unavailable, and a tap says why. Off a chat's own screen (a
 *  thread, a member's session) the header has room for its way back only. */
export function renderChatViewSwitch(conversationId, chat, onSubscreen) {
  const group = document.getElementById("chat-view-switch");
  if (!group) return;
  const view = chatViewOf(chat);
  // The sessions view keeps no text buttons in its header: its view is
  // picked in the menu under the title (renderChatTitleMenu).
  const sessionsView = Boolean(conversationId) && view === "sessions";
  renderChatTitleMenu(conversationId ? chat : undefined);
  const shown = Boolean(conversationId) && !onSubscreen && !sessionsView;
  if (group.hidden === shown) group.hidden = !shown;
  if (!shown) {
    syncHeaderSpacer();
    return;
  }
  const can = chatCanSwitchView(chat);
  group.dataset.chatView = view;
  group.classList.toggle("is-disabled", !can);
  if (can) delete group.dataset.disabledReason;
  else group.dataset.disabledReason = CHAT_VIEW_SWITCH_DISABLED_REASON;
  group.title = can ? "" : CHAT_VIEW_SWITCH_DISABLED_REASON;
  for (const option of group.querySelectorAll("[data-view]")) {
    const pressed = option.dataset.view === view ? "true" : "false";
    if (option.getAttribute("aria-pressed") !== pressed) option.setAttribute("aria-pressed", pressed);
    option.setAttribute("aria-disabled", can ? "false" : "true");
  }
  syncHeaderSpacer();
}

/** What the title's menu holds in the sessions view: on the main timeline
 *  the chat's view and Fork to new chat for the main session; on a
 *  member's own screen Fork to new chat for that member, as the computer
 *  offers it in the member's … menu (a removed member's session reads
 *  only; an Accord's screen has no menu). */
export function chatTitleMenuState(chat) {
  if (!chat || chatViewOf(chat) !== "sessions" || sessionsStateState.openAccordLaunchId) return { available: false, views: false, forkId: undefined };
  const open = openMemberSessionId();
  if (open && open !== chat.mainSessionParticipantId) {
    const member = chatMembers(chat).find(function (item) { return item.id === open; });
    return { available: Boolean(member), views: false, forkId: member ? member.id : undefined };
  }
  return { available: true, views: true, forkId: sessionsMainSessionIdOf(chat) };
}

/** The title's menu in the sessions view: the chat's view, with a check
 *  by the one it is in, and Fork to new chat. The chevron by the title
 *  says it is there. */
export function renderChatTitleMenu(chat) {
  const state = chatTitleMenuState(chat);
  const available = state.available;
  const view = chat ? chatViewOf(chat) : undefined;
  const chevron = document.getElementById("chat-title-chevron");
  const menu = document.getElementById("chat-title-menu");
  const toggle = document.getElementById("chat-members-toggle");
  if (chevron && chevron.hidden === available) chevron.hidden = !available;
  if (!available) titleMenuState.chatTitleMenuOpen = false;
  if (toggle) {
    toggle.classList.toggle("has-menu", available);
    toggle.setAttribute("aria-haspopup", available ? "menu" : "dialog");
    toggle.setAttribute("aria-controls", available ? "chat-title-menu" : "members-sheet");
  }
  if (!menu) return;
  menu.hidden = !(available && titleMenuState.chatTitleMenuOpen);
  const label = state.views ? "Chat view" : "Session";
  if (menu.getAttribute("aria-label") !== label) menu.setAttribute("aria-label", label);
  for (const item of menu.querySelectorAll("[data-title-view]")) {
    if (item.hidden === state.views) item.hidden = !state.views;
    const checked = item.dataset.titleView === view ? "true" : "false";
    if (item.getAttribute("aria-checked") !== checked) item.setAttribute("aria-checked", checked);
  }
  // Open for a member it has not read yet (the screen under it changed
  // without a tap: the chat's main session changed, say): read now.
  if (titleMenuState.chatTitleMenuOpen && available && state.forkId && (!forkToNewChatState.forkMenu || forkToNewChatState.forkMenu.key !== forkMenuKey(chat.id, state.forkId))) {
    void readForkPlan(chat, state.forkId);
  }
  renderTitleMenuFork(chat, state.forkId);
}

export function toggleChatTitleMenu(open) {
  const was = titleMenuState.chatTitleMenuOpen;
  titleMenuState.chatTitleMenuOpen = open === undefined ? !titleMenuState.chatTitleMenuOpen : open;
  const chat = activeChatRecord();
  // Opened: whether the member can be forked now is read again.
  const state = chatTitleMenuState(chat);
  // Opened: read again, whatever it said before.
  if (titleMenuState.chatTitleMenuOpen && !was && state.available && state.forkId) forkToNewChatState.forkMenu = undefined;
  renderChatTitleMenu(chat);
}

function wireChatTitleMenu() {
  const menu = document.getElementById("chat-title-menu");
  if (!menu || menu.dataset.wired === "1") return;
  menu.dataset.wired = "1";
  menu.addEventListener("click", function (event) {
    const target = event.target instanceof Element ? event.target : null;
    const fork = target ? target.closest("#chat-title-fork") : null;
    if (fork) {
      // Disabled, it stays open: its line says why.
      forkFromItem(fork);
      return;
    }
    const item = target ? target.closest("[data-title-view]") : null;
    const conversationId = selectedConversationId();
    toggleChatTitleMenu(false);
    if (item && conversationId) void setChatViewFromPhone(conversationId, item.dataset.titleView);
  });
  document.addEventListener("click", function (event) {
    if (!titleMenuState.chatTitleMenuOpen || !(event.target instanceof Element)) return;
    if (event.target.closest("#chat-title-menu, #chat-members-toggle")) return;
    toggleChatTitleMenu(false);
  });
}

export function wireChatViewSwitch() {
  wireChatTitleMenu();
  const group = document.getElementById("chat-view-switch");
  if (!group || group.dataset.wired === "1") return;
  group.dataset.wired = "1";
  let noteTimer;
  group.addEventListener("click", function (event) {
    const option = event.target instanceof Element ? event.target.closest("[data-view]") : null;
    const conversationId = selectedConversationId();
    if (!option || !conversationId) return;
    const chat = activeChatRecord();
    if (!chatCanSwitchView(chat)) {
      // Unavailable, said where she tapped (a phone has no tooltip).
      const note = document.getElementById("chat-view-note");
      if (note) {
        note.textContent = CHAT_VIEW_SWITCH_DISABLED_REASON;
        note.hidden = false;
        clearTimeout(noteTimer);
        noteTimer = setTimeout(function () { note.hidden = true; }, 4000);
      }
      return;
    }
    void setChatViewFromPhone(conversationId, option.dataset.view);
  });
}
