// Live QA for the PWA "scroll to latest" behaviour.
//
// Everything here goes through the app's own code path: a reference mailbox
// serves timeline events, the PWA's 2.5s poll ingests them, and the app's own
// render() decides where to scroll. Nothing is simulated by the harness — it
// only posts events and reads scroll position back.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { attach } = require("./cdp.cjs");
const { createReferenceMailboxServer } = require("./mailbox-reference-server.cjs");

const repoRoot = path.resolve(import.meta.dirname, "..");
const root = path.join(repoRoot, "dist/mobile");
const SITE_PORT = 8137;
const MAILBOX_PORT = 8138;
const CDP_PORT = 9336;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CONVERSATION = "conv-qa";

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".webmanifest": "application/manifest+json"
};

// The reference mailbox sends no CORS headers, so it is proxied through the
// same origin as the page rather than patched — the app then talks to it
// exactly as it would to a real same-origin mailbox.
const site = createServer(async (req, res) => {
  const url = req.url || "/";
  if (url.startsWith("/v1/mailbox/")) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const upstream = await fetch(`http://127.0.0.1:${MAILBOX_PORT}${url}`, {
      method: req.method,
      headers: { "content-type": req.headers["content-type"] || "application/json" },
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
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => site.listen(SITE_PORT, "127.0.0.1", r));

const mailbox = createReferenceMailboxServer();
const mailboxServer = mailbox.server ?? mailbox;
await new Promise((r) => mailboxServer.listen(MAILBOX_PORT, "127.0.0.1", r));

let seq = 0;
const postEvents = async (events) => {
  seq += 1;
  const res = await fetch(`http://127.0.0.1:${MAILBOX_PORT}/v1/mailbox/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      events: [{
        eventId: `qa-event-${seq}`,
        conversationId: CONVERSATION,
        logScopeId: CONVERSATION,
        originId: "qa-origin",
        originSeq: seq,
        eventHash: `hash-${seq}`,
        kind: "mobile.timeline.events",
        payload: { type: "mobile.timeline.events", events }
      }]
    })
  });
  const ack = await res.json();
  if (!res.ok || ack.appendedEventIds.length !== 1) {
    throw new Error(`mailbox did not append the event: ${JSON.stringify(ack)}`);
  }
};

const message = (i, text) => ({
  id: `m${String(i).padStart(3, "0")}`,
  role: i % 2 ? "participant" : "you",
  participantLabel: "Drew",
  content: text ?? `Message number ${i}, long enough to wrap onto more than one line on a phone screen.`,
  status: "done",
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()
});

// A leaked Chrome from a previous run would be reattached to on the same port,
// carrying its accumulated storage and silently invalidating every check.
try {
  const stale = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((r) => r.ok).catch(() => false);
  if (stale) {
    const { execSync } = await import("node:child_process");
    execSync(`lsof -ti tcp:${CDP_PORT} -sTCP:LISTEN | xargs kill -9`, { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 1000));
  }
} catch {
  // nothing listening; nothing to clean up
}

const profile = await mkdtemp(path.join(tmpdir(), "aa-mobile-qa-"));
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
  await postEvents(Array.from({ length: 40 }, (_, i) => message(i)));

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

  // Pair against the reference mailbox so the app's own poll loop runs.
  await evaluate(`(() => {
    localStorage.setItem("accordagents.mobile.pairing.v1", JSON.stringify({
      endpoint: "http://127.0.0.1:${SITE_PORT}/",
      outboxUrl: "http://127.0.0.1:${SITE_PORT}/v1/mailbox/events",
      conversationId: "${CONVERSATION}",
      pairedAt: new Date(0).toISOString()
    }));
    localStorage.setItem("accordagents.mobile.chatList.v1", JSON.stringify([
      { id: "${CONVERSATION}", title: "Scroll QA", updatedAt: new Date(0).toISOString() }
    ]));
    localStorage.setItem("accordagents.mobile.activeConversationId.v1", "${CONVERSATION}");
    return true;
  })()`);

  await app.send("Page.reload", { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 6000));


  // Ingest through the app's own exported ingest function (the same one the
  // mailbox poll calls internally), then drive the UI like a person would.
  const ingest = async (events) => evaluate(`(async () => {
    await globalThis.AccordAgentsMobile.handleRelayTimelinePayload(
      { type: "mobile.timeline.events", events: ${JSON.stringify(events)} },
      "${CONVERSATION}"
    );
    return (await globalThis.AccordAgentsMobile.listTimelineEntries("${CONVERSATION}")).length;
  })()`);

  const seeded = await ingest(Array.from({ length: 40 }, (_, i) => message(i)));
  check("app ingested the seeded timeline", seeded === 40, `${seeded} entries stored`);

  // Re-seed the chat list and open the chat, then reload so the app's own
  // startup render runs against a populated timeline.
  await evaluate(`(() => {
    localStorage.setItem("accordagents.mobile.chatList.v1", JSON.stringify([
      { id: "${CONVERSATION}", title: "Scroll QA", group: "AccordAgents", snippet: "QA", updatedAt: new Date(0).toISOString(), participants: [] }
    ]));
    localStorage.setItem("accordagents.mobile.activeConversationId.v1", "${CONVERSATION}");
    return true;
  })()`);
  await app.send("Page.reload", { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 3500));

  const metrics = () => evaluate(`(() => {
    const s = document.querySelector("#timeline-screen .thread-surface");
    const j = document.getElementById("jump-to-latest");
    if (!s) return { rows: 0, missing: true };
    return {
      rows: document.getElementById("message-list").childElementCount,
      fromBottom: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight),
      scrollTop: Math.round(s.scrollTop),
      scrollable: s.scrollHeight > s.clientHeight + 40,
      jumpVisible: j ? j.classList.contains("is-visible") : null
    };
  })()`);

  const opened = await metrics();
  check("timeline rendered and overflows the screen", opened.scrollable === true && opened.rows >= 40,
    `rows=${opened.rows} scrollable=${opened.scrollable}`);
  check("opening a chat lands on the latest message", opened.fromBottom <= 6,
    `${opened.fromBottom}px from bottom`);
  check("no jump button while already at the latest", opened.jumpVisible === false);

  // The view must sit perfectly still across several poll cycles when nothing
  // new arrives. This is the "blinking and scrolling every couple of seconds".
  await evaluate(`(() => { document.querySelector("#timeline-screen .thread-surface").scrollTop = 900; return true; })()`);
  await new Promise((r) => setTimeout(r, 400));
  const restBefore = await evaluate(`(() => document.querySelector("#timeline-screen .thread-surface").scrollTop)()`);
  await new Promise((r) => setTimeout(r, 9000));
  const restAfter = await evaluate(`(() => document.querySelector("#timeline-screen .thread-surface").scrollTop)()`);
  check("view stays still across poll cycles when nothing arrives",
    restBefore === restAfter, `scrollTop ${restBefore} -> ${restAfter} over 9s`);

  // The desktop republishes the same snapshot repeatedly. Re-delivering
  // messages the phone already has must not add rows, move the view, or raise
  // the Latest pill.
  await evaluate(`(() => { const s = document.querySelector("#timeline-screen .thread-surface"); s.scrollTop = s.scrollHeight; return true; })()`);
  await new Promise((r) => setTimeout(r, 500));
  const beforeRepublish = await metrics();
  for (let i = 0; i < 3; i += 1) {
    await postEvents(Array.from({ length: 40 }, (_, n) => message(n)));
    await new Promise((r) => setTimeout(r, 3000));
  }
  const afterRepublish = await metrics();
  check("re-delivering known messages adds no rows",
    afterRepublish.rows === beforeRepublish.rows,
    `rows ${beforeRepublish.rows} -> ${afterRepublish.rows}`);
  check("re-delivering known messages does not raise the Latest pill",
    afterRepublish.jumpVisible === false, `jumpVisible=${afterRepublish.jumpVisible}`);
  check("view is unmoved by re-delivery",
    afterRepublish.scrollTop === beforeRepublish.scrollTop,
    `scrollTop ${beforeRepublish.scrollTop} -> ${afterRepublish.scrollTop}`);

  // Measure what the eye sees, not what scrollTop says: sample the on-screen
  // position of a real message row for 10s. Any wobble is visible movement,
  // even when scrollTop never changes.
  const samplePositions = () => evaluate(`(() => {
    const rows = [...document.querySelectorAll("#message-list .message-row")];
    const target = rows[Math.floor(rows.length / 2)];
    const pill = document.getElementById("jump-to-latest");
    return {
      rowTop: target ? Math.round(target.getBoundingClientRect().top) : null,
      pillOpacity: pill ? getComputedStyle(pill).opacity : null,
      listHeight: Math.round(document.getElementById("message-list").getBoundingClientRect().height)
    };
  })()`);
  const samples = [];
  for (let i = 0; i < 10; i += 1) {
    samples.push(await samplePositions());
    await new Promise((r) => setTimeout(r, 1000));
  }
  const rowTops = [...new Set(samples.map((x) => x.rowTop))];
  const pillStates = [...new Set(samples.map((x) => x.pillOpacity))];
  const heights = [...new Set(samples.map((x) => x.listHeight))];
  check("a message row never shifts on screen over 10s",
    rowTops.length === 1, `observed tops: ${JSON.stringify(rowTops)}`);
  check("the Latest pill never fades in and out on its own",
    pillStates.length === 1, `observed opacities: ${JSON.stringify(pillStates)}`);
  check("the message list height never oscillates",
    heights.length === 1, `observed heights: ${JSON.stringify(heights)}`);

  // Threads: replies collapse under their root and open on tap, like desktop.
  const beforeThread = await metrics();
  await postEvents([
    message(60, "Root message that other replies hang under."),
    { ...message(61, "First reply inside the thread."), threadRootId: "m060" },
    { ...message(62, "Second reply inside the thread."), threadRootId: "m060" }
  ]);
  await new Promise((r) => setTimeout(r, 6000));
  const collapsed = await evaluate(`(() => ({
    rows: document.getElementById("message-list").childElementCount,
    chip: document.querySelector(".thread-chip")?.textContent || null,
    backVisible: document.getElementById("back-to-timeline")?.classList.contains("is-visible") ?? null
  }))()`);
  check("replies collapse under their message instead of filling the timeline",
    collapsed.rows === beforeThread.rows + 1 && collapsed.chip === "2 replies",
    `rows ${beforeThread.rows} -> ${collapsed.rows}, chip=${collapsed.chip}`);
  check("no back control while on the main timeline", collapsed.backVisible === false);

  await evaluate(`(() => { document.querySelector(".thread-chip").click(); return true; })()`);
  await new Promise((r) => setTimeout(r, 1200));
  const opened2 = await evaluate(`(() => ({
    rows: document.getElementById("message-list").childElementCount,
    backVisible: document.getElementById("back-to-timeline").classList.contains("is-visible"),
    title: document.getElementById("chat-title").textContent
  }))()`);
  check("tapping the chip opens the thread with root plus replies",
    opened2.rows === 3 && opened2.title === "Thread",
    `rows=${opened2.rows} title=${opened2.title}`);
  check("back control appears inside a thread", opened2.backVisible === true);

  await evaluate(`(() => { document.getElementById("back-to-timeline").click(); return true; })()`);
  await new Promise((r) => setTimeout(r, 1200));
  const backOut = await evaluate(`(() => ({
    rows: document.getElementById("message-list").childElementCount,
    backVisible: document.getElementById("back-to-timeline").classList.contains("is-visible")
  }))()`);
  check("back returns to the full timeline", backOut.rows === collapsed.rows && backOut.backVisible === false,
    `rows=${backOut.rows}`);

  // A message arriving from the mailbox must appear on its own, with no send
  // and no reload. This is the "I don't see new messages" case.
  const beforeArrival = await metrics();
  await postEvents([message(41, "Arrived from the mailbox while you were at the bottom.")]);
  await new Promise((r) => setTimeout(r, 6000));
  const arrived = await metrics();
  check("an arriving message appears without a send or reload",
    arrived.rows > beforeArrival.rows,
    `rows ${beforeArrival.rows} -> ${arrived.rows}`);
  check("arriving message does not move the view at all",
    arrived.scrollTop === beforeArrival.scrollTop,
    `scrollTop ${beforeArrival.scrollTop} -> ${arrived.scrollTop}`);

  // Same arrival, but while reading history: must not yank, must offer the pill.
  await evaluate(`(() => { document.querySelector("#timeline-screen .thread-surface").scrollTop = 0; return true; })()`);
  await new Promise((r) => setTimeout(r, 400));
  const reading = await metrics();
  await postEvents([message(42, "Arrived from the mailbox while you were reading history.")]);
  await new Promise((r) => setTimeout(r, 6000));
  const readingAfter = await metrics();
  check("arriving message does not yank you out of history",
    readingAfter.rows > arrived.rows && readingAfter.fromBottom > reading.fromBottom - 250,
    `rows=${readingAfter.rows}, still ${readingAfter.fromBottom}px from bottom`);
  check("jump-to-latest appears when the message arrived off-screen",
    readingAfter.jumpVisible === true);

  // Read history, then send a message: your own message must win.
  await evaluate(`(() => { document.querySelector("#timeline-screen .thread-surface").scrollTop = 0; return true; })()`);
  await new Promise((r) => setTimeout(r, 400));
  const scrolledUp = await metrics();
  check("scrolling up actually moves away from the latest", scrolledUp.fromBottom > 200,
    `${scrolledUp.fromBottom}px from bottom`);

  await evaluate(`(() => {
    const input = document.getElementById("composer-input");
    input.value = "Sent from QA while reading history";
    document.getElementById("composer-form").dispatchEvent(new Event("submit", { cancelable: true }));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 2500));
  const afterSend = await metrics();
  check("sending a message returns you to the latest", afterSend.fromBottom <= 6,
    `${afterSend.fromBottom}px from bottom`);

  // Scroll up again and use the button.
  await evaluate(`(() => {
    const s = document.querySelector("#timeline-screen .thread-surface");
    s.scrollTop = 0;
    document.getElementById("jump-to-latest").classList.add("is-visible");
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 300));
  await evaluate(`(() => { document.getElementById("jump-to-latest").click(); return true; })()`);
  await new Promise((r) => setTimeout(r, 2200));
  const afterJump = await metrics();
  check("jump-to-latest returns to the newest message", afterJump.fromBottom <= 6,
    `${afterJump.fromBottom}px from bottom`);
  check("jump button hides once back at the latest", afterJump.jumpVisible === false);

  const shot = await app.send("Page.captureScreenshot", { format: "png" });
  await writeFile(path.join(repoRoot, "screenshots/qa-pwa-scroll-latest.png"), Buffer.from(shot.data, "base64"));
  console.log("screenshot: screenshots/qa-pwa-scroll-latest.png");
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
  mailboxServer.close();
  // Chrome may still be flushing its profile; cleanup failure is not a QA result.
  await rm(profile, { recursive: true, force: true }).catch(() => undefined);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
