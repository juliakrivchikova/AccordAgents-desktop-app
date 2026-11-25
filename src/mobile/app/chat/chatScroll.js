import { OPEN_STREAM_KEY, OPEN_THREAD_KEY } from "../base/storageKeys.js";
import { activeChatRecord } from "../members/membersSheet.js";
import { chatViewOf } from "../sessions/sessionsState.js";

export const chatScrollState = {
  lastScrolledConversationId: undefined,
  // The screen last drawn over the chat (a thread, a member's session), and
  // the view it was drawn in.
  lastRenderedThreadRootId: undefined,
  lastRenderedView: undefined,
  lastRowsFingerprint: undefined,
  // The chat's reading position while one of its messages is open on its own
  // screen; restored on the way back.
  mainListScrollTop: undefined
};

// Treat "within this many pixels of the end" as reading the latest message.
// Anything further up means the reader is in history and must not be yanked.
const SCROLL_BOTTOM_THRESHOLD_PX = 80;

// The composer overlays the bottom of the message area, so "visually at the
// bottom" can still be ~100px away numerically. Measure it instead of
// assuming, or the app decides you scrolled away when you did not.
function bottomThresholdPx() {
  const composer = document.getElementById("composer-form");
  const composerHeight = composer ? composer.getBoundingClientRect().height : 0;
  return SCROLL_BOTTOM_THRESHOLD_PX + composerHeight;
}

export function openThreadRootId() {
  const value = sessionStorage.getItem(OPEN_THREAD_KEY);
  return value && value !== "none" ? value : undefined;
}

// The follow target is a pair: the run id the row advertised at tap time,
// plus the mobile event id of the message that run answers. The answering
// run streams under a fresh id of its own, so the event id is the only key
// that survives the placeholder being replaced by real text.
export function openStreamFollow() {
  const value = sessionStorage.getItem(OPEN_STREAM_KEY);
  if (!value || value === "none") {
    return undefined;
  }
  const parts = value.split("\u0000");
  return { runId: parts[0], mobileEventId: parts[1] || undefined };
}

export function setOpenStreamRunId(runId, mobileEventId) {
  if (runId) {
    sessionStorage.setItem(OPEN_STREAM_KEY, mobileEventId ? runId + "\u0000" + mobileEventId : runId);
  } else {
    sessionStorage.removeItem(OPEN_STREAM_KEY);
  }
}

export function setOpenThreadRootId(rootId) {
  if (rootId) {
    sessionStorage.setItem(OPEN_THREAD_KEY, rootId);
  } else {
    sessionStorage.removeItem(OPEN_THREAD_KEY);
  }
}

// Replies are hidden behind their root on the main list and shown in full
// once that thread is opened, matching how the desktop collapses them.
export function groupRowsIntoThreads(rows, openThreadRoot) {
  const replyCountByRoot = new Map();
  const latestReplyAtByRoot = new Map();
  for (const row of rows) {
    // A turn-finished note in a thread points back at a reply there; it is
    // no reply itself, as on the desktop.
    if (!row.threadRootId || row.finishedNote) {
      continue;
    }
    replyCountByRoot.set(row.threadRootId, (replyCountByRoot.get(row.threadRootId) || 0) + 1);
    const previous = latestReplyAtByRoot.get(row.threadRootId);
    if (!previous || row.createdAt > previous) {
      latestReplyAtByRoot.set(row.threadRootId, row.createdAt);
    }
  }
  if (openThreadRoot) {
    const visible = rows.filter(function (row) {
      return row.sourceId === openThreadRoot || row.threadRootId === openThreadRoot;
    });
    return { rows: visible, replyCountByRoot, latestReplyAtByRoot };
  }
  const visible = rows.filter(function (row) {
    return !row.threadRootId;
  }).map(function (row) {
    const replies = replyCountByRoot.get(row.sourceId) || 0;
    return replies > 0
      ? { ...row, replyCount: replies, latestReplyAt: latestReplyAtByRoot.get(row.sourceId) }
      : row;
  });
  return { rows: visible, replyCountByRoot, latestReplyAtByRoot };
}

