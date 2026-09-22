/**
 * Two messages sent one after the other while the first is still going out,
 * in the real PWA.
 *
 * The composer sends on the button's pointerup as well as on the form's
 * submit, and a flag made the two paths one send. It was held for the whole
 * send, network included: the second message typed while the first was still
 * being handed over on a slow connection was dropped on the floor, with
 * nothing on screen to say so (the field kept the text, the tap did nothing).
 * And a message queued while a flush was already in flight waited for the
 * retry tick half a minute later, because the flush in flight had read the
 * queue before it was written.
 *
 * This holds the mailbox's answer for a while, sends twice inside that wait,
 * and expects both messages queued and both handed over promptly. Desktop
 * Chrome, not the installed phone.
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
const SITE_PORT = 8275;
const CDP_PORT = 9425;
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CHAT = "chat-send";
// How long the mailbox holds each append: long enough to send again inside it.
const APPEND_HOLD_MS = 2_000;

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const originHeaders = loadMobileOriginHeaders(root);
/** Every event the phone appended, in the order the mailbox answered them. */
const appended = [];
const site = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname === "/v1/mailbox/events" && req.method === "POST") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const ids = (body.events || []).map((event) => event.eventId);
    await new Promise((r) => setTimeout(r, APPEND_HOLD_MS));
    appended.push(...ids);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, eventIds: ids, appendedEventIds: ids }));
    return;
  }
  if (url.pathname === "/v1/mailbox/events") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ events: [], epoch: "e1", oldestArrivalSeq: 1, maxArrivalSeq: 0 }));
    return;
  }
  if (url.pathname.startsWith("/v1/")) {
    res.writeHead(404, { "content-type": "application/json" });
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

test("a message sent while the previous one is still going out is queued and handed over", { timeout: 120_000 }, async (t) => {
  await new Promise((r) => site.listen(SITE_PORT, "127.0.0.1", r));
  killStaleCdp();
  const profile = await mkdtemp(path.join(tmpdir(), "aa-mobile-composer-send-"));
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
  const waitFor = async (read, accept, what, timeoutMs = 10_000) => {
    const end = Date.now() + timeoutMs;
    let last;
    while (Date.now() < end) {
      last = await read();
      if (accept(last)) return last;
      await sleep(100);
    }
    assert.fail(`${what}: last saw ${JSON.stringify(last)}`);
  };
  try {
    await attachWithRetry();
    // A mailbox-only pairing: no relay, so every send goes over plain HTTPS
    // to the mailbox this test holds.
    await evaluate(`(() => {
      localStorage.setItem("accordagents.mobile.pairing.v1", JSON.stringify({ endpoint: "http://127.0.0.1:${SITE_PORT}/", pairedAt: new Date(0).toISOString() }));
      localStorage.setItem("accordagents.mobile.chatList.v1", JSON.stringify([
        { id: ${JSON.stringify(CHAT)}, title: "Send", group: "AccordAgents", snippet: "…", updatedAt: new Date(0).toISOString(), participants: ["@drew"] }
      ]));
      localStorage.setItem("accordagents.mobile.activeConversationId.v1", ${JSON.stringify(CHAT)});
      return true;
    })()`);
    await evaluate("location.reload()");
    await sleep(1500);
    await attachWithRetry();
    await waitFor(
      () => evaluate(`Boolean(globalThis.AccordAgentsMobile && document.getElementById("composer-input") && document.getElementById("composer-form"))`),
      (ready) => ready === true,
      "the chat came up with its composer"
    );

    const send = (text) => evaluate(`(() => {
      const input = document.getElementById("composer-input");
      input.value = ${JSON.stringify(text)};
      document.getElementById("composer-form").dispatchEvent(new Event("submit", { cancelable: true }));
      return true;
    })()`);
    const queued = () => evaluate(`AccordAgentsMobile.listOutboxEntries().then((entries) => entries
      .filter((entry) => !entry.kind || entry.kind === "message.created")
      .map((entry) => entry.payload.content + ":" + entry.status).sort())`);

    await send("first");
    await waitFor(queued, (rows) => rows.length === 1, "the first message is queued");
    // Inside the mailbox's hold on the first: the second is typed and sent.
    await sleep(400);
    await send("second");
    assert.equal(await evaluate(`document.getElementById("composer-input").value`), "", "the second message left the field");
    await waitFor(queued, (rows) => rows.length === 2, "the second message is queued while the first is still going out");
    // Both handed over: the second right behind the first, not on the retry
    // tick half a minute later.
    await waitFor(queued, (rows) => rows.every((row) => row.endsWith(":acked")), "both messages are handed over", APPEND_HOLD_MS * 3);
    assert.deepEqual(appended.map((id) => String(id).length > 0), [true, true], "the mailbox received both");
    t.diagnostic(`appended: ${appended.length}, queue: ${JSON.stringify(await queued())}`);
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    await new Promise((resolve) => site.close(resolve));
    await rm(profile, { recursive: true, force: true });
  }
});
