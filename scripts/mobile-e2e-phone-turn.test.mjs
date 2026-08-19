// End-to-end: a turn that STARTS on the phone, from send to cleared row.
//
// The existing live harness proves an in-progress row appears, holds and
// streams. It never proves the row goes away, and it never starts the turn from
// the phone — it drives desktop-originated progress only. That is the exact gap
// User's screenshot fell into: she sent "Йоу" from the phone, the answer
// arrived, and a "Thinking" row stayed above it forever.
//
// The one detail every earlier test got wrong is the run id. A participant
// answering a phone-sent message does NOT run under the ingest run
// (`mobile-<eventId>`) — chat.ts fans out with a fresh run id and only carries
// the mobile event id along inside agentProgress. Every unit test here echoed
// `request.runId` back as the progress run id, so the placeholder and the
// answer always shared a key and always reconciled. Real runs never do.
//
// Nothing between the two ends is faked: the events come out of
// MobileRelayControlService, travel a real relay socket and a real mailbox, and
// land in a real browser running the built PWA, which sends by typing into its
// own composer.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn, execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { attach, getJson } = require("./cdp.cjs");
const { createReferenceMailboxServer } = require("./mailbox-reference-server.cjs");
const { createReferenceRelayServer } = require("./relay-reference-server.cjs");
const { loadMobileOriginHeaders, mobileOriginHeadersForPath } = require("./mobile-origin-headers.cjs");

const repoRoot = path.resolve(import.meta.dirname, "..");
const root = path.join(repoRoot, "dist/mobile");
const SITE_PORT = 8291;
const MAILBOX_PORT = 8292;
const CDP_PORT = 9352;
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CONVERSATION = "conv-turn";
const RENDEZVOUS = "rv-turn";

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(label, predicate, { timeoutMs = 25_000, stepMs = 400, detail } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await predicate();
    if (last) {
      return last;
    }
    if (Date.now() > deadline) {
      // Read at the timeout, not at call time: a label built by interpolating
      // the dump up front reports the state before the wait, which is exactly
      // the state that was fine.
      const extra = detail ? await detail() : "";
      throw new Error(`timeout waiting for ${label}${extra ? `: ${extra}` : ""}`);
    }
    await sleep(stepMs);
  }
}

/** The desktop's projection of a stored conversation, byte-for-byte the shape
 *  mobileRelayChatCatalog builds in main.ts. */
function projectTimeline(conversation) {
  return conversation.messages
    .filter((message) => message.content.trim())
    .map((message) => {
      const explicit = message.metadata?.mobileEventId;
      const sourceMessageId = message.metadata?.sourceMessageId;
      const runId = message.metadata?.runId;
      const mobileEventId = typeof explicit === "string" && explicit.trim()
        ? explicit.trim()
        : (typeof sourceMessageId === "string" && typeof runId === "string" && runId === `mobile-${sourceMessageId}`
          ? sourceMessageId
          : undefined);
      return {
        id: message.id,
        role: message.role === "user" ? "you" : message.role === "participant" ? "participant" : "system",
        ...(message.participantLabel ? { participantLabel: message.participantLabel } : {}),
        content: message.content,
        status: message.status === "error" ? "error" : message.status === "pending" ? "pending" : "done",
        createdAt: message.createdAt,
        ...(typeof runId === "string" ? { runId } : {}),
        messageId: message.id,
        ...(mobileEventId ? { mobileEventId } : {})
      };
    });
}

