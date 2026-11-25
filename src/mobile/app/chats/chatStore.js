import { nowIso, recordRelayDebug } from "../base/bytes.js";
import {
  CHAT_LIST_KEY, CHAT_TITLES_META_KEY, OWN_CHATS_KEY, SYNC_WAIT_KEY, UNREAD_KEY, UNREAD_META_KEY, VIEWED_AT_KEY
} from "../base/storageKeys.js";
import { renderChatList } from "./chatListView.js";
import { selectedConversationId } from "./openChat.js";
import { normalizeMobileMember } from "../members/mentions.js";
import { loadPairing } from "../pairing/pairing.js";
import { loadStoredStringArray, readMetaRecord, saveStoredStringArray, writeMetaRecord } from "../store/database.js";
import { listActivityOf, noteListActivitySeen } from "../sync/chatListPayload.js";
import { settleTurnsThatLeftTheList } from "../sync/settledTurns.js";

// The list is read for every avatar painted and every row reconciled;
// parsing a hundred chats with their member records each time was tens of
// megabytes of JSON per list rebuild on the User's phone. The parse is kept
// until the list is saved again here, or changed by another window of this
// origin (the storage event); the objects are never mutated by readers.
export let cachedChatList;

export function forgetCachedChatList() {
  cachedChatList = undefined;
}

export function loadChats() {
  try {
    if (!cachedChatList) {
      const raw = localStorage.getItem(CHAT_LIST_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      cachedChatList = Array.isArray(parsed) ? parsed : [];
    }
    // A chat started here is in the list before the server lists it.
    const started = loadStartedChats().filter(function (chat) {
      return !cachedChatList.some(function (known) { return known.id === chat.id; });
    });
    return started.length ? started.concat(cachedChatList) : cachedChatList;
  } catch {
    return [];
  }
}

// Chats started on this phone that the server's list does not name yet.
export const STARTED_CHATS_KEY = "accordagents.mobile.startedChats.v1";

export function loadStartedChats() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STARTED_CHATS_KEY) || "[]");
    // Started under this pairing: paired again (to another server, say),
    // the phone does not show what it started before.
    const pairing = loadPairing();
    const here = pairing && pairing.deviceId;
    return Array.isArray(parsed) ? parsed.filter(function (chat) { return chat && typeof chat.id === "string" && Boolean(here) && chat.deviceId === here; }) : [];
  } catch {
    return [];
  }
}

export function saveStartedChats(chats) {
  try {
    if (chats.length) localStorage.setItem(STARTED_CHATS_KEY, JSON.stringify(chats));
    else localStorage.removeItem(STARTED_CHATS_KEY);
  } catch {
    // Kept as it was: shown until the server lists it.
  }
}

/** A chat started here that will not be made (the server refused it, or
 *  nothing was queued): out of the list, as the computer lists no chat its
 *  New chat failed to make. Why stays in the send log and in the chat. */
export function forgetStartedChat(conversationId) {
  const own = loadStoredStringArray(OWN_CHATS_KEY);
  if (own.indexOf(conversationId) >= 0) saveStoredStringArray(OWN_CHATS_KEY, own.filter(function (id) { return id !== conversationId; }));
  const started = loadStartedChats();
  const kept = started.filter(function (chat) { return chat.id !== conversationId; });
  if (kept.length === started.length) return;
  saveStartedChats(kept);
  renderChatList();
}

