import { isNearBottom, openThreadRootId, setJumpToLatestVisible, threadSurface } from "./chatScroll.js";
import { render } from "./render.js";
import { selectedConversationId } from "../chats/openChat.js";
import { canSync } from "../outbox/sending.js";
import { loadPairing } from "../pairing/pairing.js";
import { timelinePageFor } from "../store/timelinePages.js";
import { requestTimelineViaRelay } from "../sync/serverChanges.js";

// --- earlier messages -----------------------------------------------------
// The desktop answers a timeline request with its last page and says whether
// there is more before it. Each tap asks for the page before the oldest
// message the phone was given, and the view stays where the reader was.

let loadEarlierBusy = false;

export function renderLoadEarlier(conversationId, openThread) {
  const button = document.getElementById("load-earlier");
  if (!button) {
    return;
  }
  const page = conversationId ? timelinePageFor(conversationId) : undefined;
  const pairing = loadPairing();
  const show = Boolean(page && page.hasMoreBefore && page.beforeMessageId) &&
    !openThread &&
    Boolean(pairing && canSync(pairing));
  button.hidden = !show;
  button.disabled = loadEarlierBusy;
  button.textContent = loadEarlierBusy ? "Loading…" : "Show earlier messages";
}

/** Reads the page before the earliest one this phone holds into storage:
 *  "read", "failed", or "none" when there is no page to read or a read is
 *  already going. Drawing it is the caller's. */
export async function fetchEarlierPage(conversationId) {
  const pairing = loadPairing();
  const page = conversationId ? timelinePageFor(conversationId) : undefined;
  if (!conversationId || !pairing || !canSync(pairing) || !page || !page.beforeMessageId || loadEarlierBusy) {
    return "none";
  }
  loadEarlierBusy = true;
  renderLoadEarlier(conversationId, openThreadRootId());
  try {
    await requestTimelineViaRelay(pairing, conversationId, {
      beforeMessageId: page.beforeMessageId,
      deferRender: true
    });
    return "read";
  } catch {
    return "failed";
  } finally {
    loadEarlierBusy = false;
  }
}

export async function loadEarlierMessages() {
  const conversationId = selectedConversationId();
  const surface = threadSurface();
  const heightBefore = surface ? surface.scrollHeight : 0;
  const topBefore = surface ? surface.scrollTop : 0;
  const result = await fetchEarlierPage(conversationId);
  if (result === "none" || selectedConversationId() !== conversationId) {
    return;
  }
  const failed = result === "failed";
  await render(failed ? "tunnel-reconnecting" : "synced");
  if (surface && !failed) {
    // Rows were added above the reader. Keep the message they were looking at
    // exactly where it was instead of letting the list jump under them.
    surface.scrollTop = topBefore + (surface.scrollHeight - heightBefore);
    setJumpToLatestVisible(!isNearBottom(surface));
  }
}
