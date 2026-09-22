/**
 * A tap on a button above the composer while the keyboard is up, in the real
 * PWA, pressed and released at one point the way a finger does.
 *
 * The tap takes the focus from the field on its way down. The bar under the
 * composer used to come back right there, and the composer to fold to one
 * line, so everything above them moved before the release: the release landed
 * on something else, and the tap only put the keyboard away. A card's Send,
 * Allow or Deny had to be tapped twice (review of 2026-09-22).
 *
 * Also here: a chat opened from the search results keeps its bar. The search
 * flag hid the bar everywhere, the chat's composer gives its safe area to the
 * bar, so the chat had neither.
 *
 * Desktop Chrome, not the installed phone: supporting evidence for the phone
 * check, not a stand-in for it.
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
const SITE_PORT = 8301;
const CDP_PORT = 9441;
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CHAT = "chat-tap";

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const originHeaders = loadMobileOriginHeaders(root);
const site = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname === "/v1/mailbox/events" && req.method === "POST") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const ids = (body.events || []).map((event) => event.eventId);
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

function card(id, overrides = {}) {
  return {
    id,
    conversationId: CHAT,
    kind: "choice",
    status: "pending",
    title: "Which one?",
    summary: "Pick one",
    sourceMessageId: `message-${id}`,
    options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
    allowsCustomAnswer: true,
    createdAt: new Date(0).toISOString(),
    ...overrides
  };
}

test("a tap above the composer while the keyboard is up lands the first time", { timeout: 120_000 }, async (t) => {
  await new Promise((r) => site.listen(SITE_PORT, "127.0.0.1", r));
  killStaleCdp();
  const profile = await mkdtemp(path.join(tmpdir(), "aa-mobile-tap-typing-"));
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
  const waitFor = async (expr, what, timeoutMs = 10_000) => {
    const end = Date.now() + timeoutMs;
    let last;
    while (Date.now() < end) {
      last = await evaluate(expr);
      if (last) return last;
      await sleep(100);
    }
    assert.fail(`${what}: last saw ${JSON.stringify(last)}`);
  };
  const center = (selector) => evaluate(`(() => {
    const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
  // One finger on one spot: press, then release, where the button was when
  // the finger came down.
  const tapAt = async (point) => {
    await app.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  };
  const dockShown = `(() => {
    const dock = document.getElementById("home-dock");
    return Boolean(dock && !dock.hidden && dock.getClientRects().length > 0 && getComputedStyle(dock).display !== "none");
  })()`;
  const seed = async (cards) => {
    await evaluate(`(() => {
      localStorage.setItem("accordagents.mobile.pairing.v1", JSON.stringify({ endpoint: "http://127.0.0.1:${SITE_PORT}/", pairedAt: new Date(0).toISOString() }));
      localStorage.setItem("accordagents.mobile.chatList.v1", JSON.stringify([
        { id: ${JSON.stringify(CHAT)}, title: "Tap test", group: "AccordAgents", snippet: "…", updatedAt: new Date(0).toISOString(), participants: ["@drew"] }
      ]));
      localStorage.setItem("accordagents.mobile.activeConversationId.v1", ${JSON.stringify(CHAT)});
      localStorage.setItem("accordagents.mobile.controlCards.v1", JSON.stringify({ ${JSON.stringify(CHAT)}: ${JSON.stringify(cards)} }));
      return true;
    })()`);
    await evaluate("location.reload()");
    await sleep(1500);
    await attachWithRetry();
    await waitFor(`Boolean(globalThis.AccordAgentsMobile && document.querySelector("#control-cards .control-card"))`, "the chat came up with its card");
  };

  try {
    await attachWithRetry();

    // --- a card's own answer, sent with one tap -----------------------------
    await seed([card("card-custom")]);
    await evaluate(`(() => {
      const input = document.querySelector('#control-cards .control-card-custom input');
      input.focus();
      input.value = "the third one";
      return true;
    })()`);
    await waitFor(`document.getElementById("home-dock").hidden`, "the bar to leave while typing");
    await tapAt(await center("#control-cards .control-card-custom .control-card-option"));
    await waitFor(`AccordAgentsMobile.isCardLocked("card-custom")`, "the answer to be taken on the first tap", 3_000);
    await waitFor(dockShown, "the bar to come back once the tap has landed");

    // --- Allow/Deny beside a draft in the composer, with one tap ------------
    await seed([card("card-option", { allowsCustomAnswer: false })]);
    await evaluate(`(() => {
      const input = document.getElementById("composer-input");
      input.focus();
      input.value = "a draft";
      input.dispatchEvent(new Event("input"));
      return true;
    })()`);
    await waitFor(`document.getElementById("home-dock").hidden`, "the bar to leave while typing in the composer");
    await tapAt(await center('#control-cards .control-card-option[data-option-id="yes"]'));
    await waitFor(`AccordAgentsMobile.isCardLocked("card-option")`, "the option to be taken on the first tap", 3_000);
    assert.equal(await evaluate(`document.getElementById("composer-input").value`), "a draft", "the draft is left alone");

    // --- a chat opened from the search results keeps its bar ----------------
    await evaluate(`(() => { const input = document.getElementById("composer-input"); input.value = ""; input.dispatchEvent(new Event("input")); input.blur(); document.getElementById("back-to-chats").click(); return true; })()`);
    await waitFor(`document.getElementById("chat-list")?.offsetParent !== null`, "the chat list");
    await evaluate(`document.getElementById("chat-search-toggle").click()`);
    await waitFor(`!document.getElementById("chat-search").hidden`, "the search box to open");
    assert.equal(await evaluate(dockShown), false, "the bar steps aside while searching the chat list");
    await evaluate(`(() => {
      const input = document.getElementById("chat-search-input");
      input.value = "Tap";
      input.dispatchEvent(new Event("input"));
      return true;
    })()`);
    await waitFor(`document.querySelector('#chat-list [data-conversation-id=${JSON.stringify(CHAT)}]')`, "the chat in the results");
    await evaluate(`document.querySelector('#chat-list [data-conversation-id=${JSON.stringify(CHAT)}]').click()`);
    await waitFor(`document.getElementById("timeline-screen").classList.contains("is-active")`, "the chat to open");
    await waitFor(dockShown, "the chat opened from search to show its bar");
    const placement = await evaluate(`(() => {
      const dock = document.getElementById("home-dock").getBoundingClientRect();
      const composer = document.getElementById("composer-form").getBoundingClientRect();
      return { dock: document.querySelector(".mobile-phone").dataset.dock, dockTop: Math.round(dock.top), composerBottom: Math.round(composer.bottom) };
    })()`);
    assert.equal(placement.dock, "chat", "the bar sits in the chat's column");
    assert.ok(placement.dockTop >= placement.composerBottom - 1, `the bar is under the composer, not over it: ${JSON.stringify(placement)}`);
    t.diagnostic(JSON.stringify(placement));
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    await new Promise((resolve) => site.close(resolve));
    await rm(profile, { recursive: true, force: true });
  }
});