// One way back at a time, as on the desktop: a thread goes back to its
// chat, a chat goes back to the list. Both arrows side by side read as a
// mistake, and the second one skipped a level.
export function renderThreadHeader(openThreadRoot, memberSession, accordScreen) {
  const composerInput = document.getElementById("composer-input");
  const chat = activeChatRecord();
  const sessionsView = Boolean(chat) && chatViewOf(chat) === "sessions";
  if (composerInput) {
    // A member's session writes to that member only; the sessions view's
    // main composer to the main session, with no handles to type.
    const placeholder = memberSession ? "Message this member..."
      : openThreadRoot ? "Add a reply..." : sessionsView ? "Ask anything" : "Message the room...";
    if (composerInput.placeholder !== placeholder) {
      composerInput.placeholder = placeholder;
    }
  }
  // Members are not @-mentioned in the sessions view: each is reached in
  // its own session.
  const mentionButton = document.getElementById("mention-button");
  if (mentionButton && mentionButton.hidden !== sessionsView) mentionButton.hidden = sessionsView;
  const back = document.getElementById("back-to-timeline");
  const backToChats = document.getElementById("back-to-chats");
  const title = document.getElementById("chat-title");
  if (!back) {
    return;
  }
  const label = memberSession || accordScreen ? "Back" : "Back to the chat";
  if (back.getAttribute("aria-label") !== label) back.setAttribute("aria-label", label);
  const shouldShow = Boolean(openThreadRoot || memberSession || accordScreen);
  if (back.classList.contains("is-visible") !== shouldShow) {
    back.classList.toggle("is-visible", shouldShow);
  }
  if (backToChats && backToChats.hidden !== shouldShow) {
    backToChats.hidden = shouldShow;
  }
  if (openThreadRoot && title && title.textContent !== "Thread") {
    title.textContent = "Thread";
  }
}

/** The offer to answer this message, on the screen the message opens on.
 *  Shown for a thread that has not been answered yet: once there are
 *  replies, the composer below is self-evident and the row is noise. */
export function renderThreadReplyAction(openThreadRoot, rowCount) {
  const node = document.getElementById("thread-reply-action");
  if (!node) return;
  // Decided from the rows this redraw is about to paint, not from the ones
  // still on screen from the last one.
  const show = Boolean(openThreadRoot) && rowCount <= 1;
  if (node.hidden !== !show) {
    node.hidden = !show;
  }
  if (show && !node.dataset.wired) {
    node.dataset.wired = "1";
    document.getElementById("thread-reply-button")?.addEventListener("click", function () {
      const input = document.getElementById("composer-input");
      if (!input) return;
      input.focus();
    });
  }
}

export function threadSurface() {
  return document.querySelector("#timeline-screen .thread-surface");
}

export function isNearBottom(surface) {
  if (!surface) {
    return true;
  }
  return surface.scrollHeight - surface.scrollTop - surface.clientHeight <= bottomThresholdPx();
}

/** A change that makes the chat taller or shorter — the keyboard arriving,
 *  the bar coming back — must not move a reader who was at the latest
 *  message away from it, and must leave a reader up in history where they
 *  are. Stated once so the places that resize cannot disagree. */
export function keepingReaderAtLatest(change) {
  const wasAtLatest = isNearBottom(threadSurface());
  change();
  if (wasAtLatest) {
    scrollToLatestWhenSettled("auto");
  }
}

export function setJumpToLatestVisible(visible) {
  const button = document.getElementById("jump-to-latest");
  if (button) {
    if (visible) placeJumpToLatest(button);
    button.classList.toggle("is-visible", Boolean(visible));
  }
}

/** Just above the chat's own bottom edge, wherever that is: the syncing
 *  strip, the machine's wake control and the bar all push that edge up, and
 *  a fixed offset from the bottom of the screen put the button on top of
 *  what was under the chat (the User, 2026-09-24). */
export function placeJumpToLatest(button) {
  const surface = threadSurface();
  const screen = document.getElementById("timeline-screen");
  if (!surface || !screen) return;
  const offset = Math.round(screen.getBoundingClientRect().bottom - surface.getBoundingClientRect().bottom) + 12;
  const next = offset + "px";
  if (button.style.bottom !== next) button.style.bottom = next;
}

export function scrollToLatest(behavior) {
  const surface = threadSurface();
  if (!surface) {
    return;
  }
  surface.scrollTo({ top: surface.scrollHeight, behavior: behavior || "auto" });
  setJumpToLatestVisible(false);
}

// Rows grow after mount: markdown reflows and avatars decode. Scrolling once
// lands short, so settle again on the next frame.
export function scrollToLatestWhenSettled(behavior) {
  requestAnimationFrame(function () {
    scrollToLatest(behavior);
    requestAnimationFrame(function () {
      scrollToLatest(behavior);
    });
  });
}
