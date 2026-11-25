import { ACCORD_DOCK_STORAGE_KEY } from "../accord/accordDock.js";
import { nowIso, recordRelayDebug, sha256Hex } from "../base/bytes.js";
import {
  ACTIVE_CONVERSATION_KEY, CHAT_LIST_AT_KEY, CHAT_LIST_KEY, CHAT_TITLES_META_KEY, CONTROL_CARD_SENT_KEY, CONTROL_CARDS_KEY,
  LIST_ACTIVITY_SEEN_KEY, META_STORE, OLD_PAIRING_CLEARED_KEY, OPEN_STREAM_KEY, OPEN_THREAD_KEY, OUTBOX_STORE, OWN_CHATS_KEY,
  PAIRED_RELOAD_KEY, SYNC_WAIT_KEY, TERMINAL_RUNS_KEY, TIMELINE_PAGES_KEY, TIMELINE_STORE, UNREAD_KEY, UNREAD_META_KEY,
  VIEWED_AT_KEY
} from "../base/storageKeys.js";
import { render } from "../chat/render.js";
import { STARTED_CHATS_KEY } from "../chats/chatStore.js";
import { SEND_FAILURES_STORE, SEND_LOG_SEEN_KEY } from "../outbox/sendLog.js";
import { loadPairing } from "./pairing.js";
import { ACTIVITY_CLEARED_KEY, setStoredValue } from "../shell/home.js";
import { initHubSession } from "../shell/launch.js";
import { eventLogPort, readMetaRecord, replaceMetaRecord, replaceMetaRecordIf, writeMetaRecord } from "../store/database.js";
import { SETTLE_TURNS_KEY } from "../sync/settledTurns.js";

export const serverPairing = {
  // Where pairing with the server stands, for the screen: "pairing",
  // "outdated" (the Mac or its server is older), "failed", "revoked".
  hubPairingState: undefined,
  hubClientCache: undefined
};

// --- pairing with the User's own server ----------------------------------
// The phone pairs with her server itself: the desktop shows a code (the
// server's address, a one-time token, the server's id), the phone makes a
// key of its own and enrolls it, and from then on every read and every
// write is a request signed with that key, straight to the server. No
// desktop has to be awake, and the phone never addresses one.

export const HUB_PAIRING_KEY = "accordagents.mobile.hub.v1";

const HUB_IDENTITY_META_KEY = "hub-identity";
const HUB_PENDING_IDENTITY_META_KEY = "hub-identity-pending";
const HUB_PAIRING_META_KEY = "hub-pairing";

/** The key the server said it no longer knows (the phone was removed). */
export const HUB_REVOKED_IDENTITY_META_KEY = "hub-identity-revoked";

// What the phone kept when it wrote its own signed chains (before the
// server owned the chats): where each chain stood and its clock. Nothing
// reads them; they are cleared once (retireSignedChains).
export const OLD_CHAIN_HEAD_META_PREFIX = "hubHead:";

export const OLD_CHAIN_CLOCK_META_KEY = "hubClock";
export const HUB_PHONE_PROTOCOL = 2;

/** A queue entry the server answered is kept this long (its bubble, and
 *  the mark of an answer), then let go. */
export const HUB_SENT_KEEP_MS = 7 * 24 * 60 * 60_000;

