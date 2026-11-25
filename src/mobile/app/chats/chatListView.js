import { nowIso, recordRelayDebug } from "../base/bytes.js";
import { outboxStatusById } from "../base/storageKeys.js";
import { sessionsViewNamesFor, sessionsViewTextFor } from "../cards/cardText.js";
import { chatGroupsState, filterChatsByQuery, groupedChats, loadCollapsedChatGroups, toggleChatGroupCollapsed } from "./chatGroups.js";
import { loadChats, loadUnreadConversationIds } from "./chatStore.js";
import { openConversation, selectedConversationId } from "./openChat.js";
import { OUTBOX_REFUSED, OUTBOX_SENT, OUTBOX_SUPERSEDED } from "../outbox/hubOutbox.js";
import { canSync, createOutboxEvent, persistOutboundEvent, sendNow } from "../outbox/sending.js";
import { loadPairing } from "../pairing/pairing.js";
import { chatViewOf, sessionsRules } from "../sessions/sessionsState.js";
import { relativeTime, syncProgressText, syncWaitStartedAt } from "../sync/connectionStatus.js";

let lastChatListRenderSignature = "";

/** Who wrote a chat's newest message, before its snippet: a chat shown in
 *  the sessions view names no member there (no handles in that view, and a
 *  member's task is not known without the chat's messages). */
function chatRowWho(chat) {
  const who = typeof chat.who === "string" ? chat.who : "";
  if (!who || /^(you|system):$/i.test(who.trim())) return who;
  return chatViewOf(chat) === "sessions" ? "" : who;
}

const ARTIFACT_NOTE_SNIPPET = /^@[A-Za-z0-9][A-Za-z0-9_-]* (?:created|revised|renamed|signed|archived|restored|submitted|withdrew|published) /;

/** A sessions-view chat's subtitle: when its newest message is a reply the
 *  app ended (its lines start with its member's own handle: "@main stopped
 *  before it returned a response."), those words name nobody by handle, as
 *  in the chat (sessionsViewReplyText); a member's own words stay. */
function sessionsViewSnippet(chat, text) {
  const who = typeof chat.who === "string" ? chat.who.trim().replace(/:$/, "") : "";
  if (typeof text !== "string" || text.indexOf("@") < 0) return text;
  // A document's note ("@drew revised Plan · v3") is the app's line too.
  if (/^system$/i.test(who) && ARTIFACT_NOTE_SNIPPET.test(text)) return sessionsViewTextFor(chat.id, text);
  if (!who || /^(you|system)$/i.test(who)) return text;
  const shared = sessionsRules();
  const names = sessionsViewNamesFor(chat.id);
  if (!names || !shared || typeof shared.sessionsViewReplyText !== "function") return text;
  // The app's line without handles; a member's words by the mention rule.
  const worded = shared.sessionsViewReplyText(text, who, names);
  return typeof shared.sessionsMentionText === "function" ? shared.sessionsMentionText(worded, names) : worded;
}

/** The chat list's subtitle is the desktop's 84-character cut of the last
 *  message with its line breaks already collapsed, so the line-based rule
 *  cannot find the block inside it: what follows the marker on that one line
 *  is protocol, and the User should read the sentence before it instead. Her
 *  own messages and the app's are left exactly as they are, as the desktop
 *  leaves them. */
function snippetDisplayText(chat) {
  const snippet = typeof chat.snippet === "string" ? chat.snippet : "";
  const who = typeof chat.who === "string" ? chat.who.trim().toLowerCase() : "";
  if (who === "you:" || who === "system:") {
    return snippet;
  }
  const cut = snippet.replace(/\s*user choice\s*:.*$/i, "").trim();
  return cut || "Asked you a question";
}

/** How many chats Recents lists, as Claude's does (and the desktop). */
const RECENT_CHAT_LIMIT = 20;

/** The folds of the two lists above the projects (never a project's name). */
const PINNED_GROUP_KEY = "\u0000pinned";

const RECENTS_GROUP_KEY = "\u0000recents";

/** A pin this phone asked for, shown until the server's list says so: kept
 *  while it waits to be sent (no connection), dropped when the server
 *  refused it, and once taken, kept this long at most for the list to
 *  catch up. */
const PIN_OVERRIDE_TAKEN_MS = 60_000;

const pinOverrides = new Map();

