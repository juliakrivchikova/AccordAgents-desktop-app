// The eternal "Thinking" row, second half. A placeholder row ("Running..." /
// "@x is running...") is deleted by the terminal that carries its run keys —
// but a run can die without one (an interrupted app, or an answer written
// before terminals inherited the source's mobile event id), and then the row
// sat on screen forever with its clock ticking. When a terminal arrives, the
// phone now sweeps placeholder rows old enough that no live run could still
// own them (the CLI itself is killed at 15 minutes), while fresh placeholders
// and real pending text are untouched — the reverted age guard's mistake.
//
// Runs the real PWA in Chrome against the locked reference mailbox, exactly
// like mobile-inprogress-row.test.mjs.
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
const SITE_PORT = 8171;
const MAILBOX_PORT = 8172;
const CDP_PORT = 9345;
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CONVERSATION = "conv-corpse-qa";

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

let seq = 0;
const postEnvelope = async (events) => {
  seq += 1;
  const res = await fetch(`http://127.0.0.1:${MAILBOX_PORT}/v1/mailbox/events?mailboxId=${MAILBOX_ID}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${MAILBOX_TOKEN}` },
    body: JSON.stringify({
      events: [{
        eventId: `corpse-envelope-${seq}`,
        conversationId: CONVERSATION,
        logScopeId: CONVERSATION,
        originId: "desktop-origin",
        originSeq: seq,
        eventHash: `hash-${seq}`,
        kind: "mobile.timeline.events",
        payload: sealPayload({ type: "mobile.timeline.events", conversationId: CONVERSATION, events })
      }]
    })
  });
  const ack = await res.json();
  assert.ok(res.ok && ack.appendedEventIds.length === 1, `mailbox did not append: ${JSON.stringify(ack)}`);
};

const registerMailbox = async () => {
  const res = await fetch(`http://127.0.0.1:${MAILBOX_PORT}/v1/mailbox/register?mailboxId=${MAILBOX_ID}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${MAILBOX_TOKEN}` },
    body: JSON.stringify({
      tokenHashBase64Url: createHash("sha256").update(MAILBOX_TOKEN, "utf8").digest("base64url")
    })
  });
  assert.ok(res.ok, `mailbox registration failed: ${await res.text()}`);
};

const killStaleCdp = () => {
  try {
    execSync(`lsof -ti tcp:${CDP_PORT} -sTCP:LISTEN | xargs kill -9`, { stdio: "ignore" });
  } catch {
    // nothing listening
  }
};

// All times relative to the terminal at 01:40: the corpse is 40 minutes old,
// the fresh placeholder 2 minutes, the real pending text 3 minutes.
const corpsePlaceholder = {
  id: "corpse-row",
  messageId: "corpse-row",
  role: "participant",
  content: "Running...",
  status: "pending",
  createdAt: new Date(Date.UTC(2026, 0, 1, 1, 0)).toISOString(),
  runId: "mobile-old-evt",
  mobileEventId: "old-evt"
};
const freshPlaceholder = {
  id: "fresh-row",
  messageId: "fresh-row",
  role: "participant",
  participantLabel: "@drew",
  content: "@drew is running...",
  status: "pending",
  createdAt: new Date(Date.UTC(2026, 0, 1, 1, 38)).toISOString(),
  runId: "mobile-new-evt",
  mobileEventId: "new-evt"
};
const realPendingText = {
  id: "text-row",
  messageId: "text-row",
  role: "participant",
  participantLabel: "@drew",
  content: "Half of an answer that is still being writ",
  status: "pending",
  createdAt: new Date(Date.UTC(2026, 0, 1, 1, 37)).toISOString(),
  runId: "mobile-live-evt",
  mobileEventId: "live-evt"
};
const unrelatedTerminal = {
  id: "answer-row",
  messageId: "answer-row",
  role: "participant",
  participantLabel: "@codex",
  content: "A finished answer from a different run.",
  status: "done",
  createdAt: new Date(Date.UTC(2026, 0, 1, 1, 40)).toISOString(),
  runId: "11111111-2222-3333-4444-555555555555"
};