export function saveChats(chats) {
  if (Array.isArray(chats) && chats.length > 0) {
    sessionStorage.removeItem(SYNC_WAIT_KEY);
  }
  const previousById = new Map(loadChats().map(function (chat) {
    return [chat.id, chat];
  }));
  const normalized = Array.isArray(chats) ? chats.filter(function (chat) {
    return chat && typeof chat.id === "string" && chat.id.trim() && chat.startedHere !== true;
  }).map(function (chat) {
    return {
      id: chat.id,
      title: typeof chat.title === "string" && chat.title.trim() ? chat.title : "Chat",
      group: typeof chat.group === "string" && chat.group.trim() ? chat.group : "AccordAgents",
      snippet: typeof chat.snippet === "string" && chat.snippet.trim() ? chat.snippet : "No messages yet",
      who: typeof chat.who === "string" ? chat.who : undefined,
      updatedAt: typeof chat.updatedAt === "string" ? chat.updatedAt : nowIso(),
      running: chat.running === true,
      ...(chat.pinned === true ? { pinned: true, ...(typeof chat.pinnedAt === "string" ? { pinnedAt: chat.pinnedAt } : {}) } : {}),
      ...(chat.waitingChoice === true ? { waitingChoice: true } : {}),
      // A chat with a main session, and the view it opens in (the desktop's
      // switch, shared through her server like the pin).
      ...(typeof chat.mainSessionParticipantId === "string" && chat.mainSessionParticipantId
        ? { mainSessionParticipantId: chat.mainSessionParticipantId } : {}),
      ...(chat.chatView === "sessions" || chat.chatView === "classic" ? { chatView: chat.chatView } : {}),
      ...(chat.canSwitchView === true ? { canSwitchView: true } : {}),
      // The Accords folded into the chat, as her server records them over
      // the whole chat: their cards are not pinned here.
      ...(Array.isArray(chat.accordClosed) ? { accordClosed: chat.accordClosed.filter(function (id) {
        return typeof id === "string" && id;
      }).slice(0, 200) } : {}),
      participants: Array.isArray(chat.participants) ? chat.participants.filter(function (item) {
        return typeof item === "string" && item.trim();
      }).slice(0, 4) : [],
      members: Array.isArray(chat.members) ? chat.members.map(normalizeMobileMember).filter(Boolean) : [],
      ...listActivityOf(chat)
    };
  }) : [];
  // A full storage must not stop the list: without the members' recent
  // messages it is a fraction of the size, and failing that it is kept for
  // this session only. A list write that threw left the phone on the list
  // it had, whatever the server said.
  let kept = normalized;
  try {
    localStorage.setItem(CHAT_LIST_KEY, JSON.stringify(normalized));
    forgetCachedChatList();
  } catch {
    kept = normalized.map(function (chat) {
      const { activity: _activity, ...rest } = chat;
      return rest;
    });
    try {
      localStorage.setItem(CHAT_LIST_KEY, JSON.stringify(kept));
      forgetCachedChatList();
    } catch {
      recordRelayDebug({ event: "chat-list-not-stored" });
    }
    cachedChatList = kept;
  }
  noteListActivitySeen(kept);
  settleTurnsThatLeftTheList(previousById, normalized);
  // A chat started here that the server now lists is the server's.
  const started = loadStartedChats();
  const stillStarted = started.filter(function (chat) {
    return !normalized.some(function (known) { return known.id === chat.id; });
  });
  if (stillStarted.length !== started.length) saveStartedChats(stillStarted);
  // A chat she started here stays hers until it holds something she did
  // not make: a member at work, a question for her, a line not hers. One
  // her server no longer lists (and that is not still on its way) goes.
  const ownIds = loadStoredStringArray(OWN_CHATS_KEY);
  const stillOwn = ownIds.filter(function (id) {
    const listed = normalized.find(function (chat) { return chat.id === id; });
    if (!listed) return started.some(function (chat) { return chat.id === id; });
    return listed.running !== true && listed.waitingChoice !== true && (!listed.who || listed.who === "you:");
  });
  if (stillOwn.length !== ownIds.length) saveStoredStringArray(OWN_CHATS_KEY, stillOwn);
  // Same rule as the desktop sidebar: a chat that moved while it was not the
  // one on screen is unread. The list this phone held before is the "seen"
  // baseline, so the first list after an update marks nothing. A chat she
  // made herself (New chat, a fork) is no news to her, wherever she is by
  // the time her server lists it: it moves as her server takes what she
  // made, until something else is in it.
  const activeId = selectedConversationId();
  const viewingActive = Boolean(activeId) && !document.hidden;
  const newlyActive = normalized.filter(function (chat) {
    const previous = previousById.get(chat.id);
    return Boolean(previous) &&
      stillOwn.indexOf(chat.id) < 0 &&
      chat.updatedAt > previous.updatedAt &&
      !(viewingActive && chat.id === activeId);
  }).map(function (chat) {
    return chat.id;
  });
  if (newlyActive.length > 0) {
    markConversationsUnread(newlyActive);
  }
  void mirrorChatTitlesForWorker(normalized);
  return normalized;
}

/** A chat she starts here is hers (OWN_CHATS_KEY) until it holds
 *  something she did not make. */
