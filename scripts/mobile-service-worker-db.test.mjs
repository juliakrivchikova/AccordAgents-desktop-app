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
 * page, a real push delivered through the browser's own push plumbing, and the
 * assertion that what the worker stored is what the page then reads.
 *
 * This is desktop Chrome. It is not an installed PWA and it is not iOS Safari;
 * neither is claimed here.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { spawn, execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { attach } = require("./cdp.cjs");
const { createReferenceMailboxServer } = require("./mailbox-reference-server.cjs");
const { loadMobileOriginHeaders, mobileOriginHeadersForPath } = require("./mobile-origin-headers.cjs");

const repoRoot = path.resolve(import.meta.dirname, "..");
const root = path.join(repoRoot, "dist/mobile");
const SITE_PORT = 8191;
const MAILBOX_PORT = 8192;
const CDP_PORT = 9374;
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CONVERSATION = "conv-sw-db";
const DB_NAME = "accordagents-mobile-control";

const SEAL_KEY = randomBytes(32).toString("base64url");
const sealKeyBuffer = Buffer.from(SEAL_KEY, "base64url");
const MAILBOX_TOKEN = createHmac("sha256", sealKeyBuffer).update("accord-mailbox-auth-v1", "utf8").digest("base64url");
const MAILBOX_ID = "mb-" + createHmac("sha256", sealKeyBuffer).update("accord-mailbox-scope-v1", "utf8").digest("base64url").slice(0, 32);

/** The mailbox stores only sealed bodies; the worker never opens them. */
const sealPayload = (payload) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealKeyBuffer, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tagged = Buffer.concat([ciphertext, cipher.getAuthTag()]);
  return { v: 1, alg: "A256GCM", iv: iv.toString("base64url"), ct: tagged.toString("base64url") };
};

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".webmanifest": "application/manifest+json"
};

const originHeaders = loadMobileOriginHeaders(root);
const site = createServer(async (req, res) => {
  const url = req.url || "/";
  if (url.startsWith("/v1/mailbox/") || url.startsWith("/v1/push/")) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const upstream = await fetch(`http://127.0.0.1:${MAILBOX_PORT}${url}`, {
      method: req.method,
      headers: {
        "content-type": req.headers["content-type"] || "application/json",
        ...(req.headers.authorization ? { authorization: req.headers.authorization } : {})
      },
      body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks)
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, { "content-type": "application/json" });
    res.end(body);
    return;
  }
  const rel = url.split("?")[0];
  const file = path.join(root, rel === "/" ? "index.html" : rel);
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] || "application/octet-stream",
      ...mobileOriginHeadersForPath(originHeaders, rel)
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

const mailbox = createReferenceMailboxServer({ locked: true });
const mailboxServer = mailbox.server ?? mailbox;