test("live end-to-end: a phone-sent turn clears its own in-progress row", async (t) => {
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
      // production and wrong for a loopback relay. Its own harness covers it.
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

  let originSeq = 0;
  const timelineSink = {
    async publishTimeline(timeline) {
      originSeq += 1;
      await fetch(`http://127.0.0.1:${MAILBOX_PORT}/v1/mailbox/events?mailboxId=${MAILBOX_ID}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${MAILBOX_TOKEN}` },
        body: JSON.stringify({
          events: [{
            eventId: `turn-${originSeq}`,
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

  const conversation = {
    id: CONVERSATION,
    kind: "chat",
    title: "Turn",
    createdAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    messages: [],
    findings: [],
    metadata: {}
  };

  // The real fan-out: the answer runs under its OWN run id and carries the
  // source's mobile event id along, exactly as createAgentProgressSink does.
  let turnSeq = 0;
  const holdUntilReleased = { current: undefined };
  // S6 drives two participants off one phone message and releases them one at
  // a time, so the harness can watch what the first finish does to the second.
  const fanoutGates = { current: undefined };
  const multiStepGates = { current: undefined };
  // main.ts sends EVERY progress event down two paths: the per-run callback the
  // control service passed in, and the constructor-level fan-out that reaches
  // noteExternalChatProgress. Only the second one publishes live text for a
  // fan-out run, because handleChatProgress queues anything whose run id was
  // not acked — and a fan-out run id never is. A harness that wires only the
  // callback shows no live rows at all.
  const controlRef = { current: undefined };
  const chat = {
    async sendMessage(request, _signal, progress) {
      const emit = (event) => {
        progress?.(event);
        controlRef.current?.noteExternalChatProgress(event);
      };
      // ChatService queues a snapshot every time it mutates the conversation,
      // and main.ts hands each one to pushConversationSnapshot. That is how a
      // phone-started turn's answer actually reaches the phone: a per-agent
      // finish is not published live, so without snapshots nothing lands until
      // the whole sendMessage call returns.
      const publishSnapshot = () => {
        conversation.updatedAt = new Date().toISOString();
        controlRef.current?.pushConversationSnapshot(conversation);
      };
      turnSeq += 1;
      const seq = turnSeq;
      const labels = Array.from(request.content.matchAll(/@[A-Za-z0-9._-]+/g)).map((match) => match[0]);
      if (labels.length > 1 && fanoutGates.current) {
        const gates = fanoutGates.current;
        fanoutGates.current = undefined;
        conversation.messages.push({
          id: `msg-user-${seq}`,
          role: "user",
          content: request.content,
          status: "done",
          createdAt: new Date().toISOString(),
          metadata: { runId: request.runId, mobileEventId: request.mobileEventId }
        });
        for (const label of labels) {
          emit({
            runId: `run-${label.slice(1)}-${seq}`,
            phase: "debate",
            message: `${label} is responding.`,
            createdAt: new Date().toISOString(),
            agentProgress: {
              participantId: `participant-${label.slice(1)}`,
              participantLabel: label,
              state: "running",
              messageId: `msg-${label.slice(1)}-${seq}`,
              activity: "Thinking",
              partialContent: `${label} is typing something`,
              mobileEventId: request.mobileEventId
            }
          });
        }
        for (const label of labels) {
          await gates[label];
          const content = `Reply from ${label}.`;
          conversation.messages.push({
            id: `msg-${label.slice(1)}-${seq}`,
            role: "participant",
            participantLabel: label,
            content,
            status: "done",
            createdAt: new Date().toISOString(),
            metadata: { runId: `run-${label.slice(1)}-${seq}`, sourceMessageId: `msg-user-${seq}` }
          });
          publishSnapshot();
          emit({
            runId: `run-${label.slice(1)}-${seq}`,
            phase: "debate",
            message: `${label} finished.`,
            createdAt: new Date().toISOString(),
            agentProgress: {
              participantId: `participant-${label.slice(1)}`,
              participantLabel: label,
              state: "finished",
              messageId: `msg-${label.slice(1)}-${seq}`,
              partialContent: content,
              mobileEventId: request.mobileEventId
            }
          });
        }
        return { conversation, warnings: [] };
      }
      const label = labels[0] ?? "@taylor";
      const silent = request.content.includes("no progress yet");
      const multiStep = request.content.includes("multi step");
      const userMessageId = `msg-user-${seq}`;
      const answerId = `msg-answer-${seq}`;
      const fanoutRunId = `run-fanout-${seq}`;
      const tag = request.content.match(/#([a-z0-9-]+)/)?.[1];
      const answer = tag ? `Answer for #${tag}.` : `Answer number ${seq}.`;
      conversation.messages.push({
        id: userMessageId,
        role: "user",
        content: request.content,
        status: "done",
        createdAt: new Date().toISOString(),
        metadata: { runId: request.runId, mobileEventId: request.mobileEventId }
      });
      publishSnapshot();
      const announceRunning = () => emit({
        runId: fanoutRunId,
        phase: "debate",
        message: `${label} is responding.`,
        createdAt: new Date().toISOString(),
        agentProgress: {
          participantId: "participant-taylor",
          participantLabel: label,
          state: "running",
          messageId: answerId,
          activity: "Thinking",
          partialContent: answer.slice(0, 8),
          mobileEventId: request.mobileEventId
        }
      });
      if (!silent) {
        announceRunning();
      }
      if (multiStep) {
        const gates = multiStepGates.current ?? {};
        multiStepGates.current = undefined;
        await gates.beforeInterim;
        // app_chat_send_message posts immediately and the run carries on: a
        // finished message and a live row belong to the same turn.
        conversation.messages.push({
          id: `msg-interim-${seq}`,
          role: "participant",
          participantLabel: label,
          // Long on purpose: a short row lands inside the "near the bottom"
          // slack, so a stand built from one-liners cannot tell following from
          // standing still. A real answer is many lines tall.
          content: `Interim note ${seq}.\n\n${Array.from({ length: 24 }, (_, line) => `Line ${line + 1} of the note, long enough to push the end of the conversation well out of sight.`).join("\n\n")}`,
          status: "done",
          createdAt: new Date().toISOString(),
          metadata: { runId: fanoutRunId, sourceMessageId: userMessageId }
        });
        publishSnapshot();
        emit({
          runId: fanoutRunId,
          phase: "debate",
          message: `${label} is responding.`,
          createdAt: new Date().toISOString(),
          agentProgress: {
            participantId: "participant-taylor",
            participantLabel: label,
            state: "running",
            messageId: answerId,
            activity: "Thinking",
            partialContent: answer.slice(0, 8),
            mobileEventId: request.mobileEventId
          }
        });
        await gates.beforeFinish;
      }
      if (holdUntilReleased.current) {
        await holdUntilReleased.current;
        holdUntilReleased.current = undefined;
      } else {
        await sleep(request.content.includes("#slow") ? 6000 : 1200);
      }
      if (request.content.includes("#fail")) {
        // What a real run does when it dies: no terminal of its own, so the
        // control service's catch is the only thing that says the run is over.
        throw new Error("The run could not be completed.");
      }
      conversation.messages.push({
        id: answerId,
        role: "participant",
        participantLabel: label,
        content: answer,
        status: "done",
        createdAt: new Date().toISOString(),
        metadata: { runId: fanoutRunId, sourceMessageId: userMessageId }
      });
      publishSnapshot();
      emit({
        runId: fanoutRunId,
        phase: "debate",
        message: `${label} finished.`,
        createdAt: new Date().toISOString(),
        agentProgress: {
          participantId: "participant-taylor",
          participantLabel: label,
          state: "finished",
          messageId: answerId,
          partialContent: answer,
          mobileEventId: request.mobileEventId
        }
      });
      return { conversation, warnings: [] };
    }
  };

  const catalog = {
    async listChats() {
      return [{
        id: CONVERSATION,
        title: "Turn",
        group: "AccordAgents",
        snippet: "turn",
        updatedAt: conversation.updatedAt,
        running: false,
        participants: ["@taylor"]
      }];
    },
    async listTimeline() {
      return projectTimeline(conversation);
    },
    async isConversationAllowed(id) {
      return id === CONVERSATION;
    }
  };

  const control = new MobileRelayControlService(
    {
      relayUrl: relayAddress.url,
      rendezvousId: RENDEZVOUS,
      relayCapability: "PAIRING-FINGERPRINT",
      relaySealKeyBase64: SEAL_KEY,
      conversationId: CONVERSATION,
      streamId: "route-turn:phone",
      reconnectDelayMs: 50
    },
    chat,
    catalog,
    undefined,
    timelineSink
  );

  controlRef.current = control;

  killStaleCdp();
  const profile = await mkdtemp(path.join(tmpdir(), "aa-turn-"));
  const chrome = spawn(CHROME, [
    "--headless=new", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    "--window-size=430,860", `http://127.0.0.1:${SITE_PORT}/?qa=1`
  ], { stdio: "ignore" });

  let app;
  let relayClosed = false;
  try {
    await control.connect();
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
        await sleep(500);
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
        routingId: "route-turn",
        streamId: "route-turn:phone",
        conversationId: "${CONVERSATION}",
        relaySealKeyBase64: "${SEAL_KEY}",
        pairedAt: new Date(0).toISOString()
      }));
      localStorage.setItem("accordagents.mobile.chatList.v1", JSON.stringify([
        { id: "${CONVERSATION}", title: "Turn", group: "AccordAgents", snippet: "turn", updatedAt: new Date(0).toISOString(), participants: [] }
      ]));
      localStorage.setItem("accordagents.mobile.activeConversationId.v1", "${CONVERSATION}");
      return true;
    })()`);
    await evaluate(`navigator.serviceWorker.ready.then(() => true)`);
    await app.send("Page.reload", {});
    await sleep(6000);

    const runningRows = () => evaluate(
      `(() => document.querySelectorAll('#message-list .message-row[data-status="Running"]').length)()`
    );
    const rowDump = () => evaluate(
      `(() => JSON.stringify(Array.from(document.querySelectorAll("#message-list .message-row")).map((row) => ({
        key: row.dataset.rowKey,
        status: row.dataset.status,
        text: (row.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 60)
      }))))()`
    );
    const bodyHas = (text) => evaluate(
      `(() => (document.getElementById("message-list")?.textContent || "").includes(${JSON.stringify(text)}))()`
    );
    const sendFromPhone = (text) => evaluate(`(() => {
      const input = document.getElementById("composer-input");
      const form = document.getElementById("composer-form");
      input.value = ${JSON.stringify(text)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit", { cancelable: true }));
      return true;
    })()`);

    await until("the phone reaches a live relay", async () =>
      await evaluate(`(() => (document.getElementById("connection-state")?.textContent || "").trim())()`) !== "Waiting to sync"
    ).catch(() => undefined);

    // ---- S1: a plain phone-sent turn, no @mention. The exact shape of the
    // message in User's screenshot.
    await sendFromPhone("Йоу");
    await until("the in-progress row appears for the phone-sent turn", async () => await runningRows() > 0);
    await until("the answer arrives", async () => await bodyHas("Answer number 1."));
    await until(
      `S1: the in-progress row clears when the answer lands (rows: ${await rowDump()})`,
      async () => await runningRows() === 0,
      { timeoutMs: 20_000 }
    );
    t.diagnostic(`S1 rows after finish: ${await rowDump()}`);

    // ---- S2: the same turn with an @mention, which takes the other branch of
    // the placeholder builder (labelled "@x is running..." instead of "Running...").
    await sendFromPhone("@taylor second one");
    await until("the mention turn shows an in-progress row", async () => await runningRows() > 0);
    await until("the second answer arrives", async () => await bodyHas("Answer number 2."));
    await until(
      `S2: the mention turn clears its in-progress row (rows: ${await rowDump()})`,
      async () => await runningRows() === 0,
      { timeoutMs: 20_000 }
    );

    // ---- S3: the app is killed mid-answer and relaunched. The row must reach
    // the answer after recovery instead of hanging in "Thinking".
    let release;
    holdUntilReleased.current = new Promise((resolve) => { release = resolve; });
    await sendFromPhone("third one");
    await until("the third turn shows an in-progress row", async () => await runningRows() > 0);
    await app.send("Page.reload", {});
    await sleep(5000);
    release();
    await until("the third answer arrives after relaunch", async () => await bodyHas("Answer number 3."), { timeoutMs: 30_000 });
    await until(
      `S3: a run interrupted by a relaunch still clears its row (rows: ${await rowDump()})`,
      async () => await runningRows() === 0,
      { timeoutMs: 20_000 }
    );

    // ---- S4: nothing accumulated across the three turns, and every answer is
    // still there exactly once.
    const dump = JSON.parse(await rowDump());
    assert.equal(
      dump.filter((row) => row.status === "Running").length,
      0,
      `S4: no in-progress rows survive three finished turns: ${JSON.stringify(dump)}`
    );
    for (const seq of [1, 2, 3]) {
      assert.equal(
        dump.filter((row) => row.text.includes(`Answer number ${seq}.`)).length,
        1,
        `S4: answer ${seq} appears exactly once: ${JSON.stringify(dump)}`
      );
    }

    // ---- S8: a long turn that posts a finished intermediate message and keeps
    // working. User watched one and saw TWO rows for one turn: an anonymous
    // "Thinking" and a second row carrying the real text. The desktop publishes
    // its placeholder at accept time and the participant's own live row arrives
    // separately, so both sat there at once. A turn is one live row, whatever
    // scaffolding was needed to open it.
    let releaseInterim;
    let releaseFinish;
    multiStepGates.current = {
      beforeInterim: new Promise((resolve) => { releaseInterim = resolve; }),
      beforeFinish: new Promise((resolve) => { releaseFinish = resolve; })
    };
    await sendFromPhone("multi step please");
    await until("the live row carries real text", async () => await evaluate(
      `(() => [...document.querySelectorAll('#message-list .message-row[data-status="Running"]')]
        .some((row) => (row.querySelector(".message-content")?.textContent || "").trim().length > 0))()`
    ));
    await sleep(2500); // give any second row every chance to show up
    assert.equal(
      await runningRows(),
      1,
      `S8: a running turn shows exactly one live row, not scaffolding beside it: ${await rowDump()}`
    );
    releaseInterim();
    try {
      await until("the intermediate message arrives", async () => await bodyHas("Interim note 4."));
    } catch (error) {
      t.diagnostic(`interim never rendered; rows: ${await rowDump()}`);
      t.diagnostic(`store: ${await evaluate(`(async () => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open("accordagents-mobile-control");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const entries = await new Promise((resolve, reject) => {
          const request = db.transaction("timeline", "readonly").objectStore("timeline").getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        db.close();
        return JSON.stringify(entries.slice(-6).map((entry) => ({
          id: entry.id, status: entry.status, content: (entry.content || "").slice(0, 30)
        })));
      })()`)}`);
      throw error;
    }
    await sleep(2000);
    assert.equal(
      await runningRows(),
      1,
      `S8: posting an intermediate message leaves one live row: ${await rowDump()}`
    );
    releaseFinish();
    await until("the multi-step answer arrives", async () => await bodyHas("Answer number 4."), { timeoutMs: 30_000 });
    await until(
      `S8: the multi-step turn clears its live row (rows: ${await rowDump()})`,
      async () => await runningRows() === 0,
      { timeoutMs: 20_000 }
    );
    const multiDump = JSON.parse(await rowDump());
    for (const text of ["Interim note 4.", "Answer number 4."]) {
      assert.equal(
        multiDump.filter((row) => row.text.includes(text)).length,
        1,
        `S8: "${text}" appears exactly once: ${JSON.stringify(multiDump)}`
      );
    }

    // ---- S7: while nobody has been picked yet, the row must not borrow an
    // identity. The desktop publishes its placeholder at accept time and can
    // only guess a handle from an explicit @mention, so a mentionless send used
    // to show "Agent" with a letter avatar and then swap to the real member
    // mid-run. Nothing else is on screen in this leg: the run emits no progress
    // until released, so the placeholder is the only row that can be judged.
    let releaseSilent;
    holdUntilReleased.current = new Promise((resolve) => { releaseSilent = resolve; });
    await sendFromPhone("no progress yet please");
    await until("the unnamed placeholder appears", async () => await runningRows() > 0);
    const placeholder = JSON.parse(await evaluate(`(() => {
      const row = document.querySelector('#message-list .message-row[data-status="Running"]');
      return JSON.stringify({
        scaffolding: row.dataset.scaffolding,
        dots: row.querySelectorAll(".message-typing span").length,
        handle: (row.querySelector(".message-handle")?.textContent || ""),
        avatar: row.querySelector(".message-avatar") ? "present" : "absent",
        clock: row.querySelector(".thinking-elapsed") ? "present" : "absent",
        text: (row.textContent || "").trim(),
        streamable: row.dataset.streamable || ""
      });
    })()`));
    assert.equal(placeholder.scaffolding, "1", `S7: the pre-member row is scaffolding, not a message: ${JSON.stringify(placeholder)}`);
    assert.equal(placeholder.dots, 3, `S7: it shows the small pulsing indication: ${JSON.stringify(placeholder)}`);
    assert.equal(placeholder.handle, "", `S7: it names nobody: ${JSON.stringify(placeholder)}`);
    assert.equal(placeholder.avatar, "absent", `S7: it carries no avatar: ${JSON.stringify(placeholder)}`);
    assert.equal(placeholder.clock, "absent", `S7: the clock belongs to a real member: ${JSON.stringify(placeholder)}`);
    assert.equal(placeholder.text, "", `S7: it says no words at all: ${JSON.stringify(placeholder)}`);
    assert.equal(placeholder.streamable, "", `S7: there is nothing to open on it: ${JSON.stringify(placeholder)}`);
    if (process.env.ACCORD_E2E_SHOT) {
      await evaluate(`(() => {
        const row = document.querySelector('#message-list .message-row[data-scaffolding="1"]');
        if (row) { row.scrollIntoView({ block: "center" }); }
        return true;
      })()`);
      await sleep(600);
      const shot = await app.send("Page.captureScreenshot", { format: "png" });
      await writeFile(process.env.ACCORD_E2E_SHOT, Buffer.from(shot.data, "base64"));
    }
    releaseSilent();
    await until("the answer to the silent turn arrives", async () => await bodyHas("Answer number 5."));
    await until(
      `S7: the unnamed row clears (rows: ${await rowDump()})`,
      async () => await runningRows() === 0,
      { timeoutMs: 20_000 }
    );
    const named = JSON.parse(await evaluate(`(() => JSON.stringify(Array.from(document.querySelectorAll("#message-list .message-row"))
      .map((row) => (row.querySelector(".message-handle")?.textContent || ""))
      .filter(Boolean)))()`));
    assert.ok(!named.includes("Agent"), `S7: no row is left showing the placeholder identity: ${JSON.stringify(named)}`);

    // ---- S9: the view follows a turn it is watching, and never yanks a
    // reader who left the end. Sending already scrolled, but the indication and
    // the answer arrive AFTER that scroll, so they used to land below the fold.
    const surfaceState = () => evaluate(`(() => {
      const surface = document.querySelector("#timeline-screen .thread-surface");
      const composer = document.getElementById("composer-form");
      const slack = 80 + (composer ? composer.getBoundingClientRect().height : 0);
      return JSON.stringify({
        atBottom: surface.scrollHeight - surface.scrollTop - surface.clientHeight <= slack,
        scrollTop: Math.round(surface.scrollTop),
        pill: document.getElementById("jump-to-latest")?.classList.contains("is-visible") === true
      });
    })()`);
    const rowInView = (selector) => evaluate(`(() => {
      const row = document.querySelector(${JSON.stringify(selector)});
      if (!row) { return false; }
      const box = row.getBoundingClientRect();
      const composer = document.getElementById("composer-form").getBoundingClientRect();
      return box.top >= 0 && box.bottom <= composer.top + 1;
    })()`);

    let releaseInterim9;
    let releaseFinish9;
    multiStepGates.current = {
      beforeInterim: new Promise((resolve) => { releaseInterim9 = resolve; }),
      beforeFinish: new Promise((resolve) => { releaseFinish9 = resolve; })
    };
    t.diagnostic(`S9 surface before send: ${await evaluate(`(() => {
      const surface = document.querySelector("#timeline-screen .thread-surface");
      return JSON.stringify({ scrollHeight: surface.scrollHeight, clientHeight: surface.clientHeight, scrollTop: Math.round(surface.scrollTop) });
    })()`)}`);
    await sendFromPhone("multi step again, no progress yet");
    // (a) The indication comes into sight on its own.
    await until("the indication is on screen without touching the view", async () => await rowInView('#message-list .message-row[data-scaffolding="1"]'));
    // (b) So does the intermediate message.
    releaseInterim9();
    await until("the intermediate message arrives", async () => await bodyHas("Interim note 6."));
    await sleep(1200);
    assert.equal(
      JSON.parse(await surfaceState()).atBottom,
      true,
      `S9: a reader at the end stays at the end as rows arrive: ${await surfaceState()}`
    );
    // (c) Now leave the end deliberately. Nothing may drag the view back.
    await evaluate(`(() => { document.querySelector("#timeline-screen .thread-surface").scrollTop = 0; return true; })()`);
    await sleep(600);
    const parked = JSON.parse(await surfaceState());
    assert.equal(parked.atBottom, false, "S9 precondition: the reader is in history");
    releaseFinish9();
    await until("the answer to the scrolled-away turn arrives", async () => await bodyHas("Answer number 6."), { timeoutMs: 30_000 });
    await sleep(1500);
    const afterAnswer = JSON.parse(await surfaceState());
    assert.equal(
      afterAnswer.atBottom,
      false,
      `S9: a reader who left the end is not yanked back by an arriving answer: ${JSON.stringify(afterAnswer)}`
    );
    assert.equal(
      afterAnswer.scrollTop,
      parked.scrollTop,
      `S9: the view does not move at all: ${JSON.stringify({ parked, afterAnswer })}`
    );
    assert.equal(afterAnswer.pill, true, `S9: the way back is offered instead: ${JSON.stringify(afterAnswer)}`);
    // Taking the offer returns to the end.
    await evaluate(`(() => { document.getElementById("jump-to-latest").click(); return true; })()`);
    await sleep(1200);
    assert.equal(JSON.parse(await surfaceState()).atBottom, true, "S9: the pill returns the reader to the end");
    await until("the scrolled-away turn still clears its row", async () => await runningRows() === 0, { timeoutMs: 20_000 });

    // ---- S10: two turns overlap. User double-texts, so two phone messages can
    // be in flight with interleaved terminals — exactly where deletes scoped by
    // message or mobile event id could cross-clear each other's rows.
    await sendFromPhone("first of two #slow");
    await sleep(500);
    await sendFromPhone("second of two #quick");
    await until("the quick turn finishes", async () => await bodyHas("Answer for #quick."), { timeoutMs: 30_000 });
    await sleep(1500);
    assert.equal(
      await runningRows(),
      1,
      `S10: finishing one turn leaves the other still running: ${await rowDump()}`
    );
    await until("the slow turn finishes", async () => await bodyHas("Answer for #slow."), { timeoutMs: 40_000 });
    await until(
      "S10: both overlapping turns clear their rows",
      async () => await runningRows() === 0,
      { timeoutMs: 20_000, detail: rowDump }
    );
    const overlapped = JSON.parse(await rowDump());
    for (const text of ["Answer for #slow.", "Answer for #quick."]) {
      assert.equal(
        overlapped.filter((row) => row.text.includes(text)).length,
        1,
        `S10: "${text}" survives the overlap exactly once: ${JSON.stringify(overlapped)}`
      );
    }

    // ---- S11: a run that dies. Its only terminal is the one the control
    // service writes from its catch, and it must still retire the scaffolding
    // and end the row rather than leaving "Thinking" over a dead run.
    await sendFromPhone("this one #fail");
    await until("the failure is stated on the timeline", async () => await bodyHas("The run could not be completed."), { timeoutMs: 30_000 });
    await until(
      "S11: a failed run clears its in-progress row",
      async () => await runningRows() === 0,
      { timeoutMs: 20_000, detail: rowDump }
    );
    const failed = JSON.parse(await rowDump());
    assert.equal(
      failed.filter((row) => row.status === "Error" && row.text.includes("The run could not be completed.")).length,
      1,
      `S11: the failure reads as an error, once: ${JSON.stringify(failed)}`
    );
    assert.equal(
      await evaluate(`(() => document.querySelectorAll('#message-list .message-row[data-scaffolding="1"]').length)()`),
      0,
      "S11: a failed run takes its indication with it"
    );

    // ---- S6: two participants answer ONE phone message, so both live rows and
    // the placeholder share a mobile event id. The first finish must clear the
    // placeholder and leave the other agent still writing. Getting this wrong in
    // the other direction is the "Thinking flashes and vanishes" regression.
    let releaseDrew;
    let releaseTaylor;
    fanoutGates.current = {
      "@drew": new Promise((resolve) => { releaseDrew = resolve; }),
      "@taylor": new Promise((resolve) => { releaseTaylor = resolve; })
    };
    await sendFromPhone("@drew @taylor both of you");
    await until("both participants show an in-progress row", async () => await runningRows() >= 2);
    releaseDrew();
    await until("the first participant's answer arrives", async () => await bodyHas("Reply from @drew."));
    await sleep(2500); // let every reconciliation pass settle before judging
    const midFanout = JSON.parse(await rowDump());
    const stillWriting = midFanout.filter((row) => row.status === "Running");
    assert.equal(
      stillWriting.length,
      1,
      `S6: one finish leaves exactly the other agent writing: ${JSON.stringify(midFanout)}`
    );
    assert.ok(
      stillWriting[0].text.includes("@taylor"),
      `S6: the surviving in-progress row is the unfinished agent's: ${JSON.stringify(midFanout)}`
    );
    releaseTaylor();
    await until("the second participant's answer arrives", async () => await bodyHas("Reply from @taylor."));
    await until(
      `S6: the last finish clears the last row (rows: ${await rowDump()})`,
      async () => await runningRows() === 0,
      { timeoutMs: 20_000 }
    );

    const storeDump = await evaluate(`(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("accordagents-mobile-control");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const entries = await new Promise((resolve, reject) => {
        const request = db.transaction("timeline", "readonly").objectStore("timeline").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return JSON.stringify(entries.filter((entry) => (entry.participantLabel || "") === "@drew").map((entry) => ({
        id: entry.id, status: entry.status, runId: entry.runId,
        mobileEventId: entry.mobileEventId, messageId: entry.messageId,
        content: (entry.content || "").slice(0, 40)
      })));
    })()`);
    t.diagnostic(`@drew entries in the phone store: ${storeDump}`);
    const fanoutDump = JSON.parse(await rowDump());
    for (const label of ["@drew", "@taylor"]) {
      assert.equal(
        fanoutDump.filter((row) => row.text.includes(`Reply from ${label}.`)).length,
        1,
        `S6: ${label}'s answer appears exactly once: ${JSON.stringify(fanoutDump)}`
      );
    }

    // ---- S5: tapping does not open a previous answer. With no stale row left
    // to tap, the stream view must stay closed rather than resurrect history.
    await evaluate(`(() => {
      const row = document.querySelector('#message-list .message-row[data-streamable="1"]');
      if (row) { row.click(); }
      return true;
    })()`);
    await sleep(600);
    const streamOpen = await evaluate(`(() => document.getElementById("stream-view")?.hidden === false)()`);
    assert.equal(streamOpen, false, "S5: no finished row advertises itself as a live stream to follow");

    // ---- S12: the relay dies mid-turn. On a real phone the socket is dead
    // most of the time — iOS backgrounds the app — and the turn has to resolve
    // through the mailbox alone. Live frames never reach the mailbox, so the
    // rows are populated differently: scaffolding is the only pending row until
    // the terminal lands. Every scenario above ran with a live socket, so this
    // path had no coverage at all.
    let releaseOffline;
    holdUntilReleased.current = new Promise((resolve) => { releaseOffline = resolve; });
    await sendFromPhone("offline finish #mailbox");
    await until("the turn is under way", async () => await runningRows() > 0);
    // Closed once, and the teardown must not close it again: a second close on
    // an already-closed reference never settles, which hangs the whole run long
    // after the test itself has finished.
    await relay.close();
    relayClosed = true;
    await until(
      "the phone notices the relay is gone",
      async () => await evaluate(`(() => !(window.AccordAgentsMobile?.relaySocketLive?.() ?? false))()`) !== false,
      { timeoutMs: 15_000 }
    ).catch(() => undefined);
    releaseOffline();
    await until(
      "the answer arrives with no relay at all",
      async () => await bodyHas("Answer for #mailbox."),
      { timeoutMs: 45_000, detail: rowDump }
    );
    await until(
      "S12: a turn that finished with no live socket still clears its row",
      async () => await runningRows() === 0,
      { timeoutMs: 25_000, detail: rowDump }
    );
    assert.equal(
      await evaluate(`(() => document.querySelectorAll('#message-list .message-row[data-scaffolding="1"]').length)()`),
      0,
      "S12: the indication goes with it"
    );

    t.diagnostic(`all twelve scenarios green; final rows: ${await rowDump()}`);
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    killStaleCdp();
    control.close();
    if (!relayClosed) {
      await relay.close();
    }
    site.close();
    mailboxServer.close();
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
});
