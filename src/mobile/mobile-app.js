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
              remove: function (name, key) { return requestToPromise(stores[name].delete(key)); }
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
      /** Dropped once the machine has acknowledged the event that names it. */
      release: async function (reference) {
        for (let index = 0; index < reference.fragments; index += 1) {
          await withNamedStore(MACHINE_BLOB_STORE, "readwrite", function (store) {
            store.delete(key(reference, index));
          });
        }
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
        for (let index = 0; index < reference.fragments; index += 1) {
          await withNamedStore(MACHINE_BLOB_STORE, "readwrite", function (store) {
            store.delete(key(reference, index));
          });
        }
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
        stores: { events: MACHINE_EVENT_STORE, outbox: MACHINE_OUTBOX_STORE, meta: META_STORE },
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
  async function applyMachineEvent(event, payload, machine) {
    const body = payload && typeof payload === "object" ? payload : {};
    // What this phone was actually handed, when the QA flag is on. Reading the
    // screen is not proof that a result arrived: the User's own prompt can
    // contain whatever token an answer is being looked for by.
    recordRelayDebug({ event: "machine-event-applying", kind: event.kind, bodyType: body.type,
      messages: Array.isArray(body.messages) ? body.messages.length : undefined, status: body.status });
    const conversationId = event.conversationId;
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
          id: "machine-stopped:" + body.runId, messageId: "machine-stopped:" + body.runId,
          role: "participant", participantLabel: machineRunLabel(body.runId),
          content: events.length ? "Stopped." : machineRunLabel(body.runId) + " was stopped before answering.",
          status: "done", createdAt: body.finishedAt, runId: body.runId
        });
      }
      for (const [index, warning] of (body.warnings || []).entries()) {
        events.push({ id: "machine-warning:" + body.runId + ":" + index, role: "system", content: warning,
          status: "done", createdAt: body.finishedAt });
      }
      if (body.error) {
        events.push({ id: "machine-error:" + body.runId, role: "system", content: body.error,
          status: "error", createdAt: body.finishedAt });
      }
      await handleRelayTimelinePayload({ type: "mobile.timeline.events", conversationId: conversationId, events: events },
        conversationId);
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
          id: "machine-run:" + body.runId, role: "participant",
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
            id: "machine-run:" + body.runId, role: "participant",
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
    if (body.type === "machine.approval.result") {
      noteMachineApprovalResult(body);
      return "applied";
    }
    recordRelayDebug({ event: "machine-event-unshown", kind: event.kind });
    return "applied";
  }

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
      ...(message.threadRootId ? { threadRootId: message.threadRootId } : {})
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
        await built.log.append({
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
      controlCardSent.delete(body.approvalId);
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
      avatarId: typeof value.avatarId === "string" ? value.avatarId : undefined,
      // Where this member actually runs, and what that machine needs to run
      // it. Present only for members that live on a machine.
      homeMachineId: typeof value.homeMachineId === "string" ? value.homeMachineId : undefined,
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
        }).then(function () { return entry; });
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

  /** Runs the User has asked to stop, from the tap onward. The queue entry is
   *  written asynchronously, and a render in that gap used to put the Stop
   *  control back as if nothing had been asked -- which is both a lie and a
   *  second Stop the User can send by accident. */
  const stopRequestedRunIds = new Set();

  async function stopRunFromPhone(runId) {
    const conversationId = selectedConversationId();
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
      container.append(image, note);
      loadAttachmentInto(image, entry.conversationId, attachment);
    }
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

  function loadControlCards() {
    try {
      const raw = localStorage.getItem(CONTROL_CARDS_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function saveControlCards(byConversation) {
    try {
      localStorage.setItem(CONTROL_CARDS_KEY, JSON.stringify(byConversation));
    } catch {
      // A full quota must not lose the timeline; the cards arrive again with
      // the next batch.
    }
  }

  function controlCardsFor(conversationId) {
    const stored = loadControlCards()[conversationId];
    return Array.isArray(stored) ? stored : [];
  }

  /** The desktop states the whole set for a chat, so it replaces rather than
   *  merges: a card it no longer lists has been answered or withdrawn. */
  function storeControlCards(conversationId, cards) {
    if (!conversationId || !Array.isArray(cards)) return false;
    const all = loadControlCards();
    const before = JSON.stringify(all[conversationId] || []);
    const after = JSON.stringify(cards);
    if (before === after) return false;
    all[conversationId] = cards;
    saveControlCards(all);
    // A card the desktop no longer lists has been answered or withdrawn, so the
    // "sent" mark for it goes too: the next card with that id is a new question.
    const live = new Set(cards.map(function (card) { return card && card.id; }));
    for (const id of Array.from(controlCardSent)) {
      if (!live.has(id)) controlCardSent.delete(id);
    }
    for (const id of Array.from(controlCardErrors.keys())) {
      if (!live.has(id)) controlCardErrors.delete(id);
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
    if (!conversationId) {
      return 0;
    }
    let stored = 0;
    if (Array.isArray(payload.cards) && storeControlCards(conversationId, payload.cards)) {
      stored += 1;
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
        attachments: attachments.length > 0 ? attachments : undefined,
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
        // A chat row that arrives without a participants array must not take
        // the whole list down with it.
        const chatParticipants = Array.isArray(chat.participants) ? chat.participants : [];
        const participants = chatParticipants.length > 0 ? chatParticipants : [chat.title];
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


  // --- cards a member is waiting on -----------------------------------------

  /** The chat action a tapped card produces. The shape is the one every device
   *  emits, so the desktop records and applies it exactly as it would its own —
   *  including the native identifiers the provider needs back. */
  function decisionEventForCard(card, answer) {
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
    return {
      kind: "choice.answered",
      payload: {
        operationId: "choice:" + card.id + ":" + value,
        targetKey: "choice:" + card.id,
        stateId: value,
        detail: {
          sourceMessageId: card.sourceMessageId || "",
          ...(answer.optionId ? { selectedOptionId: answer.optionId } : {}),
          ...(answer.customAnswer ? { customAnswer: answer.customAnswer } : {}),
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
    const decision = decisionEventForCard(card, answer);
    try {
      await enqueueDecision({ conversationId: conversationId, kind: decision.kind, payload: decision.payload });
    } catch (error) {
      controlCardErrors.set(card.id, "Could not save your answer on this phone. Try again.");
      await render("waiting-to-sync");
      return;
    }
    controlCardErrors.delete(card.id);
    controlCardSent.add(card.id);
    await render("waiting-to-sync");
    const flushResult = await flushOutbox();
    if (desktopDidNotTake(flushResult.status)) {
      await commandMachineAction(conversationId, decision).catch(function (error) {
        // Sent is not applied: if it could not even be handed over, the card
        // says so rather than showing an answer that went nowhere.
        controlCardSent.delete(card.id);
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

  const controlCardSent = new Set();
  const controlCardErrors = new Map();

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

    const sent = controlCardSent.has(card.id);
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
    state.textContent = failure
      ? failure
      : sent
        // Deliberately not "answered": the phone knows it sent the answer, not
        // that the provider was told. The card leaves when the desktop says so.
        ? "Answer sent. Waiting for the machine to apply it."
        : "";
    state.hidden = !state.textContent;
    wrap.append(state);
    return wrap;
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
    renderControlCards(activeId);
    renderMachineWake();
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
    const pending = entries.filter(function (entry) {
      return entry.status !== "acked";
    }).length;
    state.textContent = connectionStatus
      ? connectionStatusText(connectionStatus)
      : pending > 0 ? "Waiting to sync" : "Synced";
    let rows = messageEntries.map(function (entry) {
      return {
        rowKey: "outbox\0" + entry.eventId,
        id: entry.eventId,
        conversationId: entry.conversationId,
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
      attachments: Array.isArray(entry.attachments)
        ? entry.attachments.map(function (attachment) { return attachment.id; })
        : undefined,
      status: entry.status,
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
      syncMessageStopButton(meta, entry);
      copy.append(meta, content);
      renderAttachmentsInto(attachmentsNodeFor(copy), entry);
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
      renderAttachmentsInto(attachmentsNodeFor(bubble), entry);
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
      const meta = status.parentElement;
      if (!meta) {
        return false;
      }
      syncMessageStopButton(meta, entry);
      renderMessageContentIfChanged(content, entry.content);
      renderAttachmentsInto(attachmentsNodeFor(content.parentElement || item), entry);
      return true;
    }
    const status = item.querySelector(".message-status");
    const content = item.querySelector(".message-content");
    if (!status || !content) {
      return false;
    }
    status.textContent = entry.status;
    renderMessageContentIfChanged(content, entry.content);
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
      document.addEventListener("selectionchange", function () {
        if (document.activeElement === input && mentionMenu && !mentionMenu.hidden) {
          renderMentionMenu();
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
      });
      form.addEventListener("submit", async function (event) {
        event.preventDefault();
        const content = input.value.trim();
        const conversationId = selectedConversationId();
        // A picture on its own is a message.
        if ((!content && pendingAttachments.length === 0) || !conversationId) {
          return;
        }
        input.value = "";
        const attachments = takePendingAttachments();
        await enqueueMessage({
          content,
          conversationId,
          ...(attachments.length > 0 ? { payload: { content, attachments } } : {})
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
      });
    }
    await render();
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
    enqueueRunCancel,
    stopRunFromPhone,
    flushOutbox,
    flushOutboxViaMailbox,
    flushOutboxViaRelay,
    handleRelayChatListPayload,
    handleRelayTimelinePayload,
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
    savePairing
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
    function composerHasFocus() {
      const active = document.activeElement;
      return Boolean(active && active.id === "composer-input");
    }
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
      const wasAtLatest = isNearBottom(threadSurface());
      document.documentElement.style.setProperty("--app-h", height + "px");
      if (wasAtLatest) {
        scrollToLatestWhenSettled("auto");
      }
    }
    // A single sample can land mid-animation — the keyboard sliding away, a
    // rotation still turning — and then stick, because nothing would come
    // along to correct it. Sample across the whole animation instead.
    function remeasure() {
      apply();
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
