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

    // --- a choice looks and answers like the desktop's ----------------------
    // The User, 2026-09-22: the phone showed bare option pills, no
    // descriptions and no recommendation. Now every option is a numbered row
    // with its description, the recommended one is marked and picked, and
    // Submit answers.
    await seed([card("card-recommended", {
      recommendedOptionId: "no",
      options: [
        { id: "yes", label: "Yes", description: "Ship it today." },
        { id: "no", label: "No", description: "Wait for the review." }
      ]
    })]);
    const laidOut = await evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('#control-cards .control-card-choice'));
      return {
        rows: rows.map((row) => row.dataset.optionId + ":" + row.getAttribute("aria-checked")),
        recommended: Array.from(document.querySelectorAll('#control-cards .control-card-recommended')).map((chip) => chip.closest(".control-card-choice").dataset.optionId),
        descriptions: Array.from(document.querySelectorAll('#control-cards .control-card-choice-description')).map((node) => node.textContent),
        submitEnabled: !document.querySelector('#control-cards .control-card-submit').disabled
      };
    })()`);
    assert.deepEqual(laidOut.rows, ["yes:false", "no:true", "custom:false"], "the recommended option is picked up front");
    assert.deepEqual(laidOut.recommended, ["no"], "and marked Recommended");
    assert.deepEqual(laidOut.descriptions.slice(0, 2), ["Ship it today.", "Wait for the review."], "every option shows its description");
    assert.equal(laidOut.submitEnabled, true, "the recommendation can be sent as it stands");
    // A pick and a note being typed survive a redraw of the chat.
    await evaluate(`(() => {
      document.querySelector('#control-cards .control-card-choice[data-option-id="yes"]').click();
      document.querySelector('#control-cards .control-card-add-note').click();
      const field = document.querySelector('#control-cards .control-card-note textarea');
      field.value = "after lunch";
      field.dispatchEvent(new Event("input"));
      window.__cardNode = document.querySelector('#control-cards .control-card');
      document.dispatchEvent(new Event("visibilitychange"));
      return true;
    })()`);
    await sleep(1500);
    const survived = await evaluate(`(() => {
      const node = document.querySelector('#control-cards .control-card');
      const field = node.querySelector('.control-card-note textarea');
      return { same: node === window.__cardNode, value: field.value, focused: document.activeElement === field,
        picked: node.querySelector('.control-card-choice[aria-checked="true"]').dataset.optionId };
    })()`);
    assert.deepEqual(survived, { same: true, value: "after lunch", focused: true, picked: "yes" }, "the card is not drawn again under the typing");
    // Picking alone answers nothing; Submit, tapped once with the keyboard up, does.
    assert.equal(await evaluate(`AccordAgentsMobile.isCardLocked("card-recommended")`), false, "a pick is not an answer");
    await tapAt(await center("#control-cards .control-card-submit"));
    await waitFor(`AccordAgentsMobile.isCardLocked("card-recommended")`, "Submit to be taken on the first tap", 3_000);
    const sentChoice = await evaluate(`AccordAgentsMobile.listOutboxEntries().then((entries) => entries.filter((entry) => entry.kind === "choice.answered").map((entry) => entry.payload.detail))`);
    assert.deepEqual(sentChoice.map((detail) => [detail.selectedOptionId, detail.note]), [["yes", "after lunch"]], "the pick goes with its note");
    await waitFor(dockShown, "the bar to come back once Submit has landed");

    // A choice a machine raised is built on the phone: it carries the
    // recommendation the same way, and only when it names one of the options.
    const machineCards = await evaluate(`[
      AccordAgentsMobile.machineChoiceCard("c", { id: "m1", createdAt: "2026-09-23T00:00:00.000Z", metadata: { pendingChoice: { id: "q1", title: "T", question: "Q", status: "pending", recommendedOptionId: "b", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] } } }).recommendedOptionId,
      AccordAgentsMobile.machineChoiceCard("c", { id: "m2", createdAt: "2026-09-23T00:00:00.000Z", metadata: { pendingChoice: { id: "q2", title: "T", question: "Q", status: "pending", recommendedOptionId: "gone", options: [{ id: "a", label: "A" }] } } }).recommendedOptionId ?? null
    ]`);
    assert.deepEqual(machineCards, ["b", null], "a machine's choice carries its recommendation as the desktop's does");

    // --- Cancel on the card cancels the choice --------------------------------
    await seed([card("card-cancel", { allowsCancel: true })]);
    await tapAt(await center("#control-cards .control-card-cancel"));
    await waitFor(`AccordAgentsMobile.isCardLocked("card-cancel")`, "Cancel to be taken on the first tap", 3_000);
    const cancelled = await evaluate(`AccordAgentsMobile.listOutboxEntries().then((entries) => entries.filter((entry) => entry.kind === "choice.answered" && entry.payload.targetKey === "choice:card-cancel").map((entry) => entry.payload.detail.cancel))`);
    assert.deepEqual(cancelled, [true], "the choice is answered as cancelled");

    // --- a card's own answer, sent with one tap -----------------------------
    await seed([card("card-custom")]);
    const unpicked = await evaluate(`({
      picked: document.querySelectorAll('#control-cards .control-card-choice[aria-checked="true"]').length,
      submitDisabled: document.querySelector('#control-cards .control-card-submit').disabled
    })`);
    assert.deepEqual(unpicked, { picked: 0, submitDisabled: true }, "with no recommendation nothing is picked and Submit waits for a pick");
    await evaluate(`document.querySelector('#control-cards .control-card-choice[data-option-id="custom"]').click()`);
    const emptyAnswer = await evaluate(`({
      submitDisabled: document.querySelector('#control-cards .control-card-submit').disabled,
      hint: !document.querySelector('#control-cards .control-card-hint').hidden
    })`);
    assert.deepEqual(emptyAnswer, { submitDisabled: true, hint: true }, "an empty own answer cannot be sent, and the card says why");
    await evaluate(`(() => {
      const field = document.querySelector('#control-cards .control-card-answer textarea');
      field.focus();
      field.value = "the third one";
      field.dispatchEvent(new Event("input"));
      return true;
    })()`);
    await waitFor(`document.getElementById("home-dock").hidden`, "the bar to leave while typing");
    await tapAt(await center("#control-cards .control-card-submit"));
    await waitFor(`AccordAgentsMobile.isCardLocked("card-custom")`, "the answer to be taken on the first tap", 3_000);
    await waitFor(dockShown, "the bar to come back once the tap has landed");

    // --- an option picked beside a draft in the composer, with one tap ------
    await seed([card("card-option", { allowsCustomAnswer: false })]);
    await evaluate(`(() => {
      const input = document.getElementById("composer-input");
      input.focus();
      input.value = "a draft";
      input.dispatchEvent(new Event("input"));
      return true;
    })()`);
    await waitFor(`document.getElementById("home-dock").hidden`, "the bar to leave while typing in the composer");
    await tapAt(await center('#control-cards .control-card-choice[data-option-id="yes"]'));
    await waitFor(`document.querySelector('#control-cards .control-card-choice[data-option-id="yes"]').getAttribute("aria-checked") === "true"`, "the option to be picked on the first tap", 3_000);
    await tapAt(await center("#control-cards .control-card-submit"));
    await waitFor(`AccordAgentsMobile.isCardLocked("card-option")`, "the answer to be sent", 3_000);
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

    // --- Send, tapped with a finger, puts the keyboard away for good --------
    // The send folded the composer at once, which moved the text field under
    // the finger before the tap's click: the click landed on the field, and
    // on iOS that raises the keyboard again (the User, 2026-09-22).
    await evaluate(`(() => {
      window.__clicks = [];
      document.addEventListener("click", (event) => window.__clicks.push(event.target.closest("#send-button") ? "send-button" : (event.target.id || event.target.tagName)), true);
      const input = document.getElementById("composer-input");
      input.focus();
      input.value = "sent with a finger";
      input.dispatchEvent(new Event("input"));
      return true;
    })()`);
    await waitFor(`document.getElementById("composer-form").dataset.expanded === "1"`, "the composer to open for typing");
    const sendPoint = await center("#send-button");
    await app.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await app.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...sendPoint, radiusX: 1, radiusY: 1, force: 1 }] });
    await sleep(50);
    await app.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await app.send("Emulation.setTouchEmulationEnabled", { enabled: false, maxTouchPoints: 1 });
    await waitFor(`AccordAgentsMobile.listOutboxEntries().then((entries) => entries.some((entry) => entry.payload && entry.payload.content === "sent with a finger"))`, "the message to be sent");
    await waitFor(`window.__clicks.length > 0 && document.getElementById("composer-form").dataset.expanded === ""`, "the tap's click and the composer folding back to one line");
    const afterSend = await evaluate(`({ clicks: window.__clicks, active: document.activeElement && (document.activeElement.id || document.activeElement.tagName) })`);
    assert.deepEqual(afterSend.clicks, ["send-button"], `the tap's click lands on Send, not on the text field: ${JSON.stringify(afterSend)}`);
    assert.notEqual(afterSend.active, "composer-input", "the text field is not focused again after the send");
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    await new Promise((resolve) => site.close(resolve));
    await rm(profile, { recursive: true, force: true });
  }
});
