/**
 * A launch that cannot reach the relay keeps the phone's push subscription.
 *
 * Each launch replaces the subscription, because a subscription that has
 * quietly stopped being delivered looks exactly like a working one from the
 * phone. The replacement used to begin by giving the old one up; when the
 * relay could not be reached right then (opened offline, on a poor
 * connection) the phone was left with no subscription at all until the next
 * launch, and the notifications this was meant to keep were the ones lost.
 *
 * Desktop Chrome has no push service, so the browser boundary is stood in
 * for; everything the phone does with it is the shipped code. Not the
 * installed phone.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { spawn, execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { attach } = require("./cdp.cjs");
const { loadMobileOriginHeaders, mobileOriginHeadersForPath } = require("./mobile-origin-headers.cjs");

const repoRoot = path.resolve(import.meta.dirname, "..");
const root = path.join(repoRoot, "dist/mobile");
const SITE_PORT = 8281;
const CDP_PORT = 9431;
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CONVERSATION = "conv-push-offline";
const SEAL_KEY = randomBytes(32).toString("base64url");

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const originHeaders = loadMobileOriginHeaders(root);
/** Whether the relay can be reached for its key right now. */
const relay = { reachable: false };
const subscriptionPosts = [];
const site = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname === "/v1/push/vapid") {
    if (!relay.reachable) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, publicKey: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString("base64url") }));
    return;
  }
  if (url.pathname === "/v1/mailbox/push-subscription") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    subscriptionPosts.push(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (url.pathname === "/v1/mailbox/events") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.method === "GET"
      ? { events: [], epoch: "e1", oldestArrivalSeq: 1, maxArrivalSeq: 0 }
      : { ok: true, eventIds: [], appendedEventIds: [] }));
    return;
  }
  if (url.pathname.startsWith("/v1/")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
    return;
  }
  const rel = url.pathname;
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

test("a launch that cannot reach the relay keeps the subscription it has", { timeout: 120_000 }, async (t) => {
  await new Promise((r) => site.listen(SITE_PORT, "127.0.0.1", r));
  killStaleCdp();
  const profile = await mkdtemp(path.join(tmpdir(), "aa-mobile-push-offline-"));
  const chrome = spawn(CHROME, [
    "--headless=new", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    "--window-size=390,844", `http://127.0.0.1:${SITE_PORT}/`
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
    await evaluate(`(() => {
      localStorage.setItem("accordagents.mobile.pairing.v1", JSON.stringify({
        endpoint: "http://127.0.0.1:${SITE_PORT}/",
        outboxUrl: "http://127.0.0.1:${SITE_PORT}/v1/mailbox/events",
        conversationId: ${JSON.stringify(CONVERSATION)},
        relaySealKeyBase64: ${JSON.stringify(SEAL_KEY)},
        pairedAt: new Date(0).toISOString()
      }));
      localStorage.setItem("accordagents.mobile.chatList.v1", JSON.stringify([
        { id: ${JSON.stringify(CONVERSATION)}, title: "Push QA", group: "AccordAgents", snippet: "QA", updatedAt: new Date(0).toISOString(), participants: [] }
      ]));
      return true;
    })()`);
    await evaluate(`navigator.serviceWorker.ready.then(() => true)`);
    await evaluate("location.reload()");
    await sleep(2500);
    await attachWithRetry();
    let ready = false;
    for (let i = 0; i < 60 && !ready; i += 1) {
      ready = await evaluate("Boolean(globalThis.AccordAgentsMobile)");
      if (!ready) await sleep(500);
    }
    assert.ok(ready, "the app came up");

    // The browser boundary: a subscription this phone holds, and the push
    // service that would hand out a new one.
    await evaluate(`(async () => {
      const registration = await navigator.serviceWorker.ready;
      window.__unsubscribed = 0;
      window.__subscribed = 0;
      const held = {
        unsubscribe: async () => { window.__unsubscribed += 1; return true; },
        toJSON: () => ({ endpoint: "https://push.example/held", keys: { p256dh: "held-p256dh", auth: "held-auth" } })
      };
      registration.pushManager.getSubscription = async () => held;
      registration.pushManager.subscribe = async () => {
        window.__subscribed += 1;
        return { unsubscribe: async () => true, toJSON: () => ({ endpoint: "https://push.example/new-" + window.__subscribed, keys: { p256dh: "new-p256dh", auth: "new-auth" } }) };
      };
      return true;
    })()`);

    // Granted on the session that stays attached: a grant made on an earlier
    // one went with it. The page reads it once it has asked, through the same
    // call its own button makes.
    await app.send("Browser.grantPermissions", { origin: `http://127.0.0.1:${SITE_PORT}`, permissions: ["notifications"] });
    assert.equal(await evaluate("Notification.requestPermission()"), "granted", "alerts are allowed for this origin");

    // Offline for the relay's key: nothing is given up, nothing is posted.
    relay.reachable = false;
    await evaluate(`AccordAgentsMobile.ensurePushSubscription()`);
    assert.equal(await evaluate("window.__unsubscribed"), 0, "the subscription in hand is kept when no replacement can be made");
    assert.equal(await evaluate("window.__subscribed"), 0, "and no replacement was attempted");
    assert.equal(subscriptionPosts.length, 0, "nothing reached the relay");

    // Reachable again: the replacement goes ahead and is registered.
    relay.reachable = true;
    await evaluate(`AccordAgentsMobile.ensurePushSubscription()`);
    assert.equal(await evaluate("window.__unsubscribed"), 1, "the old subscription is given up once a replacement can be made");
    assert.equal(await evaluate("window.__subscribed"), 1, "and the replacement is made");
    assert.equal(subscriptionPosts.length, 1, "and registered with the relay");
    assert.equal(subscriptionPosts[0]?.subscription?.endpoint, "https://push.example/new-1", "the registered one is the new subscription");
    t.diagnostic(`posts: ${subscriptionPosts.length}`);
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    await new Promise((resolve) => site.close(resolve));
    await rm(profile, { recursive: true, force: true });
  }
});
