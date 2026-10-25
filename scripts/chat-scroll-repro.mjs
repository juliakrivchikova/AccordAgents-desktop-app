#!/usr/bin/env node
// End-to-end reproduction for "big chats open slowly and flicker and jump while
// scrolling".
//
// Drives an isolated AccordAgents Electron instance (launched separately with
// --remote-debugging-port and its own ACCORDAGENTS_USER_DATA_DIR, see
// docs/inspecting-the-desktop-app.md) through CDP. It opens a chat from the
// sidebar the way the User does, measures how long it takes until messages are
// painted and the view has settled at the bottom, then scrolls up through the
// whole history with real wheel events while older pages load. A frame recorder
// inside the renderer samples the timeline on every animation frame and the
// summary reports what the eye sees:
//
//   - jumps: frames in which the message the User is looking at moves on screen
//     although no wheel input arrived in that frame (or moves further than the
//     wheel input could explain),
//   - blank frames: frames in which rendered rows cover less than 90% of the
//     timeline viewport,
//   - overlap frames: frames in which two visible rows are drawn over each other,
//   - remounts: a message row that is visible in two consecutive frames but is a
//     different DOM element in the second (it re-rendered from scratch),
//   - page loads that moved the view: an older page arrived and nothing that
//     was on screen is still where it was (beyond what the wheel moved),
//   - stalls: at the top with older messages left and nothing loading, so the
//     User would have to click "Load older messages" (the script clicks it),
//   - frame gaps and long tasks.
//
//   node scripts/chat-scroll-repro.mjs --port=9476 --chat="<sidebar title>" \
//     [--out=dir] [--wheel=-300] [--interval=400] [--max-steps=800] [--label=before]
//     [--mode=wheel|trackpad] [--video] [--from="<chat to start from>"] [--trace=<file.json>]
//
// It never sends a message; it only opens and scrolls.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { attach } = require("./cdp.cjs");

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, "").split("=");
  return [key, rest.length > 0 ? rest.join("=") : "true"];
}));
function usage(problem) {
  console.error(problem);
  console.error('usage: node scripts/chat-scroll-repro.mjs --chat="<sidebar title>" [--port=9476] [--out=dir] [--wheel=-300] [--interval=400] [--max-steps=800] [--label=name] [--mode=wheel|trackpad] [--video] [--from="<other chat title>"]');
  process.exit(2);
}
if (typeof args.chat !== "string" || args.chat === "true" || !args.chat.trim()) usage("--chat is required");
const port = Number(args.port ?? 9476);
const chatTitle = args.chat;
const fromTitle = typeof args.from === "string" && args.from !== "true" ? args.from : undefined;
const wheelDelta = Number(args.wheel ?? -300);
const intervalMs = Number(args.interval ?? 400);
const maxSteps = Number(args["max-steps"] ?? 800);
const label = args.label ?? "run";
// "wheel": one wheel event of --wheel px per step (a mouse wheel notch burst).
// "trackpad": the same distance as a stream of 30 px events, one per frame (a swipe).
const mode = args.mode === "trackpad" ? "trackpad" : "wheel";
const outDir = args.out ?? fs.mkdtempSync(path.join("/private/tmp", "accordagents-chat-scroll-"));
fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value, digits = 1) => Number(Number(value).toFixed(digits));
const percentile = (values, p) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

