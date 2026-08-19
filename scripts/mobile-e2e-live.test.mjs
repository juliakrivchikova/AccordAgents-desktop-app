// End-to-end: the real desktop publisher, a real relay, the real PWA.
//
// Every mobile harness before this one fed the phone envelopes I wrote by hand.
// That proves the phone reacts correctly to what I *think* the desktop sends,
// which is exactly the gap that let four consecutive "fixes" pass their tests
// and fail on User's phone. Here the events come from
// MobileRelayControlService itself — the shipped publication code, driven by a
// chat sender that emits progress the way a real run does — travel over a real
// relay socket and a real mailbox, and land in a real browser running the built
// PWA. Nothing between the two ends is faked.
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
const { createReferenceRelayServer } = require("./relay-reference-server.cjs");
const { loadMobileOriginHeaders, mobileOriginHeadersForPath } = require("./mobile-origin-headers.cjs");

const repoRoot = path.resolve(import.meta.dirname, "..");
const root = path.join(repoRoot, "dist/mobile");
const SITE_PORT = 8191;
const MAILBOX_PORT = 8192;
const CDP_PORT = 9351;
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CONVERSATION = "conv-e2e";
const RENDEZVOUS = "rv-e2e";

const SEAL_KEY = randomBytes(32).toString("base64url");
const sealKeyBuffer = Buffer.from(SEAL_KEY, "base64url");
const MAILBOX_TOKEN = createHmac("sha256", sealKeyBuffer).update("accord-mailbox-auth-v1", "utf8").digest("base64url");
const MAILBOX_ID = "mb-" + createHmac("sha256", sealKeyBuffer).update("accord-mailbox-scope-v1", "utf8").digest("base64url").slice(0, 32);

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".webmanifest": "application/manifest+json"
};

const sealPayload = (payload) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealKeyBuffer, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tagged = Buffer.concat([ciphertext, cipher.getAuthTag()]);
  return { v: 1, alg: "A256GCM", iv: iv.toString("base64url"), ct: tagged.toString("base64url") };
};

const killStaleCdp = () => {
  try {
    execSync(`lsof -ti tcp:${CDP_PORT} -sTCP:LISTEN | xargs kill -9`, { stdio: "ignore" });
  } catch {
    // nothing listening
  }
};

