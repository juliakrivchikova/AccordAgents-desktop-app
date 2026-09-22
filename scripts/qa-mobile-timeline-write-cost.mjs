/**
 * How much one delivered batch costs the phone once its timeline store holds
 * a few weeks of rows.
 *
 * Every `mobile.timeline.events` batch is applied row by row inside
 * IndexedDB, and the dedupe rule needs the rows it can collide with. This
 * measures that write path against a store seeded like the User's: a hundred
 * chats with their last page each, then one batch of forty new rows and one
 * terminal for a pending row, timed from the page itself. Run it before and
 * after a change to the write path to see what the change bought.
 *
 * Usage: npm run build:mobile && node scripts/qa-mobile-timeline-write-cost.mjs [rowsPerChat] [chats]
 */
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
const SITE_PORT = 8251;
const CDP_PORT = 9401;
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROWS_PER_CHAT = Number(process.argv[2] || 80);
const CHATS = Number(process.argv[3] || 100);

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
try { execSync(`lsof -ti tcp:${CDP_PORT} -sTCP:LISTEN | xargs kill -9`, { stdio: "ignore" }); } catch { /* nothing listening */ }

await new Promise((r) => site.listen(SITE_PORT, "127.0.0.1", r));
const profile = await mkdtemp(path.join(tmpdir(), "aa-mobile-writecost-"));
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
  if (!app) throw new Error("could not attach to Chrome");
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
    localStorage.setItem("accordagents.mobile.chatList.v1", JSON.stringify(Array.from({ length: ${CHATS} }, (_, i) => ({
      id: "chat-" + i, title: "Chat " + i, group: "AccordAgents", snippet: "…", updatedAt: new Date(0).toISOString(), participants: ["@drew"]
    }))));
    localStorage.setItem("accordagents.mobile.activeConversationId.v1", "chat-0");
    return true;
  })()`);
  await evaluate("location.reload()");
  await sleep(1500);
  await attachWithRetry();
  for (let i = 0; i < 60 && !(await evaluate("Boolean(globalThis.AccordAgentsMobile)")); i += 1) await sleep(500);

  // Seed straight into the store: this measures the write path, not the seed.
  const seeded = await evaluate(`(async () => {
    const db = await self.AccordMobileDb.openControlDb(indexedDB);
    const tx = db.transaction("timeline", "readwrite");
    const store = tx.objectStore("timeline");
    const base = Date.now() - 20 * 24 * 3600 * 1000;
    let count = 0;
    for (let c = 0; c < ${CHATS}; c += 1) {
      for (let r = 0; r < ${ROWS_PER_CHAT}; r += 1) {
        const id = "seed-" + c + "-" + r;
        store.put({
          id: "chat-" + c + ":" + id, sourceId: id, messageId: id, conversationId: "chat-" + c,
          role: r % 2 ? "participant" : "you", participantLabel: r % 2 ? "@drew" : undefined,
          content: "Seeded message " + r + " " + "x".repeat(300), status: "done",
          createdAt: new Date(base + (c * ${ROWS_PER_CHAT} + r) * 60000).toISOString(),
          runId: r % 2 ? "run-" + c + "-" + r : undefined, receivedAt: new Date(base).toISOString()
        });
        count += 1;
      }
    }
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    db.close();
    return count;
  })()`);
  console.log(`seeded ${seeded} rows across ${CHATS} chats`);

  const batch = (tag, count) => `Array.from({ length: ${count} }, (_, i) => ({
    id: "${tag}-" + i, messageId: "${tag}-" + i, role: i % 2 ? "participant" : "you", participantLabel: i % 2 ? "@drew" : undefined,
    content: "Fresh message ${tag} " + i, status: "done", runId: i % 2 ? "run-${tag}-" + i : undefined,
    createdAt: new Date(Date.now() - (${count} - i) * 1000).toISOString()
  }))`;
  const results = [];
  for (let round = 0; round < 3; round += 1) {
    const ms = await evaluate(`(async () => {
      const started = performance.now();
      await globalThis.AccordAgentsMobile.handleRelayTimelinePayload({ type: "mobile.timeline.events", conversationId: "chat-0", events: ${batch("fresh" + round, 40)} }, undefined, { deferRender: true });
      return Math.round(performance.now() - started);
    })()`);
    results.push(ms);
    console.log(`round ${round + 1}: one 40-row batch applied in ${ms} ms`);
  }
  const terminal = await evaluate(`(async () => {
    await globalThis.AccordAgentsMobile.handleRelayTimelinePayload({ type: "mobile.timeline.events", conversationId: "chat-0", events: [{
      id: "live-1", role: "participant", participantLabel: "@drew", content: "@drew is running...", status: "pending", runId: "run-live-1", createdAt: new Date().toISOString()
    }] }, undefined, { deferRender: true });
    const started = performance.now();
    await globalThis.AccordAgentsMobile.handleRelayTimelinePayload({ type: "mobile.timeline.events", conversationId: "chat-0", events: [{
      id: "live-1", messageId: "live-1", role: "participant", participantLabel: "@drew", content: "Done now.", status: "done", runId: "run-live-1", createdAt: new Date().toISOString()
    }] }, undefined, { deferRender: true });
    return Math.round(performance.now() - started);
  })()`);
  console.log(`one terminal (pending -> done) applied in ${terminal} ms`);
  const render = await evaluate(`(async () => {
    const started = performance.now();
    await globalThis.AccordAgentsMobile.listTimelineEntries("chat-0");
    return Math.round(performance.now() - started);
  })()`);
  console.log(`one read of the open chat's rows: ${render} ms`);
  console.log(JSON.stringify({ rows: seeded, batch40Ms: results, terminalMs: terminal, readMs: render }));
} finally {
  app?.close();
  chrome.kill("SIGKILL");
  await new Promise((resolve) => site.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
