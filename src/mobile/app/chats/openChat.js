import { getTimelineEntry } from "../activity/activityItem.js";
import { nowIso } from "../base/bytes.js";
import { ACTIVE_CONVERSATION_KEY } from "../base/storageKeys.js";
import { isNearBottom, setJumpToLatestVisible, setOpenThreadRootId, threadSurface } from "../chat/chatScroll.js";
import { fetchEarlierPage } from "../chat/loadEarlier.js";
import { render, renderState } from "../chat/render.js";
import { canSync } from "../outbox/sending.js";
import { loadPairing } from "../pairing/pairing.js";
import { timelinePageFor } from "../store/timelinePages.js";
import { dropCachedChatRows } from "../store/timelineRows.js";
import { requestTimelineViaRelay } from "../sync/serverChanges.js";

export const openChatState = {
  // The message a chat opened from Activity lands on instead of its end (a
  // running member's turn in progress), until it is on screen or given up.
  pendingMessageFocus: undefined
};

// The message landed on, marked until the reader touches the chat or
// leaves it, as the desktop marks a message it opened.
export let focusedMessage;

export function activeConversationId(inputConversationId) {
  return inputConversationId ||
    localStorage.getItem(ACTIVE_CONVERSATION_KEY) ||
    loadPairing()?.conversationId ||
    "unpaired";
}

export function selectedConversationId() {
  const active = localStorage.getItem(ACTIVE_CONVERSATION_KEY) || loadPairing()?.conversationId;
  return active && active !== "unpaired" ? active : undefined;
}

/** Opens a chat, or one thread in it, and asks for its latest page. The
 *  chat list and Activity both land here, so a chat opened from either is
 *  fetched the same way. */
export function openConversation(conversationId, options) {
  const rootId = options && options.threadRootId ? options.threadRootId : undefined;
  renderState.pendingThreadOpen = rootId ? { conversationId: conversationId, rootId: rootId } : undefined;
  const focusMessageId = options && options.messageId ? options.messageId : undefined;
  const focusRequest = focusMessageId ? { conversationId: conversationId, messageId: focusMessageId } : undefined;
  openChatState.pendingMessageFocus = focusRequest;
  clearFocusMark();
  setOpenThreadRootId(rootId);
  localStorage.setItem(ACTIVE_CONVERSATION_KEY, conversationId);
  // When the User opened it, on this phone's clock: what the page it is
  // opened with holds counts as seen at this moment.
  const openedAt = nowIso();
  // A new visit reads the chat again: rows held from an earlier visit are
  // exactly what a late read must not be able to bring back.
  dropCachedChatRows();
  return render("synced").then(function () {
    const pairing = loadPairing();
    if (!pairing || !canSync(pairing)) {
      return undefined;
    }
    // A page that could not be read leaves what this phone holds on
    // screen; the next change, pull or return to the app reads it again.
    return requestTimelineViaRelay(pairing, conversationId, { opening: true, openedAt: openedAt }).catch(function () {
      return 0;
    }).then(function () {
      return render("synced");
    }).then(function () {
      return focusRequest ? revealEarlierFocusMessage(focusRequest) : undefined;
    });
  }).finally(function () {
    // Not found on any page this phone could read: the chat stays as any
    // other chat opens, at its end. A drawing already on its way with the
    // row gets a moment first: the last one asked for can be overtaken by
    // a newer one that is still reading the rows.
    if (focusRequest && openChatState.pendingMessageFocus === focusRequest) {
      setTimeout(function () {
        if (openChatState.pendingMessageFocus === focusRequest) openChatState.pendingMessageFocus = undefined;
      }, FOCUS_SETTLE_MS);
    }
  });
}

export const FOCUS_SETTLE_MS = 2000;

// A long turn's message can be pages above the latest one. The pages in
// between are read the way "Show earlier messages" reads them, so the chat
// has no hole between the message and its end. Bounded, so a message that
// is no longer there does not read a chat's whole history.
const FOCUS_EARLIER_PAGE_LIMIT = 20;

export async function revealEarlierFocusMessage(focusRequest) {
  const conversationId = focusRequest.conversationId;
  const entryId = conversationId + ":" + focusRequest.messageId;
  let read = false;
  for (let pages = 0; pages < FOCUS_EARLIER_PAGE_LIMIT; pages += 1) {
    if (openChatState.pendingMessageFocus !== focusRequest || selectedConversationId() !== conversationId) {
      return;
    }
    // Stored is enough: the drawing below (or a newer one) lands on it.
    // Reading on after that would put rows above it while it is shown.
    if (await getTimelineEntry(entryId).catch(function () { return undefined; })) break;
    const page = timelinePageFor(conversationId);
    if (!page || !page.hasMoreBefore) break;
    if (await fetchEarlierPage(conversationId) !== "read") break;
    read = true;
  }
  if (read && openChatState.pendingMessageFocus === focusRequest && selectedConversationId() === conversationId) {
    await render("synced");
  }
}

export function messageRowFor(list, messageId) {
  for (const row of list.querySelectorAll(".message-row[data-thread-root]")) {
    if (row.dataset.threadRoot === messageId) return row;
  }
  return undefined;
}

// The last landing: its re-placement (ended when the reader moves the
// chat, sends, or asks for the latest) and its mark (cleared when the
// reader touches the chat). Both go with the next landing and with leaving
// the chat, so nothing is left listening on the chat's scroll area.
let focusPlacement;

let focusMark;

export function endFocusPlacement() {
  if (focusPlacement) {
    focusPlacement.abort();
    focusPlacement = undefined;
  }
}

export function clearFocusMark() {
  endFocusPlacement();
  if (focusMark) {
    focusMark.abort();
    focusMark = undefined;
  }
  focusedMessage = undefined;
  for (const focused of document.querySelectorAll("#message-list .message-row.message-focused")) {
    focused.classList.remove("message-focused");
  }
}

/** Puts the row at the top of the chat and marks it. Rows above it can
 *  still grow as they settle (markdown, pictures), and a closing sheet or
 *  the keyboard can move the chat to its end, so it is placed again over
 *  the next moments, until the reader moves the chat themselves. */
export function focusMessageRow(conversationId, row) {
  clearFocusMark();
  const marked = { conversationId: conversationId, messageId: row.dataset.threadRoot };
  focusedMessage = marked;
  row.classList.add("message-focused");
  const surface = threadSurface();
  if (!surface) return;
  const placement = new AbortController();
  const mark = new AbortController();
  focusPlacement = placement;
  focusMark = mark;
  surface.addEventListener("wheel", endFocusPlacement, { passive: true, signal: placement.signal });
  surface.addEventListener("pointerdown", function () {
    if (focusMark === mark) clearFocusMark();
  }, { signal: mark.signal });
  const place = function () {
    if (placement.signal.aborted || !row.isConnected) return;
    const top = row.getBoundingClientRect().top - surface.getBoundingClientRect().top + surface.scrollTop - 12;
    surface.scrollTop = Math.max(0, top);
    setJumpToLatestVisible(!isNearBottom(surface));
  };
  place();
  requestAnimationFrame(function () {
    place();
    requestAnimationFrame(function () {
      place();
      requestAnimationFrame(place);
    });
  });
  setTimeout(place, 250);
  setTimeout(function () {
    place();
    if (focusPlacement === placement) endFocusPlacement();
  }, 700);
}
