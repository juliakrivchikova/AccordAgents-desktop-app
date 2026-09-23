const ASSET_VERSION = "2026-09-23-pwa-choice-card-v2";
// Tied to the marker the documented deploy step bumps, so a new shell really
// replaces the cached one rather than living beside it.
const CACHE_NAME = `accordagents-mobile-shell-v70-${ASSET_VERSION}`;
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
  `./mobile-db.js?v=${ASSET_VERSION}`,
  `./mobile-event-log.js?v=${ASSET_VERSION}`,
  `./mobile-machine-wake.js?v=${ASSET_VERSION}`,
  `./mobile-machine-command.js?v=${ASSET_VERSION}`,
  "./mobile-machine-sealing.js?v=2026-09-07-pair-sealing-v1",
  `./mobile-machine-channel.js?v=${ASSET_VERSION}`,
  `./mobile-shared.js?v=${ASSET_VERSION}`,
  `./mobile-activity.js?v=${ASSET_VERSION}`,
  "./manifest.webmanifest",
  "./assets/accordagents-mark.png"
];
const NOTIFICATION_TITLE = "AccordAgents";
const NOTIFICATION_FALLBACK_BODY = "Open AccordAgents to sync updates.";
// How long the notification may wait for the sync before it is shown anyway.
// Shorter than anything iOS is known to allow, because the cost of being late
// is the subscription itself.
const NOTIFICATION_DEADLINE_MS = 4_000;
const NOTIFICATION_ICON = "./assets/accordagents-mark.png";

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
// Mirrors the page keeps for this worker: chat titles, so a notification can
// name the chat, and the chats the phone has not looked at, for the icon.
const CHAT_TITLES_META_KEY = "chatTitles";
const UNREAD_META_KEY = "unreadConversations";
// The desktop appends one of these beside the batch it rings for: a reply
// that finished, or a member that started waiting on a permission or a
// choice. The kind is plaintext and is the only thing read here; a batch
// without a notice says nothing about what happened in it.
const REPLY_NOTICE_KIND = "mobile.notice.reply";
const APPROVAL_NOTICE_KIND = "mobile.notice.approval";

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
    // The worker is the reader that shows the notification, so it is the one
    // whose cursor the relay may believe: the doorbell must not ring again for
    // what this device has already stored. The cursor sent here is the one
    // committed by the previous sync — an acknowledgement of what is on the
    // device, not of what is on the way.
    url.searchParams.set("reader", "phone");
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
    // What arrived, by chat, in plaintext metadata only: the sealed payload is
    // never opened here. Enough to say "which chat" and "reply or approval".
    const arrivals = [];
    for (const envelope of events) {
      if (!envelope || typeof envelope.eventId !== "string") {
        continue;
      }
      sealedStore.put(envelope);
      storedCount += 1;
      arrivals.push({
        conversationId: typeof envelope.conversationId === "string" ? envelope.conversationId : "",
        kind: typeof envelope.kind === "string" ? envelope.kind : ""
      });
      if (Number.isFinite(envelope.arrivalSeq) && envelope.arrivalSeq > cursor) {
        cursor = envelope.arrivalSeq;
      }
    }
    tx.objectStore(META_STORE).put({ ...access, key: MAILBOX_ACCESS_META_KEY, epoch: epoch || access.epoch, cursor });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    // What the relay may be told once the notification is on screen: see
    // acknowledgeStored. Never before it — the notification is the whole point
    // of the wake-up, and iOS gives the handler little time.
    const acknowledge = cursor > Math.max(0, Number(access.cursor) || 0)
      ? { endpointUrl: access.endpointUrl, mailboxId: access.mailboxId, token: access.token, cursor: cursor }
      : undefined;
    return { synced: true, stored: storedCount, cursor, arrivals, acknowledge };
  } catch (error) {
    return { synced: false, reason: String(error && error.message || error) };
  } finally {
    if (db) {
      db.close();
    }
  }
}

/** Names the chats that just moved and what happened in each, from the
 *  titles the page mirrored. Message text never reaches a notification: the
 *  payloads are sealed and stay sealed. Also grows the unread mirror so the
 *  icon number is right before the page next opens. Returns one notification
 *  per chat, or nothing when the arrivals name no known chat. */