const RECORDER = String.raw`(() => {
  if (window.__chatScrollRecorder) window.__chatScrollRecorder.stop();
  const rec = { frames: [], longtasks: [], running: true, marks: {} };
  let wheel = 0;
  const onWheel = (event) => { wheel += event.deltaY; };
  document.addEventListener("wheel", onWheel, { capture: true, passive: true });
  let longtaskObserver;
  try {
    longtaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) rec.longtasks.push({ t: entry.startTime, d: entry.duration });
    });
    longtaskObserver.observe({ type: "longtask", buffered: false });
  } catch {}
  let previousVisible = new Map();
  const textId = (element) => {
    const text = (element.textContent || "").slice(0, 400);
    let hash = 0;
    for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) | 0;
    return (hash >>> 0).toString(36);
  };
  const tick = () => {
    if (!rec.running) return;
    const frame = { t: performance.now(), w: wheel };
    wheel = 0;
    const timeline = document.querySelector(".chat-timeline");
    frame.loading = Boolean(document.querySelector(".app-loading-state"));
    frame.title = document.querySelector(".chat-top-bar-title, [data-testid='chat-title']")?.textContent?.slice(0, 80);
    if (timeline) {
      const box = timeline.getBoundingClientRect();
      frame.st = timeline.scrollTop;
      frame.sh = timeline.scrollHeight;
      frame.ch = timeline.clientHeight;
      const rows = [];
      const spans = [];
      const visible = new Map();
      let remounts = 0;
      for (const item of timeline.querySelectorAll(".virtual-timeline-item")) {
        const itemBox = item.getBoundingClientRect();
        if (itemBox.height === 0) continue;
        // What the eye sees: a row clipped to its estimated height (clip-path) shows no more than that.
        const clip = /calc\(100% \+ \d+px\) ([\d.]+)px/.exec(item.style.clipPath || "");
        const height = clip ? Math.min(itemBox.height, Number(clip[1])) : itemBox.height;
        const rect = { top: itemBox.top, bottom: itemBox.top + height, height };
        const isVisible = rect.bottom > box.top && rect.top < box.bottom;
        const element = item.querySelector("[data-message-id], [data-app-tool-approval-id], .timeline-load-more-row") || item;
        const id = element.getAttribute("data-message-id")
          ? "m:" + element.getAttribute("data-message-id")
          : element.getAttribute("data-app-tool-approval-id")
            ? "a:" + element.getAttribute("data-app-tool-approval-id")
            : element.classList.contains("timeline-load-more-row") ? "load-older" : "t:" + textId(item);
        if (isVisible) {
          spans.push([Math.max(rect.top, box.top) - box.top, Math.min(rect.bottom, box.bottom) - box.top]);
          if (previousVisible.has(id) && previousVisible.get(id) !== element) remounts += 1;
          visible.set(id, element);
        }
        rows.push({ id, top: Math.round((rect.top - box.top) * 10) / 10, h: Math.round(rect.height), v: isVisible ? 1 : 0 });
      }
      previousVisible = visible;
      spans.sort((a, b) => a[0] - b[0]);
      let covered = 0;
      let cursor = -Infinity;
      for (const [start, end] of spans) {
        if (end <= cursor) continue;
        covered += end - Math.max(start, cursor);
        cursor = end;
      }
      frame.cov = Math.round((covered / Math.max(1, box.height)) * 1000) / 1000;
      // Visible rows drawn on top of each other (a row grew before the rows under it moved).
      const shown = rows.filter((row) => row.v).sort((a, b) => a.top - b.top);
      frame.ov = shown.filter((row, index) => index > 0 && shown[index - 1].top + shown[index - 1].h > row.top + 2).length;
      frame.rows = rows;
      frame.rm = remounts;
      frame.olderLoading = Boolean(timeline.querySelector(".timeline-load-more-row .spin"));
    }
    rec.frames.push(frame);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  rec.stop = () => {
    rec.running = false;
    document.removeEventListener("wheel", onWheel, { capture: true });
    longtaskObserver?.disconnect();
  };
  window.__chatScrollRecorder = rec;
  return true;
})()`;

