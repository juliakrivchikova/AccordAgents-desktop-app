import { outboxStatusById } from "../base/storageKeys.js";
import { render } from "../chat/render.js";
import { flushOutboxToServer, sendFailureOf } from "../outbox/hubOutbox.js";
import { listOutboxEntries } from "../outbox/outboxStore.js";
import { serverOwesEntry } from "../outbox/sending.js";
import { recordSendFailure, sendFailureRecord } from "../outbox/sendLog.js";
import { isHubPairing, serverPairing } from "../pairing/hubPairing.js";
import { loadPairing } from "../pairing/pairing.js";

let activeFlushOutboxPromise;

// While the app is open, what the server has not answered is offered again:
// two seconds after an attempt that got no answer, then twice as long each
// time, up to half a minute. A send, the network coming back and the app
// coming to the front each try at once, and the pauses start over.
const OUTBOX_RETRY_FIRST_MS = 2_000;

const OUTBOX_RETRY_MAX_MS = 30_000;
let outboxRetryTimer;
let outboxRetryDelayMs = 0;

function outboxOwesAnything() {
  for (const held of outboxStatusById.values()) {
    if (serverOwesEntry(held)) return true;
  }
  return false;
}

/** After every attempt: the next one, if anything still waits. */
function scheduleOutboxRetry() {
  if (outboxRetryTimer) {
    clearTimeout(outboxRetryTimer);
    outboxRetryTimer = undefined;
  }
  // A phone removed from the server sends nothing until it is paired again.
  if (!outboxOwesAnything() || !isHubPairing(loadPairing()) || (serverPairing.hubPairingState && serverPairing.hubPairingState.status === "revoked")) {
    outboxRetryDelayMs = 0;
    return;
  }
  outboxRetryDelayMs = outboxRetryDelayMs ? Math.min(OUTBOX_RETRY_MAX_MS, outboxRetryDelayMs * 2) : OUTBOX_RETRY_FIRST_MS;
  outboxRetryTimer = setTimeout(function () {
    outboxRetryTimer = undefined;
    // An app in the background is not open: coming back tries at once.
    if (document.visibilityState === "hidden") return;
    void flushOutbox().then(function (result) { return render(result && result.status); }).catch(function () { return undefined; });
  }, outboxRetryDelayMs);
}

/** Tries now, and the pauses start over. */
export function retryOutboxNow() {
  outboxRetryDelayMs = 0;
  return flushOutbox();
}

/** The app's own tick: an entry still waiting with no attempt on its way
 *  and none planned (the page was in the background when one was due)
 *  gets its next one. */
export function retryPendingOutbox() {
  if (activeFlushOutboxPromise || outboxRetryTimer || document.visibilityState === "hidden" || !outboxOwesAnything()) return Promise.resolve();
  scheduleOutboxRetry();
  return Promise.resolve();
}

// One more pass, queued behind a flush in flight: that flush read the queue
// before the entry this call is about was written, so answering with it
// alone left a message sent during a slow flush waiting for the retry tick
// half a minute later. However many ask meanwhile, one pass follows.
let queuedFlushOutboxPromise;

// One attempt at a time; but an attempt that has not finished in this long
// (a request or the phone's database that never answers) no longer holds
// the queue back: the next one starts, and the log says why. The server
// takes an operation once however often it arrives.
const OUTBOX_FLUSH_STUCK_MS = 120_000;

export function flushOutbox() {
  if (activeFlushOutboxPromise) {
    if (!queuedFlushOutboxPromise) {
      const again = function () {
        queuedFlushOutboxPromise = undefined;
        return flushOutbox();
      };
      queuedFlushOutboxPromise = activeFlushOutboxPromise.then(again, again);
    }
    return queuedFlushOutboxPromise;
  }
  let watchdog;
  const stuck = new Promise(function (resolve) {
    watchdog = setTimeout(function () { resolve({ stuck: true }); }, OUTBOX_FLUSH_STUCK_MS);
  });
  activeFlushOutboxPromise = Promise.race([flushOutboxInternal(), stuck]).then(async function (result) {
    if (result && result.stuck) {
      const owed = (await listOutboxEntries().catch(function () { return []; })).filter(serverOwesEntry);
      for (const entry of owed) {
        await recordSendFailure(sendFailureRecord(entry, { cause: "phone", reason: "Sending did not finish in two minutes; it was started again." }));
      }
      return { status: "waiting-to-sync", sent: 0, pending: owed.length };
    }
    // Anything that came back reached the server, or said it could not.
    if (result) outboxUnreachable = result.status === "unreachable";
    return result;
  }).finally(function () {
    clearTimeout(watchdog);
    activeFlushOutboxPromise = undefined;
    scheduleOutboxRetry();
  });
  return activeFlushOutboxPromise;
}

// The last send could not reach anything, and none has since: the header
// keeps saying so until one does, not only on the render right after it.
export let outboxUnreachable = false;

async function flushOutboxInternal() {
  // Every chat's queue, not only the open chat's: an answer given from
  // Activity for a chat that was then never opened again sat here for days.
  const entries = await listOutboxEntries();
  const owed = entries.filter(serverOwesEntry);
  if (!isHubPairing(loadPairing())) {
    return { status: "unreachable", sent: 0, pending: owed.length };
  }
  if (owed.length === 0) return { status: "synced", sent: 0, pending: 0 };
  try {
    return await flushOutboxToServer(entries);
  } catch (error) {
    // Not the network's doing (the phone's own database, say): said in the
    // log for each entry still waiting, and tried again.
    const failure = sendFailureOf(error);
    for (const entry of owed) await recordSendFailure(sendFailureRecord(entry, failure));
    return { status: "waiting-to-sync", sent: 0, pending: owed.length, error: failure.reason };
  }
}
