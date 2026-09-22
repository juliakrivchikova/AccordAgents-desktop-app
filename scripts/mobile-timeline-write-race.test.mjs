/**
 * A run's end and its last live row arriving at the same moment, in the real
 * PWA.
 *
 * While a member writes, the live socket delivers the growing row; when the
 * run ends, the desktop's saved snapshot brings the finished answer through
 * the mailbox. The two channels are independent, so the finished answer can
 * land while the last live row is still being written. The end of a run
 * deletes that run's live rows, and it did, while every write read the chat
 * back inside its own transaction: IndexedDB runs those one after another,
 * so the deletion always saw the row in front of it. The rows now held in
 * memory for a chat (so a streaming member does not cost a full read per
 * delivered row) were taken the moment a write was created, before the write
 * in front of it had landed -- the deletion judged against a chat that did
 * not yet hold the live row, kept it, and "Thinking…" stayed above the answer
 * it belonged to.
 *
 * This drives the two deliveries through the app's own ingest path, together,
 * and expects the finished answer alone. Desktop Chrome, not the installed
 * phone.
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
const SITE_PORT = 8271;
const CDP_PORT = 9421;
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CHAT = "chat-race";
const ROUNDS = 8;

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const originHeaders = loadMobileOriginHeaders(root);
const site = createServer(async (req, res) => {
  const rel = (req.url || "/").split("?")[0];
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

test("a run's end removes its live row even when the two land together", { timeout: 120_000 }, async (t) => {
  await new Promise((r) => site.listen(SITE_PORT, "127.0.0.1", r));
  killStaleCdp();
  const profile = await mkdtemp(path.join(tmpdir(), "aa-mobile-write-race-"));
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
      localStorage.setItem("accordagents.mobile.pairing.v1", JSON.stringify({ endpoint: "http://127.0.0.1:${SITE_PORT}/", pairedAt: new Date(0).toISOString() }));
      localStorage.setItem("accordagents.mobile.chatList.v1", JSON.stringify([
        { id: ${JSON.stringify(CHAT)}, title: "Race", group: "AccordAgents", snippet: "…", updatedAt: new Date(0).toISOString(), participants: ["@drew"] }
      ]));
      return true;
    })()`);
    await evaluate("location.reload()");
    await sleep(1500);
    await attachWithRetry();
    let ready = false;
    for (let i = 0; i < 60 && !ready; i += 1) {
      ready = await evaluate("Boolean(globalThis.AccordAgentsMobile)");
      if (!ready) await sleep(500);
    }
    assert.ok(ready, "the app came up");

    // One earlier row, delivered and settled, so the chat is one the app
    // already holds rows for: the case an open, busy chat is always in.
    const seeded = await evaluate(`globalThis.AccordAgentsMobile.handleRelayTimelinePayload({
      type: "mobile.timeline.events", conversationId: ${JSON.stringify(CHAT)},
      events: [{ id: "seed", messageId: "seed", role: "participant", participantLabel: "@drew", content: "Earlier", status: "done",
        createdAt: new Date(Date.now() - 60000).toISOString(), runId: "run-seed" }]
    }, undefined, { deferRender: true })`);
    assert.ok(seeded >= 1, "the seed row was stored");

    // Each round: the run's last live row (the socket) and its finished
    // answer (the mailbox snapshot) are ingested at the same time. The live
    // row is stamped a moment after the answer, as a delta that left the
    // desktop after the snapshot did, so nothing but the deletion can end it.
    const rounds = await evaluate(`(async () => {
      const api = globalThis.AccordAgentsMobile;
      const rounds = [];
      for (let round = 0; round < ${ROUNDS}; round += 1) {
        const messageId = "m" + round;
        const runId = "run-" + round;
        const finishedAt = Date.now();
        const batch = (event) => ({ type: "mobile.timeline.events", conversationId: ${JSON.stringify(CHAT)}, events: [event] });
        const live = batch({ id: runId + ":@drew", messageId, role: "participant", participantLabel: "@drew",
          content: "Writing the answer for round " + round, status: "pending", createdAt: new Date(finishedAt + 5).toISOString(), runId });
        const finished = batch({ id: messageId, messageId, role: "participant", participantLabel: "@drew",
          content: "Answer " + round, status: "done", createdAt: new Date(finishedAt).toISOString(), runId });
        await Promise.all([
          api.handleRelayTimelinePayload(live, undefined, { deferRender: true, live: true }),
          api.handleRelayTimelinePayload(finished, undefined, { deferRender: true })
        ]);
        const rows = await api.listTimelineEntries(${JSON.stringify(CHAT)});
        rounds.push(rows.filter((row) => row.messageId === messageId).map((row) => row.status).sort().join("+"));
      }
      return rounds;
    })()`);
    t.diagnostic(`rows per round: ${rounds.join(", ")}`);
    assert.deepEqual(rounds, Array.from({ length: ROUNDS }, () => "done"), "each round ends with the finished answer alone");
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    await new Promise((resolve) => site.close(resolve));
    await rm(profile, { recursive: true, force: true });
  }
});