test("a terminal sweeps placeholder corpses but spares fresh placeholders and real pending text", async (t) => {
  t.diagnostic(`serving ${root}`);
  await new Promise((r) => site.listen(SITE_PORT, "127.0.0.1", r));
  await new Promise((r) => mailboxServer.listen(MAILBOX_PORT, "127.0.0.1", r));
  killStaleCdp();
  const profile = await mkdtemp(path.join(tmpdir(), "aa-mobile-corpse-"));
  const chrome = spawn(CHROME, [
    "--headless=new", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    "--window-size=430,860", `http://127.0.0.1:${SITE_PORT}/`
  ], { stdio: "ignore" });

  let app;
  try {
    await registerMailbox();
    await postEnvelope([corpsePlaceholder, freshPlaceholder, realPendingText]);

    for (let i = 0; i < 40 && !app; i += 1) {
      try {
        app = await attach({ port: CDP_PORT, title: "AccordAgents" });
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    assert.ok(app, "could not attach to Chrome");
    const evaluate = async (expr) => (await app.evaluate(expr)).result.value;

    await evaluate(`(() => {
      localStorage.setItem("accordagents.mobile.pairing.v1", JSON.stringify({
        endpoint: "http://127.0.0.1:${SITE_PORT}/",
        outboxUrl: "http://127.0.0.1:${SITE_PORT}/v1/mailbox/events",
        conversationId: "${CONVERSATION}",
        relaySealKeyBase64: "${SEAL_KEY}",
        pairedAt: new Date(0).toISOString()
      }));
      localStorage.setItem("accordagents.mobile.chatList.v1", JSON.stringify([
        { id: "${CONVERSATION}", title: "Corpse QA", group: "AccordAgents", snippet: "QA", updatedAt: new Date(0).toISOString(), participants: [] }
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
    // The corpse has no participant label, so it names nobody at all; the two
    // live rows say "@drew". The labels tell the three rows apart without
    // depending on internal row keys. It used to render under an "Agent"
    // fallback with a letter avatar, which invented a member who does not
    // exist and then swapped identity when the real one started.
    const runningLabels = async () => await evaluate(
      `(() => [...document.querySelectorAll('#message-list .message-row[data-status="Running"] .message-handle')].map((n) => n.textContent).sort().join(","))()`
    );

    let appeared = 0;
    for (let i = 0; i < 20 && appeared < 3; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      appeared = await runningRows();
    }
    assert.equal(appeared, 3, "all three pending rows appear before the terminal");
    // The unnamed corpse has no handle node at all now: it is a small pulsing
    // indication, not a row wearing a member's clothes.
    assert.equal(await runningLabels(), "@drew,@drew", "only the two named rows name anybody");
    assert.equal(
      await evaluate(`(() => document.querySelectorAll('#message-list .message-row[data-scaffolding="1"] .message-typing').length)()`),
      1,
      "the unnamed corpse is the quiet indication"
    );

    // W-M(f): without a live relay socket a placeholder row cannot be
    // followed — it is blocked and a tap states the reason on the row —
    // while a row already carrying real text stays openable.
    const blockedState = JSON.parse(await evaluate(`(() => {
      const rows = [...document.querySelectorAll('#message-list .message-row[data-status="Running"]')];
      const blocked = rows.find((row) => row.dataset.streamBlocked);
      if (blocked) { blocked.click(); }
      return JSON.stringify({
        blockedCount: rows.filter((row) => row.dataset.streamBlocked).length,
        streamableCount: rows.filter((row) => row.dataset.streamable === "1").length,
        notice: blocked ? blocked.querySelector(".message-status")?.textContent : ""
      });
    })()`));
    // The unnamed corpse is no longer a message row at all — it is a small
    // pulsing indication that invites no tap, so there is nothing to block and
    // nothing to explain. The named placeholder still looks like a member's row
    // and therefore still has to say why it cannot be followed.
    assert.ok(blockedState.blockedCount >= 1, "the named placeholder is blocked without a live socket: " + JSON.stringify(blockedState));
    assert.equal(blockedState.streamableCount, 1, "the row with real text stays followable: " + JSON.stringify(blockedState));
    assert.equal(blockedState.notice, "No live connection", "a tap on a blocked row states the reason");

    await postEnvelope([unrelatedTerminal]);
    let remaining = 3;
    for (let i = 0; i < 20 && remaining >= 3; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      remaining = await runningRows();
    }
    assert.equal(remaining, 2, "exactly the 40-minute-old placeholder is swept when a terminal arrives");
    assert.equal(await runningLabels(), "@drew,@drew", "the fresh placeholder and the real pending text survive");
    assert.equal(
      await evaluate(`(() => document.querySelectorAll('#message-list .message-row[data-scaffolding="1"]').length)()`),
      0,
      "the swept corpse takes its indication with it"
    );
    const textSurvives = await evaluate(
      `(() => (document.getElementById("message-list").textContent || "").includes("Half of an answer"))()`
    );
    assert.equal(textSurvives, true, "real pending text is untouched — the sweep is placeholder-only");
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    killStaleCdp();
    site.close();
    mailboxServer.close();
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
});
