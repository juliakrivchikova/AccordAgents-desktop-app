#!/usr/bin/env node
// End-to-end reproduction for "the chat lags on a big conversation".
//
// Drives an isolated AccordAgents Electron instance (launched separately with
// --remote-debugging-port and its own ACCORDAGENTS_USER_DATA_DIR, see
// docs/inspecting-the-desktop-app.md) through CDP: opens the chat, instruments
// the renderer, sends a real message that triggers a real participant turn, and
// while that turn streams it measures what the user feels as lag: renderer long
// tasks, dropped frames, IPC round-trip latency, `conversations:updated` payload
// size and rate, and main/renderer process CPU and memory. Prints one summary.
// macOS only (process discovery relies on the Electron.app bundle layout).
//
//   node scripts/chat-lag-repro.mjs --port=9333 --chat="<sidebar title>" \
//     --message="@member Reply with exactly one word: ok" [--no-send] [--duration=180000]
//
// Point it at an isolated instance on a copy of the data: it sends a real
// message into whichever chat `--chat` names.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { attach } = require("./cdp.cjs");

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, "").split("=");
  return [key, rest.length > 0 ? rest.join("=") : "true"];
}));
function numberArg(name, fallback) {
  if (args[name] === undefined) return fallback;
  const value = Number(args[name]);
  if (!Number.isFinite(value) || value <= 0) usage(`--${name} must be a positive number`);
  return value;
}
function usage(problem) {
  console.error(problem);
  console.error('usage: node scripts/chat-lag-repro.mjs --chat="<sidebar title>" [--port=9333] [--message="..."] [--no-send] [--duration=ms] [--settle=ms] [--shots=dir]');
  process.exit(2);
}
if (process.platform !== "darwin") usage("This harness only knows how to find Electron processes on macOS.");
if (typeof args.chat !== "string" || args.chat === "true" || !args.chat.trim()) usage("--chat is required: the sidebar title of the chat to open.");
const port = numberArg("port", 9333);
const chatTitle = args.chat;
const message = args.message ?? "@claude Reply with exactly one word: ok";
const durationMs = numberArg("duration", 180_000);
const settleMs = numberArg("settle", 20_000);
const sendMessage = args["no-send"] !== "true";
// Screenshots show real chat content, so they go into a fresh private directory.
const shotsDir = args.shots ?? fs.mkdtempSync(path.join(os.tmpdir(), "accordagents-chat-lag-"));
fs.mkdirSync(shotsDir, { recursive: true, mode: 0o700 });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (values, p) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const round = (value, digits = 1) => Number(value.toFixed(digits));

function processTable() {
  const out = execFileSync("ps", ["-eo", "pid,ppid,%cpu,rss,command"], { encoding: "utf8" });
  return out.split("\n").slice(1).map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), cpu: Number(match[3]), rss: Number(match[4]), command: match[5] } : undefined;
  }).filter(Boolean);
}

function findElectronPids() {
  const table = processTable();
  const main = table.find((row) => row.command.includes(`--remote-debugging-port=${port}`) && row.command.includes("Electron.app/Contents/MacOS/Electron"));
  if (!main) throw new Error(`No Electron main process with --remote-debugging-port=${port}`);
  const renderer = table.find((row) => row.ppid === main.pid && row.command.includes("Electron Helper (Renderer)"));
  return { main: main.pid, renderer: renderer?.pid };
}

function sampleProcesses(pids, sqlitePids) {
  const table = processTable();
  const main = table.find((row) => row.pid === pids.main);
  const renderer = table.find((row) => row.pid === pids.renderer);
  for (const row of table) {
    if (row.ppid === pids.main && /(^|\/)sqlite3(\s|$)/.test(row.command)) sqlitePids.add(row.pid);
  }
  return { mainCpu: main?.cpu ?? 0, mainRss: main?.rss ?? 0, rendererCpu: renderer?.cpu ?? 0, rendererRss: renderer?.rss ?? 0 };
}

