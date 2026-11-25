import { render } from "../chat/render.js";
import { selectedConversationId } from "../chats/openChat.js";
import { canSync } from "../outbox/sending.js";
import { loadPairing } from "../pairing/pairing.js";
import { requestChatListViaRelay, requestTimelineViaRelay } from "./serverChanges.js";
import { whileLookingForMessages } from "./syncBanner.js";

// --- pull to refresh ------------------------------------------------------
// A downward drag from the very top of a list asks the desktop again. This
// is the only manual refresh the phone has; before it, "Waiting to sync"
// could only be waited out.

const PULL_REFRESH_ARM_PX = 56;

const PULL_REFRESH_MAX_PX = 84;

export function attachPullToRefresh(scroller, indicator, refresh) {
  if (!scroller || !indicator) {
    return;
  }
  let startY;
  let pulling = false;
  let distance = 0;
  let busy = false;
  function settle() {
    indicator.style.height = "0px";
    indicator.classList.remove("is-armed");
    distance = 0;
  }
  scroller.addEventListener("touchstart", function (event) {
    if (busy || scroller.scrollTop > 0 || event.touches.length !== 1) {
      pulling = false;
      return;
    }
    startY = event.touches[0].clientY;
    pulling = true;
    distance = 0;
  }, { passive: true });
  scroller.addEventListener("touchmove", function (event) {
    if (!pulling || busy) {
      return;
    }
    const dy = event.touches[0].clientY - startY;
    if (dy <= 0 || scroller.scrollTop > 0) {
      settle();
      return;
    }
    distance = Math.min(PULL_REFRESH_MAX_PX, dy * 0.55);
    indicator.style.height = distance + "px";
    indicator.classList.toggle("is-armed", distance >= PULL_REFRESH_ARM_PX);
  }, { passive: true });
  async function finish() {
    if (!pulling) {
      return;
    }
    pulling = false;
    if (distance < PULL_REFRESH_ARM_PX || busy) {
      settle();
      return;
    }
    busy = true;
    indicator.classList.add("is-refreshing");
    indicator.style.height = PULL_REFRESH_ARM_PX + "px";
    try {
      await refresh();
    } finally {
      busy = false;
      indicator.classList.remove("is-refreshing");
      settle();
    }
  }
  scroller.addEventListener("touchend", function () {
    void finish();
  });
  scroller.addEventListener("touchcancel", function () {
    pulling = false;
    settle();
  });
}

export async function refreshChatList() {
  const pairing = loadPairing();
  if (!pairing || !canSync(pairing)) {
    await render();
    return;
  }
  try {
    await requestChatListViaRelay(pairing);
    await render("synced");
  } catch {
    await render("tunnel-reconnecting");
  }
}

export async function refreshOpenTimeline() {
  const pairing = loadPairing();
  const conversationId = selectedConversationId();
  if (!pairing || !canSync(pairing) || !conversationId) {
    await render();
    return;
  }
  try {
    await whileLookingForMessages(async function () {
      await requestTimelineViaRelay(pairing, conversationId);
    });
    await render("synced");
  } catch {
    await render("tunnel-reconnecting");
  }
}
