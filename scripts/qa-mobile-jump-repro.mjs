// Reproduces the phone-only "timeline bounces up and down every couple of
// seconds" report. The desktop publishes each progress tick and the final
// snapshot as separate durable mailbox envelopes; the mailbox retains all of
// them, and the PWA re-ingests the whole history on every 2.5s poll. Each
// replayed pending envelope re-inserts a "running" row (render), and the
// replayed final snapshot deletes it again (render) — so the list grows and
// shrinks once per poll cycle. Desktop Chrome hides most of it with scroll
// anchoring; iOS Safari has none, which is why it only shows on the phone.
// A MutationObserver counts row insert/remove churn, which anchoring cannot
// hide, so the same script fails on the broken build and passes on the fix.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { attach } = require("./cdp.cjs");
const { createReferenceMailboxServer } = require("./mailbox-reference-server.cjs");
// W-E: serve the shell under the policy the CDN applies, not a laxer one.
const { loadMobileOriginHeaders, mobileOriginHeadersForPath } = require("./mobile-origin-headers.cjs");

const repoRoot = path.resolve(import.meta.dirname, "..");
const root = path.join(repoRoot, "dist/mobile");
const SITE_PORT = 8141;
const MAILBOX_PORT = 8142;
const CDP_PORT = 9339;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CONVERSATION = "conv-jump-qa";
const RUN_ID = "run-jump-1";

// The harness speaks the locked mailbox contract exactly like the desktop:
// scope id and bearer token are HMAC derivations from the pairing seal key,
// the mailbox is registered before any traffic, and every payload travels
// sealed. The phone side derives the same values from the seeded pairing.
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

const proxyCounts = { eventReads: 0 };
let decoyHits = 0;
const DECOY_PORT = 8143;
const decoy = createServer((req, res) => {
  decoyHits += 1;
  res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify({ events: [] }));
});
await new Promise((r) => decoy.listen(DECOY_PORT, "127.0.0.1", r));

