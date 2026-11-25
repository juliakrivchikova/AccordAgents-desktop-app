import { recordRelayDebug } from "../base/bytes.js";
import { META_STORE, OLD_PAIRING_CLEARED_KEY, OUTBOX_STORE } from "../base/storageKeys.js";
import { askToPair, hubPairingAsPairing, loadHubPairing, readHubInvite } from "./hubPairing.js";
import { eventLogPort } from "../store/database.js";

// A pairing made the old way, through the desktop's relay. Nothing reads or
// writes through it any more: a phone that still holds one is told to pair
// again with the User's server, and what that pairing kept is cleared.
const OLD_PAIRING_KEY = "accordagents.mobile.pairing.v1";

const OLD_MAILBOX_CURSOR_KEY = "accordagents.mobile.mailboxCursor.v1";

// What the old way kept on this phone, in stores and meta records nothing
// reads any more. The stores stay in the database's description (it only
// ever adds); their contents go with the old pairing.
const OLD_PAIRING_STORES = ["sealedEnvelopes", "events", "machineEvents", "machineOutbox", "machineBlobs"];

const OLD_PAIRING_META_KEYS = ["mailboxAccess", "machine-command-identity", "machine-access", "machine-run-terminals"];
const OLD_PAIRING_META_PREFIXES = ["machine-change-order:", "conversation-deleted:"];

/** How this phone is paired: with the User's server, or not at all. A
 *  pairing made the old way (through the desktop's relay) is not one: it is
 *  cleared at launch (see clearOldPairing). */
export function loadPairing() {
  const hub = loadHubPairing();
  return hub ? hubPairingAsPairing(hub) : undefined;
}

// Once a pairing code is read from the address, it leaves the address bar:
// a URL surviving in history, screenshots or share sheets must not be able
// to pair anyone else. Non-credential params (the qa debug flag) survive,
// and the app never re-reads credentials from location after boot. A link
// made the old way carried its credentials in these too, and is scrubbed
// the same way though it pairs nothing.
const CREDENTIAL_URL_PARAMS = ["pair", "rid", "rendezvousId", "route", "routingId", "cap", "fingerprint", "relay", "endpoint", "mailbox", "mailboxUrl", "outbox", "outboxUrl", "conversationId", "relaySealKey"];

function scrubCredentialsFromLocation() {
  try {
    const history = globalThis.history;
    const locationValue = globalThis.location;
    if (!history || !history.replaceState || !locationValue) {
      return;
    }
    const url = new URL(locationValue.href);
    let dirty = Boolean(url.hash);
    url.hash = "";
    for (const param of CREDENTIAL_URL_PARAMS) {
      if (url.searchParams.has(param)) {
        url.searchParams.delete(param);
        dirty = true;
      }
    }
    if (!dirty) {
      return;
    }
    const query = url.searchParams.toString();
    history.replaceState(null, "", url.pathname + (query ? "?" + query : ""));
  } catch {
    // Scrubbing is hygiene; failing must never break pairing itself.
  }
}

/** Asks whether to pair with the server a pairing code names, when the
 *  address carries one; true when it did. */
export function readBootstrapFromLocation(locationValue) {
  const url = new URL(locationValue.href);
  // A code for a server: the phone asks before it pairs (askToPair); the
  // address bar keeps none of it.
  const invite = readHubInvite(url);
  if (invite) {
    scrubCredentialsFromLocation();
    askToPair(invite);
    return true;
  }
  if (url.hash || CREDENTIAL_URL_PARAMS.some(function (param) { return url.searchParams.has(param); })) {
    scrubCredentialsFromLocation();
  }
  return false;
}

/**
 * A pairing made the old way, through the desktop's relay, is not used for
 * anything: what it kept on this phone (its key, its mailbox's cursor and
 * mirrored access, its queue in the relay's form, the machine journal) is
 * cleared. A phone that has no server pairing yet says once, plainly, that
 * it has to be paired again; the note stays until it is.
 */
export function clearOldPairing() {
  let held = false;
  try {
    held = localStorage.getItem(OLD_PAIRING_KEY) !== null;
    if (!held) return Promise.resolve(false);
    // Said at once (the phone cannot use the old pairing either way); the
    // key itself goes only once what it kept is cleared, so a launch that
    // could not clear it tries again at the next one.
    if (!loadHubPairing()) localStorage.setItem(OLD_PAIRING_CLEARED_KEY, "1");
  } catch {
    return Promise.resolve(held);
  }
  let dropped = 0;
  return eventLogPort().runAtomic(OLD_PAIRING_STORES.concat([META_STORE, OUTBOX_STORE]), function (tx) {
    return Promise.all(OLD_PAIRING_STORES.map(function (name) { return tx.clear(name); }))
      .then(function () { return Promise.all(OLD_PAIRING_META_KEYS.map(function (key) { return tx.remove(META_STORE, key); })); })
      .then(function () {
        return tx.removeWhere(META_STORE, function (record) {
          const key = record && typeof record.key === "string" ? record.key : "";
          return OLD_PAIRING_META_PREFIXES.some(function (prefix) { return key.indexOf(prefix) === 0; });
        });
      })
      // What the old pairing never sent goes with it: it was addressed to
      // the desktop through the relay, and nothing reads it any more.
      .then(function () { return tx.removeWhere(OUTBOX_STORE, function (entry) { const old = !entry || entry.hub !== true; if (old) dropped += 1; return old; }); });
  }).then(function () {
    try {
      localStorage.removeItem(OLD_PAIRING_KEY);
      localStorage.removeItem(OLD_MAILBOX_CURSOR_KEY);
    } catch {
      // Tried again at the next launch.
    }
    recordRelayDebug({ event: "old-pairing-cleared", hubPaired: Boolean(loadHubPairing()), droppedUnsent: dropped });
    return true;
  }, function (error) {
    recordRelayDebug({ event: "old-pairing-clear-failed", message: String(error && error.message || error) });
    return true;
  });
}

export function oldPairingCleared() {
  try {
    return localStorage.getItem(OLD_PAIRING_CLEARED_KEY) === "1";
  } catch {
    return false;
  }
}
