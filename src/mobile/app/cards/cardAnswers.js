import { nowIso, recordRelayDebug } from "../base/bytes.js";
import { CONTROL_CARD_SENT_KEY, outboxStatusById } from "../base/storageKeys.js";
import { cardIndexFor } from "./cardRows.js";
import { controlCardElement } from "./controlCard.js";
import { controlCardSignature } from "./tailCards.js";
import { render } from "../chat/render.js";
import { selectedConversationId } from "../chats/openChat.js";
import { OUTBOX_REFUSED, OUTBOX_SUPERSEDED } from "../outbox/hubOutbox.js";
import { noteOutboxStatus } from "../outbox/outboxStore.js";
import { createOutboxEvent, persistOutboundEvent, sendNow, serverOwesEntry } from "../outbox/sending.js";
import { setStoredValue } from "../shell/home.js";
import { requestToPromise, withOutbox } from "../store/database.js";
import { MARK_REFUSED } from "../sync/connectionStatus.js";

// --- cards a member is waiting on -----------------------------------------

/** The answer a tapped card gives, as the server takes it (`card.answer`,
 *  agreement Д9): a permission says whether it is allowed, with the native
 *  identifiers the provider needs back; a choice says what was picked or
 *  written, or that it was cancelled. */
function answerForCard(card, answer) {
  if (card.kind === "permission" && card.plan) {
    // Claude Code's plan approval: the row picked, by the CLI's own value,
    // and her words for "No, keep planning" (claudePlanApproval.ts).
    const keepPlanning = answer.optionId === card.plan.feedbackOptionId;
    const words = keepPlanning && typeof answer.feedback === "string" ? answer.feedback.trim() : "";
    return {
      cardId: card.id,
      cardKind: "permission",
      answer: { approve: !keepPlanning, planDecision: { optionId: answer.optionId, ...(words ? { feedback: words } : {}) } }
    };
  }
  if (card.kind === "permission") {
    const approve = answer.optionId === "allow";
    return {
      cardId: card.id,
      cardKind: "permission",
      answer: {
        approve: approve,
        // A card with a "for the rest of the chat" box says which it is,
        // as the desktop's card does (a compaction: Compact, or Compact
        // and don't ask again in this chat).
        ...(approve && card.chatScopeLabel ? { scope: answer.chatScope ? "chat" : "once" } : {}),
        ...(card.codexDecisionId ? { codexDecisionId: card.codexDecisionId } : {}),
        ...(card.draftOverride ? { draftOverride: card.draftOverride } : {})
      }
    };
  }
  return {
    cardId: card.id,
    cardKind: "choice",
    answer: {
      ...(answer.optionId ? { selectedOptionId: answer.optionId } : {}),
      ...(answer.customAnswer !== undefined ? { customAnswer: answer.customAnswer } : {}),
      ...(answer.note !== undefined ? { note: answer.note } : {}),
      ...(answer.cancel ? { cancel: true } : {})
    }
  };
}

/**
 * Answering a card: the answer is written to the queue, then sent at once.
 * A tap is not the answer being applied — the card folds to it until the
 * server states the card answered.
 */
export async function answerControlCard(card, answer) {
  const conversationId = card.conversationId || selectedConversationId();
  if (!conversationId) return;
  // One answer per card. Hashing and the database come before the "sent"
  // mark, so a second tap in that gap (Allow, then Deny beside it) would
  // otherwise queue a second, contradicting decision.
  if (controlCardAnswering.has(card.id) || isCardLocked(card.id)) return;
  controlCardAnswering.add(card.id);
  answeringOutcome.set(card.id, answerOutcomeText(card, answer));
  // The reason an earlier answer was not taken goes with it: left, it kept
  // this one from folding until the database was done.
  controlCardErrors.delete(card.id);
  foldDrawnCard(card);
  try {
    await answerControlCardOnce(card, answer, conversationId);
  } catch (error) {
    // Failed before it was saved here: the card opens again and says so.
    recordRelayDebug({ event: "card-answer-failed", reason: String(error && error.message || error) });
    if (!isCardLocked(card.id) && !controlCardErrors.has(card.id)) controlCardErrors.set(card.id, "Could not save your answer on this phone. Try again.");
  } finally {
    controlCardAnswering.delete(card.id);
    answeringOutcome.delete(card.id);
    // An answer that could not be saved, or that the server refused while
    // it was still being written, leaves the options live again: the
    // redraw inside the answer still counted it as being written and
    // folded the card.
    if (!isCardLocked(card.id)) void render();
  }
}