async function main() {
  const app = await attach({ port, timeoutMs: 30_000 });
  const href = (await app.evaluate("location.href")).result.value;
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.json());
  if (!/Electron\//.test(version["User-Agent"] ?? "")) throw new Error(`Port ${port} is not an Electron renderer: ${version["User-Agent"]}`);
  console.error(`attached ${href}`);
  await app.send("Page.bringToFront");
  await app.send("Page.enable");

  async function clickSidebarChat(title) {
    // Expand "Show N more" until the chat row is in the DOM, then click it.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const found = (await app.evaluate(`(() => {
        const title = ${JSON.stringify(title)};
        const row = [...document.querySelectorAll("[data-testid='project-session']")]
          .find((button) => button.querySelector(".truncate")?.textContent?.trim() === title);
        if (row) return "found";
        const more = document.querySelector("[data-testid='project-show-more']");
        if (more) { more.click(); return "more"; }
        const archived = document.querySelector("[data-testid='archived-toggle']");
        if (archived && archived.getAttribute("aria-expanded") !== "true" && !archived.dataset.qaOpened) {
          archived.dataset.qaOpened = "1";
          archived.click();
          return "more";
        }
        return "missing";
      })()`)).result.value;
      if (found === "found") break;
      if (found === "missing") throw new Error(`Chat not in sidebar: ${title}`);
      await sleep(150);
    }
    return (await app.evaluate(`(() => {
      const title = ${JSON.stringify(title)};
      const row = [...document.querySelectorAll("[data-testid='project-session']")]
        .find((button) => button.querySelector(".truncate")?.textContent?.trim() === title);
      row.scrollIntoView({ block: "center" });
      const t = performance.now();
      row.click();
      return t;
    })()`)).result.value;
  }

  // Start from another screen so the click really opens the chat.
  if (fromTitle) {
    await clickSidebarChat(fromTitle);
    await sleep(3000);
  } else {
    await app.click("[data-testid='new-chat']");
    await sleep(1500);
  }

  await app.evaluate(RECORDER);
  const clickAt = await clickSidebarChat(chatTitle);

  // Wait for the chat to settle: messages painted and scrollTop unchanged for 1 s.
  const openDeadline = Date.now() + 60_000;
  let firstPaintAt;
  let settledAt;
  while (Date.now() < openDeadline) {
    await sleep(100);
    const status = (await app.evaluate(`(() => {
      const frames = window.__chatScrollRecorder.frames;
      const clickAt = ${clickAt};
      const after = frames.filter((f) => f.t >= clickAt);
      const first = after.find((f) => !f.loading && f.rows && f.rows.some((r) => r.v && r.id.startsWith("m:")));
      if (!first) return { first: null };
      const last = after[after.length - 1];
      let stableSince = last.t;
      for (let i = after.length - 1; i > 0; i -= 1) {
        const a = after[i], b = after[i - 1];
        if (a.st === undefined || b.st === undefined || Math.abs(a.st - b.st) > 0.5 || a.sh !== b.sh) break;
        stableSince = b.t;
      }
      return { first: first.t, stableSince, now: last.t };
    })()`)).result.value;
    if (status.first !== null && firstPaintAt === undefined) firstPaintAt = status.first;
    if (status.first !== null && status.now - status.stableSince >= 1000) {
      settledAt = status.stableSince;
      break;
    }
  }
  const openShot = await app.screenshot({ format: "jpeg", quality: 70 });
  fs.writeFileSync(path.join(outDir, `${label}-opened.jpg`), openShot.data);

  const openFrames = (await app.evaluate(`window.__chatScrollRecorder.frames.filter((f) => f.t >= ${clickAt})`)).result.value;
  const openLongtasks = (await app.evaluate(`window.__chatScrollRecorder.longtasks.filter((l) => l.t >= ${clickAt})`)).result.value;

  // Direct IPC timing of the same open call the renderer makes, for the main-process share.
  const ipc = (await app.evaluate(`(async () => {
    const title = ${JSON.stringify(chatTitle)};
    const summaries = await window.consensus.listConversations();
    const summary = summaries.find((s) => s.title === title);
    if (!summary) return null;
    const t0 = performance.now();
    const result = await window.consensus.openConversation(summary.id, 80);
    const t1 = performance.now();
    const bytes = JSON.stringify(result).length;
    return { id: summary.id, ms: t1 - t0, bytes, messages: result?.conversation?.messages?.length, totalMessages: result?.messagePage?.totalMessages };
  })()`, {}, { timeoutMs: 60_000 })).result.value;

  // Scroll up through the history with wheel events.
  // Wheel over a point that really belongs to the timeline (notices can float over its right side).
  const box = (await app.evaluate(`(() => {
    const timeline = document.querySelector(".chat-timeline");
    const r = timeline.getBoundingClientRect();
    for (const fy of [0.5, 0.35, 0.65, 0.2, 0.8]) {
      for (let x = r.left + 24; x < r.right - 24; x += 24) {
        const y = r.top + r.height * fy;
        if (timeline.contains(document.elementFromPoint(x, y))) return { x, y };
      }
    }
    throw new Error("No point of the timeline is reachable by the pointer");
  })()`)).result.value;
  // --trace=<file>: record a Chrome performance trace of the scroll phase (devtools timeline
  // plus JS samples), for finding what makes a frame long. Tracing adds overhead, so frame
  // counts from a traced run are not comparable with an untraced one.
  const tracing = typeof args.trace === "string" && args.trace !== "true" ? await startTrace(port) : undefined;
  const scrollStart = (await app.evaluate("performance.now()")).result.value;
  await app.evaluate(`performance.mark("chat-scroll-start:" + ${JSON.stringify(String(Date.now()))})`);
  const screencastFrames = [];
  const onFrame = async (params) => {
    if (screencastFrames.length < 600) screencastFrames.push({ t: params.metadata.timestamp, data: params.data });
    app.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
  };
  let removeScreencast = () => {};
  if (args.video === "true") {
    // cdp.cjs exposes only waitForEvent, so poll it for screencast frames.
    let active = true;
    (async () => {
      while (active) {
        try {
          const params = await app.waitForEvent("Page.screencastFrame", { timeoutMs: 2000 });
          await onFrame(params);
        } catch {}
      }
    })();
    await app.send("Page.startScreencast", { format: "jpeg", quality: 50, everyNthFrame: 1 });
    removeScreencast = async () => { active = false; await app.send("Page.stopScreencast").catch(() => {}); };
  }
  let steps = 0;
  let stalls = 0;
  let topSince;
  for (; steps < maxSteps; steps += 1) {
    if (mode === "trackpad") {
      // A trackpad swipe: a stream of small wheel events, one per frame, then a pause.
      const events = Math.max(1, Math.round(Math.abs(wheelDelta) / 30));
      for (let event = 0; event < events; event += 1) {
        await app.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: Math.sign(wheelDelta) * 30 });
        await sleep(16);
      }
    } else {
      await app.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: wheelDelta });
    }
    await sleep(intervalMs);
    const state = (await app.evaluate(`(() => {
      const t = document.querySelector(".chat-timeline");
      return { st: t.scrollTop, older: Boolean(t.querySelector(".timeline-load-more-row")), olderEnabled: Boolean(t.querySelector(".timeline-load-more-row button:not([disabled])")), loading: Boolean(t.querySelector(".timeline-load-more-row .spin")) };
    })()`)).result.value;
    if (state.st <= 0 && !state.loading) {
      topSince ??= Date.now();
      if (!state.older) break;
      // Wheel input at scrollTop 0 cannot scroll, so nothing fires a scroll event. If older
      // messages exist but did not start loading, the User is stuck at the top and has to
      // click "Load older messages" herself; do what she would do and count it.
      if (state.olderEnabled && Date.now() - topSince > 1500) {
        stalls += 1;
        await app.evaluate(`document.querySelector(".chat-timeline .timeline-load-more-row button")?.click()`);
        topSince = undefined;
      } else if (Date.now() - topSince > 8000) {
        break;
      }
    } else {
      topSince = undefined;
    }
  }
  await sleep(1500);
  await removeScreencast();
  if (tracing) {
    await tracing.stop();
    console.error(`trace written to ${args.trace}`);
  }
  const scrollFrames = (await app.evaluate(`window.__chatScrollRecorder.frames.filter((f) => f.t >= ${scrollStart})`)).result.value;
  const scrollLongtasks = (await app.evaluate(`window.__chatScrollRecorder.longtasks.filter((l) => l.t >= ${scrollStart})`)).result.value;
  await app.evaluate("window.__chatScrollRecorder.stop()");
  const endShot = await app.screenshot({ format: "jpeg", quality: 70 });
  fs.writeFileSync(path.join(outDir, `${label}-top.jpg`), endShot.data);
  if (screencastFrames.length > 0) {
    const videoDir = path.join(outDir, `${label}-frames`);
    fs.mkdirSync(videoDir, { recursive: true });
    screencastFrames.forEach((frame, index) => fs.writeFileSync(path.join(videoDir, `${String(index).padStart(4, "0")}.jpg`), Buffer.from(frame.data, "base64")));
  }

  const scroll = analyseScroll(scrollFrames);
  const timeOrigin = (await app.evaluate("performance.timeOrigin")).result.value;
  const open = analyseOpen(openFrames, clickAt, firstPaintAt, settledAt);
  // Wall-clock instants, to line the renderer up with main-process logs.
  open.clickEpochMs = Math.round(timeOrigin + clickAt);
  open.firstMessagesEpochMs = firstPaintAt === undefined ? null : Math.round(timeOrigin + firstPaintAt);
  // Anything that moves on screen between the first painted messages and "settled" moved by itself.
  const openAfterPaint = openFrames.filter((frame) => firstPaintAt !== undefined && frame.t >= firstPaintAt);
  const openMotion = analyseScroll(openAfterPaint);
  open.jumpsAfterPaint = openMotion.jumps;
  open.overlapFramesAfterPaint = openMotion.overlapFrames;
  open.contentSwapsAfterPaint = openMotion.contentSwaps;
  const summary = {
    label,
    mode,
    chat: chatTitle,
    href,
    ipc: ipc && { ms: round(ipc.ms), bytes: ipc.bytes, messages: ipc.messages, totalMessages: ipc.totalMessages },
    open: { ...open, longTasks: openLongtasks.length, longTaskMs: round(openLongtasks.reduce((sum, task) => sum + task.d, 0)), maxLongTaskMs: round(Math.max(0, ...openLongtasks.map((task) => task.d))) },
    scroll: { steps, stallsAtTop: stalls, ...scroll, longTasks: scrollLongtasks.length, longTaskMs: round(scrollLongtasks.reduce((sum, task) => sum + task.d, 0)), maxLongTaskMs: round(Math.max(0, ...scrollLongtasks.map((task) => task.d))) }
  };
  fs.writeFileSync(path.join(outDir, `${label}-frames.json`), JSON.stringify({ openFrames, scrollFrames, openLongtasks, scrollLongtasks }, null, 0));
  fs.writeFileSync(path.join(outDir, `${label}-summary.json`), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  app.close();
}

async function startTrace(cdpPort) {
  const WebSocket = require("ws");
  const targets = await fetch(`http://127.0.0.1:${cdpPort}/json`).then((response) => response.json());
  const page = targets.find((target) => target.type === "page" && target.title === "AccordAgents");
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 1024 * 1024 * 1024 });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  // Events are written as they arrive: a long traced run does not fit in one string.
  const file = args.trace;
  const out = fs.createWriteStream(file);
  out.write('{"traceEvents":[');
  let first = true;
  let nextId = 1;
  let complete;
  const done = new Promise((resolve) => { complete = resolve; });
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.method === "Tracing.dataCollected") {
      for (const event of message.params.value) {
        out.write((first ? "" : ",") + JSON.stringify(event));
        first = false;
      }
    }
    if (message.method === "Tracing.tracingComplete") complete();
  });
  const send = (method, params = {}) => ws.send(JSON.stringify({ id: nextId++, method, params }));
  send("Tracing.start", {
    transferMode: "ReportEvents",
    traceConfig: {
      includedCategories: [
        "devtools.timeline",
        "disabled-by-default-devtools.timeline",
        "disabled-by-default-devtools.timeline.frame",
        "blink.user_timing",
        "v8.execute",
        "disabled-by-default-v8.cpu_profiler"
      ]
    }
  });
  await sleep(500);
  return {
    stop: async () => {
      send("Tracing.end");
      await done;
      ws.close();
      await new Promise((resolve) => out.end("]}", resolve));
    }
  };
}

