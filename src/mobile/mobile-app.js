(function () {
  const META_STORE = "meta";
  const SEALED_STORE = "sealedEnvelopes";
  const MAILBOX_ACCESS_META_KEY = "mailboxAccess";
  const OUTBOX_STORE = "outbox";
  // W: this device's own durable event log. The phone is an emitter, not a
  // remote control, so what it did has to survive being closed mid-action.
  const EVENT_STORE = "events";
  // The machine journal is kept apart from the desktop mailbox queue: the two
  // have different recipients and different acknowledgements, and a flush of
  // one must never pick up the other's work.
  const MACHINE_EVENT_STORE = "machineEvents";
  const MACHINE_OUTBOX_STORE = "machineOutbox";
  const MACHINE_BLOB_STORE = "machineBlobs";
  const TIMELINE_STORE = "timeline";
  const PAIRING_KEY = "accordagents.mobile.pairing.v1";
  const ACTIVE_CONVERSATION_KEY = "accordagents.mobile.activeConversationId.v1";
  const OPEN_THREAD_KEY = "accordagents.mobile.openThreadRootId.v1";
  // W-M: which run's reply is being watched. Session-scoped like the open
  // thread: reopening the app should land you back in the chat, not in a
  // stream for a run that finished while you were away.
  const OPEN_STREAM_KEY = "accordagents.mobile.openStreamRunId.v1";
  const SYNC_WAIT_KEY = "accordagents.mobile.syncWaitStartedAt.v1";
  const CHAT_LIST_KEY = "accordagents.mobile.chatList.v1";
  const MAILBOX_CURSOR_KEY = "accordagents.mobile.mailboxCursor.v1";
  const TERMINAL_RUNS_KEY = "accordagents.mobile.terminalRuns.v1";
  // Cards a member is waiting on, per chat, as the desktop last stated them.
  // Kept so closing the app does not lose a question that is still open.
  const CONTROL_CARDS_KEY = "accordagents.mobile.controlCards.v1";
  // Cards answered from this phone whose answer the desktop has not yet
  // stated as applied, with the queue entry that carries the answer. Kept
  // across launches: a mark that lived only in memory made a reloaded app
  // show the card as never answered (the User, 2026-09-20).
  const CONTROL_CARD_SENT_KEY = "accordagents.mobile.controlCardSent.v1";
  // Chats with activity this phone has not looked at yet. The dot in the list
  // and the number on the app icon both read from here; the service worker
  // adds to its IndexedDB mirror when a push lands while the app is closed.
  const UNREAD_KEY = "accordagents.mobile.unreadConversationIds.v1";
  const UNREAD_META_KEY = "unreadConversations";
  const CHAT_TITLES_META_KEY = "chatTitles";
  // Where the history of each chat stops on this phone: whether the desktop
  // has messages before the oldest one shown, and which message to ask before.
  const TIMELINE_PAGES_KEY = "accordagents.mobile.timelinePages.v1";
  // Which home tab the bottom bar shows (Chats, Activity, Settings), and which
  // list Activity was left on. Coming back from a chat lands where you left.
  const HOME_TAB_KEY = "accordagents.mobile.homeTab.v1";
  const ACTIVITY_TAB_KEY = "accordagents.mobile.activityTab.v1";
  // When each chat was last looked at on this phone. Activity reads a finished
  // update as seen when the chat was opened after it arrived.
  const VIEWED_AT_KEY = "accordagents.mobile.viewedAt.v1";
  // When the desktop's chat list last reached this phone, on its own clock.
  // Activity drops an "in progress" row that reached the phone well before a
  // list saying nothing runs in that chat: a run the phone never saw end.
  const CHAT_LIST_AT_KEY = "accordagents.mobile.chatListAt.v1";
  const TERMINAL_RUNS_MAX = 600;
  const DEFAULT_MANAGED_RELAY_URL = "wss://relay.accordagents.com/v1/relay";
  const RELAY_PROTOCOL = "accord-relay-v1";
  const RELAY_FRAME_MAX_BYTES = 10_240;
  const RELAY_FRAME_OVERHEAD_BYTES = 512;
  const RELAY_ACK_TIMEOUT_MS = 20_000;
  const RELAY_TIMELINE_IDLE_MS = 15 * 60_000;
  // Re-attach well inside the idle window so pushed messages never stop
  // arriving after a quiet stretch.
  const RELAY_TIMELINE_KEEPALIVE_MS = 60_000;
  const MAILBOX_TIMELINE_POLL_MS = 2_500;
  // What one read of the box brings back, and how much of a backlog the
  // catch-up after opening will work through before it draws what it has.
  const MAILBOX_PAGE_SIZE = 500;
  // How long one mailbox request may take before it counts as failed. The
  // worker's background read allows ten seconds; the page can afford more.
  const MAILBOX_FETCH_TIMEOUT_MS = 15_000;
  const CATCH_UP_PAGE_BUDGET = 25;
  const CATCH_UP_BUDGET_MS = 8_000;
  let activeFlushOutboxPromise;
  // The status of every queue entry this phone has seen, by event id, so a
  // card can say whether the answer it sent was handed over without a read.
  const outboxStatusById = new Map();
  let activeRelaySocket;
  let activeRelaySocketKey;
  let activeRelaySocketPromise;
  let activeRelayTimelineCollectorSocket;
  let activeMailboxTimelinePollTimer;
  let activeRelayTimelineKeepAliveTimer;
  // Held so a second bootstrap replaces the ticker instead of stacking another
  // one on top of it.
  let activeThinkingClockTimer;
  let activeSyncProgressClockTimer;
  let lastChatListRenderSignature = "";
  let lastActivityRenderSignature = "";
  let lastSettingsRenderSignature = "";
  // The choice opened from Activity to be answered in full, by card id.
  let openActivityCardId;
  // The thread to land in when the chat Activity is opening is first drawn.
  let pendingThreadOpen;
  // Bumped by every write to the timeline store. The home screens redraw on
  // every batch and poll; rereading a week of messages each time for the
  // Activity badge would cost the phone far more than the list is worth.
  let timelineGeneration = 0;
  let recentTimelineCache;
  let recentTimelineRead;
  // The lists last built, and what they were built from.
  let activityMemo;
  // When the Activity list was last redrawn; taps right after it are ignored.
  let lastActivityListRenderAt = 0;
  let lastActivityRowOrder = "";
  let chatListRefreshTimer;
  let lastChatListRefreshAt = 0;
  let activityRereadTimer;
  const ACTIVITY_REREAD_MIN_MS = 1500;
  let activityItemRenderToken = 0;

  function nowIso() {
    return new Date().toISOString();
  }

  // A relay frame arrives as text or as bytes depending on how the peer sent
  // it. Both are the same JSON.
  function relayFrameText(data) {
    if (typeof data === "string") {
      return data;
    }
    if (data instanceof ArrayBuffer) {
      return new TextDecoder().decode(data);
    }
    if (data && typeof data.byteLength === "number") {
      return new TextDecoder().decode(data);
    }
    return String(data);
  }

  function recordRelayDebug(entry) {
    try {
      if (!new URL(globalThis.location.href).searchParams.has("qa")) {
        return;
      }
      globalThis.__relayDebug = globalThis.__relayDebug || [];
      globalThis.__relayDebug.push({
        at: Date.now(),
        ...entry
      });
    } catch {
      return;
    }
  }

  function createEventId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
      globalThis.crypto.getRandomValues(bytes);
    } else {
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Math.floor(Math.random() * 256);
      }
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, function (byte) {
      return byte.toString(16).padStart(2, "0");
    }).join("");
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20)
    ].join("-");
  }

  function bytesToBase64Url(bytes) {
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function base64UrlToBytes(value) {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function base64UrlToText(value) {
    return new TextDecoder().decode(base64UrlToBytes(value));
  }

  function textToBytes(value) {
    return new TextEncoder().encode(value);
  }

  async function sha256Hex(value) {
    if (!globalThis.crypto?.subtle) {
      throw new Error("Mobile outbox hashing requires WebCrypto.");
    }
    const digest = await globalThis.crypto.subtle.digest("SHA-256", textToBytes(value));
    return Array.from(new Uint8Array(digest), function (byte) {
      return byte.toString(16).padStart(2, "0");
    }).join("");
  }

  function stableJson(value) {
    if (value === undefined) {
      return "null";
    }
    if (value === null || typeof value !== "object") {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return "[" + value.map(stableJson).join(",") + "]";
    }
    return "{" + Object.keys(value).filter(function (key) {
      return value[key] !== undefined;
    }).sort().map(function (key) {
      return JSON.stringify(key) + ":" + stableJson(value[key]);
    }).join(",") + "}";
  }

  // >>> generated: mailbox-crypto (edit src/shared/mailboxCryptoContract.js, then run scripts/generate-mailbox-crypto.mjs)
  // Canonical mailbox crypto contract (W4). THIS FILE IS THE SINGLE SOURCE:
  // scripts/generate-mailbox-crypto.mjs copies it verbatim into the PWA
  // (src/mobile/mobile-app.js, between the generated markers)
  // and regenerates the known-answer fixture
  // (scripts/mailbox-contract-vectors.json). Edit here, run the generator, and
  // commit the regenerated outputs together — a stale copy is a review failure.
  //
  // Plain JS with zero imports so the same text runs in the browser page, the
  // phone's service worker and the desktop (Node >= 18.17 exposes
  // globalThis.crypto). Constants must match src/shared/mailboxSealedPayload.ts;
  // the generator refuses to run when they drift.
  (function () {
    var MAILBOX_AUTH_TOKEN_INFO = "accord-mailbox-auth-v1";
    var MAILBOX_SCOPE_ID_INFO = "accord-mailbox-scope-v1";
    var MAILBOX_SCOPE_ID_PREFIX = "mb-";
    var MAILBOX_SCOPE_ID_LENGTH = 32;

    function subtle() {
      if (!globalThis.crypto || !globalThis.crypto.subtle) {
        throw new Error("Mailbox crypto requires WebCrypto.");
      }
      return globalThis.crypto.subtle;
    }

    function textToBytesC(value) {
      return new TextEncoder().encode(value);
    }

    function base64UrlToBytesC(value) {
      var normalized = value.replace(/-/g, "+").replace(/_/g, "/");
      var padded = normalized + "===".slice((normalized.length + 3) % 4);
      var binary = atob(padded);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    }

    function bytesToBase64UrlC(bytes) {
      var binary = "";
      for (var i = 0; i < bytes.length; i += 1) {
        binary += String.fromCharCode(bytes[i]);
      }
      return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }

    async function importSealKey(sealKeyBase64Url, usages) {
      return subtle().importKey("raw", base64UrlToBytesC(sealKeyBase64Url), "AES-GCM", false, usages);
    }

    // Seals a payload into the shared envelope: AES-256-GCM, 12-byte iv,
    // WebCrypto layout (auth tag appended to the ciphertext), base64url fields.
    async function sealToEnvelope(payload, sealKeyBase64Url) {
      var iv = new Uint8Array(12);
      globalThis.crypto.getRandomValues(iv);
      var key = await importSealKey(sealKeyBase64Url, ["encrypt"]);
      var ciphertext = await subtle().encrypt({ name: "AES-GCM", iv: iv }, key, textToBytesC(JSON.stringify(payload)));
      return {
        v: 1,
        alg: "A256GCM",
        iv: bytesToBase64UrlC(iv),
        ct: bytesToBase64UrlC(new Uint8Array(ciphertext))
      };
    }

    async function openEnvelope(envelope, sealKeyBase64Url) {
      if (!envelope || envelope.v !== 1 || envelope.alg !== "A256GCM") {
        throw new Error("Unsupported sealed mailbox payload.");
      }
      var key = await importSealKey(sealKeyBase64Url, ["decrypt"]);
      var plaintext = await subtle().decrypt(
        { name: "AES-GCM", iv: base64UrlToBytesC(envelope.iv) },
        key,
        base64UrlToBytesC(envelope.ct)
      );
      return JSON.parse(new TextDecoder().decode(plaintext));
    }

    // Both mailbox credentials are one-way HMAC-SHA256 derivations from the
    // pairing seal key; the relay can never recover the key from either.
    async function deriveAccess(sealKeyBase64Url) {
      var key = await subtle().importKey(
        "raw",
        base64UrlToBytesC(sealKeyBase64Url),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );
      var token = bytesToBase64UrlC(new Uint8Array(
        await subtle().sign("HMAC", key, textToBytesC(MAILBOX_AUTH_TOKEN_INFO))
      ));
      var scopeDigest = bytesToBase64UrlC(new Uint8Array(
        await subtle().sign("HMAC", key, textToBytesC(MAILBOX_SCOPE_ID_INFO))
      ));
      return {
        token: token,
        scopeId: MAILBOX_SCOPE_ID_PREFIX + scopeDigest.slice(0, MAILBOX_SCOPE_ID_LENGTH)
      };
    }

    globalThis.AccordMailboxCrypto = {
      MAILBOX_AUTH_TOKEN_INFO: MAILBOX_AUTH_TOKEN_INFO,
      MAILBOX_SCOPE_ID_INFO: MAILBOX_SCOPE_ID_INFO,
      MAILBOX_SCOPE_ID_PREFIX: MAILBOX_SCOPE_ID_PREFIX,
      MAILBOX_SCOPE_ID_LENGTH: MAILBOX_SCOPE_ID_LENGTH,
      sealToEnvelope: sealToEnvelope,
      openEnvelope: openEnvelope,
      deriveAccess: deriveAccess
    };
  })();
  // <<< generated: mailbox-crypto

  // Thin adapters over the generated contract keep the app's existing
  // string-based seal/open signatures (shared by the relay socket path).
  async function sealRelayPayload(payload, keyBase64) {
    return JSON.stringify(await globalThis.AccordMailboxCrypto.sealToEnvelope(payload, keyBase64));
  }

  async function openRelayPayload(sealed, keyBase64) {
    return globalThis.AccordMailboxCrypto.openEnvelope(JSON.parse(sealed), keyBase64);
  }

  // The mailbox is locked per pairing: both the mailbox id and the bearer
  // token are one-way HMAC derivations from the pairing seal key (see the
  // generated contract above), so a pasted or scanned link is all the phone
  // needs. The relay never sees the seal key itself.
  let mailboxAccessCache;
  let mailboxAuthRejected = false;

  async function mailboxAccessForPairing(pairing) {
    const sealKey = pairing?.relaySealKeyBase64;
    if (!sealKey || !globalThis.crypto?.subtle) {
      return undefined;
    }
    if (mailboxAccessCache && mailboxAccessCache.sealKey === sealKey) {
      return mailboxAccessCache.value;
    }
    const value = await globalThis.AccordMailboxCrypto.deriveAccess(sealKey);
    mailboxAccessCache = { sealKey, value };
    return value;
  }

  // W5 doorbell subscription: the phone registers its Web Push subscription
  // with its own locked mailbox (bearer-authenticated), including its own
  // event origin so its writes do not ring its own bell. The relay sends
  // empty pushes; iOS requires a user gesture before Notification permission,
  // hence the explicit enable button.
  let pushSubscriptionEnsured = false;
  // W-K: the relay refuses push endpoints outside its allowlist (W-D). That
  // refusal must be said out loud — a phone that silently never rings looks
  // identical to one that is simply quiet, and the user waits forever.
  let pushEndpointRejected = false;
  const PUSH_ENDPOINT_REJECTED_ERROR = "mailbox_push_endpoint_rejected";

  async function ensurePushSubscription() {
    if (pushSubscriptionEnsured) {
      return;
    }
    try {
      if (!("Notification" in globalThis) || Notification.permission !== "granted") {
        return;
      }
      if (!navigator.serviceWorker || !("PushManager" in globalThis)) {
        return;
      }
      const pairing = loadPairing();
      const endpoint = outboxEndpoint();
      if (!pairing?.relaySealKeyBase64 || !endpoint) {
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      // The relay's key before anything is given up: a phone that cannot
      // reach the relay just now (opened offline, on a poor connection) keeps
      // the subscription it has rather than trading it for a replacement it
      // cannot make — which left it with none until the next launch.
      const vapidUrl = new URL("/v1/push/vapid", endpoint);
      const vapidBody = await (await fetch(vapidUrl.toString())).json();
      if (!vapidBody?.publicKey) {
        return;
      }
      // A subscription can stop being delivered without ever being reported
      // gone: the push service keeps accepting rings for it, the phone hears
      // nothing, and from in here the two cases look identical. Nothing
      // available to this page can tell them apart, so the first check of each
      // launch replaces the subscription instead of trusting it. That is one
      // extra round trip when the app opens, against notifications silently
      // stopping until the User notices and says so.
      if (subscription) {
        try {
          await subscription.unsubscribe();
          subscription = undefined;
        } catch {
          // Keeping a subscription that might be dead beats having none.
        }
      }
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToBytes(vapidBody.publicKey)
        });
      }
      const request = await authorizedMailboxRequest(endpoint);
      const url = new URL(request.url);
      url.pathname = "/v1/mailbox/push-subscription";
      url.search = "";
      url.searchParams.set("mailboxId", new URL(request.url).searchParams.get("mailboxId") || "");
      const response = await fetch(url.toString(), {
        method: "POST",
        headers: Object.assign({ "content-type": "application/json" }, request.headers),
        body: JSON.stringify({
          subscription: subscription.toJSON(),
          suppressOriginId: await mobileOriginId(pairing)
        })
      });
      if (response.ok) {
        pushSubscriptionEnsured = true;
        return;
      }
      if (response.status === 400) {
        const body = await response.json().catch(() => ({}));
        if (body && body.error === PUSH_ENDPOINT_REJECTED_ERROR) {
          // Terminal for this browser: the endpoint will not become allowed by
          // trying again, so stop and say so instead of retrying on every open.
          pushEndpointRejected = true;
          pushSubscriptionEnsured = true;
        }
      }
    } catch {
      // Push is an enhancement; the poll path never depends on it.
    }
  }

  // A push subscription can go dead while still looking alive: the push
  // service keeps accepting rings for it and the phone never hears one. From
  // inside the app the only cure is to drop the subscription and ask for a new
  // one, so this is offered wherever alerts are already on.
  let alertsReconnect = "";

  async function reconnectMessageAlerts() {
    const endpoint = outboxEndpoint();
    const pairing = loadPairing();
    if (!endpoint || !pairing?.relaySealKeyBase64) return "failed";
    if (!navigator.serviceWorker || !("PushManager" in globalThis)) return "failed";
    try {
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      if (existing) {
        // An endpoint the relay still holds must stop being rung: unsubscribe
        // first, then register whatever the browser hands back next.
        await existing.unsubscribe();
      }
      pushSubscriptionEnsured = false;
      await ensurePushSubscription();
      return pushSubscriptionEnsured && !pushEndpointRejected ? "ok" : "failed";
    } catch {
      return "failed";
    }
  }

  async function enableMessageAlerts() {
    try {
      if (!("Notification" in globalThis)) {
        return "unsupported";
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        return permission;
      }
      await ensurePushSubscription();
      await render("synced");
      return "granted";
    } catch {
      return "error";
    }
  }

  async function authorizedMailboxRequest(endpoint) {
    const pairing = loadPairing();
    const access = await mailboxAccessForPairing(pairing);
    if (!access) {
      return { url: endpoint, headers: {} };
    }
    // W5 mirror: the push-woken service worker needs exactly these — and only
    // these — to fetch in the background. Merge-write so the shared cursor is
    // never clobbered. The seal key is deliberately absent.
    void writeMailboxAccessMeta({
      endpointUrl: endpoint,
      mailboxId: access.scopeId,
      token: access.token
    });
    const url = new URL(endpoint);
    url.searchParams.set("mailboxId", access.scopeId);
    return { url: url.toString(), headers: { authorization: "Bearer " + access.token } };
  }

  function noteMailboxResponse(response) {
    if (response.ok) {
      mailboxAuthRejected = false;
    }
  }

  // The relay reports two different 401s: "mailbox_unregistered" means the
  // desktop has not finished registering this pairing's mailbox (a quiet
  // waiting state — keep polling), while a refused token means the pairing
  // was revoked and only a fresh link helps. Reads the response body, so
  // callers must not consume it again.
  async function mailboxAuthFailureState(response) {
    if (response.status !== 401) {
      return "other";
    }
    const body = await response.text().catch(function () {
      return "";
    });
    if (body.indexOf("mailbox_unregistered") >= 0) {
      return "unregistered";
    }
    mailboxAuthRejected = true;
    // Revoked means the mirrored background credentials are dead too; destroy
    // them in step with the pairing lifecycle.
    void clearMailboxAccessMeta();
    return "revoked";
  }

  function isSealedMailboxPayload(payload) {
    return Boolean(payload) &&
      typeof payload === "object" &&
      payload.v === 1 &&
      payload.alg === "A256GCM" &&
      typeof payload.iv === "string" &&
      typeof payload.ct === "string";
  }

  async function openMailboxEnvelopePayload(envelope, pairing) {
    const payload = envelope?.payload;
    if (!isSealedMailboxPayload(payload)) {
      return payload;
    }
    if (!pairing?.relaySealKeyBase64) {
      return undefined;
    }
    try {
      return await openRelayPayload(JSON.stringify(payload), pairing.relaySealKeyBase64);
    } catch {
      return undefined;
    }
  }

  function chunkRelayCiphertext(request) {
    const chunkSize = RELAY_FRAME_MAX_BYTES - RELAY_FRAME_OVERHEAD_BYTES;
    const chunks = [];
    for (let start = 0; start < request.ciphertext.length || chunks.length === 0; start += chunkSize) {
      chunks.push(request.ciphertext.slice(start, start + chunkSize));
    }
    return chunks.map(function (chunk, index) {
      return {
        protocol: RELAY_PROTOCOL,
        streamId: request.streamId,
        logicalMessageId: request.logicalMessageId,
        frameId: request.logicalMessageId + ":" + index + ":" + chunks.length,
        frameIndex: index,
        frameCount: chunks.length,
        cursor: request.cursor || undefined,
        // A room can hold more than the desktop. A frame for a machine names
        // it, so the relay hands it to that device and to nobody else.
        to: request.to || undefined,
        ciphertextChunk: chunk
      };
    });
  }

  function reassembleRelayCiphertext(frames) {
    if (frames.length === 0) {
      return { status: "missing" };
    }
    const first = frames[0];
    const chunks = new Map();
    for (const frame of frames) {
      if (frame.protocol !== RELAY_PROTOCOL ||
        frame.streamId !== first.streamId ||
        frame.logicalMessageId !== first.logicalMessageId ||
        frame.frameCount !== first.frameCount) {
        return { status: "conflict", reason: "mixed relay frames" };
      }
      const existing = chunks.get(frame.frameIndex);
      if (existing && existing.ciphertextChunk !== frame.ciphertextChunk) {
        return { status: "conflict", reason: "duplicate frame index with different ciphertext" };
      }
      chunks.set(frame.frameIndex, frame);
    }
    if (chunks.size !== first.frameCount) {
      return { status: "missing" };
    }
    return {
      status: "complete",
      streamId: first.streamId,
      logicalMessageId: first.logicalMessageId,
      ciphertext: Array.from({ length: first.frameCount }, function (_, index) {
        return chunks.get(index).ciphertextChunk;
      }).join("")
    };
  }

  function openDb() {
    // One description of this database, shared with the service worker. They
    // are separate programs over the same storage, and when each carried its
    // own version the two drifted far enough that the worker could no longer
    // open it at all.
    const schema = globalThis.AccordMobileDb;
    if (!schema) return Promise.reject(new Error("The phone's database description did not load."));
    return schema.openControlDb(indexedDB);
  }

  /**
   * One IndexedDB transaction across several stores, for the durable event log.
   * The action and its outgoing record are written inside it, so a failed queue
   * write leaves no event either: an action no peer will ever hear about is
   * worse than one the User can retry.
   */
  function eventLogPort() {
    return {
      runAtomic: function (names, work) {
        return openDb().then(function (db) {
          return new Promise(function (resolve, reject) {
            const tx = db.transaction(names, "readwrite");
            const stores = {};
            names.forEach(function (name) { stores[name] = tx.objectStore(name); });
            let value;
            let failed;
            tx.onerror = function () { reject(failed || tx.error || new Error("Event log transaction failed.")); };
            tx.onabort = function () { reject(failed || tx.error || new Error("Event log transaction aborted.")); };
            tx.oncomplete = function () { resolve(value); db.close(); };
            const handle = {
              get: function (name, key) { return requestToPromise(stores[name].get(key)); },
              getAll: function (name) { return requestToPromise(stores[name].getAll()); },
              put: function (name, entry) { return requestToPromise(stores[name].put(entry)); },
              remove: function (name, key) { return requestToPromise(stores[name].delete(key)); },
              removeWhere: function (name, matches) {
                return new Promise(function (resolve, reject) {
                  const request = stores[name].openCursor();
                  request.onerror = () => reject(request.error);
                  request.onsuccess = function () {
                    const cursor = request.result;
                    if (!cursor) { resolve(); return; }
                    if (matches(cursor.value)) cursor.delete();
                    cursor.continue();
                  };
                });
              }
            };
            Promise.resolve()
              .then(function () { return work(handle); })
              .then(function (result) { value = result; })
              .catch(function (error) { failed = error; try { tx.abort(); } catch (abortError) { reject(error); } });
          });
        });
      }
    };
  }

  let activeEventLog;
  /** This device's durable log. Built once the pairing is known, because the
   *  origin id has to be stable across reloads for its sequence to continue. */
  function eventLog(originId) {
    if (!originId || !self.AccordMobileEventLog) return undefined;
    if (!activeEventLog || activeEventLog.originId !== originId) {
      activeEventLog = {
        originId: originId,
        log: self.AccordMobileEventLog.createMobileEventLog({ port: eventLogPort(), originId: originId })
      };
    }
    return activeEventLog.log;
  }

  function withOutbox(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(OUTBOX_STORE, mode);
        const store = tx.objectStore(OUTBOX_STORE);
        let value;
        tx.onerror = function () {
          reject(tx.error || new Error("Outbox transaction failed."));
        };
        tx.oncomplete = function () {
          resolve(value);
          db.close();
        };
        try {
          value = fn(store);
        } catch (error) {
          tx.abort();
          reject(error);
        }
      });
    });
  }

  function requestToPromise(request) {
    return new Promise(function (resolve, reject) {
      request.onerror = function () {
        reject(request.error || new Error("IndexedDB request failed."));
      };
      request.onsuccess = function () {
        resolve(request.result);
      };
    });
  }

  function noteOutboxStatus(entry) {
    if (entry && typeof entry.eventId === "string") {
      outboxStatusById.set(entry.eventId, { status: entry.status, deliveredVia: entry.deliveredVia });
    }
  }

  function putOutboxEntry(entry) {
    noteOutboxStatus(entry);
    return withOutbox("readwrite", function (store) {
      return requestToPromise(store.put(entry));
    });
  }

  // One chat's rows, as they stand in the store. Every delivered row is
  // deduplicated against the chat it belongs to, and reading that chat back
  // from the database for each of them is what a streaming member costs: a
  // dozen full reads in seven seconds, each one hundreds of milliseconds on a
  // real phone, which is why text arrived in lumps (the User, 2026-09-21).
  // Only this page writes timeline rows -- the push-woken worker stores sealed
  // envelopes and nothing else -- so the rows held here cannot go stale behind
  // this context's back. Anything that writes without maintaining them drops
  // them, which is enforced in withTimeline rather than left to each caller.
  // A few chats at a time, not one: the chat on screen is read for drawing
  // while another member streams into a different chat, and a single slot made
  // those two evict each other on every delivered row.
  const CHAT_ROWS_HELD_LIMIT = 4;
  const chatRowsHeld = new Map();

  function dropCachedChatRows() {
    chatRowsHeld.clear();
  }

  function holdChatRows(conversationId, rows) {
    if (typeof conversationId !== "string" || !conversationId) return rows;
    chatRowsHeld.delete(conversationId);
    chatRowsHeld.set(conversationId, rows);
    while (chatRowsHeld.size > CHAT_ROWS_HELD_LIMIT) {
      chatRowsHeld.delete(chatRowsHeld.keys().next().value);
    }
    return rows;
  }

  function withTimeline(mode, fn, options) {
    // A write that does not keep the held rows in step drops them twice: when
    // it is asked for, and again once it has landed. The first alone was not
    // enough — a write created between the two moments read the chat afresh
    // and held rows this one was about to delete.
    const dropsHeldRows = mode === "readwrite" && !(options && options.maintainsChatRows);
    if (dropsHeldRows) {
      dropCachedChatRows();
    }
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction([TIMELINE_STORE, META_STORE], mode);
        const store = tx.objectStore(TIMELINE_STORE);
        let value;
        tx.onerror = function () {
          reject(tx.error || new Error("Timeline transaction failed."));
        };
        // A transaction that fails still holds its connection open until it
        // is closed here; left to the garbage collector, that connection
        // blocks the next version change the worker asks for.
        tx.onabort = function () {
          reject(tx.error || new Error("Timeline transaction aborted."));
          db.close();
        };
        tx.oncomplete = function () {
          // Activity keeps what it read until the store changes. The write
          // helpers resolve false or 0 when a replayed row changed nothing;
          // anything else counts as a change. Registered on the value before
          // it is handed back, so the count moves before the caller resumes.
          if (mode === "readwrite") {
            Promise.resolve(value).then(function (result) {
              if (result !== false && result !== 0) timelineGeneration += 1;
            }, function () { timelineGeneration += 1; });
          }
          if (dropsHeldRows) {
            dropCachedChatRows();
          }
          resolve(value);
          db.close();
        };
        try {
          value = fn(store, tx.objectStore(META_STORE));
        } catch (error) {
          tx.abort();
          reject(error);
        }
      });
    });
  }

  function isScaffoldingEntry(entry) {
    return Boolean(entry) &&
      entry.role === "participant" &&
      entry.status === "pending" &&
      isPlaceholderTimelineContent(entry.content);
  }

  function sameTimelineEntryContent(left, right) {
    const attachmentIds = function (entry) {
      return Array.isArray(entry.attachments)
        ? entry.attachments.map(function (attachment) { return attachment.id; }).join(",")
        : "";
    };
    return left.content === right.content &&
      left.status === right.status &&
      left.createdAt === right.createdAt &&
      (left.participantLabel || "") === (right.participantLabel || "") &&
      (left.threadRootId || "") === (right.threadRootId || "") &&
      (left.runId || "") === (right.runId || "") &&
      attachmentIds(left) === attachmentIds(right);
  }

  function sameMobileEvent(left, right) {
    return Boolean(left.mobileEventId) &&
      left.mobileEventId === right.mobileEventId &&
      Boolean(left.conversationId) && left.conversationId === right.conversationId;
  }

  // Scaffolding ("@x is running..." / "Running...") says an answer is being
  // written before anyone has been picked. Once the participant's own row
  // exists for the same phone message, that sentence has been replaced by the
  // real thing — it is not a second live row, it is a leftover. User watched a
  // long turn and saw both: an anonymous "Thinking" and, under it, the row
  // carrying the actual text.
  //
  // The rule lives INSIDE the write transaction because the two rows travel
  // different paths and race. Checked outside, the scaffolding's "is there a
  // real row yet?" can run between the real row's own delete and its put, see
  // nothing, and store itself anyway. IndexedDB serialises readwrite
  // transactions on the store, so deciding here cannot interleave.
  // The rows one chat holds, through the store's chat index when the database
  // has it. Every rule below works inside one chat — the key it compares
  // carries the chat id, and a phone message's own row is matched by chat as
  // well — yet the read behind it used to scan the whole store for every
  // delivered row. On a phone with weeks of chats that was seconds of main
  // thread per batch, and a streaming member sends a batch every few seconds:
  // the timeline fell behind and caught up in lumps, and the live text with
  // it (the User, 2026-09-20).
  /** The rows of one chat. The write path may take them from what this page
   *  already holds -- it is the only writer, so they cannot be stale behind its
   *  back -- while a read for drawing always goes to the store, because what is
   *  on screen must not come from memory that a reload would not have. */
  // The key of a row that never exists. A write asks the store for it before
  // taking the rows held for a chat: the answer comes only once every write
  // created before this one has landed, and each of those brought the held
  // rows up to date as it landed. Taken any earlier — at the moment the write
  // was created, as they were at first — the held rows could predate the
  // write in front, and a run's end judged against them missed the live row
  // it had come to end: "Thinking…" stayed above the answer it belonged to
  // whenever the socket's last row and the mailbox's finished one landed
  // together.
  const HELD_ROWS_SYNC_KEY = "\u0000held-rows-sync";

  function timelineRowsForConversation(store, conversationId, options) {
    const mayHold = Boolean(options && options.mayHold) &&
      typeof conversationId === "string" && Boolean(conversationId);
    const remember = function (rows) {
      return mayHold ? holdChatRows(conversationId, rows) : rows;
    };
    const readStore = function () {
      const schema = globalThis.AccordMobileDb;
      const indexName = schema && schema.TIMELINE_CONVERSATION_INDEX;
      if (typeof conversationId === "string" && conversationId && indexName && store.indexNames.contains(indexName)) {
        return requestToPromise(store.index(indexName).getAll(conversationId)).then(remember);
      }
      return requestToPromise(store.getAll()).then(function (rows) {
        return typeof conversationId === "string" && conversationId
          ? rows.filter(function (row) { return row && row.conversationId === conversationId; })
          : rows;
      }).then(remember);
    };
    if (!mayHold) {
      return readStore();
    }
    return requestToPromise(store.get(HELD_ROWS_SYNC_KEY)).then(function () {
      const held = chatRowsHeld.get(conversationId);
      return held ? held : readStore();
    });
  }

  /** Keeps the rows held for a chat in step with a write this function just
   *  made, so the next delivered row does not have to read the chat back. */
  function noteChatRowStored(entry) {
    if (!entry) return;
    const rows = chatRowsHeld.get(entry.conversationId);
    if (!rows) return;
    holdChatRows(entry.conversationId, rows.filter(function (row) {
      return row && row.id !== entry.id;
    }).concat([entry]));
  }

  function noteChatRowsRemoved(conversationId, ids) {
    const rows = chatRowsHeld.get(conversationId);
    if (!rows || ids.length === 0) return;
    holdChatRows(conversationId, rows.filter(function (row) { return row && ids.indexOf(row.id) < 0; }));
  }

  function putTimelineEntryDeduped(entry) {
    const key = timelineEntryDedupeKey(entry);
    // The one write path that keeps the held rows in step instead of dropping
    // them: it is the one a streaming member takes, over and over.
    return withTimeline("readwrite", function (store, meta) {
      // Same transaction as the timeline write: a concurrent deletion cannot
      // land between a separate check and this stale message's insertion.
      return requestToPromise(meta.get("conversation-deleted:" + entry.conversationId)).then(function (deleted) {
        if (deleted) return 0;
        return timelineRowsForConversation(store, entry.conversationId, { mayHold: true }).then(function (entries) {
        const current = entries.find(function (existing) {
          return existing && existing.id === entry.id && existing.conversationId === entry.conversationId &&
            existing.role === "participant" && entry.role === "participant" && existing.runId === entry.runId;
        });
        if (current && entry.status === "pending") {
          // Saved snapshots carry the waiting row; only the live socket carries
          // growing text. Either can arrive last, including after reconnect.
          if (current.status !== "pending") return 0;
          if (isScaffoldingEntry(entry) && !isPlaceholderTimelineContent(current.content)) {
            entry = { ...entry, content: current.content };
          }
          // Live progress does not repeat the snapshot's visual thread metadata.
          entry = { ...entry, createdAt: current.createdAt, threadRootId: entry.threadRootId || current.threadRootId };
        }
        const others = entries.filter(function (existing) {
          return existing && existing.id !== entry.id;
        });
        if (isScaffoldingEntry(entry) && others.some(function (existing) {
          return existing.role === "participant" &&
            !isPlaceholderTimelineContent(existing.content) &&
            sameMobileEvent(entry, existing);
        })) {
          return 0;
        }
        // Resolves true only when the store ends up different from before: a
        // replayed copy of a row already held is not news for anyone.
        const stored = entries.find(function (existing) {
          return existing && existing.id === entry.id && existing.conversationId === entry.conversationId;
        });
        // When this phone got the row in this state, and when it watched the
        // run end, are this phone's knowledge; a later copy of the same row
        // (the snapshot after the terminal, a page read under another id) does
        // not carry them. Taken from the copy being replaced, and stamped only
        // for a row that is new here or has just changed state.
        const prior = stored || (key ? others.find(function (existing) {
          return timelineEntryDedupeKey(existing) === key;
        }) : undefined);
        if (prior && prior.status === entry.status) {
          entry = {
            ...entry,
            ...(prior.receivedAt && !entry.receivedAt ? { receivedAt: prior.receivedAt } : {}),
            ...(prior.settledAt && !entry.settledAt ? { settledAt: prior.settledAt } : {})
          };
        } else if (!entry.receivedAt) {
          entry = { ...entry, receivedAt: nowIso() };
        }
        // A later copy of a row this phone already holds can name less than
        // the first one did: a machine's delta carries no run id, a page read
        // no thread root. What was known stays known, or the row's identity
        // in Activity flips and a cleared update comes back as news.
        if (stored) {
          entry = {
            ...entry,
            ...(stored.runId && !entry.runId ? { runId: stored.runId } : {}),
            ...(stored.messageId && !entry.messageId ? { messageId: stored.messageId } : {}),
            ...(stored.threadRootId && !entry.threadRootId ? { threadRootId: stored.threadRootId } : {}),
            ...(stored.mobileEventId && !entry.mobileEventId ? { mobileEventId: stored.mobileEventId } : {})
          };
        }
        if (stored && sameTimelineEntryContent(stored, entry) &&
          (stored.settledAt || "") === (entry.settledAt || "") &&
          (stored.receivedAt || "") === (entry.receivedAt || "")) {
          return false;
        }
        const removed = others.filter(function (existing) {
          if (key && timelineEntryDedupeKey(existing) === key) {
            return true;
          }
          return !isScaffoldingEntry(entry) &&
            entry.role === "participant" &&
            isScaffoldingEntry(existing) &&
            sameMobileEvent(entry, existing);
        });
        const deletes = removed.map(function (existing) {
          return requestToPromise(store.delete(existing.id));
        });
        return Promise.all(deletes).then(function () {
          return requestToPromise(store.put(entry));
        }).then(function () {
          noteChatRowsRemoved(entry.conversationId, removed.map(function (existing) { return existing.id; }));
          noteChatRowStored(entry);
          return true;
        });
        });
      });
    }, { maintainsChatRows: true });
  }

  // NOTE: an age guard was tried here and reverted. Its intent was right — an
  // old terminal should not delete a newer live row — but the pending row and
  // the answer it becomes do not share an id on every path, so the guard blocked
  // rows from ever being replaced and they piled up on screen. The root cause it
  // was defending against is fixed upstream: the conversation projection no
  // longer lends one run's id to unrelated messages.
  // A terminal carries two keys and they do NOT identify the same row. The run
  // id names the run that produced the answer; a participant answering a
  // phone-sent message fans out under a fresh run id chat.ts invents, while the
  // placeholder the phone is showing was keyed by the ingest run
  // (`mobile-<eventId>`). Requiring BOTH keys to match — which is what this did
  // — meant a phone-started turn never cleared its own row: the answer landed
  // and "Thinking" stayed above it forever, and tapping that corpse opened the
  // stream on whichever older answer shared its mobile event id.
  //
  // Requiring EITHER key is too blunt in the other direction: a live row from a
  // second participant on the same phone message carries the same mobile event
  // id, so the first agent to finish would delete the other's in-progress row —
  // the "Thinking appears for a second and vanishes" regression. So the mobile
  // event id clears scaffolding only. Real in-progress text is never touched by
  // it; only the run id, which is precise, may take a row with content.
  // The ingest run is named after the phone message it carries, so a terminal
  // under that name is the whole message failing rather than one member
  // finishing. Nothing else can say it: when sendMessage throws, no participant
  // ever produced a terminal of its own, and the control service's catch is the
  // only thing that reports the run is over.
  function isPhoneMessageFailure(status, runId, mobileEventId) {
    return status === "error" && Boolean(mobileEventId) && runId === "mobile-" + mobileEventId;
  }

  function deleteTimelineEntry(entryId) {
    return withTimeline("readwrite", function (store) {
      return requestToPromise(store.get(entryId)).then(function (existing) {
        if (!existing) {
          return false;
        }
        return requestToPromise(store.delete(entryId)).then(function () {
          noteChatRowsRemoved(existing.conversationId, [entryId]);
          return true;
        });
      });
    }, { maintainsChatRows: true });
  }

  function deletePendingTimelineEntriesForRun(conversationId, runId, mobileEventId, messageId, status) {
    if (!runId && !mobileEventId && !messageId) {
      return Promise.resolve(0);
    }
    const wholeMessageFailed = isPhoneMessageFailure(status, runId, mobileEventId);
    return withTimeline("readwrite", function (store) {
      return timelineRowsForConversation(store, conversationId, { mayHold: true }).then(function (entries) {
        const deletes = entries.filter(function (entry) {
          if (!entry || entry.status !== "pending") {
            return false;
          }
          // A finished message ends its OWN row. It used to end every pending
          // row of its run, which is wrong for a turn that posts more than one
          // message: an intermediate note posted mid-run deleted the live row
          // the run was still writing, so the turn looked finished while it was
          // still going.
          const matchesMessage = Boolean(messageId) &&
            (entry.messageId === messageId || entry.sourceId === messageId);
          const matchesScaffolding = isPlaceholderTimelineContent(entry.content) &&
            ((Boolean(runId) && entry.runId === runId) ||
              (Boolean(mobileEventId) && entry.mobileEventId === mobileEventId));
          // A live row that never carried a message id of its own can only be
          // this run's current segment, so the run id is the only handle there
          // is. Rows that DO name a message are left to the clause above.
          //
          // This holds because every source that posts more than one message
          // per run also stamps a message id: chat turns build their progress
          // sink with the pending message's id, and scaffolding carries a
          // synthetic one. A future progress source that omits the message id
          // AND posts intermediate messages would bring back the bug where a
          // note deletes the live row beside it — give it a message id.
          const matchesAnonymousRunRow = Boolean(runId) && entry.runId === runId && !entry.messageId;
          // A failed phone message takes every row it started with it. Scoped
          // to the ingest run on purpose: one member erroring while another is
          // still writing carries the same mobile event id, and must not clear
          // the other's live row.
          const matchesFailedPhoneMessage = wholeMessageFailed && entry.mobileEventId === mobileEventId;
          return (matchesMessage || matchesScaffolding || matchesAnonymousRunRow || matchesFailedPhoneMessage) &&
            entry.conversationId === conversationId;
        }).map(function (entry) {
          return { id: entry.id, done: requestToPromise(store.delete(entry.id)) };
        });
        return Promise.all(deletes.map(function (item) { return item.done; })).then(function () {
          noteChatRowsRemoved(conversationId, deletes.map(function (item) { return item.id; }));
          return deletes.length;
        });
      });
    }, { maintainsChatRows: true });
  }

  // A placeholder row ("@x is running..." / "Running...") is pure scaffolding:
  // it announces that an answer is being written. Its run can die without a
  // terminal that carries its keys — an interrupted app, or an answer written
  // before terminals inherited the source's mobile event id — and then nothing
  // ever deletes it. No live run outlives the CLI's own 15-minute kill, so a
  // placeholder half an hour older than an arriving terminal is a corpse, not
  // a run. Only placeholder-sentence rows qualify; real pending text is never
  // touched, which is what the reverted age guard got wrong.
  const PLACEHOLDER_CORPSE_AGE_MS = 30 * 60 * 1000;

  function isPlaceholderTimelineContent(content) {
    const text = (content || "").trim();
    return text === "Running..." || /\bis running\.\.\.$/.test(text);
  }

  function deleteStalePlaceholderTimelineEntries(conversationId, terminalCreatedAt) {
    const terminalTime = Date.parse(terminalCreatedAt || "");
    if (!Number.isFinite(terminalTime)) {
      return Promise.resolve(0);
    }
    return withTimeline("readwrite", function (store) {
      return timelineRowsForConversation(store, conversationId, { mayHold: true }).then(function (entries) {
        const deletes = entries.filter(function (entry) {
          if (!entry || entry.status !== "pending" || !isPlaceholderTimelineContent(entry.content)) {
            return false;
          }
          if (entry.conversationId !== conversationId) {
            return false;
          }
          const created = Date.parse(entry.createdAt || "");
          return Number.isFinite(created) && terminalTime - created > PLACEHOLDER_CORPSE_AGE_MS;
        }).map(function (entry) {
          return { id: entry.id, done: requestToPromise(store.delete(entry.id)) };
        });
        return Promise.all(deletes.map(function (item) { return item.done; })).then(function () {
          noteChatRowsRemoved(conversationId, deletes.map(function (item) { return item.id; }));
          return deletes.length;
        });
      });
    }, { maintainsChatRows: true });
  }



  // Before 2026-09-18-pwa-parity-v1 the desktop's projection sent every
  // system message and the phone stored each as a bubble. Those the desktop
  // never showed ("Auto-resumed @x after member request", tool-approval
  // notes) are dropped once; a system row the User can see (an artifact note)
  // is fetched again with the chat's last page and comes back. Rows the phone
  // itself wrote — machine warnings and errors — are not from the desktop and
  // stay.
  const INTERNAL_SYSTEM_ROWS_DROPPED_KEY = "accordagents.mobile.internalSystemRowsDropped.v1";

  function dropStoredInternalSystemRows() {
    if (localStorage.getItem(INTERNAL_SYSTEM_ROWS_DROPPED_KEY) === "1") {
      return Promise.resolve(0);
    }
    return withTimeline("readwrite", function (store) {
      return requestToPromise(store.getAll()).then(function (entries) {
        const deletes = entries.filter(function (entry) {
          return entry && entry.role === "system" && !String(entry.sourceId || "").startsWith(MACHINE_ROW_ID_PREFIX);
        }).map(function (entry) {
          return requestToPromise(store.delete(entry.id));
        });
        return Promise.all(deletes).then(function () {
          return deletes.length;
        });
      });
    }).then(function (dropped) {
      localStorage.setItem(INTERNAL_SYSTEM_ROWS_DROPPED_KEY, "1");
      return dropped;
    });
  }

  // W1+W5: one (epoch, cursor) pair, shared with the service worker through
  // the IndexedDB meta record, which also mirrors the non-decrypting mailbox
  // credentials a push-woken background fetch needs — endpoint URL, mailbox
  // id, bearer token. The seal key itself never enters IndexedDB; it stays in
  // the pairing, which the service worker cannot read.
  let lastStaleRefillKey = "";

  function withNamedStore(storeName, mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        let value;
        tx.onerror = function () {
          reject(tx.error || new Error(storeName + " transaction failed."));
        };
        tx.oncomplete = function () {
          resolve(value);
          db.close();
        };
        try {
          value = fn(store);
        } catch (error) {
          tx.abort();
          reject(error);
        }
      });
    });
  }

  // This phone as a device of its own: a signing key, the machines it is
  // allowed to command, and the way to reach one of them directly. Without
  // this the phone can only ask the desktop, and a closed desktop means a
  // phone that can do nothing.
  const MACHINE_IDENTITY_META_KEY = "machine-command-identity";
  const MACHINE_ACCESS_META_KEY = "machine-access";

  async function readMetaRecord(key) {
    return withNamedStore(META_STORE, "readonly", function (store) {
      return requestToPromise(store.get(key));
    });
  }

  /**
   * A record this phone cannot lose quietly.
   *
   * This used to swallow its errors. A failed write of the signing identity
   * meant a phone that minted a new key on the next reload, which every
   * machine then refused because the roster names the old one; a failed write
   * of the machine list meant a phone that silently forgot where to send. Both
   * are visible now, and the caller decides.
   */
  async function writeMetaRecord(key, value) {
    const existing = (await readMetaRecord(key)) || {};
    await withNamedStore(META_STORE, "readwrite", function (store) {
      store.put({ ...existing, ...value, key });
    });
  }

  const machineCommandStore = {
    get: (key) => readMetaRecord(key),
    set: (key, value) => writeMetaRecord(key, value)
  };

  let machineIdentityPromise;

  /** The signing identity a machine checks this phone's commands against. */
  function machineCommandIdentity() {
    const api = globalThis.AccordMachineCommand;
    if (!api) return Promise.resolve(undefined);
    machineIdentityPromise ??= api.ensureIdentity(machineCommandStore).catch(function (error) {
      machineIdentityPromise = undefined;
      machineUnavailableReason = String((error && error.message) || error);
      recordRelayDebug({ event: "machine-identity-unavailable", message: machineUnavailableReason });
      return undefined;
    });
    return machineIdentityPromise;
  }

  /**
   * Records where this phone may reach each machine.
   *
   * Only the list of machines is replaced. Everything else under this key --
   * in particular anything the delivery path keeps -- is left alone: learning
   * the machines again is a routine refresh, not a reason to forget what has
   * not been delivered yet.
   */
  async function storeMachineAccess(machines) {
    const list = Array.isArray(machines) ? machines : [];
    await writeMetaRecord(MACHINE_ACCESS_META_KEY, { machines: list });
    await machineChannels().then(function (channels) {
      if (channels) channels.setMachines(list);
    }).catch(function (error) {
      recordRelayDebug({ event: "machine-channels-unavailable", message: String(error && error.message || error) });
    });
    return list;
  }

  async function machineAccessList() {
    const record = await readMetaRecord(MACHINE_ACCESS_META_KEY);
    return (record && record.machines) || [];
  }

  async function machineAccessFor(machineId) {
    const machines = await machineAccessList();
    return machineId ? machines.find((machine) => machine.machineId === machineId) : machines[0];
  }

  /** One IndexedDB transaction over the phone's machine journal. */
  function machineLogPort() {
    return {
      runAtomic: function (names, work) {
        return eventLogPort().runAtomic(names.map(storeName), function (tx) {
          return work({
            get: function (name, key) { return tx.get(storeName(name), key); },
            getAll: function (name) { return tx.getAll(storeName(name)); },
            put: function (name, entry) { return tx.put(storeName(name), entry); },
            remove: function (name, key) { return tx.remove(storeName(name), key); }
          });
        });
      }
    };
    // The journal names its stores logically; this is the one place that
    // knows which physical store each of them is. Idempotent, so a caller that
    // already speaks the physical names is not mapped a second time into the
    // wrong store -- which is exactly what silently sent every event into the
    // meta store, where it has no key at all.
    function storeName(name) {
      if (name === "events" || name === MACHINE_EVENT_STORE) return MACHINE_EVENT_STORE;
      if (name === "outbox" || name === MACHINE_OUTBOX_STORE) return MACHINE_OUTBOX_STORE;
      if (name === MACHINE_BLOB_STORE) return MACHINE_BLOB_STORE;
      return META_STORE;
    }
  }

  /**
   * Bodies too large to travel inside one event.
   *
   * A long reply is sent as fragments and only becomes readable once every one
   * of them has arrived and the whole thing hashes to what the event claims.
   * An incomplete body is not applied and not acknowledged, so the machine
   * keeps it and sends the rest.
   */
  function machineBlobStore(api) {
    function key(reference, index) { return "blob:" + reference.blobHash + ":" + index; }
    return {
      store: function (fragment) {
        if (!fragment || !fragment.reference || typeof fragment.bytesBase64 !== "string") {
          return Promise.reject(new Error("Invalid machine event fragment."));
        }
        return withNamedStore(MACHINE_BLOB_STORE, "readwrite", function (store) {
          store.put({ key: key(fragment.reference, fragment.index), bytesBase64: fragment.bytesBase64 });
        });
      },
      /** A fragment held for sending, in the shape the machine reads. */
      fragment: async function (reference, index) {
        const held = await withNamedStore(MACHINE_BLOB_STORE, "readonly", function (store) {
          return requestToPromise(store.get(key(reference, index)));
        });
        return held ? { reference: reference, index: index, bytesBase64: held.bytesBase64 } : undefined;
      },
      take: async function (reference) {
        const parts = [];
        for (let index = 0; index < reference.fragments; index += 1) {
          const held = await withNamedStore(MACHINE_BLOB_STORE, "readonly", function (store) {
            return requestToPromise(store.get(key(reference, index)));
          });
          if (!held) return undefined;
          parts.push(api.base64ToBytes(held.bytesBase64));
        }
        const total = parts.reduce(function (sum, part) { return sum + part.length; }, 0);
        if (total !== reference.byteLength) return undefined;
        const bytes = new Uint8Array(total);
        let at = 0;
        for (const part of parts) { bytes.set(part, at); at += part.length; }
        if ("sha256:" + await api.sha256Hex(bytes) !== reference.blobHash) return undefined;
        const body = JSON.parse(new TextDecoder().decode(bytes));
        return body;
      }
    };
  }

  let machineChannelsPromise;
  /** Said plainly when this phone cannot reach a machine at all. */
  let machineUnavailableReason;

  /**
   * This phone's connections to the machines it may command.
   *
   * Built once the signing identity exists, because every event it emits and
   * every acknowledgement it makes is signed with that key, and the machine
   * decides what to accept by it.
   */
  function machineChannels() {
    const api = globalThis.AccordMachineCommand;
    const channelApi = globalThis.AccordMachineChannel;
    const logApi = globalThis.AccordMobileEventLog;
    if (!api || !channelApi || !logApi) return Promise.resolve(undefined);
    machineChannelsPromise ??= (async function () {
      const identity = await machineCommandIdentity();
      if (!identity) return undefined;
      const log = logApi.createMobileEventLog({
        port: machineLogPort(),
        originId: identity.deviceId,
        stores: { events: MACHINE_EVENT_STORE, outbox: MACHINE_OUTBOX_STORE, meta: META_STORE, blobs: MACHINE_BLOB_STORE },
        keyId: identity.keyId,
        hashPayload: async function (payload) { return "sha256:" + await api.sha256Hex(api.textBytes(api.stableJson(payload))); },
        hashEvent: async function (unsigned) { return "sha256:" + await api.sha256Hex(api.textBytes(api.stableJson(unsigned))); },
        sign: async function (eventHash) { return api.signEventHash(identity, eventHash); }
      });
      await log.restore();
      const channels = channelApi.createMachineChannels({
        api: api,
        identity: identity,
        log: log,
        blobs: machineBlobStore(api),
        seal: sealRelayPayload,
        open: openRelayPayload,
        chunk: chunkRelayCiphertext,
        reassemble: reassembleRelayCiphertext,
        connect: function (machine) {
          return openRelaySocket(machine.relayUrl, {
            rendezvousId: machine.rendezvousId,
            fingerprint: machine.fingerprint || "",
            routingId: machine.rendezvousId,
            deviceId: identity.deviceId,
            expectDeviceId: machine.deviceId
          });
        },
        apply: applyMachineEvent,
        onAcknowledged: noteMachineDelivered,
        debug: recordRelayDebug
      });
      channels.setMachines(await machineAccessList());
      machineUnavailableReason = undefined;
      return { channels: channels, log: log, identity: identity };
    })().catch(function (error) {
      machineChannelsPromise = undefined;
      machineUnavailableReason = String((error && error.message) || error);
      recordRelayDebug({ event: "machine-channels-unavailable", message: machineUnavailableReason });
      return undefined;
    });
    return machineChannelsPromise.then(function (built) { return built && built.channels; });
  }

  function machineJournal() {
    return machineChannels().then(function () { return machineChannelsPromise; }).then(function (built) { return built; });
  }

  /**
   * What a machine sends back, carried out here.
   *
   * A result is a message in this chat, so it goes through the same projection
   * the desktop's timeline uses -- one shape, one dedupe rule, one render. A
   * kind this build does not show yet is still applied, because refusing it
   * would leave the machine holding it forever; what it must never do is claim
   * to have shown something it did not.
   */
  const deletedMachineConversations = new Set();
  let deletedMachineConversationsLoaded;

  function loadDeletedMachineConversations() {
    if (!deletedMachineConversationsLoaded) {
      deletedMachineConversationsLoaded = withNamedStore(META_STORE, "readonly", store => requestToPromise(store.getAll(IDBKeyRange.bound("conversation-deleted:", "conversation-deleted:\uffff"))))
        .then(records => {
          for (const record of records) {
            if (typeof record.key === "string" && record.key.startsWith("conversation-deleted:")) {
              deletedMachineConversations.add(record.key.slice("conversation-deleted:".length));
            }
          }
        }).catch(error => { deletedMachineConversationsLoaded = undefined; throw error; });
    }
    return deletedMachineConversationsLoaded;
  }

  async function isMachineConversationDeleted(conversationId) {
    if (deletedMachineConversations.has(conversationId)) return true;
    const deleted = await readMetaRecord("conversation-deleted:" + conversationId);
    if (deleted) deletedMachineConversations.add(conversationId);
    return Boolean(deleted);
  }

  async function applyMachineConversationDeletion(conversationId, deletedAt) {
    // Keep the receipt journal/outbox for replay and ACKs; erase only the
    // visible projection together with its permanent resurrection barrier.
    await eventLogPort().runAtomic([META_STORE, TIMELINE_STORE], async tx => {
      const key = "conversation-deleted:" + conversationId;
      if (!await tx.get(META_STORE, key)) await tx.put(META_STORE, { key, conversationId, deletedAt });
      await tx.removeWhere(TIMELINE_STORE, entry => entry.conversationId === conversationId);
    });
    timelineGeneration += 1;
    // Written past withTimeline, so the rows it holds are dropped here.
    dropCachedChatRows();
    deletedMachineConversations.add(conversationId);
    saveChats(loadChats().filter(chat => chat.id !== conversationId));
    const cards = loadControlCards();
    delete cards[conversationId];
    saveControlCards(cards);
    if (selectedConversationId() === conversationId) localStorage.setItem(ACTIVE_CONVERSATION_KEY, "unpaired");
    await render("synced");
  }

  async function applyMachineEvent(event, payload, machine) {
    const body = payload && typeof payload === "object" ? payload : {};
    // What this phone was actually handed, when the QA flag is on. Reading the
    // screen is not proof that a result arrived: the User's own prompt can
    // contain whatever token an answer is being looked for by.
    recordRelayDebug({ event: "machine-event-applying", kind: event.kind, bodyType: body.type,
      messages: Array.isArray(body.messages) ? body.messages.length : undefined, status: body.status });
    const conversationId = event.conversationId;
    if (body.type === "machine.conversation.deleted") {
      if (body.conversationId !== conversationId || typeof body.deletedAt !== "string") throw new Error("Invalid chat deletion identity.");
      await applyMachineConversationDeletion(conversationId, body.deletedAt);
      return "applied";
    }
    if (await isMachineConversationDeleted(conversationId)) return "applied";
    if (body.type === "machine.turn.finished") {
      const stopped = body.status === "interrupted";
      const events = (body.messages || []).map(function (message) {
        return machineTimelineEvent(message, body.status === "failed" ? "error" : "done", body.runId);
      });
      // A stopped run often produced nothing, and only a settled row for this
      // run clears the one that says it is still working. Without this the
      // phone showed "Stopping..." for a member that had already gone.
      if (stopped) {
        events.push({
          id: MACHINE_ROW_ID_PREFIX + "stopped:" + body.runId, messageId: MACHINE_ROW_ID_PREFIX + "stopped:" + body.runId,
          role: "participant", participantLabel: machineRunLabel(body.runId),
          content: events.some(function (event) { return event.hidden !== true; })
            ? "Stopped."
            : machineRunLabel(body.runId) + " was stopped before answering.",
          status: "done", createdAt: body.finishedAt, runId: body.runId
        });
      }
      for (const [index, warning] of (body.warnings || []).entries()) {
        events.push({ id: MACHINE_ROW_ID_PREFIX + "warning:" + body.runId + ":" + index, role: "system", content: warning,
          status: "done", createdAt: body.finishedAt });
      }
      if (body.error) {
        events.push({ id: MACHINE_ROW_ID_PREFIX + "error:" + body.runId, role: "system", content: body.error,
          status: "error", createdAt: body.finishedAt });
      }
      await handleRelayTimelinePayload({ type: "mobile.timeline.events", conversationId: conversationId, events: events },
        conversationId);
      // A member raises a choice by writing one in its own reply, so the
      // question arrives with the answer's own message rather than in a later
      // conversation delta. Looking for it only in deltas meant a choice the
      // member asked at the end of its turn was never shown, and it waited for
      // an answer the User was never offered the chance to give.
      for (const message of body.messages || []) {
        const card = machineChoiceCard(conversationId, message);
        if (card) mergeControlCard(conversationId, card);
      }
      noteMachineRunSettled(body.runId, body.status);
      // The terminal outlives this page: a reload must not resurrect a Stop
      // control for a run the machine has already finished.
      await rememberMachineTerminal(conversationId, body);
      return "applied";
    }
    if (body.type === "machine.turn.started") {
      noteMachineRunStarted(body.runId, machine);
      // The same in-progress row the desktop shows, so a member working on a
      // machine looks like a member working anywhere else.
      await handleRelayTimelinePayload({
        type: "mobile.timeline.events", conversationId: conversationId,
        // Deliberately without a message id of its own. A live row that names
        // one is ended only by a terminal naming the same id, and this row is
        // written before the machine has said what its answer's id will be, so
        // nothing would ever end it: the run showed as still working beside
        // its own finished answer, and offered a Stop for a member that had
        // already gone. Carrying only the run id is the other half of that
        // contract, and it holds because this source posts one live row per
        // run and no intermediate messages.
        events: [{
          id: MACHINE_ROW_ID_PREFIX + "run:" + body.runId, role: "participant",
          participantLabel: machineRunLabel(body.runId), content: machineRunLabel(body.runId) + " is running...",
          status: "pending", createdAt: body.startedAt, runId: body.runId
        }]
      }, conversationId);
      return "applied";
    }
    if (body.type === "machine.turn.progress.delta") {
      // Streamed text, accumulated the way the desktop accumulates it: the
      // frame carries how much of the previous text to keep and what to add.
      const held = machineRunStreams.get(body.runId) || "";
      const retain = body.content && Number.isSafeInteger(body.content.retain) ? body.content.retain : held.length;
      const next = held.slice(0, Math.max(0, Math.min(retain, held.length))) + ((body.content && body.content.append) || "");
      machineRunStreams.set(body.runId, next);
      if (next.trim()) {
        await handleRelayTimelinePayload({
          type: "mobile.timeline.events", conversationId: conversationId,
          events: [{
            id: MACHINE_ROW_ID_PREFIX + "run:" + body.runId, role: "participant",
            participantLabel: machineRunLabel(body.runId), content: next,
            status: "pending", createdAt: new Date().toISOString(), runId: body.runId
          }]
        }, conversationId);
      }
      return "applied";
    }
    if (body.type === "machine.conversation.backdelta") {
      await handleRelayTimelinePayload({
        type: "mobile.timeline.events",
        conversationId: conversationId,
        events: (body.messages || []).map(function (message) { return machineTimelineEvent(message, "done"); })
      }, conversationId);
      // A member on a machine asks the User things as well as answering them.
      // Without this the question existed on the machine and nowhere the User
      // could see it, and the member waited for an answer that could not come.
      for (const message of body.messages || []) {
        const card = machineChoiceCard(conversationId, message);
        if (card) mergeControlCard(conversationId, card);
      }
      await render("synced");
      return "applied";
    }
    if (body.type === "machine.approval.requested" || body.type === "machine.approval.updated") {
      mergeControlCard(conversationId, machineApprovalCard(conversationId, body.approval, machine && machine.name));
      await render("synced");
      return "applied";
    }
    if (body.type === "machine.choice.result") {
      clearCardSent(body.choiceId);
      const card = controlCardsFor(conversationId).find(item => item.id === body.choiceId);
      if (card && body.choice) {
        const selected = (body.choice.options || []).find(option => option.id === body.choice.selectedOptionId);
        mergeControlCard(conversationId, { ...card,
          status: body.choice.status === "pending" ? "pending" : "answered",
          outcome: body.choice.status === "cancelled" ? "Cancelled" : body.choice.customAnswer || selected?.label || "Answered"
        });
      }
      if (!body.ok || body.uncertain) controlCardErrors.set(body.choiceId, body.error || "The machine has not confirmed this answer.");
      else controlCardErrors.delete(body.choiceId);
      await render("synced");
      return "applied";
    }
    if (body.type === "machine.approval.result") {
      noteMachineApprovalResult(body);
      return "applied";
    }
    recordRelayDebug({ event: "machine-event-unshown", kind: event.kind });
    return "applied";
  }

  // A machine hands the phone its messages whole, so the per-message half of
  // the desktop's timeline rule applies here (the desktop applies the whole
  // rule before it projects for the phone): an internal system trigger
  // ("Auto-resumed @x after member request") is not a message the User sees
  // anywhere else. A hidden row still settles its run's pending row; it is
  // simply never stored.
  function machineMessageHiddenOnPhone(message) {
    const shared = globalThis.AccordMobileShared;
    if (!shared || !message || typeof message !== "object") {
      return false;
    }
    return shared.isChatMessageHiddenFromTimeline({
      role: message.role,
      content: typeof message.content === "string" ? message.content : "",
      metadata: message.metadata && typeof message.metadata === "object" ? message.metadata : undefined
    });
  }

  // Rows this phone writes about a machine run, never received from the
  // desktop. The sweep of stored internal rows spares them by this prefix.
  const MACHINE_ROW_ID_PREFIX = "machine-";

  function machineTimelineEvent(message, status, runId) {
    const content = typeof message.content === "string" ? message.content : "";
    return {
      id: message.id,
      messageId: message.id,
      role: message.role === "user" ? "you" : message.role === "system" ? "system" : "participant",
      participantLabel: message.participantHandle || message.participantName,
      content: content,
      status: status,
      createdAt: message.createdAt || nowIso(),
      ...(runId ? { runId: runId } : {}),
      ...(message.threadRootId ? { threadRootId: message.threadRootId } : {}),
      ...(machineMessageHiddenOnPhone(message) ? { hidden: true } : {})
    };
  }

  /** One card in, the rest left alone: replacing the list would erase the
   *  cards this phone already knows about from the desktop or another run. */
  function mergeControlCard(conversationId, card) {
    if (!conversationId || !card || !card.id) return false;
    const cards = controlCardsFor(conversationId).slice();
    const at = cards.findIndex(function (existing) { return existing && existing.id === card.id; });
    if (at >= 0) cards[at] = { ...cards[at], ...card };
    else cards.push(card);
    return storeControlCards(conversationId, cards);
  }

  /**
   * The same card the desktop would show for this approval.
   *
   * Deliberately the same fields as controlCardsFromConversation in
   * src/shared/mobileControlCards.ts, because a member must be answered the
   * same way wherever the User happens to be looking. The phone cannot import
   * that module, so the two are kept in step by the card contract test rather
   * than by hope; a card missing its options is a card with no buttons.
   */
  function machineApprovalCard(conversationId, approval, machineName) {
    return {
      id: approval.id,
      kind: "permission",
      // Learned from the machine itself, not from the desktop: the desktop's
      // chat list cannot vouch for it and must not withdraw it.
      source: "machine",
      conversationId: conversationId,
      title: approval.summary || "Permission request",
      summary: approval.summary || "",
      ...(approval.requesterHandle ? { requesterLabel: "@" + approval.requesterHandle } : {}),
      ...(machineName ? { machineName: machineName } : {}),
      options: [{ id: "allow", label: "Allow" }, { id: "deny", label: "Deny" }],
      allowsCustomAnswer: false,
      allowsCancel: false,
      status: approval.status === "pending" ? "pending" : "answered",
      createdAt: approval.createdAt,
      ...(typeof approval.codexDecisionId === "string" ? { codexDecisionId: approval.codexDecisionId } : {}),
      ...(approval.request ? { draftOverride: approval.request } : {})
    };
  }

  /** The choice a member asked, as the desktop shows it. */
  function machineChoiceCard(conversationId, message) {
    const choice = message.metadata && message.metadata.pendingChoice;
    if (!choice) return undefined;
    const options = choice.options || [];
    const selected = options.find(function (option) { return option.id === choice.selectedOptionId; });
    return {
      id: choice.id,
      kind: "choice",
      source: "machine",
      conversationId: conversationId,
      title: choice.title || "Choice",
      summary: choice.question || "",
      ...(message.participantLabel ? { requesterLabel: message.participantLabel } : {}),
      options: options,
      allowsCustomAnswer: true,
      allowsCancel: true,
      status: choice.status === "pending" ? "pending" : "answered",
      ...(choice.status === "pending" ? {} : {
        outcome: choice.status === "cancelled" ? "Cancelled"
          : (selected && selected.label) || choice.customAnswer || "Answered"
      }),
      createdAt: message.createdAt,
      sourceMessageId: message.id
    };
  }

  /**
   * Asks a machine to run a member's turn, with nothing else in between.
   *
   * The ask is minted into this phone's journal -- its identity, its place in
   * this device's sequence, its hash chain, its signature and its delivery row
   * in one write -- and only then offered to the machine. It stays there until
   * the machine acknowledges it, so a reload, a dead connection or a closed tab
   * in the middle is a delivery that resumes, not a turn the User never got.
   */
  async function commandMachineTurn(request) {
    if (await isMachineConversationDeleted(request.conversationId)) throw new Error("This chat was permanently deleted.");
    const built = await machineJournal();
    const machine = await machineAccessFor(request.machineId);
    if (!built || !machine) throw new Error("This phone cannot reach that machine directly yet.");
    const api = globalThis.AccordMachineCommand;
    const scope = api.deviceEventScope(machine.rendezvousId, request.conversationId, "actions");
    // The machine runs against its own copy of the chat, so the row the turn
    // answers travels with the command rather than being assumed to be there.
    // A long paste is larger than one event carries, so it goes as a body the
    // event names and the fragments beside it -- the same shape a machine uses
    // to send this phone a long answer.
    if (request.message) {
      const body = await built.channels.prepare({
        type: "machine.conversation.delta",
        conversationId: request.conversationId,
        messages: [request.message],
        updatedAt: nowIso()
      });
      try {
        await built.channels.append({
          eventId: "phone-delta-" + request.runId,
          conversationId: request.conversationId,
          logScopeId: scope,
          kind: "machine.conversation.delta",
          recipients: [machine.deviceId],
          payload: body
        });
      } catch (error) {
        // The event was never recorded, so nothing will ever release the body
        // it named. Dropping it here is what keeps a failing write from
        // leaving a fresh copy behind on every retry.
        await built.channels.discard(body);
        throw error;
      }
    }
    const event = await built.log.append({
      eventId: api.machineCommandEventId(request.runId),
      conversationId: request.conversationId,
      logScopeId: scope,
      kind: "machine.turn.request",
      recipients: [machine.deviceId],
      payload: api.turnRequest(request)
    });
    await built.channels.deliver(machine.machineId).catch(function (error) {
      // Held, not lost: the connection retries and the journal still owes it.
      recordRelayDebug({ event: "machine-command-holding", runId: request.runId, message: String(error && error.message || error) });
    });
    return event.eventId;
  }

  /**
   * Asks a machine to stop a run.
   *
   * Recorded and delivered the same way, which is the point: until the machine
   * acknowledges it, the User is told the stop is being delivered. Calling it
   * stopped at the moment of sending would be a claim this phone cannot make.
   */
  async function commandMachineCancel(request) {
    const built = await machineJournal();
    const machine = await machineAccessFor(request.machineId);
    if (!built || !machine) throw new Error("This phone cannot reach that machine directly yet.");
    const api = globalThis.AccordMachineCommand;
    const event = await built.log.append({
      eventId: api.machineCancelEventId(request.runId),
      conversationId: request.conversationId,
      logScopeId: api.deviceEventScope(machine.rendezvousId, request.conversationId, "actions"),
      kind: "machine.turn.cancel",
      recipients: [machine.deviceId],
      payload: api.cancelRequest(request)
    });
    await built.channels.deliver(machine.machineId).catch(function (error) {
      recordRelayDebug({ event: "machine-cancel-holding", runId: request.runId, message: String(error && error.message || error) });
    });
    return event.eventId;
  }

  /**
   * Drives a machine for what the desktop did not take.
   *
   * The desktop is asked first: it owns the chat and does the routing. When it
   * is not there, a member that lives on a machine can still be asked, by this
   * phone, over the machine's own channel. The two are exclusive on purpose --
   * the same message going down both paths would be two runs of the member.
   */
  async function driveMachineForPendingMessages(conversationId) {
    const entries = (await listOutboxEntries()).filter(function (entry) {
      return entry.status !== "acked" && entry.conversationId === conversationId && isMessageOutboxEntry(entry);
    });
    let driven = 0;
    for (const entry of entries) {
      const content = (entry.payload && entry.payload.content) || "";
      const member = machineMemberFor(conversationId, content);
      if (!member) continue;
      const machine = await machineAccessFor(member.homeMachineId);
      if (!machine) {
        machineUnavailableReason = "This phone has not been told how to reach " + member.displayName + "'s machine.";
        continue;
      }
      const runId = "mobile-" + entry.eventId;
      machineRunState.set(runId, { status: "requested", machineId: machine.machineId,
        participantLabel: "@" + member.handle, conversationId: conversationId });
      try {
        await commandMachineTurn({
          machineId: machine.machineId,
          conversationId: conversationId,
          participant: member.participant,
          runId: runId,
          messageId: entry.eventId,
          pendingMessageId: "pending-" + entry.eventId,
          requestedAt: entry.createdAt,
          message: {
            id: entry.eventId,
            role: "user",
            content: content,
            createdAt: entry.createdAt,
            status: "done"
          }
        });
      } catch (error) {
        const message = String((error && error.message) || error);
        recordRelayDebug({ event: "machine-drive-failed", eventId: entry.eventId, message: message });
        machineUnavailableReason = message;
        await putOutboxEntry({ ...entry, lastError: message, updatedAt: nowIso() });
        continue;
      }
      // Handed to the machine, so it does not also go to the desktop: the
      // desktop learns this message from the machine's own copy. It is not
      // called delivered until the machine acknowledges the command.
      await putOutboxEntry({ ...entry, status: "syncing", deliveredVia: "machine", machineId: machine.machineId,
        machineRunId: runId, updatedAt: nowIso() });
      driven += 1;
    }
    return driven;
  }

  /**
   * The machine confirmed it has the ask. Only now is the message delivered.
   *
   * Until this, the entry stays pending and is offered again -- which is what
   * makes a dropped connection a delivery that resumes. Marking it at the
   * moment of sending would both lie to the User and make the phone re-mint an
   * ask the machine already holds.
   */
  async function noteMachineDelivered(receipt) {
    const entries = await listOutboxEntries();
    for (const entry of entries) {
      if (!entry.machineRunId || entry.status === "acked") continue;
      const api = globalThis.AccordMachineCommand;
      if (receipt.eventId !== api.machineCommandEventId(entry.machineRunId)) continue;
      await putOutboxEntry({ ...entry, status: "acked", ack: { ackRole: "machine", eventIds: [receipt.eventId] },
        updatedAt: nowIso(), lastError: undefined });
      await render("synced");
    }
  }

  /** A run this phone asked a machine for, rather than the desktop. */
  async function machineRunForCancel(conversationId, runId) {
    const entries = await listOutboxEntries();
    const entry = entries.find(function (item) { return item.machineRunId === runId; });
    if (entry) return { machineId: entry.machineId, runId: runId };
    const chat = loadChats().find(function (item) { return item.id === conversationId; });
    const members = ((chat && chat.members) || []).filter(function (member) { return member.homeMachineId; });
    return members.length === 1 ? { machineId: members[0].homeMachineId, runId: runId } : undefined;
  }

  /** Answers a card on the machine that raised it, as the same chat action
   *  every device emits, so one answer is one decision wherever it is applied. */
  async function commandMachineAction(conversationId, decision) {
    const built = await machineJournal();
    if (!built) throw new Error("This phone cannot reach a machine directly yet.");
    const roster = built.channels.roster();
    if (!roster.length) throw new Error("This phone has no machine to answer on.");
    const event = await built.log.append({
      eventId: "phone-action:" + decision.payload.operationId,
      conversationId: conversationId,
      logScopeId: "chat:actions",
      kind: decision.kind,
      recipients: roster,
      payload: decision.payload
    });
    await built.channels.deliver().catch(function (error) {
      recordRelayDebug({ event: "machine-action-holding", operationId: decision.payload.operationId,
        message: String(error && error.message || error) });
    });
    return event.eventId;
  }

  const machineRunState = new Map();
  const machineRunStreams = new Map();

  function noteMachineRunStarted(runId, machine) {
    const held = machineRunState.get(runId) || {};
    machineRunState.set(runId, { ...held, status: "running", machineId: machine && machine.machineId });
  }

  const MACHINE_TERMINALS_META_KEY = "machine-run-terminals";

  /**
   * What this phone knows ended, kept across reloads.
   *
   * The timeline rows say what was said; this says the run itself is over. A
   * reload rebuilds the Stop controls from the rows, and a run whose terminal
   * only ever lived in memory would be offered for stopping again.
   */
  async function rememberMachineTerminal(conversationId, body) {
    const record = (await readMetaRecord(MACHINE_TERMINALS_META_KEY)) || {};
    const terminals = record.terminals || {};
    terminals[body.runId] = { status: body.status, conversationId: conversationId, finishedAt: body.finishedAt };
    // Bounded: the newest few hundred are what a live screen can refer to.
    const ids = Object.keys(terminals);
    if (ids.length > 300) {
      ids.sort(function (left, right) {
        return String(terminals[left].finishedAt || "").localeCompare(String(terminals[right].finishedAt || ""));
      });
      for (const id of ids.slice(0, ids.length - 300)) delete terminals[id];
    }
    await writeMetaRecord(MACHINE_TERMINALS_META_KEY, { terminals: terminals });
    for (const runId of Object.keys(terminals)) machineRunState.set(runId, { status: terminals[runId].status });
  }

  function machineRunSettled(runId) {
    const held = runId ? machineRunState.get(runId) : undefined;
    return Boolean(held && held.status && held.status !== "running" && held.status !== "requested");
  }

  /** Reloads what ended, so Stop is not offered for a finished run. */
  async function restoreMachineTerminals() {
    const record = await readMetaRecord(MACHINE_TERMINALS_META_KEY).catch(function () { return undefined; });
    const terminals = (record && record.terminals) || {};
    for (const runId of Object.keys(terminals)) machineRunState.set(runId, { status: terminals[runId].status });
    return Object.keys(terminals).length;
  }

  function noteMachineRunSettled(runId, status) {
    const held = machineRunState.get(runId) || {};
    machineRunState.set(runId, { ...held, status: status || "completed" });
    machineRunStreams.delete(runId);
  }

  /** Who the row belongs to. This phone knows for a run it asked for itself;
   *  for anything else it says nothing rather than naming the wrong member. */
  function machineRunLabel(runId) {
    const held = machineRunState.get(runId);
    return (held && held.participantLabel) || "Agent";
  }

  /**
   * What the machine made of an answer, rather than that it was sent.
   *
   * `ok` false is the owner's own apply error and is shown as one. An
   * uncertain outcome is neither: the card says it is not settled rather than
   * claiming an answer that may not have taken.
   */
  function noteMachineApprovalResult(body) {
    if (!body || !body.approvalId) return;
    if (body.ok === false) {
      clearCardSent(body.approvalId);
      controlCardErrors.set(body.approvalId, body.error || "The machine could not apply this answer.");
      return;
    }
    if (body.uncertain) {
      controlCardErrors.set(body.approvalId, "The machine has not confirmed this answer yet.");
      return;
    }
    controlCardErrors.delete(body.approvalId);
    if (body.approval) mergeControlCard(body.conversationId, machineApprovalCard(body.conversationId, body.approval));
  }

  async function readMailboxAccessMeta() {
    try {
      return await withNamedStore(META_STORE, "readonly", function (store) {
        return requestToPromise(store.get(MAILBOX_ACCESS_META_KEY));
      });
    } catch {
      return undefined;
    }
  }

  async function writeMailboxAccessMeta(patch) {
    try {
      const existing = (await readMailboxAccessMeta()) || {};
      await withNamedStore(META_STORE, "readwrite", function (store) {
        store.put({ ...existing, ...patch, key: MAILBOX_ACCESS_META_KEY });
      });
    } catch {
      // Best effort: a lost mirror only delays background sync, never breaks
      // the foreground path.
    }
  }

  async function clearMailboxAccessMeta() {
    try {
      await withNamedStore(META_STORE, "readwrite", function (store) {
        store.delete(MAILBOX_ACCESS_META_KEY);
      });
    } catch {
      // Best effort.
    }
  }

  async function loadMailboxCursor() {
    const meta = await readMailboxAccessMeta();
    if (meta && (typeof meta.epoch === "string" || Number.isFinite(meta.cursor))) {
      return { epoch: typeof meta.epoch === "string" ? meta.epoch : "", cursor: Number(meta.cursor) || 0 };
    }
    // One-time migration from the short-lived localStorage cursor home.
    try {
      const raw = localStorage.getItem(MAILBOX_CURSOR_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        localStorage.removeItem(MAILBOX_CURSOR_KEY);
        const value = { epoch: typeof parsed.epoch === "string" ? parsed.epoch : "", cursor: Number(parsed.cursor) || 0 };
        await writeMailboxAccessMeta(value);
        return value;
      }
    } catch {
      // Fall through to a fresh cursor.
    }
    return { epoch: "", cursor: 0 };
  }

  async function saveMailboxCursor(epoch, cursor) {
    await writeMailboxAccessMeta({ epoch: epoch, cursor: cursor });
  }

  // Drains what a push-woken service worker stored while the app was closed:
  // still-sealed envelopes, opened here with the pairing key, so the timeline
  // is already caught up the moment the app opens.
  async function drainSealedEnvelopes(pairing) {
    let envelopes;
    try {
      envelopes = await withNamedStore(SEALED_STORE, "readonly", function (store) {
        return requestToPromise(store.getAll());
      });
    } catch {
      return 0;
    }
    if (!Array.isArray(envelopes) || envelopes.length === 0) {
      return 0;
    }
    let stored = 0;
    for (const envelope of envelopes) {
      if (envelope?.kind === "mobile.timeline.events") {
        const payload = await openMailboxEnvelopePayload(envelope, pairing);
        if (payload?.type === "mobile.timeline.events") {
          stored += await handleRelayTimelinePayload(payload, envelope.conversationId, { deferRender: true });
        }
      }
      await withNamedStore(SEALED_STORE, "readwrite", function (store) {
        store.delete(envelope.eventId);
      }).catch(function () {
        return undefined;
      });
    }
    return stored;
  }

  // Once a run has produced its final (done or error) event, replayed copies
  // of its older "running" placeholders must not resurrect. A retry of the
  // same run stays visible because its placeholder is newer than the recorded
  // terminal timestamp.
  let terminalRunMap;

  function terminalRuns() {
    if (!terminalRunMap) {
      terminalRunMap = new Map();
      for (const pair of loadStoredStringArray(TERMINAL_RUNS_KEY)) {
        const split = pair.indexOf("\u0000");
        if (split > 0) {
          terminalRunMap.set(pair.slice(0, split), pair.slice(split + 1));
        }
      }
    }
    return terminalRunMap;
  }

  function terminalRunKeys(runId, mobileEventId) {
    const keys = [];
    if (typeof runId === "string" && runId.trim()) {
      keys.push("run\u0000" + runId.trim());
    }
    if (typeof mobileEventId === "string" && mobileEventId.trim()) {
      keys.push("mobile\u0000" + mobileEventId.trim());
    }
    return keys;
  }

  function rememberTerminalRun(runId, mobileEventId, terminalCreatedAt) {
    const runs = terminalRuns();
    let changed = false;
    for (const key of terminalRunKeys(runId, mobileEventId)) {
      const existing = runs.get(key);
      if (existing === undefined || existing < terminalCreatedAt) {
        runs.set(key, terminalCreatedAt);
        changed = true;
      }
    }
    if (changed) {
      saveStoredStringArray(TERMINAL_RUNS_KEY, Array.from(runs.entries()).slice(-TERMINAL_RUNS_MAX).map(function (entry) {
        return entry[0] + "\u0000" + entry[1];
      }));
    }
  }

  function isSupersededPendingEvent(runId, mobileEventId, createdAt) {
    const runs = terminalRuns();
    return terminalRunKeys(runId, mobileEventId).some(function (key) {
      const terminalAt = runs.get(key);
      return terminalAt !== undefined && createdAt <= terminalAt;
    });
  }

  function loadStoredStringArray(key) {
    try {
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter(function (value) {
        return typeof value === "string";
      }) : [];
    } catch {
      return [];
    }
  }

  function saveStoredStringArray(key, values) {
    try {
      localStorage.setItem(key, JSON.stringify(values));
    } catch {
      // Bookkeeping is best-effort; ingest stays idempotent without it.
    }
  }

  function listTimelineEntries(conversationId) {
    return withTimeline("readonly", function (store) {
      return timelineRowsForConversation(store, conversationId);
    }).then(function (entries) {
      return entries.filter(function (entry) {
        // Older rows without an owner stay on disk, but cannot be attributed
        // to every chat. Only the desktop/machine can state their ownership.
        return !conversationId || entry.conversationId === conversationId;
      }).sort(function (left, right) {
        return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
      });
    });
  }

  function timelineEntryDedupeKey(entry) {
    if (!entry || entry.role === "you") {
      return "";
    }
    const conversationId = typeof entry.conversationId === "string" ? entry.conversationId.trim() : "";
    const mobileEventId = typeof entry.mobileEventId === "string" ? entry.mobileEventId.trim() : "";
    const messageId = typeof entry.messageId === "string" ? entry.messageId.trim() : "";
    const sourceId = typeof entry.sourceId === "string" ? entry.sourceId.trim() : "";
    const runId = typeof entry.runId === "string" ? entry.runId.trim() : "";
    const content = typeof entry.content === "string" ? entry.content.trim() : "";
    if (!content) {
      return "";
    }
    const participant = typeof entry.participantLabel === "string" && entry.participantLabel.trim()
      ? entry.participantLabel.trim().toLowerCase()
      : entry.role === "system" ? "system" : "participant";
    const status = entry.status === "error" ? "error" : entry.status === "done" ? "done" : "pending";
    if (mobileEventId) {
      return [conversationId, "mobile", mobileEventId, participant, status, content].join("\0");
    }
    if (messageId || sourceId) {
      return [conversationId, "message", messageId || sourceId, participant, status, content].join("\0");
    }
    if (!runId) {
      return "";
    }
    return [conversationId, "run", runId, participant, status, content].join("\0");
  }

  function dedupeTimelineEntries(entries) {
    const output = [];
    const indexByKey = new Map();
    for (const entry of entries) {
      const key = timelineEntryDedupeKey(entry);
      if (!key) {
        output.push(entry);
        continue;
      }
      const existingIndex = indexByKey.get(key);
      if (existingIndex === undefined) {
        indexByKey.set(key, output.length);
        output.push(entry);
        continue;
      }
      output[existingIndex] = preferTimelineEntry(output[existingIndex], entry);
    }
    return output;
  }

  // One render key means one row on screen — that is the whole point of the
  // key. The store can hold two records that collapse to it for a moment: a
  // live row and the finished answer differ in status and content, so they are
  // separate records until reconciliation removes the first. Rendering both
  // mounted two nodes under one key, and the newest text won on one of them
  // while the other kept whatever it had.
  function dedupeRenderRowsByKey(rows) {
    const output = [];
    const indexByKey = new Map();
    for (const row of rows) {
      const key = row.rowKey || row.id;
      const existingIndex = indexByKey.get(key);
      if (existingIndex === undefined) {
        indexByKey.set(key, output.length);
        output.push(row);
        continue;
      }
      output[existingIndex] = preferTimelineEntry(output[existingIndex], row);
    }
    return output;
  }

  function preferTimelineEntry(left, right) {
    const leftTime = Date.parse(left.createdAt);
    const rightTime = Date.parse(right.createdAt);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
      return rightTime >= leftTime ? right : left;
    }
    return right.createdAt >= left.createdAt ? right : left;
  }

  function timelineRenderRowKey(entry) {
    if (!entry) {
      return "";
    }
    const conversationId = typeof entry.conversationId === "string" ? entry.conversationId.trim() : "";
    const participant = typeof entry.participantLabel === "string" && entry.participantLabel.trim()
      ? entry.participantLabel.trim().toLowerCase()
      : entry.role === "system" ? "system" : "participant";
    const mobileEventId = typeof entry.mobileEventId === "string" ? entry.mobileEventId.trim() : "";
    // Scaffolding has no message of its own — it stands for the phone message
    // until a real row exists — so the phone message is its identity. Anything
    // else is keyed by its own message: one turn can post several (an
    // intermediate note while the run carries on, then the answer), and keying
    // those by the phone message collapsed them into one row, so the note ate
    // the live row and the turn looked finished while it was still writing.
    if (mobileEventId && isScaffoldingEntry(entry)) {
      return ["timeline-mobile", conversationId, mobileEventId, participant].join("\0");
    }
    const messageId = typeof entry.messageId === "string" ? entry.messageId.trim() : "";
    const sourceId = typeof entry.sourceId === "string" ? entry.sourceId.trim() : "";
    if (messageId || sourceId) {
      return ["timeline-message", conversationId, messageId || sourceId, participant].join("\0");
    }
    const runId = typeof entry.runId === "string" ? entry.runId.trim() : "";
    if (runId) {
      return ["timeline-run", conversationId, runId, participant].join("\0");
    }
    return "timeline-entry\0" + String(entry.id || "");
  }

  function listOutboxEntries(conversationId) {
    return withOutbox("readonly", function (store) {
      return requestToPromise(store.getAll());
    }).then(function (entries) {
      for (const entry of entries) noteOutboxStatus(entry);
      return entries.filter(function (entry) {
        return !conversationId || entry.conversationId === conversationId;
      }).sort(function (left, right) {
        return left.createdAt.localeCompare(right.createdAt) || left.eventId.localeCompare(right.eventId);
      });
    });
  }

  // The list is read for every avatar painted and every row reconciled;
  // parsing a hundred chats with their member records each time was tens of
  // megabytes of JSON per list rebuild on the User's phone. The parse is kept
  // until the list is saved again here, or changed by another window of this
  // origin (the storage event); the objects are never mutated by readers.
  let cachedChatList;

  function forgetCachedChatList() {
    cachedChatList = undefined;
  }

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("storage", function (event) {
      if (!event || event.key === null || event.key === CHAT_LIST_KEY) {
        forgetCachedChatList();
      }
    });
  }

  function loadChats() {
    try {
      if (!cachedChatList) {
        const raw = localStorage.getItem(CHAT_LIST_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        cachedChatList = Array.isArray(parsed) ? parsed : [];
      }
      return cachedChatList.filter(chat => !deletedMachineConversations.has(chat.id));
    } catch {
      return [];
    }
  }

  function saveChats(chats) {
    if (Array.isArray(chats) && chats.length > 0) {
      sessionStorage.removeItem(SYNC_WAIT_KEY);
    }
    const previousById = new Map(loadChats().map(function (chat) {
      return [chat.id, chat];
    }));
    const normalized = Array.isArray(chats) ? chats.filter(function (chat) {
      return chat && typeof chat.id === "string" && chat.id.trim();
    }).map(function (chat) {
      return {
        id: chat.id,
        title: typeof chat.title === "string" && chat.title.trim() ? chat.title : "Chat",
        group: typeof chat.group === "string" && chat.group.trim() ? chat.group : "AccordAgents",
        snippet: typeof chat.snippet === "string" && chat.snippet.trim() ? chat.snippet : "No messages yet",
        who: typeof chat.who === "string" ? chat.who : undefined,
        updatedAt: typeof chat.updatedAt === "string" ? chat.updatedAt : nowIso(),
        running: chat.running === true,
        participants: Array.isArray(chat.participants) ? chat.participants.filter(function (item) {
          return typeof item === "string" && item.trim();
        }).slice(0, 4) : [],
        members: Array.isArray(chat.members) ? chat.members.map(normalizeMobileMember).filter(Boolean) : []
      };
    }) : [];
    localStorage.setItem(CHAT_LIST_KEY, JSON.stringify(normalized));
    forgetCachedChatList();
    // Same rule as the desktop sidebar: a chat that moved while it was not the
    // one on screen is unread. The list this phone held before is the "seen"
    // baseline, so the first list after an update marks nothing.
    const activeId = selectedConversationId();
    const viewingActive = Boolean(activeId) && !document.hidden;
    const newlyActive = normalized.filter(function (chat) {
      const previous = previousById.get(chat.id);
      return Boolean(previous) &&
        chat.updatedAt > previous.updatedAt &&
        !(viewingActive && chat.id === activeId);
    }).map(function (chat) {
      return chat.id;
    });
    if (newlyActive.length > 0) {
      markConversationsUnread(newlyActive);
    }
    void mirrorChatTitlesForWorker(normalized);
    return normalized;
  }

  function loadUnreadConversationIds() {
    return loadStoredStringArray(UNREAD_KEY);
  }

  function markConversationsUnread(conversationIds) {
    const current = loadUnreadConversationIds();
    const next = current.slice();
    for (const conversationId of conversationIds) {
      if (conversationId && next.indexOf(conversationId) < 0) {
        next.push(conversationId);
      }
    }
    if (next.length === current.length) {
      return;
    }
    saveStoredStringArray(UNREAD_KEY, next);
    void syncUnreadWithWorker(next);
  }

  function markConversationRead(conversationId) {
    const current = loadUnreadConversationIds();
    if (current.indexOf(conversationId) < 0) {
      return;
    }
    const next = current.filter(function (item) {
      return item !== conversationId;
    });
    saveStoredStringArray(UNREAD_KEY, next);
    void syncUnreadWithWorker(next);
  }

  function loadViewedAt() {
    try {
      const parsed = JSON.parse(localStorage.getItem(VIEWED_AT_KEY) || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  /** Records that the chat was looked at now, on this phone's clock: Activity
   *  compares it with when rows reached this phone, never with a desktop
   *  stamp, so a desktop clock running ahead cannot mark news as seen. Every
   *  render of the open chat lands here, so the answer the User just watched
   *  finish is always behind the mark. */
  function markConversationViewed(conversationId, newestReceivedAt) {
    if (!conversationId) return;
    const all = loadViewedAt();
    const stored = Date.parse(all[conversationId] || "");
    const newest = Date.parse(newestReceivedAt || "");
    // A mark already past the newest row this phone holds for the chat says
    // all it needs to; rewriting it on every redraw of a streaming chat made
    // Activity rebuild its lists on each one.
    if (Number.isFinite(stored) && (!Number.isFinite(newest) || stored >= newest)) return;
    const next = nowIso();
    if (Number.isFinite(stored) && stored >= Date.parse(next)) return;
    all[conversationId] = next;
    try {
      localStorage.setItem(VIEWED_AT_KEY, JSON.stringify(all));
    } catch {
      // Losing this only makes an update look unseen a little longer.
    }
  }

  // The number on the icon is the number of chats with something new, the
  // same thing the dots in the list add up to. The IndexedDB copy is what a
  // push-woken service worker adds to and shows while the page is closed.
  async function syncUnreadWithWorker(ids) {
    await writeMetaRecord(UNREAD_META_KEY, { ids: ids }).catch(function () { return undefined; });
    applyAppBadge(ids.length);
  }

  function applyAppBadge(count) {
    if (!("setAppBadge" in navigator)) {
      return;
    }
    const apply = count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge();
    Promise.resolve(apply).catch(function () { return undefined; });
  }

  // The worker cannot read localStorage, and the chat list lives there; the
  // titles it needs for a notification are mirrored, nothing else.
  async function mirrorChatTitlesForWorker(chats) {
    const titles = {};
    for (const chat of chats) {
      titles[chat.id] = chat.title;
    }
    await writeMetaRecord(CHAT_TITLES_META_KEY, { titles: titles }).catch(function () { return undefined; });
  }

  // Reconciles the unread set with what a push-woken worker added while the
  // page was closed, then puts the icon number back in step.
  async function adoptWorkerUnread() {
    const record = await readMetaRecord(UNREAD_META_KEY).catch(function () { return undefined; });
    const workerIds = record && Array.isArray(record.ids) ? record.ids.filter(function (id) {
      return typeof id === "string" && id.trim();
    }) : [];
    // The chat on screen is being read only while the page is visible; a
    // push counted for it behind a locked screen is still news.
    const activeId = selectedConversationId();
    const viewingActive = Boolean(activeId) && !document.hidden;
    const merged = loadUnreadConversationIds();
    for (const id of workerIds) {
      if (merged.indexOf(id) < 0 && !(viewingActive && id === activeId)) {
        merged.push(id);
      }
    }
    saveStoredStringArray(UNREAD_KEY, merged);
    await syncUnreadWithWorker(merged);
  }

  function loadTimelinePages() {
    try {
      const raw = localStorage.getItem(TIMELINE_PAGES_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function timelinePageFor(conversationId) {
    const page = loadTimelinePages()[conversationId];
    return page && typeof page === "object" ? page : undefined;
  }

  // Where "earlier" continues from. An answer to a request for the page before
  // a message always moves it back. The latest page — asked on every open,
  // every pull and every return to the foreground — must not move it forward
  // past history this phone already holds: each of those reset it to the page
  // below the latest one, so the next taps re-fetched rows already on screen
  // and showed nothing.
  async function adoptTimelinePage(conversationId, payload) {
    const page = payload.page;
    const existing = timelinePageFor(conversationId);
    if (page.earlier !== true && existing && existing.beforeMessageId &&
      existing.beforeMessageId !== page.beforeMessageId &&
      await holdsHistoryBefore(conversationId, payload.events)) {
      return;
    }
    saveTimelinePage(conversationId, page);
  }

  async function holdsHistoryBefore(conversationId, events) {
    const pageTimes = (Array.isArray(events) ? events : []).map(function (event) {
      return Date.parse((event && event.createdAt) || "");
    }).filter(Number.isFinite);
    if (pageTimes.length === 0) {
      return false;
    }
    const pageOldest = Math.min.apply(null, pageTimes);
    const entries = await listTimelineEntries(conversationId).catch(function () { return []; });
    return entries.some(function (entry) {
      const time = Date.parse((entry && entry.createdAt) || "");
      return Number.isFinite(time) && time < pageOldest;
    });
  }

  function saveTimelinePage(conversationId, page) {
    const pages = loadTimelinePages();
    pages[conversationId] = {
      hasMoreBefore: page.hasMoreBefore === true,
      beforeMessageId: typeof page.beforeMessageId === "string" && page.beforeMessageId.trim()
        ? page.beforeMessageId
        : undefined
    };
    localStorage.setItem(TIMELINE_PAGES_KEY, JSON.stringify(pages));
  }

  function normalizeMobileMember(value) {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const handle = typeof value.handle === "string" ? value.handle.trim().replace(/^@/, "") : "";
    if (!handle) {
      return undefined;
    }
    return {
      id: typeof value.id === "string" && value.id.trim() ? value.id : handle,
      handle,
      mentionHandle: typeof value.mentionHandle === "string" && value.mentionHandle.trim()
        ? value.mentionHandle.trim().replace(/^@/, "")
        : handle,
      displayName: typeof value.displayName === "string" && value.displayName.trim()
        ? value.displayName.trim()
        : "@" + handle,
      roleLabel: typeof value.roleLabel === "string" ? value.roleLabel.trim() : "",
      kind: typeof value.kind === "string" ? value.kind : "",
      avatarId: typeof value.avatarId === "string" ? value.avatarId : undefined,
      isAssistant: value.isAssistant === true,
      // Where this member actually runs, and what that machine needs to run
      // it. Present only for members that live on a machine.
      homeMachineId: typeof value.homeMachineId === "string" ? value.homeMachineId : undefined,
      homeMachineName: typeof value.homeMachineName === "string" && value.homeMachineName.trim()
        ? value.homeMachineName.trim()
        : undefined,
      participant: value.participant && typeof value.participant === "object" ? value.participant : undefined
    };
  }

  /** The member a message is addressed to, when that member lives on a
   *  machine this phone can reach itself. */
  function machineMemberFor(conversationId, content) {
    const chat = loadChats().find(function (item) { return item.id === conversationId; });
    const members = (chat && chat.members) || [];
    const mentioned = String(content || "").match(/(?:^|\s)@([A-Za-z0-9_-]+)/g) || [];
    const handles = mentioned.map(function (raw) { return raw.trim().replace(/^@/, "").toLowerCase(); });
    const candidates = members.filter(function (member) { return member.homeMachineId && member.participant; });
    if (!candidates.length) return undefined;
    if (!handles.length) return candidates.length === 1 ? candidates[0] : undefined;
    return candidates.find(function (member) {
      return handles.indexOf(member.handle.toLowerCase()) >= 0 || handles.indexOf(member.mentionHandle.toLowerCase()) >= 0;
    });
  }

  function activeMentionQuery(value) {
    const match = String(value || "").match(/(?:^|\s)@([A-Za-z0-9_-]*)$/);
    return match ? match[1] : undefined;
  }

  function mentionOptions(value, members) {
    const query = activeMentionQuery(value);
    if (query === undefined) {
      return [];
    }
    const normalizedQuery = query.toLowerCase();
    return (Array.isArray(members) ? members : []).filter(function (member) {
      return member.handle.toLowerCase().includes(normalizedQuery) ||
        member.displayName.toLowerCase().includes(normalizedQuery);
    });
  }

  function replaceActiveMention(value, handle) {
    const source = String(value || "");
    const match = source.match(/(?:^|\s)@([A-Za-z0-9_-]*)$/);
    if (!match || match.index === undefined) {
      return source + (source.endsWith(" ") || !source ? "" : " ") + "@" + handle + " ";
    }
    const prefix = source.slice(0, match.index);
    const leadingSpace = match[0].startsWith(" ") ? " " : "";
    return prefix + leadingSpace + "@" + handle + " ";
  }

  function mentionShortcutEdit(value, selectionStart, selectionEnd) {
    const source = String(value || "");
    const rawStart = Number.isFinite(selectionStart) ? selectionStart : source.length;
    const rawEnd = Number.isFinite(selectionEnd) ? selectionEnd : rawStart;
    const start = Math.max(0, Math.min(source.length, Math.min(rawStart, rawEnd)));
    const end = Math.max(start, Math.min(source.length, Math.max(rawStart, rawEnd)));
    const before = source.slice(0, start);
    const trigger = before && !/\s$/.test(before) ? " @" : "@";
    return {
      value: before + trigger + source.slice(end),
      caret: before.length + trigger.length
    };
  }

  function replaceMentionAtCaret(value, handle, caret) {
    const source = String(value || "");
    const position = Number.isFinite(caret)
      ? Math.max(0, Math.min(source.length, caret))
      : source.length;
    const replacedBefore = replaceActiveMention(source.slice(0, position), handle);
    const after = source.slice(position);
    const suffix = replacedBefore.endsWith(" ") && after.startsWith(" ")
      ? after.slice(1)
      : after;
    return {
      value: replacedBefore + suffix,
      caret: replacedBefore.length
    };
  }

  function selectedConversationMembers() {
    return conversationMembers(selectedConversationId());
  }

  function conversationMembers(conversationId) {
    const chat = loadChats().find(function (item) {
      return item.id === conversationId;
    });
    return chat ? chatMembers(chat) : [];
  }

  function chatMembers(chat) {
    if (Array.isArray(chat.members) && chat.members.length > 0) {
      return chat.members;
    }
    return (chat.participants || []).map(function (handle) {
      return normalizeMobileMember({ handle });
    }).filter(Boolean);
  }

  function loadPairing() {
    try {
      const raw = localStorage.getItem(PAIRING_KEY);
      return raw ? JSON.parse(raw) : undefined;
    } catch {
      return undefined;
    }
  }

  function savePairing(pairing) {
    localStorage.setItem(PAIRING_KEY, JSON.stringify(pairing));
    if (pairing.conversationId) {
      localStorage.setItem(ACTIVE_CONVERSATION_KEY, pairing.conversationId);
    }
    return pairing;
  }

  // W-G(a): once a pairing from the URL persists, the credentials leave the
  // address bar — a URL surviving in history, screenshots or share sheets
  // must not be able to pair anyone else. Non-credential params (the qa
  // debug flag) survive, and the app never re-reads credentials from
  // location after boot. Pasted-link pairing passes a synthetic location, so
  // the address bar is credential-free there and this is a no-op.
  const CREDENTIAL_URL_PARAMS = ["rid", "rendezvousId", "route", "routingId", "cap", "fingerprint", "relay", "endpoint", "mailbox", "mailboxUrl", "outbox", "outboxUrl", "conversationId", "relaySealKey"];

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

  function savePairingFromUrl(pairing) {
    const saved = savePairing(pairing);
    scrubCredentialsFromLocation();
    return saved;
  }

  function readBootstrapFromLocation(locationValue) {
    const url = new URL(locationValue.href);
    const fragment = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
    const compactKey = fragment.get("k") || fragment.get("relaySealKey");
    const compactRendezvousId = url.searchParams.get("rid") || url.searchParams.get("rendezvousId");
    const compactRoutingId = url.searchParams.get("route") || url.searchParams.get("routingId");
    const compactFingerprint = url.searchParams.get("cap") || url.searchParams.get("fingerprint");
    if (compactKey && compactRendezvousId && compactRoutingId && compactFingerprint) {
      return savePairingFromUrl({
        endpoint: url.searchParams.get("relay") || DEFAULT_MANAGED_RELAY_URL,
        relayUrl: url.searchParams.get("relay") || DEFAULT_MANAGED_RELAY_URL,
        mailboxUrl: url.searchParams.get("mailbox") || undefined,
        outboxUrl: url.searchParams.get("outbox") || undefined,
        conversationId: url.searchParams.get("conversationId") || undefined,
        routingId: compactRoutingId,
        rendezvousId: compactRendezvousId,
        relaySealKeyBase64: compactKey,
        fingerprint: compactFingerprint,
        pairedAt: nowIso()
      });
    }
    const pairingPayload = fragment.get("pairing");
    if (pairingPayload) {
      const pairing = JSON.parse(base64UrlToText(pairingPayload));
      return savePairingFromUrl({
        endpoint: pairing.relayUrl || DEFAULT_MANAGED_RELAY_URL,
        relayUrl: pairing.relayUrl || DEFAULT_MANAGED_RELAY_URL,
        mailboxUrl: pairing.mailboxUrl || undefined,
        outboxUrl: pairing.outboxUrl || undefined,
        conversationId: pairing.capabilities?.find(function (capability) {
          return capability.scope === "conversation";
        })?.conversationId || undefined,
        routingId: pairing.stableRoutingId || undefined,
        rendezvousId: pairing.rendezvousId || undefined,
        relaySealKeyBase64: pairing.relaySealKeyBase64 || undefined,
        fingerprint: pairing.fingerprint || undefined,
        pairedAt: nowIso()
      });
    }
    const endpoint = url.searchParams.get("endpoint") || url.searchParams.get("relay");
    const outboxUrl = url.searchParams.get("outboxUrl");
    const conversationId = url.searchParams.get("conversationId");
    const routingId = url.searchParams.get("routingId");
    const rendezvousId = url.searchParams.get("rendezvousId");
    // W-G(b): the seal key is accepted from the URL fragment only. A query
    // string reaches server logs, referrers and browser sync; the fragment
    // never leaves the device. The app never issued query-key links, so
    // nothing breaks.
    const relaySealKeyBase64 = fragment.get("relaySealKey") || fragment.get("k");
    const fingerprint = url.searchParams.get("fingerprint");
    if (!endpoint && !outboxUrl && !conversationId && !routingId && !rendezvousId) {
      return loadPairing();
    }
    return savePairingFromUrl({
      endpoint: endpoint || DEFAULT_MANAGED_RELAY_URL,
      relayUrl: endpoint || DEFAULT_MANAGED_RELAY_URL,
      outboxUrl: outboxUrl || undefined,
      conversationId: conversationId || undefined,
      routingId: routingId || undefined,
      rendezvousId: rendezvousId || undefined,
      relaySealKeyBase64: relaySealKeyBase64 || undefined,
      fingerprint: fingerprint || undefined,
      pairedAt: nowIso()
    });
  }

  function activeConversationId(inputConversationId) {
    return inputConversationId ||
      localStorage.getItem(ACTIVE_CONVERSATION_KEY) ||
      loadPairing()?.conversationId ||
      "unpaired";
  }

  function selectedConversationId() {
    const active = localStorage.getItem(ACTIVE_CONVERSATION_KEY) || loadPairing()?.conversationId;
    return active && active !== "unpaired" && !deletedMachineConversations.has(active) ? active : undefined;
  }

  async function createOutboxEvent(input) {
    const pairing = loadPairing();
    const eventId = input.eventId || createEventId();
    const createdAt = input.createdAt || nowIso();
    const conversationId = activeConversationId(input.conversationId);
    if (await isMachineConversationDeleted(conversationId)) throw new Error("This chat was permanently deleted.");
    const logScopeId = input.logScopeId || conversationId;
    const originId = await mobileOriginId(pairing);
    const originSeq = await nextOriginSeq(originId, logScopeId);
    const kind = input.kind || "message.created";
    const payload = input.payload || {
      content: input.content,
      ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {})
    };
    const payloadHash = "sha256:" + await sha256Hex(stableJson(payload));
    const prevHash = await previousEventHash(originId, logScopeId);
    const keyId = "mobile:" + originId;
    const logicalTs = [
      String(originSeq).padStart(16, "0"),
      originId,
      logScopeId
    ].join(":");
    const unsignedEvent = {
      eventId,
      conversationId,
      logScopeId,
      originId,
      originSeq,
      logicalTs,
      kind,
      payloadHash,
      prevHash: prevHash || null,
      keyId,
      createdAt
    };
    const eventHash = "sha256:" + await sha256Hex(stableJson(unsignedEvent));
    return {
      eventId,
      conversationId,
      logScopeId,
      originId,
      originSeq,
      logicalTs,
      kind,
      payload,
      payloadHash,
      ...(prevHash ? { prevHash } : {}),
      keyId,
      createdAt,
      eventHash,
      status: "queued",
      attempts: 0,
      updatedAt: createdAt,
      ack: undefined,
      lastError: undefined
    };
  }

  // Pictures chosen on the phone, waiting for the next send. Same limits the
  // desktop composer enforces, checked here so the refusal is visible where the
  // picture was chosen rather than deep in the relay.
  const MOBILE_UPLOAD_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];
  const MOBILE_UPLOAD_MAX_IMAGES = 5;
  const MOBILE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
  const MOBILE_UPLOAD_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
  // The models downscale anything above this before looking, so sending more
  // costs the same tokens and only burns relay bandwidth and phone storage.
  const MOBILE_UPLOAD_MAX_EDGE = 2576;
  // A guard on what we are willing to decode at all, before any resizing. A
  // compressed byte count is a poor proxy for decoded memory — a 12 MB JPEG can
  // still be tens of megapixels — so this is deliberately conservative.
  const MOBILE_UPLOAD_MAX_SOURCE_BYTES = 12 * 1024 * 1024;
  let pendingAttachments = [];

  function readFileAsBase64(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onerror = function () {
        reject(new Error("read-failed"));
      };
      reader.onload = function () {
        const result = String(reader.result || "");
        const comma = result.indexOf(",");
        resolve(comma >= 0 ? result.slice(comma + 1) : "");
      };
      reader.readAsDataURL(file);
    });
  }

  // JPEG is lossy and has no transparency, so only a JPEG stays a JPEG. PNG and
  // WebP both become PNG: lossless, alpha preserved, and encodable on every
  // engine that runs this app.
  function preparedImageMimeType(sourceMimeType) {
    return sourceMimeType === "image/jpeg" ? "image/jpeg" : "image/png";
  }

  function preparedImageFilename(filename, mimeType) {
    const base = String(filename || "image").replace(/\.[A-Za-z0-9]+$/, "");
    return base + (mimeType === "image/jpeg" ? ".jpg" : ".png");
  }

  async function decodeOrientedImage(file) {
    // createImageBitmap with imageOrientation is the direct route, but it is not
    // everywhere: older WebKit either lacks the function or ignores the option.
    // Falling through to an <img>, which honours EXIF on its own, keeps a phone
    // that cannot do the first route from losing the picture entirely.
    if (typeof createImageBitmap === "function") {
      try {
        return await createImageBitmap(file, { imageOrientation: "from-image" });
      } catch {
        // fall through
      }
    }
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      if (typeof image.decode === "function") {
        await image.decode();
      } else {
        await new Promise(function (resolve, reject) {
          image.onload = resolve;
          image.onerror = reject;
        });
      }
      return image;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function preparePickedImage(file) {
    // Orientation is baked into the pixels here. Models do not read image
    // metadata at all, so a photo taken sideways reaches them sideways — which
    // is exactly what happened to the first picture sent from the phone.
    const source = await decodeOrientedImage(file);
    try {
      const sourceWidth = source.width || source.naturalWidth;
      const sourceHeight = source.height || source.naturalHeight;
      if (!sourceWidth || !sourceHeight) {
        throw new Error("decode-failed");
      }
      const scale = Math.min(1, MOBILE_UPLOAD_MAX_EDGE / Math.max(sourceWidth, sourceHeight));
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(source, 0, 0, width, height);
      const mimeType = preparedImageMimeType(file.type);
      const blob = await new Promise(function (resolve) {
        canvas.toBlob(resolve, mimeType, 0.9);
      });
      if (!blob) {
        throw new Error("encode-failed");
      }
      return {
        mimeType,
        filename: preparedImageFilename(file.name, mimeType),
        dataBase64: await readFileAsBase64(blob),
        width,
        height
      };
    } finally {
      if (source && typeof source.close === "function") {
        source.close();
      }
    }
  }

  async function addPendingAttachments(files) {
    const rejected = [];
    for (const file of Array.from(files || [])) {
      if (pendingAttachments.length >= MOBILE_UPLOAD_MAX_IMAGES) {
        rejected.push(file.name + " — too many pictures");
        continue;
      }
      if (MOBILE_UPLOAD_MIME_TYPES.indexOf(file.type) < 0) {
        rejected.push(file.name + " — not a PNG, JPEG or WebP");
        continue;
      }
      if (file.size > MOBILE_UPLOAD_MAX_SOURCE_BYTES) {
        rejected.push(file.name + " — too large to open");
        continue;
      }
      try {
        // Resize first: the limits below apply to what actually travels, so a
        // 12 MP photo is accepted rather than refused for a size it will not
        // have by the time it is sent.
        const prepared = await preparePickedImage(file);
        const bytes = Math.floor((prepared.dataBase64.length * 3) / 4);
        if (!prepared.dataBase64 || bytes <= 0) {
          rejected.push(file.name + " — could not be read");
          continue;
        }
        if (bytes > MOBILE_UPLOAD_MAX_BYTES) {
          rejected.push(file.name + " — larger than 4 MB");
          continue;
        }
        // Five 4 MB pictures would be a 27 MB base64 payload in IndexedDB and
        // one relay frame. The batch is bounded as well as each picture.
        const pendingBytes = pendingAttachments.reduce(function (total, item) {
          return total + Math.floor((item.dataBase64.length * 3) / 4);
        }, 0);
        if (pendingBytes + bytes > MOBILE_UPLOAD_MAX_TOTAL_BYTES) {
          rejected.push(file.name + " — over the 8 MB total");
          continue;
        }
        pendingAttachments.push({
          id: createEventId(),
          filename: prepared.filename,
          mimeType: prepared.mimeType,
          dataBase64: prepared.dataBase64
        });
      } catch {
        rejected.push(file.name + " — could not be read");
      }
    }
    return rejected;
  }

  function renderPendingAttachments() {
    const strip = document.getElementById("composer-attachments");
    if (!strip) {
      return;
    }
    strip.textContent = "";
    // A picture waiting to be sent keeps the composer open, the same as text.
    const form = document.getElementById("composer-form");
    if (form) {
      const input = document.getElementById("composer-input");
      const open = pendingAttachments.length > 0 ||
        (input && (document.activeElement === input || Boolean(input.value.trim())));
      form.dataset.expanded = open ? "1" : "";
    }
    if (pendingAttachments.length === 0) {
      strip.hidden = true;
      return;
    }
    strip.hidden = false;
    for (const attachment of pendingAttachments) {
      const chip = document.createElement("div");
      chip.className = "composer-attachment-chip";
      const thumb = document.createElement("img");
      thumb.className = "composer-attachment-thumb";
      thumb.alt = attachment.filename;
      thumb.src = "data:" + attachment.mimeType + ";base64," + attachment.dataBase64;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "composer-attachment-remove";
      remove.setAttribute("aria-label", "Remove " + attachment.filename);
      remove.textContent = "×";
      remove.addEventListener("click", function () {
        pendingAttachments = pendingAttachments.filter(function (item) {
          return item.id !== attachment.id;
        });
        renderPendingAttachments();
      });
      chip.append(thumb, remove);
      strip.append(chip);
    }
  }

  function takePendingAttachments() {
    const taken = pendingAttachments.map(function (attachment) {
      return {
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        dataBase64: attachment.dataBase64
      };
    });
    pendingAttachments = [];
    renderPendingAttachments();
    return taken;
  }

  /**
   * Records what this device did and queues it for delivery in ONE IndexedDB
   * transaction. A failed queue write leaves no event either: an action nobody
   * will ever hear about is worse than one the User can retry.
   */
  function persistOutboundEvent(entry) {
    return eventLogPort().runAtomic([EVENT_STORE, OUTBOX_STORE], function (tx) {
      return tx.get(EVENT_STORE, entry.eventId).then(function (existing) {
        if (existing) return entry;
        return tx.put(EVENT_STORE, {
          eventId: entry.eventId,
          conversationId: entry.conversationId,
          logScopeId: entry.logScopeId,
          originId: entry.originId,
          originSeq: entry.originSeq,
          logicalTs: entry.logicalTs,
          kind: entry.kind,
          payload: entry.payload,
          payloadHash: entry.payloadHash,
          eventHash: entry.eventHash,
          createdAt: entry.createdAt,
          acknowledgedBy: []
        }).then(function () {
          return tx.put(OUTBOX_STORE, entry);
        }).then(function () { noteOutboxStatus(entry); return entry; });
      });
    });
  }

  function enqueueMessage(input) {
    return createOutboxEvent(input).then(persistOutboundEvent);
  }

  function enqueueRunCancel(input) {
    return createOutboxEvent({
      conversationId: input.conversationId,
      kind: "run.cancel.requested",
      payload: { runId: input.runId }
    }).then(persistOutboundEvent);
  }

  function isMessageOutboxEntry(entry) {
    return !entry.kind || entry.kind === "message.created";
  }

  // How many times the desktop may answer "not taken" before the entry is
  // set aside for good: offered for ever, it would lock the card it carries.
  const OUTBOX_REFUSAL_LIMIT = 5;

  /** Whether a queue entry is still the desktop's to take: not acknowledged,
   *  not replaced by a later answer to the same card, not refused for good,
   *  and not handed to a member's own machine, which acknowledges its own. */
  function desktopOwesEntry(entry) {
    return Boolean(entry) && entry.status !== "acked" && entry.status !== "superseded" &&
      entry.status !== "refused" && entry.deliveredVia !== "machine";
  }

  /** Runs the User has asked to stop, from the tap onward. The queue entry is
   *  written asynchronously, and a render in that gap used to put the Stop
   *  control back as if nothing had been asked -- which is both a lie and a
   *  second Stop the User can send by accident. */
  const stopRequestedRunIds = new Set();

  async function stopRunFromPhone(runId, forConversationId) {
    // Activity stops a run in a chat that is not open, so it names the chat.
    const conversationId = forConversationId || selectedConversationId();
    if (!conversationId || typeof runId !== "string" || !runId.trim()) {
      return;
    }
    stopRequestedRunIds.add(runId.trim());
    await render("waiting-to-sync");
    await enqueueRunCancel({ conversationId, runId: runId.trim() });
    await render("waiting-to-sync");
    const flushResult = await flushOutbox();
    if (desktopDidNotTake(flushResult.status)) {
      // A stop this phone could not hand over is held, not done. The row keeps
      // saying "Stopping" until the machine acknowledges the cancel; calling
      // it stopped here would be a claim about a member still running.
      const target = await machineRunForCancel(conversationId, runId.trim());
      if (target && target.machineId) {
        await commandMachineCancel({ machineId: target.machineId, conversationId: conversationId, runId: target.runId })
          .catch(function (error) {
            recordRelayDebug({ event: "machine-cancel-failed", runId: target.runId, message: String(error && error.message || error) });
          });
      }
    }
    await pollMailboxTimeline().catch(function () {
      return 0;
    });
    await render(flushResult.status);
  }

  async function mobileOriginId(pairing) {
    const source = [
      pairing?.routingId,
      pairing?.rendezvousId,
      pairing?.fingerprint,
      "mobile"
    ].filter(Boolean).join(":");
    return "mobile-" + (await sha256Hex(source)).slice(0, 32);
  }

  /** Every event this device has emitted, from the durable store. The queue is
   *  emptied when things are delivered, so deriving the sequence from it would
   *  restart at 1 and fork this origin's log. */
  function listEmittedEvents() {
    return eventLogPort().runAtomic([EVENT_STORE], function (tx) {
      return tx.getAll(EVENT_STORE);
    }).catch(function () { return []; });
  }

  async function nextOriginSeq(originId, logScopeId) {
    const entries = await listEmittedEvents();
    return entries.filter(function (entry) {
      return entry.originId === originId && entry.logScopeId === logScopeId && Number.isSafeInteger(entry.originSeq);
    }).reduce(function (max, entry) {
      return Math.max(max, entry.originSeq);
    }, 0) + 1;
  }

  async function previousEventHash(originId, logScopeId) {
    const entries = await listEmittedEvents();
    const previous = entries.filter(function (entry) {
      return entry.originId === originId && entry.logScopeId === logScopeId && typeof entry.eventHash === "string";
    }).sort(function (left, right) {
      return left.originSeq - right.originSeq || left.eventId.localeCompare(right.eventId);
    }).pop();
    return previous?.eventHash;
  }

  function mailboxEventForAppend(entry) {
    return {
      eventId: entry.eventId,
      conversationId: entry.conversationId,
      logScopeId: entry.logScopeId,
      originId: entry.originId,
      originSeq: entry.originSeq,
      logicalTs: entry.logicalTs,
      kind: entry.kind,
      payload: entry.payload,
      payloadHash: entry.payloadHash,
      eventHash: entry.eventHash,
      ...(entry.prevHash ? { prevHash: entry.prevHash } : {}),
      ...(entry.signature ? { signature: entry.signature } : {}),
      ...(entry.keyId ? { keyId: entry.keyId } : {}),
      createdAt: entry.createdAt
    };
  }

  function outboxEndpoint(endpoint) {
    const pairing = loadPairing();
    if (pairing?.outboxUrl) {
      return pairing.outboxUrl;
    }
    const base = endpoint || pairing?.endpoint;
    if (!base) {
      return undefined;
    }
    const url = new URL("/v1/mailbox/events", base);
    if (url.protocol === "wss:") {
      url.protocol = "https:";
    } else if (url.protocol === "ws:") {
      url.protocol = "http:";
    }
    if (pairing?.routingId && !url.searchParams.has("mailboxId")) {
      url.searchParams.set("mailboxId", pairing.routingId);
    }
    return url.toString();
  }

  function relayEndpoint() {
    const pairing = loadPairing();
    return pairing?.relayUrl || pairing?.endpoint;
  }

  function relayCanSync(pairing) {
    return Boolean(
      pairing?.relaySealKeyBase64 &&
        pairing?.rendezvousId &&
        pairing?.routingId &&
        pairing?.fingerprint &&
        relayEndpoint()
    );
  }

  async function flushOutboxViaRelay(entries, pairing) {
    const relayUrl = relayEndpoint();
    if (!relayUrl || !relayCanSync(pairing)) {
      return { status: "waiting-for-desktop", sent: 0, pending: entries.filter((entry) => entry.status !== "acked").length };
    }
    const pendingEntries = entries.filter(desktopOwesEntry);
    if (pendingEntries.length === 0) {
      return { status: "synced", sent: 0, pending: 0 };
    }
    const socket = await getRelaySocket(relayUrl, pairing);
    ensureRelayTimelineCollector(socket, pairing);
    let sent = 0;
    let refused = 0;
    for (const entry of pendingEntries) {
      const syncing = {
        ...entry,
        status: "syncing",
        attempts: entry.attempts + 1,
        updatedAt: nowIso()
      };
      await putOutboxEntry(syncing);
      const sealed = await sealRelayPayload({
        type: "mobile.outbox.events",
        events: [syncing]
      }, pairing.relaySealKeyBase64);
      const ack = await sendRelayRequest(socket, pairing, {
        logicalMessageId: entry.eventId,
        ciphertext: sealed
      });
      const openedAck = await openRelayPayload(ack.ciphertext, pairing.relaySealKeyBase64);
      const ackedEventIds = Array.isArray(openedAck?.eventIds) ? openedAck.eventIds : [openedAck?.eventId];
      if (!ackedEventIds.includes(entry.eventId)) {
        // The desktop answered and left this one out: it could not take it.
        // Every chat's queue goes through here now, so one refused entry
        // must not stand in front of the rest; it is kept, said to be
        // waiting, and offered again later — a few times, then set aside,
        // so the card it carries is not locked behind it for ever.
        refused += 1;
        const refusals = (Number(entry.refusals) || 0) + 1;
        await putOutboxEntry({
          ...syncing,
          status: refusals >= OUTBOX_REFUSAL_LIMIT ? "refused" : "waiting-to-sync",
          refusals: refusals,
          updatedAt: nowIso(),
          lastError: "The desktop did not take this."
        });
        continue;
      }
      await putOutboxEntry({
        ...syncing,
        status: "acked",
        ack: {
          ackRole: openedAck.ackRole || "desktop",
          eventIds: ackedEventIds
        },
        updatedAt: nowIso(),
        lastError: undefined
      });
      sent += 1;
    }
    return { status: "synced", sent, pending: refused };
  }

  async function getRelaySocket(relayUrl, pairing) {
    const key = relaySocketKey(relayUrl, pairing);
    if (activeRelaySocket && activeRelaySocketKey === key && activeRelaySocket.readyState === 1) {
      return activeRelaySocket;
    }
    if (activeRelaySocketPromise && activeRelaySocketKey === key) {
      return activeRelaySocketPromise;
    }
    if (activeRelaySocket && activeRelaySocket.readyState < 2) {
      activeRelaySocket.close(1000, "mobile relay socket replaced");
    }
    activeRelaySocketKey = key;
    const opening = openRelaySocket(relayUrl, pairing).then(function (socket) {
      // Dropped or replaced while this open was in flight — the foreground
      // resync closing a frozen socket and dialling again, a re-pairing — so
      // this socket must not become the live one beside the replacement: the
      // relay seats one phone, and the collector would be left on the loser.
      // Close it and answer with whatever is current instead.
      if (activeRelaySocketPromise !== opening) {
        if (socket.readyState < 2) {
          socket.close(1000, "mobile relay socket superseded");
        }
        if (activeRelaySocketKey !== key) {
          throw new Error("Relay socket replaced by another pairing.");
        }
        return getRelaySocket(relayUrl, pairing);
      }
      activeRelaySocket = socket;
      liveRelayReconnectDelayMs = LIVE_RELAY_RECONNECT_MIN_MS;
      socket.addEventListener("close", function () {
        if (activeRelaySocket === socket) {
          activeRelaySocket = undefined;
          activeRelaySocketPromise = undefined;
          activeRelayTimelineCollectorSocket = undefined;
          // The reply on screen stops moving the moment this socket is gone;
          // dial again now rather than on the next keep-alive tick.
          scheduleLiveRelayReconnect();
        }
      }, { once: true });
      return socket;
    }).catch(function (error) {
      if (activeRelaySocketPromise !== opening) {
        // Superseded while opening — typically the relay dismissed it the
        // moment the replacement was seated. Its failure is not the
        // replacement's: whoever waited on this open continues on the
        // current socket instead of failing a request the User will see.
        if (activeRelaySocketKey !== key) {
          throw error;
        }
        return getRelaySocket(relayUrl, pairing);
      }
      activeRelaySocket = undefined;
      activeRelaySocketPromise = undefined;
      activeRelayTimelineCollectorSocket = undefined;
      throw error;
    });
    activeRelaySocketPromise = opening;
    return opening;
  }

  function relaySocketKey(relayUrl, pairing) {
    return [
      relayUrl,
      pairing.rendezvousId,
      pairing.routingId,
      pairing.fingerprint
    ].join("\0");
  }

  function ensureRelayTimelineCollector(socket, pairing) {
    if (activeRelayTimelineCollectorSocket === socket) {
      return;
    }
    activeRelayTimelineCollectorSocket = socket;
    collectRelayTimeline(socket, pairing).catch(function () {
      if (socket.readyState < 2) {
        socket.close(1000, "mobile timeline collector stopped");
      }
    }).finally(function () {
      if (activeRelayTimelineCollectorSocket === socket) {
        activeRelayTimelineCollectorSocket = undefined;
      }
    });
  }

  function openRelaySocket(relayUrl, pairing) {
    if (typeof globalThis.WebSocket !== "function") {
      return Promise.reject(new Error("Relay sync requires WebSocket."));
    }
    const url = new URL(relayUrl);
    url.searchParams.set("rid", pairing.rendezvousId);
    url.searchParams.set("role", "phone");
    url.searchParams.set("cap", pairing.fingerprint);
    // A phone that does not name itself is seated under the role name, and a
    // frame addressed to this device is then delivered to nobody. That is fine
    // for the two-party desktop pairing, and wrong for a machine's room, where
    // everything is addressed.
    if (pairing.deviceId) url.searchParams.set("did", pairing.deviceId);
    return new Promise(function (resolve, reject) {
      const socket = new globalThis.WebSocket(url.toString());
      // The relay forwards frames as binary, and a browser WebSocket hands
      // binary back as a Blob by default — which every parse site below turned
      // into the string "[object Blob]" and dropped. That silently discarded
      // EVERY live frame: the streaming text the desktop publishes arrived and
      // was thrown away. arraybuffer gives us bytes we can decode in place.
      socket.binaryType = "arraybuffer";
      recordRelayDebug({ event: "construct", url: url.toString() });
      let settled = false;
      const timer = setTimeout(function () {
        recordRelayDebug({ event: "connect-timeout", readyState: socket.readyState });
        socket.close(1000, "relay connect timeout");
        cleanup();
        reject(new Error("Relay tunnel reconnecting."));
      }, RELAY_ACK_TIMEOUT_MS);
      function cleanup() {
        clearTimeout(timer);
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
      }
      function resolveReady(reason) {
        if (settled) {
          return;
        }
        settled = true;
        recordRelayDebug({ event: "ready", reason, readyState: socket.readyState });
        cleanup();
        resolve(socket);
      }
      function onMessage(event) {
        let parsed;
        try {
          parsed = JSON.parse(relayFrameText(event.data));
        } catch {
          return;
        }
        recordRelayDebug({
          event: "control-message",
          type: parsed?.type,
          peerConnected: parsed?.peerConnected,
          role: parsed?.role
        });
        // Waiting for a particular device: a machine's arrival is not
        // announced to phones, so its presence is read from the room roster
        // and a room without it fails now and is retried, rather than hanging
        // until the connect timeout.
        if (pairing.expectDeviceId) {
          if (parsed?.type === "relay.ready") {
            const present = (parsed.peers || []).some(function (peer) { return peer && peer.deviceId === pairing.expectDeviceId; });
            if (present) resolveReady("expected-device-present");
            else {
              cleanup();
              socket.close(1000, "expected device is not in the room");
              reject(new Error("That machine is not connected right now."));
            }
            return;
          }
          if (parsed?.type === "relay.peer-connected" && parsed.deviceId === pairing.expectDeviceId) {
            resolveReady("expected-device-connected");
            return;
          }
        }
        if (parsed?.type === "relay.ready" && parsed.peerConnected === true) {
          resolveReady("peer-connected-at-ready");
        } else if (parsed?.type === "relay.peer-connected") {
          resolveReady("peer-connected");
        } else if (parsed?.type === "relay.error") {
          cleanup();
          reject(new Error("Relay tunnel unavailable: " + (parsed.code || "relay error") + "."));
        }
      }
      function onOpen() {
        recordRelayDebug({ event: "open", readyState: socket.readyState });
      }
      function onError() {
        cleanup();
        recordRelayDebug({ event: "connect-error", readyState: socket.readyState });
        reject(new Error("Relay tunnel unavailable."));
      }
      function onClose(event) {
        cleanup();
        recordRelayDebug({ event: "connect-close", code: event.code, reason: event.reason, readyState: socket.readyState });
        reject(new Error("Relay tunnel reconnecting."));
      }
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("message", onMessage);
      socket.addEventListener("error", onError, { once: true });
      socket.addEventListener("close", onClose, { once: true });
    });
  }

  function sendRelayRequest(socket, pairing, request) {
    const streamId = pairing.routingId + ":phone";
    const frames = chunkRelayCiphertext({
      streamId,
      logicalMessageId: request.logicalMessageId,
      ciphertext: request.ciphertext,
      to: request.to
    });
    const buffer = new Map();
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        recordRelayDebug({ event: "ack-timeout", logicalMessageId: request.logicalMessageId, readyState: socket.readyState });
        cleanup();
        reject(new Error("Relay ack timeout."));
      }, RELAY_ACK_TIMEOUT_MS);
      function cleanup() {
        clearTimeout(timer);
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("close", onClose);
        socket.removeEventListener("error", onError);
      }
      function onMessage(event) {
        let parsed;
        try {
          parsed = JSON.parse(relayFrameText(event.data));
        } catch {
          recordRelayDebug({ event: "message-parse-error", data: relayFrameText(event.data).slice(0, 240) });
          return;
        }
        recordRelayDebug({
          event: "message",
          protocol: parsed?.protocol,
          streamId: parsed?.streamId,
          logicalMessageId: parsed?.logicalMessageId,
          type: parsed?.type
        });
        if (parsed?.type === "relay.error") {
          cleanup();
          reject(new Error("Relay tunnel unavailable: " + (parsed.code || "relay error") + "."));
          return;
        }
        if (parsed?.protocol !== RELAY_PROTOCOL) {
          return;
        }
        const key = parsed.streamId + "\0" + parsed.logicalMessageId;
        const collected = [...(buffer.get(key) || []), parsed];
        buffer.set(key, collected);
        const result = reassembleRelayCiphertext(collected);
        if (result.status === "complete") {
          if (!isRelayReplyForRequest(request.logicalMessageId, result.logicalMessageId)) {
            buffer.delete(key);
            recordRelayDebug({
              event: "message-ignored",
              logicalMessageId: result.logicalMessageId,
              waitingFor: request.logicalMessageId
            });
            return;
          }
          recordRelayDebug({ event: "ack-complete", logicalMessageId: result.logicalMessageId });
          cleanup();
          resolve(result);
        } else if (result.status === "conflict") {
          recordRelayDebug({ event: "ack-conflict", reason: result.reason });
          cleanup();
          reject(new Error("Relay frame conflict: " + result.reason));
        }
      }
      function onClose(event) {
        recordRelayDebug({ event: "ack-close", code: event.code, reason: event.reason, readyState: socket.readyState });
        cleanup();
        reject(new Error("Relay tunnel reconnecting."));
      }
      function onError() {
        recordRelayDebug({ event: "ack-error", readyState: socket.readyState });
        cleanup();
        reject(new Error("Relay tunnel unavailable."));
      }
      socket.addEventListener("message", onMessage);
      socket.addEventListener("close", onClose);
      socket.addEventListener("error", onError);
      for (const frame of frames) {
        recordRelayDebug({ event: "send", logicalMessageId: frame.logicalMessageId, frameIndex: frame.frameIndex, frameCount: frame.frameCount });
        socket.send(JSON.stringify(frame));
      }
    });
  }

  function isRelayReplyForRequest(requestLogicalMessageId, responseLogicalMessageId) {
    return responseLogicalMessageId === requestLogicalMessageId ||
      responseLogicalMessageId.startsWith(requestLogicalMessageId + ":");
  }

  // W-M: the phone only ever opened a relay socket to *send* something, so a
  // reader sitting in a chat had no live channel at all — the desktop's
  // streaming publications had nowhere to land, which is why tapping the
  // in-progress row showed nothing. While a conversation is open, hold the
  // socket and keep the timeline collector attached so live text arrives as it
  // is written. Idempotent: getRelaySocket reuses the open one.
  // The live socket is what carries a member's text as it is written. When it
  // drops — the relay seated a newer connection, the network blinked, the
  // collector's idle close — the keep-alive was the only thing that dialled
  // again, up to a minute later, and the reply on screen stood still until
  // then: streaming that worked one time and not the next (the User,
  // 2026-09-20). Dial again promptly, backing off while the relay stays away.
  const LIVE_RELAY_RECONNECT_MIN_MS = 1_500;
  const LIVE_RELAY_RECONNECT_MAX_MS = 30_000;
  let liveRelayReconnectDelayMs = LIVE_RELAY_RECONNECT_MIN_MS;
  let liveRelayReconnectTimer;

  function scheduleLiveRelayReconnect() {
    if (liveRelayReconnectTimer || !selectedConversationId() || document.hidden) return;
    const delay = liveRelayReconnectDelayMs;
    liveRelayReconnectDelayMs = Math.min(LIVE_RELAY_RECONNECT_MAX_MS, liveRelayReconnectDelayMs * 2);
    liveRelayReconnectTimer = setTimeout(function () {
      liveRelayReconnectTimer = undefined;
      ensureLiveRelayForOpenConversation();
    }, delay);
  }

  function ensureLiveRelayForOpenConversation() {
    const pairing = loadPairing();
    const relayUrl = relayEndpoint();
    if (!pairing || !relayUrl || !relayCanSync(pairing) || !selectedConversationId()) {
      return;
    }
    void getRelaySocket(relayUrl, pairing).then(function (socket) {
      ensureRelayTimelineCollector(socket, pairing);
    }).catch(function (error) {
      recordRelayDebug({ event: "live-relay-failed", reason: String(error && error.message || error) });
      scheduleLiveRelayReconnect();
    });
  }

  async function sendRelayPayload(pairing, logicalMessageId, payload) {
    const relayUrl = relayEndpoint();
    if (!relayUrl || !relayCanSync(pairing)) {
      throw new Error("Waiting for desktop.");
    }
    const socket = await getRelaySocket(relayUrl, pairing);
    ensureRelayTimelineCollector(socket, pairing);
    const sealed = await sealRelayPayload(payload, pairing.relaySealKeyBase64);
    const reply = await sendRelayRequest(socket, pairing, {
      logicalMessageId,
      ciphertext: sealed
    });
    return openRelayPayload(reply.ciphertext, pairing.relaySealKeyBase64);
  }

  async function requestChatListViaRelay(pairing) {
    const payload = await sendRelayPayload(pairing, "chat-list-" + createEventId(), {
      type: "mobile.chat-list.request"
    });
    return handleRelayChatListPayload(payload);
  }

  /**
   * Tells the desktop the key this phone signs machine commands with, and
   * learns which machines it may command.
   *
   * Done while the desktop is reachable, precisely so that the phone can keep
   * working when it is not: a machine answers the devices its owner named, and
   * this is how the phone gets named.
   */
  async function announceMachineIdentityViaRelay(pairing) {
    const identity = await machineCommandIdentity();
    if (!identity) return undefined;
    const payload = await sendRelayPayload(pairing, "device-identity-" + createEventId(), {
      type: "mobile.device.identity",
      deviceId: identity.deviceId,
      publicKeyDerBase64: identity.publicKeyDerBase64,
      name: "Phone"
    });
    if (payload && payload.type === "mobile.machines" && Array.isArray(payload.machines)) {
      await storeMachineAccess(payload.machines);
      return payload.machines;
    }
    return undefined;
  }

  async function requestTimelineViaRelay(pairing, conversationId, options) {
    const beforeMessageId = options && typeof options.beforeMessageId === "string" && options.beforeMessageId.trim()
      ? options.beforeMessageId
      : undefined;
    const payload = await sendRelayPayload(pairing, "timeline-" + conversationId + "-" + createEventId(), {
      type: "mobile.timeline.request",
      conversationId,
      ...(beforeMessageId ? { beforeMessageId } : {})
    });
    return handleRelayTimelinePayload(payload, conversationId, {
      deferRender: Boolean(options && options.deferRender),
      historyPage: Boolean(beforeMessageId)
    });
  }

  async function pollMailboxTimeline(options) {
    const endpoint = outboxEndpoint(options && options.endpoint);
    if (!endpoint) {
      return 0;
    }
    const pairing = loadPairing();
    const request = await authorizedMailboxRequest(endpoint);
    // Cursor reads span every conversation in the pairing's box: filtering by
    // conversation while advancing one shared cursor would silently skip
    // other conversations' envelopes.
    const fetchPage = async function (afterArrival) {
      const url = new URL(request.url);
      url.searchParams.set("limit", String(MAILBOX_PAGE_SIZE));
      url.searchParams.set("afterArrival", String(Math.max(0, afterArrival)));
      // The cursor this page brings is the one it committed after storing the
      // previous page — its acknowledgement of everything below it, the same
      // one the worker sends — so the relay does not ring for what is already
      // on the screen.
      url.searchParams.set("reader", "phone");
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: Object.assign({ "accept": "application/json" }, request.headers),
        // A response that never comes must not hold the catch-up open for
        // ever: while it ran, every poll stood aside and every return to the
        // foreground waited on it, so one stalled connection was a phone that
        // never synced again until it was relaunched.
        signal: AbortSignal.timeout(MAILBOX_FETCH_TIMEOUT_MS)
      });
      noteMailboxResponse(response);
      if (response.status === 401) {
        const failure = await mailboxAuthFailureState(response);
        if (failure === "revoked") {
          // The mailbox lock no longer accepts this pairing: the desktop
          // revoked it. Surface the re-pair screen instead of retrying forever.
          await render("revoked");
          throw new Error("Mailbox timeline poll was refused (HTTP 401).");
        }
        throw new Error("Mailbox is not registered yet (HTTP 401).");
      }
      if (!response.ok) {
        throw new Error("Mailbox timeline poll failed with HTTP " + response.status + ".");
      }
      return response.json();
    };
    // Anything a push-woken service worker stored while the app was closed is
    // ingested first, so the network poll continues from the shared cursor.
    let drained = await drainSealedEnvelopes(pairing);
    // How much of the backlog one call takes. The periodic poll takes a page,
    // because it is never far behind; the catch-up after the app opens takes
    // as many as it needs, so a phone that was away for hours shows one wait
    // and then everything, instead of a lump of old messages every few seconds
    // (the User, 2026-09-21).
    const pageBudget = Math.max(1, (options && options.pages) || 1);
    const deadline = options && options.budgetMs ? Date.now() + options.budgetMs : 0;
    let pagesRead = 0;
    let total = 0;
    let more = true;
    while (more && pagesRead < pageBudget) {
      const page = await ingestOnePage(drained);
      drained = 0;
      total += page.stored;
      more = page.more;
      pagesRead += 1;
      if (deadline && Date.now() > deadline) break;
    }
    return total;

    async function ingestOnePage(alreadyStored) {
    const cursorState = await loadMailboxCursor();
    let body = await fetchPage(cursorState.cursor);
    const epoch = typeof body?.epoch === "string" ? body.epoch : "";
    if (epoch && epoch !== cursorState.epoch) {
      // Box recreated: numbering restarted, cursor no longer applies. Re-read
      // from zero; the IndexedDB dedupe absorbs the replay.
      await saveMailboxCursor(epoch, 0);
      body = await fetchPage(0);
    }
    if (!Array.isArray(body?.events)) {
      return { stored: alreadyStored, more: false };
    }
    // Stale cursor: events expired beneath us, so there is a real gap the
    // mailbox can no longer fill. Fire exactly one timeline-request refill
    // per detection instead of silently continuing.
    const oldestArrival = Number(body.oldestArrivalSeq);
    const current = await loadMailboxCursor();
    if (Number.isFinite(oldestArrival) && current.cursor > 0 && current.cursor + 1 < oldestArrival) {
      const refillKey = (epoch || current.epoch) + ":" + oldestArrival;
      if (lastStaleRefillKey !== refillKey) {
        lastStaleRefillKey = refillKey;
        const refillConversationId = selectedConversationId();
        if (pairing && refillConversationId && relayCanSync(pairing)) {
          requestTimelineViaRelay(pairing, refillConversationId).catch(function () {
            return undefined;
          });
        }
      }
    }
    let stored = alreadyStored;
    let advanced = current.cursor;
    for (const envelope of body.events) {
      if (Number.isFinite(envelope?.arrivalSeq) && envelope.arrivalSeq > advanced) {
        advanced = envelope.arrivalSeq;
      }
      if (envelope?.kind !== "mobile.timeline.events") {
        continue;
      }
      const payload = await openMailboxEnvelopePayload(envelope, pairing);
      if (payload?.type !== "mobile.timeline.events") {
        continue;
      }
      // Rendering happens once per poll (in the callers), not per envelope, so
      // catching up on several envelopes cannot flash intermediate states.
      stored += await handleRelayTimelinePayload(payload, envelope.conversationId, { deferRender: true });
    }
    if (advanced !== current.cursor || (epoch && epoch !== current.epoch)) {
      await saveMailboxCursor(epoch || current.epoch, advanced);
    }
    // A full page means the box very likely holds more behind it.
    return { stored: stored, more: body.events.length >= MAILBOX_PAGE_SIZE && advanced > current.cursor };
    }
  }

  // A queue entry the desktop did not take at the time is offered again while
  // the phone is open, not only when the User next acts in that chat.
  const OUTBOX_RETRY_MIN_MS = 30_000;
  let lastOutboxRetryAt = 0;

  function retryPendingOutbox() {
    if (activeFlushOutboxPromise || Date.now() - lastOutboxRetryAt < OUTBOX_RETRY_MIN_MS) return Promise.resolve();
    let pending = false;
    for (const held of outboxStatusById.values()) {
      if (desktopOwesEntry(held)) { pending = true; break; }
    }
    if (!pending) return Promise.resolve();
    lastOutboxRetryAt = Date.now();
    return flushOutbox().then(function (result) {
      return result && result.sent > 0 ? render(result.status) : undefined;
    }).catch(function () { return undefined; });
  }

  // One wait, then everything: while this runs the timeline says so and is not
  // redrawn per page, so a backlog arrives as a single change rather than as
  // old messages crawling in one lump at a time.
  let catchingUp = false;

  // "Nothing new" and "still looking" must not look the same. The banner waits
  // a moment so an ordinary fast poll does not blink it, and stays up long
  // enough to be read once it is there.
  const SYNC_BANNER_DELAY_MS = 350;
  const SYNC_BANNER_MIN_MS = 700;
  let syncDepth = 0;
  let syncBannerTimer;
  let syncBannerHideTimer;
  let syncBannerShownAt = 0;

  function setSyncBanner(visible) {
    const node = document.getElementById("timeline-syncing");
    if (!node) return;
    if (visible && node.hidden) {
      syncBannerShownAt = Date.now();
    }
    node.hidden = !visible;
  }

  /** Runs a sync that could bring messages in, with the banner saying so. */
  async function whileLookingForMessages(run) {
    syncDepth += 1;
    if (syncDepth === 1 && !syncBannerTimer) {
      clearTimeout(syncBannerHideTimer);
      syncBannerHideTimer = undefined;
      syncBannerTimer = setTimeout(function () {
        syncBannerTimer = undefined;
        if (syncDepth > 0) setSyncBanner(true);
      }, SYNC_BANNER_DELAY_MS);
    }
    try {
      return await run();
    } finally {
      syncDepth = Math.max(0, syncDepth - 1);
      if (syncDepth === 0) {
        clearTimeout(syncBannerTimer);
        syncBannerTimer = undefined;
        const node = document.getElementById("timeline-syncing");
        if (node && !node.hidden) {
          const left = Math.max(0, SYNC_BANNER_MIN_MS - (Date.now() - syncBannerShownAt));
          clearTimeout(syncBannerHideTimer);
          syncBannerHideTimer = setTimeout(function () {
            syncBannerHideTimer = undefined;
            if (syncDepth === 0) setSyncBanner(false);
          }, left);
        }
      }
    }
  }

  async function catchUpFromRelay() {
    if (catchingUp || !outboxEndpoint()) return 0;
    catchingUp = true;
    await render();
    try {
      return await whileLookingForMessages(function () {
        return pollMailboxTimeline({ pages: CATCH_UP_PAGE_BUDGET, budgetMs: CATCH_UP_BUDGET_MS });
      });
    } catch {
      return 0;
    } finally {
      catchingUp = false;
      await render("synced");
    }
  }

  function startMailboxTimelinePolling() {
    clearInterval(activeMailboxTimelinePollTimer);
    if (!outboxEndpoint()) {
      return;
    }
    // Re-registers silently when permission is already granted (covers
    // subscription lapse: the relay drops a dead subscription and the phone
    // replaces it here on next open).
    void ensurePushSubscription();
    activeMailboxTimelinePollTimer = setInterval(function () {
      if (catchingUp) return;
      void retryPendingOutbox();
      // Polling only wrote to storage; without this the timeline never
      // repainted, so arriving messages stayed invisible until the next
      // send or reload.
      whileLookingForMessages(function () {
        return pollMailboxTimeline();
      }).then(function (stored) {
        return stored > 0 ? render("synced") : undefined;
      }).catch(function () {
        return undefined;
      });
    }, MAILBOX_TIMELINE_POLL_MS);
  }

  function startRelayTimelineKeepAlive() {
    clearInterval(activeRelayTimelineKeepAliveTimer);
    activeRelayTimelineKeepAliveTimer = setInterval(function () {
      const pairing = loadPairing();
      const relayUrl = relayEndpoint();
      if (!pairing || !relayCanSync(pairing) || !relayUrl || !selectedConversationId()) {
        return;
      }
      // The collector closes its socket after an idle period, and nothing
      // reopened it, so the phone quietly stopped receiving pushed messages.
      Promise.resolve(getRelaySocket(relayUrl, pairing)).then(function (socket) {
        ensureRelayTimelineCollector(socket, pairing);
      }).catch(function () {
        return undefined;
      });
    }, RELAY_TIMELINE_KEEPALIVE_MS);
  }

  // How long a pending card must have been on this phone before its absence
  // from the desktop's list means it was answered or withdrawn. A card that
  // reached the phone while the list was being built is not in it yet; both
  // moments are this phone's own clock, so they compare whatever the desktop
  // stamped the card with (a choice carries its run's start).
  // Five minutes rather than two: the list is read from the desktop's
  // database, and a card reaches the phone from the desktop's memory first —
  // a save that lags behind must not read as the card being closed.
  const PENDING_CARD_RECONCILE_GRACE_MS = 5 * 60_000;

  /**
   * The desktop's chat list says which cards still wait in every chat it
   * lists. A pending card this phone holds that the desktop no longer lists
   * was answered or withdrawn while this phone was not listening — the batch
   * that said so was lost, or was never written because it carried nothing
   * else — and it would otherwise wait here for ever: the User's screenshot
   * of 2026-09-20 showed cards the desktop had closed days earlier.
   *
   * Answered cards are kept; they are the record under their messages, and
   * the list says nothing about them. A card learned from a machine directly
   * is kept too: the desktop cannot vouch for it.
   */
  function reconcilePendingControlCards(payload) {
    // The stamp says the desktop knows this contract; the judgement below is
    // on this phone's clock.
    if (!Number.isFinite(Date.parse(typeof payload.generatedAt === "string" ? payload.generatedAt : ""))) return 0;
    const now = Date.now();
    let changed = 0;
    for (const chat of payload.chats) {
      if (!chat || typeof chat.id !== "string" || !Array.isArray(chat.pendingCards)) continue;
      const listed = new Map();
      for (const card of chat.pendingCards) {
        if (card && typeof card.id === "string" && card.status === "pending") {
          listed.set(card.id, { ...card, conversationId: chat.id });
        }
      }
      const next = [];
      const seen = new Set();
      for (const card of controlCardsFor(chat.id)) {
        if (!card || typeof card.id !== "string") continue;
        seen.add(card.id);
        if (card.status !== "pending" || card.source === "machine") {
          // An answered card is never reopened by a list that was read before
          // the answer: what this phone holds is the later fact.
          next.push(card);
          continue;
        }
        const fresh = listed.get(card.id);
        if (fresh) {
          next.push({ ...card, ...fresh });
          continue;
        }
        const receivedAt = Date.parse(card.receivedAt || card.createdAt || "");
        if (Number.isFinite(receivedAt) && receivedAt > now - PENDING_CARD_RECONCILE_GRACE_MS) {
          // Too new to judge: the list may predate it. The next list decides.
          next.push(card);
        }
        // Otherwise the desktop no longer waits on it, and neither does this phone.
      }
      for (const card of listed.values()) {
        if (!seen.has(card.id)) next.push(card);
      }
      if (storeControlCards(chat.id, next)) changed += 1;
    }
    return changed;
  }

  function handleRelayChatListPayload(payload) {
    if (payload?.type !== "mobile.chat-list" || !Array.isArray(payload.chats)) {
      return [];
    }
    // A card the list closed leaves the screen now, whether or not the
    // caller redraws afterwards.
    if (reconcilePendingControlCards(payload) > 0) void render();
    // When the desktop last said which chats have a run going; Activity
    // trusts a "still running" row only if it started after that.
    try {
      localStorage.setItem(CHAT_LIST_AT_KEY, nowIso());
    } catch {
      // Without it Activity simply shows what the chat shows.
    }
    return saveChats(payload.chats);
  }

  function timelineAttachmentsFromEvent(event) {
    if (!event || !Array.isArray(event.attachments)) {
      return [];
    }
    return event.attachments
      .filter(function (attachment) {
        return attachment && typeof attachment.id === "string" && attachment.id.trim();
      })
      .map(function (attachment) {
        return {
          id: attachment.id,
          filename: typeof attachment.filename === "string" ? attachment.filename : "image",
          mimeType: typeof attachment.mimeType === "string" ? attachment.mimeType : "image/png",
          width: Number.isFinite(attachment.width) ? attachment.width : undefined,
          height: Number.isFinite(attachment.height) ? attachment.height : undefined
        };
      });
  }

  // Bytes arrive once per image and stay for the session. The timeline re-sends
  // the last forty rows constantly; refetching a screenshot on every batch would
  // put the picture through the relay again and again.
  const attachmentDataUrls = new Map();
  const attachmentFetches = new Map();
  const ATTACHMENT_CACHE_MAX_ENTRIES = 24;

  function rememberAttachmentResult(attachmentId, result) {
    // Oldest out first. Without a bound, scrolling a long history keeps every
    // picture ever opened in memory for the life of the session.
    if (attachmentDataUrls.size >= ATTACHMENT_CACHE_MAX_ENTRIES) {
      const oldest = attachmentDataUrls.keys().next();
      if (!oldest.done) {
        attachmentDataUrls.delete(oldest.value);
      }
    }
    attachmentDataUrls.set(attachmentId, result);
  }

  async function requestAttachmentViaRelay(pairing, conversationId, attachmentId) {
    return sendRelayPayload(pairing, "attachment-" + attachmentId + "-" + createEventId(), {
      type: "mobile.attachment.request",
      conversationId,
      attachmentId
    });
  }

  function loadAttachmentInto(image, conversationId, attachment) {
    if (attachment.dataBase64) {
      // Already in hand — a picture queued on this phone, not yet echoed back.
      applyAttachmentResult(image, "data:" + attachment.mimeType + ";base64," + attachment.dataBase64);
      return;
    }
    const cached = attachmentDataUrls.get(attachment.id);
    if (cached) {
      applyAttachmentResult(image, cached);
      return;
    }
    if (!attachmentFetches.has(attachment.id)) {
      const pairing = loadPairing();
      attachmentFetches.set(attachment.id, (async function () {
        const payload = await requestAttachmentViaRelay(pairing, conversationId, attachment.id);
        if (payload && payload.type === "mobile.attachment" && typeof payload.dataBase64 === "string") {
          const mimeType = typeof payload.mimeType === "string" ? payload.mimeType : attachment.mimeType;
          return "data:" + mimeType + ";base64," + payload.dataBase64;
        }
        // "too-large" and "unavailable" are answers, not failures: the row says
        // so instead of spinning forever.
        return payload && typeof payload.reason === "string" ? payload.reason : "unavailable";
      })().catch(function () {
        // A dropped connection is not an answer: leave it uncached so opening
        // the chat again retries instead of showing a permanent failure.
        return "retry";
      }).then(function (result) {
        if (result !== "retry") {
          rememberAttachmentResult(attachment.id, result);
        }
        attachmentFetches.delete(attachment.id);
        return result === "retry" ? "unavailable" : result;
      }));
    }
    attachmentFetches.get(attachment.id).then(function (result) {
      if (image.isConnected) {
        applyAttachmentResult(image, result);
      }
    });
  }

  function applyAttachmentResult(image, result) {
    if (result && result.indexOf("data:") === 0) {
      image.src = result;
      image.dataset.state = "ready";
      return;
    }
    // A replaced element renders no pseudo-element, so the reason goes in a
    // sibling the reader can actually see.
    image.dataset.state = result === "too-large" ? "too-large" : "unavailable";
    image.hidden = true;
    const note = image.nextElementSibling;
    if (note && note.classList.contains("message-image-note")) {
      note.textContent = result === "too-large"
        ? "Too large for the phone — open it on the desktop"
        : "Image unavailable";
      note.hidden = false;
    }
  }

  function renderAttachmentsInto(container, entry) {
    const attachments = Array.isArray(entry.attachments) ? entry.attachments : [];
    const signature = attachments.map(function (attachment) { return attachment.id; }).join(",");
    if (container.dataset.attachmentSignature === signature) {
      return;
    }
    container.dataset.attachmentSignature = signature;
    container.textContent = "";
    if (attachments.length === 0) {
      container.hidden = true;
      return;
    }
    container.hidden = false;
    for (const attachment of attachments) {
      const image = document.createElement("img");
      image.className = "message-image";
      image.alt = attachment.filename;
      image.dataset.state = "loading";
      image.loading = "lazy";
      if (attachment.width && attachment.height) {
        // Reserve the real box before the bytes land, so the timeline does not
        // jump under the reader when the picture appears.
        image.width = attachment.width;
        image.height = attachment.height;
      }
      const note = document.createElement("div");
      note.className = "message-image-note";
      note.hidden = true;
      // A loaded picture opens at full size; one that has no bytes yet, or
      // never will, stays a note in the row.
      image.addEventListener("click", function () {
        if (image.dataset.state === "ready" && image.src) {
          openImageViewer(image.src, attachment.filename);
        }
      });
      container.append(image, note);
      loadAttachmentInto(image, entry.conversationId, attachment);
    }
  }

  function openImageViewer(src, alt) {
    const viewer = document.getElementById("image-viewer");
    const picture = document.getElementById("image-viewer-image");
    if (!viewer || !picture) {
      return;
    }
    picture.src = src;
    picture.alt = alt || "Picture";
    viewer.hidden = false;
    // The bar leaves and comes back with the viewer; a reader at the latest
    // message stays there across both, as across the keyboard.
    keepingReaderAtLatest(applyDock);
  }

  function closeImageViewer() {
    const viewer = document.getElementById("image-viewer");
    const picture = document.getElementById("image-viewer-image");
    if (!viewer || viewer.hidden) {
      return;
    }
    viewer.hidden = true;
    if (picture) {
      picture.removeAttribute("src");
    }
    keepingReaderAtLatest(applyDock);
  }

  function wireImageViewer() {
    const viewer = document.getElementById("image-viewer");
    const close = document.getElementById("image-viewer-close");
    if (!viewer) {
      return;
    }
    close?.addEventListener("click", closeImageViewer);
    // Anywhere outside the picture itself is "back": the dark backdrop and the
    // picture's own margins. Scrolling inside a tall picture must not close it.
    viewer.addEventListener("click", function (event) {
      if (event.target === viewer || (event.target instanceof Element && event.target.classList.contains("image-viewer-body"))) {
        closeImageViewer();
      }
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        closeImageViewer();
      }
    });
  }

  function attachmentsNodeFor(parent) {
    let node = parent.querySelector(".message-images");
    if (!node) {
      node = document.createElement("div");
      node.className = "message-images";
      node.hidden = true;
      parent.append(node);
    }
    return node;
  }

  // The cards of every synced chat in one string. Parsing it per row per
  // redraw cost tens of milliseconds on a store with hundreds of answered
  // choices, on every batch of a streaming run; the parse is kept until the
  // string itself changes.
  let controlCardsParseCache;

  function loadControlCards() {
    try {
      const raw = localStorage.getItem(CONTROL_CARDS_KEY);
      if (controlCardsParseCache && controlCardsParseCache.raw === raw) {
        return controlCardsParseCache.parsed;
      }
      const decoded = raw ? JSON.parse(raw) : {};
      const parsed = decoded && typeof decoded === "object" && !Array.isArray(decoded) ? decoded : {};
      controlCardsParseCache = { raw: raw, parsed: parsed };
      return parsed;
    } catch {
      return {};
    }
  }

  function saveControlCards(byConversation) {
    try {
      controlCardsParseCache = undefined;
      localStorage.setItem(CONTROL_CARDS_KEY, JSON.stringify(byConversation));
      return true;
    } catch {
      // A full quota must not lose the timeline; the cards arrive again with
      // the next batch. Said so to the caller rather than counted as written.
      return false;
    }
  }

  // Answered cards a batch does not name are kept as the record under their
  // messages; only this many per chat, newest first, so the store cannot grow
  // with every choice ever answered.
  // Per chat, and the record only matters for the chats still being read:
  // a hundred each across every chat the phone has opened grew towards the
  // few megabytes the browser allows, past which no new card is stored.
  const CONTROL_CARDS_KEPT_ANSWERED_LIMIT = 30;

  function controlCardsFor(conversationId) {
    const stored = loadControlCards()[conversationId];
    return Array.isArray(stored) ? stored : [];
  }

  /** The desktop states the whole set for a chat, so it replaces rather than
   *  merges: a card it no longer lists has been answered or withdrawn. */
  function storeControlCards(conversationId, cards) {
    if (!conversationId || !Array.isArray(cards)) return false;
    const all = loadControlCards();
    const previous = Array.isArray(all[conversationId]) ? all[conversationId] : [];
    const before = JSON.stringify(previous);
    const previousById = new Map(previous.filter(function (card) { return card && card.id; })
      .map(function (card) { return [card.id, card]; }));
    // When each card reached this phone, on its own clock: what a later list
    // is judged against. A card already held keeps the moment it first came.
    const arrived = nowIso();
    const stamped = cards.map(function (card) {
      if (!card || !card.id) return card;
      const held = previousById.get(card.id);
      return { ...card, receivedAt: (held && held.receivedAt) || card.receivedAt || arrived };
    });
    // What the desktop sends is the whole of what still waits, so a pending
    // card it leaves out is closed. An answered card it leaves out was only
    // outside the page it read: it stays, as the record under its message.
    // A card learned from a member's machine directly is kept as well: the
    // desktop cannot vouch for it, and a batch that does not name it says
    // only that the desktop has not seen it yet — the same rule the chat
    // list's reconciliation follows.
    const incoming = new Set(stamped.map(function (card) { return card && card.id; }));
    const kept = previous.filter(function (card) {
      return card && card.id && !incoming.has(card.id) && (card.status !== "pending" || card.source === "machine");
    }).sort(function (left, right) {
      return String(right.createdAt || "").localeCompare(String(left.createdAt || ""));
    }).slice(0, CONTROL_CARDS_KEPT_ANSWERED_LIMIT);
    const next = stamped.concat(kept);
    const after = JSON.stringify(next);
    if (before === after) return false;
    all[conversationId] = next;
    if (!saveControlCards(all)) return false;
    // A card the desktop no longer lists has been answered or withdrawn, so the
    // "sent" mark for it goes too: the next card with that id is a new question.
    // Only this chat's cards: the set says nothing about another chat's, and
    // clearing theirs made an answer already sent there answerable again.
    const live = new Set(next.map(function (card) { return card && card.id; }));
    for (const card of previous) {
      const id = card && card.id;
      if (!id || live.has(id)) continue;
      clearCardSent(id);
      controlCardErrors.delete(id);
    }
    // A card the desktop now states as answered is answered: the "sent" mark
    // has done its work, whichever device the answer came from.
    for (const card of next) {
      if (card && card.id && card.status !== "pending") clearCardSent(card.id);
    }
    return true;
  }

  async function handleRelayTimelinePayload(payload, fallbackConversationId, options) {
    if (payload?.type !== "mobile.timeline.events" || !Array.isArray(payload.events)) {
      return 0;
    }
    // Never the chat that happens to be open: a batch that does not say which
    // conversation it belongs to used to be filed under whatever the user was
    // looking at, which is how another chat's messages appeared in this one.
    const conversationId = payload.conversationId || fallbackConversationId;
    if (!conversationId || await isMachineConversationDeleted(conversationId)) {
      return 0;
    }
    // Only the answer to a direct request says where this chat's history
    // stops; batches that arrive on their own carry no page and leave the
    // stored cursor alone. Handled here rather than by the requester because
    // a slow answer can outlive the request's own wait and still land through
    // the socket collector — the rows must not arrive without their cursor.
    if (payload.page && typeof payload.page === "object") {
      await adoptTimelinePage(conversationId, payload);
    }
    let stored = 0;
    let changed = 0;
    if (Array.isArray(payload.cards) && storeControlCards(conversationId, payload.cards)) {
      stored += 1;
      changed += 1;
    }
    for (const event of payload.events) {
      if (!event || typeof event !== "object") {
        continue;
      }
      const id = typeof event.id === "string" && event.id.trim() ? event.id : createEventId();
      const content = typeof event.content === "string" ? event.content.trim() : "";
      const attachments = timelineAttachmentsFromEvent(event);
      // A picture with no caption is still a message. Requiring text dropped it.
      if (!content && attachments.length === 0) {
        continue;
      }
      const status = event.status === "error" ? "error" : event.status === "done" ? "done" : "pending";
      const runId = typeof event.runId === "string" ? event.runId : undefined;
      const mobileEventId = typeof event.mobileEventId === "string" ? event.mobileEventId : undefined;
      const createdAt = typeof event.createdAt === "string" ? event.createdAt : nowIso();
      const role = event.role === "you" ? "you" : event.role === "system" ? "system" : "participant";
      // W-N: only the agent's own finished message ends the agent's run. A
      // message sent from this phone comes back in the next conversation
      // snapshot as "done" and carries the run's identity — the run is named
      // after it (`mobile-<eventId>`, same mobileEventId) — so treating any
      // non-pending event as terminal deleted the in-progress row about a
      // second after it appeared, and blacklisted the run so it never returned.
      const messageId = typeof event.messageId === "string" && event.messageId.trim() ? event.messageId.trim() : id;
      // A page of earlier history is a record, not a run ending: it must not
      // clear anything pending now, nor crowd the recent runs out of the
      // terminal bookkeeping, which is bounded.
      const historyPage = Boolean(options && options.historyPage) || Boolean(payload.page && payload.page.earlier === true);
      // When this phone watched the run end on the live socket, it notes when:
      // the message keeps the time the run started, and Activity lists an
      // update by when it finished. A backlog drained later carries no such
      // moment, so it keeps the desktop's stamp.
      let settledAt;
      if (!historyPage && status !== "pending" && role === "participant" && (runId || mobileEventId || messageId)) {
        const cleared = await deletePendingTimelineEntriesForRun(conversationId, runId, mobileEventId, messageId, status);
        if (cleared > 0 && status === "done" && options && options.live) settledAt = nowIso();
        rememberTerminalRun(runId, mobileEventId, createdAt);
        await deleteStalePlaceholderTimelineEntries(conversationId, createdAt);
      }
      if (!historyPage && status === "pending" && isSupersededPendingEvent(runId, mobileEventId, createdAt)) {
        continue;
      }
      // What the desktop keeps off its timeline travels only to end a run:
      // the bookkeeping above ran, and no bubble is stored for it. It counts
      // as handled so the settled row is drawn now, not on the next batch. A
      // copy stored before the desktop hid it (an older shell, a page read
      // that could not see the row's trigger) goes with it.
      if (event.hidden === true) {
        if (await deleteTimelineEntry(conversationId ? conversationId + ":" + id : id)) {
          changed += 1;
        }
        stored += 1;
        continue;
      }
      const written = await putTimelineEntryDeduped({
        id: conversationId ? conversationId + ":" + id : id,
        sourceId: id,
        conversationId,
        role,
        participantLabel: typeof event.participantLabel === "string" ? event.participantLabel : undefined,
        content,
        attachments: attachments.length > 0 ? attachments : undefined,
        status,
        createdAt,
        runId,
        messageId: typeof event.messageId === "string" ? event.messageId : undefined,
        threadRootId: typeof event.threadRootId === "string" && event.threadRootId.trim()
          ? event.threadRootId
          : undefined,
        mobileEventId,
        ...(settledAt ? { settledAt: settledAt } : {})
      });
      if (written) {
        changed += 1;
      }
      stored += 1;
    }
    // News for a chat that is not on screen — or is, behind a locked screen —
    // is unread, the way the desktop marks a chat it is not showing. The
    // phone's own message echoed back is news too; the desktop treats it so.
    const historyBatch = Boolean(options && options.historyPage) || Boolean(payload.page && payload.page.earlier === true);
    if (changed > 0 && !historyBatch && (conversationId !== selectedConversationId() || document.hidden)) {
      markConversationsUnread([conversationId]);
    }
    if (changed > 0 && !historyBatch) {
      refreshChatListSoon(conversationId);
    }
    if (stored > 0 && !(options && options.deferRender)) {
      await render("synced");
    }
    return stored;
  }

  function collectRelayTimeline(socket, pairing) {
    const buffer = new Map();
    return new Promise(function (resolve, reject) {
      let idleTimer;
      function resetIdleTimer() {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(function () {
          cleanup();
          socket.close(1000, "mobile timeline idle");
          resolve();
        }, RELAY_TIMELINE_IDLE_MS);
      }
      function cleanup() {
        clearTimeout(idleTimer);
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("close", onClose);
        socket.removeEventListener("error", onError);
      }
      async function onMessage(event) {
        let parsed;
        try {
          parsed = JSON.parse(relayFrameText(event.data));
        } catch {
          return;
        }
        if (parsed?.protocol !== RELAY_PROTOCOL) {
          return;
        }
        const key = parsed.streamId + "\0" + parsed.logicalMessageId;
        const collected = [...(buffer.get(key) || []), parsed];
        buffer.set(key, collected);
        const result = reassembleRelayCiphertext(collected);
        if (result.status === "complete") {
          buffer.delete(key);
          const payload = await openRelayPayload(result.ciphertext, pairing.relaySealKeyBase64);
          const stored = await handleRelayTimelinePayload(payload, undefined, { deferRender: true, live: true });
          // Storing alone left the timeline stale: pushed messages did not
          // appear until the next send or reload.
          if (stored > 0) {
            await render("synced");
          }
          resetIdleTimer();
        } else if (result.status === "conflict") {
          cleanup();
          reject(new Error("Relay frame conflict: " + result.reason));
        }
      }
      function onClose() {
        cleanup();
        resolve();
      }
      function onError() {
        cleanup();
        reject(new Error("Relay tunnel unavailable."));
      }
      socket.addEventListener("message", onMessage);
      socket.addEventListener("close", onClose);
      socket.addEventListener("error", onError);
      resetIdleTimer();
    });
  }

  // One more pass, queued behind a flush in flight: that flush read the queue
  // before the entry this call is about was written, so answering with it
  // alone left a message sent during a slow flush waiting for the retry tick
  // half a minute later. However many ask meanwhile, one pass follows.
  let queuedFlushOutboxPromise;

  function flushOutbox(options) {
    if (activeFlushOutboxPromise) {
      if (!queuedFlushOutboxPromise) {
        const again = function () {
          queuedFlushOutboxPromise = undefined;
          return flushOutbox(options);
        };
        queuedFlushOutboxPromise = activeFlushOutboxPromise.then(again, again);
      }
      return queuedFlushOutboxPromise;
    }
    activeFlushOutboxPromise = flushOutboxInternal(options).finally(function () {
      activeFlushOutboxPromise = undefined;
    });
    return activeFlushOutboxPromise;
  }

  async function flushOutboxInternal(options) {
    const pairing = loadPairing();
    const endpoint = outboxEndpoint(options && options.endpoint);
    // Every chat's queue, not only the open chat's: an answer given from
    // Activity for a chat that was then never opened again sat here for days.
    // What was handed to a member's machine directly is that machine's to
    // acknowledge and must not go to the desktop as well — the same message
    // down both paths is two runs of the member.
    const entries = (await listOutboxEntries()).filter(desktopOwesEntry);
    if (relayCanSync(pairing)) {
      try {
        return await flushOutboxViaRelay(entries, pairing);
      } catch (error) {
        if (!endpoint) {
          return { status: "tunnel-reconnecting", sent: 0, pending: entries.filter((entry) => entry.status !== "acked").length, error: error instanceof Error ? error.message : String(error) };
        }
      }
    }
    if (endpoint) {
      try {
        return await flushOutboxViaMailbox(entries, endpoint);
      } catch (error) {
        return { status: "waiting-to-sync", sent: 0, pending: entries.filter((entry) => entry.status !== "acked").length, error: error instanceof Error ? error.message : String(error) };
      }
    }
    return { status: "waiting-to-sync", sent: 0, pending: entries.filter((entry) => entry.status !== "acked").length };
  }

  async function flushOutboxViaMailbox(entries, endpoint) {
    const pendingEntries = entries.filter(desktopOwesEntry);
    let sent = 0;
    const pairing = loadPairing();
    const request = await authorizedMailboxRequest(endpoint);
    for (const entry of pendingEntries) {
      const syncing = {
        ...entry,
        status: "syncing",
        attempts: entry.attempts + 1,
        updatedAt: nowIso()
      };
      await putOutboxEntry(syncing);
      try {
        const event = mailboxEventForAppend(syncing);
        // Hashes stay computed over the plaintext payload; sealing wraps only
        // what travels, and the desktop unseals before verifying.
        if (pairing?.relaySealKeyBase64) {
          event.payload = JSON.parse(await sealRelayPayload(event.payload, pairing.relaySealKeyBase64));
        }
        const response = await fetch(request.url, {
          method: "POST",
          headers: Object.assign({ "content-type": "application/json" }, request.headers),
          body: JSON.stringify({ events: [event] }),
          signal: AbortSignal.timeout(MAILBOX_FETCH_TIMEOUT_MS)
        });
        noteMailboxResponse(response);
        if (response.status === 401) {
          const failure = await mailboxAuthFailureState(response);
          if (failure === "revoked") {
            await render("revoked");
          }
          throw new Error("HTTP 401 (" + failure + ")");
        }
        if (!response.ok) {
          throw new Error("HTTP " + response.status);
        }
        const ack = await response.json();
        const ackedEventIds = Array.isArray(ack?.eventIds) ? ack.eventIds : [ack?.eventId];
        if (!ackedEventIds.includes(entry.eventId)) {
          throw new Error("Ack eventId mismatch.");
        }
        await putOutboxEntry({
          ...syncing,
          status: "acked",
          ack,
          updatedAt: nowIso(),
          lastError: undefined
        });
        sent += 1;
      } catch (error) {
        await putOutboxEntry({
          ...syncing,
          status: "waiting-to-sync",
          updatedAt: nowIso(),
          lastError: error instanceof Error ? error.message : String(error)
        });
        return { status: "waiting-to-sync", sent, pending: pendingEntries.length - sent };
      }
    }
    return { status: "synced", sent, pending: Math.max(0, pendingEntries.length - sent) };
  }

  function statusText(status) {
    if (status === "acked") {
      return "Sent";
    }
    if (status === "syncing") {
      return "Syncing";
    }
    if (status === "refused") {
      return "Not taken by the desktop";
    }
    if (status === "superseded") {
      return "Replaced";
    }
    return "Waiting to sync";
  }

  // Waiting with no feedback reads as "nothing is happening", so the wait is
  // timed and named, and a long silence says the desktop is not answering.
  function syncWaitStartedAt() {
    const existing = sessionStorage.getItem(SYNC_WAIT_KEY);
    if (existing) {
      return existing;
    }
    const now = nowIso();
    sessionStorage.setItem(SYNC_WAIT_KEY, now);
    return now;
  }

  function syncProgressText(startedAt) {
    const started = Date.parse(startedAt || "");
    const seconds = Number.isFinite(started) ? Math.max(0, Math.floor((Date.now() - started) / 1000)) : 0;
    if (seconds < 20) {
      return "Asking the desktop for your chats… " + seconds + "s";
    }
    if (seconds < 60) {
      return "Still waiting on the desktop… " + seconds + "s";
    }
    return "The desktop has not answered in " + Math.floor(seconds / 60) + "m. " +
      "Check that AccordAgents is open on your computer, then pair again.";
  }

  function startSyncProgressClock() {
    clearInterval(activeSyncProgressClockTimer);
    activeSyncProgressClockTimer = setInterval(function () {
      for (const node of document.querySelectorAll(".sync-progress")) {
        const next = syncProgressText(node.dataset.startedAt);
        if (node.textContent !== next) {
          node.textContent = next;
        }
      }
    }, 1000);
  }

  function connectionStatusText(status) {
    // What this phone cannot do at all outranks what it is waiting for: a
    // browser without Ed25519 will never reach a machine, and saying "waiting
    // to sync" forever would be a lie the User cannot act on.
    if (machineUnavailableReason && (status === "waiting-to-sync" || status === "waiting-for-desktop" || status === "tunnel-reconnecting")) {
      return machineUnavailableReason;
    }
    if (status === "tunnel-reconnecting") {
      return "Tunnel reconnecting";
    }
    if (status === "waiting-for-desktop") {
      return "Waiting for desktop";
    }
    if (status === "waiting-to-sync") {
      return "Waiting to sync";
    }
    return "Synced";
  }

  function relativeTime(iso) {
    const time = Date.parse(iso);
    if (!Number.isFinite(time)) {
      return "";
    }
    const diffMs = Math.max(0, Date.now() - time);
    const minutes = Math.floor(diffMs / 60_000);
    if (minutes < 1) {
      return "now";
    }
    if (minutes < 60) {
      return minutes + "m";
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return hours + "h";
    }
    return Math.floor(hours / 24) + "d";
  }

  // Which picture a member shows is decided by the same code the desktop
  // runs (bundled as mobile-shared.js from src/shared/chatAvatarCatalog.ts):
  // the member's `avatarId` and provider, never a guess from the handle. A
  // member the phone has no record for gets what the desktop gives an unknown
  // author — the provider glyph its name suggests, or initials.
  const CHAT_ASSISTANT_DISPLAY_NAME = "Chat Assistant";

  function mobileSharedRules() {
    return globalThis.AccordMobileShared;
  }

  function avatarAssetUrl(assetId) {
    const shared = mobileSharedRules();
    if (!shared || !assetId) {
      return undefined;
    }
    if (assetId === shared.CHAT_ASSISTANT_AVATAR_ASSET_ID) {
      return "assets/accordagents-mark.png";
    }
    const entry = shared.chatAvatarCatalogEntry(assetId);
    return entry ? "assets/avatars/" + shared.chatAvatarAssetFileName(entry) : undefined;
  }

  function normalizeMemberHandle(value) {
    return String(value || "").trim().replace(/^@/, "").toLowerCase();
  }

  function memberForLabel(members, label) {
    const wanted = normalizeMemberHandle(label);
    if (!wanted) {
      return undefined;
    }
    return (members || []).find(function (member) {
      return normalizeMemberHandle(member.handle) === wanted ||
        normalizeMemberHandle(member.mentionHandle) === wanted ||
        normalizeMemberHandle(member.displayName) === wanted;
    });
  }

  // Without the shared bundle (an old cached shell) the phone can still name
  // the member: initials on a plain disc, the same stand-in the desktop uses
  // while a picture is missing.
  function initialsAvatar(label) {
    const text = String(label || "").trim() || "Agent";
    return { glyphKind: "generic", label: text, mediaMode: "glyph", initials: text.replace(/^@/, "").charAt(0).toUpperCase() || "?" };
  }

  function avatarForMember(member) {
    const shared = mobileSharedRules();
    const label = member.displayName || "@" + member.handle;
    if (!shared) {
      return initialsAvatar(label);
    }
    // A member the list only knows by handle (an older chat list) has no
    // provider to pick a default from; its name is all there is to go on.
    if (member.kind !== "claude-code" && member.kind !== "codex-cli" && member.kind !== "gemini-cli") {
      return shared.resolveChatAvatarByName(label);
    }
    return shared.resolveChatParticipantAvatar(
      { id: member.id, handle: member.handle, kind: member.kind, avatarId: member.avatarId },
      label,
      // The desktop says which member is the assistant; a list from an older
      // desktop is recognised by the name it gave.
      { isAssistant: member.isAssistant === true || label === CHAT_ASSISTANT_DISPLAY_NAME }
    );
  }

  function avatarForLabel(members, label) {
    const member = memberForLabel(members, label);
    if (member) {
      return avatarForMember(member);
    }
    const shared = mobileSharedRules();
    const text = String(label || "").trim() || "Agent";
    return shared ? shared.resolveChatAvatarByName(text) : initialsAvatar(text);
  }

  /** What the frame will show, for change detection: repainting on every
   *  render would restart the image load. */
  function avatarSignature(resolved) {
    return [resolved.glyphKind, resolved.mediaMode, resolved.assetId || "", resolved.customAvatarId || "", resolved.initials || ""].join("\0");
  }

  function clearAvatarKindClasses(avatar) {
    for (const className of [...avatar.classList]) {
      if (className.startsWith("avatar-") && className !== "avatar-icon") {
        avatar.classList.remove(className);
      }
    }
  }

  // One frame contract, the desktop's: the element is the disc, sized by its
  // own class; the picture inside is either a glyph (75%, contained) or a
  // photo (100%, covering). Nothing per member or per surface beyond that.
  function paintAvatar(avatar, resolved, conversationId) {
    const signature = avatarSignature(resolved);
    if (avatar.dataset.avatarSignature === signature) {
      // A drawn avatar still waiting for its bytes is asked for again on a
      // repaint (once the retry pause has passed): a missed answer must not
      // leave initials on a row that is patched in place for the session.
      if (resolved.customAvatarId && avatar.dataset.avatarLoaded !== "1") {
        loadCustomAvatarInto(avatar, conversationId, resolved.customAvatarId, signature);
      }
      return;
    }
    avatar.dataset.avatarSignature = signature;
    delete avatar.dataset.avatarLoaded;
    delete avatar.dataset.avatarCustomId;
    avatar.textContent = "";
    avatar.removeAttribute("style");
    clearAvatarKindClasses(avatar);
    avatar.classList.add("avatar-icon", "avatar-" + resolved.glyphKind);
    avatar.setAttribute("aria-label", resolved.label || "");
    if (resolved.customAvatarId) {
      // Initials stand in until the bytes arrive; a drawn avatar that cannot be
      // fetched (no desktop reachable) stays initials, as on the desktop
      // before its bytes load.
      const initials = document.createElement("span");
      initials.className = "avatar-media avatar-media-glyph";
      initials.textContent = resolved.initials || "?";
      avatar.classList.remove("avatar-custom");
      avatar.classList.add("avatar-generic");
      avatar.append(initials);
      loadCustomAvatarInto(avatar, conversationId, resolved.customAvatarId, signature);
      return;
    }
    const assetUrl = avatarAssetUrl(resolved.assetId);
    if (assetUrl) {
      avatar.append(avatarImage(assetUrl, resolved.mediaMode));
      avatar.dataset.avatarLoaded = "1";
      return;
    }
    const initials = document.createElement("span");
    initials.className = "avatar-media avatar-media-glyph";
    initials.textContent = resolved.initials || "?";
    avatar.append(initials);
    avatar.dataset.avatarLoaded = "1";
  }

  function avatarImage(src, mediaMode) {
    const img = document.createElement("img");
    img.className = "avatar-media avatar-media-" + mediaMode;
    img.src = src;
    img.alt = "";
    img.decoding = "async";
    // A hundred chat rows and eighty message rows are built at once; only
    // the discs on screen need their picture now.
    img.loading = "lazy";
    return img;
  }

  // Drawn avatars live as files on the desktop; the member record names the
  // id and the bytes come once per session, like a picture in a message.
  // Bounded like the picture cache: a drawn avatar can be megabytes.
  const customAvatarDataUrls = new Map();
  const customAvatarFetches = new Map();
  const customAvatarRetryAfter = new Map();
  const CUSTOM_AVATAR_CACHE_MAX_ENTRIES = 24;
  // A desktop that is off answers nothing for the relay's whole wait; asking
  // again on every repaint would keep a request in flight for the session.
  const CUSTOM_AVATAR_RETRY_PAUSE_MS = 60 * 1000;

  function rememberCustomAvatar(avatarId, result) {
    if (customAvatarDataUrls.size >= CUSTOM_AVATAR_CACHE_MAX_ENTRIES) {
      const oldest = customAvatarDataUrls.keys().next();
      if (!oldest.done) {
        customAvatarDataUrls.delete(oldest.value);
      }
    }
    customAvatarDataUrls.set(avatarId, result);
  }

  function loadCustomAvatarInto(avatar, conversationId, customId, signature) {
    const avatarId = "custom:" + customId;
    const cached = customAvatarDataUrls.get(avatarId);
    if (cached) {
      applyCustomAvatar(avatar, cached, signature);
      return;
    }
    avatar.dataset.avatarCustomId = customId;
    if (!customAvatarFetches.has(avatarId)) {
      if ((customAvatarRetryAfter.get(avatarId) || 0) > Date.now()) {
        return;
      }
      const pairing = loadPairing();
      customAvatarFetches.set(avatarId, (async function () {
        if (!pairing || !relayCanSync(pairing) || !conversationId) {
          return "retry";
        }
        const payload = await sendRelayPayload(pairing, "avatar-" + customId + "-" + createEventId(), {
          type: "mobile.avatar.request",
          conversationId: conversationId,
          avatarId: avatarId
        });
        if (payload && payload.type === "mobile.avatar" && typeof payload.dataBase64 === "string") {
          return "data:" + (typeof payload.mimeType === "string" ? payload.mimeType : "image/png") + ";base64," + payload.dataBase64;
        }
        // "unavailable" and "too-large" are answers: initials stay, and the
        // id is not asked for again this session.
        return payload && typeof payload.reason === "string" ? "unavailable" : "retry";
      })().catch(function () {
        return "retry";
      }).then(function (result) {
        if (result !== "retry") {
          rememberCustomAvatar(avatarId, result);
        }
        if (result !== "retry" && !result.startsWith("data:")) {
          // Answered "no" — not asked again while the answer is remembered.
          customAvatarRetryAfter.set(avatarId, Date.now() + CUSTOM_AVATAR_RETRY_PAUSE_MS);
        } else if (result === "retry") {
          customAvatarRetryAfter.set(avatarId, Date.now() + CUSTOM_AVATAR_RETRY_PAUSE_MS);
        }
        customAvatarFetches.delete(avatarId);
        // Every disc on screen that shows this member gets the picture: a row
        // painted while the desktop was unreachable is patched in place and
        // would otherwise keep its initials for the session.
        for (const node of document.querySelectorAll('[data-avatar-custom-id="' + CSS.escape(customId) + '"]')) {
          applyCustomAvatar(node, result, node.dataset.avatarSignature);
        }
        return result;
      }));
    }
    customAvatarFetches.get(avatarId).then(function (result) {
      if (avatar.isConnected && avatar.dataset.avatarSignature === signature) {
        applyCustomAvatar(avatar, result, signature);
      }
    });
  }

  function applyCustomAvatar(avatar, result, signature) {
    if (typeof result !== "string" || !result.startsWith("data:")) {
      return;
    }
    if (avatar.dataset.avatarSignature !== signature || avatar.dataset.avatarLoaded === "1") {
      return;
    }
    avatar.textContent = "";
    avatar.classList.remove("avatar-generic");
    avatar.classList.add("avatar-custom");
    avatar.append(avatarImage(result, "photo"));
    avatar.dataset.avatarLoaded = "1";
  }

  function renderMessageContent(container, markdown) {
    container.textContent = "";
    container.classList.add("markdown-text");
    const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) {
        index += 1;
        continue;
      }
      if (line.trim().startsWith("```")) {
        const language = line.trim().slice(3).trim();
        const codeLines = [];
        index += 1;
        while (index < lines.length && !lines[index].trim().startsWith("```")) {
          codeLines.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) {
          index += 1;
        }
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        if (language) {
          code.dataset.language = language;
        }
        code.textContent = codeLines.join("\n");
        pre.append(code);
        container.append(pre);
        continue;
      }
      const unordered = line.match(/^\s*[-*]\s+(.+)$/);
      if (unordered) {
        const list = document.createElement("ul");
        while (index < lines.length) {
          const item = lines[index].match(/^\s*[-*]\s+(.+)$/);
          if (!item) {
            break;
          }
          const li = document.createElement("li");
          appendInlineMarkdown(li, item[1]);
          list.append(li);
          index += 1;
        }
        container.append(list);
        continue;
      }
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (ordered) {
        const list = document.createElement("ol");
        while (index < lines.length) {
          const item = lines[index].match(/^\s*\d+[.)]\s+(.+)$/);
          if (!item) {
            break;
          }
          const li = document.createElement("li");
          appendInlineMarkdown(li, item[1]);
          list.append(li);
          index += 1;
        }
        container.append(list);
        continue;
      }
      const paragraphLines = [];
      while (index < lines.length && lines[index].trim()) {
        if (lines[index].trim().startsWith("```") ||
          /^\s*[-*]\s+/.test(lines[index]) ||
          /^\s*\d+[.)]\s+/.test(lines[index])) {
          break;
        }
        paragraphLines.push(lines[index]);
        index += 1;
      }
      const paragraph = document.createElement("p");
      appendInlineMarkdown(paragraph, paragraphLines.join("\n"));
      container.append(paragraph);
    }
  }

  function appendInlineMarkdown(parent, text) {
    const source = String(text || "");
    const pattern = /(`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*([^*]+)\*)/g;
    let cursor = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      appendPlainText(parent, source.slice(cursor, match.index));
      if (match[2] !== undefined) {
        const code = document.createElement("code");
        code.textContent = match[2];
        parent.append(code);
      } else if (match[3] !== undefined) {
        const strong = document.createElement("strong");
        appendPlainText(strong, match[3]);
        parent.append(strong);
      } else if (match[4] !== undefined && match[5] !== undefined) {
        const anchor = document.createElement("a");
        anchor.href = match[5];
        anchor.target = "_blank";
        anchor.rel = "noreferrer";
        appendPlainText(anchor, match[4]);
        parent.append(anchor);
      } else if (match[6] !== undefined) {
        const em = document.createElement("em");
        appendPlainText(em, match[6]);
        parent.append(em);
      }
      cursor = pattern.lastIndex;
    }
    appendPlainText(parent, source.slice(cursor));
  }

  /** What a member's message shows. The desktop hides the control blocks it
   *  turns into its own controls — the `User choice:` block that becomes the
   *  card below the message — and the phone shows the same message, so it
   *  applies the same rule, from the same shared module rather than a copy of
   *  its own. */
  function displayedMessageText(content, author) {
    const text = typeof content === "string" ? content : "";
    // The desktop applies this to a member's message only: what the User typed
    // is her own words, even when a line of it happens to start "User choice:".
    if (author !== undefined && author !== "agent") {
      return text;
    }
    const shared = self.AccordMobileShared;
    return shared && typeof shared.stripChatControlBlocks === "function"
      ? shared.stripChatControlBlocks(text)
      : text;
  }

  function renderMessageContentIfChanged(container, markdown, author) {
    // Compared before the rule runs: reconciling every row on every redraw
    // must not re-strip every message of a long chat to find nothing changed.
    const raw = String(markdown || "");
    if (container.dataset.markdownRaw === raw) {
      return;
    }
    let source = displayedMessageText(raw, author);
    // A message that is nothing but the block it asked its question with: the
    // card carries the question, and an empty bubble with a timestamp says
    // nothing about what happened. Only when a question was in fact asked —
    // a message that was nothing but "Participant requests: none." asked
    // nothing, and said so wrongly.
    if (!source.trim() && /^\s*user choice\s*:/im.test(raw)) {
      source = "Asked you a question.";
    }
    container.dataset.markdownRaw = raw;
    if (container.dataset.markdownSource === source) {
      return;
    }
    renderMessageContent(container, source);
    container.dataset.markdownSource = source;
  }

  function appendPlainText(parent, text) {
    const parts = String(text || "").split("\n");
    parts.forEach(function (part, index) {
      if (index > 0) {
        parent.append(document.createElement("br"));
      }
      if (part) {
        parent.append(document.createTextNode(part));
      }
    });
  }

  // Which projects are folded in the chat list. Persisted: the phone reopens
  // the app many times a day, and a second project that takes a long scroll to
  // reach every time was the complaint. The desktop folds its project groups
  // the same way, with the same chevron.
  const COLLAPSED_CHAT_GROUPS_KEY = "accordagents.mobile.collapsedChatGroups.v1";

  function loadCollapsedChatGroups() {
    try {
      const raw = localStorage.getItem(COLLAPSED_CHAT_GROUPS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter(function (name) { return typeof name === "string"; }) : [];
    } catch {
      return [];
    }
  }

  function toggleChatGroupCollapsed(name) {
    const current = loadCollapsedChatGroups();
    const next = current.indexOf(name) >= 0
      ? current.filter(function (item) { return item !== name; })
      : current.concat([name]);
    try {
      localStorage.setItem(COLLAPSED_CHAT_GROUPS_KEY, JSON.stringify(next));
    } catch {
      // Storage full or unavailable: the fold is lost with the tap, not the app.
    }
  }

  function groupedChats(chats) {
    const groups = [];
    const groupByName = new Map();
    for (const chat of chats) {
      const name = chat.group || "AccordAgents";
      let group = groupByName.get(name);
      if (!group) {
        group = { name, items: [] };
        groupByName.set(name, group);
        groups.push(group);
      }
      group.items.push(chat);
    }
    return groups;
  }

  // The search filters what the phone already holds: title, who wrote last
  // and what they wrote. It never asks the desktop.
  let chatSearchQuery = "";

  function chatMatchesQuery(chat, query) {
    const needle = String(query || "").trim().toLowerCase();
    if (!needle) {
      return true;
    }
    return [chat.title, chat.who, chat.snippet, chat.group].some(function (field) {
      return typeof field === "string" && field.toLowerCase().includes(needle);
    });
  }

  function filterChatsByQuery(chats, query) {
    return chats.filter(function (chat) {
      return chatMatchesQuery(chat, query);
    });
  }

  /** Opens a chat, or one thread in it, and asks for its latest page. The
   *  chat list and Activity both land here, so a chat opened from either is
   *  fetched the same way. */
  function openConversation(conversationId, options) {
    const rootId = options && options.threadRootId ? options.threadRootId : undefined;
    pendingThreadOpen = rootId ? { conversationId: conversationId, rootId: rootId } : undefined;
    setOpenThreadRootId(rootId);
    localStorage.setItem(ACTIVE_CONVERSATION_KEY, conversationId);
    // A new visit reads the chat again: rows held from an earlier visit are
    // exactly what a late read must not be able to bring back.
    dropCachedChatRows();
    return render("synced").then(function () {
      const pairing = loadPairing();
      if (pairing && relayCanSync(pairing)) {
        return requestTimelineViaRelay(pairing, conversationId).then(function () {
          return render("synced");
        }).catch(function () {
          return render("tunnel-reconnecting");
        }).then(function () {
          return pollMailboxTimeline().catch(function () {
            return 0;
          });
        }).then(function () {
          return render("synced");
        });
      }
      return pollMailboxTimeline().catch(function () {
        return 0;
      }).then(function () {
        return render("synced");
      });
    });
  }

  /** The chat list's subtitle is the desktop's 84-character cut of the last
   *  message with its line breaks already collapsed, so the line-based rule
   *  cannot find the block inside it: what follows the marker on that one line
   *  is protocol, and the User should read the sentence before it instead. Her
   *  own messages and the app's are left exactly as they are, as the desktop
   *  leaves them. */
  function snippetDisplayText(chat) {
    const snippet = typeof chat.snippet === "string" ? chat.snippet : "";
    const who = typeof chat.who === "string" ? chat.who.trim().toLowerCase() : "";
    if (who === "you:" || who === "system:") {
      return snippet;
    }
    const cut = snippet.replace(/\s*user choice\s*:.*$/i, "").trim();
    return cut || "Asked you a question";
  }

  function renderChatList() {
    const listContainer = document.getElementById("chat-list");
    if (listContainer) {
      delete listContainer.dataset.state;
    }
    const container = document.getElementById("chat-list");
    if (!container) {
      return;
    }
    const allChats = loadChats();
    const chats = filterChatsByQuery(allChats, chatSearchQuery);
    const activeId = selectedConversationId();
    const unreadIds = loadUnreadConversationIds();
    // A search shows everything it matches; folding applies to the plain list,
    // and the headers are plain labels while a search is open so a tap cannot
    // change a fold it does not show.
    const searching = Boolean(chatSearchQuery.trim());
    const collapsedGroups = searching ? [] : loadCollapsedChatGroups();
    const renderSignature = JSON.stringify({
      activeId,
      query: chatSearchQuery,
      unreadIds,
      collapsedGroups,
      chats: chats.map(function (chat) {
        return {
          id: chat.id,
          title: chat.title,
          group: chat.group,
          snippet: chat.snippet,
          who: chat.who,
          running: chat.running,
          updatedAt: chat.updatedAt,
          participants: chat.participants,
          // What each row's avatars are drawn from: a member's changed picture
          // must repaint the row even when nothing else about the chat moved.
          members: chatMembers(chat).map(function (member) {
            return [member.handle, member.kind, member.avatarId || "", member.isAssistant === true];
          })
        };
      })
    });
    if (lastChatListRenderSignature === renderSignature) {
      return;
    }
    lastChatListRenderSignature = renderSignature;
    container.textContent = "";
    if (allChats.length > 0 && chats.length === 0) {
      const empty = document.createElement("div");
      empty.className = "mobile-empty";
      empty.textContent = "No chats match “" + chatSearchQuery.trim() + "”.";
      container.append(empty);
      return;
    }
    if (chats.length === 0) {
      const empty = document.createElement("div");
      empty.className = "mobile-empty";
      if (!relayCanSync(loadPairing())) {
        empty.textContent = "Scan the desktop QR to connect this phone.";
      } else {
        empty.textContent = "";
        const line = document.createElement("div");
        line.className = "sync-progress";
        line.dataset.startedAt = syncWaitStartedAt();
        line.textContent = syncProgressText(line.dataset.startedAt);
        empty.append(line);
      }
      container.append(empty);
      return;
    }
    for (const group of groupedChats(chats)) {
      const collapsed = collapsedGroups.indexOf(group.name) >= 0;
      const title = document.createElement(searching ? "div" : "button");
      title.className = "mobile-chat-group-title";
      title.dataset.group = group.name;
      const name = document.createElement("span");
      name.className = "mobile-chat-group-name";
      name.textContent = group.name;
      if (searching) {
        title.append(name);
      } else {
        title.type = "button";
        title.setAttribute("aria-expanded", collapsed ? "false" : "true");
        const chevron = document.createElement("span");
        chevron.className = "mobile-chat-group-chevron";
        chevron.setAttribute("aria-hidden", "true");
        title.append(chevron, name);
      }
      if (collapsed) {
        // Folded away, not silenced: the count says what is inside, and a
        // fresh message in a folded project still shows its dot here.
        const count = document.createElement("span");
        count.className = "mobile-chat-group-count";
        count.textContent = String(group.items.length);
        title.append(count);
        if (group.items.some(function (chat) { return unreadIds.indexOf(chat.id) >= 0; })) {
          const dot = document.createElement("span");
          dot.className = "mobile-unread-dot";
          dot.setAttribute("aria-label", "Unread messages");
          title.append(dot);
        }
      }
      if (!searching) {
        title.addEventListener("click", function () {
          toggleChatGroupCollapsed(group.name);
          renderChatList();
        });
      }
      if (collapsed) {
        container.append(title);
        continue;
      }
      const list = document.createElement("div");
      list.className = "mobile-chat-group";
      for (const chat of group.items) {
        const row = document.createElement("button");
        const unread = unreadIds.indexOf(chat.id) >= 0;
        row.className = "mobile-chat-row" + (chat.id === activeId ? " is-active" : "") + (unread ? " is-unread" : "");
        row.type = "button";
        row.dataset.conversationId = chat.id;
        if (unread) {
          row.dataset.unread = "1";
        }
        row.addEventListener("click", function () {
          openConversation(chat.id);
        });
        const avatars = document.createElement("div");
        avatars.className = "mobile-chat-avatars";
        // A chat row that arrives without a participants array must not take
        // the whole list down with it.
        const chatParticipants = Array.isArray(chat.participants) ? chat.participants : [];
        const participants = chatParticipants.length > 0 ? chatParticipants : [chat.title];
        const rowMembers = chatMembers(chat);
        participants.slice(0, 2).forEach(function (participant) {
          const avatar = document.createElement("span");
          avatar.className = "mobile-chat-avatar";
          paintAvatar(avatar, avatarForLabel(rowMembers, participant), chat.id);
          avatars.append(avatar);
        });
        const copy = document.createElement("div");
        copy.className = "mobile-chat-copy";
        const titleLine = document.createElement("div");
        titleLine.className = "mobile-chat-title-line";
        const strong = document.createElement("strong");
        strong.textContent = chat.title;
        titleLine.append(strong);
        if (chat.running) {
          const live = document.createElement("span");
          live.className = "mobile-live-dot";
          titleLine.append(live);
        }
        if (unread) {
          const dot = document.createElement("span");
          dot.className = "mobile-unread-dot";
          dot.setAttribute("aria-label", "New activity");
          titleLine.append(dot);
        }
        const snippet = document.createElement("div");
        snippet.className = "mobile-chat-snippet";
        if (chat.who) {
          const who = document.createElement("b");
          who.textContent = chat.who;
          snippet.append(who);
        }
        const snippetText = document.createElement("span");
        snippetText.textContent = snippetDisplayText(chat);
        snippet.append(snippetText);
        copy.append(titleLine, snippet);
        const when = document.createElement("div");
        when.className = "mobile-chat-time";
        when.textContent = relativeTime(chat.updatedAt);
        row.append(avatars, copy, when);
        list.append(row);
      }
      container.append(title, list);
    }
  }

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
  let lastScrolledConversationId;
  let lastRenderedThreadRootId;
  let lastRowsFingerprint;

  function openThreadRootId() {
    const value = sessionStorage.getItem(OPEN_THREAD_KEY);
    return value && value !== "none" ? value : undefined;
  }

  // The follow target is a pair: the run id the row advertised at tap time,
  // plus the mobile event id of the message that run answers. The answering
  // run streams under a fresh id of its own, so the event id is the only key
  // that survives the placeholder being replaced by real text.
  function openStreamFollow() {
    const value = sessionStorage.getItem(OPEN_STREAM_KEY);
    if (!value || value === "none") {
      return undefined;
    }
    const parts = value.split("\u0000");
    return { runId: parts[0], mobileEventId: parts[1] || undefined };
  }

  function setOpenStreamRunId(runId, mobileEventId) {
    if (runId) {
      sessionStorage.setItem(OPEN_STREAM_KEY, mobileEventId ? runId + "\u0000" + mobileEventId : runId);
    } else {
      sessionStorage.removeItem(OPEN_STREAM_KEY);
    }
  }

  function setOpenThreadRootId(rootId) {
    if (rootId) {
      sessionStorage.setItem(OPEN_THREAD_KEY, rootId);
    } else {
      sessionStorage.removeItem(OPEN_THREAD_KEY);
    }
  }

  // Replies are hidden behind their root on the main list and shown in full
  // once that thread is opened, matching how the desktop collapses them.
  function groupRowsIntoThreads(rows, openThreadRoot) {
    const replyCountByRoot = new Map();
    const latestReplyAtByRoot = new Map();
    for (const row of rows) {
      if (!row.threadRootId) {
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
  function renderThreadHeader(openThreadRoot) {
    const composerInput = document.getElementById("composer-input");
    if (composerInput) {
      const placeholder = openThreadRoot ? "Add a reply..." : "Message the room...";
      if (composerInput.placeholder !== placeholder) {
        composerInput.placeholder = placeholder;
      }
    }
    const back = document.getElementById("back-to-timeline");
    const backToChats = document.getElementById("back-to-chats");
    const title = document.getElementById("chat-title");
    if (!back) {
      return;
    }
    const shouldShow = Boolean(openThreadRoot);
    if (back.classList.contains("is-visible") !== shouldShow) {
      back.classList.toggle("is-visible", shouldShow);
    }
    if (backToChats && backToChats.hidden !== shouldShow) {
      backToChats.hidden = shouldShow;
    }
    if (openThreadRoot && title) {
      title.textContent = "Thread";
    }
  }

  /** The offer to answer this message, on the screen the message opens on.
   *  Shown for a thread that has not been answered yet: once there are
   *  replies, the composer below is self-evident and the row is noise. */
  function renderThreadReplyAction(openThreadRoot, rowCount) {
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

  function threadSurface() {
    return document.querySelector("#timeline-screen .thread-surface");
  }

  function isNearBottom(surface) {
    if (!surface) {
      return true;
    }
    return surface.scrollHeight - surface.scrollTop - surface.clientHeight <= bottomThresholdPx();
  }

  /** A change that makes the chat taller or shorter — the keyboard arriving,
   *  the bar coming back — must not move a reader who was at the latest
   *  message away from it, and must leave a reader up in history where they
   *  are. Stated once so the places that resize cannot disagree. */
  function keepingReaderAtLatest(change) {
    const wasAtLatest = isNearBottom(threadSurface());
    change();
    if (wasAtLatest) {
      scrollToLatestWhenSettled("auto");
    }
  }

  function setJumpToLatestVisible(visible) {
    const button = document.getElementById("jump-to-latest");
    if (button) {
      button.classList.toggle("is-visible", Boolean(visible));
    }
  }

  function scrollToLatest(behavior) {
    const surface = threadSurface();
    if (!surface) {
      return;
    }
    surface.scrollTo({ top: surface.scrollHeight, behavior: behavior || "auto" });
    setJumpToLatestVisible(false);
  }

  // Rows grow after mount: markdown reflows and avatars decode. Scrolling once
  // lands short, so settle again on the next frame.
  function scrollToLatestWhenSettled(behavior) {
    requestAnimationFrame(function () {
      scrollToLatest(behavior);
      requestAnimationFrame(function () {
        scrollToLatest(behavior);
      });
    });
  }

  // An installed home-screen app gets its own storage on iOS, so it starts with
  // no pairing even though Safari has one. Say that plainly instead of showing
  // an empty list with dead buttons. The same screen serves re-pairing after a
  // revoke: the QR scan and paste box are the no-hand-copy path to a new link.
  function renderUnpairedNotice(noticeText, stateTag) {
    const state = stateTag || "unpaired";
    const container = document.getElementById("chat-list");
    if (!container || container.dataset.state === state) {
      return;
    }
    container.dataset.state = state;
    container.textContent = "";

    const notice = document.createElement("div");
    notice.className = "mobile-empty";
    notice.textContent = noticeText ||
      ("Paste the pairing link from the desktop app to connect this device. " +
      "An installed app has its own storage, so it pairs separately from the browser.");

    const form = document.createElement("form");
    form.className = "pairing-form";
    const input = document.createElement("input");
    input.type = "url";
    input.className = "pairing-input";
    input.placeholder = "https://mobile.accordagents.com/?v=1&rid=…";
    input.autocomplete = "off";
    input.autocapitalize = "off";
    input.spellcheck = false;
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "pairing-submit";
    submit.textContent = "Pair this device";
    const error = document.createElement("p");
    error.className = "pairing-error";

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) {
        return;
      }
      try {
        // Same parser the app uses when opened via the link, so a pasted link
        // and a tapped link produce exactly the same pairing.
        const paired = readBootstrapFromLocation({ href: value });
        if (!paired) {
          throw new Error("That link does not contain pairing details.");
        }
        mailboxAuthRejected = false;
        delete container.dataset.state;
        void render();
      } catch (parseError) {
        error.textContent = parseError instanceof Error
          ? parseError.message
          : "That link could not be read. Copy it again from the desktop app.";
      }
    });

    const scan = document.createElement("button");
    scan.type = "button";
    scan.className = "pairing-scan";
    scan.textContent = "Scan QR code";
    const scanner = document.createElement("div");
    scanner.className = "pairing-scanner";
    const video = document.createElement("video");
    video.setAttribute("playsinline", "");
    video.muted = true;
    scanner.append(video);

    scan.addEventListener("click", function () {
      void startPairingScan(video, scanner, error, function (decoded) {
        input.value = decoded;
        form.dispatchEvent(new Event("submit", { cancelable: true }));
      });
    });

    form.append(input, submit);
    container.append(notice, scan, scanner, form, error);
  }

  // Scanning happens inside the app because iOS opens a camera-scanned link in
  // Safari, which cannot reach an installed home-screen app's storage.
  async function startPairingScan(video, scanner, error, onDecoded) {
    if (typeof jsQR !== "function") {
      error.textContent = "The QR reader did not load. Paste the link instead.";
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" }
      });
    } catch {
      error.textContent = "Camera access was refused. Paste the link instead.";
      return;
    }
    error.textContent = "";
    scanner.classList.add("is-active");
    video.srcObject = stream;
    await video.play().catch(function () {
      return undefined;
    });
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const stop = function () {
      scanner.classList.remove("is-active");
      for (const track of stream.getTracks()) {
        track.stop();
      }
    };
    const deadline = Date.now() + 60_000;
    const tick = function () {
      if (!scanner.classList.contains("is-active")) {
        return;
      }
      if (Date.now() > deadline) {
        stop();
        error.textContent = "No code found. Try again, or paste the link.";
        return;
      }
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const frame = context.getImageData(0, 0, canvas.width, canvas.height);
        const found = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: "dontInvert" });
        if (found && found.data) {
          stop();
          onDecoded(found.data);
          return;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }


  // --- cards a member is waiting on -----------------------------------------

  /** The chat action a tapped card produces. The shape is the one every device
   *  emits, so the desktop records and applies it exactly as it would its own —
   *  including the native identifiers the provider needs back. */
  async function decisionEventForCard(card, answer) {
    if (card.kind === "permission") {
      const approve = answer.optionId === "allow";
      return {
        kind: "permission.decided",
        payload: {
          operationId: "permission:" + card.id + ":" + (approve ? "allow" : "deny"),
          targetKey: "approval:" + card.id,
          stateId: approve ? "approved" : "denied",
          detail: {
            approve: approve,
            ...(card.codexDecisionId ? { codexDecisionId: card.codexDecisionId } : {}),
            ...(card.draftOverride ? { draftOverride: card.draftOverride } : {})
          }
        }
      };
    }
    const value = answer.cancel ? "cancelled" : answer.optionId || (answer.customAnswer ? "custom" : "empty");
    const identity = answer.customAnswer !== undefined || answer.note !== undefined
      ? value + ":" + await sha256Hex(stableJson({ customAnswer: answer.customAnswer, note: answer.note })) : value;
    return {
      kind: "choice.answered",
      payload: {
        operationId: "choice:" + card.id + ":" + identity,
        targetKey: "choice:" + card.id,
        stateId: value,
        detail: {
          sourceMessageId: card.sourceMessageId || "",
          ...(answer.optionId ? { selectedOptionId: answer.optionId } : {}),
          ...(answer.customAnswer !== undefined ? { customAnswer: answer.customAnswer } : {}),
          ...(answer.note !== undefined ? { note: answer.note } : {}),
          ...(answer.cancel ? { cancel: true } : {})
        }
      }
    };
  }

  /**
   * Answering a card: the event and the queue entry are written in one
   * IndexedDB transaction, then the queue is flushed. A tap is not the answer
   * being applied — the card says "sent" until the desktop states it answered.
   */
  async function answerControlCard(card, answer) {
    const conversationId = card.conversationId || selectedConversationId();
    if (!conversationId) return;
    // One answer per card. Hashing and the database come before the "sent"
    // mark, so a second tap in that gap (Allow, then Deny beside it) would
    // otherwise queue a second, contradicting decision.
    if (controlCardAnswering.has(card.id) || isCardLocked(card.id)) return;
    controlCardAnswering.add(card.id);
    try {
      await answerControlCardOnce(card, answer, conversationId);
    } finally {
      controlCardAnswering.delete(card.id);
      // An answer that could not be saved leaves the options live again.
      if (controlCardErrors.has(card.id) && !isCardLocked(card.id)) void render();
    }
  }

  async function answerControlCardOnce(card, answer, conversationId) {
    const decision = await decisionEventForCard(card, answer);
    await supersedeQueuedAnswer(card.id);
    let queued;
    try {
      queued = await enqueueDecision({ conversationId: conversationId, kind: decision.kind, payload: decision.payload });
    } catch (error) {
      controlCardErrors.set(card.id, "Could not save your answer on this phone. Try again.");
      await render("waiting-to-sync");
      return;
    }
    controlCardErrors.delete(card.id);
    markCardSent(card.id, queued && queued.eventId);
    await render("waiting-to-sync");
    const flushResult = await flushOutbox();
    if (desktopDidNotTake(flushResult.status)) {
      await commandMachineAction(conversationId, decision).catch(function (error) {
        // Sent is not applied: if it could not even be handed over, the card
        // says so rather than showing an answer that went nowhere.
        clearCardSent(card.id);
        controlCardErrors.set(card.id, "Not delivered yet: " + String(error && error.message || error));
      });
    }
    await pollMailboxTimeline().catch(function () { return 0; });
    await render(flushResult.status);
  }

  /** The desktop did not take this: it is not there, or its tunnel is down. */
  function desktopDidNotTake(status) {
    return status === "waiting-for-desktop" || status === "tunnel-reconnecting" || status === "waiting-to-sync";
  }

  function enqueueDecision(input) {
    return createOutboxEvent({
      conversationId: input.conversationId,
      kind: input.kind,
      payload: input.payload
    }).then(persistOutboundEvent);
  }

  let controlCardSentCache;

  function loadCardSentMarks() {
    if (controlCardSentCache) return controlCardSentCache;
    try {
      const parsed = JSON.parse(localStorage.getItem(CONTROL_CARD_SENT_KEY) || "{}");
      controlCardSentCache = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      controlCardSentCache = {};
    }
    return controlCardSentCache;
  }

  function saveCardSentMarks(marks) {
    controlCardSentCache = marks;
    setStoredValue(CONTROL_CARD_SENT_KEY, JSON.stringify(marks));
  }

  function isCardSent(cardId) {
    return Boolean(cardId) && Object.prototype.hasOwnProperty.call(loadCardSentMarks(), cardId);
  }

  function markCardSent(cardId, eventId) {
    const marks = { ...loadCardSentMarks() };
    marks[cardId] = { at: nowIso(), ...(eventId ? { eventId: eventId } : {}) };
    saveCardSentMarks(marks);
  }

  function clearCardSent(cardId) {
    const marks = loadCardSentMarks();
    if (!Object.prototype.hasOwnProperty.call(marks, cardId)) return;
    const next = { ...marks };
    delete next[cardId];
    saveCardSentMarks(next);
  }

  /** What the card says about an answer given on this phone: handed over to
   *  the desktop, or still only saved here. The queue entry the mark names
   *  says which; an entry this phone has not read yet counts as handed over
   *  rather than alarming the User over a cache miss. A mark this old with
   *  the card still waiting has stopped meaning anything — the answer was
   *  lost on its way or refused — so the card unlocks and says so, rather
   *  than showing dead buttons for ever. */
  function cardSentState(cardId) {
    const mark = loadCardSentMarks()[cardId];
    if (!mark) return undefined;
    const held = mark.eventId ? outboxStatusById.get(mark.eventId) : undefined;
    if (held && held.status === "refused") return { locked: false, text: CONTROL_CARD_REFUSED_TEXT };
    const at = Date.parse(mark.at || "");
    // An answer nobody has taken yet may be lost, and ten minutes of that
    // unlocks the card. One the desktop or the mailbox has taken is not lost:
    // it is applied when the desktop is next up, and a second answer given
    // meanwhile only raced it — the older one won on the desktop and the
    // User's later one was quietly discarded. That answer waits a day before
    // the card unlocks, for the rare desktop that took it and then forgot.
    const owed = !held || desktopOwesEntry(held);
    const unlockAfterMs = owed ? CONTROL_CARD_SENT_UNLOCK_MS : CONTROL_CARD_TAKEN_UNLOCK_MS;
    const stale = !Number.isFinite(at) || Date.now() - at > unlockAfterMs;
    if (stale) return { locked: false, text: CONTROL_CARD_STALE_TEXT };
    return { locked: true, text: held && held.status !== "acked" ? CONTROL_CARD_SAVED_TEXT : CONTROL_CARD_SENT_TEXT };
  }

  /** An earlier answer to the card still on its way is replaced, not raced:
   *  both travelling would let the older one win on the desktop and record
   *  the User's later one as superseded. The entry stays in the journal, so
   *  the sequence this phone signs is unbroken; it is simply never offered. */
  function supersedeQueuedAnswer(cardId) {
    const mark = loadCardSentMarks()[cardId];
    if (!mark || !mark.eventId) return Promise.resolve(false);
    return withOutbox("readwrite", function (store) {
      return requestToPromise(store.get(mark.eventId)).then(function (entry) {
        if (!entry || !desktopOwesEntry(entry)) return false;
        const replaced = { ...entry, status: "superseded", updatedAt: nowIso() };
        noteOutboxStatus(replaced);
        return requestToPromise(store.put(replaced)).then(function () { return true; });
      });
    }).catch(function () { return false; });
  }

  function cardSentText(cardId) {
    const state = cardSentState(cardId);
    return state ? state.text : "";
  }

  /** Whether the card's options are dead because an answer is on its way. */
  function isCardLocked(cardId) {
    const state = cardSentState(cardId);
    return Boolean(state && state.locked);
  }

  const controlCardErrors = new Map();
  // Cards whose answer is being written right now, before it is "sent".
  const controlCardAnswering = new Set();
  // Deliberately not "answered": the phone knows it sent the answer, not that
  // the provider was told. The card leaves when the desktop says so.
  const CONTROL_CARD_SENT_TEXT = "Answer sent. Waiting for the machine to apply it.";
  const CONTROL_CARD_SAVED_TEXT = "Answer saved on this phone. Not delivered yet.";
  const CONTROL_CARD_STALE_TEXT = "Answer sent, but not applied yet. You can answer again.";
  const CONTROL_CARD_REFUSED_TEXT = "The desktop did not take this answer. You can answer again.";
  // How long an answer may stay on its way before the card is offered again.
  const CONTROL_CARD_SENT_UNLOCK_MS = 10 * 60_000;
  // For an answer the desktop or the mailbox has taken: see cardSentState.
  const CONTROL_CARD_TAKEN_UNLOCK_MS = 24 * 60 * 60_000;

  function renderControlCards(conversationId) {
    const host = document.getElementById("control-cards");
    if (!host) return;
    const cards = controlCardsFor(conversationId).filter(function (card) {
      return card && card.status === "pending";
    });
    host.replaceChildren();
    host.hidden = cards.length === 0;
    for (const card of cards) {
      host.append(controlCardElement(card));
    }
  }

  function controlCardElement(card) {
    const wrap = document.createElement("article");
    wrap.className = "control-card";
    wrap.dataset.cardId = card.id;
    wrap.dataset.cardKind = card.kind;

    const head = document.createElement("div");
    head.className = "control-card-head";
    const title = document.createElement("span");
    title.className = "control-card-title";
    title.textContent = card.title || (card.kind === "permission" ? "Permission request" : "Choice");
    head.append(title);
    if (card.requesterLabel || card.machineName) {
      const who = document.createElement("span");
      who.className = "control-card-who";
      who.textContent = [card.requesterLabel, card.machineName].filter(Boolean).join(" · ");
      head.append(who);
    }
    wrap.append(head);

    if (card.summary) {
      const summary = document.createElement("p");
      summary.className = "control-card-summary";
      summary.textContent = card.summary;
      wrap.append(summary);
    }

    const sent = isCardLocked(card.id) || controlCardAnswering.has(card.id);
    const options = document.createElement("div");
    options.className = "control-card-options";
    for (const option of Array.isArray(card.options) ? card.options : []) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "control-card-option";
      button.dataset.optionId = option.id;
      button.textContent = option.label || option.id;
      button.disabled = sent;
      button.addEventListener("click", function () {
        void answerControlCard(card, { optionId: option.id });
      });
      options.append(button);
    }
    if (card.allowsCancel) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "control-card-option";
      cancel.dataset.optionId = "cancel";
      cancel.textContent = "Cancel";
      cancel.disabled = sent;
      cancel.addEventListener("click", function () {
        void answerControlCard(card, { cancel: true });
      });
      options.append(cancel);
    }
    wrap.append(options);

    if (card.allowsCustomAnswer) {
      const custom = document.createElement("div");
      custom.className = "control-card-custom";
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "Answer in your own words";
      input.setAttribute("aria-label", "Answer in your own words");
      input.disabled = sent;
      // The keyboard this field raises takes the bar with it, as the
      // composer's does, and gives it back the same way.
      input.addEventListener("focus", function () { keepingReaderAtLatest(applyDock); });
      input.addEventListener("blur", function () { keepingReaderAtLatest(applyDock); });
      const send = document.createElement("button");
      send.type = "button";
      send.className = "control-card-option";
      send.textContent = "Send";
      send.disabled = sent;
      send.addEventListener("click", function () {
        const text = input.value.trim();
        if (!text) return;
        void answerControlCard(card, { customAnswer: text });
      });
      custom.append(input, send);
      wrap.append(custom);
    }

    const state = document.createElement("p");
    state.className = "control-card-state";
    const failure = controlCardErrors.get(card.id);
    state.textContent = failure || cardSentText(card.id);
    state.hidden = !state.textContent;
    wrap.append(state);
    return wrap;
  }


  // --- home: the bottom bar, Activity and Settings ---------------------------
  //
  // With no chat open the phone shows one of three home tabs, switched by the
  // floating bar at the bottom: Chats, Activity and Settings. Activity lists
  // what the relay already delivered (see mobile-activity.js), so it works the
  // same whether the desktop is answering right now or not.

  const HOME_TABS = ["chats", "activity", "settings"];
  const ACTIVITY_TABS = ["running", "pending", "finished"];
  const ACTIVITY_TAB_LABELS = { running: "Running", pending: "Pending", finished: "Finished" };
  const SVG_NS = "http://www.w3.org/2000/svg";
  // A copy of the week's rows is kept until the store changes, and refreshed at
  // least this often in case another window of the app wrote to it.
  const ACTIVITY_CACHE_MAX_AGE_MS = 60_000;
  // A tap that lands this soon after the list was redrawn may have been aimed
  // at a row that has since moved; answering is too consequential to guess.
  const ACTIVITY_TAP_GUARD_MS = 450;
  // What the User cleared from Activity on this phone, by row key and the
  // moment she cleared it. Local to the device, as the desktop's Clear is.
  const ACTIVITY_CLEARED_KEY = "accordagents.mobile.activityCleared.v1";
  // How far a row slides to show its action, and how far a finger must travel
  // before the list stops treating the gesture as a scroll.
  const SWIPE_ACTION_WIDTH = 88;
  const SWIPE_START_PX = 12;
  // A batch for a chat the stored list does not have asks for the list again,
  // at most this often.
  const CHAT_LIST_REFRESH_MIN_MS = 60_000;

  function setStoredValue(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // A full quota must not stop the bar from switching; the choice is just
      // not remembered.
    }
  }

  // The chat's own dialogs: while one is open the bar is not there to be
  // tapped behind it.
  const CHAT_DIALOG_IDS = ["image-viewer", "members-sheet"];

  const SCREEN_IDS = {
    chats: "chats-screen",
    activity: "activity-screen",
    settings: "settings-screen",
    timeline: "timeline-screen"
  };

  // What the User picked this session wins over what storage holds, so a
  // write refused by a full quota does not flip the bar straight back.
  let currentHomeTab;
  let currentActivityTab;

  function homeTab() {
    if (currentHomeTab) return currentHomeTab;
    const stored = localStorage.getItem(HOME_TAB_KEY);
    return HOME_TABS.indexOf(stored) >= 0 ? stored : "chats";
  }

  function setHomeTab(tab) {
    if (HOME_TABS.indexOf(tab) < 0) return;
    currentHomeTab = tab;
    setStoredValue(HOME_TAB_KEY, tab);
  }

  function setActivityTab(tab) {
    currentActivityTab = tab;
    setStoredValue(ACTIVITY_TAB_KEY, tab);
  }

  /** Leaving the open chat, the one way the back button and the bar's tabs
   *  both take: the thread is left first, then the chat, so a redraw in
   *  between cannot land on a thread of a chat that is no longer open. */
  function leaveOpenChat() {
    if (!selectedConversationId()) return;
    closeMembersSheet();
    closeImageViewer();
    setOpenThreadRootId(undefined);
    localStorage.removeItem(ACTIVE_CONVERSATION_KEY);
    dropCachedChatRows();
  }

  /** One way to change home tab, from the bar and from search alike: an open
   *  choice is left, the open chat is left (the bar is under the chat too, so
   *  a tab can be tapped from inside one), the tab is remembered, and the
   *  screen redrawn. */
  function switchHomeTab(tab) {
    closeActivityItem();
    leaveOpenChat();
    setHomeTab(tab);
    showScreen(tab);
    return render();
  }

  function storedActivityTab() {
    if (currentActivityTab) return currentActivityTab;
    const stored = localStorage.getItem(ACTIVITY_TAB_KEY);
    return ACTIVITY_TABS.indexOf(stored) >= 0 ? stored : undefined;
  }

  /** Which home screen, or the open chat, is on screen. */
  function showScreen(name) {
    for (const key of Object.keys(SCREEN_IDS)) {
      const screen = document.getElementById(SCREEN_IDS[key]);
      if (screen) screen.classList.toggle("is-active", key === name);
    }
    // After the classes are on: applyDock reads the screen from them.
    applyDock();
    for (const tab of document.querySelectorAll("[data-home-tab]")) {
      const active = tab.dataset.homeTab === name;
      tab.dataset.active = active ? "true" : "false";
      if (active) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    }
  }

  /** Whether the keyboard is up: the composer holding focus is what the height
   *  tracker already treats as the keyboard being open, so the bar and the
   *  measuring cannot disagree about it. */
  function composerHasFocus() {
    const active = document.activeElement;
    if (!active) return false;
    if (active.id === "composer-input") return true;
    // A card's own answer field raises the keyboard the same way the
    // composer does, and the bar has no room beside it either.
    return (active.tagName === "INPUT" || active.tagName === "TEXTAREA") &&
      Boolean(active.closest && active.closest("#timeline-screen"));
  }

  /** What is on screen, read from the screens themselves rather than kept
   *  beside them: the bar is decided outside a redraw too (the keyboard opens),
   *  and a remembered copy could then answer for a screen that is not up. */
  function screenOnShow() {
    for (const key of Object.keys(SCREEN_IDS)) {
      const screen = document.getElementById(SCREEN_IDS[key]);
      if (screen && screen.classList.contains("is-active")) return key;
    }
    return "chats";
  }

  /** The bar's own state. It shows on the home screens of a paired phone and
   *  under the chat's composer, as the User asked on 2026-09-20 (Slack's
   *  behaviour). It steps aside for a choice opened from Activity, so nothing
   *  behind it can be reached, and inside a chat while the keyboard is up,
   *  where there is no room for it. Called on every screen change and on the
   *  composer's focus and blur, which is when the keyboard comes and goes. */
  function applyDock() {
    const name = screenOnShow();
    const paired = Boolean(loadPairing()) && !mailboxAuthRejected;
    const home = name !== "timeline" && paired;
    const inChat = name === "timeline" && paired;
    // Anything that takes the screen for itself takes the bar with it: the
    // choice opened from Activity, a picture at full size, and the members
    // sheet — a dialog with a backdrop, and navigation left live outside a
    // backdrop is a way around it. The live-reply view is a screen of the
    // chat rather than a dialog, so the bar stays under that one.
    const covered = (name === "activity" && Boolean(openActivityCardId)) ||
      (inChat && CHAT_DIALOG_IDS.some(function (id) {
        const node = document.getElementById(id);
        return Boolean(node && !node.hidden);
      }));
    const typing = inChat && composerHasFocus();
    const shown = (home || inChat) && !covered && !typing;
    // Where the bar is, for the stylesheet: "1" floating over a home screen,
    // "chat" in the column under the composer, "0" not on screen at all.
    const placement = !shown ? "0" : home ? "1" : "chat";
    const dock = document.getElementById("home-dock");
    if (dock) dock.hidden = !shown;
    const phone = document.querySelector(".mobile-phone");
    if (phone) phone.dataset.dock = placement;
  }

  function lineIcon(paths, size) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", String(size || 20));
    svg.setAttribute("height", String(size || 20));
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    for (const d of paths) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return svg;
  }

  /** The members' rows from the Activity window on, read by their time index.
   *  Only what Activity uses is kept, with the text cut to what a preview
   *  needs: the copy stays in memory between redraws, and a week of answers in
   *  full is megabytes. */
  function listRecentTimelineEntries(sinceIso, keepChars) {
    return withTimeline("readonly", function (store) {
      return requestToPromise(store.index("createdAt").getAll(IDBKeyRange.lowerBound(sinceIso)));
    }).then(function (rows) {
      const kept = [];
      for (const row of rows) {
        if (!row || row.role !== "participant") continue;
        kept.push({
          id: row.id,
          sourceId: row.sourceId,
          messageId: row.messageId,
          conversationId: row.conversationId,
          role: row.role,
          participantLabel: row.participantLabel,
          status: row.status,
          createdAt: row.createdAt,
          receivedAt: row.receivedAt,
          settledAt: row.settledAt,
          runId: row.runId,
          mobileEventId: row.mobileEventId,
          threadRootId: row.threadRootId,
          content: typeof row.content === "string" ? row.content.slice(0, keepChars) : ""
        });
      }
      return kept;
    });
  }

  /** Runs a stop was asked for that the desktop has not taken yet, from the
   *  queue itself: after a reload the in-memory mark is gone, the request is not. */
  function queuedStopRunIds() {
    return listOutboxEntries(undefined).then(function (entries) {
      return entries.filter(function (entry) {
        return entry && entry.kind === "run.cancel.requested" && entry.payload && entry.payload.runId;
      }).map(function (entry) {
        return entry.payload.runId;
      });
    }).catch(function () {
      return [];
    });
  }

  function readRecentActivitySource(activityApi, now) {
    if (recentTimelineRead) return recentTimelineRead;
    const generation = timelineGeneration;
    const since = new Date(now - activityApi.WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    recentTimelineRead = Promise.all([
      listRecentTimelineEntries(since, activityApi.PREVIEW_SOURCE_LIMIT),
      queuedStopRunIds()
    ]).then(function (read) {
      const source = { generation: generation, readAt: Date.now(), entries: read[0], queuedStops: read[1] };
      // Renders overlap: an older read finishing late must not replace a newer one.
      if (!recentTimelineCache || generation >= recentTimelineCache.generation) {
        recentTimelineCache = source;
      }
      return recentTimelineCache;
    }).catch(function () {
      return recentTimelineCache || { generation: generation, readAt: 0, entries: [], queuedStops: [] };
    }).finally(function () {
      recentTimelineRead = undefined;
    });
    return recentTimelineRead;
  }

  function machineRunKnownLive(runId) {
    const held = runId ? machineRunState.get(runId) : undefined;
    return Boolean(held && (held.status === "running" || held.status === "requested"));
  }

  /** `cached` asks for the lists to be built from rows already read, never
   *  from a fresh pass over the store. Inside a chat that is the only
   *  acceptable cost: reading a week of rows takes hundreds of milliseconds on
   *  a phone with a busy week behind it, and an agent streaming into the open
   *  chat would pay it every second or so, on the main thread. What waits for
   *  the User is counted from the cards, which are read from storage anyway;
   *  what is stale in there is at most the count of finished updates, until
   *  the chat is left. Nothing cached at all (a phone opened straight into a
   *  chat from a notification) is read once. */
  async function loadActivity(options) {
    const activityApi = self.AccordMobileActivity;
    if (!activityApi) return undefined;
    const now = Date.now();
    // Inside a chat the lists are not on screen — only the bar's number is —
    // and a pass over a week of rows for it is what made streaming text arrive
    // in lumps. Whoever asks while a chat is open gets what was last read,
    // whether or not they remembered to say so.
    const cached = Boolean(options && options.cached) || Boolean(selectedConversationId());
    let source = recentTimelineCache;
    if (source && source.generation === timelineGeneration && now - source.readAt < ACTIVITY_CACHE_MAX_AGE_MS) {
      // Nothing written since the last read.
    } else if (cached && source) {
      // Whatever was last read stands; no new pass over the store.
    } else if (cached) {
      source = await readRecentActivitySource(activityApi, now);
    } else if (source && now - source.readAt < ACTIVITY_REREAD_MIN_MS) {
      // A run streaming into the store changes it every second or so; the
      // lists catch up once the burst has had a moment, not on every write.
      if (!activityRereadTimer) {
        activityRereadTimer = setTimeout(function () {
          activityRereadTimer = undefined;
          if (!selectedConversationId()) void render();
        }, ACTIVITY_REREAD_MIN_MS - (now - source.readAt));
      }
    } else {
      source = await readRecentActivitySource(activityApi, now);
    }
    const stops = new Set(source.queuedStops.concat(Array.from(stopRequestedRunIds)));
    // The same inputs give the same lists; a redraw for an unrelated reason
    // (a poll, the clock) does not redo the work. Stored strings are compared
    // as they are, not copied into a key: the chat list can be large.
    const inputs = [
      localStorage.getItem(CONTROL_CARDS_KEY),
      localStorage.getItem(CHAT_LIST_KEY),
      localStorage.getItem(UNREAD_KEY),
      localStorage.getItem(VIEWED_AT_KEY),
      localStorage.getItem(ACTIVITY_CLEARED_KEY),
      localStorage.getItem(CHAT_LIST_AT_KEY),
      JSON.stringify(Array.from(deletedMachineConversations)),
      JSON.stringify(Array.from(stops)),
      JSON.stringify(Array.from(machineRunState, function (pair) { return [pair[0], pair[1] && pair[1].status]; })),
      String(Math.floor(now / 60_000))
    ];
    if (activityMemo && activityMemo.source === source && activityMemo.inputs.length === inputs.length &&
      activityMemo.inputs.every(function (value, index) { return value === inputs[index]; })) {
      return activityMemo.activity;
    }
    const activity = activityApi.buildActivity({
      entries: source.entries,
      cardsByConversation: loadControlCards(),
      chats: loadChats(),
      unreadConversationIds: loadUnreadConversationIds(),
      viewedAt: loadViewedAt(),
      isRunSettled: machineRunSettled,
      isRunKnownLive: machineRunKnownLive,
      isStopRequested: function (runId) { return stops.has(runId); },
      isPlaceholder: isPlaceholderTimelineContent,
      // Activity previews are member messages too: the block that becomes a
      // card is not what the row should read.
      displayText: function (content) { return displayedMessageText(content, "agent"); },
      clearedEntryIds: loadClearedActivity(),
      hiddenConversationIds: Array.from(deletedMachineConversations),
      chatListAt: localStorage.getItem(CHAT_LIST_AT_KEY) || undefined,
      now: now
    });
    activityMemo = { source: source, inputs: inputs, activity: activity };
    return activity;
  }

  /** A batch for a chat the phone's list does not have yet (created on the
   *  desktop while this app stayed open) asks for the list again, so the chat
   *  and anything it is waiting on show up without a trip to the background. */
  function refreshChatListSoon(conversationId) {
    if (!conversationId || chatListRefreshTimer) return;
    if (loadChats().some(function (chat) { return chat.id === conversationId; })) return;
    const wait = Math.max(0, CHAT_LIST_REFRESH_MIN_MS - (Date.now() - lastChatListRefreshAt));
    chatListRefreshTimer = setTimeout(function () {
      chatListRefreshTimer = undefined;
      lastChatListRefreshAt = Date.now();
      const pairing = loadPairing();
      if (!pairing || !relayCanSync(pairing)) return;
      void requestChatListViaRelay(pairing).then(function () {
        return render("synced");
      }).catch(function () {
        return undefined;
      });
    }, wait);
  }

  async function renderHome(tab, revision) {
    const activity = await loadActivity();
    if (revision !== renderRevision || selectedConversationId()) return;
    renderActivityBadge(activity);
    if (tab === "activity") {
      renderActivity(activity);
    } else if (tab === "settings") {
      renderSettings();
    }
  }

  /** The bar's Activity number on its own, for when the lists are not on
   *  screen: inside a chat. Built from rows already read — see loadActivity —
   *  so an open chat never pays for a pass over the store. */
  async function refreshDockBadge(revision) {
    const activity = await loadActivity({ cached: true });
    // A newer redraw has taken over: its own number is the one to keep.
    if (revision !== undefined && revision !== renderRevision) return;
    if (!activity) return;
    renderActivityBadge(activity);
  }

  function renderActivityBadge(activity) {
    const badge = document.getElementById("activity-badge");
    const tab = document.querySelector('[data-home-tab="activity"]');
    const count = activity && self.AccordMobileActivity ? self.AccordMobileActivity.attentionCount(activity) : 0;
    if (badge) {
      badge.hidden = count === 0;
      badge.textContent = count > 99 ? "99+" : String(count);
    }
    if (tab) tab.setAttribute("aria-label", count > 0 ? "Activity, " + count + " new" : "Activity");
  }

  function activityAvatarFor(conversationId, handle) {
    return avatarForLabel(conversationMembers(conversationId), handle || "Agent");
  }

  function activityRowAvatar(conversationId, handle) {
    const avatar = document.createElement("span");
    avatar.className = "mobile-chat-avatar act-avatar";
    paintAvatar(avatar, activityAvatarFor(conversationId, handle), conversationId);
    return avatar;
  }

  /** The two lines every Activity row starts with: the chat, who (and where,
   *  for a permission), when, and whether it is new; then what was said. */
  function activityRowMain(row, stamp) {
    const main = document.createElement("button");
    main.type = "button";
    main.className = "act-main";
    const top = document.createElement("span");
    top.className = "act-top";
    const title = document.createElement("span");
    title.className = "act-chat-title";
    title.textContent = row.chatTitle;
    // "by @drew · Office Mac": who asks, and where it would run. A machine is
    // never named as the author.
    const byText = row.handle
      ? " by " + [row.handle, row.machineName].filter(Boolean).join(" · ")
      : row.machineName ? " · " + row.machineName : "";
    if (byText) {
      const by = document.createElement("span");
      by.className = "act-by";
      by.textContent = byText;
      title.append(by);
    }
    top.append(title);
    for (const node of stamp) top.append(node);
    const preview = document.createElement("span");
    preview.className = "act-preview" + (row.kind === "permission" ? " act-preview-full" : "");
    preview.textContent = row.preview || (row.kind === "run" ? "Thinking…" : "");
    main.append(top, preview);
    return main;
  }

  function activityTime(iso) {
    const time = document.createElement("span");
    time.className = "act-time";
    time.textContent = relativeTime(iso);
    return time;
  }

  /** The whole row is the way in, as a chat-list row is, not only its text. */
  function makeRowOpen(element, open) {
    element.dataset.tappable = "1";
    element.addEventListener("click", open);
  }

  // What has been cleared, most recently cleared last, bounded: a phone does
  // not keep a year of them, and the newest are the ones that must survive.
  const ACTIVITY_CLEARED_LIMIT = 2000;

  function loadClearedActivity() {
    try {
      const raw = JSON.parse(localStorage.getItem(ACTIVITY_CLEARED_KEY) || "[]");
      return Array.isArray(raw) ? raw.filter(function (id) { return typeof id === "string"; }) : [];
    } catch {
      return [];
    }
  }

  /** Clearing a finished row hides the updates that row stands for, and only
   *  those: the next answer from that member in that chat is a new update and
   *  brings the row back. Named by update rather than by a moment in time,
   *  because a finished row is stamped when its run started — a run already in
   *  flight would otherwise be swallowed when it finished. */
  function clearActivityRow(row) {
    const ids = Array.isArray(row && row.entryIds) ? row.entryIds : [];
    if (ids.length === 0) return;
    const cleared = loadClearedActivity().filter(function (id) { return ids.indexOf(id) < 0; });
    const next = cleared.concat(ids).slice(-ACTIVITY_CLEARED_LIMIT);
    setStoredValue(ACTIVITY_CLEARED_KEY, JSON.stringify(next));
    activityMemo = undefined;
    void render();
  }

  /** One row is open at a time: a second swipe closes the first, and so does a
   *  tap anywhere else. */
  let openSwipeRow;
  // Kept beside the node: the list is rebuilt from scratch, so the node goes
  // and the row it stood for does not.
  let openSwipeKey;

  function closeOpenSwipe() {
    if (openSwipeRow && openSwipeRow.isConnected) {
      openSwipeRow.dataset.swiped = "0";
    }
    openSwipeRow = undefined;
    openSwipeKey = undefined;
  }

  /** The Activity list is rebuilt whenever anything in it changes, including
   *  once a minute for the clock. An open row is re-opened on the new node so
   *  the action does not vanish between the swipe and the tap. */
  function restoreOpenSwipe(list) {
    if (!openSwipeKey || !list) return;
    const wrap = list.querySelector('.act-swipe[data-activity-key="' + cssEscapeValue(openSwipeKey) + '"]');
    if (!wrap) {
      openSwipeRow = undefined;
      openSwipeKey = undefined;
      return;
    }
    wrap.dataset.swiped = "1";
    openSwipeRow = wrap;
  }

  function cssEscapeValue(value) {
    return String(value).replace(/["\\]/g, "\\$&");
  }

  /** The row slides left under the finger and stops at its action. Vertical
   *  movement wins until the finger has travelled far enough sideways, so the
   *  list still scrolls normally. */
  function makeRowSwipeable(wrap, surface) {
    let startX = 0;
    let startY = 0;
    let sliding = false;
    let decided = false;
    surface.addEventListener("touchstart", function (event) {
      if (event.touches.length !== 1) return;
      startX = event.touches[0].clientX;
      startY = event.touches[0].clientY;
      sliding = false;
      decided = false;
    }, { passive: true });
    surface.addEventListener("touchmove", function (event) {
      if (event.touches.length !== 1) return;
      const dx = event.touches[0].clientX - startX;
      const dy = event.touches[0].clientY - startY;
      if (!decided) {
        if (Math.abs(dy) > Math.abs(dx)) {
          decided = true;
          return;
        }
        if (Math.abs(dx) < SWIPE_START_PX) return;
        decided = true;
        sliding = true;
        if (openSwipeRow && openSwipeRow !== wrap) closeOpenSwipe();
      }
      if (!sliding) return;
      const offset = Math.max(-SWIPE_ACTION_WIDTH, Math.min(0, dx));
      surface.style.transform = "translateX(" + offset + "px)";
    }, { passive: true });
    const settle = function (event) {
      if (!sliding) return;
      sliding = false;
      surface.style.transform = "";
      const dx = (event.changedTouches && event.changedTouches[0] ? event.changedTouches[0].clientX : startX) - startX;
      const open = dx <= -SWIPE_ACTION_WIDTH / 2;
      wrap.dataset.swiped = open ? "1" : "0";
      openSwipeRow = open ? wrap : undefined;
      openSwipeKey = open ? wrap.dataset.activityKey : undefined;
    };
    surface.addEventListener("touchend", settle);
    surface.addEventListener("touchcancel", settle);
  }

  /** A row with an action behind it. The action is a real button — reachable
   *  by a screen reader without the gesture — and the row itself keeps doing
   *  what it did before. */
  function rowWithSwipeAction(element, action) {
    if (!action) return element;
    const wrap = document.createElement("div");
    wrap.className = "act-swipe";
    wrap.dataset.swiped = "0";
    if (element.dataset.activityKey) wrap.dataset.activityKey = element.dataset.activityKey;
    const actions = document.createElement("div");
    actions.className = "act-swipe-actions";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "act-swipe-action act-swipe-" + action.kind;
    button.setAttribute("aria-label", action.label);
    button.append(action.icon, (function () {
      const label = document.createElement("span");
      label.textContent = action.label;
      return label;
    })());
    button.addEventListener("click", function (event) {
      event.stopPropagation();
      closeOpenSwipe();
      action.run();
    });
    actions.append(button);
    element.classList.add("act-swipe-surface");
    // A tap on the row itself closes the action rather than opening the chat
    // behind it: the row is showing something to be answered, not a link.
    element.addEventListener("click", function (event) {
      if (wrap.dataset.swiped !== "1") return;
      event.stopPropagation();
      event.preventDefault();
      closeOpenSwipe();
    }, true);
    makeRowSwipeable(wrap, element);
    wrap.append(actions, element);
    return wrap;
  }

  function finishedActivityRow(row) {
    const element = document.createElement("div");
    element.className = "act-row" + (row.read ? "" : " is-unread");
    element.dataset.activityKey = row.key;
    const stamp = [activityTime(row.at)];
    if (row.count > 1) {
      const badge = document.createElement("span");
      badge.className = "act-badge" + (row.read ? " act-badge-read" : "");
      badge.textContent = String(row.count);
      badge.setAttribute("aria-label", row.count + " updates");
      stamp.push(badge);
    } else if (!row.read) {
      const dot = document.createElement("span");
      dot.className = "act-dot";
      dot.setAttribute("aria-label", "Unread");
      stamp.push(dot);
    }
    const col = document.createElement("div");
    col.className = "act-col";
    col.append(activityRowMain(row, stamp));
    element.append(activityRowAvatar(row.conversationId, row.handle), col);
    makeRowOpen(element, function () {
      void openConversation(row.conversationId, { threadRootId: row.threadRootId });
    });
    // Swipe left to clear it from this phone's Activity, the way the desktop's
    // "Clear from activity" works there: local to the device (the User,
    // 2026-09-20).
    return rowWithSwipeAction(element, {
      kind: "clear",
      label: "Clear",
      icon: lineIcon(["M18 6 6 18", "m6 6 12 12"], 20),
      run: function () { clearActivityRow(row); }
    });
  }

  function pendingActivityRow(row) {
    const card = row.card;
    const element = document.createElement("div");
    element.className = "act-row is-unread";
    element.dataset.activityKey = row.key;
    element.dataset.cardId = card.id;
    element.dataset.cardKind = card.kind;
    const dot = document.createElement("span");
    dot.className = "act-dot act-dot-pending";
    dot.setAttribute("aria-label", "Waiting for you");
    const col = document.createElement("div");
    col.className = "act-col";
    col.append(activityRowMain(row, [activityTime(row.at), dot]));
    const sent = isCardLocked(card.id) || controlCardAnswering.has(card.id);
    if (row.kind === "choice") {
      // A choice is read and answered in full, so the row opens it.
      const chevron = document.createElement("span");
      chevron.className = "act-chevron";
      chevron.append(lineIcon(["m9 18 6-6-6-6"], 20));
      element.append(activityRowAvatar(row.conversationId, row.handle), col, chevron);
      makeRowOpen(element, function () {
        openActivityCardId = card.id;
        showScreen("activity");
        void render();
      });
    } else {
      const actions = document.createElement("div");
      actions.className = "act-actions";
      // A tap that misses a pill by a few pixels stays on the list: it was
      // meant for an answer, not for opening the chat behind the row.
      actions.addEventListener("click", function (event) { event.stopPropagation(); });
      const buttons = [];
      for (const option of Array.isArray(card.options) ? card.options : []) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "act-pill" + (option.id === "allow" ? " act-pill-primary" : "");
        button.dataset.optionId = option.id;
        button.textContent = option.label || option.id;
        button.disabled = sent;
        button.addEventListener("click", function (event) {
          event.stopPropagation();
          // Rows can move when a card arrives or leaves; a tap right after a
          // redraw may have been meant for another row.
          if (Date.now() - lastActivityListRenderAt < ACTIVITY_TAP_GUARD_MS) return;
          // One answer per card: the other option goes dead with the first tap.
          for (const other of buttons) other.disabled = true;
          void answerControlCard(card, { optionId: option.id });
        });
        buttons.push(button);
        actions.append(button);
      }
      col.append(actions);
      element.append(activityRowAvatar(row.conversationId, row.handle), col);
      makeRowOpen(element, function () {
        void openConversation(row.conversationId);
      });
    }
    const failure = controlCardErrors.get(card.id);
    if (failure || cardSentText(card.id)) {
      const state = document.createElement("p");
      state.className = "act-state";
      // A tap is not the answer being applied; the row leaves when the
      // desktop says the card is answered.
      state.textContent = failure || cardSentText(card.id);
      col.append(state);
    }
    // Swipe left to cancel, as the desktop's "Cancel pending card" does. Only
    // where cancelling is the card's own answer: a permission is answered by
    // Allow or Deny, and those are already in the row — a second control
    // meaning Deny would be a trap.
    if (!card.allowsCancel || sent) {
      return element;
    }
    return rowWithSwipeAction(element, {
      kind: "cancel",
      label: "Cancel",
      icon: lineIcon(["M18 6 6 18", "m6 6 12 12"], 20),
      run: function () {
        if (Date.now() - lastActivityListRenderAt < ACTIVITY_TAP_GUARD_MS) return;
        void answerControlCard(card, { cancel: true });
      }
    });
  }

  function runningActivityRow(row) {
    const element = document.createElement("div");
    element.className = "act-row";
    element.dataset.activityKey = row.key;
    const elapsed = document.createElement("span");
    // Ticked by the same clock as the chat's own running rows.
    elapsed.className = "act-elapsed thinking-elapsed";
    elapsed.dataset.startedAt = row.at || nowIso();
    elapsed.textContent = formatElapsed(row.at);
    const live = document.createElement("span");
    live.className = "mobile-live-dot";
    live.setAttribute("aria-label", "Running");
    const col = document.createElement("div");
    col.className = "act-col";
    col.append(activityRowMain(row, [elapsed, live]));
    element.append(activityRowAvatar(row.conversationId, row.handle), col);
    if (row.cancellable) {
      const stopping = row.stopping || stopRequestedRunIds.has(row.runId);
      const stop = document.createElement("button");
      stop.type = "button";
      stop.className = "act-stop";
      stop.dataset.runId = row.runId;
      stop.disabled = stopping;
      stop.setAttribute("aria-label", stopping ? "Stopping" : "Stop " + (row.handle || "this run"));
      const ring = document.createElement("span");
      ring.className = "act-stop-ring";
      const square = document.createElement("span");
      square.className = "act-stop-square";
      ring.append(square);
      stop.append(ring);
      stop.addEventListener("click", function (event) {
        event.stopPropagation();
        if (stop.disabled || Date.now() - lastActivityListRenderAt < ACTIVITY_TAP_GUARD_MS) return;
        stop.disabled = true;
        stop.setAttribute("aria-label", "Stopping");
        void stopRunFromPhone(row.runId, row.conversationId);
      });
      element.append(stop);
    }
    makeRowOpen(element, function () {
      void openConversation(row.conversationId, { threadRootId: row.threadRootId });
    });
    return element;
  }

  function activityEmptyText(tab) {
    if (tab === "running") return "Nothing is running right now.";
    if (tab === "pending") return "Nothing is waiting for you.";
    const days = self.AccordMobileActivity ? self.AccordMobileActivity.WINDOW_DAYS : 7;
    return "No updates from members in the last " + days + " days.";
  }

  function renderActivityTabs(data, tab) {
    const tabsHost = document.getElementById("activity-tabs");
    if (!tabsHost) return;
    const signature = JSON.stringify([tab, ACTIVITY_TABS.map(function (name) { return data[name].length; })]);
    if (tabsHost.dataset.signature === signature) return;
    tabsHost.dataset.signature = signature;
    tabsHost.replaceChildren();
    for (const name of ACTIVITY_TABS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "act-tab";
      button.dataset.activityTab = name;
      button.dataset.active = name === tab ? "true" : "false";
      if (name === tab) button.setAttribute("aria-current", "true");
      const label = document.createElement("span");
      label.textContent = ACTIVITY_TAB_LABELS[name];
      const count = document.createElement("span");
      count.className = "act-tab-count";
      count.textContent = String(data[name].length);
      button.append(label, count);
      if (name === tab) {
        const bar = document.createElement("span");
        bar.className = "act-tab-bar";
        button.append(bar);
      }
      button.addEventListener("click", function () {
        setActivityTab(name);
        const list = document.getElementById("activity-list");
        if (list) list.scrollTop = 0;
        void render();
      });
      tabsHost.append(button);
    }
  }

  function renderActivity(activity) {
    const list = document.getElementById("activity-list");
    if (!list) return;
    const data = activity || { running: [], pending: [], finished: [] };
    const openCard = openActivityCardId
      ? data.pending.find(function (row) { return row.card.id === openActivityCardId; })
      : undefined;
    if (openActivityCardId && !openCard) {
      // Answered or withdrawn: there is nothing left to answer here.
      closeActivityItem();
      showScreen("activity");
    }
    void renderActivityItem(openCard);
    let tab = storedActivityTab();
    if (!tab) {
      // Chosen once there is something to choose by, and then kept: a list
      // that switched itself whenever a card came or went would move rows
      // under a finger.
      tab = data.pending.length > 0 ? "pending" : data.running.length > 0 ? "running" : "finished";
      if (data.pending.length + data.running.length + data.finished.length > 0) setActivityTab(tab);
    }
    renderActivityTabs(data, tab);
    // Only the list on screen decides whether it is drawn again.
    const rows = data[tab];
    const signature = JSON.stringify({
      tab: tab,
      minute: Math.floor(Date.now() / 60_000),
      rows: rows.map(function (row) {
        return [row.key, row.chatTitle, row.handle, row.machineName, row.preview, row.at, row.count, row.read,
          row.cancellable, row.stopping, avatarSignature(activityAvatarFor(row.conversationId, row.handle)),
          row.card ? [isCardLocked(row.card.id), cardSentText(row.card.id), controlCardAnswering.has(row.card.id), controlCardErrors.get(row.card.id) || ""] : 0,
          row.runId ? stopRequestedRunIds.has(row.runId) : 0];
      })
    });
    if (signature === lastActivityRenderSignature) return;
    lastActivityRenderSignature = signature;
    // The guard against a tap meant for a row that has just moved is armed
    // only when rows did move. A redraw for the clock, a streaming preview or
    // a card's state leaves every row where it was, and a tap on one of them
    // is meant — armed on those too, a Stop or an Allow was dropped, with
    // nothing on screen to say so, for half a second after every redraw.
    const order = tab + "\n" + rows.map(function (row) { return row.key; }).join("\n");
    if (order !== lastActivityRowOrder) {
      lastActivityRowOrder = order;
      lastActivityListRenderAt = Date.now();
    }
    list.replaceChildren();
    list.dataset.activityTab = tab;
    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "mobile-empty act-empty";
      empty.textContent = activityEmptyText(tab);
      list.append(empty);
      return;
    }
    for (const row of rows) {
      list.append(tab === "running" ? runningActivityRow(row) : tab === "pending" ? pendingActivityRow(row) : finishedActivityRow(row));
    }
    restoreOpenSwipe(list);
  }

  function getTimelineEntry(entryId) {
    return withTimeline("readonly", function (store) {
      return requestToPromise(store.get(entryId));
    });
  }

  /** The message a choice belongs to: stored under the chat's id and its own,
   *  so it is read directly rather than by reading the whole store. */
  async function findChoiceMessage(conversationId, sourceMessageId) {
    if (!sourceMessageId) return undefined;
    const direct = await getTimelineEntry(conversationId + ":" + sourceMessageId).catch(function () { return undefined; });
    if (direct) return direct;
    const entries = await listTimelineEntries(conversationId).catch(function () { return []; });
    return entries.find(function (entry) {
      return entry.messageId === sourceMessageId || entry.sourceId === sourceMessageId;
    });
  }

  /** A choice opened from Activity: the message it belongs to and the whole
   *  card, answered exactly as it is in the chat. */
  async function renderActivityItem(row) {
    const view = document.getElementById("activity-item");
    const body = document.getElementById("activity-item-body");
    if (!view || !body) return;
    if (!row) {
      activityItemRenderToken += 1;
      if (!view.hidden) {
        view.hidden = true;
        body.replaceChildren();
        delete body.dataset.signature;
      }
      return;
    }
    const card = row.card;
    const titleNode = document.getElementById("activity-item-title");
    const subNode = document.getElementById("activity-item-sub");
    if (titleNode) titleNode.textContent = row.chatTitle;
    if (subNode) subNode.textContent = "Waiting for you" + (row.handle ? " · asked by " + row.handle : "");
    view.hidden = false;
    view.dataset.conversationId = row.conversationId;
    const signature = JSON.stringify([card, isCardLocked(card.id), cardSentText(card.id), controlCardAnswering.has(card.id), controlCardErrors.get(card.id) || ""]);
    if (body.dataset.signature === signature) return;
    body.dataset.signature = signature;
    const token = ++activityItemRenderToken;
    const source = await findChoiceMessage(row.conversationId, card.sourceMessageId);
    // A later draw (the answer being sent, say) owns the view now.
    if (token !== activityItemRenderToken || openActivityCardId !== card.id) return;
    body.replaceChildren();
    if (source && source.content) {
      const message = document.createElement("div");
      message.className = "act-item-message";
      const head = document.createElement("div");
      head.className = "act-item-message-head";
      head.append(activityRowAvatar(row.conversationId, source.participantLabel || row.handle));
      const who = document.createElement("span");
      who.className = "message-handle";
      who.textContent = source.participantLabel || row.handle || "";
      const when = document.createElement("span");
      when.className = "message-status";
      when.textContent = formatClockTime(source.createdAt);
      head.append(who, when);
      const content = document.createElement("div");
      content.className = "message-content markdown-text";
      renderMessageContent(content, displayedMessageText(source.content));
      message.append(head, content);
      body.append(message);
    }
    body.append(controlCardElement(card));
  }

  function settingsGroup(title, rows) {
    const section = document.createElement("section");
    const heading = document.createElement("div");
    heading.className = "set-group-title";
    heading.textContent = title;
    const group = document.createElement("div");
    group.className = "set-group";
    for (const row of rows) group.append(row);
    section.append(heading, group);
    return section;
  }

  function settingsRow(title, sub, control) {
    const row = document.createElement("div");
    row.className = "set-row";
    const copy = document.createElement("div");
    copy.className = "set-copy";
    const strong = document.createElement("span");
    strong.className = "set-title";
    strong.textContent = title;
    copy.append(strong);
    if (sub) {
      const small = document.createElement("span");
      small.className = "set-sub";
      small.textContent = sub;
      copy.append(small);
    }
    row.append(copy);
    if (control) row.append(control);
    return row;
  }

  function settingsButton(label, onClick, disabled) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "set-button";
    button.textContent = label;
    button.disabled = Boolean(disabled);
    button.addEventListener("click", onClick);
    return button;
  }

  /** What this phone can change about itself. Only what it can actually do:
   *  iOS does not let a web app turn its own alerts off, so they are offered
   *  while undecided and otherwise described, not drawn as a switch. */
  function renderSettings() {
    const list = document.getElementById("settings-list");
    if (!list) return;
    const permission = "Notification" in globalThis ? Notification.permission : "unsupported";
    const pushable = Boolean(outboxEndpoint()) && "Notification" in globalThis && "PushManager" in globalThis;
    const power = machinePowerHandoff();
    const signature = JSON.stringify([permission, pushable, pushEndpointRejected, Boolean(power), machineWakeState, alertsReconnect]);
    if (signature === lastSettingsRenderSignature) return;
    lastSettingsRenderSignature = signature;
    list.replaceChildren();

    list.append(settingsGroup("This phone", [
      settingsRow("Paired with your desktop", "Chats and replies come through the AccordAgents relay.")
    ]));

    let alertsSub;
    let alertsControl;
    if (pushEndpointRejected || !pushable || permission === "unsupported") {
      alertsSub = "Not available in this browser. Messages still arrive when you open the app.";
    } else if (permission === "granted") {
      alertsSub = alertsReconnect === "working"
        ? "Reconnecting this phone to alerts\u2026"
        : alertsReconnect === "ok"
          ? "On, and reconnected to this phone just now."
          : alertsReconnect === "failed"
            ? "On, but reconnecting did not go through. Try again in a moment."
            : "On. You hear about replies and questions while the app is closed.";
      alertsControl = settingsButton("Reconnect", function (event) {
        const button = event.currentTarget;
        button.disabled = true;
        alertsReconnect = "working";
        lastSettingsRenderSignature = "";
        void render();
        void reconnectMessageAlerts().then(function (result) {
          alertsReconnect = result;
          lastSettingsRenderSignature = "";
          void render();
        });
      }, alertsReconnect === "working");
    } else if (permission === "denied") {
      alertsSub = "Off. Turn them on for AccordAgents in your phone's settings.";
    } else {
      alertsSub = "When a member replies or needs you.";
      alertsControl = settingsButton("Turn on", function (event) {
        const button = event.currentTarget;
        button.disabled = true;
        void enableMessageAlerts().finally(function () {
          lastSettingsRenderSignature = "";
          void render();
        });
      });
    }
    list.append(settingsGroup("Notifications", [settingsRow("Message alerts", alertsSub, alertsControl)]));

    if (power) {
      const waking = machineWakeState.status === "waking";
      list.append(settingsGroup("Machines", [
        settingsRow(
          "Cloud machine",
          machineWakeState.detail || "Asleep? Wake it to keep working.",
          settingsButton(waking ? "Waking…" : "Wake", function () {
            void wakeMachineFromPhone();
          }, waking)
        )
      ]));
    }
  }

  /** Leaves the opened choice at once, so its old content is not what shows
   *  when Activity comes back. */
  function closeActivityItem() {
    openActivityCardId = undefined;
    activityItemRenderToken += 1;
    const view = document.getElementById("activity-item");
    const body = document.getElementById("activity-item-body");
    if (view) view.hidden = true;
    if (body) {
      body.replaceChildren();
      delete body.dataset.signature;
    }
  }

  function wireHomeDock() {
    for (const tab of document.querySelectorAll("[data-home-tab]")) {
      tab.addEventListener("click", function () {
        const name = tab.dataset.homeTab;
        if (name === homeTab() && name === "activity") {
          // Tapping the tab you are on goes back to the top of its list.
          const list = document.getElementById("activity-list");
          if (list) list.scrollTop = 0;
        }
        void switchHomeTab(name);
      });
    }
    const back = document.getElementById("activity-item-back");
    back?.addEventListener("click", function () {
      closeActivityItem();
      showScreen("activity");
      void render();
    });
    const open = document.getElementById("activity-item-open");
    open?.addEventListener("click", function () {
      const view = document.getElementById("activity-item");
      const conversationId = view && view.dataset.conversationId;
      closeActivityItem();
      if (conversationId) void openConversation(conversationId);
    });
  }

  // --- waking the machine ----------------------------------------------------

  let machineWakeState = { status: "idle", detail: "" };

  /** The scoped key this device was handed at pairing, or undefined when the
   *  desktop manages no AWS machine. It never leaves this device. */
  function machinePowerHandoff() {
    const pairing = loadPairing();
    const power = pairing && pairing.power;
    return power && power.instanceId && power.credentials ? power : undefined;
  }

  async function callMachinePower(action) {
    const power = machinePowerHandoff();
    const wake = self.AccordMobileMachineWake;
    if (!power || !wake || !globalThis.crypto || !globalThis.crypto.subtle) {
      throw new Error("This phone has no key for that machine.");
    }
    const request = await wake.machineWakeRequest({
      action: action,
      instanceId: power.instanceId,
      credentials: power.credentials,
      crypto: wake.webCrypto(globalThis.crypto.subtle)
    });
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error("AWS refused the request (" + response.status + ").");
    }
    return text;
  }

  async function wakeMachineFromPhone() {
    machineWakeState = { status: "waking", detail: "Asking AWS to start the machine…" };
    await render();
    try {
      await callMachinePower("start");
      // Started is not ready: the runtime still has to boot and connect, and
      // saying otherwise would be the same lie as calling a tap an answer.
      machineWakeState = { status: "started", detail: "Start requested. The machine appears once its runtime connects." };
    } catch (error) {
      machineWakeState = { status: "error", detail: String(error && error.message ? error.message : error) };
    }
    await render();
    await pollMailboxTimeline().catch(function () { return 0; });
  }

  function renderMachineWake() {
    const host = document.getElementById("machine-wake");
    if (!host) return;
    const power = machinePowerHandoff();
    host.replaceChildren();
    host.hidden = !power;
    if (!power) return;
    const label = document.createElement("span");
    label.textContent = machineWakeState.detail || "Machine asleep? Wake it to keep working.";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = machineWakeState.status === "waking" ? "Waking…" : "Wake machine";
    button.disabled = machineWakeState.status === "waking";
    button.addEventListener("click", function () {
      void wakeMachineFromPhone();
    });
    host.append(label, button);
  }

  let renderRevision = 0;

  async function render(connectionStatus) {
    const revision = ++renderRevision;
    await loadDeletedMachineConversations();
    if (revision !== renderRevision) return;
    const state = document.getElementById("connection-state");
    const list = document.getElementById("message-list");
    const chatsScreen = document.getElementById("chats-screen");
    const timelineScreen = document.getElementById("timeline-screen");
    const title = document.getElementById("chat-title");
    const activeId = selectedConversationId();
    if (!state || !list || !chatsScreen || !timelineScreen) {
      return;
    }
    if (list.dataset.conversationId !== (activeId || "")) {
      // Navigation changes the heading before IDB finishes. Remove the old
      // chat's rows and stream controls in the same turn, including on a failed
      // read; they must never remain actionable under the new chat's identity.
      if (list.dataset.conversationId !== undefined) {
        // A thread opened from Activity is the one place a chat is entered
        // straight into a thread; everything else starts on the main list.
        setOpenThreadRootId(pendingThreadOpen && pendingThreadOpen.conversationId === activeId ? pendingThreadOpen.rootId : undefined);
        pendingThreadOpen = undefined;
        setOpenStreamRunId(undefined);
        renderStreamView([], connectionStatus);
      }
      list.dataset.conversationId = activeId || "";
      list.replaceChildren();
      renderThreadHeader(undefined);
      state.textContent = "";
      lastRowsFingerprint = undefined;
      lastScrolledConversationId = undefined;
    }
    if (!loadPairing()) {
      renderUnpairedNotice();
      showScreen("chats");
      return;
    }
    if (mailboxAuthRejected) {
      renderUnpairedNotice(
        "This device's access was revoked from the desktop. " +
        "Scan the QR code or paste a fresh pairing link to reconnect.",
        "revoked"
      );
      showScreen("chats");
      return;
    }
    // W5: offer the doorbell once paired. iOS only grants Notification
    // permission from a user gesture, so this is a visible button, shown only
    // while permission is still undecided.
    const alertsButton = document.getElementById("enable-alerts");
    if (alertsButton) {
      const canOffer = Boolean(outboxEndpoint()) &&
        "Notification" in globalThis &&
        "PushManager" in globalThis &&
        Notification.permission === "default";
      // W-K: a refused subscription replaces the offer with a plain statement.
      // Quiet-wait and alerts-will-never-arrive must not look the same.
      if (pushEndpointRejected) {
        alertsButton.hidden = false;
        alertsButton.disabled = true;
        alertsButton.dataset.alertsState = "unavailable";
        alertsButton.textContent = "Alerts aren't available in this browser. Messages still arrive when you open the app.";
      } else {
        alertsButton.dataset.alertsState = canOffer ? "offered" : "hidden";
        alertsButton.hidden = !canOffer;
      }
      if (!pushEndpointRejected && !alertsButton.dataset.wired) {
        alertsButton.dataset.wired = "1";
        alertsButton.addEventListener("click", function () {
          alertsButton.disabled = true;
          void enableMessageAlerts().finally(function () {
            if (pushEndpointRejected) {
              // The refusal arrived during this click; leave the stated
              // message the render pass just wrote instead of hiding it.
              return;
            }
            alertsButton.disabled = false;
            alertsButton.hidden = !("Notification" in globalThis) || Notification.permission !== "default";
          });
        });
      }
    }
    renderChatList();
    renderControlCards(activeId);
    renderMachineWake();
    const openHomeTab = homeTab();
    showScreen(activeId ? "timeline" : openHomeTab);
    if (!activeId) {
      // Reopening the same chat should land at the latest message again.
      lastScrolledConversationId = undefined;
      await renderHome(openHomeTab, revision);
      return;
    }
    const activeChat = loadChats().find(function (chat) {
      return chat.id === activeId;
    });
    if (title) {
      title.textContent = activeChat?.title || "AccordAgents";
    }
    // Looking at the chat is what reads it. A chat opened behind a locked
    // screen is not being looked at.
    if (!document.hidden) {
      markConversationRead(activeId);
    }
    renderMembersSheetIfOpen(activeChat);
    const entries = await listOutboxEntries(activeId);
    const timelineEntries = await listTimelineEntries(activeId);
    // A mailbox update, navigation or another tab may have superseded this
    // read. Committing it would replace the current chat with the old snapshot.
    if (revision !== renderRevision || activeId !== selectedConversationId()) return;
    if (!document.hidden) {
      markConversationViewed(activeId, timelineEntries.reduce(function (newest, entry) {
        const at = entry && (entry.receivedAt || entry.createdAt);
        return typeof at === "string" && at > newest ? at : newest;
      }, ""));
    }
    // The bar is under the chat too, so its Activity number must keep up in
    // there: while a chat is open it is the only place the User is told that
    // something elsewhere is waiting. Only the number, never the lists — and
    // counted after this look at the chat is recorded, so what was just read
    // is not still counted as news.
    void refreshDockBadge(revision);
    const messageEntries = entries.filter(isMessageOutboxEntry);
    const requestedStopRunIds = new Set(entries.filter(function (entry) {
      return entry.kind === "run.cancel.requested";
    }).map(function (entry) {
      return entry.payload.runId;
    }));
    const outboxContent = new Set(messageEntries.map(function (entry) {
      return entry.payload.content.trim();
    }));
    const visibleTimelineEntries = dedupeTimelineEntries(timelineEntries.filter(function (entry) {
      return !(entry.role === "you" && outboxContent.has(entry.content.trim()));
    }));
    const pending = entries.filter(desktopOwesEntry).length;
    state.textContent = catchingUp
      ? "Catching up\u2026"
      : connectionStatus
        ? connectionStatusText(connectionStatus)
        : pending > 0 ? "Waiting to sync" : "Synced";
    let rows = messageEntries.map(function (entry) {
      return {
        rowKey: "outbox\0" + entry.eventId,
        id: entry.eventId,
        conversationId: entry.conversationId,
        // Shown in the thread it was written in, not in the chat behind it.
        threadRootId: entry.payload && typeof entry.payload.threadRootId === "string"
          ? entry.payload.threadRootId
          : undefined,
        author: "you",
        content: entry.payload.content,
        // A picture just sent from this phone shows in its own pending row
        // rather than only after the desktop echoes it back.
        attachments: Array.isArray(entry.payload.attachments)
          ? entry.payload.attachments.map(function (attachment, index) {
            return {
              id: "outbox:" + entry.eventId + ":" + index,
              filename: attachment.filename || "image",
              mimeType: attachment.mimeType,
              dataBase64: attachment.dataBase64
            };
          })
          : undefined,
        status: statusText(entry.status),
        createdAt: entry.createdAt
      };
    }).concat(visibleTimelineEntries.map(function (entry) {
      return {
        rowKey: timelineRenderRowKey(entry),
        id: entry.id,
        conversationId: entry.conversationId,
        // The stored entry and the rendered row are different shapes. Carrying
        // this across is what makes a picture appear at all: it was stored and
        // then dropped here, so a message with an image rendered as text.
        attachments: entry.attachments,
        author: entry.role === "you" ? "you" : entry.role === "system" ? "system" : "agent",
        // The desktop publishes the in-progress row the moment it accepts the
        // message, before routing has picked anyone, and can only guess a
        // handle from an explicit @mention in the text. With no mention there
        // is no one to name yet — saying "Agent" with a letter avatar showed a
        // participant who does not exist and then swapped identity mid-run.
        participantLabel: entry.participantLabel || "Agent",
        identified: Boolean(entry.participantLabel),
        // Scaffolding that names nobody says one thing — "accepted, an answer
        // is coming" — and says it before anyone is picked. Rendered as a
        // message row it pretended to be a message: an avatar slot, a status, a
        // running clock, all belonging to a member who did not exist yet. It
        // gets a small indication instead.
        //
        // Scaffolding that DOES name a member ("@drew is running...") is not
        // empty — it says who is working, which is exactly what the desktop
        // shows — so it keeps the member row, the clock and the shimmer.
        scaffolding: isScaffoldingEntry(entry) && !entry.participantLabel,
        // A run this phone has already seen end is not offered for stopping,
        // even if a row for it is still on screen after a reload.
        cancellable: !isScaffoldingEntry(entry) && !machineRunSettled(entry.runId),
        content: entry.content,
        status: entry.status === "error" ? "Error" : entry.status === "done" ? "Done" : "Running",
        createdAt: entry.createdAt,
        threadRootId: entry.threadRootId,
        sourceId: entry.sourceId || entry.id,
        // W-M: the run this row belongs to, so a live row can be opened as a
        // stream and the stream can keep following it as it grows. The mobile
        // event id rides along because the answering run has a fresh id of its
        // own: the frames it streams can only be bound to this row through the
        // source event they both answer.
        runId: entry.runId,
        stopRequested: requestedStopRunIds.has(entry.runId) || stopRequestedRunIds.has(entry.runId),
        mobileEventId: entry.mobileEventId
      };
    }));
    rows = dedupeRenderRowsByKey(rows).sort(function (left, right) {
      return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
    });
    renderStreamView(rows, connectionStatus);
    const openThread = openThreadRootId();
    const grouped = groupRowsIntoThreads(rows, openThread);
    rows = grouped.rows;
    renderThreadHeader(openThread);
    renderThreadReplyAction(openThread, rows.length);
    renderLoadEarlier(activeId, openThread);
    const openedConversation = lastScrolledConversationId !== activeId || openThread !== lastRenderedThreadRootId;
    lastRenderedThreadRootId = openThread;
    const rowsFingerprint = rows.map(function (row) {
      return (row.rowKey || row.id) + "\u0000" + messageRowSignature(row);
    }).join("\u0001");
    const rowsChanged = rowsFingerprint !== lastRowsFingerprint;
    lastRowsFingerprint = rowsFingerprint;
    // Measured BEFORE the rows are mounted: appending content is itself what
    // moves the end away, so asking afterwards always answers "not at the
    // bottom" and the view would never follow anything.
    const wasAtBottom = isNearBottom(threadSurface());
    reconcileMessageRows(list, rows);
    lastScrolledConversationId = activeId;
    if (!rowsChanged && !openedConversation) {
      return;
    }
    if (openedConversation) {
      scrollToLatestWhenSettled("auto");
      return;
    }
    // Whoever is at the end is following the conversation, so the view follows
    // too: the indication that a reply is coming, and the reply itself, arrive
    // in sight instead of below the fold. Reading history is the opposite
    // intent — leaving the end is the reader's decision and nothing may undo
    // it, so the pill offers the way back rather than taking it.
    if (wasAtBottom) {
      scrollToLatestWhenSettled("auto");
      return;
    }
    setJumpToLatestVisible(true);
  }

  // W-M(b,c,e,f): the live reply, rendered in its own view.
  //
  // There is no new pipeline here: the accumulated text is already what the
  // in-progress row carries, so opening the view mid-run shows everything so
  // far by construction, and every later ingest updates it through the same
  // render pass as the timeline.
  function renderStreamView(rows, connectionStatus) {
    const view = document.getElementById("stream-view");
    const body = document.getElementById("stream-body");
    const label = document.getElementById("stream-label");
    const state = document.getElementById("stream-state");
    const stop = document.getElementById("stream-stop");
    if (!view || !body || !label || !state || !stop) {
      return;
    }
    const follow = openStreamFollow();
    if (!follow) {
      view.hidden = true;
      return;
    }
    // Match by run id OR by the source's mobile event id, and prefer the
    // newest match: the placeholder row and the growing reply both answer the
    // same event, and the reply is the one worth showing.
    let row;
    for (const candidate of rows) {
      if (candidate.author !== "agent") {
        continue;
      }
      if (candidate.runId === follow.runId ||
        (follow.mobileEventId && candidate.mobileEventId === follow.mobileEventId)) {
        row = candidate;
      }
    }
    if (!row) {
      // The run is gone entirely — nothing honest left to show.
      setOpenStreamRunId(undefined);
      view.hidden = true;
      return;
    }
    view.hidden = false;
    label.textContent = row.participantLabel || "Agent";
    stop.hidden = !isCancellableMobileRow(row);
    stop.disabled = row.stopRequested === true;
    stop.dataset.runId = row.runId || "";
    stop.textContent = row.stopRequested ? "Stopping…" : "Stop";
    stop.setAttribute("aria-label", "Stop response from " + (row.participantLabel || "Agent"));
    // (e) When the run finishes the view stays and shows the finished answer;
    // leaving is the reader's decision, not ours.
    state.textContent = row.status === "Running"
      ? (connectionStatus === "synced" || connectionStatus === undefined ? "Writing…" : "Writing… (reconnecting)")
      : row.status;
    const text = isThinkingEntry(row) ? "" : displayedMessageText(row.content, "agent");
    if (body.dataset.text !== text) {
      body.dataset.text = text;
      body.textContent = text || "Nothing written yet.";
      // Follow the tail only while the reader is already at it.
      if (body.dataset.pinned !== "0") {
        body.scrollTop = body.scrollHeight;
      }
    }
  }

  function wireStreamView() {
    const view = document.getElementById("stream-view");
    const body = document.getElementById("stream-body");
    const close = document.getElementById("stream-close");
    const stop = document.getElementById("stream-stop");
    const list = document.getElementById("message-list");
    if (!view || !body || !close || !stop || !list || view.dataset.wired === "1") {
      return;
    }
    view.dataset.wired = "1";
    close.addEventListener("click", function () {
      setOpenStreamRunId(undefined);
      view.hidden = true;
    });
    stop.addEventListener("click", function () {
      const runId = stop.dataset.runId;
      if (!runId || stop.disabled) {
        return;
      }
      stop.disabled = true;
      stop.textContent = "Stopping…";
      void stopRunFromPhone(runId);
    });
    // Scrolling away from the tail stops the view yanking itself back down.
    body.addEventListener("scroll", function () {
      const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
      body.dataset.pinned = atBottom ? "1" : "0";
    });
    list.addEventListener("click", function (event) {
      const row = event.target && event.target.closest ? event.target.closest(".message-row") : undefined;
      if (!row) {
        return;
      }
      // (f) A row that cannot be followed says why instead of opening a view
      // that would sit there empty.
      if (row.dataset.streamBlocked) {
        flashRowNotice(row, "No live connection");
        return;
      }
      if (row.dataset.streamable !== "1") {
        // Slack's shape, which the User asked for: a message opens on its own
        // screen, and the offer to answer it in a thread lives there rather
        // than under every message in the chat.
        // A tap meant for something inside the row -- a picture, a card, a
        // button, a link -- is not a tap on the message.
        const interactive = event.target && event.target.closest
          ? event.target.closest("button, a, img, input, textarea, select, label, .control-card")
          : undefined;
        if (interactive) {
          return;
        }
        const threadRoot = row.dataset.threadRoot;
        if (threadRoot && !openThreadRootId()) {
          setOpenThreadRootId(threadRoot);
          void render();
        }
        return;
      }
      const runId = row.dataset.streamRunId;
      if (!runId) {
        return;
      }
      setOpenStreamRunId(runId, row.dataset.streamMobileEventId || undefined);
      body.dataset.pinned = "1";
      body.dataset.text = "";
      void render();
    });
  }

  // W-M(a): only a live agent row with a run to follow can be opened. Applied
  // on create AND on update, because a row that ends while on screen is updated
  // in place and would otherwise keep advertising a run that is over.
  // W-M(f): a row can be followed live only while a relay socket is up, or
  // when it already carries real text the view can honestly show. Partial
  // text is live-only, so without either the view would sit empty forever.
  function relaySocketLive() {
    return Boolean(activeRelaySocket && activeRelaySocket.readyState === 1);
  }

  function applyStreamableState(item, entry) {
    if (entry.scaffolding) {
      delete item.dataset.streamable;
      delete item.dataset.streamRunId;
      delete item.dataset.streamMobileEventId;
      delete item.dataset.streamBlocked;
      return;
    }
    if (entry.author === "agent" && entry.status === "Running" && entry.runId) {
      const followable = relaySocketLive() ||
        Boolean((entry.content || "").trim() && !isPlaceholderTimelineContent(entry.content));
      if (followable) {
        item.dataset.streamable = "1";
        item.dataset.streamRunId = entry.runId;
        delete item.dataset.streamBlocked;
      } else {
        delete item.dataset.streamable;
        delete item.dataset.streamRunId;
        item.dataset.streamBlocked = "no-live-connection";
      }
      if (entry.mobileEventId) {
        item.dataset.streamMobileEventId = entry.mobileEventId;
      } else {
        delete item.dataset.streamMobileEventId;
      }
      return;
    }
    delete item.dataset.streamable;
    delete item.dataset.streamRunId;
    delete item.dataset.streamMobileEventId;
    delete item.dataset.streamBlocked;
  }

  function messageRowSignature(entry) {
    return JSON.stringify({
      replyCount: entry.replyCount,
      author: entry.author,
      participantLabel: entry.participantLabel,
      avatar: entry.author === "agent" && entry.identified !== false ? avatarSignature(rowAvatar(entry)) : undefined,
      identified: entry.identified,
      scaffolding: entry.scaffolding,
      content: entry.content,
      answered: answeredCardsForMessage(entry).map(function (card) {
        return card.id + ":" + (card.outcome || "");
      }),
      attachments: Array.isArray(entry.attachments)
        ? entry.attachments.map(function (attachment) { return attachment.id; })
        : undefined,
      status: entry.status,
      when: formatClockTime(entry.createdAt),
      runId: entry.runId,
      stopRequested: entry.stopRequested
    });
  }

  // A pending agent row with no text yet is a run that has started and not
  // produced output. The desktop shows an animated "Thinking" plus elapsed
  // time; match it rather than the flat placeholder sentence.
  function isThinkingEntry(entry) {
    return entry.author === "agent" &&
      entry.status === "Running" &&
      /\bis running\.\.\.$|^Running\.\.\.$/.test((entry.content || "").trim());
  }

  // W-M(f): the stated reason lives on the row itself for a moment — no
  // modal, no view that would hang empty.
  function flashRowNotice(row, text) {
    const status = row.querySelector(".message-status");
    if (!status || status.dataset.noticeTimer) {
      return;
    }
    const original = status.textContent;
    status.dataset.noticeTimer = "1";
    status.textContent = text;
    setTimeout(function () {
      delete status.dataset.noticeTimer;
      status.textContent = original;
    }, 1600);
  }

  function renderThinkingInto(container, entry) {
    if (container.dataset.thinking === "1") {
      return;
    }
    container.dataset.thinking = "1";
    container.textContent = "";
    const label = document.createElement("span");
    label.className = "thinking-label";
    label.textContent = "Thinking";
    const elapsed = document.createElement("span");
    elapsed.className = "thinking-elapsed";
    elapsed.dataset.startedAt = entry.createdAt || nowIso();
    elapsed.textContent = formatElapsed(entry.createdAt);
    container.append(label, elapsed);
  }

  function formatElapsed(startedAt) {
    const started = Date.parse(startedAt || "");
    const total = Number.isFinite(started) ? Math.max(0, Math.floor((Date.now() - started) / 1000)) : 0;
    return Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
  }

  // Only the seconds text is touched, never the row, so ticking cannot cause
  // the list churn that made the view jump.
  function startThinkingClock() {
    clearInterval(activeThinkingClockTimer);
    activeThinkingClockTimer = setInterval(function () {
      for (const node of document.querySelectorAll(".thinking-elapsed")) {
        const next = formatElapsed(node.dataset.startedAt);
        if (node.textContent !== next) {
          node.textContent = next;
        }
      }
    }, 1000);
  }

  // The slot is held either way so the row does not jump sideways when the
  // participant becomes known; it simply carries no identity until then.
  // Same clock the desktop prints under a message. A finished message says
  // when it was written; only a message still in flight says what it is doing.
  function formatClockTime(iso) {
    const time = Date.parse(iso || "");
    if (!Number.isFinite(time)) {
      return "";
    }
    return new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  }

  function messageStatusLabel(entry) {
    if (entry.status === "Done" || entry.status === "Sent") {
      return formatClockTime(entry.createdAt) || entry.status;
    }
    return entry.status;
  }

  function rowHandleText(entry) {
    return entry.identified === false ? "" : (entry.participantLabel || "Agent");
  }

  // The member list can arrive after the row did, and a member's picture can
  // change on the desktop; the row's signature carries the resolved avatar so
  // the row is patched when either happens.
  function rowAvatar(entry) {
    const conversationId = entry.conversationId || selectedConversationId();
    return avatarForLabel(conversationMembers(conversationId), entry.participantLabel || "Agent");
  }

  function applyRowIdentity(avatar, entry) {
    if (entry.identified === false) {
      if (avatar.dataset.avatarSignature !== "") {
        avatar.textContent = "";
        avatar.removeAttribute("style");
        clearAvatarKindClasses(avatar);
        avatar.dataset.avatarSignature = "";
        delete avatar.dataset.avatarLoaded;
      }
      avatar.dataset.identified = "0";
      return;
    }
    const conversationId = entry.conversationId || selectedConversationId();
    paintAvatar(avatar, rowAvatar(entry), conversationId);
    avatar.dataset.identified = "1";
  }

  function renderScaffoldingInto(item) {
    const dots = document.createElement("div");
    dots.className = "message-typing";
    dots.setAttribute("role", "status");
    dots.setAttribute("aria-label", "Waiting for a reply");
    for (let index = 0; index < 3; index += 1) {
      dots.append(document.createElement("span"));
    }
    item.append(dots);
  }

  function isCancellableMobileRow(entry) {
    return entry.author === "agent" &&
      entry.status === "Running" &&
      Boolean(entry.runId) &&
      entry.cancellable !== false;
  }

  function syncMessageStopButton(meta, entry) {
    let button = meta.querySelector(".message-stop");
    const visible = isCancellableMobileRow(entry);
    if (!visible) {
      button?.remove();
      return;
    }
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "message-stop";
      button.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        const targetRunId = button.dataset.runId;
        if (!targetRunId || button.disabled) {
          return;
        }
        button.disabled = true;
        button.textContent = "Stopping…";
        void stopRunFromPhone(targetRunId);
      });
      meta.append(button);
    }
    button.dataset.runId = entry.runId;
    button.disabled = entry.stopRequested === true;
    button.textContent = entry.stopRequested ? "Stopping…" : "Stop";
    button.setAttribute("aria-label", "Stop response from " + rowHandleText(entry));
  }

  function createMessageRow(entry) {
    const item = document.createElement("li");
    item.className = "message-row";
    item.dataset.rowKey = entry.rowKey || entry.id;
    item.dataset.rowSignature = messageRowSignature(entry);
    item.dataset.status = entry.status;
    item.dataset.author = entry.author;
    // Which message this row is, for the screen a tap opens. Rows with nothing
    // the desktop can thread from -- scaffolding, a message still queued on
    // this phone -- carry none, so a tap on them does nothing.
    // Not a system note: the desktop offers a thread on every message but
    // those, and the phone offers exactly what the desktop does.
    if (entry.sourceId && !entry.scaffolding && entry.status !== "queued" && entry.author !== "system") {
      item.dataset.threadRoot = entry.sourceId;
    } else {
      delete item.dataset.threadRoot;
    }
    applyStreamableState(item, entry);
    if (entry.scaffolding) {
      item.dataset.scaffolding = "1";
      renderScaffoldingInto(item);
      return item;
    }
    if (entry.author === "agent") {
      const avatar = document.createElement("div");
      avatar.className = "message-avatar";
      applyRowIdentity(avatar, entry);
      const copy = document.createElement("div");
      copy.className = "message-copy";
      const meta = document.createElement("div");
      meta.className = "message-meta";
      const handle = document.createElement("span");
      handle.className = "message-handle";
      handle.textContent = rowHandleText(entry);
      const status = document.createElement("span");
      status.className = "message-status";
      status.textContent = messageStatusLabel(entry);
      const content = document.createElement("div");
      content.className = "message-content";
      if (isThinkingEntry(entry)) {
        renderThinkingInto(content, entry);
      } else {
        renderMessageContentIfChanged(content, entry.content, entry.author);
      }
      meta.append(handle, status);
      syncMessageStopButton(meta, entry);
      copy.append(meta, content);
      renderAttachmentsInto(attachmentsNodeFor(copy), entry);
      syncAnsweredCards(copy, entry);
      item.append(avatar, copy);
    } else {
      const bubble = document.createElement("div");
      bubble.className = "message-bubble";
      const content = document.createElement("div");
      content.className = "message-content";
      renderMessageContentIfChanged(content, entry.content, entry.author);
      const meta = document.createElement("div");
      meta.className = "message-status";
      meta.textContent = messageStatusLabel(entry);
      bubble.append(content, meta);
      renderAttachmentsInto(attachmentsNodeFor(bubble), entry);
      item.append(bubble);
    }
    appendThreadChip(item, entry);
    return item;
  }

  /** The question the User already answered stays with its own message, the
   *  way the desktop keeps the answered card under it. The pinned strip above
   *  the composer carries only what is still waiting, so without this the
   *  phone would hide the protocol block from the bubble and leave no trace of
   *  what was asked or what was chosen (the User, 2026-09-20). */
  function answeredCardsForMessage(entry) {
    if (!entry || entry.author !== "agent") return [];
    const conversationId = selectedConversationId();
    if (!conversationId) return [];
    const messageId = entry.messageId || entry.sourceId || entry.id;
    if (!messageId) return [];
    return controlCardsFor(conversationId).filter(function (card) {
      return card && card.status !== "pending" && card.kind === "choice" && card.sourceMessageId === messageId;
    });
  }

  function answeredCardElement(card) {
    const wrap = document.createElement("article");
    wrap.className = "control-card control-card-answered";
    wrap.dataset.cardId = card.id;
    wrap.dataset.cardKind = card.kind;
    const head = document.createElement("div");
    head.className = "control-card-head";
    const title = document.createElement("span");
    title.className = "control-card-title";
    title.textContent = card.title || "Choice";
    head.append(title);
    if (card.requesterLabel) {
      const who = document.createElement("span");
      who.className = "control-card-who";
      who.textContent = card.requesterLabel;
      head.append(who);
    }
    wrap.append(head);
    if (card.summary) {
      const summary = document.createElement("p");
      summary.className = "control-card-summary";
      summary.textContent = card.summary;
      wrap.append(summary);
    }
    const state = document.createElement("p");
    state.className = "control-card-state";
    state.textContent = card.outcome === "Cancelled" ? "Cancelled" : "Answered: " + (card.outcome || "");
    wrap.append(state);
    return wrap;
  }

  /** Idempotent: the same message redrawn keeps its node unless the answer
   *  itself changed. */
  function syncAnsweredCards(container, entry) {
    const cards = answeredCardsForMessage(entry);
    const signature = cards.map(function (card) { return card.id + ":" + (card.outcome || ""); }).join("|");
    if (container.dataset.answeredCards === signature) return;
    container.dataset.answeredCards = signature;
    for (const node of container.querySelectorAll(".control-card-answered")) {
      node.remove();
    }
    for (const card of cards) {
      container.append(answeredCardElement(card));
    }
  }

  function appendThreadChip(item, entry) {
    const threadRoot = entry.sourceId;
    if (!entry.replyCount) {
      return;
    }
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "thread-chip";
    chip.dataset.threadRoot = threadRoot;
    chip.textContent = entry.replyCount === 1 ? "1 reply" : entry.replyCount + " replies";
    chip.addEventListener("click", function () {
      setOpenThreadRootId(threadRoot);
      void render();
    });
    item.append(chip);
  }

  function updateMessageRow(item, entry) {
    if (item.dataset.author !== entry.author) {
      return false;
    }
    // Scaffolding and a message are different shapes; the reconciler replaces
    // the node rather than trying to morph one into the other.
    if ((item.dataset.scaffolding === "1") !== Boolean(entry.scaffolding)) {
      return false;
    }
    if (entry.scaffolding) {
      item.dataset.rowSignature = messageRowSignature(entry);
      item.dataset.status = entry.status;
      return true;
    }
    item.dataset.rowSignature = messageRowSignature(entry);
    item.dataset.status = entry.status;
    // Not a system note: the desktop offers a thread on every message but
    // those, and the phone offers exactly what the desktop does.
    if (entry.sourceId && !entry.scaffolding && entry.status !== "queued" && entry.author !== "system") {
      item.dataset.threadRoot = entry.sourceId;
    } else {
      delete item.dataset.threadRoot;
    }
    // Rows are updated in place, so this has to be re-applied here too: a row
    // that finished while on screen must stop looking openable.
    applyStreamableState(item, entry);
    if (entry.author === "agent") {
      const avatar = item.querySelector(".message-avatar");
      const handle = item.querySelector(".message-handle");
      const status = item.querySelector(".message-status");
      const content = item.querySelector(".message-content");
      if (!avatar || !handle || !status || !content) {
        return false;
      }
      applyRowIdentity(avatar, entry);
      handle.textContent = rowHandleText(entry);
      status.textContent = messageStatusLabel(entry);
      const meta = status.parentElement;
      if (!meta) {
        return false;
      }
      syncMessageStopButton(meta, entry);
      renderMessageContentIfChanged(content, entry.content, entry.author);
      renderAttachmentsInto(attachmentsNodeFor(content.parentElement || item), entry);
      // A question answered while its row is on screen keeps its card there.
      syncAnsweredCards(content.parentElement || item, entry);
      return true;
    }
    const status = item.querySelector(".message-status");
    const content = item.querySelector(".message-content");
    if (!status || !content) {
      return false;
    }
    status.textContent = messageStatusLabel(entry);
    renderMessageContentIfChanged(content, entry.content, entry.author);
    renderAttachmentsInto(attachmentsNodeFor(content.parentElement || item), entry);
    return true;
  }

  // Nodes are consumed, not looked up by key. The old sweep asked "is this
  // node's key still wanted?", which keeps EVERY node carrying a wanted key —
  // so once two nodes ended up sharing one key, the loser was unreachable and
  // stayed on screen forever, showing an answer or a "Thinking" that the store
  // no longer had. Consuming one node per rendered row and removing whatever is
  // left over cannot leave an orphan behind, whatever the keys look like.
  function reconcileMessageRows(list, rows) {
    const existing = new Map();
    for (const child of Array.from(list.children)) {
      const bucket = existing.get(child.dataset.rowKey);
      if (bucket) {
        bucket.push(child);
      } else {
        existing.set(child.dataset.rowKey, [child]);
      }
    }
    const kept = new Set();
    let cursor = list.firstElementChild;
    for (const entry of rows) {
      const rowKey = entry.rowKey || entry.id;
      const bucket = existing.get(rowKey);
      let item = bucket && bucket.length > 0 ? bucket.shift() : undefined;
      if (!item || item.dataset.rowSignature !== messageRowSignature(entry)) {
        if (item && updateMessageRow(item, entry)) {
          // Keep the existing DOM node mounted so PWA updates do not flash.
        } else {
          const replacement = createMessageRow(entry);
          if (item) {
            const wasCursor = item === cursor;
            item.replaceWith(replacement);
            if (wasCursor) {
              cursor = replacement;
            }
          }
          item = replacement;
        }
      }
      if (item !== cursor) {
        list.insertBefore(item, cursor);
      }
      cursor = item.nextElementSibling;
      kept.add(item);
    }
    for (const child of Array.from(list.children)) {
      if (!kept.has(child)) {
        child.remove();
      }
    }
  }

  // --- members of the open chat ---------------------------------------------
  // Everything shown here is already on the phone: the chat list carries each
  // member's role and home machine. Nothing is asked of the desktop.

  let membersSheetOpen = false;

  function memberKindLabel(kind) {
    if (kind === "claude-code") {
      return "Claude Code";
    }
    if (kind === "codex-cli") {
      return "Codex CLI";
    }
    if (kind === "gemini-cli") {
      return "Gemini CLI";
    }
    return "";
  }

  // Same wording as the desktop's run-location control, from the phone's
  // point of view: the desktop is "local".
  function memberLocationLabel(member) {
    if (member.homeMachineId) {
      return member.homeMachineName || "Machine";
    }
    return "Local · desktop";
  }

  function renderMembersSheet(chat) {
    const sheet = document.getElementById("members-sheet");
    const list = document.getElementById("members-sheet-list");
    const title = document.getElementById("members-sheet-title");
    const toggle = document.getElementById("chat-members-toggle");
    if (!sheet || !list) {
      return;
    }
    sheet.hidden = !membersSheetOpen;
    keepingReaderAtLatest(applyDock);
    if (toggle) {
      toggle.setAttribute("aria-expanded", membersSheetOpen ? "true" : "false");
    }
    if (!membersSheetOpen) {
      return;
    }
    const members = chat ? selectedConversationMembers() : [];
    if (title) {
      title.textContent = members.length === 1 ? "1 member" : members.length + " members";
    }
    list.replaceChildren();
    if (members.length === 0) {
      const empty = document.createElement("div");
      empty.className = "members-sheet-empty";
      empty.textContent = "No members in this chat yet.";
      list.append(empty);
      return;
    }
    members.forEach(function (member) {
      const row = document.createElement("div");
      row.className = "members-sheet-row";
      row.dataset.handle = member.handle;
      const avatar = document.createElement("span");
      avatar.className = "mobile-mention-avatar";
      paintAvatar(avatar, avatarForMember(member), selectedConversationId());
      const copy = document.createElement("span");
      copy.className = "members-sheet-copy";
      const name = document.createElement("strong");
      name.textContent = member.displayName;
      const role = document.createElement("span");
      role.className = "members-sheet-role";
      role.textContent = [member.roleLabel, memberKindLabel(member.kind)].filter(Boolean).join(" · ");
      const location = document.createElement("span");
      location.className = "members-sheet-location";
      location.textContent = memberLocationLabel(member);
      copy.append(name, role, location);
      row.append(avatar, copy);
      list.append(row);
    });
  }

  function renderMembersSheetIfOpen(chat) {
    if (membersSheetOpen) {
      renderMembersSheet(chat);
    }
  }

  function activeChatRecord() {
    const conversationId = selectedConversationId();
    return loadChats().find(function (chat) {
      return chat.id === conversationId;
    });
  }

  function openMembersSheet() {
    membersSheetOpen = true;
    renderMembersSheet(activeChatRecord());
  }

  function closeMembersSheet() {
    membersSheetOpen = false;
    renderMembersSheet(undefined);
  }

  function wireMembersSheet() {
    const toggle = document.getElementById("chat-members-toggle");
    const sheet = document.getElementById("members-sheet");
    const close = document.getElementById("members-sheet-close");
    if (!toggle || !sheet) {
      return;
    }
    toggle.addEventListener("click", function () {
      if (!selectedConversationId()) {
        return;
      }
      if (membersSheetOpen) {
        closeMembersSheet();
      } else {
        openMembersSheet();
      }
    });
    close?.addEventListener("click", closeMembersSheet);
    sheet.addEventListener("click", function (event) {
      if (event.target instanceof Element && event.target.dataset.membersClose === "1") {
        closeMembersSheet();
      }
    });
  }

  // --- earlier messages -----------------------------------------------------
  // The desktop answers a timeline request with its last page and says whether
  // there is more before it. Each tap asks for the page before the oldest
  // message the phone was given, and the view stays where the reader was.

  let loadEarlierBusy = false;

  function renderLoadEarlier(conversationId, openThread) {
    const button = document.getElementById("load-earlier");
    if (!button) {
      return;
    }
    const page = conversationId ? timelinePageFor(conversationId) : undefined;
    const pairing = loadPairing();
    const show = Boolean(page && page.hasMoreBefore && page.beforeMessageId) &&
      !openThread &&
      Boolean(pairing && relayCanSync(pairing));
    button.hidden = !show;
    button.disabled = loadEarlierBusy;
    button.textContent = loadEarlierBusy ? "Loading…" : "Show earlier messages";
  }

  async function loadEarlierMessages() {
    const conversationId = selectedConversationId();
    const pairing = loadPairing();
    const page = conversationId ? timelinePageFor(conversationId) : undefined;
    if (!conversationId || !pairing || !relayCanSync(pairing) || !page || !page.beforeMessageId || loadEarlierBusy) {
      return;
    }
    loadEarlierBusy = true;
    renderLoadEarlier(conversationId, openThreadRootId());
    const surface = threadSurface();
    const heightBefore = surface ? surface.scrollHeight : 0;
    const topBefore = surface ? surface.scrollTop : 0;
    let failed = false;
    try {
      await requestTimelineViaRelay(pairing, conversationId, {
        beforeMessageId: page.beforeMessageId,
        deferRender: true
      });
    } catch {
      failed = true;
    } finally {
      loadEarlierBusy = false;
    }
    if (selectedConversationId() !== conversationId) {
      return;
    }
    await render(failed ? "tunnel-reconnecting" : "synced");
    if (surface && !failed) {
      // Rows were added above the reader. Keep the message they were looking at
      // exactly where it was instead of letting the list jump under them.
      surface.scrollTop = topBefore + (surface.scrollHeight - heightBefore);
      setJumpToLatestVisible(!isNearBottom(surface));
    }
  }

  // --- pull to refresh ------------------------------------------------------
  // A downward drag from the very top of a list asks the desktop again. This
  // is the only manual refresh the phone has; before it, "Waiting to sync"
  // could only be waited out.

  const PULL_REFRESH_ARM_PX = 56;
  const PULL_REFRESH_MAX_PX = 84;

  function attachPullToRefresh(scroller, indicator, refresh) {
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

  async function refreshChatList() {
    const pairing = loadPairing();
    if (!pairing || !relayCanSync(pairing)) {
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

  async function refreshOpenTimeline() {
    const pairing = loadPairing();
    const conversationId = selectedConversationId();
    if (!pairing || !relayCanSync(pairing) || !conversationId) {
      await pollMailboxTimeline().catch(function () { return 0; });
      await render();
      return;
    }
    try {
      await whileLookingForMessages(async function () {
        await requestTimelineViaRelay(pairing, conversationId);
        await pollMailboxTimeline().catch(function () { return 0; });
      });
      await render("synced");
    } catch {
      await render("tunnel-reconnecting");
    }
    ensureLiveRelayForOpenConversation();
  }

  // --- coming back to the app -----------------------------------------------
  // iOS freezes the page in the background. The socket that looks open when
  // the app returns is usually dead, and nothing would notice until the next
  // request timed out or the keep-alive ticked — up to a minute of a reply
  // that had stopped moving. Coming back asks the desktop straight away.

  const FOREGROUND_RECONNECT_AFTER_MS = 5_000;
  let hiddenSince;
  let foregroundResyncPromise;

  function dropRelaySocket(reason) {
    const socket = activeRelaySocket;
    activeRelaySocket = undefined;
    activeRelaySocketPromise = undefined;
    activeRelayTimelineCollectorSocket = undefined;
    if (socket && socket.readyState < 2) {
      socket.close(1000, reason);
    }
  }

  function resyncAfterForeground() {
    if (foregroundResyncPromise) {
      return foregroundResyncPromise;
    }
    foregroundResyncPromise = (async function () {
      const awayMs = hiddenSince ? Date.now() - hiddenSince : 0;
      hiddenSince = undefined;
      recordRelayDebug({ event: "foreground-resync", awayMs });
      await adoptWorkerUnread();
      const pairing = loadPairing();
      if (!pairing || !relayCanSync(pairing)) {
        await render();
        return;
      }
      if (awayMs > FOREGROUND_RECONNECT_AFTER_MS) {
        dropRelaySocket("mobile foreground resync");
      }
      // The box first, the socket after. Coming back from the background is
      // exactly when the live channel is half-open: each request on it waits
      // out a twenty-second ack timeout, and behind those the messages already
      // sitting in the mailbox waited too -- the User came back to a chat that
      // showed nothing until she left it and opened it again (2026-09-22).
      // The mailbox is plain HTTPS and owes nothing to the socket.
      await catchUpFromRelay();
      await render("synced");
      try {
        await requestChatListViaRelay(pairing);
        const conversationId = selectedConversationId();
        if (conversationId) {
          await requestTimelineViaRelay(pairing, conversationId);
        }
        await render("synced");
      } catch {
        await render("tunnel-reconnecting");
      }
      lastOutboxRetryAt = 0;
      await retryPendingOutbox();
      await pollMailboxTimeline().catch(function () { return 0; });
      await render();
      ensureLiveRelayForOpenConversation();
      // A launch that could not register for rings tries again here, on the
      // connection the User has now, rather than on the next launch.
      if (!pushSubscriptionEnsured) {
        void ensurePushSubscription();
      }
    })().finally(function () {
      foregroundResyncPromise = undefined;
    });
    return foregroundResyncPromise;
  }

  function wireForegroundResync() {
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        hiddenSince = Date.now();
        return;
      }
      void resyncAfterForeground();
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
  function openActivityFromNotification() {
    leaveOpenChat();
    setHomeTab("activity");
    void render("synced");
  }

  function wireWorkerMessages() {
    if (!("serviceWorker" in navigator)) {
      return;
    }
    navigator.serviceWorker.addEventListener("message", function (event) {
      if (event.data && event.data.type === "accord-open-activity") {
        openActivityFromNotification();
      }
      // A push counted while this page was open: fold it in now, so the chat
      // on screen is not left on the icon as unread until the next return.
      if (event.data && event.data.type === "accord-unread-changed") {
        void adoptWorkerUnread().then(renderChatList).catch(function () { return undefined; });
      }
    });
  }

  // --- the "/" menu ---------------------------------------------------------
  // What the desktop composer lists after "/": /compact and /goal for one clear
  // member, saved prompts, and the skills the target member can run. The
  // desktop decides the list; the phone only asks with the draft so far.

  function activeSlashQuery(value) {
    const match = String(value || "").match(/(?:^|\s)\/([A-Za-z0-9_-]*)$/);
    return match ? match[1] : undefined;
  }

  function replaceActiveSlashQuery(value, insertion) {
    const source = String(value || "");
    const match = source.match(/(?:^|\s)\/([A-Za-z0-9_-]*)$/);
    if (!match || match.index === undefined) {
      return source + (source.endsWith(" ") || !source ? "" : " ") + insertion;
    }
    const prefix = source.slice(0, match.index);
    const leadingSpace = match[0].startsWith(" ") ? " " : "";
    return prefix + leadingSpace + insertion;
  }

  function replaceSlashAtCaret(value, insertion, caret) {
    const source = String(value || "");
    const position = Number.isFinite(caret)
      ? Math.max(0, Math.min(source.length, caret))
      : source.length;
    const replacedBefore = replaceActiveSlashQuery(source.slice(0, position), insertion);
    const after = source.slice(position);
    const suffix = replacedBefore.endsWith(" ") && after.startsWith(" ") ? after.slice(1) : after;
    return { value: replacedBefore + suffix, caret: replacedBefore.length };
  }

  function skillTokenPresent(value, frontmatterName) {
    const escaped = String(frontmatterName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("(^|\\s)/" + escaped + "(?=\\s|$)").test(String(value || ""));
  }

  async function requestComposerOptionsViaRelay(pairing, conversationId, query, content) {
    const payload = await sendRelayPayload(pairing, "composer-" + createEventId(), {
      type: "mobile.composer.request",
      conversationId,
      query,
      content
    });
    if (!payload || payload.type !== "mobile.composer") {
      return { commands: [], prompts: [], skills: [] };
    }
    return {
      commands: Array.isArray(payload.commands) ? payload.commands : [],
      prompts: Array.isArray(payload.prompts) ? payload.prompts : [],
      skills: Array.isArray(payload.skills) ? payload.skills : []
    };
  }

  // A notification tapped while the app was closed opens it with the chat
  // named in the URL. The parameter is consumed once and removed, so a reload
  // does not keep re-opening that chat.
  function adoptOpenConversationFromLocation() {
    try {
      const url = new URL(globalThis.location.href);
      const open = url.searchParams.get("open");
      if (!open || !open.trim()) {
        return;
      }
      setOpenThreadRootId(undefined);
      localStorage.setItem(ACTIVE_CONVERSATION_KEY, open.trim());
      url.searchParams.delete("open");
      history.replaceState(null, "", url.pathname + (url.search || "") + (url.hash || ""));
    } catch {
      return;
    }
  }

  function wireChatSearch() {
    const toggle = document.getElementById("chat-search-toggle");
    const box = document.getElementById("chat-search");
    const input = document.getElementById("chat-search-input");
    const close = document.getElementById("chat-search-close");
    if (!toggle || !box || !input) {
      return;
    }
    function setOpen(open) {
      box.hidden = !open;
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      // The bar steps aside while searching: with the keyboard up it would sit
      // on top of the results.
      const phone = document.querySelector(".mobile-phone");
      if (phone) phone.dataset.searching = open ? "1" : "0";
      if (open) {
        input.focus();
      } else {
        input.value = "";
        chatSearchQuery = "";
        renderChatList();
      }
    }
    // The search button lives in the bottom bar, so it can be tapped from
    // Activity, Settings, or from inside a chat: it searches the chat list, so
    // it goes there first. An open chat has to be part of that test — the
    // remembered tab inside a chat is usually Chats already, and then the box
    // would open on a screen the reader cannot see.
    toggle.addEventListener("click", function () {
      if (selectedConversationId() || homeTab() !== "chats") {
        void switchHomeTab("chats");
        setOpen(true);
        return;
      }
      setOpen(box.hidden);
    });
    close?.addEventListener("click", function () {
      setOpen(false);
    });
    input.addEventListener("input", function () {
      chatSearchQuery = input.value;
      renderChatList();
    });
    input.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        setOpen(false);
      }
      if (event.key === "Enter") {
        input.blur();
      }
    });
  }

  async function init() {
    readBootstrapFromLocation(globalThis.location);
    adoptOpenConversationFromLocation();
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("service-worker.js").catch(function () {
        return undefined;
      });
    }
    const form = document.getElementById("composer-form");
    const input = document.getElementById("composer-input");
    const jump = document.getElementById("jump-to-latest");
    if (jump) {
      jump.addEventListener("click", function () {
        scrollToLatest("smooth");
      });
    }
    const surface = threadSurface();
    if (surface) {
      surface.addEventListener("scroll", function () {
        setJumpToLatestVisible(!isNearBottom(surface));
      }, { passive: true });
    }
    wireChatSearch();
    wireHomeDock();
    wireMembersSheet();
    wireImageViewer();
    wireWorkerMessages();
    // Opened from a notification while the app was not running: the worker
    // cannot postMessage to a page that does not exist yet, so it says it in
    // the URL instead.
    if (new URLSearchParams(location.search).get("tab") === "activity") {
      leaveOpenChat();
      setHomeTab("activity");
      history.replaceState(undefined, "", location.pathname);
    }
    wireForegroundResync();
    document.getElementById("load-earlier")?.addEventListener("click", function () {
      void loadEarlierMessages();
    });
    attachPullToRefresh(document.getElementById("chat-list"), document.getElementById("chat-list-refresh"), refreshChatList);
    attachPullToRefresh(surface, document.getElementById("timeline-refresh"), refreshOpenTimeline);
    const backToTimeline = document.getElementById("back-to-timeline");
    if (backToTimeline) {
      backToTimeline.addEventListener("click", function () {
        setOpenThreadRootId(undefined);
        void render();
      });
    }
    const back = document.getElementById("back-to-chats");
    if (back) {
      back.addEventListener("click", function () {
        leaveOpenChat();
        void render();
      });
    }
    if (form && input) {
      // The bar under the composer leaves while the keyboard is up and comes
      // back when it goes. Either way the chat grows or shrinks by the bar's
      // height, so a reader who was at the latest message stays there.
      function applyDockForKeyboard() {
        keepingReaderAtLatest(applyDock);
      }
      input.addEventListener("focus", applyDockForKeyboard);
      input.addEventListener("blur", applyDockForKeyboard);
      let mentionIndex = 0;
      const mentionMenu = document.getElementById("mention-menu");
      const mentionButton = document.getElementById("mention-button");

      function mentionValueBeforeCaret() {
        const caret = typeof input.selectionStart === "number" ? input.selectionStart : input.value.length;
        return input.value.slice(0, caret);
      }

      function closeMentionMenu() {
        if (mentionMenu) {
          mentionMenu.hidden = true;
          mentionMenu.textContent = "";
        }
        input.setAttribute("aria-expanded", "false");
        input.removeAttribute("aria-activedescendant");
      }

      function insertMention(member) {
        const caret = typeof input.selectionStart === "number" ? input.selectionStart : input.value.length;
        const edit = replaceMentionAtCaret(input.value, member.mentionHandle, caret);
        input.value = edit.value;
        mentionIndex = 0;
        closeMentionMenu();
        input.focus();
        input.setSelectionRange(edit.caret, edit.caret);
      }

      function renderMentionMenu() {
        if (!mentionMenu) {
          return [];
        }
        const options = mentionOptions(mentionValueBeforeCaret(), selectedConversationMembers());
        mentionMenu.textContent = "";
        if (options.length === 0) {
          closeMentionMenu();
          return [];
        }
        mentionIndex = Math.min(mentionIndex, options.length - 1);
        const title = document.createElement("div");
        title.className = "mobile-mention-title";
        title.textContent = "Members";
        mentionMenu.append(title);
        options.forEach(function (member, index) {
          const option = document.createElement("button");
          option.type = "button";
          option.id = "mention-option-" + index;
          option.className = "mobile-mention-option" + (index === mentionIndex ? " is-selected" : "");
          option.setAttribute("role", "option");
          option.setAttribute("aria-selected", index === mentionIndex ? "true" : "false");
          option.addEventListener("pointerdown", function (event) {
            event.preventDefault();
          });
          option.addEventListener("click", function () {
            insertMention(member);
          });
          const avatar = document.createElement("span");
          avatar.className = "mobile-mention-avatar";
          paintAvatar(avatar, avatarForMember(member), selectedConversationId());
          const copy = document.createElement("span");
          copy.className = "mobile-mention-copy";
          const name = document.createElement("strong");
          name.textContent = member.displayName;
          const role = document.createElement("span");
          role.textContent = member.roleLabel;
          copy.append(name, role);
          option.append(avatar, copy);
          mentionMenu.append(option);
        });
        mentionMenu.hidden = false;
        input.setAttribute("aria-expanded", "true");
        input.setAttribute("aria-activedescendant", "mention-option-" + mentionIndex);
        mentionMenu.querySelector(".is-selected")?.scrollIntoView({ block: "nearest" });
        return options;
      }

      // The "/" menu. The list is the desktop's — it knows the member the
      // draft addresses, the saved prompts and the skills that member can run —
      // so each keystroke after "/" asks it, debounced, and a stale answer is
      // dropped. Picking a skill is remembered so the message carries it the
      // way the desktop composer does, as long as its token is still in the
      // text when the message goes.
      const slashMenu = document.getElementById("slash-menu");
      let slashIndex = 0;
      let slashOptions = [];
      let slashRequestSeq = 0;
      let slashDebounceTimer;
      let slashRequestKey = "";
      let selectedSkillMentions = [];

      function slashMenuOpen() {
        return Boolean(slashMenu) && !slashMenu.hidden && slashOptions.length > 0;
      }

      function closeSlashMenu() {
        clearTimeout(slashDebounceTimer);
        slashRequestSeq += 1;
        slashRequestKey = "";
        slashOptions = [];
        if (slashMenu) {
          slashMenu.hidden = true;
          slashMenu.textContent = "";
        }
        if (!mentionMenu || mentionMenu.hidden) {
          input.setAttribute("aria-expanded", "false");
          input.removeAttribute("aria-activedescendant");
        }
      }

      function slashOptionLabel(option) {
        if (option.kind === "command") {
          return { title: option.item.label || "/" + option.item.id, detail: option.item.description || "" };
        }
        if (option.kind === "prompt") {
          return { title: "/" + option.item.trigger, detail: option.item.label || "" };
        }
        return { title: "/" + option.item.frontmatterName, detail: option.item.description || option.item.displayName || "" };
      }

      function renderSlashMenu(state) {
        if (!slashMenu) {
          return;
        }
        slashMenu.textContent = "";
        if (slashOptions.length === 0 && state === "ready") {
          closeSlashMenu();
          return;
        }
        slashIndex = Math.min(slashIndex, Math.max(0, slashOptions.length - 1));
        if (slashOptions.length === 0) {
          const note = document.createElement("div");
          note.className = "mobile-mention-title";
          note.dataset.slashState = state;
          note.textContent = state === "offline" ? "Commands need the desktop" : "Asking the desktop…";
          slashMenu.append(note);
        }
        const groups = [
          { kind: "command", title: "Commands" },
          { kind: "prompt", title: "Saved prompts" },
          { kind: "skill", title: "Skills" }
        ];
        let position = 0;
        for (const group of groups) {
          const members = slashOptions.filter(function (option) { return option.kind === group.kind; });
          if (members.length === 0) {
            continue;
          }
          const title = document.createElement("div");
          title.className = "mobile-mention-title";
          title.textContent = group.title;
          slashMenu.append(title);
          for (const option of members) {
            const index = slashOptions.indexOf(option);
            const button = document.createElement("button");
            button.type = "button";
            button.id = "slash-option-" + index;
            button.className = "mobile-mention-option mobile-slash-option" + (index === slashIndex ? " is-selected" : "");
            button.dataset.slashKind = option.kind;
            button.setAttribute("role", "option");
            button.setAttribute("aria-selected", index === slashIndex ? "true" : "false");
            button.addEventListener("pointerdown", function (event) {
              event.preventDefault();
            });
            button.addEventListener("click", function () {
              insertSlashOption(option);
            });
            const copy = document.createElement("span");
            copy.className = "mobile-mention-copy";
            const label = slashOptionLabel(option);
            const name = document.createElement("strong");
            name.textContent = label.title;
            const detail = document.createElement("span");
            detail.textContent = label.detail;
            copy.append(name, detail);
            button.append(copy);
            slashMenu.append(button);
            position += 1;
          }
        }
        slashMenu.hidden = false;
        input.setAttribute("aria-expanded", "true");
        if (position > 0) {
          input.setAttribute("aria-activedescendant", "slash-option-" + slashIndex);
          slashMenu.querySelector(".is-selected")?.scrollIntoView({ block: "nearest" });
        }
      }

      function insertSlashOption(option) {
        const caret = typeof input.selectionStart === "number" ? input.selectionStart : input.value.length;
        let insertion;
        if (option.kind === "command") {
          insertion = "/" + option.item.id + " ";
        } else if (option.kind === "prompt") {
          insertion = String(option.item.body || "").trim();
        } else {
          insertion = "/" + option.item.frontmatterName + " ";
          if (!selectedSkillMentions.some(function (mention) { return mention.skillId === option.item.skillId; })) {
            selectedSkillMentions.push(option.item);
          }
        }
        const edit = replaceSlashAtCaret(input.value, insertion, caret);
        input.value = edit.value;
        slashIndex = 0;
        closeSlashMenu();
        input.focus();
        input.setSelectionRange(edit.caret, edit.caret);
      }

      function updateSlashMenu() {
        const before = mentionValueBeforeCaret();
        const query = activeSlashQuery(before);
        if (query === undefined) {
          clearTimeout(slashDebounceTimer);
          slashRequestKey = "";
          if (slashMenu && !slashMenu.hidden) {
            closeSlashMenu();
          }
          return;
        }
        // A caret moving inside the same draft is not a new question.
        const requestKey = selectedConversationId() + "\0" + before;
        if (requestKey === slashRequestKey) {
          return;
        }
        slashRequestKey = requestKey;
        clearTimeout(slashDebounceTimer);
        const pairing = loadPairing();
        const conversationId = selectedConversationId();
        if (!pairing || !relayCanSync(pairing) || !conversationId) {
          slashOptions = [];
          renderSlashMenu("offline");
          return;
        }
        renderSlashMenu("loading");
        const seq = ++slashRequestSeq;
        const content = input.value;
        slashDebounceTimer = setTimeout(function () {
          requestComposerOptionsViaRelay(pairing, conversationId, query, content).then(function (result) {
            if (seq !== slashRequestSeq || activeSlashQuery(mentionValueBeforeCaret()) !== query) {
              return;
            }
            slashOptions = [].concat(
              result.commands.map(function (item) { return { kind: "command", item }; }),
              result.prompts.map(function (item) { return { kind: "prompt", item }; }),
              result.skills.filter(function (item) {
                return item && item.capabilityState === "invocable" && !item.ambiguous;
              }).map(function (item) { return { kind: "skill", item }; })
            );
            renderSlashMenu("ready");
          }).catch(function () {
            if (seq === slashRequestSeq) {
              slashOptions = [];
              renderSlashMenu("offline");
            }
          });
        }, 120);
      }

      // The skills a message carries are the ones still named in it: deleting
      // the "/name" token drops the skill, as it does on the desktop.
      function takeSkillMentions(content) {
        const carried = selectedSkillMentions.filter(function (mention) {
          return skillTokenPresent(content, mention.frontmatterName);
        });
        selectedSkillMentions = [];
        return carried;
      }

      input.addEventListener("input", function () {
        mentionIndex = 0;
        renderMentionMenu();
        slashIndex = 0;
        updateSlashMenu();
      });
      document.addEventListener("selectionchange", function () {
        if (document.activeElement === input && mentionMenu && !mentionMenu.hidden) {
          renderMentionMenu();
        }
        if (document.activeElement === input && slashMenu && !slashMenu.hidden) {
          updateSlashMenu();
        }
      });
      // Every control in the composer row needs this, not just the mention one.
      // A tap on a button moves focus off the textarea, iOS puts the keyboard
      // away, and the click only lands afterwards — so the first tap looks like
      // it just closed the keyboard and did nothing.
      function keepFieldFocusedOnTap(element) {
        if (!element) {
          return;
        }
        element.addEventListener("pointerdown", function (event) {
          if (document.activeElement === input) {
            event.preventDefault();
          }
        });
      }

      if (mentionButton) {
        keepFieldFocusedOnTap(mentionButton);
        mentionButton.addEventListener("click", function () {
          const edit = mentionShortcutEdit(input.value, input.selectionStart, input.selectionEnd);
          input.value = edit.value;
          input.focus();
          input.setSelectionRange(edit.caret, edit.caret);
          mentionIndex = 0;
          renderMentionMenu();
        });
      }
      const attachButton = document.getElementById("attach-button");
      const imageInput = document.getElementById("composer-image-input");
      keepFieldFocusedOnTap(attachButton);
      keepFieldFocusedOnTap(document.getElementById("send-button"));
      if (attachButton && imageInput) {
        attachButton.addEventListener("click", function () {
          imageInput.click();
        });
        imageInput.addEventListener("change", async function () {
          const rejected = await addPendingAttachments(imageInput.files);
          // Clearing lets the same file be picked again after removing it.
          imageInput.value = "";
          renderPendingAttachments();
          if (rejected.length > 0) {
            const state = document.getElementById("connection-state");
            if (state) {
              state.textContent = "Not attached: " + rejected.join("; ");
            }
          }
        });
      }
      input.addEventListener("keydown", function (event) {
        if (slashMenuOpen()) {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            slashIndex = (slashIndex + 1) % slashOptions.length;
            renderSlashMenu("ready");
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            slashIndex = (slashIndex - 1 + slashOptions.length) % slashOptions.length;
            renderSlashMenu("ready");
            return;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            insertSlashOption(slashOptions[slashIndex] || slashOptions[0]);
            return;
          }
        }
        if (event.key === "Escape" && slashMenu && !slashMenu.hidden) {
          closeSlashMenu();
          return;
        }
        const options = mentionOptions(mentionValueBeforeCaret(), selectedConversationMembers());
        if (options.length > 0 && event.key === "ArrowDown") {
          event.preventDefault();
          mentionIndex = (mentionIndex + 1) % options.length;
          renderMentionMenu();
          return;
        }
        if (options.length > 0 && event.key === "ArrowUp") {
          event.preventDefault();
          mentionIndex = (mentionIndex - 1 + options.length) % options.length;
          renderMentionMenu();
          return;
        }
        if (options.length > 0 && (event.key === "Enter" || event.key === "Tab")) {
          event.preventDefault();
          insertMention(options[mentionIndex] || options[0]);
          return;
        }
        if (event.key === "Escape") {
          closeMentionMenu();
        }
      });
      input.addEventListener("blur", function () {
        setTimeout(closeMentionMenu, 0);
        setTimeout(closeSlashMenu, 0);
      });
      // One tap, one send. The form's submit event is not enough on the phone:
      // the send button keeps the field focused so the keyboard does not shove
      // the layout mid-tap, and a tap that changes nothing on screen can be
      // dropped before it becomes a click -- which is how a tap came to only
      // put the keyboard away, leaving the message sitting there (the User,
      // 2026-09-21). The button therefore sends on pointerup as well, and
      // submitComposer makes the two paths one send: it empties the field and
      // takes the pictures before its first wait, so the second path finds
      // nothing. A flag held across the whole send did that too, and more: it
      // also dropped the next message typed while the first was still going
      // out over a slow connection, with nothing on screen to say so.
      const sendComposer = function () {
        return submitComposer();
      };
      // Slack's shape: one line until it is tapped, then the row of tools.
      // Anything already written keeps it open, so a draft is never left
      // without a way to send it.
      const composerForm = document.getElementById("composer-form");
      const updateComposerShape = function () {
        if (!composerForm) return;
        const open = document.activeElement === input ||
          Boolean(input.value.trim()) ||
          pendingAttachments.length > 0;
        composerForm.dataset.expanded = open ? "1" : "";
      };
      input.addEventListener("focus", updateComposerShape);
      input.addEventListener("blur", updateComposerShape);
      input.addEventListener("input", updateComposerShape);
      updateComposerShape();
      const sendButton = document.getElementById("send-button");
      if (sendButton) {
        sendButton.addEventListener("pointerup", function (event) {
          event.preventDefault();
          void sendComposer();
        });
      }
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        void sendComposer();
      });
      async function submitComposer() {
        const content = input.value.trim();
        const conversationId = selectedConversationId();
        // A picture on its own is a message.
        if ((!content && pendingAttachments.length === 0) || !conversationId) {
          return;
        }
        input.value = "";
        // The message is gone, so the keyboard has nothing left to do: it goes
        // down and gives the screen back, instead of sitting over the reply
        // the User just asked for. The composer goes back to one line with it.
        input.blur();
        updateComposerShape();
        closeSlashMenu();
        const attachments = takePendingAttachments();
        const skillMentions = takeSkillMentions(content);
        // A reply written with a thread open belongs to that thread. Without
        // this the desktop had nothing to place it by and put it in the main
        // timeline, where the User -- still looking at the thread -- could not
        // see her own message at all (the User, 2026-09-21).
        const threadRootId = openThreadRootId();
        const carriesExtras = attachments.length > 0 || skillMentions.length > 0 || Boolean(threadRootId);
        await enqueueMessage({
          content,
          conversationId,
          ...(threadRootId ? { threadRootId } : {}),
          ...(carriesExtras
            ? {
              payload: {
                content,
                ...(threadRootId ? { threadRootId } : {}),
                ...(attachments.length > 0 ? { attachments } : {}),
                ...(skillMentions.length > 0 ? { skillMentions } : {})
              }
            }
            : {})
        });
        await render();
        // Sending is a deliberate action, so following it is expected.
        scrollToLatestWhenSettled("auto");
        const flushResult = await flushOutbox();
        // The desktop first; if it is not there, the member's own machine.
        if (desktopDidNotTake(flushResult.status)) {
          await driveMachineForPendingMessages(conversationId).catch(function (error) {
            recordRelayDebug({ event: "machine-drive-failed", message: String(error && error.message || error) });
            return 0;
          });
        }
        await pollMailboxTimeline().catch(function () {
          return 0;
        });
        await render(flushResult.status);
      }
    }
    // Cached rows are visible before synchronization finishes. Their controls
    // and elapsed time must work throughout those network waits.
    wireStreamView();
    startThinkingClock();
    startSyncProgressClock();
    // Internal system rows stored before the desktop stopped sending them
    // would otherwise sit in the timeline forever: nothing ever asks the phone
    // to drop a row it once received.
    await dropStoredInternalSystemRows().catch(function () { return 0; });
    // What the queue holds, so a card can say whether its answer went out and
    // the periodic retry knows there is something to offer.
    await listOutboxEntries().catch(function () { return []; });
    await render();
    // What a push-woken worker counted while the app was closed, folded in
    // before the lists paint again; the icon number follows.
    await adoptWorkerUnread().catch(function () { return undefined; });
    // The connections to this phone's machines come up first and independently
    // of the desktop. Waiting for the desktop here is what made a closed
    // desktop a phone that could do nothing: everything the machine owes this
    // phone, and everything this phone still owes the machine, is settled on
    // this connection whether or not the desktop is anywhere.
    await restoreMachineTerminals().catch(function () { return 0; });
    void machineChannels().then(function (channels) {
      if (channels) return channels.deliver().catch(function () { return undefined; });
      return undefined;
    }).catch(function () { return undefined; });
    const pairing = loadPairing();
    if (pairing && relayCanSync(pairing)) {
      try {
        await requestChatListViaRelay(pairing);
        // While the desktop is here: register this phone's signing key and
        // pick up the machines it may reach when the desktop is not.
        await announceMachineIdentityViaRelay(pairing).catch(function () { return undefined; });
        await render("synced");
        const conversationId = selectedConversationId();
        if (conversationId) {
          await requestTimelineViaRelay(pairing, conversationId);
          await render("synced");
        }
      } catch {
        await render("tunnel-reconnecting");
      }
    }
    const flushResult = await flushOutbox();
    // Everything the box has held since this phone was last open, taken in one
    // go behind a single "Catching up" rather than page by page on screen.
    await catchUpFromRelay();
    await render(flushResult.status);
    startMailboxTimelinePolling();
    ensureLiveRelayForOpenConversation();
    startRelayTimelineKeepAlive();
  }

  globalThis.AccordAgentsMobile = {
    // W-K's harness drives the real user path — permission prompt, subscribe,
    // POST, render — rather than a stand-in for it.
    enableMessageAlerts,
    ensurePushSubscription,
    whileLookingForMessages,
    reconnectMessageAlerts,
    ensureLiveRelayForOpenConversation,
    createOutboxEvent,
    enqueueMessage,
    enqueueRunCancel,
    stopRunFromPhone,
    flushOutbox,
    flushOutboxViaMailbox,
    flushOutboxViaRelay,
    handleRelayChatListPayload,
    handleRelayTimelinePayload,
    reconcilePendingControlCards,
    retryPendingOutbox,
    isCardSent,
    isCardLocked,
    desktopOwesEntry,
    machineTimelineEvent,
    activeMentionQuery,
    mentionOptions,
    replaceActiveMention,
    mentionShortcutEdit,
    replaceMentionAtCaret,
    isCancellableMobileRow,
    requestChatListViaRelay,
    announceMachineIdentityViaRelay,
    commandMachineTurn,
    commandMachineCancel,
    commandMachineAction,
    driveMachineForPendingMessages,
    machineMemberFor,
    machineChannels,
    machineAccessList,
    storeMachineAccess,
    machineCommandIdentity,
    requestTimelineViaRelay,
    openRelayPayload,
    readBootstrapFromLocation,
    reassembleRelayCiphertext,
    sealRelayPayload,
    chunkRelayCiphertext,
    listOutboxEntries,
    listTimelineEntries,
    dedupeTimelineEntries,
    reconcileMessageRows,
    timelineEntryDedupeKey,
    timelineRenderRowKey,
    updateMessageRow,
    loadPairing,
    connectionStatusText,
    renderMessageContent,
    timelineAttachmentsFromEvent,
    addPendingAttachments,
    takePendingAttachments,
    preparePickedImage,
    savePairing,
    chatMatchesQuery,
    filterChatsByQuery,
    formatClockTime,
    messageStatusLabel,
    activeSlashQuery,
    replaceActiveSlashQuery,
    replaceSlashAtCaret,
    skillTokenPresent,
    requestComposerOptionsViaRelay,
    loadUnreadConversationIds,
    markConversationsUnread,
    markConversationRead,
    adoptWorkerUnread,
    resyncAfterForeground,
    dropRelaySocket,
    loadEarlierMessages,
    timelinePageFor,
    saveTimelinePage,
    refreshChatList,
    refreshOpenTimeline,
    openImageViewer,
    closeImageViewer,
    openMembersSheet,
    closeMembersSheet,
    openActivityFromNotification
  };

  // iOS reports a height at first paint that is taller than what you can
  // actually see, so the composer starts half off the bottom of the screen —
  // and the page is deliberately unscrollable now, so nothing brings it back
  // until the keyboard opens and closes and forces a re-measure. Measure the
  // usable height ourselves instead of letting CSS inherit that first value.
  // Tracking visualViewport also means the composer rides above the keyboard
  // rather than sitting behind it.
  function trackUsableHeight() {
    const viewport = typeof window !== "undefined" ? window.visualViewport : null;
    let lastHeight = 0;
    let lastWidth = 0;
    function apply() {
      const width = window.innerWidth;
      // Never measure while the composer is focused: on iOS the keyboard is
      // covering part of the screen and every frame of its animation reports a
      // different height, so resizing on each one made the whole screen jump
      // the moment the input was tapped. A width change is a rotation, which
      // the keyboard cannot cause, so that one is honoured either way.
      if (composerHasFocus() && width === lastWidth) {
        return;
      }
      const height = viewport ? viewport.height : window.innerHeight;
      if (height <= 0 || (height === lastHeight && width === lastWidth)) {
        return;
      }
      lastHeight = height;
      lastWidth = width;
      // A reader sitting at the latest message stays there across a rotation.
      keepingReaderAtLatest(function () {
        document.documentElement.style.setProperty("--app-h", height + "px");
      });
    }
    // A single sample can land mid-animation — the keyboard sliding away, a
    // rotation still turning — and then stick, because nothing would come
    // along to correct it. Sample across the whole animation instead.
    function remeasure() {
      apply();
      applyDock();
      [150, 350, 600, 900].forEach(function (delay) {
        setTimeout(apply, delay);
      });
    }
    remeasure();
    // The height iOS reports at first paint is too tall; the real one only
    // exists after the first frame.
    requestAnimationFrame(apply);
    window.addEventListener("resize", remeasure);
    window.addEventListener("orientationchange", remeasure);
    // Coming back from the background is the other moment the height can be
    // stale with no resize to announce it.
    window.addEventListener("pageshow", remeasure);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) {
        remeasure();
      }
    });
    document.addEventListener("focusout", remeasure);
  }

  if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", function () {
      trackUsableHeight();
      init().catch(function (error) {
        const state = document.getElementById("connection-state");
        if (state) {
          state.textContent = error instanceof Error ? error.message : String(error);
        }
      });
    });
  }
})();
