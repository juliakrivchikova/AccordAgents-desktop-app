const ASSET_VERSION = "2026-09-01-picture-rows-v1";
// Tied to the marker the documented deploy step bumps, so a new shell really
// replaces the cached one rather than living beside it.
const CACHE_NAME = `accordagents-mobile-shell-v68-${ASSET_VERSION}`;
const APP_SHELL = [
  "./",
  "./index.html",
  `./mobile-app.css?v=${ASSET_VERSION}`,
  `./mobile-app.js?v=${ASSET_VERSION}`,
  `./jsqr.js?v=${ASSET_VERSION}`,
  // Everything the page loads before it can do anything. These were left out,
  // so offline the phone had a shell and no journal, no signing key and no way
  // to reach a machine. The worker imports the first of them itself.
  "./mobile-db.js",
  `./mobile-event-log.js?v=${ASSET_VERSION}`,
  `./mobile-machine-wake.js?v=${ASSET_VERSION}`,
  `./mobile-machine-command.js?v=${ASSET_VERSION}`,
  "./mobile-machine-sealing.js?v=2026-09-07-pair-sealing-v1",
  `./mobile-machine-channel.js?v=${ASSET_VERSION}`,
  "./manifest.webmanifest",
  "./assets/accordagents-mark.png"
];
const NOTIFICATION_TITLE = "AccordAgents";
const NOTIFICATION_OPTIONS = {
  body: "Open AccordAgents to sync updates.",
  icon: "./assets/accordagents-mark.png",
  badge: "./assets/accordagents-mark.png",
  tag: "accordagents-sync",
  data: { action: "sync" }
};

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }
  // Sync API responses must never be cached: serving a cached mailbox poll
  // freezes the timeline at the first response for the whole session.
  if (url.pathname.startsWith("/v1/")) {
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", copy));
          return response;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }
  event.respondWith(
    // The page asks for each script with its own `?v=` marker, and those move
    // independently. Matching the path as well is what makes the shell load
    // offline after a marker changes instead of only the pieces that happened
    // to keep theirs.
    caches.match(request)
      .then((exact) => exact || caches.match(request, { ignoreSearch: true }))
      .then((cached) => cached || fetch(request).then((response) => {
      // Never cache a transient error (404/500 during a deploy): it would be
      // served cache-first until the next CACHE_NAME bump.
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      }
      return response;
    }))
  );
});

// W5 doorbell: a push is a wake signal and nothing more. The handler never
// reads the push payload — routing comes only from device storage — and it
// never decrypts: envelopes are stored sealed and the page opens them with
// the seal key it alone holds. The notification stays opaque.
// The page's description of this database, loaded rather than copied. The
// worker used to carry its own version number, the page moved past it, and
// IndexedDB refuses a version older than the one on disk -- so every
// push-woken sync failed at the open, silently, because a push handler has
// nobody to tell. Neither side can move alone now.
importScripts("./mobile-db.js");
const SCHEMA = self.AccordMobileDb;
const META_STORE = SCHEMA.STORES.meta;
const SEALED_STORE = SCHEMA.STORES.sealed;
const MAILBOX_ACCESS_META_KEY = "mailboxAccess";

/** Only the two stores a push-woken sync actually touches: a worker that is a
 *  build behind must still deliver, not force a version for a store it will
 *  never open. */
function openControlDb() {
  return SCHEMA.openControlDb(indexedDB, [META_STORE, SEALED_STORE]);
}

function dbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function backgroundMailboxSync() {
  let db;
  try {
    db = await openControlDb();
    const access = await dbRequest(db.transaction(META_STORE).objectStore(META_STORE).get(MAILBOX_ACCESS_META_KEY));
    if (!access || !access.endpointUrl || !access.mailboxId || !access.token) {
      return { synced: false, reason: "no mirrored credentials" };
    }
    // Hard rule: endpoint and mailbox id come only from device storage.
    const url = new URL(access.endpointUrl);
    url.searchParams.set("mailboxId", access.mailboxId);
    url.searchParams.set("limit", "500");
    url.searchParams.set("afterArrival", String(Math.max(0, Number(access.cursor) || 0)));
    const response = await fetch(url.toString(), {
      headers: { accept: "application/json", authorization: "Bearer " + access.token },
      // Bound the background fetch: a stalled connection must not eat the push
      // budget, because iOS revokes a subscription that repeatedly fails to
      // show a notification.
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
      return { synced: false, reason: "HTTP " + response.status };
    }
    const body = await response.json();
    const events = Array.isArray(body && body.events) ? body.events : [];
    const epoch = typeof (body && body.epoch) === "string" ? body.epoch : "";
    if (epoch && access.epoch && epoch !== access.epoch) {
      // Box recreated: numbering restarted. Reset the cursor and let the
      // page re-read and reconcile on next open. The write is awaited like
      // the cursor-advance path below: returning into db.close() with the
      // transaction still open risks losing the reset, and a stale cursor
      // against renumbered storage is a silent gap. (W-B)
      const resetTx = db.transaction(META_STORE, "readwrite");
      resetTx.objectStore(META_STORE).put({ ...access, key: MAILBOX_ACCESS_META_KEY, epoch, cursor: 0 });
      await new Promise((resolve, reject) => {
        resetTx.oncomplete = resolve;
        resetTx.onerror = () => reject(resetTx.error);
      });
      return { synced: false, reason: "epoch reset" };
    }
    let cursor = Math.max(0, Number(access.cursor) || 0);
    const tx = db.transaction([SEALED_STORE, META_STORE], "readwrite");
    const sealedStore = tx.objectStore(SEALED_STORE);
    let storedCount = 0;
    for (const envelope of events) {
      if (!envelope || typeof envelope.eventId !== "string") {
        continue;
      }
      sealedStore.put(envelope);
      storedCount += 1;
      if (Number.isFinite(envelope.arrivalSeq) && envelope.arrivalSeq > cursor) {
        cursor = envelope.arrivalSeq;
      }
    }
    tx.objectStore(META_STORE).put({ ...access, key: MAILBOX_ACCESS_META_KEY, epoch: epoch || access.epoch, cursor });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    return { synced: true, stored: storedCount, cursor };
  } catch (error) {
    return { synced: false, reason: String(error && error.message || error) };
  } finally {
    if (db) {
      db.close();
    }
  }
}

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    // Always show the notification, even if the background sync fails: a push
    // that does not surface a notification counts against the subscription on
    // iOS. The page catches up on open regardless.
    try {
      await backgroundMailboxSync();
    } finally {
      await self.registration.showNotification(NOTIFICATION_TITLE, NOTIFICATION_OPTIONS);
    }
  })());
});

// Harness hook: runs the same background sync as a push, with no arguments —
// anything the message carries (including an endpoint) is ignored by
// construction, which is exactly what the payload-isolation test proves.
self.addEventListener("message", (event) => {
  if (!event.data || event.data.type !== "accord-test-push") {
    return;
  }
  event.waitUntil((async () => {
    const result = await backgroundMailboxSync();
    if (event.source) {
      event.source.postMessage({ type: "accord-test-push-done", result });
    }
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow("./");
    })
  );
});
