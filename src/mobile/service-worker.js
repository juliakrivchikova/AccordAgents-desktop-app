const ASSET_VERSION = "2026-10-26-phone-fixes";
// Tied to the marker the documented deploy step bumps, so a new shell really
// replaces the cached one rather than living beside it.
const CACHE_NAME = `accordagents-mobile-shell-v72-${ASSET_VERSION}`;
const APP_SHELL = [
  "./",
  "./index.html",
  `./mobile-app.css?v=${ASSET_VERSION}`,
  `./mobile-app.js?v=${ASSET_VERSION}`,
  `./jsqr.js?v=${ASSET_VERSION}`,
  // Everything the page loads before it can do anything: left out, offline
  // the phone had a shell and no database description, no signing client and
  // no shared rules. The worker imports two of them itself, unversioned.
  "./mobile-db.js",
  `./mobile-db.js?v=${ASSET_VERSION}`,
  `./mobile-shared.js?v=${ASSET_VERSION}`,
  `./mobile-hub-client.js?v=${ASSET_VERSION}`,
  "./mobile-hub-client.js",
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
  // API responses must never be cached: serving a cached read freezes the
  // timeline at the first response for the whole session.
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

// The doorbell: a push is a wake signal and nothing more. The handler never
// reads the push payload — what it is about is read from the User's server,
// with a request signed by this phone's own key — and the notification names
// the chat and what happened in it, never the message text.
// The page's description of this database, loaded rather than copied. The
// worker used to carry its own version number, the page moved past it, and
// IndexedDB refuses a version older than the one on disk -- so every
// push-woken sync failed at the open, silently, because a push handler has
// nobody to tell. Neither side can move alone now.
importScripts("./mobile-db.js");
// A phone paired with the User's server reads what a push is about from the
// server, with a request signed by the phone's own key (the page made it and
// keeps it in this database). Signing proves who asks; it opens nothing: the
// server answers with which chat and what kind, and the page reads the rest.
importScripts("./mobile-hub-client.js");
const SCHEMA = self.AccordMobileDb;
const META_STORE = SCHEMA.STORES.meta;
// Mirrors the page keeps for this worker: chat titles, so a notification can
// name the chat, and the chats the phone has not looked at, for the icon.
const CHAT_TITLES_META_KEY = "chatTitles";
const UNREAD_META_KEY = "unreadConversations";
// What a notice the server keeps is about: a reply that finished, or a
// member that started waiting on a permission or a choice.
const REPLY_NOTICE_KIND = "mobile.notice.reply";
const APPROVAL_NOTICE_KIND = "mobile.notice.approval";
const HUB_PAIRING_META_KEY = "hub-pairing";
const HUB_IDENTITY_META_KEY = "hub-identity";

/** Only the store a push-woken sync actually touches: a worker that is a
 *  build behind must still deliver, not force a version for a store it will
 *  never open. */
function openControlDb() {
  return SCHEMA.openControlDb(indexedDB, [META_STORE]);
}

function dbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** What a push from the User's server is about: the notices this phone has
 *  not seen, read from the server. Not synced when this phone is not paired
 *  with a server. */
async function backgroundHubSync() {
  let db;
  let pairing;
  let identity;
  try {
    db = await openControlDb();
    pairing = await dbRequest(db.transaction(META_STORE).objectStore(META_STORE).get(HUB_PAIRING_META_KEY));
    identity = await dbRequest(db.transaction(META_STORE).objectStore(META_STORE).get(HUB_IDENTITY_META_KEY));
  } catch (error) {
    return { synced: false, reason: String(error && error.message || error) };
  } finally {
    if (db) db.close();
  }
  if (!pairing || !pairing.hubUrl || !identity || !identity.privateKeyDerBase64 || !self.AccordHubClient) {
    return { synced: false, reason: "not paired with a server" };
  }
  try {
    const client = self.AccordHubClient.createHubDeviceClient({ hubUrl: pairing.hubUrl, identity: async () => identity });
    const answer = await client.getJson("/v1/phone/notices", {}, { timeoutMs: 8_000 });
    const notices = Array.isArray(answer && answer.notices) ? answer.notices : [];
    return {
      synced: true,
      stored: notices.length,
      arrivals: notices.map((notice) => ({
        conversationId: typeof notice.conversationId === "string" ? notice.conversationId : "",
        kind: notice.kind === "approval" ? APPROVAL_NOTICE_KIND : REPLY_NOTICE_KIND,
        title: typeof notice.title === "string" ? notice.title : ""
      })),
      hubAcknowledge: Number.isSafeInteger(answer && answer.head) ? { hubUrl: pairing.hubUrl, through: answer.head, identity } : undefined
    };
  } catch (error) {
    return { synced: false, reason: String(error && error.message || error) };
  }
}

/** Tells the server this phone has shown what it was rung for. */
async function acknowledgeHubNotices(result) {
  const ack = result && result.hubAcknowledge;
  if (!ack || !self.AccordHubClient) return;
  try {
    const client = self.AccordHubClient.createHubDeviceClient({ hubUrl: ack.hubUrl, identity: async () => ack.identity });
    await client.postJson("/v1/phone/seen", { through: ack.through }, { timeoutMs: 5_000 });
  } catch {
    // The next push reads them again; a repeated notice replaces the old one.
  }
}

/** Names the chats that just moved and what happened in each, from the
 *  titles the page mirrored (or the title the server gave). Message text
 *  never reaches a notification. Also grows the unread mirror so the icon
 *  number is right before the page next opens. Returns one notification per
 *  chat, or nothing when the arrivals name no known chat. */
async function describeArrivals(arrivals) {
  const byConversation = new Map();
  const touched = new Set();
  // A server names the chat itself; the page's mirror wins when it has one.
  const named = new Map();
  for (const arrival of arrivals) {
    if (!arrival.conversationId) {
      continue;
    }
    if (typeof arrival.title === "string" && arrival.title.trim()) named.set(arrival.conversationId, arrival.title.trim());
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
    const title = typeof titles[conversationId] === "string" && titles[conversationId].trim() ? titles[conversationId].trim() : named.get(conversationId) || "";
    if (!title) {
      continue;
    }
    // Read on a lock screen, in one glance: what happened, and where. The
    // name of whoever wrote it stays out, as the message text does. An
    // approval outranks a reply: it is the one that is waiting on the User.
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

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    // Always show a notification, even if the background sync fails: a push
    // that does not surface a notification counts against the subscription on
    // iOS. The page catches up on open regardless.
    let result;
    const sync = backgroundHubSync();
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
    await acknowledgeHubNotices(settled);
  })());
});

// Harness hook: runs the same background sync as a push, with no arguments —
// anything the message carries (including a server address) is ignored by
// construction: what is read, and from where, comes only from device storage.
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
    const result = await backgroundHubSync();
    if (event.source) {
      event.source.postMessage({ type: "accord-test-push-done", result: result && result.hubAcknowledge ? { ...result, hubAcknowledge: { through: result.hubAcknowledge.through } } : result });
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