function chatWithPinOverride(chat) {
  const override = pinOverrides.get(chat.id);
  if (!override) return chat;
  const sent = override.eventId ? outboxStatusById.get(override.eventId) : undefined;
  const status = sent && sent.status;
  if (status === OUTBOX_SENT && !override.takenAt) override.takenAt = Date.now();
  // Only once her server has taken this pin: before that, a list saying the
  // same is an older one (from before a pin undone just ahead of it), and
  // the next list, with that earlier pin, would show it again.
  const settled = override.takenAt !== undefined && (chat.pinned === true) === override.pinned;
  const refused = status === OUTBOX_REFUSED || status === OUTBOX_SUPERSEDED;
  const stale = override.takenAt !== undefined && Date.now() - override.takenAt > PIN_OVERRIDE_TAKEN_MS;
  if (settled || refused || stale) {
    pinOverrides.delete(chat.id);
    return chat;
  }
  if (override.pinned) return { ...chat, pinned: true, pinnedAt: override.pinnedAt };
  const { pinned: _pinned, pinnedAt: _pinnedAt, ...rest } = chat;
  return rest;
}

function chatTimeValue(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : 0;
}

/** Pinned chats in the order they were pinned (a new one goes to the
 *  bottom; one whose time is not known, last), as the desktop orders them
 *  (pinnedChatSummaries). */
function pinnedChats(chats) {
  const pinnedAtValue = function (chat) {
    const value = Date.parse(chat.pinnedAt || "");
    return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
  };
  return chats.filter(function (chat) { return chat.pinned === true; }).sort(function (left, right) {
    return pinnedAtValue(left) - pinnedAtValue(right) ||
      String(left.title).localeCompare(String(right.title)) || String(left.id).localeCompare(String(right.id));
  });
}

/** The newest chats of every project, pinned ones included, as the desktop
 *  lists them (recentChatSummaries). */
function recentChats(chats) {
  return chats.slice().sort(function (left, right) {
    return chatTimeValue(right.updatedAt) - chatTimeValue(left.updatedAt) ||
      String(left.title).localeCompare(String(right.title)) || String(left.id).localeCompare(String(right.id));
  }).slice(0, RECENT_CHAT_LIMIT);
}

/** The one mark a chat shows (the User, 2026-11-15): a member at work, else
 *  a question waiting for her, else something new, else none. */
function chatRowMark(chat, unread) {
  if (chat.running) return "running";
  if (chat.waitingChoice === true) return "waiting";
  if (unread) return "unread";
  return "none";
}

export function renderChatList() {
  const listContainer = document.getElementById("chat-list");
  if (listContainer) {
    delete listContainer.dataset.state;
  }
  const container = document.getElementById("chat-list");
  if (!container) {
    return;
  }
  const allChats = loadChats().map(chatWithPinOverride);
  const chats = filterChatsByQuery(allChats, chatGroupsState.chatSearchQuery);
  const activeId = selectedConversationId();
  const unreadIds = loadUnreadConversationIds();
  // A search shows everything it matches; folding applies to the plain list,
  // and the headers are plain labels while a search is open so a tap cannot
  // change a fold it does not show.
  const searching = Boolean(chatGroupsState.chatSearchQuery.trim());
  const collapsedGroups = searching ? [] : loadCollapsedChatGroups();
  const renderSignature = JSON.stringify({
    activeId,
    query: chatGroupsState.chatSearchQuery,
    unreadIds,
    collapsedGroups,
    chats: chats.map(function (chat) {
      return {
        id: chat.id,
        title: chat.title,
        group: chat.group,
        snippet: chat.snippet,
        who: chat.who,
        running: chat.running,
        pinned: chat.pinned === true ? chat.pinnedAt || true : false,
        waitingChoice: chat.waitingChoice === true,
        updatedAt: chat.updatedAt
      };
    })
  });
  if (lastChatListRenderSignature === renderSignature) {
    return;
  }
  lastChatListRenderSignature = renderSignature;
  container.textContent = "";
  if (allChats.length > 0 && chats.length === 0) {
    const empty = document.createElement("div");
    empty.className = "mobile-empty";
    empty.textContent = "No chats match “" + chatGroupsState.chatSearchQuery.trim() + "”.";
    container.append(empty);
    return;
  }
  if (chats.length === 0) {
    const empty = document.createElement("div");
    empty.className = "mobile-empty";
    if (!canSync(loadPairing())) {
      empty.textContent = "Scan the code from your computer (Settings → Device Pairing) to connect this phone.";
    } else {
      empty.textContent = "";
      const line = document.createElement("div");
      line.className = "sync-progress";
      line.dataset.startedAt = syncWaitStartedAt();
      line.textContent = syncProgressText(line.dataset.startedAt);
      empty.append(line);
    }
    container.append(empty);
    return;
  }
  // Pinned and Recents above the projects, as on the desktop (the User,
  // 2026-11-15); a chat may be listed in all three. A search lists by
  // project only, each match once.
  const sections = [];
  if (!searching) {
    const pinned = pinnedChats(chats);
    if (pinned.length) sections.push({ key: PINNED_GROUP_KEY, name: "Pinned", kind: "pinned", items: pinned });
    sections.push({ key: RECENTS_GROUP_KEY, name: "Recents", kind: "recents", items: recentChats(chats) });
  }
  for (const group of groupedChats(chats)) {
    sections.push({ key: group.name, name: group.name, kind: "project", items: group.items });
  }
  for (const group of sections) {
    const collapsed = collapsedGroups.indexOf(group.key) >= 0;
    const title = document.createElement(searching ? "div" : "button");
    title.className = "mobile-chat-group-title";
    title.dataset.group = group.name;
    title.dataset.section = group.kind;
    const name = document.createElement("span");
    name.className = "mobile-chat-group-name";
    name.textContent = group.name;
    if (searching) {
      title.append(name);
    } else {
      title.type = "button";
      title.setAttribute("aria-expanded", collapsed ? "false" : "true");
      const chevron = document.createElement("span");
      chevron.className = "mobile-chat-group-chevron";
      chevron.setAttribute("aria-hidden", "true");
      title.append(chevron, name);
    }
    if (collapsed) {
      // Folded away, not silenced: the count says what is inside, and a
      // fresh message in a folded project still shows its dot here.
      const count = document.createElement("span");
      count.className = "mobile-chat-group-count";
      count.textContent = String(group.items.length);
      title.append(count);
      if (group.items.some(function (chat) { return unreadIds.indexOf(chat.id) >= 0; })) {
        const dot = document.createElement("span");
        dot.className = "mobile-unread-dot";
        dot.setAttribute("aria-label", "Unread messages");
        title.append(dot);
      }
    }
    if (!searching) {
      title.addEventListener("click", function () {
        toggleChatGroupCollapsed(group.key);
        renderChatList();
      });
    }
    if (collapsed) {
      container.append(title);
      continue;
    }
    const list = document.createElement("div");
    list.className = "mobile-chat-group";
    list.dataset.section = group.kind;
    for (const chat of group.items) {
      list.append(chatListRow(chat, activeId, unreadIds));
    }
    container.append(title, list);
  }
}

