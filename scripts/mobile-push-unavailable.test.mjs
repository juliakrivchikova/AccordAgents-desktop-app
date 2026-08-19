// W-K: when the relay refuses this browser's push endpoint (W-D's allowlist),
// the phone must say so.
//
// A phone that silently never rings is indistinguishable from one that is
// simply quiet, so the user waits for an alert that will never come. This
// harness makes the relay refuse the subscription and asserts the phone lands
// in a stated-unavailable state, does not crash, and does not retry forever.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { spawn, execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { attach } = require("./cdp.cjs");
const { createReferenceMailboxServer } = require("./mailbox-reference-server.cjs");
// W-E: serve the shell under the policy the CDN applies, not a laxer one.
const { loadMobileOriginHeaders, mobileOriginHeadersForPath } = require("./mobile-origin-headers.cjs");

const repoRoot = path.resolve(import.meta.dirname, "..");
const root = path.join(repoRoot, "dist/mobile");
const SITE_PORT = 8161;
const MAILBOX_PORT = 8162;
const CDP_PORT = 9343;
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CONVERSATION = "conv-push-qa";

const SEAL_KEY = randomBytes(32).toString("base64url");
const sealKeyBuffer = Buffer.from(SEAL_KEY, "base64url");
const MAILBOX_TOKEN = createHmac("sha256", sealKeyBuffer).update("accord-mailbox-auth-v1", "utf8").digest("base64url");
const MAILBOX_ID = "mb-" + createHmac("sha256", sealKeyBuffer).update("accord-mailbox-scope-v1", "utf8").digest("base64url").slice(0, 32);

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".webmanifest": "application/manifest+json"
};

const pushSubscriptionPosts = [];

const originHeaders = loadMobileOriginHeaders(root);
const site = createServer(async (req, res) => {
  const url = req.url || "/";
  if (url.startsWith("/v1/push/vapid")) {
    res.writeHead(200, { "content-type": "application/json" });
    // A syntactically valid uncompressed P-256 point, so subscribe() gets past
    // key parsing; the fake subscription never reaches a real push service.
    res.end(JSON.stringify({ ok: true, publicKey: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString("base64url") }));
    return;
  }
  if (url.startsWith("/v1/mailbox/push-subscription")) {
    pushSubscriptionPosts.push(new Date().toISOString());
    // Exactly what W-D's worker answers for an endpoint outside the allowlist.
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "mailbox_push_endpoint_rejected", reason: "unsupported push service" }));
    return;
  }
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
  try {
    execSync(`lsof -ti tcp:${CDP_PORT} -sTCP:LISTEN | xargs kill -9`, { stdio: "ignore" });
  } catch {
    // nothing listening
  }
};

test("a refused push subscription is stated, not silent, and is not retried", async () => {
  await new Promise((r) => site.listen(SITE_PORT, "127.0.0.1", r));
  await new Promise((r) => mailboxServer.listen(MAILBOX_PORT, "127.0.0.1", r));
  await fetch(`http://127.0.0.1:${MAILBOX_PORT}/v1/mailbox/register?mailboxId=${MAILBOX_ID}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${MAILBOX_TOKEN}` },
    body: JSON.stringify({ tokenHashBase64Url: createHash("sha256").update(MAILBOX_TOKEN, "utf8").digest("base64url") })
  });
  killStaleCdp();
  const profile = await mkdtemp(path.join(tmpdir(), "aa-mobile-push-"));
  const chrome = spawn(CHROME, [
    "--headless=new", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    "--window-size=430,860", `http://127.0.0.1:${SITE_PORT}/`
  ], { stdio: "ignore" });

  let app;
  try {
    for (let i = 0; i < 40 && !app; i += 1) {
      try {
        app = await attach({ port: CDP_PORT, title: "AccordAgents" });
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    assert.ok(app, "could not attach to Chrome");
    const evaluate = async (expr) => (await app.evaluate(expr)).result.value;

    await app.send("Browser.grantPermissions", {
      origin: `http://127.0.0.1:${SITE_PORT}`,
      permissions: ["notifications"]
    });

    await evaluate(`(() => {
      localStorage.setItem("accordagents.mobile.pairing.v1", JSON.stringify({
        endpoint: "http://127.0.0.1:${SITE_PORT}/",
        outboxUrl: "http://127.0.0.1:${SITE_PORT}/v1/mailbox/events",
        conversationId: "${CONVERSATION}",
        relaySealKeyBase64: "${SEAL_KEY}",
        pairedAt: new Date(0).toISOString()
      }));
      localStorage.setItem("accordagents.mobile.chatList.v1", JSON.stringify([
        { id: "${CONVERSATION}", title: "Push QA", group: "AccordAgents", snippet: "QA", updatedAt: new Date(0).toISOString(), participants: [] }
      ]));
      localStorage.setItem("accordagents.mobile.activeConversationId.v1", "${CONVERSATION}");
      return true;
    })()`);
    await evaluate(`navigator.serviceWorker.ready.then(() => true)`);
    await app.send("Page.reload", {});
    await new Promise((r) => setTimeout(r, 6000));

    // Headless Chrome has no push service, so subscribe() cannot produce a real
    // subscription. Stand one in at the browser boundary only — everything the
    // phone does with it, and with the relay's answer, is the shipped code.
    await evaluate(`(async () => {
      const registration = await navigator.serviceWorker.ready;
      registration.pushManager.getSubscription = async () => ({
        toJSON: () => ({
          endpoint: "https://attacker.test/collect",
          keys: { p256dh: "fake-p256dh", auth: "fake-auth" }
        })
      });
      return true;
    })()`);

    const first = await evaluate(`AccordAgentsMobile.enableMessageAlerts()`);
    assert.equal(first, "granted", "permission is granted, so the phone proceeds to subscribe");
    assert.equal(pushSubscriptionPosts.length, 1, "the phone posted its subscription once");

    const state = await evaluate(`(() => {
      const button = document.getElementById("enable-alerts");
      return JSON.stringify({
        state: button?.dataset.alertsState ?? "",
        hidden: button?.hidden ?? null,
        text: (button?.textContent || "").trim()
      });
    })()`);
    const banner = JSON.parse(state);
    assert.equal(banner.state, "unavailable", `phone must state the refusal, got ${state}`);
    assert.equal(banner.hidden, false, "the statement must be visible, not hidden like the quiet-wait state");
    assert.match(banner.text, /aren't available/i, "the statement names what will not happen");

    // No retry loop: the endpoint will not become allowed by asking again.
    await evaluate(`AccordAgentsMobile.enableMessageAlerts()`);
    await evaluate(`AccordAgentsMobile.ensurePushSubscription()`);
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal(pushSubscriptionPosts.length, 1, "the refusal is terminal — no further attempts");

    // And the app is still alive and syncing after the refusal.
    const alive = await evaluate(`(() => Boolean(document.getElementById("message-list")))()`);
    assert.equal(alive, true, "the refusal must not take the app down");
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    killStaleCdp();
    site.close();
    mailboxServer.close();
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
});