async function answerControlCardOnce(card, answer, conversationId) {
  const given = answerForCard(card, answer);
  await supersedeQueuedAnswer(card.id);
  let queued;
  try {
    queued = await enqueueDecision({ conversationId: conversationId, payload: { ...given, label: answerOutcomeText(card, answer) } });
  } catch (error) {
    controlCardErrors.set(card.id, "Could not save your answer on this phone. Try again.");
    await render();
    return;
  }
  controlCardErrors.delete(card.id);
  // The operation's id names the answer: a refusal of it from the member's
  // device names it too.
  markCardSent(card.id, queued && queued.eventId, answerOutcomeText(card, answer), queued && queued.eventId);
  // The answer goes out at once; the redraw does not hold it back.
  await sendNow();
}

function enqueueDecision(input) {
  return createOutboxEvent({
    conversationId: input.conversationId,
    kind: "card.answer",
    payload: input.payload
  }).then(persistOutboundEvent);
}

let controlCardSentCache;

function loadCardSentMarks() {
  if (controlCardSentCache) return controlCardSentCache;
  try {
    const parsed = JSON.parse(localStorage.getItem(CONTROL_CARD_SENT_KEY) || "{}");
    controlCardSentCache = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    controlCardSentCache = {};
  }
  return controlCardSentCache;
}

function saveCardSentMarks(marks) {
  controlCardSentCache = marks;
  setStoredValue(CONTROL_CARD_SENT_KEY, JSON.stringify(marks));
}

export function isCardSent(cardId) {
  return Boolean(cardId) && Object.prototype.hasOwnProperty.call(loadCardSentMarks(), cardId);
}

function markCardSent(cardId, eventId, outcome, operationId) {
  const marks = { ...loadCardSentMarks() };
  // Only a label for the fold: an own answer of any length is already in
  // the queue entry, and the marks share the few megabytes with the cards.
  const label = typeof outcome === "string" && outcome.length > CONTROL_CARD_OUTCOME_LABEL_MAX
    ? outcome.slice(0, CONTROL_CARD_OUTCOME_LABEL_MAX - 1) + "\u2026" : outcome;
  marks[cardId] = { at: nowIso(), ...(eventId ? { eventId: eventId } : {}), ...(typeof label === "string" ? { outcome: label } : {}),
    ...(operationId ? { operationId: operationId } : {}) };
  saveCardSentMarks(marks);
}

/** The member's home refused the answer this phone sent to a card: it waits no
 *  more, and says why, as a member's machine already makes it. Only for the
 *  answer the refusal names: a later one may still be on its way. True when
 *  the card changed. */
export function noteRefusedAnswer(card) {
  const refusals = card && card.status === "pending" && Array.isArray(card.refusedAnswers) ? card.refusedAnswers : [];
  const mark = refusals.length ? loadCardSentMarks()[card.id] : undefined;
  const refused = mark && mark.operationId
    ? refusals.find(function (item) { return item && item.operationId === mark.operationId; }) : undefined;
  if (!refused) return false;
  clearCardSent(card.id);
  controlCardErrors.set(card.id, refused.reason || CONTROL_CARD_REFUSED_TEXT);
  return true;
}

/** The card folds where it is drawn at the tap itself: the render that
 *  follows waits on hashing and the database, which on a long chat is a
 *  visible while. */
function foldDrawnCard(card) {
  for (const node of Array.from(document.querySelectorAll(".control-card[data-card-id]"))) {
    if (node.dataset.cardId !== card.id || node.classList.contains("control-card-answered")) continue;
    const folded = controlCardElement(card);
    folded.dataset.signature = controlCardSignature(card);
    node.replaceWith(folded);
  }
}

/** How an answer given on this phone reads once its card is folded away. */
function answerOutcomeText(card, answer) {
  if (answer && answer.cancel) return "Cancelled";
  if (answer && typeof answer.customAnswer === "string") return answer.customAnswer;
  const options = Array.isArray(card.options) ? card.options : [];
  const option = options.find(function (item) { return answer && item.id === answer.optionId; });
  const said = option ? option.label || option.id : (answer && answer.optionId) || "";
  // Worded as the folded line on the desktop says it (compactionCardEnding).
  return said && answer && answer.optionId === card.primaryOptionId && answer.chatScope && card.chatScopeLabel ? said + " · " + card.chatScopeLabel : said;
}

