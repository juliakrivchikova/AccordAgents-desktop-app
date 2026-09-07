/**
 * The phone answering a card, driven through the real PWA in a browser.
 *
 * A permission a member is waiting on is published exactly the way the desktop
 * publishes it, the card is tapped in the page, and what the phone then holds
 * and posts is checked: the event and the queue entry written together, the
 * native identifiers carried back, the card saying "sent" rather than
 * "answered", and all of it surviving a reload.
 *
 * This is a browser check, not the installed phone: it runs the same files the
 * phone runs, under the same origin headers, but a physically installed PWA is
 * not claimed by it.
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
const SITE_PORT = 8165;
const MAILBOX_PORT = 8166;
const CDP_PORT = 9355;
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CONVERSATION = "conv-cards-qa";

const SEAL_KEY = randomBytes(32).toString("base64url");
const sealKeyBuffer = Buffer.from(SEAL_KEY, "base64url");
const MAILBOX_TOKEN = createHmac("sha256", sealKeyBuffer).update("accord-mailbox-auth-v1", "utf8").digest("base64url");
const MAILBOX_ID = "mb-" + createHmac("sha256", sealKeyBuffer).update("accord-mailbox-scope-v1", "utf8").digest("base64url").slice(0, 32);

const sealPayload = (payload) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealKeyBuffer, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tagged = Buffer.concat([ciphertext, cipher.getAuthTag()]);
  return { v: 1, alg: "A256GCM", iv: iv.toString("base64url"), ct: tagged.toString("base64url") };
};

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json" };
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
      // From the resolved file, not the request path: "/" has no extension and
      // index.html would be served as a download instead of a page.
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

let seq = 0;
const postEnvelope = async (payload) => {
  seq += 1;
  const res = await fetch(`http://127.0.0.1:${MAILBOX_PORT}/v1/mailbox/events?mailboxId=${MAILBOX_ID}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${MAILBOX_TOKEN}` },
    body: JSON.stringify({
      events: [{
        eventId: `cards-envelope-${seq}`,
        conversationId: CONVERSATION,
        logScopeId: CONVERSATION,
        originId: "desktop-origin",
        originSeq: seq,
        eventHash: `hash-${seq}`,
        kind: "mobile.timeline.events",
        payload: sealPayload(payload)
      }]
    })
  });
  const ack = await res.json();
  assert.ok(res.ok && ack.appendedEventIds.length === 1, `mailbox did not append: ${JSON.stringify(ack)}`);
};

const permissionCard = {
  id: "card-qa-1",
  kind: "permission",
  conversationId: CONVERSATION,
  title: "@drew wants to read a file",
  summary: "Read src/index.ts from the project.",
  requesterLabel: "@drew",
  machineName: "cloud-box",
  options: [{ id: "allow", label: "Allow" }, { id: "deny", label: "Deny" }],
  allowsCustomAnswer: false,
  allowsCancel: false,
  status: "pending",
  createdAt: new Date(Date.UTC(2026, 8, 7, 9, 0)).toISOString(),
  codexDecisionId: "native-decision-77",
  draftOverride: { capability: "read", path: "src/index.ts" }
};

const message = {
  id: "m1", messageId: "m1", role: "participant", participantLabel: "@drew",
  content: "Working on it.", status: "done", createdAt: new Date(Date.UTC(2026, 8, 7, 8, 59)).toISOString()
};

const killStaleCdp = () => {
  try { execSync(`lsof -ti tcp:${CDP_PORT} -sTCP:LISTEN | xargs kill -9`, { stdio: "ignore" }); } catch { /* nothing listening */ }
};