const INSTRUMENT = `(() => {
  // A previous run's timers keep writing into the object they captured; a fresh
  // object means this summary only counts this run.
  const lag = window.__lag = {
    startedAt: performance.now(),
    snapshots: 0, snapshotMsgs: [], snapshotBytes: [], snapshotAt: [],
    longTasks: 0, longTaskMs: 0, maxLongTask: 0,
    frames: 0, maxFrameGap: 0, slowFrames: 0,
    ipc: [], ipcErrors: 0
  };
  window.consensus.onConversationUpdated((updated) => {
    lag.snapshots += 1;
    lag.snapshotAt.push(performance.now());
    lag.snapshotMsgs.push(Array.isArray(updated.messages) ? updated.messages.length : -1);
    if (lag.snapshotBytes.length < 3) lag.snapshotBytes.push(JSON.stringify(updated).length);
  });
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        lag.longTasks += 1;
        lag.longTaskMs += entry.duration;
        lag.maxLongTask = Math.max(lag.maxLongTask, entry.duration);
      }
    }).observe({ type: "longtask", buffered: false });
  } catch (error) { lag.longTaskError = String(error); }
  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    const gap = now - last;
    last = now;
    lag.frames += 1;
    if (gap > 50) lag.slowFrames += 1;
    lag.maxFrameGap = Math.max(lag.maxFrameGap, gap);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  setInterval(async () => {
    const t0 = performance.now();
    try { await window.consensus.getAppVersion(); lag.ipc.push(performance.now() - t0); }
    catch { lag.ipcErrors += 1; }
  }, 250);
  return "installed";
})()`;

const READ_STATS = `(() => {
  const lag = window.__lag;
  const heap = performance.memory ? performance.memory.usedJSHeapSize : -1;
  const running = Boolean(document.querySelector('article.chat-message.is-running')) ||
    Boolean(document.querySelector('[data-testid="project-session"][data-selected="true"][data-running="true"]'));
  return JSON.stringify({
    snapshots: lag.snapshots, snapshotMsgs: lag.snapshotMsgs, snapshotBytes: lag.snapshotBytes, snapshotAt: lag.snapshotAt,
    longTasks: lag.longTasks, longTaskMs: lag.longTaskMs, maxLongTask: lag.maxLongTask, longTaskError: lag.longTaskError,
    frames: lag.frames, maxFrameGap: lag.maxFrameGap, slowFrames: lag.slowFrames,
    ipc: lag.ipc, ipcErrors: lag.ipcErrors, heap, running,
    renderedMessages: document.querySelectorAll('article.chat-message').length,
    domNodes: document.getElementsByTagName('*').length,
    elapsedMs: performance.now() - lag.startedAt
  });
})()`;

async function saveShot(app, name) {
  try {
    const shot = await app.screenshot({ format: "png" });
    const file = path.join(shotsDir, `${name}.png`);
    fs.writeFileSync(file, shot.data);
    return file;
  } catch (error) {
    return `screenshot failed: ${error.message}`;
  }
}