const originHeaders = loadMobileOriginHeaders(root);
const site = createServer(async (req, res) => {
  const url = req.url || "/";
  if (url.startsWith("/v1/mailbox/events") && req.method === "GET") {
    proxyCounts.eventReads += 1;
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
await new Promise((r) => site.listen(SITE_PORT, "127.0.0.1", r));

const mailbox = createReferenceMailboxServer({ locked: true });
const mailboxServer = mailbox.server ?? mailbox;
await new Promise((r) => mailboxServer.listen(MAILBOX_PORT, "127.0.0.1", r));

const registerMailbox = async () => {
  const res = await fetch(`http://127.0.0.1:${MAILBOX_PORT}/v1/mailbox/register?mailboxId=${MAILBOX_ID}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${MAILBOX_TOKEN}`
    },
    body: JSON.stringify({
      tokenHashBase64Url: createHash("sha256").update(MAILBOX_TOKEN, "utf8").digest("base64url")
    })
  });
  if (!res.ok) {
    throw new Error(`mailbox registration failed: ${await res.text()}`);
  }
};

let seq = 0;
const postEnvelope = async (events) => {
  seq += 1;
  const res = await fetch(`http://127.0.0.1:${MAILBOX_PORT}/v1/mailbox/events?mailboxId=${MAILBOX_ID}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${MAILBOX_TOKEN}`
    },
    body: JSON.stringify({
      events: [{
        eventId: `jump-envelope-${seq}`,
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
  if (!res.ok || ack.appendedEventIds.length !== 1) {
    throw new Error(`mailbox did not append the envelope: ${JSON.stringify(ack)}`);
  }
};

const doneMessage = (i) => ({
  id: `m${String(i).padStart(3, "0")}`,
  role: i % 2 ? "participant" : "you",
  participantLabel: "Drew",
  content: `Message number ${i}, long enough to wrap onto more than one line on a phone screen.`,
  status: "done",
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
  messageId: `m${String(i).padStart(3, "0")}`
});

// The exact publication sequence of one desktop run, retained by the mailbox:
// a base snapshot, three progress ticks (pending, same id, growing content),
// then the terminal snapshot that includes the finished message.
const base = Array.from({ length: 30 }, (_, i) => doneMessage(i));
const progressTick = (n) => ({
  id: `${RUN_ID}:@drew`,
  role: "participant",
  participantLabel: "@drew",
  content: "@drew is running" + ".".repeat(n + 1),
  status: "pending",
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 50, n)).toISOString(),
  runId: RUN_ID
});
const finalMessage = {
  ...doneMessage(31),
  id: "m031",
  messageId: "m031",
  role: "participant",
  participantLabel: "@drew",
  content: "Here is the finished answer from the run, long enough to wrap onto a second line.",
  runId: RUN_ID,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 55)).toISOString()
};

try {
  const stale = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((r) => r.ok).catch(() => false);
  if (stale) {
    const { execSync } = await import("node:child_process");
    execSync(`lsof -ti tcp:${CDP_PORT} -sTCP:LISTEN | xargs kill -9`, { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 1000));
  }
} catch {
  // nothing listening
}

const profile = await mkdtemp(path.join(tmpdir(), "aa-mobile-jump-"));
const chrome = spawn(CHROME, [
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  "--window-size=430,860", `http://127.0.0.1:${SITE_PORT}/`
], { stdio: "ignore" });

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

try {
  await registerMailbox();
  await postEnvelope(base);
  for (let n = 0; n < 3; n += 1) {
    await postEnvelope([progressTick(n)]);
  }
  await postEnvelope([...base.slice(-10), finalMessage]);

  let app;
  for (let i = 0; i < 40; i += 1) {
    try {
      app = await attach({ port: CDP_PORT, title: "AccordAgents" });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!app) throw new Error("could not attach to Chrome");
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
      { id: "${CONVERSATION}", title: "Jump QA", group: "AccordAgents", snippet: "QA", updatedAt: new Date(0).toISOString(), participants: [] }
    ]));
    localStorage.setItem("accordagents.mobile.activeConversationId.v1", "${CONVERSATION}");
    return true;
  })()`);
  // Wait for the service worker to finish activating, then reload NORMALLY so
  // the page runs under SW control — the state every real installed PWA is in.
  // (A hard reload loads the page uncontrolled and would hide SW bugs; that
  // race is exactly why this harness used to pass or fail depending on
  // machine load.)
  await evaluate(`navigator.serviceWorker.ready.then(() => true)`);
  await app.send("Page.reload", {});
  await new Promise((r) => setTimeout(r, 6000));

  const controlled = await evaluate(`(() => Boolean(navigator.serviceWorker.controller))()`);
  check("page is service-worker controlled like a real install", controlled === true);

  // W-E leg 1: the fifteen behavioural checks below only mean something if the
  // page is actually running under the shipped policy. Prove the policy is
  // present and is the deployed one, then probe the two connect-src forms the
  // app depends on — a cross-origin https fetch and a wss socket — because a
  // policy that quietly forbids either would break the phone while every
  // behavioural check here still passed.
  const servedPolicy = (await fetch(`http://127.0.0.1:${SITE_PORT}/index.html`))
    .headers.get("content-security-policy") ?? "";
  const shippedPolicy = mobileOriginHeadersForPath(originHeaders, "/index.html")["Content-Security-Policy"] ?? "";
  check("the page is served under the deployed Content-Security-Policy",
    servedPolicy.length > 0 && servedPolicy === shippedPolicy,
    servedPolicy.slice(0, 80) || "no policy served");
  check("the policy forbids inline script and foreign script origins",
    /script-src 'self'/.test(servedPolicy) && !/unsafe-inline/.test(servedPolicy),
    servedPolicy);

  const connectProbe = await evaluate(`(async () => {
    const out = { https: "", wss: "" };
    try {
      await fetch("https://fcm.googleapis.com/accord-csp-probe", { mode: "no-cors" });
      out.https = "allowed";
    } catch (error) {
      out.https = String(error && error.message || error);
    }
    out.wss = await new Promise((resolve) => {
      let socket;
      try {
        socket = new WebSocket("wss://relay.accordagents.com/v1/relay?rid=csp-probe");
      } catch (error) {
        resolve("blocked: " + String(error && error.message || error));
        return;
      }
      const done = (value) => { try { socket.close(); } catch {} resolve(value); };
      socket.addEventListener("open", () => done("allowed"));
      // A refused connection is fine — CSP blocking shows up as a construction
      // or security error, not as a failed handshake.
      socket.addEventListener("error", () => done("allowed (not blocked by policy)"));
      setTimeout(() => done("timeout"), 5000);
    });
    return JSON.stringify(out);
  })()`);
  const probes = JSON.parse(connectProbe);
  check("connect-src permits an https request to a relay host", probes.https === "allowed", connectProbe);
  check("connect-src permits a wss socket", probes.wss.startsWith("allowed"), connectProbe);
  const settled = await evaluate(`(() => {
    const list = document.getElementById("message-list");
    return list ? list.childElementCount : -1;
  })()`);
  check("timeline rendered after pairing", settled > 25, `${settled} rows`);

  // Record every row insertion/removal and the list height for 9 seconds
  // (3+ poll cycles) while the user does nothing at all.
  await evaluate(`(() => {
    const list = document.getElementById("message-list");
    globalThis.__jumpLog = { added: 0, removed: 0, heights: [], rowCounts: [] };
    globalThis.__jumpObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        globalThis.__jumpLog.added += m.addedNodes.length;
        globalThis.__jumpLog.removed += m.removedNodes.length;
      }
    });
    globalThis.__jumpObserver.observe(list, { childList: true });
    globalThis.__jumpTimer = setInterval(() => {
      globalThis.__jumpLog.heights.push(Math.round(list.getBoundingClientRect().height));
      globalThis.__jumpLog.rowCounts.push(list.childElementCount);
    }, 100);
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 9000));
  const log = await evaluate(`(() => {
    clearInterval(globalThis.__jumpTimer);
    globalThis.__jumpObserver.disconnect();
    const l = globalThis.__jumpLog;
    return JSON.stringify({
      added: l.added,
      removed: l.removed,
      rowCounts: [...new Set(l.rowCounts)],
      minHeight: Math.min(...l.heights),
      maxHeight: Math.max(...l.heights)
    });
  })()`);
  const parsed = JSON.parse(log);
  console.log("observed:", log);
  check("no rows are inserted or removed while idle",
    parsed.added === 0 && parsed.removed === 0,
    `${parsed.added} inserted, ${parsed.removed} removed over 9s`);
  check("row count never oscillates while idle",
    parsed.rowCounts.length === 1, `row counts seen: ${JSON.stringify(parsed.rowCounts)}`);
  check("list height never oscillates while idle",
    parsed.maxHeight - parsed.minHeight === 0,
    `height varied ${parsed.minHeight} -> ${parsed.maxHeight}`);

  // The finished run's placeholder must not survive anywhere in the list.
  const placeholders = await evaluate(`(() =>
    [...document.querySelectorAll("#message-list .message-row")]
      .filter((row) => (row.textContent || "").includes("is running")).length
  )()`);
  check("no stale 'is running' placeholder for a finished run", placeholders === 0,
    `${placeholders} placeholder rows`);

  // A genuinely new message must still arrive and paint (regression guard for
  // the earlier "messages never appeared" fix).
  const rowsBefore = await evaluate(`(() => document.getElementById("message-list").childElementCount)()`);
  await postEnvelope([{
    ...doneMessage(40),
    id: "m040", messageId: "m040",
    content: "A brand new message that should still arrive and paint.",
    createdAt: new Date(Date.UTC(2026, 0, 1, 1, 0)).toISOString()
  }]);
  // Sample instead of a fixed sleep so a slow machine reports latency rather
  // than a false failure, and a genuine stall (e.g. a cached poll response)
  // still fails after the full window.
  let rowsAfter = rowsBefore;
  let arrivalMs = -1;
  for (let t = 0; t < 24 && arrivalMs === -1; t += 1) {
    await new Promise((r) => setTimeout(r, 500));
    rowsAfter = await evaluate(`(() => document.getElementById("message-list").childElementCount)()`);
    if (rowsAfter > rowsBefore) {
      arrivalMs = (t + 1) * 500;
    }
  }
  check("a genuinely new message still arrives while idle", rowsAfter === rowsBefore + 1,
    `rows ${rowsBefore} -> ${rowsAfter}${arrivalMs > 0 ? ` after ~${arrivalMs}ms` : " (never arrived in 12s)"}`);

  // W3 acceptance: once the run's terminal snapshot is durable, the desktop
  // deletes its superseded pending-progress envelopes; the mailbox must no
  // longer serve them, and the phone must stay exactly as it is.
  const deleteRes = await fetch(`http://127.0.0.1:${MAILBOX_PORT}/v1/mailbox/delete?mailboxId=${MAILBOX_ID}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${MAILBOX_TOKEN}` },
    body: JSON.stringify({ eventIds: ["jump-envelope-2", "jump-envelope-3", "jump-envelope-4"] })
  });
  const deleteAck = await deleteRes.json();
  check("owner delete removes the superseded progress envelopes", deleteRes.ok &&
    JSON.stringify(deleteAck.deletedEventIds) === JSON.stringify(["jump-envelope-2", "jump-envelope-3", "jump-envelope-4"]),
    JSON.stringify(deleteAck.deletedEventIds));
  const listing = await (await fetch(`http://127.0.0.1:${MAILBOX_PORT}/v1/mailbox/events?mailboxId=${MAILBOX_ID}&afterArrival=0`, {
    headers: { authorization: `Bearer ${MAILBOX_TOKEN}` }
  })).json();
  const remainingIds = listing.events.map((event) => event.eventId);
  check("progress envelopes are gone after the terminal snapshot",
    !remainingIds.some((id) => ["jump-envelope-2", "jump-envelope-3", "jump-envelope-4"].includes(id)),
    `remaining: ${JSON.stringify(remainingIds)}`);
  await new Promise((r) => setTimeout(r, 3000));
  const rowsAfterDelete = await evaluate(`(() => document.getElementById("message-list").childElementCount)()`);
  check("deletion changes nothing on the phone", rowsAfterDelete === rowsAfter,
    `rows ${rowsAfter} -> ${rowsAfterDelete}`);

  // W5 acceptance, behavioral half: after pairing and credential mirroring,
  // no SW-reachable store may contain the seal key. localStorage is page-only
  // (the platform denies it to service workers), so the key living there is
  // the design, not a violation.
  const storageSweep = await evaluate(`(async () => {
    const findings = [];
    const db = await new Promise((resolve, reject) => {
      const open = indexedDB.open("accordagents-mobile-control");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    for (const storeName of [...db.objectStoreNames]) {
      const rows = await new Promise((resolve, reject) => {
        const request = db.transaction(storeName).objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const serialized = JSON.stringify(rows);
      if (serialized.includes(${JSON.stringify(SEAL_KEY)})) {
        findings.push(storeName);
      }
    }
    db.close();
    for (const cacheName of await caches.keys()) {
      const cache = await caches.open(cacheName);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        const text = await response.text().catch(() => "");
        if (text.includes(${JSON.stringify(SEAL_KEY)})) {
          findings.push("cache:" + cacheName);
        }
      }
    }
    const meta = await new Promise((resolve) => {
      const open = indexedDB.open("accordagents-mobile-control");
      open.onsuccess = () => {
        const tx = open.result.transaction("meta").objectStore("meta").get("mailboxAccess");
        tx.onsuccess = () => { resolve(tx.result); open.result.close(); };
        tx.onerror = () => { resolve(undefined); open.result.close(); };
      };
      open.onerror = () => resolve(undefined);
    });
    return JSON.stringify({ findings, mirrored: Boolean(meta && meta.token && meta.endpointUrl && meta.mailboxId) });
  })()`);
  const sweep = JSON.parse(storageSweep);
  check("credentials are mirrored for the background worker", sweep.mirrored === true, storageSweep);
  check("no SW-reachable store contains the seal key", sweep.findings.length === 0,
    `stores containing key: ${JSON.stringify(sweep.findings)}`);

  // W5 acceptance, payload isolation: a push-like wake naming a different
  // endpoint must produce a fetch to the stored endpoint and no request to
  // the payload-supplied one.
  const readsBefore = proxyCounts.eventReads;
  const decoyBefore = decoyHits;
  const pushResult = await evaluate(`(async () => {
    const registration = await navigator.serviceWorker.ready;
    const done = new Promise((resolve) => {
      const listener = (event) => {
        if (event.data && event.data.type === "accord-test-push-done") {
          navigator.serviceWorker.removeEventListener("message", listener);
          resolve(event.data.result);
        }
      };
      navigator.serviceWorker.addEventListener("message", listener);
      setTimeout(() => resolve({ synced: false, reason: "timeout" }), 8000);
    });
    registration.active.postMessage({
      type: "accord-test-push",
      endpoint: "http://127.0.0.1:${DECOY_PORT}/v1/mailbox/events",
      mailboxId: "mb-evil"
    });
    return JSON.stringify(await done);
  })()`);
  const pushOutcome = JSON.parse(pushResult);
  check("push-woken sync fetches and succeeds", pushOutcome.synced === true, pushResult);
  check("push-woken sync used the stored endpoint", proxyCounts.eventReads > readsBefore,
    `event reads ${readsBefore} -> ${proxyCounts.eventReads}`);
  check("payload-supplied endpoint received no request", decoyHits === decoyBefore,
    `decoy hits ${decoyBefore} -> ${decoyHits}`);

  app.close();
} catch (error) {
  console.error("QA HARNESS ERROR:", error?.message || error);
  results.push({ name: "harness completed", pass: false });
} finally {
  chrome.kill("SIGKILL");
  try {
    const { execSync } = await import("node:child_process");
    execSync(`lsof -ti tcp:${CDP_PORT} -sTCP:LISTEN | xargs kill -9`, { stdio: "ignore" });
  } catch {
    // already gone
  }
  site.close();
  decoy.close();
  mailboxServer.close();
  await rm(profile, { recursive: true, force: true }).catch(() => undefined);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