export function loadHubPairing() {
  try {
    const raw = localStorage.getItem(HUB_PAIRING_KEY);
    const parsed = raw ? JSON.parse(raw) : undefined;
    return parsed && typeof parsed.hubUrl === "string" && typeof parsed.deviceId === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function isHubPairing(pairing) {
  return Boolean(pairing && pairing.hub === true && pairing.hubUrl);
}

/** A phone paired for every chat starts new ones, as the computer does; one
 *  paired for a single chat has only that chat. */
export function canStartChats(pairing) {
  return isHubPairing(pairing) && !pairing.conversationId;
}

/** The hub pairing in the shape the rest of the app reads a pairing in. */
export function hubPairingAsPairing(hub) {
  return {
    hub: true,
    hubUrl: hub.hubUrl,
    hubId: hub.hubId,
    deviceId: hub.deviceId,
    ...(hub.scope && hub.scope.scope === "conversation" ? { conversationId: hub.scope.conversationId } : {}),
    pairedAt: hub.pairedAt
  };
}

// The phone's key, read once: every request it signs asks for it, and
// each read was its own database open on the way to the server. Replaced
// when the phone pairs (or another tab does).
let hubIdentityCache;

// Bumped whenever the key may have changed: a read that started before
// does not put the old key back.
let hubIdentityGeneration = 0;

export function forgetHubIdentity() {
  hubIdentityGeneration += 1;
  hubIdentityCache = undefined;
}

function hasSigningKey(identity) {
  return Boolean(identity && (identity.privateKey || identity.privateKeyDerBase64));
}

export function hubIdentity() {
  if (hubIdentityCache) return Promise.resolve(hubIdentityCache);
  const generation = hubIdentityGeneration;
  return readMetaRecord(HUB_IDENTITY_META_KEY).then(function (identity) {
    if (!identity || !identity.deviceId || !hasSigningKey(identity)) throw new Error("This phone has lost its pairing key. Pair it again.");
    return identity.privateKeyDerBase64 ? sealStoredIdentity(identity) : identity;
  }).then(function (identity) {
    if (generation === hubIdentityGeneration) hubIdentityCache = identity;
    return identity;
  });
}

/**
 * A key this phone kept as text (it paired before keys were kept
 * unreadable) becomes a non-extractable key, once and in place: the same
 * key, so the server, the Mac and the pairing stay as they are and nothing
 * is paired again; the text is gone from the database. The key on record
 * is replaced only while it is still this one (another tab may have paired
 * meanwhile). A failed write signs from memory and is tried again on the
 * next launch.
 */
async function sealStoredIdentity(identity) {
  const api = globalThis.AccordHubClient;
  if (!api || typeof api.sealHubDeviceIdentity !== "function") return identity;
  const sealed = await api.sealHubDeviceIdentity(identity);
  try {
    await replaceMetaRecordIf(HUB_IDENTITY_META_KEY, sealed, function (current) {
      return Boolean(current && current.deviceId === identity.deviceId && current.privateKeyDerBase64);
    });
    // The key as stored must sign before its text is given up: a browser
    // that could not keep it gets the text back, and signs from it.
    const stored = await readMetaRecord(HUB_IDENTITY_META_KEY);
    if (stored && stored.deviceId === identity.deviceId && !stored.privateKeyDerBase64) {
      const works = await api.signHubRequestWeb(stored, { method: "GET", pathWithQuery: "/v1/key-check" }).then(function () { return true; }, function () { return false; });
      if (!works) {
        await replaceMetaRecordIf(HUB_IDENTITY_META_KEY, identity, function (current) {
          return Boolean(current && current.deviceId === identity.deviceId && !current.privateKeyDerBase64);
        });
        recordRelayDebug({ event: "hub-key-seal-reverted", deviceId: identity.deviceId });
        return identity;
      }
    }
    const pending = await readMetaRecord(HUB_PENDING_IDENTITY_META_KEY);
    if (pending && pending.identity && pending.identity.privateKeyDerBase64) {
      const pendingSealed = { ...pending, identity: await api.sealHubDeviceIdentity(pending.identity) };
      await replaceMetaRecordIf(HUB_PENDING_IDENTITY_META_KEY, pendingSealed, function (current) {
        return Boolean(current && current.tokenHash === pending.tokenHash && current.identity && current.identity.privateKeyDerBase64);
      });
    }
    recordRelayDebug({ event: "hub-key-sealed", deviceId: identity.deviceId });
  } catch (error) {
    recordRelayDebug({ event: "hub-key-seal-failed", message: String(error && error.message || error) });
  }
  return sealed;
}

export function hubClient() {
  const pairing = loadHubPairing();
  const api = globalThis.AccordHubClient;
  if (!pairing || !api) return undefined;
  if (!serverPairing.hubClientCache || serverPairing.hubClientCache.hubUrl !== pairing.hubUrl) {
    serverPairing.hubClientCache = { hubUrl: pairing.hubUrl, client: api.createHubDeviceClient({ hubUrl: pairing.hubUrl, identity: hubIdentity }) };
  }
  return serverPairing.hubClientCache.client;
}

/** The code the desktop shows, from the link it opened: `#hub=…&t=…&id=…`. */
export function readHubInvite(url) {
  const fragment = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const hubUrl = fragment.get("hub");
  const token = fragment.get("t");
  const hubId = fragment.get("id");
  if (!hubUrl || !token || !hubId) return undefined;
  try {
    const parsed = new URL(hubUrl);
    const local = parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !local) return undefined;
  } catch {
    return undefined;
  }
  return { hubUrl: hubUrl.replace(/\/+$/, ""), token: token, hubId: hubId };
}

function phoneName() {
  const agent = String(globalThis.navigator && navigator.userAgent || "");
  if (/iPhone/.test(agent)) return "iPhone";
  if (/iPad/.test(agent)) return "iPad";
  if (/Android/.test(agent)) return "Android phone";
  return "Phone";
}

function hubPairingFailure(error) {
  const status = error && typeof error.status === "number" ? error.status : 0;
  if (status === 410) return { status: "failed", message: "This pairing code was already used or has expired. Make a new one on your computer (Settings → Device Pairing)." };
  if (status === 404 || status === 405) return { status: "outdated", message: "Update AccordAgents on your computer, then pair this phone again." };
  if (error && error.unreachable) return { status: "failed", message: "Could not reach your server. Check the phone's connection and scan the code again." };
  if (status === 400 || status === 429) {
    // The server says what was wrong (a clock that is off, too many tries).
    let said = "";
    try { said = String(JSON.parse(error.body || "{}").error || ""); } catch { said = ""; }
    if (said) return { status: "failed", message: said };
  }
  return { status: "failed", message: "Pairing did not work: " + String(error && error.message || error) };
}

/**
 * A pairing code — from a link that opened the app, a pasted link or a
 * scanned code — is never used at once. The phone first says which server
 * it would pair with, and that this replaces the pairing it has, and pairs
 * only when the User says so: a link in a chat or on a page can carry a
 * code for anyone's server, and pairing with it would send what she writes
 * there.
 */
export function askToPair(invite) {
  serverPairing.hubPairingState = { status: "confirm", invite: invite, replacing: Boolean(loadHubPairing()) };
  void render();
}

/** The server this phone is paired with now: its id at its address. */
export function currentHubServer() {
  const pairing = loadHubPairing();
  if (!pairing) return undefined;
  try {
    return pairing.hubId + "@" + new URL(pairing.hubUrl).origin;
  } catch {
    return pairing.hubId + "@" + pairing.hubUrl;
  }
}

export function serverHost(hubUrl) {
  try {
    return new URL(hubUrl).host;
  } catch {
    return String(hubUrl || "");
  }
}

/** The same server at the same address: the id alone is not enough, since
 *  any server can answer with the id the User's own server publishes. */
export function isSameServer(pairing, invite) {
  if (!pairing || !invite || pairing.hubId !== invite.hubId) return false;
  try {
    return new URL(pairing.hubUrl).origin === new URL(invite.hubUrl).origin;
  } catch {
    return false;
  }
}

/**
 * What this phone kept of the chats of the server it was paired with: its
 * chats, cards, timelines, the send log and what it has not sent yet.
 * Pairing with another server clears it, so nothing kept for one server is
 * shown as the other's, and nothing written for one goes to the other.
 */
async function forgetServerData() {
  await eventLogPort().runAtomic([TIMELINE_STORE, OUTBOX_STORE, SEND_FAILURES_STORE, META_STORE], function (tx) {
    return Promise.all([
      tx.clear(TIMELINE_STORE), tx.clear(OUTBOX_STORE), tx.clear(SEND_FAILURES_STORE),
      tx.remove(META_STORE, UNREAD_META_KEY), tx.remove(META_STORE, CHAT_TITLES_META_KEY)
    ]);
  });
  const keys = [CHAT_LIST_KEY, CHAT_LIST_AT_KEY, CONTROL_CARDS_KEY, CONTROL_CARD_SENT_KEY, UNREAD_KEY, OWN_CHATS_KEY, TIMELINE_PAGES_KEY,
    ACTIVE_CONVERSATION_KEY, OPEN_THREAD_KEY, OPEN_STREAM_KEY, STARTED_CHATS_KEY, VIEWED_AT_KEY, LIST_ACTIVITY_SEEN_KEY,
    ACTIVITY_CLEARED_KEY, TERMINAL_RUNS_KEY, SYNC_WAIT_KEY, SEND_LOG_SEEN_KEY, SETTLE_TURNS_KEY, ACCORD_DOCK_STORAGE_KEY];
  for (const key of keys) {
    try {
      localStorage.removeItem(key);
      sessionStorage.removeItem(key);
    } catch {
      // A key that cannot be removed holds only what the next read replaces.
    }
  }
}

/**
 * Pairs this phone with the User's server from the code the desktop shows.
 * The key is made (and kept) before it is offered, so a lost answer is
 * asked again with the same key and the same code; the server answers the
 * same phone again rather than refusing it.
 */
export async function pairWithServer(invite) {
  // Pairing over a pairing this phone has: the screen says how it goes in
  // place of the chats, and after a failure the chats come back as they
  // were (Back to chats); they are cleared only once the new pairing holds.
  const replacing = Boolean(loadHubPairing());
  const api = globalThis.AccordHubClient;
  if (!api) {
    serverPairing.hubPairingState = { status: "failed", message: "This copy of the app cannot pair yet. Reload it and scan the code again.", replacing: replacing };
    await render();
    return false;
  }
  serverPairing.hubPairingState = { status: "pairing", replacing: replacing };
  await render();
  try {
    const probe = api.createHubDeviceClient({ hubUrl: invite.hubUrl, identity: function () { return Promise.reject(new Error("not paired")); } });
    const health = await probe.health();
    if (!health || !(Number(health.protocol) >= HUB_PHONE_PROTOCOL)) {
      serverPairing.hubPairingState = { status: "outdated", message: "Update AccordAgents on your computer, then pair this phone again.", replacing: replacing };
      await render();
      return false;
    }
    if (health.hubId !== invite.hubId) {
      serverPairing.hubPairingState = { status: "failed", message: "This code is for another server. Make a new one on your computer.", replacing: replacing };
      await render();
      return false;
    }
    const tokenHash = await sha256Hex(invite.token);
    const pending = await readMetaRecord(HUB_PENDING_IDENTITY_META_KEY);
    // A phone paired with this server before keeps its key: paired again,
    // it replaces its own entry on the Mac and the server instead of
    // standing beside it as a second phone.
    const previous = await readMetaRecord(HUB_IDENTITY_META_KEY);
    const previousPairing = await readMetaRecord(HUB_PAIRING_META_KEY);
    const revoked = await readMetaRecord(HUB_REVOKED_IDENTITY_META_KEY);
    const sameServer = Boolean(previous && previous.deviceId && hasSigningKey(previous) && previousPairing &&
      isSameServer(previousPairing, invite) && previousPairing.deviceId === previous.deviceId &&
      !(revoked && revoked.deviceId && revoked.deviceId === previous.deviceId));
    const chosen = pending && pending.tokenHash === tokenHash && pending.identity ? pending.identity
      : sameServer ? previous : await api.createHubDeviceIdentity();
    // A key kept as text (paired before) goes on as a non-extractable one.
    const identity = chosen.privateKeyDerBase64 ? await api.sealHubDeviceIdentity(chosen) : chosen;
    await replaceMetaRecord(HUB_PENDING_IDENTITY_META_KEY, { tokenHash: tokenHash, identity: identity });
    const answer = await api.enrollHubPhone({ hubUrl: invite.hubUrl, hubId: invite.hubId, token: invite.token, identity: identity, name: phoneName() });
    // Another server than the one this phone is paired with: what it kept
    // for that one goes first, and the app starts again on the new one.
    const current = loadHubPairing();
    const switching = Boolean(current) && !isSameServer(current, invite);
    if (switching) await forgetServerData();
    // The key the server now knows this phone by, before the pairing that
    // names it: a pairing without its key could never sign again. What the
    // queue still holds goes out under it: a request is signed when it is
    // sent, the operations in it are not.
    await replaceMetaRecord(HUB_IDENTITY_META_KEY, identity);
    forgetHubIdentity();
    const pairing = { hubUrl: invite.hubUrl, hubId: invite.hubId, deviceId: identity.deviceId, scope: answer.scope, pairedAt: nowIso(), protocol: answer.protocol };
    setStoredValue(HUB_PAIRING_KEY, JSON.stringify(pairing));
    // Paired again: the note that the old pairing was cleared has done its work.
    localStorage.removeItem(OLD_PAIRING_CLEARED_KEY);
    if (revoked && revoked.deviceId) await writeMetaRecord(HUB_REVOKED_IDENTITY_META_KEY, { deviceId: "" }).catch(function () {});
    serverPairing.hubClientCache = undefined;
    // The worker reads these to fetch what a push is about.
    await writeMetaRecord(HUB_PAIRING_META_KEY, { hubUrl: invite.hubUrl, hubId: invite.hubId, deviceId: identity.deviceId });
    if (answer.scope && answer.scope.scope === "conversation") {
      localStorage.setItem(ACTIVE_CONVERSATION_KEY, answer.scope.conversationId);
    }
    // Nothing more to write: the server put this phone on its roster as it
    // enrolled, and the desktop learns it from that roster.
    serverPairing.hubPairingState = undefined;
    recordRelayDebug({ event: "hub-paired", deviceId: identity.deviceId, switched: switching });
    if (switching) {
      // Nothing this page holds in memory belongs to the new server. The
      // launch after it is the pairing's, not a fresh start: it lands on
      // the chats, as a pairing with the same server does.
      try { sessionStorage.setItem(PAIRED_RELOAD_KEY, "1"); } catch { /* lands on New chat instead */ }
      globalThis.location.reload();
      return true;
    }
    await render();
    // From here on the phone works as it does after a launch: what it owes
    // goes out, the chats come in, live progress and alerts start.
    await initHubSession(loadPairing());
    return true;
  } catch (error) {
    serverPairing.hubPairingState = { ...hubPairingFailure(error), replacing: replacing };
    recordRelayDebug({ event: "hub-pairing-failed", message: String(error && error.message || error) });
    await render();
    return false;
  }
}