/** The answer a card on its way folds to, while it is written and after. */
export function cardOutcome(cardId) {
  if (answeringOutcome.has(cardId)) return answeringOutcome.get(cardId);
  const mark = loadCardSentMarks()[cardId];
  return mark && typeof mark.outcome === "string" ? mark.outcome : undefined;
}

export function clearCardSent(cardId) {
  const marks = loadCardSentMarks();
  if (!Object.prototype.hasOwnProperty.call(marks, cardId)) return;
  const next = { ...marks };
  delete next[cardId];
  saveCardSentMarks(next);
}

/** Whether an answer given on this phone still holds its card, folded and
 *  saying nothing more (the User, 2026-09-24), or has stopped meaning
 *  anything and the card says it can be answered again. The queue entry the
 *  mark names says how long it may hold; an entry this phone has not read
 *  yet counts as handed over rather than alarming the User over a cache
 *  miss. A mark this old with the card still waiting means the answer was
 *  lost on its way or given up without a word, so the card unlocks rather
 *  than showing an answer on its way for ever. */
export function cardSentState(cardId) {
  const mark = loadCardSentMarks()[cardId];
  if (!mark) return undefined;
  const held = mark.eventId ? outboxStatusById.get(mark.eventId) : undefined;
  if (held && held.status === OUTBOX_REFUSED) {
    return { locked: false, text: held.lastError ? MARK_REFUSED + ": " + held.lastError + " You can answer again." : CONTROL_CARD_REFUSED_TEXT };
  }
  const at = Date.parse(mark.at || "");
  // An answer nobody has taken yet may be lost, and ten minutes of that
  // unlocks the card. One the server has taken is not lost:
  // it is applied when the desktop is next up, and a second answer given
  // meanwhile only raced it — the older one won on the desktop and the
  // User's later one was quietly discarded. That answer waits an hour
  // before the card unlocks, for the desktop that took it and then gave it
  // up without saying so.
  const owed = !held || serverOwesEntry(held);
  const unlockAfterMs = owed ? CONTROL_CARD_SENT_UNLOCK_MS : CONTROL_CARD_TAKEN_UNLOCK_MS;
  const stale = !Number.isFinite(at) || Date.now() - at > unlockAfterMs;
  if (stale) return { locked: false, text: CONTROL_CARD_STALE_TEXT };
  return { locked: true, text: "" };
}

/** An earlier answer to the card still on its way is replaced, not raced:
 *  the server takes the first answer to a card and refuses the next, so
 *  both travelling would let the older one win. The entry stays in the
 *  queue, marked replaced; it is never offered. */
function supersedeQueuedAnswer(cardId) {
  const mark = loadCardSentMarks()[cardId];
  if (!mark || !mark.eventId) return Promise.resolve(false);
  return withOutbox("readwrite", function (store) {
    return requestToPromise(store.get(mark.eventId)).then(function (entry) {
      if (!entry || !serverOwesEntry(entry)) return false;
      const replaced = { ...entry, status: OUTBOX_SUPERSEDED, updatedAt: nowIso() };
      noteOutboxStatus(replaced);
      return requestToPromise(store.put(replaced)).then(function () { return true; });
    });
  }).catch(function () { return false; });
}

export function cardSentText(cardId) {
  const state = cardSentState(cardId);
  return state ? state.text : "";
}

/** Whether the card's options are dead because an answer is on its way. */
export function isCardLocked(cardId) {
  const state = cardSentState(cardId);
  return Boolean(state && state.locked);
}

export const controlCardErrors = new Map();

// Cards whose answer is being written right now, before it is "sent".
export const controlCardAnswering = new Set();

// What such a card was answered with, for the fold, until the mark has it.
const answeringOutcome = new Map();

const CONTROL_CARD_OUTCOME_LABEL_MAX = 200;
const CONTROL_CARD_STALE_TEXT = "Answer sent, but not applied yet. You can answer again.";

// Said for a refusal from the member's home and from the server alike, so
// it names neither: either way the answer was not taken.
const CONTROL_CARD_REFUSED_TEXT = "This answer was not accepted. You can answer again.";

// How long an answer may stay on its way before the card is offered again.
const CONTROL_CARD_SENT_UNLOCK_MS = 10 * 60_000;

// For an answer the server has taken: see cardSentState.
// An hour, not a day: the desktop can take an answer and then give it up
// (five failed applies) without the phone hearing, and the card must not
// show dead buttons for a day over that.
const CONTROL_CARD_TAKEN_UNLOCK_MS = 60 * 60_000;

/** The cards a member is waiting on in this chat. */
export function pendingControlCards(conversationId) {
  return cardIndexFor(conversationId).pending;
}
