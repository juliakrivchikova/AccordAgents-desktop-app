import { lineIcon } from "../activity/activityData.js";
import { appendCardWho, cardAppText, cardRequesterLabel } from "./cardText.js";
import { controlCardsFor } from "./controlCardStore.js";
import { artifactNoteCardForEntry } from "../chat/artifactNotes.js";
import { answeredCardsForMessage, formatClockTime } from "../chat/messageRows.js";
import { renderRevision } from "../chat/render.js";
import { URGENT_ALERT_CHEVRON_PATHS } from "../chat/urgentAlerts.js";
import { selectedConversationId } from "../chats/openChat.js";
import { mobileSharedRules } from "../members/avatars.js";

export const cardRowsState = {
  // The chat's cards by the message they belong to, read once per render: a
  // chat keeps every choice ever asked, and each row asks several times.
  renderCardIndex: null,
  // Each artifact note's marks for the rows being drawn, by row key.
  renderNoteProgress: null
};

export function noteProgressFor(rows) {
  const shared = mobileSharedRules();
  if (!shared || typeof shared.artifactNoteProgressById !== "function") return null;
  return shared.artifactNoteProgressById(rows.filter(function (entry) {
    return Boolean(artifactNoteCardForEntry(entry));
  }).map(function (entry) {
    return { id: entry.rowKey || entry.id, content: entry.content };
  }));
}

export function noteProgressOf(entry) {
  return cardRowsState.renderNoteProgress ? cardRowsState.renderNoteProgress.get(entry.rowKey || entry.id) : undefined;
}

export function cardIndexFor(conversationId) {
  // Only the render that built it may use it: a render cut short cannot
  // leave a stale index behind for the next one.
  if (cardRowsState.renderCardIndex && cardRowsState.renderCardIndex.conversationId === conversationId &&
    cardRowsState.renderCardIndex.revision === renderRevision) return cardRowsState.renderCardIndex;
  return buildCardIndex(conversationId);
}

export function typingInChatCard() {
  const active = document.activeElement;
  return Boolean(active && active.tagName === "TEXTAREA" && active.closest && active.closest("#message-list .control-card"));
}

export function buildCardIndex(conversationId) {
  const byMessage = new Map();
  const pending = [];
  const waiting = [];
  for (const card of controlCardsFor(conversationId)) {
    if (!card) continue;
    if (card.status === "pending") pending.push(card);
    // Approved and not done yet (a member removal waiting for running
    // turns): shown where it was asked, without buttons, until it is.
    else if (card.waiting === true && card.kind === "permission") waiting.push(card);
    if (!card.sourceMessageId) continue;
    const list = byMessage.get(card.sourceMessageId);
    if (list) list.push(card);
    else byMessage.set(card.sourceMessageId, [card]);
  }
  return { conversationId: conversationId, byMessage: byMessage, pending: pending, waiting: waiting };
}

export function cardsForMessage(entry) {
  if (!entry || entry.author !== "agent" || entry.scaffolding) return [];
  const conversationId = selectedConversationId();
  if (!conversationId) return [];
  const messageId = entry.messageId || entry.sourceId || entry.id;
  if (!messageId) return [];
  return cardIndexFor(conversationId).byMessage.get(messageId) || [];
}

/** The choices still waiting under this message. */
export function pendingCardsForMessage(entry) {
  return cardsForMessage(entry).filter(function (card) {
    return card.status === "pending" && card.kind === "choice";
  });
}

// lucide list-checks: the used choice's line, as on the desktop.
const CHOICE_ROW_PATHS = ["m3 17 2 2 4-4", "m3 7 2 2 4-4", "M13 6h8", "M13 12h8", "M13 18h8"];

/** A used card's one line, like a folded urgent alert: its icon, what it
 *  was about, then how it ended; a chevron when it opens. */
export function cardRowElement(tag, icon, previewText, outcomeText, opens) {
  const row = document.createElement(tag);
  row.className = "card-row";
  if (tag === "button") {
    row.type = "button";
    row.setAttribute("aria-expanded", "false");
  }
  icon.classList.add("card-row-icon");
  const preview = document.createElement("span");
  preview.className = "card-row-preview";
  preview.textContent = previewText;
  const end = document.createElement("span");
  end.className = "card-row-outcome";
  end.textContent = outcomeText;
  row.append(icon, preview, end);
  if (opens) {
    const chevron = lineIcon(URGENT_ALERT_CHEVRON_PATHS, 14);
    chevron.classList.add("card-row-chevron");
    row.append(chevron);
  }
  return row;
}

/** An answered, cancelled or expired choice: one line, like a folded
 *  urgent alert (the User, 2026-11-16) -- what was asked, then who asked
 *  and how it ended. It opens nothing. */
function answeredCardElement(card) {
  const outcome = cardAppText(card, card.outcome) || "Answered";
  const when = card.decidedAt ? formatClockTime(card.decidedAt) : "";
  const row = cardRowElement("article", lineIcon(CHOICE_ROW_PATHS, 14), card.title || "Choice",
    [cardRequesterLabel(card), outcome + (when ? " " + when : "")].filter(Boolean).join(" · "), false);
  row.classList.add("control-card-answered");
  row.querySelector(".card-row-outcome").title = outcome;
  row.dataset.cardId = card.id;
  row.dataset.cardKind = card.kind;
  row.setAttribute("aria-label", (card.title || "Choice") + ": " + outcome);
  return row;
}

/** A card folded to what was answered while it is not done yet: one
 *  approved and waiting to be applied, or an answer still on its way. */
export function compactCardElement(card, outcome, className, label) {
  const wrap = document.createElement("article");
  wrap.className = "control-card " + className;
  wrap.dataset.cardId = card.id;
  wrap.dataset.cardKind = card.kind;
  const head = document.createElement("div");
  head.className = "control-card-head";
  const title = document.createElement("span");
  title.className = "control-card-title";
  // Headed as the live card is, now that a permission folds as well.
  title.textContent = cardAppText(card, card.title, true) || (card.kind === "permission" ? "Permission request" : "Choice");
  head.append(title);
  appendCardWho(head, card);
  wrap.append(head);
  if (card.summary) {
    const summary = document.createElement("p");
    summary.className = "control-card-summary";
    summary.textContent = cardAppText(card, card.summary, true);
    wrap.append(summary);
  }
  const state = document.createElement("p");
  state.className = "control-card-state";
  outcome = cardAppText(card, outcome);
  state.textContent = outcome === "Cancelled" || outcome === "Expired" ? outcome : outcome ? label + outcome : "";
  state.hidden = !state.textContent;
  wrap.append(state);
  return wrap;
}

/** Idempotent: the same message redrawn keeps its node unless the answer
 *  itself changed. */
export function syncAnsweredCards(container, entry) {
  const cards = answeredCardsForMessage(entry);
  const signature = cards.map(function (card) { return card.id + ":" + (card.outcome || "") + ":" + (card.decidedAt || ""); }).join("|");
  if (container.dataset.answeredCards === signature) return;
  container.dataset.answeredCards = signature;
  for (const node of container.querySelectorAll(".control-card-answered")) {
    node.remove();
  }
  for (const card of cards) {
    container.append(answeredCardElement(card));
  }
}