export function noteOwnChat(conversationId) {
  const own = loadStoredStringArray(OWN_CHATS_KEY);
  if (own.indexOf(conversationId) < 0) saveStoredStringArray(OWN_CHATS_KEY, own.concat(conversationId));
}

export function loadUnreadConversationIds() {
  return loadStoredStringArray(UNREAD_KEY);
}

export function markConversationsUnread(conversationIds) {
  const current = loadUnreadConversationIds();
  const next = current.slice();
  for (const conversationId of conversationIds) {
    if (conversationId && next.indexOf(conversationId) < 0) {
      next.push(conversationId);
    }
  }
  if (next.length === current.length) {
    return;
  }
  saveStoredStringArray(UNREAD_KEY, next);
  void syncUnreadWithWorker(next);
}

export function markConversationRead(conversationId) {
  const current = loadUnreadConversationIds();
  if (current.indexOf(conversationId) < 0) {
    return;
  }
  const next = current.filter(function (item) {
    return item !== conversationId;
  });
  saveStoredStringArray(UNREAD_KEY, next);
  void syncUnreadWithWorker(next);
}

export function loadViewedAt() {
  try {
    const parsed = JSON.parse(localStorage.getItem(VIEWED_AT_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Records that the chat was looked at now, on this phone's clock: Activity
 *  compares it with when rows reached this phone, never with a desktop
 *  stamp, so a desktop clock running ahead cannot mark news as seen. Every
 *  render of the open chat lands here, so the answer the User just watched
 *  finish is always behind the mark. */
export function markConversationViewed(conversationId, newestReceivedAt, viewedAt) {
  if (!conversationId) return;
  const all = loadViewedAt();
  const stored = Date.parse(all[conversationId] || "");
  const newest = Date.parse(newestReceivedAt || "");
  // A mark already past the newest row this phone holds for the chat says
  // all it needs to; rewriting it on every redraw of a streaming chat made
  // Activity rebuild its lists on each one.
  if (Number.isFinite(stored) && (!Number.isFinite(newest) || stored >= newest)) return;
  // Now, unless the look happened earlier (a chat opened and left before
  // its page came): never moved back.
  const next = viewedAt || nowIso();
  if (Number.isFinite(stored) && stored >= Date.parse(next)) return;
  all[conversationId] = next;
  try {
    localStorage.setItem(VIEWED_AT_KEY, JSON.stringify(all));
  } catch {
    // Losing this only makes an update look unseen a little longer.
  }
}

// The number on the icon is the number of chats with something new, the
// same thing the dots in the list add up to. The IndexedDB copy is what a
// push-woken service worker adds to and shows while the page is closed.
async function syncUnreadWithWorker(ids) {
  await writeMetaRecord(UNREAD_META_KEY, { ids: ids }).catch(function () { return undefined; });
  applyAppBadge(ids.length);
}

function applyAppBadge(count) {
  if (!("setAppBadge" in navigator)) {
    return;
  }
  const apply = count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge();
  Promise.resolve(apply).catch(function () { return undefined; });
}

// The worker cannot read localStorage, and the chat list lives there; the
// titles it needs for a notification are mirrored, nothing else.
async function mirrorChatTitlesForWorker(chats) {
  const titles = {};
  for (const chat of chats) {
    titles[chat.id] = chat.title;
  }
  await writeMetaRecord(CHAT_TITLES_META_KEY, { titles: titles }).catch(function () { return undefined; });
}

// Reconciles the unread set with what a push-woken worker added while the
// page was closed, then puts the icon number back in step.
export async function adoptWorkerUnread() {
  const record = await readMetaRecord(UNREAD_META_KEY).catch(function () { return undefined; });
  const workerIds = record && Array.isArray(record.ids) ? record.ids.filter(function (id) {
    return typeof id === "string" && id.trim();
  }) : [];
  // The chat on screen is being read only while the page is visible; a
  // push counted for it behind a locked screen is still news.
  const activeId = selectedConversationId();
  const viewingActive = Boolean(activeId) && !document.hidden;
  const merged = loadUnreadConversationIds();
  for (const id of workerIds) {
    if (merged.indexOf(id) < 0 && !(viewingActive && id === activeId)) {
      merged.push(id);
    }
  }
  saveStoredStringArray(UNREAD_KEY, merged);
  await syncUnreadWithWorker(merged);
}
