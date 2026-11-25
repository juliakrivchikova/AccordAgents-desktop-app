import { render } from "../chat/render.js";
import { closeChatSearch } from "../chats/chatSearch.js";
import { closeNewChatMentions, renderNewChat, renderNewChatState } from "./newChatScreen.js";
import { unreachableDetail } from "../outbox/hubOutbox.js";
import { serverPairing } from "../pairing/hubPairing.js";
import { applyDock } from "../shell/home.js";
import { serverPhoneGet } from "../sync/serverReads.js";

export const newChatOfferState = {
  // What the screen says, kept while it is redrawn (a reason no chat can be
  // started, a refusal, a read that failed), and whether it is only that the
  // offer is still being read.
  newChatSaid: undefined,
  // The main session's provider, model and effort the chip chose (sessions
  // view): { kind, hostId, model, reasoningEffort }; none: as offered.
  newChatMainChoice: undefined,
  // The project the chat works in: a path the computer offered, or "" for none.
  newChatProject: "",
  // Pictures for the first message, prepared as the chat's composer prepares them.
  newChatAttachments: [],
  // Pictures still being prepared: Start waits for them.
  newChatPreparing: 0,
  // What was typed before the caret when the @ list was last drawn: the list
  // starts again at its top when that changes, and keeps where it was scrolled
  // to while it does not.
  newChatMentionText: undefined,
  newChatStarting: false
};

// --- New chat -----------------------------------------------------------

// What the computer's New chat offers, as the server holds it (the User,
// 2026-10-29: the phone's New chat is the computer's): its projects, the
// project a chat starts in, the Chat Assistant and the saved members, each
// as the computer would add it.
export let newChatOffer;

export let newChatReading = false;
export let newChatChosen = new Set();
export const NEW_CHAT_REJECTED_PREFIX = "Not attached: ";
let newChatToken = 0;

// The last read of the offer failed for want of a connection: read again
// once the phone is back (retryNewChatOffer). Not after a refusal or an
// older server, which reading again would not change.
let newChatUnreachable = false;

// While New chat is up and its read keeps failing that way, it is tried
// again by itself, each pause twice the last, up to a minute.
const NEW_CHAT_RETRY_FIRST_MS = 5_000;

const NEW_CHAT_RETRY_MAX_MS = 60_000;
let newChatRetryTimer;
let newChatRetryDelay = 0;

// A read again by itself is under way: the screen keeps saying what it said.
export let newChatReadingAgain = false;

// When the offer on screen was read, to read it again once it is old.
let newChatOfferAt = 0;

const NEW_CHAT_OFFER_FRESH_MS = 5 * 60_000;
export const NEW_CHAT_FOLDER_ICON = ["m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"];
export const NEW_CHAT_NO_PROJECT_ICON = ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "m5.7 5.7 12.6 12.6"];
export const NEW_CHAT_CHECK_ICON = ["M20 6 9 17l-5-5"];

export async function openNewChat(options) {
  const screen = document.getElementById("new-chat-screen");
  if (!screen) return;
  // A read again by itself keeps what the screen says until the answer
  // differs: the note does not flicker, nor is it spoken again, on each try.
  const again = Boolean(options && options.again);
  const token = ++newChatToken;
  newChatOffer = undefined;
  newChatChosen = new Set();
  newChatOfferState.newChatMainChoice = undefined;
  newChatOfferState.newChatProject = "";
  newChatReading = true;
  newChatReadingAgain = again;
  newChatUnreachable = false;
  if (!again) {
    clearTimeout(newChatRetryTimer);
    newChatRetryDelay = 0;
  }
  closeNewChatPickers();
  if (!again) renderNewChat("Reading what your computer offers…");
  screen.hidden = false;
  applyDock();
  let answer;
  try {
    answer = await serverPhoneGet("/v1/phone/new-chat", {});
  } catch (error) {
    if (token !== newChatToken) return;
    newChatReading = false;
    newChatReadingAgain = false;
    // Taken off the server: the chats screen says so and how to pair again,
    // which a line about not reaching the server would not.
    if (serverPairing.hubPairingState && serverPairing.hubPairingState.status === "revoked") {
      closeNewChat();
      void render();
      return;
    }
    newChatUnreachable = Boolean(error && (error.unavailable || error.serverStatus >= 500));
    if (newChatUnreachable) scheduleNewChatRetry();
    // A server from before New chat on the phone: it updates once the desktop does.
    renderNewChat(error && error.serverStatus === 404
      ? "Your server does not start chats from the phone yet. It will once AccordAgents on your computer has updated."
      : "Could not reach your server: " + unreachableDetail(error));
    return;
  }
  if (token !== newChatToken) return;
  newChatReading = false;
  newChatReadingAgain = false;
  clearTimeout(newChatRetryTimer);
  newChatRetryDelay = 0;
  applyNewChatAnswer(answer);
}

