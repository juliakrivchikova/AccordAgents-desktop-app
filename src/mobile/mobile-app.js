(function () {
  const DB_NAME = "accordagents-mobile-control";
  const DB_VERSION = 3;
  const META_STORE = "meta";
  const SEALED_STORE = "sealedEnvelopes";
  const MAILBOX_ACCESS_META_KEY = "mailboxAccess";
  const OUTBOX_STORE = "outbox";
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
  let activeFlushOutboxPromise;
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
  // (src/mobile/mobile-app.js, between the generated markers), into the cloud
  // runner script (src/main/services/mobileMailboxRunnerCrypto.generated.ts),
  // and regenerates the known-answer fixture
  // (scripts/mailbox-contract-vectors.json). Edit here, run the generator, and
  // commit the regenerated outputs together — a stale copy is a review failure.
  //
  // Plain JS with zero imports so the same text runs in the browser page, the
  // phone's service worker, and the cloud runner (Node >= 18.17 exposes
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
      if (!subscription) {
        const vapidUrl = new URL("/v1/push/vapid", endpoint);
        const vapidBody = await (await fetch(vapidUrl.toString())).json();
        if (!vapidBody?.publicKey) {
          return;
        }
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
    return new Promise(function (resolve, reject) {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function () {
        const db = request.result;
        if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
          const store = db.createObjectStore(OUTBOX_STORE, { keyPath: "eventId" });
          store.createIndex("status", "status", { unique: false });
          store.createIndex("createdAt", "createdAt", { unique: false });
        }
        if (!db.objectStoreNames.contains(TIMELINE_STORE)) {
          const store = db.createObjectStore(TIMELINE_STORE, { keyPath: "id" });
          store.createIndex("createdAt", "createdAt", { unique: false });
        }
        // W5: the service worker's stores. meta mirrors the non-decrypting
        // mailbox credentials plus the shared cursor; sealedEnvelopes holds
        // what a push-woken fetch stored, still sealed, for the page to open.
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(SEALED_STORE)) {
          db.createObjectStore(SEALED_STORE, { keyPath: "eventId" });
        }
      };
      request.onerror = function () {
        reject(request.error || new Error("IndexedDB open failed."));
      };
      request.onsuccess = function () {
        resolve(request.result);
      };
    });
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

  function putOutboxEntry(entry) {
    return withOutbox("readwrite", function (store) {
      return requestToPromise(store.put(entry));
    });
  }

  function withTimeline(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(TIMELINE_STORE, mode);
        const store = tx.objectStore(TIMELINE_STORE);
        let value;
        tx.onerror = function () {
          reject(tx.error || new Error("Timeline transaction failed."));
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

  function isScaffoldingEntry(entry) {
    return Boolean(entry) &&
      entry.role === "participant" &&
      entry.status === "pending" &&
      isPlaceholderTimelineContent(entry.content);
  }

  function sameMobileEvent(left, right) {
    return Boolean(left.mobileEventId) &&
      left.mobileEventId === right.mobileEventId &&
      (!left.conversationId || !right.conversationId || left.conversationId === right.conversationId);
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
  function putTimelineEntryDeduped(entry) {
    const key = timelineEntryDedupeKey(entry);
    return withTimeline("readwrite", function (store) {
      return requestToPromise(store.getAll()).then(function (entries) {
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
        const deletes = others.filter(function (existing) {
          if (key && timelineEntryDedupeKey(existing) === key) {
            return true;
          }
          return !isScaffoldingEntry(entry) &&
            entry.role === "participant" &&
            isScaffoldingEntry(existing) &&
            sameMobileEvent(entry, existing);
        }).map(function (existing) {
          return requestToPromise(store.delete(existing.id));
        });
        return Promise.all(deletes).then(function () {
          return requestToPromise(store.put(entry));
        });
      });
    });
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

  function deletePendingTimelineEntriesForRun(conversationId, runId, mobileEventId, messageId, status) {
    if (!runId && !mobileEventId && !messageId) {
      return Promise.resolve(0);
    }
    const wholeMessageFailed = isPhoneMessageFailure(status, runId, mobileEventId);
    return withTimeline("readwrite", function (store) {
      return requestToPromise(store.getAll()).then(function (entries) {
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
            (!conversationId || entry.conversationId === conversationId || entry.conversationId === undefined);
        }).map(function (entry) {
          return requestToPromise(store.delete(entry.id));
        });
        return Promise.all(deletes).then(function () {
          return deletes.length;
        });
      });
    });
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
      return requestToPromise(store.getAll()).then(function (entries) {
        const deletes = entries.filter(function (entry) {
          if (!entry || entry.status !== "pending" || !isPlaceholderTimelineContent(entry.content)) {
            return false;
          }
          if (conversationId && entry.conversationId !== conversationId && entry.conversationId !== undefined) {
            return false;
          }
          const created = Date.parse(entry.createdAt || "");
          return Number.isFinite(created) && terminalTime - created > PLACEHOLDER_CORPSE_AGE_MS;
        }).map(function (entry) {
          return requestToPromise(store.delete(entry.id));
        });
        return Promise.all(deletes).then(function () {
          return deletes.length;
        });
      });
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
      return requestToPromise(store.getAll());
    }).then(function (entries) {
      return entries.filter(function (entry) {
        return !conversationId || entry.conversationId === conversationId || entry.conversationId === undefined;
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
      return entries.filter(function (entry) {
        return !conversationId || entry.conversationId === conversationId;
      }).sort(function (left, right) {
        return left.createdAt.localeCompare(right.createdAt) || left.eventId.localeCompare(right.eventId);
      });
    });
  }

  function loadChats() {
    try {
      const raw = localStorage.getItem(CHAT_LIST_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveChats(chats) {
    if (Array.isArray(chats) && chats.length > 0) {
      sessionStorage.removeItem(SYNC_WAIT_KEY);
    }
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
    return normalized;
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
      avatarId: typeof value.avatarId === "string" ? value.avatarId : undefined
    };
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

  function selectedConversationMembers() {
    const conversationId = selectedConversationId();
    const chat = loadChats().find(function (item) {
      return item.id === conversationId;
    });
    if (!chat) {
      return [];
    }
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
    return active && active !== "unpaired" ? active : undefined;
  }

  async function createOutboxEvent(input) {
    const pairing = loadPairing();
    const eventId = input.eventId || createEventId();
    const createdAt = input.createdAt || nowIso();
    const conversationId = activeConversationId(input.conversationId);
    const logScopeId = input.logScopeId || conversationId;
    const originId = await mobileOriginId(pairing);
    const originSeq = await nextOriginSeq(originId, logScopeId);
    const payload = {
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
      kind: "message.created",
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
      kind: "message.created",
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

  function enqueueMessage(input) {
    return createOutboxEvent(input).then(function (entry) {
      return putOutboxEntry(entry).then(function () {
        return entry;
      });
    });
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

  async function nextOriginSeq(originId, logScopeId) {
    const entries = await listOutboxEntries();
    return entries.filter(function (entry) {
      return entry.originId === originId && entry.logScopeId === logScopeId && Number.isSafeInteger(entry.originSeq);
    }).reduce(function (max, entry) {
      return Math.max(max, entry.originSeq);
    }, 0) + 1;
  }

  async function previousEventHash(originId, logScopeId) {
    const entries = await listOutboxEntries();
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
    const pendingEntries = entries.filter(function (entry) {
      return entry.status !== "acked";
    });
    if (pendingEntries.length === 0) {
      return { status: "synced", sent: 0, pending: 0 };
    }
    const socket = await getRelaySocket(relayUrl, pairing);
    ensureRelayTimelineCollector(socket, pairing);
    let sent = 0;
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
        throw new Error("Relay ack eventId mismatch.");
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
    return { status: "synced", sent, pending: 0 };
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
    activeRelaySocketPromise = openRelaySocket(relayUrl, pairing).then(function (socket) {
      activeRelaySocket = socket;
      socket.addEventListener("close", function () {
        if (activeRelaySocket === socket) {
          activeRelaySocket = undefined;
          activeRelaySocketPromise = undefined;
          activeRelayTimelineCollectorSocket = undefined;
        }
      }, { once: true });
      return socket;
    }).catch(function (error) {
      activeRelaySocket = undefined;
      activeRelaySocketPromise = undefined;
      activeRelayTimelineCollectorSocket = undefined;
      throw error;
    });
    return activeRelaySocketPromise;
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
      ciphertext: request.ciphertext
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

  async function requestTimelineViaRelay(pairing, conversationId) {
    const payload = await sendRelayPayload(pairing, "timeline-" + conversationId + "-" + createEventId(), {
      type: "mobile.timeline.request",
      conversationId
    });
    return handleRelayTimelinePayload(payload, conversationId);
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
      url.searchParams.set("limit", "500");
      url.searchParams.set("afterArrival", String(Math.max(0, afterArrival)));
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: Object.assign({ "accept": "application/json" }, request.headers)
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
      return drained;
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
    let stored = drained;
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
    return stored;
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
      // Polling only wrote to storage; without this the timeline never
      // repainted, so arriving messages stayed invisible until the next
      // send or reload.
      pollMailboxTimeline().then(function (stored) {
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

  function handleRelayChatListPayload(payload) {
    if (payload?.type !== "mobile.chat-list" || !Array.isArray(payload.chats)) {
      return [];
    }
    return saveChats(payload.chats);
  }

  async function handleRelayTimelinePayload(payload, fallbackConversationId, options) {
    if (payload?.type !== "mobile.timeline.events" || !Array.isArray(payload.events)) {
      return 0;
    }
    const conversationId = payload.conversationId || fallbackConversationId || selectedConversationId();
    let stored = 0;
    for (const event of payload.events) {
      if (!event || typeof event !== "object") {
        continue;
      }
      const id = typeof event.id === "string" && event.id.trim() ? event.id : createEventId();
      const content = typeof event.content === "string" ? event.content.trim() : "";
      if (!content) {
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
      if (status !== "pending" && role === "participant" && (runId || mobileEventId || messageId)) {
        await deletePendingTimelineEntriesForRun(conversationId, runId, mobileEventId, messageId, status);
        rememberTerminalRun(runId, mobileEventId, createdAt);
        await deleteStalePlaceholderTimelineEntries(conversationId, createdAt);
      }
      if (status === "pending" && isSupersededPendingEvent(runId, mobileEventId, createdAt)) {
        continue;
      }
      await putTimelineEntryDeduped({
        id: conversationId ? conversationId + ":" + id : id,
        sourceId: id,
        conversationId,
        role,
        participantLabel: typeof event.participantLabel === "string" ? event.participantLabel : undefined,
        content,
        status,
        createdAt,
        runId,
        messageId: typeof event.messageId === "string" ? event.messageId : undefined,
        threadRootId: typeof event.threadRootId === "string" && event.threadRootId.trim()
          ? event.threadRootId
          : undefined,
        mobileEventId
      });
      stored += 1;
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
          const stored = await handleRelayTimelinePayload(payload, undefined, { deferRender: true });
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

  function flushOutbox(options) {
    if (activeFlushOutboxPromise) {
      return activeFlushOutboxPromise;
    }
    activeFlushOutboxPromise = flushOutboxInternal(options).finally(function () {
      activeFlushOutboxPromise = undefined;
    });
    return activeFlushOutboxPromise;
  }

  async function flushOutboxInternal(options) {
    const pairing = loadPairing();
    const endpoint = outboxEndpoint(options && options.endpoint);
    const entries = await listOutboxEntries(selectedConversationId());
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
    const pendingEntries = entries.filter(function (entry) {
      return entry.status !== "acked";
    });
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
          body: JSON.stringify({ events: [event] })
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

  function chatInitial(title, index) {
    const normalized = (title || "Chat").trim();
    return normalized.charAt(0).toUpperCase() || String(index + 1);
  }

  function avatarAssetFor(label) {
    const normalized = String(label || "").toLowerCase();
    if (normalized.includes("taylor") || normalized.includes("claude-reviewer") || normalized.includes("bunny")) {
      return "assets/avatars/claude-bunny.png";
    }
    if (normalized.includes("morgan") || normalized.includes("claude-cat")) {
      return "assets/avatars/claude-cat.png";
    }
    if (normalized.includes("admin") || normalized.includes("perf") || normalized.includes("hamster")) {
      return "assets/avatars/codex-hamster.png";
    }
    if (normalized.includes("dog")) {
      return "assets/avatars/codex-dog.png";
    }
    if (normalized.includes("drew") || normalized.includes("codex")) {
      return "assets/avatars/codex-frog.png";
    }
    return undefined;
  }

  function fillAvatar(avatar, label, index, size) {
    const asset = avatarAssetFor(label);
    if (asset) {
      const img = document.createElement("img");
      img.src = asset;
      img.alt = "";
      avatar.textContent = "";
      avatar.append(img);
      return;
    }
    const [color, soft] = avatarColor(index);
    avatar.style.color = color;
    avatar.style.background = soft;
    avatar.textContent = chatInitial(label, index);
    if (size) {
      avatar.style.fontSize = size;
    }
  }

  function avatarColor(index) {
    const colors = [
      ["#7d5fd3", "#efebfb"],
      ["#6e8bf0", "#ebeefc"],
      ["#0e9f6e", "#e7f6ef"],
      ["#d97706", "#fff3df"]
    ];
    return colors[index % colors.length];
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

  function renderMessageContentIfChanged(container, markdown) {
    const source = String(markdown || "");
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

  function renderChatList() {
    const listContainer = document.getElementById("chat-list");
    if (listContainer) {
      delete listContainer.dataset.state;
    }
    const container = document.getElementById("chat-list");
    if (!container) {
      return;
    }
    const chats = loadChats();
    const activeId = selectedConversationId();
    const renderSignature = JSON.stringify({
      activeId,
      chats: chats.map(function (chat) {
        return {
          id: chat.id,
          title: chat.title,
          group: chat.group,
          snippet: chat.snippet,
          who: chat.who,
          running: chat.running,
          updatedAt: chat.updatedAt,
          participants: chat.participants
        };
      })
    });
    if (lastChatListRenderSignature === renderSignature) {
      return;
    }
    lastChatListRenderSignature = renderSignature;
    container.textContent = "";
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
      const title = document.createElement("div");
      title.className = "mobile-chat-group-title";
      title.textContent = group.name;
      const list = document.createElement("div");
      list.className = "mobile-chat-group";
      for (const chat of group.items) {
        const row = document.createElement("button");
        row.className = "mobile-chat-row" + (chat.id === activeId ? " is-active" : "");
        row.type = "button";
        row.addEventListener("click", function () {
          localStorage.setItem(ACTIVE_CONVERSATION_KEY, chat.id);
          void render("synced").then(function () {
            const pairing = loadPairing();
            if (pairing && relayCanSync(pairing)) {
              return requestTimelineViaRelay(pairing, chat.id).then(function () {
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
        });
        const avatars = document.createElement("div");
        avatars.className = "mobile-chat-avatars";
        const participants = chat.participants.length > 0 ? chat.participants : [chat.title];
        participants.slice(0, 2).forEach(function (participant, index) {
          const avatar = document.createElement("span");
          avatar.className = "mobile-chat-avatar";
          fillAvatar(avatar, participant.replace(/^@/, ""), index);
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
        const snippet = document.createElement("div");
        snippet.className = "mobile-chat-snippet";
        if (chat.who) {
          const who = document.createElement("b");
          who.textContent = chat.who;
          snippet.append(who);
        }
        const snippetText = document.createElement("span");
        snippetText.textContent = chat.snippet;
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

  function renderThreadHeader(openThreadRoot) {
    const back = document.getElementById("back-to-timeline");
    const title = document.getElementById("chat-title");
    if (!back) {
      return;
    }
    const shouldShow = Boolean(openThreadRoot);
    if (back.classList.contains("is-visible") !== shouldShow) {
      back.classList.toggle("is-visible", shouldShow);
    }
    if (openThreadRoot && title) {
      title.textContent = "Thread";
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

  async function render(connectionStatus) {
    const state = document.getElementById("connection-state");
    const list = document.getElementById("message-list");
    const chatsScreen = document.getElementById("chats-screen");
    const timelineScreen = document.getElementById("timeline-screen");
    const title = document.getElementById("chat-title");
    const activeId = selectedConversationId();
    if (!state || !list || !chatsScreen || !timelineScreen) {
      return;
    }
    if (!loadPairing()) {
      renderUnpairedNotice();
      chatsScreen.classList.add("is-active");
      timelineScreen.classList.remove("is-active");
      return;
    }
    if (mailboxAuthRejected) {
      renderUnpairedNotice(
        "This device's access was revoked from the desktop. " +
        "Scan the QR code or paste a fresh pairing link to reconnect.",
        "revoked"
      );
      chatsScreen.classList.add("is-active");
      timelineScreen.classList.remove("is-active");
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
    chatsScreen.classList.toggle("is-active", !activeId);
    timelineScreen.classList.toggle("is-active", Boolean(activeId));
    if (!activeId) {
      // Reopening the same chat should land at the latest message again.
      lastScrolledConversationId = undefined;
      return;
    }
    const activeChat = loadChats().find(function (chat) {
      return chat.id === activeId;
    });
    if (title) {
      title.textContent = activeChat?.title || "AccordAgents";
    }
    const entries = await listOutboxEntries(activeId);
    const timelineEntries = await listTimelineEntries(activeId);
    const outboxContent = new Set(entries.map(function (entry) {
      return entry.payload.content.trim();
    }));
    const visibleTimelineEntries = dedupeTimelineEntries(timelineEntries.filter(function (entry) {
      return !(entry.role === "you" && outboxContent.has(entry.content.trim()));
    }));
    const pending = entries.filter(function (entry) {
      return entry.status !== "acked";
    }).length;
    state.textContent = connectionStatus
      ? connectionStatusText(connectionStatus)
      : pending > 0 ? "Waiting to sync" : "Synced";
    let rows = entries.map(function (entry) {
      return {
        rowKey: "outbox\0" + entry.eventId,
        id: entry.eventId,
        author: "you",
        content: entry.payload.content,
        status: statusText(entry.status),
        createdAt: entry.createdAt
      };
    }).concat(visibleTimelineEntries.map(function (entry) {
      return {
        rowKey: timelineRenderRowKey(entry),
        id: entry.id,
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
    if (!view || !body || !label || !state) {
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
    // (e) When the run finishes the view stays and shows the finished answer;
    // leaving is the reader's decision, not ours.
    state.textContent = row.status === "Running"
      ? (connectionStatus === "synced" || connectionStatus === undefined ? "Writing…" : "Writing… (reconnecting)")
      : row.status;
    const text = isThinkingEntry(row) ? "" : (row.content || "");
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
    const list = document.getElementById("message-list");
    if (!view || !body || !close || !list || view.dataset.wired === "1") {
      return;
    }
    view.dataset.wired = "1";
    close.addEventListener("click", function () {
      setOpenStreamRunId(undefined);
      view.hidden = true;
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
      identified: entry.identified,
      scaffolding: entry.scaffolding,
      content: entry.content,
      status: entry.status
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
  function rowHandleText(entry) {
    return entry.identified === false ? "" : (entry.participantLabel || "Agent");
  }

  function applyRowIdentity(avatar, entry) {
    if (entry.identified === false) {
      if (avatar.dataset.avatarLabel !== "") {
        avatar.textContent = "";
        avatar.removeAttribute("style");
        avatar.dataset.avatarLabel = "";
      }
      avatar.dataset.identified = "0";
      return;
    }
    const participantLabel = entry.participantLabel || "Agent";
    if (avatar.dataset.avatarLabel !== participantLabel) {
      avatar.textContent = "";
      avatar.removeAttribute("style");
      fillAvatar(avatar, participantLabel, 0, "13px");
      avatar.dataset.avatarLabel = participantLabel;
    }
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

  function createMessageRow(entry) {
    const item = document.createElement("li");
    item.className = "message-row";
    item.dataset.rowKey = entry.rowKey || entry.id;
    item.dataset.rowSignature = messageRowSignature(entry);
    item.dataset.status = entry.status;
    item.dataset.author = entry.author;
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
      status.textContent = entry.status;
      const content = document.createElement("div");
      content.className = "message-content";
      if (isThinkingEntry(entry)) {
        renderThinkingInto(content, entry);
      } else {
        renderMessageContentIfChanged(content, entry.content);
      }
      meta.append(handle, status);
      copy.append(meta, content);
      item.append(avatar, copy);
    } else {
      const bubble = document.createElement("div");
      bubble.className = "message-bubble";
      const content = document.createElement("div");
      content.className = "message-content";
      renderMessageContentIfChanged(content, entry.content);
      const meta = document.createElement("div");
      meta.className = "message-status";
      meta.textContent = entry.status;
      bubble.append(content, meta);
      item.append(bubble);
    }
    appendThreadChip(item, entry);
    return item;
  }

  function appendThreadChip(item, entry) {
    if (!entry.replyCount) {
      return;
    }
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "thread-chip";
    chip.dataset.threadRoot = entry.sourceId;
    chip.textContent = entry.replyCount === 1 ? "1 reply" : entry.replyCount + " replies";
    chip.addEventListener("click", function () {
      setOpenThreadRootId(entry.sourceId);
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
      status.textContent = entry.status;
      renderMessageContentIfChanged(content, entry.content);
      return true;
    }
    const status = item.querySelector(".message-status");
    const content = item.querySelector(".message-content");
    if (!status || !content) {
      return false;
    }
    status.textContent = entry.status;
    renderMessageContentIfChanged(content, entry.content);
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

  async function init() {
    readBootstrapFromLocation(globalThis.location);
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
        setOpenThreadRootId(undefined);
        localStorage.removeItem(ACTIVE_CONVERSATION_KEY);
        void render();
      });
    }
    if (form && input) {
      let mentionIndex = 0;
      const mentionMenu = document.getElementById("mention-menu");

      function closeMentionMenu() {
        if (mentionMenu) {
          mentionMenu.hidden = true;
          mentionMenu.textContent = "";
        }
        input.setAttribute("aria-expanded", "false");
        input.removeAttribute("aria-activedescendant");
      }

      function insertMention(member) {
        input.value = replaceActiveMention(input.value, member.mentionHandle);
        mentionIndex = 0;
        closeMentionMenu();
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }

      function renderMentionMenu() {
        if (!mentionMenu) {
          return [];
        }
        const options = mentionOptions(input.value, selectedConversationMembers());
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
          fillAvatar(avatar, member.displayName, index);
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

      input.addEventListener("input", function () {
        mentionIndex = 0;
        renderMentionMenu();
      });
      input.addEventListener("keydown", function (event) {
        const options = mentionOptions(input.value, selectedConversationMembers());
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
      });
      form.addEventListener("submit", async function (event) {
        event.preventDefault();
        const content = input.value.trim();
        const conversationId = selectedConversationId();
        if (!content || !conversationId) {
          return;
        }
        input.value = "";
        await enqueueMessage({ content, conversationId });
        await render();
        // Sending is a deliberate action, so following it is expected.
        scrollToLatestWhenSettled("auto");
        const flushResult = await flushOutbox();
        await pollMailboxTimeline().catch(function () {
          return 0;
        });
        await render(flushResult.status);
      });
    }
    await render();
    const pairing = loadPairing();
    if (pairing && relayCanSync(pairing)) {
      try {
        await requestChatListViaRelay(pairing);
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
    await pollMailboxTimeline().catch(function () {
      return 0;
    });
    await render(flushResult.status);
    startMailboxTimelinePolling();
    wireStreamView();
    ensureLiveRelayForOpenConversation();
    startThinkingClock();
    startSyncProgressClock();
    startRelayTimelineKeepAlive();
  }

  globalThis.AccordAgentsMobile = {
    // W-K's harness drives the real user path — permission prompt, subscribe,
    // POST, render — rather than a stand-in for it.
    enableMessageAlerts,
    ensurePushSubscription,
    ensureLiveRelayForOpenConversation,
    createOutboxEvent,
    enqueueMessage,
    flushOutbox,
    flushOutboxViaMailbox,
    flushOutboxViaRelay,
    handleRelayChatListPayload,
    handleRelayTimelinePayload,
    activeMentionQuery,
    mentionOptions,
    replaceActiveMention,
    requestChatListViaRelay,
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
    savePairing
  };

  if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", function () {
      init().catch(function (error) {
        const state = document.getElementById("connection-state");
        if (state) {
          state.textContent = error instanceof Error ? error.message : String(error);
        }
      });
    });
  }
})();
