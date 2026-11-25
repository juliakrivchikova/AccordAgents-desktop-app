import { recordRelayDebug } from "../base/bytes.js";
import { render } from "../chat/render.js";
import { renderChatList } from "../chats/chatListView.js";
import { closeChatSearch } from "../chats/chatSearch.js";
import { adoptWorkerUnread } from "../chats/chatStore.js";
import { selectedConversationId } from "../chats/openChat.js";
import { closeNewChat, newChatAfterServerAnswered } from "../newChat/newChatOffer.js";
import { canSync } from "../outbox/sending.js";
import { loadPairing } from "../pairing/pairing.js";
import { leaveOpenChat, setActivityTab, setHomeTab } from "../shell/home.js";
import { retryOutboxNow } from "./outboxRetry.js";
import { requestChatListViaRelay, requestTimelineViaRelay, startServerChanges, stopServerChanges } from "./serverChanges.js";
import { markHubNoticesSeen } from "./serverReads.js";
import { runSettlePass } from "./settledTurns.js";

// --- coming back to the app -----------------------------------------------
// iOS freezes the page in the background, and a request that was waiting
// for news when it froze is usually dead. Coming back asks the server
// straight away.

let hiddenSince;

let foregroundResyncPromise;

export function resyncAfterForeground() {
  if (foregroundResyncPromise) {
    return foregroundResyncPromise;
  }
  foregroundResyncPromise = (async function () {
    const awayMs = hiddenSince ? Date.now() - hiddenSince : 0;
    hiddenSince = undefined;
    recordRelayDebug({ event: "foreground-resync", awayMs });
    await adoptWorkerUnread();
    const pairing = loadPairing();
    if (!pairing || !canSync(pairing)) {
      await render();
      return;
    }
    // Back in front: what was missed is read from the server, and what
    // this phone still owes it goes now, the pauses between tries over.
    // Once the server answers again, New chat reads its offer if it has
    // none or if it is old (newChatAfterServerAnswered).
    await retryOutboxNow().catch(function () { return undefined; });
    await requestChatListViaRelay(pairing).then(newChatAfterServerAnswered, function () { return []; });
    const openId = selectedConversationId();
    if (openId) await requestTimelineViaRelay(pairing, openId).catch(function () { return 0; });
    startServerChanges();
    void markHubNoticesSeen();
    await render("synced");
  })().finally(function () {
    foregroundResyncPromise = undefined;
  });
  return foregroundResyncPromise;
}

export function wireForegroundResync() {
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      hiddenSince = Date.now();
      stopServerChanges();
      return;
    }
    void resyncAfterForeground();
    void runSettlePass();
  });
  window.addEventListener("pageshow", function (event) {
    if (event.persisted) {
      void resyncAfterForeground();
    }
  });
  window.addEventListener("online", function () {
    void resyncAfterForeground();
  });
}

/** Where a tapped notification lands: the Activity tab, showing what just
 *  happened across every chat. A chat can be one of many and a reply can be
 *  inside a thread, so the list is the one place that always holds it. */
export function openActivityFromNotification(list) {
  closeChatSearch();
  closeNewChat();
  leaveOpenChat();
  setHomeTab("activity");
  // The list the notification was about: an approval waits on Pending, a
  // reply is among what finished. Left to the list last read, a tap on
  // "Approval needed" could land on Finished with the approval behind a
  // tab switch.
  if (list === "pending" || list === "finished") {
    setActivityTab(list);
  }
  void render("synced");
}

export function wireWorkerMessages() {
  if (!("serviceWorker" in navigator)) {
    return;
  }
  navigator.serviceWorker.addEventListener("message", function (event) {
    if (event.data && event.data.type === "accord-open-activity") {
      openActivityFromNotification(event.data.list);
    }
    // A push counted while this page was open: fold it in now, so the chat
    // on screen is not left on the icon as unread until the next return.
    if (event.data && event.data.type === "accord-unread-changed") {
      void adoptWorkerUnread().then(renderChatList).catch(function () { return undefined; });
    }
  });
}
