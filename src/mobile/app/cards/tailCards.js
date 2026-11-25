import { cardOutcome, cardSentText, controlCardAnswering, controlCardErrors, isCardLocked } from "./cardAnswers.js";
import { pendingCardsForMessage } from "./cardRows.js";
import { cardRequesterLabel } from "./cardText.js";
import { controlCardElement } from "./controlCard.js";

/** The chat's own last item: what waits for the User and has no message of
 *  its own, a permission. A choice stands only under its message. It
 *  scrolls with the chat, as the desktop's does. A strip of its own above
 *  the composer cut the cards off against the chat and read as a card going
 *  under the text (the User, 2026-09-24). */
export function renderTailCards(list, cards) {
  let host = document.getElementById("control-cards");
  if (!host && cards.length === 0) return;
  if (!host) {
    host = document.createElement("li");
    host.id = "control-cards";
    host.className = "control-cards";
    host.setAttribute("aria-label", "Waiting for you");
  }
  if (host.parentElement !== list || list.lastElementChild !== host) list.append(host);
  host.hidden = cards.length === 0;
  syncCardNodes(host, cards);
}

/** A choice under the message that asked it, as on the desktop. */
export function syncPendingCards(container, entry) {
  const cards = pendingCardsForMessage(entry);
  let host = null;
  for (const child of Array.from(container.children)) {
    if (child.classList.contains("message-cards")) host = child;
  }
  if (!host && cards.length === 0) return;
  if (!host) {
    host = document.createElement("div");
    host.className = "message-cards";
    container.append(host);
  }
  host.hidden = cards.length === 0;
  syncCardNodes(host, cards);
}

function syncCardNodes(host, cards) {
  // Every render passes through here. A card that has not changed keeps its
  // node, so a pick, a note being typed and the keyboard over it survive a
  // reply arriving in the chat; only what changed is drawn again.
  const held = new Map();
  for (const node of Array.from(host.children)) held.set(node.dataset.cardId, node);
  const next = cards.map(function (card) {
    const signature = controlCardSignature(card);
    const node = held.get(card.id);
    if (node && node.dataset.signature === signature) return node;
    const fresh = controlCardElement(card);
    fresh.dataset.signature = signature;
    return fresh;
  });
  const keep = new Set(next);
  for (const node of Array.from(host.children)) {
    if (!keep.has(node)) node.remove();
  }
  let at = host.firstChild;
  for (const node of next) {
    if (node === at) {
      at = at.nextSibling;
      continue;
    }
    host.insertBefore(node, at);
  }
}

/** What a card is drawn from, so an unchanged card is not drawn again. */
export function controlCardSignature(card) {
  return JSON.stringify([card.id, card.kind, card.status, card.waiting === true, card.outcome || "", card.title, card.summary, cardRequesterLabel(card),
    card.machineName, card.options, card.recommendedOptionId, card.allowsCustomAnswer, card.allowsCancel,
    isCardLocked(card.id) || controlCardAnswering.has(card.id), controlCardErrors.get(card.id) || "",
    cardSentText(card.id), cardOutcome(card.id) || "", card.signInUrl || "",
    card.meter || null, card.keeps || null, card.chatScopeLabel || "", card.primaryOptionId || "",
    card.plan ? [card.plan.text.length, card.plan.isPlan, card.plan.feedbackOptionId] : 0]);
}

// A card's "for the rest of the chat" box, by card, outside the card: the
// same card is drawn in the chat and on Activity, and drawn again when it
// changes, and a ticked box must survive both.
export const cardChatScopeTicked = new Set();
