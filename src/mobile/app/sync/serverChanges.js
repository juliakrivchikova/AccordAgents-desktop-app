import { render } from "../chat/render.js";
import { selectedConversationId } from "../chats/openChat.js";
import { serverPairing } from "../pairing/hubPairing.js";
import { handleRelayChatListPayload } from "./chatListPayload.js";
import { markHubNoticesSeen, SERVER_CHANGES_WAIT_MS, serverPhoneGet, serverReadsState } from "./serverReads.js";
import { settleHeldTurnsBeyondPage } from "./settledTurns.js";
import { handleRelayTimelinePayload } from "./timelinePayload.js";

async function requestChatListFromServer() {
  const requestedAt = Date.now();
  const payload = await serverPhoneGet("/v1/phone/chats");
  return handleRelayChatListPayload(payload, { requestedAt: requestedAt });
}

async function requestTimelineFromServer(conversationId, options) {
  const beforeMessageId = options && typeof options.beforeMessageId === "string" && options.beforeMessageId.trim()
    ? options.beforeMessageId
    : undefined;
  const payload = await serverPhoneGet("/v1/phone/timeline", { conversationId, beforeMessageId });
  const stored = await handleRelayTimelinePayload(payload, conversationId, {
    deferRender: Boolean(options && options.deferRender),
    historyPage: Boolean(beforeMessageId),
    opening: Boolean(options && options.opening),
    openedAt: options && options.openedAt
  });
  // Only a newest page with history before it can leave a held row behind:
  // a page that is the whole chat and lacks a row says the row is not the
  // server's at all, which the older rules (the corpse rule) handle.
  if (!beforeMessageId && payload && Array.isArray(payload.events) && payload.page && payload.page.hasMoreBefore === true) {
    void settleHeldTurnsBeyondPage(conversationId, payload.events);
  }
  return stored;
}

// What changed on the server, asked with a request the server holds open
// until something does. Runs while the app is in front; a chat that changed
// is read again: the list always, the open chat's newest page when it is
// the one.
let serverChanges = { instance: "", seq: 0 };

let serverChangesRunning = false;
let serverChangesStopped = false;

export function startServerChanges() {
  serverChangesStopped = false;
  if (serverChangesRunning || serverReadsState.serverReads !== "yes") return;
  serverChangesRunning = true;
  void (async function () {
    let failures = 0;
    try {
      while (!serverChangesStopped && serverReadsState.serverReads === "yes" && document.visibilityState !== "hidden") {
        let answer;
        try {
          answer = await serverPhoneGet("/v1/phone/changes", {
            instance: serverChanges.instance || "none",
            after: serverChanges.seq,
            waitMs: serverChanges.instance ? SERVER_CHANGES_WAIT_MS : 0
          }, { timeoutMs: SERVER_CHANGES_WAIT_MS + 15_000 });
          failures = 0;
        } catch (error) {
          const status = error && typeof error === "object" ? error.serverStatus : undefined;
          if (status === 404 || status === 403 || status === 401) {
            serverReadsState.serverReads = "no";
            // Taken off the server: said in place of the chats at once, and
            // New chat, the screen the app rests on, does not stay up.
            if (serverPairing.hubPairingState && serverPairing.hubPairingState.status === "revoked") void render();
            return;
          }
          failures += 1;
          await new Promise(function (resolve) { setTimeout(resolve, Math.min(30_000, 2_000 * failures)); });
          continue;
        }
        if (!answer || typeof answer.instance !== "string" || typeof answer.seq !== "number") continue;
        // The server is busy (or answered at once with nothing): ask again
        // a little later rather than straight away.
        if (typeof answer.retryAfterMs === "number" && answer.retryAfterMs > 0) {
          await new Promise(function (resolve) { setTimeout(resolve, Math.min(60_000, answer.retryAfterMs)); });
        }
        const first = !serverChanges.instance;
        const reset = answer.reset === true;
        serverChanges = { instance: answer.instance, seq: answer.seq };
        if (first) continue;
        const changed = Array.isArray(answer.conversationIds) ? answer.conversationIds : [];
        if (!reset && changed.length === 0) continue;
        const openConversationId = selectedConversationId();
        void markHubNoticesSeen();
        await requestChatListFromServer().catch(function () { return []; });
        if (openConversationId && (reset || changed.indexOf(openConversationId) >= 0)) {
          await requestTimelineFromServer(openConversationId).catch(function () { return 0; });
        }
        await render("synced");
      }
    } finally {
      serverChangesRunning = false;
    }
  })();
}

export function stopServerChanges() {
  serverChangesStopped = true;
}

/** The chat list, from the server; following its feed of changes starts
 *  (again) with it. */
export async function requestChatListViaRelay() {
  const chats = await requestChatListFromServer();
  serverReadsState.serverReads = "yes";
  startServerChanges();
  return chats;
}

/** A chat's newest page (or the page before a message), from the server. */
export async function requestTimelineViaRelay(pairing, conversationId, options) {
  return requestTimelineFromServer(conversationId, options);
}