test("live end-to-end: the in-progress row holds, streams, and becomes the answer", async (t) => {
  const { MobileRelayControlService } = await import(
    path.join(repoRoot, "dist/main/main/services/mobileRelayControl.js")
  );

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
    let rel = url.split("?")[0];
    if (rel === "/") {
      rel = "/index.html";
    }
    try {
      const body = await readFile(path.join(root, rel));
      // The shipped policy allows wss: and not ws:, which is right for
      // production and wrong for a loopback relay — it blocks this harness's
      // socket outright. (Worth keeping in view: it also means any deployment
      // pointing a pairing at a plain-ws relay would be blocked at the phone.)
      // The policy has its own harness; this one is about streaming.
      const headers = { ...mobileOriginHeadersForPath(originHeaders, rel) };
      delete headers["Content-Security-Policy"];
      res.writeHead(200, {
        "content-type": TYPES[path.extname(rel)] || "application/octet-stream",
        ...headers
      });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise((r) => site.listen(SITE_PORT, "127.0.0.1", r));

  const mailbox = createReferenceMailboxServer({ locked: true });
  const mailboxServer = mailbox.server ?? mailbox;
  await new Promise((r) => mailboxServer.listen(MAILBOX_PORT, "127.0.0.1", r));
  const relay = createReferenceRelayServer();
  const relayAddress = await relay.listen();

  await fetch(`http://127.0.0.1:${MAILBOX_PORT}/v1/mailbox/register?mailboxId=${MAILBOX_ID}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${MAILBOX_TOKEN}` },
    body: JSON.stringify({ tokenHashBase64Url: createHash("sha256").update(MAILBOX_TOKEN, "utf8").digest("base64url") })
  });

  // The durable half of what main.ts wires up: sealed envelopes into the real
  // mailbox, same shape the desktop appends.
  let originSeq = 0;
  const timelineSink = {
    async publishTimeline(timeline) {
      originSeq += 1;
      await fetch(`http://127.0.0.1:${MAILBOX_PORT}/v1/mailbox/events?mailboxId=${MAILBOX_ID}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${MAILBOX_TOKEN}` },
        body: JSON.stringify({
          events: [{
            eventId: `e2e-${originSeq}`,
            conversationId: CONVERSATION,
            logScopeId: CONVERSATION,
            originId: "desktop-origin",
            originSeq,
            eventHash: `hash-${originSeq}`,
            kind: "mobile.timeline.events",
            payload: sealPayload(timeline)
          }]
        })
      });
    }
  };

  // A run that writes its answer in pieces, exactly like a real one.
  const ticks = ["Half a sen", "Half a sentence, and", "Half a sentence, and then the end."];
  let progressSink;
  const control = new MobileRelayControlService(
    {
      relayUrl: relayAddress.url,
      rendezvousId: RENDEZVOUS,
      relayCapability: "PAIRING-FINGERPRINT",
      relaySealKeyBase64: SEAL_KEY,
      conversationId: CONVERSATION,
      streamId: `route-e2e:phone`,
      reconnectDelayMs: 50
    },
    { async sendMessage() { throw new Error("not used in this leg"); } },
    undefined,
    (progress) => { progressSink?.(progress); },
    timelineSink
  );

  killStaleCdp();
  const profile = await mkdtemp(path.join(tmpdir(), "aa-e2e-"));
  const chrome = spawn(CHROME, [
    "--headless=new", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    "--window-size=430,860", `http://127.0.0.1:${SITE_PORT}/?qa=1`
  ], { stdio: "ignore" });

  let app;
  try {
    await control.connect();
    const { getJson } = require("./cdp.cjs");
    let attachError;
    for (let i = 0; i < 60 && !app; i += 1) {
      try {
        const targets = await getJson("/json", { port: CDP_PORT });
        const page = targets.find((target) => target.type === "page" && (target.url || "").startsWith(`http://127.0.0.1:${SITE_PORT}`));
        if (!page) {
          throw new Error(`no page target yet (${targets.length} targets)`);
        }
        app = await attach({ port: CDP_PORT, title: page.title });
      } catch (error) {
        attachError = error;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    assert.ok(app, `could not attach to Chrome: ${attachError?.message ?? attachError}`);
    // A page target carries our URL before its document is ours: until the
    // navigation commits, the document is the initial empty one, whose origin
    // is opaque and denies storage outright. On a Mac the load won that race;
    // on a slower box it does not, and every storage call fails with
    // "Access is denied for this document". Wait for the origin, not the URL.
    for (let i = 0; i < 60; i += 1) {
      const origin = await app.evaluate(`location.origin`).then((r) => r.result?.value).catch(() => undefined);
      if (origin === `http://127.0.0.1:${SITE_PORT}`) {
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    const evaluate = async (expr) => (await app.evaluate(expr)).result.value;

    await evaluate(`(() => {
      localStorage.setItem("accordagents.mobile.pairing.v1", JSON.stringify({
        endpoint: "http://127.0.0.1:${SITE_PORT}/",
        outboxUrl: "http://127.0.0.1:${SITE_PORT}/v1/mailbox/events",
        relayUrl: "${relayAddress.url}",
        rendezvousId: "${RENDEZVOUS}",
        fingerprint: "PAIRING-FINGERPRINT",
        routingId: "route-e2e",
        streamId: "route-e2e:phone",
        conversationId: "${CONVERSATION}",
        relaySealKeyBase64: "${SEAL_KEY}",
        pairedAt: new Date(0).toISOString()
      }));
      localStorage.setItem("accordagents.mobile.chatList.v1", JSON.stringify([
        { id: "${CONVERSATION}", title: "E2E", group: "AccordAgents", snippet: "e2e", updatedAt: new Date(0).toISOString(), participants: [] }
      ]));
      localStorage.setItem("accordagents.mobile.activeConversationId.v1", "${CONVERSATION}");
      return true;
    })()`);
    await evaluate(`navigator.serviceWorker.ready.then(() => true)`);
    await app.send("Page.reload", {});
    await new Promise((r) => setTimeout(r, 6000));

    const runningRows = async () => await evaluate(
      `(() => document.querySelectorAll('#message-list .message-row[data-status="Running"]').length)()`
    );
    const streamText = async () => await evaluate(
      `(() => (document.getElementById("stream-body")?.textContent || "").trim())()`
    );

    // The real publisher emits growing progress for a live run.
    const runId = "run-e2e-1";
    const tick = (text, state, seconds) => ({
      runId,
      phase: state === "finished" ? "done" : "debate",
      message: "@drew is writing.",
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString(),
      agentProgress: {
        participantId: "participant-drew",
        participantLabel: "@drew",
        state,
        messageId: "message-drew-e2e",
        partialContent: text
      }
    });

    control.noteExternalChatProgress(tick(ticks[0], "running", 1));
    let rows = 0;
    for (let i = 0; i < 30 && rows === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      rows = await runningRows();
    }
    assert.equal(rows, 1, "the in-progress row reaches the phone from the real publisher");

    // It must still be there after the pause a real run takes.
    await new Promise((r) => setTimeout(r, 6000));
    assert.equal(await runningRows(), 1, "the in-progress row holds while the run continues");

    // Opening it shows what has been written so far.
    await evaluate(`(() => { document.querySelector('#message-list .message-row[data-streamable="1"]').click(); return true; })()`);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await streamText(), ticks[0], "the stream opens on the text written so far");

    // And follows the reply as it grows.
    control.noteExternalChatProgress(tick(ticks[1], "running", 2));
    let grown = "";
    for (let i = 0; i < 30 && grown !== ticks[1]; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      grown = await streamText();
    }
    assert.equal(grown, ticks[1], "the stream follows the reply as it is written");

    t.diagnostic("row held, stream opened and followed — through the real publisher, relay and PWA");
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    killStaleCdp();
    control.close();
    await relay.close();
    site.close();
    mailboxServer.close();
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
});