const app = await attach({ port, timeoutMs: 20_000 });
try {
  await app.send("Page.bringToFront").catch(() => {});
  await app.waitForSelector('[data-testid="project-session"]', { timeoutMs: 60_000 });
  const clicked = await app.evaluate(`(() => {
    const title = ${JSON.stringify(chatTitle)};
    const rows = [...document.querySelectorAll('[data-testid="project-session"]')];
    const row = rows.find((element) => (element.textContent || "").includes(title));
    if (!row) return { ok: false, count: rows.length };
    row.click();
    return { ok: true };
  })()`);
  if (!clicked.result.value.ok) {
    process.exitCode = 2;
    throw new Error(`Chat "${chatTitle}" not found among ${clicked.result.value.count} sidebar rows.`);
  }
  await app.waitForSelector("article.chat-message", { timeoutMs: 120_000 });
  await sleep(3000);
  const installed = await app.evaluate(INSTRUMENT);
  const pids = findElectronPids();
  const baseline = JSON.parse((await app.evaluate(READ_STATS)).result.value);
  const sqlitePids = new Set();
  const baseProc = sampleProcesses(pids, sqlitePids);
  console.log(JSON.stringify({ phase: "opened", instrument: installed.result.value, pids, renderedMessages: baseline.renderedMessages, domNodes: baseline.domNodes, heapMb: round(baseline.heap / 1048576), mainRssMb: round(baseProc.mainRss / 1024), rendererRssMb: round(baseProc.rendererRss / 1024), shot: await saveShot(app, "opened") }));

  if (sendMessage) {
    await app.fill(".chat-composer textarea", message);
    await sleep(500);
    await app.click('button[aria-label="Send message"]');
    console.log(JSON.stringify({ phase: "sent", message }));
  }

  const startedAt = Date.now();
  const cpuSamples = [];
  let sawRunning = false;
  let lastRunningAt = Date.now();
  let lastSnapshotCount = baseline.snapshots;
  let lastSnapshotChangeAt = Date.now();
  let stats = baseline;
  while (Date.now() - startedAt < durationMs) {
    await sleep(2000);
    stats = JSON.parse((await app.evaluate(READ_STATS)).result.value);
    cpuSamples.push(sampleProcesses(pids, sqlitePids));
    if (stats.running) { sawRunning = true; lastRunningAt = Date.now(); }
    if (stats.snapshots !== lastSnapshotCount) { lastSnapshotCount = stats.snapshots; lastSnapshotChangeAt = Date.now(); }
    const quietFor = Math.min(Date.now() - lastRunningAt, Date.now() - lastSnapshotChangeAt);
    if (sendMessage && sawRunning && !stats.running && quietFor > settleMs) break;
    if (!sendMessage && Date.now() - startedAt > Math.min(durationMs, 30_000)) break;
  }
  const endProc = sampleProcesses(pids, sqlitePids);
  const gaps = stats.snapshotAt.slice(1).map((t, i) => t - stats.snapshotAt[i]);
  const summary = {
    phase: "done",
    elapsedS: round((Date.now() - startedAt) / 1000),
    sawRunning,
    stillRunning: stats.running,
    snapshots: stats.snapshots,
    snapshotMessagesAvg: stats.snapshotMsgs.length ? round(stats.snapshotMsgs.reduce((a, b) => a + b, 0) / stats.snapshotMsgs.length) : 0,
    snapshotMessagesMax: Math.max(0, ...stats.snapshotMsgs),
    snapshotBytesFirst: stats.snapshotBytes,
    snapshotMinGapMs: gaps.length ? round(Math.min(...gaps)) : null,
    snapshotsPerMinute: stats.elapsedMs > 0 ? round(stats.snapshots / (stats.elapsedMs / 60_000)) : 0,
    longTasks: stats.longTasks,
    longTaskTotalMs: round(stats.longTaskMs),
    longTaskMaxMs: round(stats.maxLongTask),
    longTaskError: stats.longTaskError,
    frames: stats.frames,
    slowFrames: stats.slowFrames,
    maxFrameGapMs: round(stats.maxFrameGap),
    ipcSamples: stats.ipc.length,
    ipcP50Ms: round(percentile(stats.ipc, 50)),
    ipcP95Ms: round(percentile(stats.ipc, 95)),
    ipcMaxMs: round(Math.max(0, ...stats.ipc)),
    ipcErrors: stats.ipcErrors,
    rendererHeapMbStart: round(baseline.heap / 1048576),
    rendererHeapMbEnd: round(stats.heap / 1048576),
    mainCpuAvg: round(cpuSamples.reduce((a, s) => a + s.mainCpu, 0) / Math.max(1, cpuSamples.length)),
    mainCpuMax: round(Math.max(0, ...cpuSamples.map((s) => s.mainCpu))),
    rendererCpuAvg: round(cpuSamples.reduce((a, s) => a + s.rendererCpu, 0) / Math.max(1, cpuSamples.length)),
    rendererCpuMax: round(Math.max(0, ...cpuSamples.map((s) => s.rendererCpu))),
    mainRssMbStart: round(baseProc.mainRss / 1024),
    mainRssMbEnd: round(endProc.mainRss / 1024),
    rendererRssMbStart: round(baseProc.rendererRss / 1024),
    rendererRssMbEnd: round(endProc.rendererRss / 1024),
    sqlite3ProcessesSeen: sqlitePids.size,
    renderedMessages: stats.renderedMessages,
    shot: await saveShot(app, "done")
  };
  console.log(JSON.stringify(summary, null, 2));
} finally {
  app.close();
}
