import { nowIso } from "../base/bytes.js";
import { CHAT_LIST_AT_KEY, LIST_ACTIVITY_SEEN_KEY } from "../base/storageKeys.js";
import { controlCardsFor, storeControlCards } from "../cards/controlCardStore.js";
import { render } from "../chat/render.js";
import { saveChats } from "../chats/chatStore.js";

// What the list may carry per chat, and how much of each message: the same
// length Activity previews from.
const LIST_ACTIVITY_PER_CHAT = 8;

const LIST_ACTIVITY_CONTENT_CHARS = 880;

/** The members' messages the server's list carries for a chat (its running
 *  members and newest finished replies), kept in the shape Activity reads
 *  timeline rows in. A chat the phone never opened has no other rows, and
 *  without these Activity listed only the chats opened on this phone. */
export function listActivityOf(chat) {
  if (!Array.isArray(chat.activity)) return {};
  const rows = [];
  // The newest, if the server ever sends more than this phone keeps.
  for (const event of chat.activity.slice(-LIST_ACTIVITY_PER_CHAT)) {
    if (!event || typeof event !== "object" || event.hidden === true || event.role !== "participant") continue;
    const messageId = typeof event.messageId === "string" && event.messageId.trim() ? event.messageId.trim()
      : typeof event.id === "string" && event.id.trim() ? event.id.trim() : "";
    if (!messageId || (event.status !== "pending" && event.status !== "done")) continue;
    if (typeof event.content !== "string" || typeof event.createdAt !== "string") continue;
    rows.push({
      messageId: messageId,
      status: event.status,
      content: event.content.slice(0, LIST_ACTIVITY_CONTENT_CHARS),
      createdAt: event.createdAt,
      ...(typeof event.runId === "string" && event.runId ? { runId: event.runId } : {}),
      ...(typeof event.mobileEventId === "string" && event.mobileEventId ? { mobileEventId: event.mobileEventId } : {}),
      ...(typeof event.participantLabel === "string" && event.participantLabel ? { participantLabel: event.participantLabel } : {}),
      ...(typeof event.participantId === "string" && event.participantId ? { participantId: event.participantId } : {}),
      ...(typeof event.sourceMessageId === "string" && event.sourceMessageId ? { sourceMessageId: event.sourceMessageId } : {}),
      ...(typeof event.threadRootId === "string" && event.threadRootId ? { threadRootId: event.threadRootId } : {})
    });
  }
  return rows.length > 0 ? { activity: rows } : {};
}

function listActivitySeenKey(conversationId, row) {
  return conversationId + "\u0000" + row.messageId + "\u0000" + row.status;
}

export function loadListActivitySeen() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LIST_ACTIVITY_SEEN_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Each listed message keeps the moment it first came in its current state:
 *  the same list read again is not news, a run that finished since is. Only
 *  what the list still carries is kept. */
export function noteListActivitySeen(chats) {
  // The first list this phone keeps these for is the baseline, as the
  // first chat list after an update marks nothing: each message counts as
  // having come when it was written, so what was there before is judged
  // against when its chat was last looked at, not counted as new now.
  const firstList = localStorage.getItem(LIST_ACTIVITY_SEEN_KEY) === null;
  const previous = loadListActivitySeen();
  const next = {};
  const now = nowIso();
  let changed = firstList;
  for (const chat of chats) {
    for (const row of chat.activity || []) {
      const key = listActivitySeenKey(chat.id, row);
      next[key] = previous[key] || (firstList ? row.createdAt : now);
      if (!previous[key]) changed = true;
    }
  }
  if (!changed && Object.keys(previous).length === Object.keys(next).length) return;
  try {
    localStorage.setItem(LIST_ACTIVITY_SEEN_KEY, JSON.stringify(next));
  } catch {
    // Without it a listed reply only reads as new a little longer.
  }
}

/** The rows Activity is built from: what this phone holds of the chats it
 *  read, and for every chat the list carries, the members' messages it
 *  names. The same message from both is one row: the stored one, unless the
 *  list says a run the phone last saw going has finished. */