test("a card published by the desktop is answered on the phone and survives a reload", async (t) => {
  await new Promise((r) => site.listen(SITE_PORT, "127.0.0.1", r));
  await new Promise((r) => mailboxServer.listen(MAILBOX_PORT, "127.0.0.1", r));
  killStaleCdp();
  const profile = await mkdtemp(path.join(tmpdir(), "aa-mobile-cards-"));
  const chrome = spawn(CHROME, [
    "--headless=new", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    "--window-size=430,860", `http://127.0.0.1:${SITE_PORT}/`
  ], { stdio: "ignore" });

  let app;
  try {
    const registered = await fetch(`http://127.0.0.1:${MAILBOX_PORT}/v1/mailbox/register?mailboxId=${MAILBOX_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${MAILBOX_TOKEN}` },
      body: JSON.stringify({ tokenHashBase64Url: createHash("sha256").update(MAILBOX_TOKEN, "utf8").digest("base64url") })
    });
    assert.ok(registered.ok, "mailbox registration failed");
    await postEnvelope({ type: "mobile.timeline.events", conversationId: CONVERSATION, events: [message], cards: [permissionCard] });

    for (let i = 0; i < 40 && !app; i += 1) {
      try { app = await attach({ port: CDP_PORT, title: "AccordAgents" }); }
      catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    assert.ok(app, "could not attach to Chrome");
    const evaluate = async (expr) => (await app.evaluate(expr)).result.value;

    await evaluate(`(() => {
      localStorage.setItem("accordagents.mobile.pairing.v1", JSON.stringify({
        endpoint: "http://127.0.0.1:${SITE_PORT}/",
        outboxUrl: "http://127.0.0.1:${SITE_PORT}/v1/mailbox/events",
        conversationId: "${CONVERSATION}",
        relaySealKeyBase64: "${SEAL_KEY}",
        pairedAt: new Date(0).toISOString(),
        power: {
          version: 1, handoffId: "handoff-qa", machineId: "m1",
          instanceId: "i-0943b28f7231ab93c", region: "us-east-1",
          credentials: { accessKeyId: "AKIAEXAMPLEWAKEKEY001", secretAccessKey: "synthetic", region: "us-east-1" },
          issuedTo: "route", issuedAt: new Date(0).toISOString()
        }
      }));
      localStorage.setItem("accordagents.mobile.chatList.v1", JSON.stringify([
        { id: "${CONVERSATION}", title: "Cards QA", group: "AccordAgents", snippet: "QA", updatedAt: new Date(0).toISOString(), participants: [] }
      ]));
      localStorage.setItem("accordagents.mobile.activeConversationId.v1", "${CONVERSATION}");
      return true;
    })()`);
    await evaluate("location.reload()");
    await new Promise((r) => setTimeout(r, 1500));
    for (let i = 0; i < 40 && !app; i += 1) {
      try { app = await attach({ port: CDP_PORT, title: "AccordAgents" }); } catch { await new Promise((r) => setTimeout(r, 500)); }
    }

    const cardText = async () => evaluate(`(() => {
      const card = document.querySelector('[data-card-id="card-qa-1"]');
      return card ? card.innerText : null;
    })()`);
    let text = null;
    for (let i = 0; i < 60 && !text; i += 1) {
      text = await cardText();
      if (!text) await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(text, "the card never appeared on the phone");
    assert.match(text, /wants to read a file/);
    assert.match(text, /Read src\/index\.ts/);
    assert.match(text, /cloud-box/);
    t.diagnostic(`card rendered: ${text.replace(/\n/g, " | ")}`);

    // The wake control is offered because this pairing carries a scoped key.
    assert.equal(await evaluate(`(() => {
      const wake = document.getElementById("machine-wake");
      return wake && !wake.hidden ? wake.innerText : null;
    })()`) !== null, true, "the wake control must be offered when the pairing carries a key");

    // Tap Allow, in the page.
    await evaluate(`(() => {
      document.querySelector('[data-card-id="card-qa-1"] [data-option-id="allow"]').click();
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 2000));

    const stored = await evaluate(`(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("accordagents-mobile-control");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const read = (name) => new Promise((resolve) => {
        const tx = db.transaction(name, "readonly");
        const all = tx.objectStore(name).getAll();
        all.onsuccess = () => resolve(all.result);
        all.onerror = () => resolve([]);
      });
      const events = await read("events");
      const outbox = await read("outbox");
      db.close();
      const decision = events.find((entry) => entry.kind === "permission.decided");
      return {
        decision: decision || null,
        queued: outbox.some((entry) => decision && entry.eventId === decision.eventId),
        cardState: document.querySelector('[data-card-id="card-qa-1"] .control-card-state')?.innerText || "",
        allowDisabled: document.querySelector('[data-card-id="card-qa-1"] [data-option-id="allow"]')?.disabled === true
      };
    })()`);
    assert.ok(stored.decision, "the answer was not written to the phone's event log");
    assert.equal(stored.queued, true, "the event and the queue entry are written together");
    assert.equal(stored.decision.payload.targetKey, "approval:card-qa-1");
    assert.equal(stored.decision.payload.stateId, "approved");
    assert.equal(stored.decision.payload.detail.approve, true);
    assert.equal(stored.decision.payload.detail.codexDecisionId, "native-decision-77",
      "the native decision id must travel back with the answer");
    assert.deepEqual(stored.decision.payload.detail.draftOverride, { capability: "read", path: "src/index.ts" });
    assert.match(stored.cardState, /Waiting for the machine to apply it/,
      "a tap is not the answer being applied");
    assert.equal(stored.allowDisabled, true, "an answered card does not offer the action again");

    // The desktop received it: the sealed answer is in the mailbox.
    const posted = await fetch(`http://127.0.0.1:${MAILBOX_PORT}/v1/mailbox/events?mailboxId=${MAILBOX_ID}&limit=50`, {
      headers: { authorization: `Bearer ${MAILBOX_TOKEN}` }
    }).then((res) => res.json());
    assert.ok(
      (posted.events || []).some((event) => event.kind === "permission.decided"),
      "the answer never reached the mailbox the desktop reads"
    );

    // A reload must not lose it.
    await evaluate("location.reload()");
    await new Promise((r) => setTimeout(r, 2500));
    app = await attach({ port: CDP_PORT, title: "AccordAgents" });
    const afterReload = async () => (await app.evaluate(`(() => {
      const card = document.querySelector('[data-card-id="card-qa-1"]');
      return card ? card.innerText : null;
    })()`)).result.value;
    let reloaded = null;
    for (let i = 0; i < 40 && !reloaded; i += 1) {
      reloaded = await afterReload();
      if (!reloaded) await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(reloaded, "the open card did not survive a reload");

    // Once the desktop states it is no longer pending, the card leaves.
    await postEnvelope({ type: "mobile.timeline.events", conversationId: CONVERSATION, events: [message], cards: [] });
    let gone = false;
    for (let i = 0; i < 60 && !gone; i += 1) {
      gone = (await app.evaluate(`document.querySelector('[data-card-id="card-qa-1"]') === null`)).result.value === true;
      if (!gone) await new Promise((r) => setTimeout(r, 500));
    }
    assert.equal(gone, true, "an answered card must stop offering an action");
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    site.close();
    mailboxServer.close();
    await rm(profile, { recursive: true, force: true });
  }
});
