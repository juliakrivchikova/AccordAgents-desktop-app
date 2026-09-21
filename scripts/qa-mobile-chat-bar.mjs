// Live QA for the bottom bar inside a chat (the User's 2026-09-20 decision:
// Slack's behaviour). The built shell runs in a phone-sized Chrome against a
// reference mailbox, the timeline is ingested through the app's own code path,
// and the harness only reads geometry back and takes pictures:
//
//   - the bar is under the composer, never over it, and inside the screen;
//   - it is the same bar as on the home screens: same width, same tap targets;
//   - it goes while the composer has the keyboard and comes back after;
//   - a reader at the latest message is still there when it comes and goes;
//   - the chat's dialogs take it with them;
//   - an open chat pays nothing for it: no pass over the timeline store;
//   - a tab leaves the chat for that screen.
//
// Pictures land in /tmp/qa-bar-*.png. Run: npm run qa:mobile-chat-bar
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn, execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { attach } = require("./cdp.cjs");
const { createReferenceMailboxServer } = require("./mailbox-reference-server.cjs");

const repoRoot = path.resolve(import.meta.dirname, "..");
const root = path.join(repoRoot, "dist/mobile");
const SITE_PORT = 8231;
const MAILBOX_PORT = 8232;
const CDP_PORT = 9391;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CONVERSATION = "conv-qa-bar";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json" };

for (const port of [CDP_PORT, SITE_PORT, MAILBOX_PORT]) {
  try { execSync(`lsof -ti tcp:${port} -sTCP:LISTEN | xargs kill -9`, { stdio: "ignore" }); } catch { /* nothing listening */ }
}

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
  } catch { res.writeHead(404).end("not found"); }
});
await new Promise((r) => site.listen(SITE_PORT, "127.0.0.1", r));
const mailbox = createReferenceMailboxServer();
const mailboxServer = mailbox.server ?? mailbox;
await new Promise((r) => mailboxServer.listen(MAILBOX_PORT, "127.0.0.1", r));