/** What the computer offers, from the server's answer, on screen. */
function applyNewChatAnswer(answer) {
  newChatOfferAt = performance.now();
  newChatOffer = answer && answer.options ? { options: answer.options, roles: answer.roles || {}, machines: answer.machines || {} } : undefined;
  // As on the computer: the project it last worked in, or none.
  newChatOfferState.newChatProject = newChatOffer && newChatOffer.options.defaultProject ? newChatOffer.options.defaultProject : "";
  renderNewChat(answer && answer.unavailable ? answer.unavailable : "");
}

/** Nothing on New chat was touched yet: no member, no other project, no
 *  words, no picture, no list open. */
function newChatUntouched() {
  if (!newChatOffer) return false;
  const input = document.getElementById("new-chat-input");
  return newChatChosen.size === 0 && !newChatOfferState.newChatMainChoice && newChatOfferState.newChatProject === (newChatOffer.options.defaultProject || "") &&
    newChatOfferState.newChatAttachments.length === 0 && newChatOfferState.newChatPreparing === 0 && !(input && input.value.trim()) &&
    !document.querySelector(".new-chat-picker:not([hidden])");
}

/** New chat still up without what the computer offers because the phone
 *  had no connection (the app started on it offline): read again once the
 *  phone is back, in front or after a read of the chats got through. */
export function retryNewChatOffer() {
  const screen = document.getElementById("new-chat-screen");
  if (!screen || screen.hidden || !newChatUnreachable || newChatOffer || newChatReading || newChatOfferState.newChatStarting) return;
  // Not from the background or with no network: the next try waits, and
  // coming back to the front or online reads it sooner (resyncAfterForeground).
  if (document.hidden || navigator.onLine === false) {
    scheduleNewChatRetry();
    return;
  }
  void openNewChat({ again: true });
}

/** New chat resting as the first screen for long: its offer (members,
 *  where they run, projects) is read again on coming back, but only while
 *  nothing on it was touched, so no pick is lost; the offer on screen stays
 *  usable while it is read, and stays as it was if the read fails. */
function refreshStaleNewChatOffer() {
  const screen = document.getElementById("new-chat-screen");
  if (!screen || screen.hidden || newChatReading || newChatOfferState.newChatStarting || !newChatUntouched()) return;
  if (performance.now() - newChatOfferAt < NEW_CHAT_OFFER_FRESH_MS) return;
  const token = newChatToken;
  newChatOfferAt = performance.now();
  serverPhoneGet("/v1/phone/new-chat", {}).then(function (answer) {
    if (token !== newChatToken || newChatReading || newChatOfferState.newChatStarting || !newChatUntouched()) return;
    applyNewChatAnswer(answer);
  }, function () { return undefined; });
}

export function newChatAfterServerAnswered() {
  retryNewChatOffer();
  refreshStaleNewChatOffer();
}

function scheduleNewChatRetry() {
  clearTimeout(newChatRetryTimer);
  newChatRetryDelay = Math.min(newChatRetryDelay ? newChatRetryDelay * 2 : NEW_CHAT_RETRY_FIRST_MS, NEW_CHAT_RETRY_MAX_MS);
  newChatRetryTimer = setTimeout(retryNewChatOffer, newChatRetryDelay);
}

/** In place of the chats stands a pairing prompt, or the note that says how
 *  to pair or that the phone was removed: nothing over it or beside it
 *  offers what only a paired phone can do (New chat, search). */
export function clearForPairingNote() {
  const searchToggle = document.getElementById("chat-search-toggle");
  if (searchToggle) searchToggle.hidden = true;
  const newChatButton = document.getElementById("new-chat-button");
  if (newChatButton) newChatButton.hidden = true;
  closeChatSearch();
  const screen = document.getElementById("new-chat-screen");
  if (screen && !screen.hidden) closeNewChat();
}

export function closeNewChat() {
  newChatToken += 1;
  // What the chip chose was for that chat: closed without sending, it is
  // gone, as on the computer.
  newChatOfferState.newChatMainChoice = undefined;
  // Left, New chat reads nothing more until it is opened again, and then
  // from the first pause.
  clearTimeout(newChatRetryTimer);
  newChatRetryDelay = 0;
  closeNewChatMentions();
  closeNewChatPickers();
  const screen = document.getElementById("new-chat-screen");
  if (screen) screen.hidden = true;
  const input = document.getElementById("new-chat-input");
  if (input) input.blur();
  applyDock();
}

/** One of the card's lists, over the screen. The keyboard goes down for it:
 *  the list is what is being looked at. */
export function openNewChatPicker(id) {
  if (!newChatOffer) return;
  const input = document.getElementById("new-chat-input");
  if (input) input.blur();
  closeNewChatPickers();
  const sheet = document.getElementById(id);
  if (sheet) sheet.hidden = false;
  renderNewChatState();
}

export function closeNewChatPickers() {
  for (const id of ["new-chat-projects-sheet", "new-chat-members-sheet", "new-chat-model-sheet"]) {
    const sheet = document.getElementById(id);
    if (sheet) sheet.hidden = true;
  }
  renderNewChatState();
}