/** One chat's row, the same wherever it is listed. */
function chatListRow(chat, activeId, unreadIds) {
  const row = document.createElement("button");
  const unread = unreadIds.indexOf(chat.id) >= 0;
  const mark = chatRowMark(chat, unread);
  // One mark per row (the User, 2026-11-15): the unread look only when news is the mark.
  row.className = "mobile-chat-row" + (chat.id === activeId ? " is-active" : "") + (mark === "unread" ? " is-unread" : "");
  row.type = "button";
  row.dataset.conversationId = chat.id;
  if (mark === "unread") {
    row.dataset.unread = "1";
  }
  if (chat.pinned === true) {
    row.dataset.pinned = "1";
  }
  row.dataset.mark = mark;
  row.addEventListener("click", function () {
    // The tap that ended a long press opened the chat's actions, not the chat.
    if (row.dataset.longPressed === "1") {
      delete row.dataset.longPressed;
      return;
    }
    openConversation(chat.id);
  });
  wireChatRowLongPress(row, chat.id);
  // No avatars on a row (the User, 2026-11-01): the title, the last
  // line and when.
  const copy = document.createElement("div");
  copy.className = "mobile-chat-copy";
  const titleLine = document.createElement("div");
  titleLine.className = "mobile-chat-title-line";
  const strong = document.createElement("strong");
  strong.textContent = chat.title;
  titleLine.append(strong);
  if (mark === "running") {
    const live = document.createElement("span");
    live.className = "mobile-live-dot";
    titleLine.append(live);
  } else if (mark === "waiting") {
    const dot = document.createElement("span");
    dot.className = "mobile-waiting-dot";
    dot.setAttribute("aria-label", "Waiting for your answer");
    titleLine.append(dot);
  } else if (mark === "unread") {
    const dot = document.createElement("span");
    dot.className = "mobile-unread-dot";
    dot.setAttribute("aria-label", "New activity");
    titleLine.append(dot);
  }
  const snippet = document.createElement("div");
  snippet.className = "mobile-chat-snippet";
  if (chatRowWho(chat)) {
    const who = document.createElement("b");
    who.textContent = chatRowWho(chat);
    snippet.append(who);
  }
  const snippetText = document.createElement("span");
  snippetText.textContent = sessionsViewSnippet(chat, snippetDisplayText(chat));
  snippet.append(snippetText);
  copy.append(titleLine, snippet);
  const when = document.createElement("div");
  when.className = "mobile-chat-time";
  when.textContent = relativeTime(chat.updatedAt);
  row.append(copy, when);
  return row;
}

// --- a chat's actions (a long press on its row) ----------------------------

const CHAT_LONG_PRESS_MS = 500;

const CHAT_LONG_PRESS_SLOP_PX = 10;
let chatActionsConversationId;
let chatActionsOpenedAt = 0;