const profile = await mkdtemp(path.join(tmpdir(), "aa-bar-qa-"));
const chrome = spawn(CHROME, ["--headless=new", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "--window-size=393,852",
  `http://127.0.0.1:${SITE_PORT}/`], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
let app;
for (let i = 0; i < 40 && !app; i += 1) {
  try { app = await attach({ port: CDP_PORT, title: "AccordAgents" }); } catch { await sleep(500); }
}
if (!app) {
  const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json`).then((r) => r.json()).catch((e) => String(e));
  throw new Error("no chrome: " + JSON.stringify((targets.filter ? targets : []).map((t) => [t.type, t.title, t.url])));
}
const evaluate = async (expr) => (await app.evaluate(expr)).result.value;
await app.send("Emulation.setDeviceMetricsOverride", { width: 393, height: 852, deviceScaleFactor: 3, mobile: true });
const shot = async (name) => {
  const { data } = await app.send("Page.captureScreenshot", { format: "png" });
  await writeFile(`/tmp/qa-bar-${name}.png`, Buffer.from(data, "base64"));
};
const theme = async (mode) => app.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: mode }] });

const messages = Array.from({ length: 12 }, (_, i) => ({
  id: `m${i}`, role: i % 2 ? "participant" : "you", participantLabel: "Drew",
  content: `Message ${i} in the QA chat, long enough to wrap onto a second line on a phone.`,
  status: "done", createdAt: new Date(Date.UTC(2026, 8, 20, 6, i)).toISOString()
}));

await evaluate(`(() => {
  localStorage.setItem("accordagents.mobile.pairing.v1", JSON.stringify({
    endpoint: "http://127.0.0.1:${SITE_PORT}/",
    outboxUrl: "http://127.0.0.1:${SITE_PORT}/v1/mailbox/events",
    pairedAt: new Date(0).toISOString()
  }));
  localStorage.setItem("accordagents.mobile.chatList.v1", JSON.stringify([
    { id: "${CONVERSATION}", title: "Bottom bar QA", group: "AccordAgents", snippet: "…", updatedAt: new Date().toISOString(), participants: ["@drew"] }
  ]));
  localStorage.setItem("accordagents.mobile.activeConversationId.v1", "${CONVERSATION}");
  return true;
})()`);
await app.send("Page.reload", { ignoreCache: true });
await sleep(4000);
await evaluate(`(async () => {
  await globalThis.AccordAgentsMobile.handleRelayTimelinePayload(
    { type: "mobile.timeline.events", events: ${JSON.stringify(messages)} }, "${CONVERSATION}");
  return true;
})()`);
await sleep(2500);

const geometry = () => evaluate(`(() => {
  const dock = document.getElementById("home-dock");
  const bar = dock.getBoundingClientRect();
  const composer = document.getElementById("composer-form").getBoundingClientRect();
  const surface = document.querySelector("#timeline-screen .thread-surface");
  return {
    dockHidden: dock.hidden, dockAttr: document.querySelector(".mobile-phone").dataset.dock,
    barTop: Math.round(bar.top), barBottom: Math.round(bar.bottom), barHeight: Math.round(bar.height),
    composerBottom: Math.round(composer.bottom), viewport: Math.round(window.innerHeight),
    overlapsComposer: bar.top < composer.bottom - 1,
    offBottom: bar.bottom > window.innerHeight + 1,
    fromBottom: Math.round(surface.scrollHeight - surface.scrollTop - surface.clientHeight)
  };
})()`);

const bar = () => evaluate(`(() => {
  const dock = document.getElementById("home-dock");
  const box = dock.getBoundingClientRect();
  const style = getComputedStyle(dock);
  const inner = box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  return {
    hidden: dock.hidden,
    inner: Math.round(inner),
    tabs: [...document.querySelectorAll(".pb-tab")].map((tab) => Math.round(tab.getBoundingClientRect().width))
  };
})()`);

const out = {};
try {
// What an open chat costs: a pass over a week of timeline rows takes hundreds
// of milliseconds on a phone, so the number in the bar must not ask for one
// while a member streams into another chat.
await evaluate(`(() => {
  window.__timelineReads = 0;
  const original = IDBIndex.prototype.getAll;
  IDBIndex.prototype.getAll = function (...args) { window.__timelineReads += 1; return original.apply(this, args); };
  return true;
})()`);
for (let burst = 0; burst < 6; burst += 1) {
  await evaluate(`(async () => {
    await globalThis.AccordAgentsMobile.handleRelayTimelinePayload(
      { type: "mobile.timeline.events", events: [{ id: "burst${burst}", role: "participant", participantLabel: "Morgan",
        content: "Streaming into another chat, burst ${burst}", status: "pending", createdAt: new Date().toISOString() }] },
      "conv-qa-other");
    return true;
  })()`);
  await sleep(1200);
}
const timelineReads = await evaluate(`window.__timelineReads`);
// Each delivered row used to cost two passes over a chat's rows: one to
// deduplicate it and one to draw with. The write side now works from rows the
// page already holds, so a streamed row costs the redraw only. Dropping that
// last one means drawing from memory a reload would not have, and the reads it
// would remove are the ones the chat-isolation suite holds open on purpose --
// so this is a ceiling, not a target of zero.
check("an open chat pays one pass per streamed row, not two", timelineReads <= 7, `${timelineReads} passes over the timeline store in 7s of streaming`);

// Waiting for messages must be visible as waiting, not as an empty chat.
const bannerStates = await evaluate(`(async () => {
  const node = document.getElementById("timeline-syncing");
  const slow = AccordAgentsMobile.whileLookingForMessages(() => new Promise((done) => setTimeout(done, 1200)));
  await new Promise((r) => setTimeout(r, 700));
  const during = node.hidden;
  await slow;
  await new Promise((r) => setTimeout(r, 1200));
  return JSON.stringify({ during, after: node.hidden, text: node.textContent.trim() });
})()`);
const banner = JSON.parse(bannerStates);
check("a chat that is still looking says so", banner.during === false && banner.after === true && /Looking for new messages/.test(banner.text), JSON.stringify(banner));

out.closed = await geometry();
out.barInChat = await bar();
await shot("chat-light");
await theme("dark"); await sleep(400); await shot("chat-dark"); await theme("light"); await sleep(300);
check("the bar is under the chat, below the composer and inside the screen",
  out.closed.dockHidden === false && out.closed.dockAttr === "chat" &&
  out.closed.overlapsComposer === false && out.closed.offBottom === false,
  JSON.stringify(out.closed));
check("the reader is at the latest message with the bar on screen", out.closed.fromBottom <= 2, `${out.closed.fromBottom}px from the bottom`);

await evaluate(`document.getElementById("composer-input").focus()`);
await sleep(700);
out.typing = await geometry();
await shot("chat-typing");
check("the bar leaves while the keyboard is up", out.typing.dockHidden === true && out.typing.dockAttr === "0", JSON.stringify(out.typing));
check("the reader is still at the latest message while typing", out.typing.fromBottom <= 2, `${out.typing.fromBottom}px from the bottom`);

await evaluate(`document.getElementById("composer-input").blur()`);
await sleep(900);
out.afterBlur = await geometry();
check("the bar comes back when the keyboard goes",
  out.afterBlur.dockHidden === false && out.afterBlur.dockAttr === "chat" && out.afterBlur.overlapsComposer === false,
  JSON.stringify(out.afterBlur));
check("the reader is still at the latest message after it comes back", out.afterBlur.fromBottom <= 2, `${out.afterBlur.fromBottom}px from the bottom`);

// A reader up in history stays up in history when the bar comes and goes:
// the scroll is restored only for a reader who was at the latest message.
const parked = await evaluate(`(() => {
  const surface = document.querySelector("#timeline-screen .thread-surface");
  if (surface.scrollHeight <= surface.clientHeight + 100) return null;
  surface.scrollTop = 0;
  return Math.round(surface.scrollTop);
})()`);
if (parked === null) {
  check("a reader up in history is left there", false, "the QA thread does not overflow — seed more messages");
} else {
  await evaluate(`document.getElementById("composer-input").focus()`);
  await sleep(700);
  const whileTyping = await evaluate(`Math.round(document.querySelector("#timeline-screen .thread-surface").scrollTop)`);
  await evaluate(`document.getElementById("composer-input").blur()`);
  await sleep(900);
  const afterKeyboard = await evaluate(`Math.round(document.querySelector("#timeline-screen .thread-surface").scrollTop)`);
  check("a reader up in history is left there, keyboard up and down",
    whileTyping <= 2 && afterKeyboard <= 2, `scrollTop ${whileTyping} while typing, ${afterKeyboard} after`);
  await evaluate(`(() => {
    const surface = document.querySelector("#timeline-screen .thread-surface");
    surface.scrollTop = surface.scrollHeight;
    return true;
  })()`);
  await sleep(300);
}

// The chat's own dialogs take the bar with them: a picture at full size is
// not letterboxed by a nav bar, and a dialog with a backdrop has nothing live
// outside it.
await evaluate(`document.getElementById("chat-members-toggle").click()`);
await sleep(500);
const withSheet = await bar();
await evaluate(`document.getElementById("members-sheet-close")?.click()`);
await sleep(500);
const afterSheet = await bar();
check("the members sheet takes the bar with it",
  withSheet.hidden === true && afterSheet.hidden === false,
  `hidden with the sheet: ${withSheet.hidden}, after it: ${afterSheet.hidden}`);

await evaluate(`document.querySelector('[data-home-tab="chats"]').click()`);
await sleep(1500);
out.afterTab = await evaluate(`(() => ({
  chats: document.getElementById("chats-screen").classList.contains("is-active"),
  active: localStorage.getItem("accordagents.mobile.activeConversationId.v1"),
  dockAttr: document.querySelector(".mobile-phone").dataset.dock
}))()`);
await shot("chats-light");
out.barAtHome = await bar();
check("the bar inside a chat is the bar from the home screens, tap targets and all",
  out.barInChat.inner === out.barAtHome.inner &&
  out.barInChat.tabs.every((width, index) => width === out.barAtHome.tabs[index] && width >= 44),
  `in a chat ${JSON.stringify(out.barInChat)}, at home ${JSON.stringify(out.barAtHome)}`);
check("a tab tapped inside a chat leaves the chat for that screen",
  out.afterTab.chats === true && !out.afterTab.active && out.afterTab.dockAttr === "1", JSON.stringify(out.afterTab));
} finally {
  app?.close();
  chrome.kill("SIGKILL");
  site.close();
  mailboxServer.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; pictures in /tmp/qa-bar-*.png`);
process.exit(failed.length ? 1 : 0);
