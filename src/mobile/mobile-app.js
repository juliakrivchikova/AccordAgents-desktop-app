(function () {
  const DB_NAME = "accordagents-mobile-control";
  const DB_VERSION = 1;
  const OUTBOX_STORE = "outbox";
  const PAIRING_KEY = "accordagents.mobile.pairing.v1";
  const ACTIVE_CONVERSATION_KEY = "accordagents.mobile.activeConversationId.v1";
  const RELAY_PROTOCOL = "accord-relay-v1";
  const RELAY_FRAME_MAX_BYTES = 10_240;
  const RELAY_FRAME_OVERHEAD_BYTES = 512;
  const RELAY_ACK_TIMEOUT_MS = 5_000;

  function nowIso() {
    return new Date().toISOString();
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

  async function importRelaySealKey(keyBase64) {
    if (!globalThis.crypto?.subtle) {
      throw new Error("Relay sealing requires WebCrypto.");
    }
    return globalThis.crypto.subtle.importKey(
      "raw",
      base64UrlToBytes(keyBase64),
      "AES-GCM",
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function sealRelayPayload(payload, keyBase64) {
    const iv = new Uint8Array(12);
    globalThis.crypto.getRandomValues(iv);
    const key = await importRelaySealKey(keyBase64);
    const ciphertext = await globalThis.crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      textToBytes(JSON.stringify(payload))
    );
    return JSON.stringify({
      v: 1,
      alg: "A256GCM",
      iv: bytesToBase64Url(iv),
      ct: bytesToBase64Url(new Uint8Array(ciphertext))
    });
  }

  async function openRelayPayload(sealed, keyBase64) {
    const envelope = JSON.parse(sealed);
    if (!envelope || envelope.v !== 1 || envelope.alg !== "A256GCM") {
      throw new Error("Unsupported relay sealed payload.");
    }
    const key = await importRelaySealKey(keyBase64);
    const plaintext = await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlToBytes(envelope.iv) },
      key,
      base64UrlToBytes(envelope.ct)
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
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

  function listOutboxEntries() {
    return withOutbox("readonly", function (store) {
      return requestToPromise(store.getAll());
    }).then(function (entries) {
      return entries.sort(function (left, right) {
        return left.createdAt.localeCompare(right.createdAt) || left.eventId.localeCompare(right.eventId);
      });
    });
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

  function readBootstrapFromLocation(locationValue) {
    const url = new URL(locationValue.href);
    const fragment = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
    const pairingPayload = fragment.get("pairing");
    if (pairingPayload) {
      const pairing = JSON.parse(base64UrlToText(pairingPayload));
      return savePairing({
        endpoint: pairing.relayUrl || undefined,
        relayUrl: pairing.relayUrl || undefined,
        mailboxUrl: pairing.mailboxUrl || undefined,
        outboxUrl: pairing.outboxUrl || undefined,
        conversationId: pairing.capabilities?.[0]?.conversationId || undefined,
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
    const relaySealKeyBase64 = url.searchParams.get("relaySealKey");
    const fingerprint = url.searchParams.get("fingerprint");
    if (!endpoint && !outboxUrl && !conversationId && !routingId && !rendezvousId) {
      return loadPairing();
    }
    return savePairing({
      endpoint: endpoint || undefined,
      relayUrl: endpoint || undefined,
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
      loadPairing()?.conversationId ||
      localStorage.getItem(ACTIVE_CONVERSATION_KEY) ||
      "unpaired";
  }

  function createOutboxEvent(input) {
    const eventId = input.eventId || createEventId();
    const createdAt = input.createdAt || nowIso();
    const conversationId = activeConversationId(input.conversationId);
    return {
      eventId,
      conversationId,
      logScopeId: input.logScopeId || conversationId,
      kind: "message.created",
      payload: {
        content: input.content,
        replyToMessageId: input.replyToMessageId || undefined
      },
      status: "queued",
      attempts: 0,
      createdAt,
      updatedAt: createdAt,
      ack: undefined,
      lastError: undefined
    };
  }

  function enqueueMessage(input) {
    const entry = createOutboxEvent(input);
    return putOutboxEntry(entry).then(function () {
      return entry;
    });
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
    return new URL("/v1/mailbox/events", base).toString();
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
    const socket = await openRelaySocket(relayUrl, pairing);
    let sent = 0;
    try {
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
    } finally {
      socket.close(1000, "mobile outbox flushed");
    }
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
      const timer = setTimeout(function () {
        socket.close(1000, "relay connect timeout");
        reject(new Error("Relay tunnel reconnecting."));
      }, RELAY_ACK_TIMEOUT_MS);
      socket.addEventListener("open", function () {
        clearTimeout(timer);
        resolve(socket);
      }, { once: true });
      socket.addEventListener("error", function () {
        clearTimeout(timer);
        reject(new Error("Relay tunnel unavailable."));
      }, { once: true });
      socket.addEventListener("close", function () {
        clearTimeout(timer);
      }, { once: true });
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
          parsed = JSON.parse(String(event.data));
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
          cleanup();
          resolve(result);
        } else if (result.status === "conflict") {
          cleanup();
          reject(new Error("Relay frame conflict: " + result.reason));
        }
      }
      function onClose() {
        cleanup();
        reject(new Error("Relay tunnel reconnecting."));
      }
      function onError() {
        cleanup();
        reject(new Error("Relay tunnel unavailable."));
      }
      socket.addEventListener("message", onMessage);
      socket.addEventListener("close", onClose);
      socket.addEventListener("error", onError);
      for (const frame of frames) {
        socket.send(JSON.stringify(frame));
      }
    });
  }

  async function flushOutbox(options) {
    const pairing = loadPairing();
    if (relayCanSync(pairing)) {
      const entries = await listOutboxEntries();
      try {
        return await flushOutboxViaRelay(entries, pairing);
      } catch (error) {
        const hasMailboxFallback = Boolean(outboxEndpoint(options && options.endpoint));
        if (!hasMailboxFallback) {
          return { status: "tunnel-reconnecting", sent: 0, pending: entries.filter((entry) => entry.status !== "acked").length, error: error instanceof Error ? error.message : String(error) };
        }
      }
    }
    const endpoint = outboxEndpoint(options && options.endpoint);
    const entries = await listOutboxEntries();
    let sent = 0;
    if (!endpoint) {
      return { status: "waiting-to-sync", sent, pending: entries.length };
    }
    for (const entry of entries) {
      if (entry.status === "acked") {
        continue;
      }
      const syncing = {
        ...entry,
        status: "syncing",
        attempts: entry.attempts + 1,
        updatedAt: nowIso()
      };
      await putOutboxEntry(syncing);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ events: [syncing] })
        });
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
        return { status: "waiting-to-sync", sent, pending: entries.length - sent };
      }
    }
    return { status: "synced", sent, pending: Math.max(0, entries.length - sent) };
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

  async function render(connectionStatus) {
    const state = document.getElementById("connection-state");
    const list = document.getElementById("message-list");
    if (!state || !list) {
      return;
    }
    const entries = await listOutboxEntries();
    const pending = entries.filter(function (entry) {
      return entry.status !== "acked";
    }).length;
    state.textContent = connectionStatus
      ? connectionStatusText(connectionStatus)
      : pending > 0 ? "Waiting to sync" : "Synced";
    list.textContent = "";
    for (const entry of entries) {
      const item = document.createElement("li");
      item.className = "message-row";
      item.dataset.status = entry.status;
      const content = document.createElement("div");
      content.className = "message-content";
      content.textContent = entry.payload.content;
      const meta = document.createElement("div");
      meta.className = "message-status";
      meta.textContent = statusText(entry.status);
      item.append(content, meta);
      list.append(item);
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
    if (form && input) {
      form.addEventListener("submit", async function (event) {
        event.preventDefault();
        const content = input.value.trim();
        if (!content) {
          return;
        }
        input.value = "";
        await enqueueMessage({ content });
        await render();
        const flushResult = await flushOutbox();
        await render(flushResult.status);
      });
    }
    await render();
    const flushResult = await flushOutbox();
    await render(flushResult.status);
  }

  globalThis.AccordAgentsMobile = {
    createOutboxEvent,
    enqueueMessage,
    flushOutbox,
    flushOutboxViaRelay,
    openRelayPayload,
    readBootstrapFromLocation,
    reassembleRelayCiphertext,
    sealRelayPayload,
    chunkRelayCiphertext,
    listOutboxEntries,
    loadPairing,
    connectionStatusText,
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