/** A tap on the sheet this soon after it opened is the long press ending. */
const CHAT_ACTIONS_SETTLE_MS = 400;

/** Held still for a moment, the row opens the chat's actions; moved, it
 *  scrolls the list as before. A right click (or a desktop browser's
 *  long press) does the same. */
function wireChatRowLongPress(row, conversationId) {
  let timer;
  let startX = 0;
  let startY = 0;
  const cancel = function () {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  row.addEventListener("touchstart", function (event) {
    if (event.touches.length !== 1) return;
    delete row.dataset.longPressed;
    startX = event.touches[0].clientX;
    startY = event.touches[0].clientY;
    cancel();
    timer = setTimeout(function () {
      timer = undefined;
      row.dataset.longPressed = "1";
      openChatActions(conversationId, true);
    }, CHAT_LONG_PRESS_MS);
  }, { passive: true });
  row.addEventListener("touchmove", function (event) {
    if (!timer || event.touches.length !== 1) return;
    const dx = event.touches[0].clientX - startX;
    const dy = event.touches[0].clientY - startY;
    if (Math.abs(dx) > CHAT_LONG_PRESS_SLOP_PX || Math.abs(dy) > CHAT_LONG_PRESS_SLOP_PX) cancel();
  }, { passive: true });
  // The finger lifting after a long press must not also tap what opened
  // under it (the sheet's backdrop or its Pin row).
  row.addEventListener("touchend", function (event) {
    cancel();
    if (row.dataset.longPressed === "1" && event.cancelable) event.preventDefault();
  });
  row.addEventListener("touchcancel", cancel);
  row.addEventListener("contextmenu", function (event) {
    event.preventDefault();
    cancel();
    openChatActions(conversationId, false);
  });
}

/** `byTouch`: opened by a finger still on the glass, whose lifting must not
 *  tap the sheet. */
function openChatActions(conversationId, byTouch) {
  const sheet = document.getElementById("chat-actions-sheet");
  const title = document.getElementById("chat-actions-title");
  const pin = document.getElementById("chat-actions-pin");
  const chat = loadChats().map(chatWithPinOverride).find(function (item) { return item.id === conversationId; });
  if (!sheet || !title || !pin || !chat) return;
  chatActionsConversationId = conversationId;
  title.textContent = chat.title || "Chat";
  pin.textContent = chat.pinned === true ? "Unpin" : "Pin";
  pin.dataset.pinned = chat.pinned === true ? "1" : "0";
  if (byTouch) chatActionsOpenedAt = Date.now();
  else if (sheet.hidden) chatActionsOpenedAt = 0;
  sheet.hidden = false;
  pin.focus({ preventScroll: true });
  // Haptics where the phone offers them: the press was taken.
  if (navigator.vibrate) {
    try { navigator.vibrate(10); } catch { /* not offered */ }
  }
}

function closeChatActions() {
  const sheet = document.getElementById("chat-actions-sheet");
  if (sheet) sheet.hidden = true;
  chatActionsConversationId = undefined;
}

export function wireChatActionsSheet() {
  const sheet = document.getElementById("chat-actions-sheet");
  if (!sheet) return;
  const settling = function () { return Date.now() - chatActionsOpenedAt < CHAT_ACTIONS_SETTLE_MS; };
  sheet.addEventListener("click", function (event) {
    const target = event.target;
    if (settling()) return;
    if (target instanceof Element && target.closest("[data-chat-actions-close]")) closeChatActions();
  });
  document.getElementById("chat-actions-close")?.addEventListener("click", closeChatActions);
  document.getElementById("chat-actions-pin")?.addEventListener("click", function (event) {
    if (settling()) {
      event.stopPropagation();
      return;
    }
    const conversationId = chatActionsConversationId;
    const pinned = event.currentTarget instanceof HTMLElement && event.currentTarget.dataset.pinned === "1";
    closeChatActions();
    if (conversationId) void setChatPinnedFromPhone(conversationId, !pinned);
  });
}

/** Pins or unpins a chat for every device: shown here at once, sent to the
 *  User's server like everything else the phone writes. */
async function setChatPinnedFromPhone(conversationId, pinned) {
  const pinnedAt = nowIso();
  const override = { pinned: pinned, pinnedAt: pinnedAt };
  pinOverrides.set(conversationId, override);
  renderChatList();
  try {
    const entry = await createOutboxEvent({ conversationId: conversationId, kind: "conversation.pin", payload: { pinned: pinned, pinnedAt: pinnedAt } })
      .then(persistOutboundEvent);
    override.eventId = entry.eventId;
  } catch (error) {
    pinOverrides.delete(conversationId);
    renderChatList();
    recordRelayDebug({ event: "chat-pin-not-queued", message: error instanceof Error ? error.message : String(error) });
    return;
  }
  await sendNow();
}
