/**
 * The page and the service worker over one database, in a real browser.
 *
 * These are two separate programs that open the same IndexedDB, and each used
 * to carry its own copy of the version number. They drifted: the page reached
 * version 4 while the worker still asked for 3, and IndexedDB refuses to open
 * a database at a version lower than the one on disk. From that moment every
 * push-woken sync failed at the open - silently, because a push handler has
 * nobody to tell. The phone simply stopped picking anything up in the
 * background and nothing said so.
 *
 * So this drives the real thing: the shipped worker registered by the shipped
 * page, which paired it with a real hub (the User's own server), a real push
 * delivered through the browser's own push plumbing, and the assertion that
 * the worker read what the page stored (its pairing, its key, the chat
 * titles) and wrote back what the page then reads.
 *
 * This is desktop Chrome. It is not an installed PWA and it is not iOS Safari;
 * neither is claimed here.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { rm } from "node:fs/promises";
import path from "node:path";
import { attachApp, launchChrome, member, pairPage, serveMobileShell, sleep, startMobileHub, tempProfile } from "./mobile-hub-fixture.mjs";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "..");
const SITE_PORT = 8193;
const CDP_PORT = 9374;
const CONVERSATION = "conv-sw-db";
const DB_NAME = "accordagents-mobile-control";

test("a push-woken worker opens the database the page created and stores what it fetched", { timeout: 120_000 }, async (t) => {
  // Registered first: a failed assertion below must still close these, or the
  // run hangs on an open listener rather than reporting the failure.
  let chrome;
  let profile;
  let app;
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: SITE_PORT, hubOrigins: [hub.base] });
  t.after(async () => {
    app?.close();
    chrome?.kill("SIGKILL");
    await site.close();
    await hub.close();
    if (profile) await rm(profile, { recursive: true, force: true });
  });
  await hub.createChat(CONVERSATION, { title: "Worker QA", participants: [member("drew")] });
  // The page must not mark the notice seen before the push arrives: what
  // the worker is rung for is then still the phone's to show.
  hub.setGate(async (request) => request.method === "POST" && request.path === "/v1/phone/seen" ? { status: 503, body: { ok: false } } : undefined);
  profile = await tempProfile("aa-sw-db-");
  chrome = launchChrome({ port: CDP_PORT, profile, url: `${site.origin}/`, width: 430, height: 860 });
  app = await attachApp({ port: CDP_PORT });
  const evaluate = app.evaluate;
  await app.send("Browser.grantPermissions", { origin: site.origin, permissions: ["notifications"] });
  await pairPage(app, { hub, siteOrigin: site.origin });
  await evaluate(`navigator.serviceWorker.ready.then(() => true)`);

  // The page has opened its database by now. This is the version the worker
  // has to cope with, whatever number this build happens to be on.
  const pageVersion = await evaluate(`(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(${JSON.stringify(DB_NAME)});
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const version = db.version;
    const stores = [...db.objectStoreNames];
    db.close();
    return { version, stores };
  })()`);
  assert.ok(pageVersion.version >= 5, `the page's database is at version ${pageVersion.version}`);
  for (const store of ["meta", "outbox", "timeline"]) {
    assert.ok(pageVersion.stores.includes(store), `the page's database is missing ${store}`);
  }
  // The timeline is read by chat, through an index: without it every
  // delivered row cost a scan of the whole store (seconds per batch on a
  // phone with weeks of chats), and a worker a build behind must find the
  // index already there rather than force a version of its own.
  const timelineIndexes = await evaluate(`(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(${JSON.stringify(DB_NAME)});
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const names = [...db.transaction("timeline").objectStore("timeline").indexNames];
    db.close();
    return names;
  })()`);
  assert.ok(timelineIndexes.includes("conversationId"), `the timeline store is indexed by chat: ${timelineIndexes.join(", ")}`);

  // The defect itself, stated: a context that asks for an older version cannot
  // open this database at all. That is what the shipped worker used to do.
  const stale = await evaluate(`(async () => {
    try {
      await new Promise((resolve, reject) => {
        const request = indexedDB.open(${JSON.stringify(DB_NAME)}, 3);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return "opened";
    } catch (error) {
      return error && error.name;
    }
  })()`);
  assert.equal(stale, "VersionError", "asking for an older version must still be the error it always was");

  // Something to be rung for: a member waits on a permission. The server
  // keeps the notice until this phone has shown it.
  await hub.raiseApproval(CONVERSATION, {
    id: "perm-sw", conversationId: CONVERSATION, requesterParticipantId: "p-drew", requesterHandle: "drew", requesterRoleConfigId: "software-engineer",
    toolName: "Bash", capability: "shell", status: "pending", request: { command: "ls" }, summary: "Use Bash",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  });
  const notices = await hub.storage.hub().notices(0, 50);
  assert.equal(notices.length, 1, "the server holds one notice for the phone");

  // A real push, delivered by the browser to the registered worker. The id is
  // the one Chrome reports for the registration, not a target id.
  const updated = app.waitForEvent("ServiceWorker.workerRegistrationUpdated", { timeoutMs: 30_000 });
  await app.send("ServiceWorker.enable", {});
  const registrations = await updated;
  const registration = (registrations.registrations || []).find((entry) => !entry.isDeleted);
  assert.ok(registration, "the shipped service worker never registered");
  await app.send("ServiceWorker.deliverPushMessage", {
    origin: site.origin,
    registrationId: registration.registrationId,
    data: "sync"
  });

  // The proof: the worker read the pairing and the key the page stored, asked
  // the server what it was rung for, named the chat from the titles the page
  // mirrored, and wrote the unread mark the page then reads — which means it
  // opened this database rather than failing at it.
  let shown;
  for (let attempt = 0; attempt < 60 && !shown; attempt += 1) {
    shown = await evaluate(`(async () => {
      const registration = await navigator.serviceWorker.ready;
      const notifications = await registration.getNotifications();
      const named = notifications.find((item) => item.tag === ${JSON.stringify("accordagents-chat-" + CONVERSATION)});
      if (!named) return null;
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(${JSON.stringify(DB_NAME)});
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const unread = await new Promise((resolve) => {
        const get = db.transaction("meta", "readonly").objectStore("meta").get("unreadConversations");
        get.onsuccess = () => resolve(get.result || null);
        get.onerror = () => resolve(null);
      });
      db.close();
      return { body: named.body, unread: unread && unread.ids };
    })()`);
    if (!shown) await sleep(500);
  }
  assert.ok(shown, "the push-woken worker showed nothing: it could not use the page's database");
  assert.equal(shown.body, "Approval needed in Worker QA", "the worker named the chat and what waits in it");
  assert.ok(Array.isArray(shown.unread) && shown.unread.includes(CONVERSATION), "and marked the chat unread where the page reads it");
  assert.ok(hub.requests.some((request) => request.method === "GET" && request.path === "/v1/phone/notices"), "the worker asked the server");
});

test("a worker that reaches the database first leaves the page a database it can use", async (t) => {
  // The other order: a push wakes the worker on a phone where the page has
  // never run. The worker must not create a database the page then cannot
  // open, which is the same drift in the other direction.
  const { openControlDb, DB_VERSION, STORES, resetResolvedVersion } =
    require(path.join(repoRoot, "src/mobile/mobile-db.js"));
  t.after(() => resetResolvedVersion());

  const databases = new Map();
  const fakeIndexedDb = {
    open(name, version) {
      const request = { onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      queueMicrotask(() => {
        const existing = databases.get(name) || { version: 0, objectStoreNames: new Set() };
        if (version !== undefined && version < existing.version) {
          request.error = Object.assign(new Error("version too low"), { name: "VersionError" });
          request.onerror?.();
          return;
        }
        const target = version === undefined ? Math.max(existing.version, 1) : version;
        const db = {
          version: target,
          objectStoreNames: {
            contains: (store) => existing.objectStoreNames.has(store),
            [Symbol.iterator]: () => existing.objectStoreNames[Symbol.iterator]()
          },
          createObjectStore: (store) => { existing.objectStoreNames.add(store); return { createIndex: () => undefined }; },
          close: () => undefined
        };
        request.result = db;
        databases.set(name, { version: target, objectStoreNames: existing.objectStoreNames });
        if (target > existing.version || existing.version === 0) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    }
  };

  // The worker goes first and only asks for the store it uses.
  const workerDb = await openControlDb(fakeIndexedDb, [STORES.meta]);
  assert.equal(workerDb.version, DB_VERSION, "the worker settles on the shared version, not one of its own");
  resetResolvedVersion();
  // The page follows and finds everything it needs already there.
  const pageDb = await openControlDb(fakeIndexedDb);
  assert.equal(pageDb.version, DB_VERSION, "and the page does not have to upgrade past it");
  for (const store of Object.values(STORES)) {
    assert.ok(pageDb.objectStoreNames.contains(store), `the page is missing ${store}`);
  }
});
