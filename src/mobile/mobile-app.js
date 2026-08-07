(function () {
  const DB_NAME = "accordagents-mobile-control";
  const DB_VERSION = 1;
  const OUTBOX_STORE = "outbox";
  const PAIRING_KEY = "accordagents.mobile.pairing.v1";
  const ACTIVE_CONVERSATION_KEY = "accordagents.mobile.activeConversationId.v1";

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
    const endpoint = url.searchParams.get("endpoint") || url.searchParams.get("relay");
    const conversationId = url.searchParams.get("conversationId");
    const routingId = url.searchParams.get("routingId");
    const rendezvousId = url.searchParams.get("rendezvousId");
    if (!endpoint && !conversationId && !routingId && !rendezvousId) {
      return loadPairing();
    }
    return savePairing({
      endpoint: endpoint || undefined,
      conversationId: conversationId || undefined,
      routingId: routingId || undefined,
      rendezvousId: rendezvousId || undefined,
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
    const base = endpoint || loadPairing()?.endpoint;
    if (!base) {
      return undefined;
    }
    return new URL("/v1/mobile/outbox", base).toString();
  }

  async function flushOutbox(options) {
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
          body: JSON.stringify(syncing)
        });
        if (!response.ok) {
          throw new Error("HTTP " + response.status);
        }
        const ack = await response.json();
        if (!ack || ack.eventId !== entry.eventId) {
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

  async function render() {
    const state = document.getElementById("connection-state");
    const list = document.getElementById("message-list");
    if (!state || !list) {
      return;
    }
    const entries = await listOutboxEntries();
    const pending = entries.filter(function (entry) {
      return entry.status !== "acked";
    }).length;
    state.textContent = pending > 0 ? "Waiting to sync" : "Synced";
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
        await flushOutbox();
        await render();
      });
    }
    await render();
    await flushOutbox();
    await render();
  }

  globalThis.AccordAgentsMobile = {
    createOutboxEvent,
    enqueueMessage,
    flushOutbox,
    listOutboxEntries,
    loadPairing,
    readBootstrapFromLocation,
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
