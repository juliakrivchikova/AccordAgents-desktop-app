// W-N: the in-progress row must survive the run.
//
// Observed on the phone: the "@drew is running" row appears and disappears
// about a second later while the run is still going. The cause is the message
// the user sent *from the phone*. It comes back in the next conversation
// snapshot as a finished ("done") event, and it carries the same run identity
// as the pending row — the run is named after it (`mobile-<eventId>`, and the
// same mobileEventId). The phone treated any non-pending event bearing a run
// identity as that run's terminal, so it deleted the pending row and recorded
// the run as terminal, which also blocked the row from ever coming back.
//
// This harness replays exactly that publication sequence against the real PWA
// through the locked mailbox contract, and asserts both halves: the user's own
// echo must not end the run, and the agent's finished message still must.
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
// W-E: serve the shell under the policy the CDN applies, not a laxer one.
const { loadMobileOriginHeaders, mobileOriginHeadersForPath } = require("./mobile-origin-headers.cjs");

const repoRoot = path.resolve(import.meta.dirname, "..");
const root = path.join(repoRoot, "dist/mobile");
const SITE_PORT = 8151;
const MAILBOX_PORT = 8152;
const CDP_PORT = 9341;
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CONVERSATION = "conv-inprogress-qa";
// The phone-originated event id, and the run named after it — the collision at
// the heart of this defect.
const MOBILE_EVENT_ID = "mob-evt-1";
const RUN_ID = `mobile-${MOBILE_EVENT_ID}`;

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
        eventId: `inprogress-envelope-${seq}`,
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

const doneMessage = (i) => ({
  id: `m${String(i).padStart(3, "0")}`,
  messageId: `m${String(i).padStart(3, "0")}`,
  role: i % 2 ? "participant" : "you",
  participantLabel: "Drew",
  content: `Earlier message number ${i}.`,
  status: "done",
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()
});

// What mobileRelayControl publishes while the run is live.
const runningRow = {
  id: `${RUN_ID}:@drew`,
  messageId: `${RUN_ID}:@drew`,
  role: "participant",
  participantLabel: "@drew",
  content: "@drew is running...",
  status: "pending",
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 50)).toISOString(),
  runId: RUN_ID,
  mobileEventId: MOBILE_EVENT_ID
};

// What the next conversation snapshot carries for the message the user sent
// from the phone: role "you", status "done", and the run's own identity —
// because chat.ts names the message `mobile-<eventId>` and stores the same
// mobileEventId on it.
const userEchoFromSnapshot = {
  id: RUN_ID,
  messageId: RUN_ID,
  role: "you",
  content: "What is the status of the mailbox work?",
  status: "done",
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 49)).toISOString(),
  runId: RUN_ID,
  mobileEventId: MOBILE_EVENT_ID
};

// The agent's actual answer, which must still end the run.
const agentAnswer = {
  id: "m099",
  messageId: "m099",
  role: "participant",
  participantLabel: "@drew",
  content: "Here is the finished answer from the run.",
  status: "done",
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 55)).toISOString(),
  runId: RUN_ID,
  mobileEventId: MOBILE_EVENT_ID
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

