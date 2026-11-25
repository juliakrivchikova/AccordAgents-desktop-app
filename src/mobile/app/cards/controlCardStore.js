import { nowIso } from "../base/bytes.js";
import { CONTROL_CARDS_KEY } from "../base/storageKeys.js";
import { clearCardSent, controlCardErrors, noteRefusedAnswer } from "./cardAnswers.js";
import { choiceDrafts, choiceViews } from "./choiceCard.js";

// The cards of every synced chat in one string. Parsing it per row per
// redraw cost tens of milliseconds on a store with hundreds of answered
// choices, on every batch of a streaming run; the parse is kept until the
// string itself changes.
let controlCardsParseCache;

export function loadControlCards() {
  try {
    const raw = localStorage.getItem(CONTROL_CARDS_KEY);
    if (controlCardsParseCache && controlCardsParseCache.raw === raw) {
      return controlCardsParseCache.parsed;
    }
    const decoded = raw ? JSON.parse(raw) : {};
    const parsed = decoded && typeof decoded === "object" && !Array.isArray(decoded) ? decoded : {};
    controlCardsParseCache = { raw: raw, parsed: parsed };
    return parsed;
  } catch {
    return {};
  }
}

function saveControlCards(byConversation) {
  try {
    controlCardsParseCache = undefined;
    localStorage.setItem(CONTROL_CARDS_KEY, JSON.stringify(byConversation));
    return true;
  } catch {
    // A full quota must not lose the timeline; the cards arrive again with
    // the next batch. Said so to the caller rather than counted as written.
    return false;
  }
}

// Answered cards a batch does not name are kept as the record under their
// messages; only this many per chat, newest first, so the store cannot grow
// with every choice ever answered.
// Per chat, and the record only matters for the chats still being read:
// a hundred each across every chat the phone has opened grew towards the
// few megabytes the browser allows, past which no new card is stored.
const CONTROL_CARDS_KEPT_ANSWERED_LIMIT = 30;

export function controlCardsFor(conversationId) {
  const stored = loadControlCards()[conversationId];
  return Array.isArray(stored) ? stored : [];
}

/** The desktop states the whole set for a chat, so it replaces rather than
 *  merges: a card it no longer lists has been answered or withdrawn. */
export function storeControlCards(conversationId, cards) {
  if (!conversationId || !Array.isArray(cards)) return false;
  const all = loadControlCards();
  const previous = Array.isArray(all[conversationId]) ? all[conversationId] : [];
  const before = JSON.stringify(previous);
  const previousById = new Map(previous.filter(function (card) { return card && card.id; })
    .map(function (card) { return [card.id, card]; }));
  // When each card reached this phone, on its own clock: what a later list
  // is judged against. A card already held keeps the moment it first came.
  const arrived = nowIso();
  const stamped = cards.map(function (card) {
    if (!card || !card.id) return card;
    const held = previousById.get(card.id);
    return { ...card, receivedAt: (held && held.receivedAt) || card.receivedAt || arrived };
  });
  // What the server sends is the whole of what still waits, so a pending
  // card it leaves out is closed. An answered card it leaves out was only
  // outside the page it read: it stays, as the record under its message.
  const incoming = new Set(stamped.map(function (card) { return card && card.id; }));
  const kept = previous.filter(function (card) {
    // A waiting card is not a record: once the server leaves it out, what
    // it waited for has happened (or will not).
    return card && card.id && !incoming.has(card.id) && card.status !== "pending" && card.waiting !== true;
  }).sort(function (left, right) {
    return String(right.createdAt || "").localeCompare(String(left.createdAt || ""));
  }).slice(0, CONTROL_CARDS_KEPT_ANSWERED_LIMIT);
  const next = stamped.concat(kept);
  // Before the sameness check: the same answer sent again is refused again
  // under the card the phone already holds.
  let refused = false;
  for (const card of stamped) refused = noteRefusedAnswer(card) || refused;
  const after = JSON.stringify(next);
  if (before === after) return refused;
  all[conversationId] = next;
  if (!saveControlCards(all)) return refused;
  // A card the desktop no longer lists has been answered or withdrawn, so the
  // "sent" mark for it goes too: the next card with that id is a new question.
  // Only this chat's cards: the set says nothing about another chat's, and
  // clearing theirs made an answer already sent there answerable again.
  const live = new Set(next.map(function (card) { return card && card.id; }));
  for (const card of previous) {
    const id = card && card.id;
    if (!id || live.has(id)) continue;
    clearCardSent(id);
    controlCardErrors.delete(id);
    choiceDrafts.delete(id);
    choiceViews.delete(id);
  }
  // A card the desktop now states as answered is answered: the "sent" mark
  // has done its work, whichever device the answer came from, and a pick
  // not sent from here has nothing left to answer.
  for (const card of next) {
    if (card && card.id && card.status !== "pending") {
      clearCardSent(card.id);
      choiceDrafts.delete(card.id);
      choiceViews.delete(card.id);
    }
  }
  return true;
}
