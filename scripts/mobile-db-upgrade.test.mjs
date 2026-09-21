/**
 * The phone's database moving from the version every installed phone has to
 * the one this shell asks for, in a real browser.
 *
 * Version 6 adds an index over the timeline store's chat id. On an installed
 * phone that store already exists and holds weeks of rows, so the index is
 * created inside the version-change transaction on the existing store — a
 * path a fresh profile never takes, because it creates the store and the
 * index together. This builds the version-5 shape by hand on the app's
 * origin, then loads the app and checks that it opened the database, raised
 * it, added the index, and can still reach the old rows through it.
 *
 * This is desktop Chrome, not the installed phone.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { spawn, execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { attach } = require("./cdp.cjs");
const { loadMobileOriginHeaders, mobileOriginHeadersForPath } = require("./mobile-origin-headers.cjs");

const repoRoot = path.resolve(import.meta.dirname, "..");
const root = path.join(repoRoot, "dist/mobile");
const SITE_PORT = 8261;
const CDP_PORT = 9411;
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DB_NAME = "accordagents-mobile-control";
// A page on the app's origin that runs none of the app: the database is
// shaped here before the app ever sees it.
const EMPTY_PAGE = "/qa-empty-page.html";

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const originHeaders = loadMobileOriginHeaders(root);
const site = createServer(async (req, res) => {
  const rel = (req.url || "/").split("?")[0];
  if (rel === EMPTY_PAGE) {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>AccordAgents</title><p>empty</p>");
    return;
  }
  const file = path.join(root, rel === "/" ? "index.html" : rel);
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", ...mobileOriginHeadersForPath(originHeaders, rel) });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killStaleCdp = () => {
  try { execSync(`lsof -ti tcp:${CDP_PORT} -sTCP:LISTEN | xargs kill -9`, { stdio: "ignore" }); } catch { /* nothing listening */ }
};

test("a phone on database version 5 gets the chat index without losing its rows", async (t) => {
  await new Promise((r) => site.listen(SITE_PORT, "127.0.0.1", r));
  killStaleCdp();
  const profile = await mkdtemp(path.join(tmpdir(), "aa-mobile-db-upgrade-"));
  const chrome = spawn(CHROME, [
    "--headless=new", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    "--window-size=390,844", `http://127.0.0.1:${SITE_PORT}${EMPTY_PAGE}`
  ], { stdio: "ignore" });
  let app;
  const attachWithRetry = async () => {
    app?.close();
    app = undefined;
    for (let i = 0; i < 40 && !app; i += 1) {
      try { app = await attach({ port: CDP_PORT, title: "AccordAgents" }); } catch { await sleep(500); }
    }
    assert.ok(app, "could not attach to Chrome");
  };
  const evaluate = async (expr) => {
    const result = await app.evaluate(expr);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  try {
    await attachWithRetry();
    // The shape an installed phone has today: version 5, the timeline store
    // with its createdAt index only, and rows in it.
    const seeded = await evaluate(`(async () => {
      const request = indexedDB.open(${JSON.stringify(DB_NAME)}, 5);
      request.onupgradeneeded = () => {
        const db = request.result;
        const outbox = db.createObjectStore("outbox", { keyPath: "eventId" });
        outbox.createIndex("status", "status", { unique: false });
        outbox.createIndex("createdAt", "createdAt", { unique: false });
        const timeline = db.createObjectStore("timeline", { keyPath: "id" });
        timeline.createIndex("createdAt", "createdAt", { unique: false });
        db.createObjectStore("meta", { keyPath: "key" });
        db.createObjectStore("sealedEnvelopes", { keyPath: "eventId" });
        const events = db.createObjectStore("events", { keyPath: "eventId" });
        events.createIndex("origin", ["originId", "logScopeId", "originSeq"], { unique: false });
        events.createIndex("conversationId", "conversationId", { unique: false });
        const machineEvents = db.createObjectStore("machineEvents", { keyPath: "eventId" });
        machineEvents.createIndex("origin", ["originId", "logScopeId", "originSeq"], { unique: false });
        db.createObjectStore("machineOutbox", { keyPath: "eventId" });
        db.createObjectStore("machineBlobs", { keyPath: "key" });
      };
      const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      await new Promise((resolve, reject) => {
        const tx = db.transaction("timeline", "readwrite");
        const store = tx.objectStore("timeline");
        for (let i = 0; i < 300; i += 1) {
          const chat = "chat-" + (i % 3);
          store.put({ id: chat + ":m" + i, sourceId: "m" + i, messageId: "m" + i, conversationId: chat, role: "participant",
            participantLabel: "@drew", content: "Row " + i, status: "done", createdAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString() });
        }
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      const version = db.version;
      db.close();
      return version;
    })()`);
    assert.equal(seeded, 5, "the database starts at the version installed phones have");

    // The app loads over it and raises it.
    await evaluate(`location.href = "/"`);
    await sleep(1500);
    await attachWithRetry();
    let ready = false;
    for (let i = 0; i < 60 && !ready; i += 1) {
      ready = await evaluate(`Boolean(globalThis.AccordAgentsMobile && globalThis.AccordMobileDb)`);
      if (!ready) await sleep(500);
    }
    assert.ok(ready, "the app came up on the upgraded database");
    const after = await evaluate(`(async () => {
      const db = await globalThis.AccordMobileDb.openControlDb(indexedDB);
      const store = db.transaction("timeline").objectStore("timeline");
      const names = [...store.indexNames];
      const rows = await new Promise((resolve, reject) => {
        const all = store.index("conversationId").getAll("chat-1");
        all.onsuccess = () => resolve(all.result);
        all.onerror = () => reject(all.error);
      });
      const total = await new Promise((resolve) => { const count = store.count(); count.onsuccess = () => resolve(count.result); });
      const version = db.version;
      db.close();
      return { version, names, byChat: rows.length, total };
    })()`);
    assert.equal(after.version, 6, "raised to the version this shell asks for");
    assert.ok(after.names.includes("conversationId"), `the chat index was added to the existing store: ${after.names.join(", ")}`);
    assert.equal(after.total, 300, "no row was lost in the upgrade");
    assert.equal(after.byChat, 100, "the old rows are reachable through the new index");
    // And the app reads them through it.
    const listed = await evaluate(`globalThis.AccordAgentsMobile.listTimelineEntries("chat-2").then((rows) => rows.length)`);
    assert.equal(listed, 100);
    t.diagnostic(`upgraded to v${after.version} with indexes ${after.names.join(", ")}`);
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    await new Promise((resolve) => site.close(resolve));
    await rm(profile, { recursive: true, force: true });
  }
});