test("the in-progress row survives the user's own echo and ends only on the agent's answer", async (t) => {
  t.diagnostic(`serving ${root}`);
  await new Promise((r) => site.listen(SITE_PORT, "127.0.0.1", r));
  await new Promise((r) => mailboxServer.listen(MAILBOX_PORT, "127.0.0.1", r));
  killStaleCdp();
  const profile = await mkdtemp(path.join(tmpdir(), "aa-mobile-inprogress-"));
  const chrome = spawn(CHROME, [
    "--headless=new", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    "--window-size=430,860", `http://127.0.0.1:${SITE_PORT}/`
  ], { stdio: "ignore" });

  let app;
  try {
    await registerMailbox();
    await postEnvelope(Array.from({ length: 6 }, (_, i) => doneMessage(i)));

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
        { id: "${CONVERSATION}", title: "In-progress QA", group: "AccordAgents", snippet: "QA", updatedAt: new Date(0).toISOString(), participants: [] }
      ]));
      localStorage.setItem("accordagents.mobile.activeConversationId.v1", "${CONVERSATION}");
      return true;
    })()`);
    await evaluate(`navigator.serviceWorker.ready.then(() => true)`);
    await app.send("Page.reload", {});
    await new Promise((r) => setTimeout(r, 6000));

    // The phone renders a pending row as an animated "Thinking" rather than
    // echoing the placeholder text, so the row is identified by its status.
    const runningRows = async () => await evaluate(
      `(() => document.querySelectorAll('#message-list .message-row[data-status="Running"]').length)()`
    );

    await postEnvelope([runningRow]);
    let appeared = 0;
    for (let i = 0; i < 20 && appeared === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      appeared = await runningRows();
    }
    if (appeared !== 1) {
      t.diagnostic(await evaluate(`(() => JSON.stringify({
        rows: document.getElementById("message-list")?.childElementCount ?? -1,
        statuses: [...document.querySelectorAll("#message-list > *")].map((n) => n.getAttribute("data-status")),
        html: (document.querySelector('#message-list > *:last-child')?.outerHTML || "").slice(0, 300),
        text: (document.getElementById("message-list")?.textContent || "").slice(0, 400)
      }))()`));
    }
    assert.equal(appeared, 1, "the in-progress row must appear while the run is live");

    // The snapshot that follows about a second later, carrying the user's own
    // message back as finished. The run has NOT ended.
    await postEnvelope([userEchoFromSnapshot]);
    await new Promise((r) => setTimeout(r, 6000));
    assert.equal(
      await runningRows(),
      1,
      "the user's own message coming back as done must not delete the in-progress row"
    );

    // The agent finishing still ends the run.
    await postEnvelope([agentAnswer]);
    let cleared = 1;
    for (let i = 0; i < 20 && cleared !== 0; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      cleared = await runningRows();
    }
    assert.equal(cleared, 0, "the agent's finished answer must still clear the in-progress row");

    // W-M: the same run, watched as a stream. Sent as a fresh run so the row is
    // live again, then opened by tapping it exactly as a reader would.
    const streamRunId = "mobile-stream-evt";
    const partial = (text, createdAt) => ({
      id: `${streamRunId}:@drew`,
      messageId: `${streamRunId}:@drew`,
      role: "participant",
      participantLabel: "@drew",
      content: text,
      status: "pending",
      createdAt,
      runId: streamRunId,
      mobileEventId: "stream-evt"
    });
    await postEnvelope([partial("Half of a sen", new Date(Date.UTC(2026, 0, 1, 1, 0)).toISOString())]);
    let streamable = 0;
    for (let i = 0; i < 20 && streamable === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      streamable = await evaluate(`(() => document.querySelectorAll('#message-list .message-row[data-streamable="1"]').length)()`);
    }
    assert.equal(streamable, 1, "a live agent row can be opened");

    await evaluate(`(() => {
      document.querySelector('#message-list .message-row[data-streamable="1"]').click();
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 500));
    const opened = await evaluate(`(() => {
      const view = document.getElementById("stream-view");
      return JSON.stringify({ hidden: view.hidden, text: (document.getElementById("stream-body").textContent || "").trim(), state: (document.getElementById("stream-state").textContent || "").trim() });
    })()`);
    const openedState = JSON.parse(opened);
    assert.equal(openedState.hidden, false, "tapping the live row opens the stream");
    assert.equal(openedState.text, "Half of a sen", "opening mid-run shows everything accumulated so far");

    // It grows as the reply grows.
    await postEnvelope([partial("Half of a sentence, then the rest.", new Date(Date.UTC(2026, 0, 1, 1, 1)).toISOString())]);
    let grown = "";
    for (let i = 0; i < 20 && !grown.endsWith("the rest."); i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      grown = await evaluate(`(() => (document.getElementById("stream-body").textContent || "").trim())()`);
    }
    assert.equal(grown, "Half of a sentence, then the rest.", "the stream follows the reply as it is written");

    // And when the run finishes the view stays, showing the finished answer.
    await postEnvelope([{
      ...partial("Half of a sentence, then the rest. Done.", new Date(Date.UTC(2026, 0, 1, 1, 2)).toISOString()),
      status: "done"
    }]);
    let finished = "";
    for (let i = 0; i < 20 && !finished.includes("Done"); i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      finished = await evaluate(`(() => JSON.stringify({ hidden: document.getElementById("stream-view").hidden, text: (document.getElementById("stream-body").textContent || "").trim(), state: (document.getElementById("stream-state").textContent || "").trim() }))()`);
    }
    const finishedState = JSON.parse(finished);
    assert.equal(finishedState.hidden, false, "the view stays after the run finishes");
    assert.match(finishedState.text, /Done\.$/, "it shows the finished answer");
    assert.equal(finishedState.state, "Done", "and says the run is done rather than still writing");
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    killStaleCdp();
    site.close();
    mailboxServer.close();
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
});