function analyseOpen(frames, clickAt, firstPaintAt, settledAt) {
  const firstMessages = frames.find((frame) => !frame.loading && frame.rows?.some((row) => row.v && row.id.startsWith("m:")));
  // Scroll position changes after messages first appear: the view moving on its own while opening.
  let positionChanges = 0;
  let blankFrames = 0;
  if (firstMessages) {
    const after = frames.filter((frame) => frame.t >= firstMessages.t && (settledAt === undefined || frame.t <= settledAt));
    for (let index = 1; index < after.length; index += 1) {
      const a = after[index - 1];
      const b = after[index];
      if (a.st !== undefined && b.st !== undefined && Math.abs(b.st - a.st) > 4) positionChanges += 1;
      if (b.cov !== undefined && b.cov < 0.9) blankFrames += 1;
    }
  }
  return {
    firstMessagesMs: firstPaintAt === undefined ? null : round(firstPaintAt - clickAt),
    settledMs: settledAt === undefined ? null : round(settledAt - clickAt),
    loadingFrames: frames.filter((frame) => frame.loading).length,
    selfScrollFramesAfterPaint: positionChanges,
    blankFramesAfterPaint: blankFrames
  };
}

function analyseScroll(frames) {
  const jumps = [];
  let swaps = 0;
  let blankFrames = 0;
  let overlapFrames = 0;
  let remounts = 0;
  let noRowFrames = 0;
  const gaps = [];
  for (let index = 1; index < frames.length; index += 1) {
    const a = frames[index - 1];
    const b = frames[index];
    gaps.push(b.t - a.t);
    if (!b.rows) continue;
    if (b.cov < 0.9) blankFrames += 1;
    if (b.ov > 0) overlapFrames += 1;
    if (!b.rows.some((row) => row.v)) noRowFrames += 1;
    remounts += b.rm ?? 0;
    if (!a.rows) continue;
    // The message the User is looking at: the first visible row of the previous frame
    // (prefer one whose top edge is on screen).
    const candidates = a.rows.filter((row) => row.v && row.id !== "load-older");
    const anchor = candidates.find((row) => row.top >= 0) ?? candidates[0];
    if (!anchor) continue;
    const next = b.rows.find((row) => row.id === anchor.id);
    // Scrolling up by |w| px can move content down by at most |w| px. 8 px slack for rounding.
    const allowance = Math.abs(a.w ?? 0) + Math.abs(b.w ?? 0) + 8;
    if (!next) {
      // The anchor is gone from the rendered window: everything on screen was replaced.
      swaps += 1;
      jumps.push({ t: round(b.t), move: null, wheel: (a.w ?? 0) + (b.w ?? 0), st: [round(a.st), round(b.st)], sh: [a.sh, b.sh], anchor: anchor.id.slice(0, 14) });
      continue;
    }
    const move = next.top - anchor.top;
    if (Math.abs(move) > allowance) {
      jumps.push({ t: round(b.t), move: round(move), wheel: (a.w ?? 0) + (b.w ?? 0), st: [round(a.st), round(b.st)], sh: [a.sh, b.sh], anchor: anchor.id.slice(0, 14) });
    }
  }
  // Every older page that arrived (the content grew by more than a screen in one frame): is what
  // was on screen still where it was a few frames later, apart from what the wheel moved it?
  let pageLoads = 0;
  let pageLoadsThatMovedView = 0;
  for (let index = 1; index < frames.length; index += 1) {
    const a = frames[index - 1];
    const last = Math.min(frames.length - 1, index + 3);
    const b = frames[last];
    if (!a.rows || !b.rows || frames[index].sh - a.sh < Math.max(1500, a.ch ?? 0)) continue;
    pageLoads += 1;
    let wheel = 0;
    // A wheel event recorded in the frame before can still be moving the content.
    for (let k = index - 1; k <= last; k += 1) wheel += Math.abs(frames[k].w ?? 0);
    const before = new Map(a.rows.filter((row) => row.v && row.id !== "load-older").map((row) => [row.id, row.top]));
    const kept = b.rows.filter((row) => row.v && before.has(row.id) && Math.abs(row.top - before.get(row.id)) <= wheel + 8);
    if (before.size > 0 && kept.length === 0) pageLoadsThatMovedView += 1;
  }
  const measured = jumps.filter((jump) => jump.move !== null);
  return {
    pageLoads,
    pageLoadsThatMovedView,
    frames: frames.length,
    durationMs: round((frames.at(-1)?.t ?? 0) - (frames[0]?.t ?? 0)),
    jumps: jumps.length,
    contentSwaps: swaps,
    jumpPxTotal: round(measured.reduce((sum, jump) => sum + Math.abs(jump.move), 0)),
    jumpPxMax: round(Math.max(0, ...measured.map((jump) => Math.abs(jump.move)))),
    blankFrames,
    overlapFrames,
    noRowFrames,
    remounts,
    frameGapP95Ms: round(percentile(gaps, 95)),
    frameGapMaxMs: round(Math.max(0, ...gaps)),
    framesOver50ms: gaps.filter((gap) => gap > 50).length,
    finalScrollHeight: frames.at(-1)?.sh,
    sampleJumps: jumps.slice(0, 15)
  };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