async function describeArrivals(arrivals) {
  const byConversation = new Map();
  const touched = new Set();
  for (const arrival of arrivals) {
    if (!arrival.conversationId) {
      continue;
    }
    touched.add(arrival.conversationId);
    if (arrival.kind !== REPLY_NOTICE_KIND && arrival.kind !== APPROVAL_NOTICE_KIND) {
      continue;
    }
    const entry = byConversation.get(arrival.conversationId) || { approval: false, reply: false };
    if (arrival.kind === APPROVAL_NOTICE_KIND) {
      entry.approval = true;
    } else {
      entry.reply = true;
    }
    byConversation.set(arrival.conversationId, entry);
  }
  if (touched.size === 0) {
    return [];
  }
  let db;
  let titles = {};
  let unread = [];
  try {
    db = await openControlDb();
    const titlesRecord = await dbRequest(db.transaction(META_STORE).objectStore(META_STORE).get(CHAT_TITLES_META_KEY));
    titles = titlesRecord && titlesRecord.titles && typeof titlesRecord.titles === "object" ? titlesRecord.titles : {};
    const unreadRecord = await dbRequest(db.transaction(META_STORE).objectStore(META_STORE).get(UNREAD_META_KEY));
    unread = unreadRecord && Array.isArray(unreadRecord.ids) ? unreadRecord.ids.filter((id) => typeof id === "string") : [];
    for (const conversationId of touched) {
      if (!unread.includes(conversationId)) {
        unread.push(conversationId);
      }
    }
    const tx = db.transaction(META_STORE, "readwrite");
    tx.objectStore(META_STORE).put({ key: UNREAD_META_KEY, ids: unread });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Without the mirrors the notification falls back to the generic line.
  } finally {
    if (db) {
      db.close();
    }
  }
  await applyBadge(unread.length);
  await tellPagesUnreadChanged();
  const notifications = [];
  for (const [conversationId, entry] of byConversation) {
    const title = typeof titles[conversationId] === "string" ? titles[conversationId].trim() : "";
    if (!title) {
      continue;
    }
    // Read on a lock screen, in one glance: what happened, and where. The
    // name of whoever wrote it stays out — it lives inside the sealed payload
    // this worker deliberately never opens. An approval outranks a reply: it
    // is the one that is waiting on the User.
    const body = entry.approval ? `Approval needed in ${title}` : `New message in ${title}`;
    notifications.push({ conversationId, body, approval: entry.approval });
  }
  return notifications;
}

/** A page open right now folds this count in at once. Without it, a push for
 *  the very chat the page was showing left that chat on the icon as unread
 *  until the app was next brought back to the foreground. */
async function tellPagesUnreadChanged() {
  try {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clients) {
      client.postMessage({ type: "accord-unread-changed" });
    }
  } catch {
    // The page reconciles on its next return to the foreground regardless.
  }
}

async function applyBadge(count) {
  if (!("setAppBadge" in self.navigator)) {
    return;
  }
  try {
    if (count > 0) {
      await self.navigator.setAppBadge(count);
    } else {
      await self.navigator.clearAppBadge();
    }
  } catch {
    // The icon number is a courtesy; the notification is what matters here.
  }
}

/** Shows what arrived. With `namedOnly`, a sync that names no chat shows
 *  nothing and answers false: the generic notice already on screen stands,
 *  rather than being shown again and then closed — a push that ends with no
 *  notification on screen is what iOS counts against the subscription. */
async function showArrivalNotifications(result, namedOnly) {
  const arrivals = result && result.synced && Array.isArray(result.arrivals) ? result.arrivals : [];
  const notifications = await describeArrivals(arrivals).catch(() => []);
  if (notifications.length === 0) {
    if (namedOnly) {
      return false;
    }
    await self.registration.showNotification(NOTIFICATION_TITLE, {
      body: NOTIFICATION_FALLBACK_BODY,
      icon: NOTIFICATION_ICON,
      badge: NOTIFICATION_ICON,
      tag: "accordagents-sync",
      data: { action: "sync" }
    });
    return false;
  }
  // One per chat, tagged by chat: a second reply in the same chat replaces
  // the first notification instead of stacking, and another chat's does not.
  for (const notification of notifications) {
    await self.registration.showNotification(NOTIFICATION_TITLE, {
      body: notification.body,
      icon: NOTIFICATION_ICON,
      badge: NOTIFICATION_ICON,
      tag: "accordagents-chat-" + notification.conversationId,
      // An approval is answered on Activity's Pending list; a reply is read
      // there among what finished. The tap lands on the right one.
      data: { action: "open", conversationId: notification.conversationId, list: notification.approval ? "pending" : "finished" }
    });
  }
  return true;
}

