import { selectedConversationId } from "../chats/openChat.js";
import { HUB_REVOKED_IDENTITY_META_KEY, hubClient, hubIdentity, isHubPairing, serverPairing } from "../pairing/hubPairing.js";
import { loadPairing } from "../pairing/pairing.js";
import { refreshHubMachines } from "../settings/machineWake.js";
import { writeMetaRecord } from "../store/database.js";
import { listTimelineEntries } from "../store/timelineRows.js";
import { retryPendingOutbox } from "./outboxRetry.js";
import { handleRelayTimelinePayload } from "./timelinePayload.js";

export const serverReadsState = {
  // Whether the server's feed of changes may be followed: "yes" once the
  // chat list has been read from it, "no" after it refused the feed (it is
  // asked again with the next list).
  serverReads: "unknown"
};

// Who waits for this phone's part of the next hand-over to be done.
let handOverWaiters = [];

/** Called as the first request of a hand-over is started (the operations,
 *  or a picture put up before the message that names it): the queue is
 *  written. The request itself is not sent yet — its signature and the
 *  network still follow, asynchronously. */
export function noteHandOverRequestStarted() {
  const waiters = handOverWaiters;
  handOverWaiters = [];
  for (const resolve of waiters) resolve();
}

// The longest a redraw after a send waits for the hand-over to start. The
// wait is the phone's own work (its queue, the signature), tens of
// milliseconds; this only bounds a store that has stalled.
const SEND_BEFORE_DRAW_MAX_MS = 1_000;

/** What the User just did goes to the server before the chat is drawn
 *  again: a redraw reads and checks every row of the chat in one go, and
 *  started first, it held the hand-over back for as long as it took (most
 *  of the time between Send and the server having it). The wait ends when
 *  the first request has been started (see noteHandOverRequestStarted),
 *  when the flush ends without one, or after a second at most: the screen
 *  is never held for the network. */
export function handOverBeforeDrawing(flushing) {
  let timer;
  let waiter;
  const started = new Promise(function (resolve) {
    waiter = resolve;
    handOverWaiters.push(resolve);
    timer = setTimeout(resolve, SEND_BEFORE_DRAW_MAX_MS);
  });
  return Promise.race([started, flushing.then(function () { return undefined; }, function () { return undefined; })])
    .finally(function () {
      clearTimeout(timer);
      handOverWaiters = handOverWaiters.filter(function (item) { return item !== waiter; });
    });
}

/** The app is open and showing what happened: the notices so far are
 *  seen, so the server does not ring this phone for them, nor does a later
 *  ring show them again. At most every ten seconds. */
let hubNoticesSeenAt = 0;

export async function markHubNoticesSeen() {
  if (!isHubPairing(loadPairing()) || document.visibilityState === "hidden" || Date.now() - hubNoticesSeenAt < 10_000) return;
  hubNoticesSeenAt = Date.now();
  try {
    const client = hubClient();
    const answer = await hubPhoneGet("/v1/phone/notices", {});
    if (client && answer && Number.isSafeInteger(answer.head) && answer.head > (Number(answer.seen) || 0)) {
      await client.postJson("/v1/phone/seen", { through: answer.head });
    }
  } catch {
    // The next look marks them.
  }
}

/** A signed read from the server, as serverPhoneGet answers it. */
export async function hubPhoneGet(path, params, options) {
  const client = hubClient();
  if (!client) throw Object.assign(new Error("Not paired with a server"), { serverStatus: 0, unavailable: true });
  try {
    return await client.getJson(path, params || {}, { timeoutMs: (options && options.timeoutMs) || SERVER_FETCH_TIMEOUT_MS });
  } catch (error) {
    const status = error && typeof error.status === "number" ? error.status : 0;
    if (status === 401 && String(error && error.body || "").indexOf("not on the hub's roster") >= 0) {
      // Taken off the server's devices (removed on the desktop): this phone
      // reads nothing more and says so. Any other refusal (a clock that is
      // off) is not a removal.
      serverPairing.hubPairingState = { status: "revoked", message: "This phone was removed from your server. Pair it again from your computer." };
      // Paired again after this, the phone gets a new key: the one the
      // User took off is not trusted again.
      void hubIdentity().then(function (identity) { return writeMetaRecord(HUB_REVOKED_IDENTITY_META_KEY, { deviceId: identity.deviceId }); }).catch(function () {});
    }
    throw Object.assign(new Error(String(error && error.message || error)), { serverStatus: status, serverBody: error && error.body || "", unavailable: Boolean(error && error.unreachable) });
  }
}

// Live progress of the open chat's running members, read from the server
// while one runs: the same pending rows the desktop's live frames carried.
let hubProgressTimer;

let hubProgressBusy = false;

export function startHubProgressPolling() {
  if (hubProgressTimer) return;
  let ticks = 0;
  hubProgressTimer = setInterval(function () {
    // What the server says about the machines (waking, last seen) every
    // fifteen seconds while the app is open.
    ticks += 1;
    if (ticks % 10 === 0 && document.visibilityState !== "hidden") void refreshHubMachines();
    // A send the server never answered (a dropped connection, a server
    // restarting) is offered again while the app is open; the server keeps
    // one copy whatever arrives twice.
    void retryPendingOutbox();
    const pairing = loadPairing();
    const conversationId = selectedConversationId();
    if (!isHubPairing(pairing) || !conversationId || document.visibilityState === "hidden" || hubProgressBusy) return;
    hubProgressBusy = true;
    void listTimelineEntries(conversationId).then(function (rows) {
      if (!rows.some(function (row) { return row.role === "participant" && row.status === "pending"; })) return undefined;
      return hubPhoneGet("/v1/phone/progress", { conversationId: conversationId }).then(function (payload) {
        return handleRelayTimelinePayload(payload, conversationId, { live: true });
      });
    }).catch(function () { return undefined; }).finally(function () { hubProgressBusy = false; });
  }, 1_500);
}

const SERVER_FETCH_TIMEOUT_MS = 20_000;
export const SERVER_CHANGES_WAIT_MS = 25_000;

/** A signed read from the server. */
export function serverPhoneGet(path, params, options) {
  return hubPhoneGet(path, params, options);
}