const killStaleCdp = () => {
  try { execSync(`lsof -ti tcp:${CDP_PORT} -sTCP:LISTEN | xargs kill -9`, { stdio: "ignore" }); }
  catch { /* nothing listening */ }
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a push-woken worker opens the database the page created and stores what it fetched", async (t) => {
  // Registered first: a failed assertion below must still close these, or the
  // run hangs on an open listener rather than reporting the failure.
  let chrome;
  let profile;
  t.after(async () => {
    chrome?.kill("SIGKILL");
    await new Promise((resolve) => site.close(resolve));
    await new Promise((resolve) => mailboxServer.close(resolve));
    if (profile) await rm(profile, { recursive: true, force: true });
  });
  await new Promise((r) => site.listen(SITE_PORT, "127.0.0.1", r));
  await new Promise((r) => mailboxServer.listen(MAILBOX_PORT, "127.0.0.1", r));
  const registered = await fetch(`http://127.0.0.1:${MAILBOX_PORT}/v1/mailbox/register?mailboxId=${MAILBOX_ID}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${MAILBOX_TOKEN}` },
    body: JSON.stringify({ tokenHashBase64Url: createHash("sha256").update(MAILBOX_TOKEN, "utf8").digest("base64url") })
  });
  assert.ok(registered.ok, "mailbox registration failed");
  // One sealed envelope waiting, exactly as the desktop would have left it.
  const posted = await fetch(`http://127.0.0.1:${MAILBOX_PORT}/v1/mailbox/events?mailboxId=${MAILBOX_ID}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${MAILBOX_TOKEN}` },
    body: JSON.stringify({
      events: [{
        eventId: "sw-db-envelope-1", conversationId: CONVERSATION, logScopeId: CONVERSATION,
        originId: "desktop-origin", originSeq: 1, eventHash: "hash-1",
        kind: "mobile.timeline.events",
        payload: sealPayload({ type: "mobile.timeline.events", conversationId: CONVERSATION, events: [] })
      }]
    })
  });
  assert.ok(posted.ok, `posting the envelope failed: ${posted.status}`);

  killStaleCdp();
  profile = await mkdtemp(path.join(tmpdir(), "aa-sw-db-"));
  chrome = spawn(CHROME, [
    "--headless=new", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    "--window-size=430,860", `http://127.0.0.1:${SITE_PORT}/`
  ], { stdio: "ignore" });
  let app;
  for (let attempt = 0; attempt < 60 && !app; attempt += 1) {
    try { app = await attach({ port: CDP_PORT, title: "AccordAgents" }); }
    catch { await wait(500); }
  }
  assert.ok(app, "could not attach to Chrome");
  const evaluate = async (expression) => {
    const result = await app.evaluate(expression);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };

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
  for (const store of ["meta", "sealedEnvelopes", "machineEvents", "machineOutbox", "machineBlobs"]) {
    assert.ok(pageVersion.stores.includes(store), `the page's database is missing ${store}`);
  }

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

  // What the worker is told to sync with. The page mirrors these itself in
  // normal use; written here directly so the test is about the database.
  await evaluate(`(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(${JSON.stringify(DB_NAME)});
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("meta", "readwrite");
      tx.objectStore("meta").put({
        key: "mailboxAccess",
        endpointUrl: "http://127.0.0.1:${SITE_PORT}/v1/mailbox/events",
        mailboxId: ${JSON.stringify(MAILBOX_ID)},
        token: ${JSON.stringify(MAILBOX_TOKEN)},
        cursor: 0
      });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return true;
  })()`);

  // A real push, delivered by the browser to the registered worker. The id is
  // the one Chrome reports for the registration, not a target id.
  const updated = app.waitForEvent("ServiceWorker.workerRegistrationUpdated", { timeoutMs: 30_000 });
  await app.send("ServiceWorker.enable", {});
  const registrations = await updated;
  const registration = (registrations.registrations || []).find((entry) => !entry.isDeleted);
  assert.ok(registration, "the shipped service worker never registered");
  await app.send("ServiceWorker.deliverPushMessage", {
    origin: `http://127.0.0.1:${SITE_PORT}`,
    registrationId: registration.registrationId,
    data: "sync"
  });

  // The proof: what the worker fetched and stored is readable by the page,
  // which means the worker opened this database rather than failing at it.
  let stored;
  for (let attempt = 0; attempt < 60 && !stored; attempt += 1) {
    stored = await evaluate(`(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(${JSON.stringify(DB_NAME)});
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const rows = await new Promise((resolve) => {
        const tx = db.transaction("sealedEnvelopes", "readonly");
        const all = tx.objectStore("sealedEnvelopes").getAll();
        all.onsuccess = () => resolve(all.result);
        all.onerror = () => resolve([]);
      });
      const access = await new Promise((resolve) => {
        const tx = db.transaction("meta", "readonly");
        const get = tx.objectStore("meta").get("mailboxAccess");
        get.onsuccess = () => resolve(get.result || null);
        get.onerror = () => resolve(null);
      });
      db.close();
      return rows.length ? { ids: rows.map((row) => row.eventId), cursor: access && access.cursor } : null;
    })()`);
    if (!stored) await wait(500);
  }
  assert.ok(stored, "the push-woken worker stored nothing: it could not use the page's database");
  assert.deepEqual(stored.ids, ["sw-db-envelope-1"], "the worker stored the envelope it fetched");
  assert.ok(Number(stored.cursor) > 0, "and advanced the shared cursor it read");
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

  // The worker goes first and only asks for the two stores it uses.
  const workerDb = await openControlDb(fakeIndexedDb, [STORES.meta, STORES.sealed]);
  assert.equal(workerDb.version, DB_VERSION, "the worker settles on the shared version, not one of its own");
  resetResolvedVersion();
  // The page follows and finds everything it needs already there.
  const pageDb = await openControlDb(fakeIndexedDb);
  assert.equal(pageDb.version, DB_VERSION, "and the page does not have to upgrade past it");
  for (const store of Object.values(STORES)) {
    assert.ok(pageDb.objectStoreNames.contains(store), `the page is missing ${store}`);
  }
});