export function withListActivity(entries, chats, seen) {
  const listed = new Map();
  for (const chat of chats) {
    for (const row of chat.activity || []) {
      listed.set(chat.id + "\u0000" + row.messageId, {
        id: chat.id + ":" + row.messageId,
        sourceId: row.messageId,
        conversationId: chat.id,
        role: "participant",
        participantLabel: row.participantLabel,
        participantId: row.participantId,
        sourceMessageId: row.sourceMessageId,
        content: row.content,
        status: row.status,
        createdAt: row.createdAt,
        receivedAt: seen[listActivitySeenKey(chat.id, row)] || row.createdAt,
        runId: row.runId,
        mobileEventId: row.mobileEventId,
        messageId: row.messageId,
        threadRootId: row.threadRootId
      });
    }
  }
  if (listed.size === 0) return entries;
  const covered = new Set();
  const kept = entries.filter(function (entry) {
    const key = entry.conversationId + "\u0000" + (entry.messageId || entry.sourceId || "");
    const fromList = listed.get(key);
    if (!fromList) return true;
    if (entry.status === "pending" && fromList.status === "done") return false;
    covered.add(key);
    return true;
  });
  for (const [key, row] of listed) {
    if (!covered.has(key)) kept.push(row);
  }
  return kept;
}

// Only for a list this phone may have asked for before a card reached it
// (or one it did not ask for itself): such a list cannot know the card, so
// its silence about a card younger than this says nothing, and the next
// list decides. Both moments are this phone's own clock.
const PENDING_CARD_RECONCILE_GRACE_MS = 5 * 60_000;

/**
 * The server's chat list says which cards still wait in every chat it
 * lists, read from the same store as the chat pages that bring the cards.
 * A pending card this phone holds that a list asked for after the card
 * arrived does not name was answered or withdrawn while this phone was not
 * looking at that chat, and it leaves at once; without this it would wait
 * here for ever (the User's screenshot of 2026-09-20 showed cards closed
 * days earlier). A list that may predate the card leaves it to the next
 * list, for the grace above.
 *
 * Answered cards are kept; they are the record under their messages, and
 * the list says nothing about them.
 */
export function reconcilePendingControlCards(payload, options) {
  // The stamp says the desktop knows this contract; the judgement below is
  // on this phone's clock.
  if (!Number.isFinite(Date.parse(typeof payload.generatedAt === "string" ? payload.generatedAt : ""))) return 0;
  const now = Date.now();
  // When this phone sent the request the list answers. The server serves
  // the list and the chat pages from one store, so a list asked for after a
  // card arrived knows everything the page that brought the card knew.
  const askedAt = options && Number.isFinite(options.requestedAt) ? options.requestedAt : undefined;
  let changed = 0;
  for (const chat of payload.chats) {
    if (!chat || typeof chat.id !== "string" || !Array.isArray(chat.pendingCards)) continue;
    const listed = new Map();
    for (const card of chat.pendingCards) {
      if (card && typeof card.id === "string" && card.status === "pending") {
        listed.set(card.id, { ...card, conversationId: chat.id });
      }
    }
    const next = [];
    const seen = new Set();
    for (const card of controlCardsFor(chat.id)) {
      if (!card || typeof card.id !== "string") continue;
      seen.add(card.id);
      if (card.status !== "pending") {
        // An answered card is never reopened by a list that was read before
        // the answer: what this phone holds is the later fact. A waiting one
        // (approved, not applied yet) is the chat page's to settle: the list
        // carries only pending cards.
        next.push(card);
        continue;
      }
      const fresh = listed.get(card.id);
      if (fresh) {
        next.push({ ...card, ...fresh });
        continue;
      }
      const receivedAt = Date.parse(card.receivedAt || card.createdAt || "");
      const listIsLater = askedAt !== undefined && Number.isFinite(receivedAt) && receivedAt < askedAt;
      if (!listIsLater && Number.isFinite(receivedAt) && receivedAt > now - PENDING_CARD_RECONCILE_GRACE_MS) {
        // Too new to judge: the list may predate it. The next list decides.
        next.push(card);
      }
      // Otherwise the desktop no longer waits on it, and neither does this phone.
    }
    for (const card of listed.values()) {
      if (!seen.has(card.id)) next.push(card);
    }
    if (storeControlCards(chat.id, next)) changed += 1;
  }
  return changed;
}

export function handleRelayChatListPayload(payload, options) {
  if (payload?.type !== "mobile.chat-list" || !Array.isArray(payload.chats)) {
    return [];
  }
  // A card the list closed leaves the screen now, whether or not the
  // caller redraws afterwards.
  if (reconcilePendingControlCards(payload, options) > 0) void render();
  // When the desktop last said which chats have a run going; Activity
  // trusts a "still running" row only if it started after that.
  try {
    localStorage.setItem(CHAT_LIST_AT_KEY, nowIso());
  } catch {
    // Without it Activity simply shows what the chat shows.
  }
  return saveChats(payload.chats);
}