/** Tells the relay what this device now holds, so its doorbell does not ring
 *  again for it. Sent after the notification, never before: the wake-up exists
 *  to show that notification, and an extra request in front of it spends the
 *  handler's time. Best effort — losing it costs one extra ring, never a
 *  missing one. */
async function acknowledgeStored(result) {
  const ack = result && result.acknowledge;
  if (!ack) return;
  try {
    const url = new URL(ack.endpointUrl);
    url.searchParams.set("mailboxId", ack.mailboxId);
    url.searchParams.set("limit", "1");
    url.searchParams.set("afterArrival", String(ack.cursor));
    url.searchParams.set("reader", "phone");
    await fetch(url.toString(), {
      headers: { accept: "application/json", authorization: "Bearer " + ack.token },
      signal: AbortSignal.timeout(5_000)
    });
  } catch {
    // The next sync says it again.
  }
}

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    // Always show a notification, even if the background sync fails: a push
    // that does not surface a notification counts against the subscription on
    // iOS. The page catches up on open regardless.
    let result;
    const sync = backgroundMailboxSync();
    try {
      // A sync that takes too long is the same thing to iOS as no sync at all:
      // the handler is cut off with nothing shown, and that counts against the
      // subscription. So the notification waits only as long as it can afford
      // to; the sync itself keeps running under the same waitUntil and stores
      // what it fetched regardless.
      result = await Promise.race([
        sync,
        new Promise((resolve) => setTimeout(() => resolve(undefined), NOTIFICATION_DEADLINE_MS))
      ]);
    } finally {
      await showArrivalNotifications(result);
    }
    const settled = await sync.catch(() => undefined);
    if (result === undefined && settled && settled.synced) {
      // The sync outran the deadline: the generic notice was shown for it,
      // and it stayed while the named ones never came. When the late sync
      // does name a chat they come now and the generic one goes, so the lock
      // screen names the chat after all; when it names none (the page's own
      // poll took the burst first), the generic one stands.
      const named = await showArrivalNotifications(settled, true);
      if (named) {
        try {
          for (const shown of await self.registration.getNotifications({ tag: "accordagents-sync" })) {
            shown.close();
          }
        } catch {
          // Two notifications for one arrival is the worse of the two
          // outcomes only by a little.
        }
      }
    }
    await acknowledgeStored(settled);
  })());
});

// Harness hook: runs the same background sync as a push, with no arguments —
// anything the message carries (including an endpoint) is ignored by
// construction, which is exactly what the payload-isolation test proves.
self.addEventListener("message", (event) => {
  if (!event.data || (event.data.type !== "accord-test-push" && event.data.type !== "accord-test-describe")) {
    return;
  }
  event.waitUntil((async () => {
    if (event.data.type === "accord-test-describe") {
      // Harness hook for the wording: the same description a real push would
      // build from these plaintext arrivals and the mirrors on this device.
      const notifications = await describeArrivals(Array.isArray(event.data.arrivals) ? event.data.arrivals : []);
      if (event.source) {
        event.source.postMessage({ type: "accord-test-describe-done", notifications });
      }
      return;
    }
    const result = await backgroundMailboxSync();
    if (event.source) {
      event.source.postMessage({ type: "accord-test-push-done", result });
    }
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  // Which of Activity's lists holds what the notification was about: an
  // approval waits on Pending, a reply is among what finished. Without this
  // the tap landed on whichever list was last read.
  const list = data.list === "pending" ? "pending" : data.list === "finished" ? "finished" : "";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          const focused = await client.focus();
          // Activity, not the chat: there are many chats and a reply can sit
          // in a thread, so the list of what just happened is the one place
          // that always holds the thing the notification was about. The page
          // owns navigation; it is told the tab and the list, nothing more.
          (focused || client).postMessage({ type: "accord-open-activity", ...(list ? { list } : {}) });
          return focused;
        }
      }
      return self.clients.openWindow("./?tab=activity" + (list ? "&list=" + list : ""));
    })
  );
});
