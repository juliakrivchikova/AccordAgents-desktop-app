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
// The phone reaches no mailbox while this is set: every connection drops.
let mailboxDown = false;
const site = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname.startsWith("/v1/") && mailboxDown) {
    req.socket.destroy();
    return;
  }
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

// No message of its own unless a test gives it one: drawn at the chat's end,
// where what a card's fields do is the same as under a message.
function card(id, overrides = {}) {
  return {
    id,
    conversationId: CHAT,
    kind: "choice",
    status: "pending",
    title: "Which one?",
    summary: "Pick one",
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
  // Where the finger goes, once it has scrolled the target into sight: Cancel
  // and Submit end a long card and scroll with it.
  const center = (selector) => evaluate(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    target.scrollIntoView({ block: "nearest" });
    const rect = target.getBoundingClientRect();
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
  // Which of a card's fields get focused from script, and how. A note opened
  // by a link and focused from script came up behind the iPhone's keyboard
  // (the User, 2026-09-24); a field the finger taps is lifted, as the composer is.
  const watchFieldFocus = `(() => {
    window.__fieldFocus = [];
    const focus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (options) {
      const field = this.closest(".control-card-note") ? "note" : this.closest(".control-card-answer") ? "answer" : (this.id || this.tagName);
      window.__fieldFocus.push(field + (options && options.preventScroll ? ":held" : ":lifted"));
      return focus.call(this, options);
    };
    return true;
  })()`;

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
    // The note is open under the pick, for the finger to tap: nothing opens
    // it behind a link or focuses it from script.
    await evaluate(watchFieldFocus);
    await evaluate(`document.querySelector('#control-cards .control-card-choice[data-option-id="yes"]').click()`);
    const noteOpen = await evaluate(`(() => {
      const panel = document.querySelector('#control-cards .control-card-note');
      return {
        shown: !panel.hidden,
        under: panel.previousElementSibling && panel.previousElementSibling.dataset.optionId,
        link: document.querySelectorAll('#control-cards .control-card-add-note').length,
        focusedFromScript: window.__fieldFocus
      };
    })()`);
    assert.deepEqual(noteOpen, { shown: true, under: "yes", link: 0, focusedFromScript: [] },
      "the note box opens right under the picked option, and is taken by a tap");
    // It moves with the pick, and what is typed in it goes along.
    await evaluate(`(() => {
      const field = document.querySelector('#control-cards .control-card-note textarea');
      field.value = "moving";
      field.dispatchEvent(new Event("input"));
      document.querySelector('#control-cards .control-card-choice[data-option-id="no"]').click();
      return true;
    })()`);
    const moved = await evaluate(`(() => {
      const panel = document.querySelector('#control-cards .control-card-note');
      return { under: panel.previousElementSibling && panel.previousElementSibling.dataset.optionId, text: panel.querySelector("textarea").value };
    })()`);
    assert.deepEqual(moved, { under: "no", text: "moving" }, "the note moves under the new pick with its text");
    await evaluate(`(() => {
      document.querySelector('#control-cards .control-card-choice[data-option-id="yes"]').click();
      const field = document.querySelector('#control-cards .control-card-note textarea');
      field.value = "";
      field.dispatchEvent(new Event("input"));
      return true;
    })()`);
    // A pick and a note being typed survive a redraw of the chat.
    await evaluate(`(() => {
      const field = document.querySelector('#control-cards .control-card-note textarea');
      field.focus();
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
    await seed([card("card-cancel", { allowsCancel: true, recommendedOptionId: "yes" })]);
    await evaluate(`(() => { const field = document.querySelector('#control-cards .control-card-note textarea'); field.value = "never mind"; field.dispatchEvent(new Event("input")); return true; })()`);
    await tapAt(await center("#control-cards .control-card-cancel"));
    await waitFor(`AccordAgentsMobile.isCardLocked("card-cancel")`, "Cancel to be taken on the first tap", 3_000);
    await waitFor(`(() => { const panel = document.querySelector('#control-cards [data-card-id="card-cancel"] .control-card-note'); return !panel || panel.hidden; })()`,
      "a note typed before Cancel not to be shown as if it went with it", 3_000);
    const cancelled = await evaluate(`AccordAgentsMobile.listOutboxEntries().then((entries) => entries.filter((entry) => entry.kind === "choice.answered" && entry.payload.targetKey === "choice:card-cancel").map((entry) => entry.payload.detail.cancel))`);
    assert.deepEqual(cancelled, [true], "the choice is answered as cancelled");

    // --- a card's own answer, sent with one tap -----------------------------
    await seed([card("card-custom")]);
    const unpicked = await evaluate(`({
      picked: document.querySelectorAll('#control-cards .control-card-choice[aria-checked="true"]').length,
      submitDisabled: document.querySelector('#control-cards .control-card-submit').disabled
    })`);
    assert.deepEqual(unpicked, { picked: 0, submitDisabled: true }, "with no recommendation nothing is picked and Submit waits for a pick");
    await evaluate(watchFieldFocus);
    await evaluate(`document.querySelector('#control-cards .control-card-choice[data-option-id="custom"]').click()`);
    assert.deepEqual(await evaluate(`({ open: !document.querySelector('#control-cards .control-card-answer').hidden, focusedFromScript: window.__fieldFocus })`),
      { open: true, focusedFromScript: [] }, "picking your own answer opens its field for the finger to tap; nothing focuses it from script");
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
    // Marked as an own answer the way the desktop marks one: without it the
    // desktop looked for an option of that name and refused the answer.
    const ownAnswer = await evaluate(`AccordAgentsMobile.listOutboxEntries().then((entries) => entries.filter((entry) => entry.payload && entry.payload.targetKey === "choice:card-custom").map((entry) => [entry.payload.stateId, entry.payload.detail.selectedOptionId, entry.payload.detail.customAnswer]))`);
    assert.deepEqual(ownAnswer, [["__custom__", "__custom__", "the third one"]], "an own answer goes out as the desktop's own-answer option");

    // --- an answer the desktop refused ---------------------------------------
    // Refused, it stayed folded and pale "on its way" for an hour, the desktop
    // saying nothing (the User, 2026-10-01). The card the desktop sends now
    // names the refused answer; the phone stops waiting for that one only.
    const sentOperation = await evaluate(`AccordAgentsMobile.listOutboxEntries().then((entries) => entries.find((entry) => entry.payload && entry.payload.targetKey === "choice:card-custom").payload.operationId)`);
    const refuse = (operationId) => evaluate(`AccordAgentsMobile.handleRelayTimelinePayload(${JSON.stringify({
      type: "mobile.timeline.events", conversationId: CHAT, events: [],
      cards: [{ ...card("card-custom"), refusedAnswers: [{ operationId, reason: "Selected option was not found." }] }]
    })}, ${JSON.stringify(CHAT)}).then(() => true)`);
    const cardState = `(() => {
      const node = document.querySelector('#message-list [data-card-id="card-custom"]');
      const state = node && node.querySelector(".control-card-state");
      return { locked: AccordAgentsMobile.isCardLocked("card-custom"), folded: Boolean(node && node.classList.contains("control-card-folded")),
        state: state && !state.hidden ? state.textContent : "" };
    })()`;
    await refuse("choice:card-custom:another-answer");
    assert.deepEqual(await evaluate(cardState), { locked: true, folded: true, state: "Your answer: the third one" },
      "a refusal of some other answer leaves this phone's answer on its way");
    await refuse(sentOperation);
    await waitFor(`!AccordAgentsMobile.isCardLocked("card-custom") && !document.querySelector('#message-list [data-card-id="card-custom"]').classList.contains("control-card-folded")`, "the refused card to open again");
    assert.deepEqual(await evaluate(cardState), { locked: false, folded: false, state: "Selected option was not found." },
      "the refused answer's card opens again and says why");
    assert.deepEqual(await evaluate(`({
      picked: document.querySelector('#message-list [data-card-id="card-custom"] .control-card-choice[aria-checked="true"]').dataset.optionId,
      typed: document.querySelector('#message-list [data-card-id="card-custom"] .control-card-answer textarea').value
    })`), { picked: "custom", typed: "the third one" }, "it opens with what was picked and typed, not the recommendation and an empty box");
    // Answered again: folded at the tap, the old reason gone with it, though
    // the queue entry is written after the tap.
    assert.deepEqual(await evaluate(`(() => {
      document.querySelector('#message-list [data-card-id="card-custom"] .control-card-submit').click();
      const node = document.querySelector('#message-list [data-card-id="card-custom"]');
      return { folded: node.classList.contains("control-card-folded"), state: node.querySelector(".control-card-state").textContent };
    })()`), { folded: true, state: "Your answer: the third one" }, "an answer given again folds at the tap, without the old reason");
    await waitFor(`AccordAgentsMobile.isCardLocked("card-custom")`, "the answer given again to be taken");
    // The same answer is refused again under the card the phone already holds.
    await refuse(sentOperation);
    await waitFor(`!AccordAgentsMobile.isCardLocked("card-custom") && !document.querySelector('#message-list [data-card-id="card-custom"]').classList.contains("control-card-folded")`,
      "the same answer, refused again under an unchanged card, to open the card again");

    // --- a field a pick opens comes into sight in the chat -------------------
    // Picking "Write your own answer" at the bottom edge opened its box below
    // the fold, with nothing to say so. It is scrolled into sight in the chat,
    // without focus (a field focused from script came up behind the iPhone's
    // keyboard) and without moving the page (the User, 2026-09-24).
    const longOptions = [1, 2, 3, 4].map((index) => ({ id: "long-" + index, label: "Option " + index,
      description: "A long description, so the card grows past the height it is allowed and has to scroll." }));
    await seed([card("card-long", { options: longOptions })]);
    await evaluate(watchFieldFocus);
    const revealed = await evaluate(`(() => {
      const surface = document.getElementById("message-list").closest(".thread-surface");
      const row = document.querySelector('#control-cards .control-card-choice[data-option-id="custom"]');
      // The finger has scrolled just far enough to see the row at the bottom edge.
      surface.scrollTop += row.getBoundingClientRect().top - surface.getBoundingClientRect().bottom + 40;
      const pageBefore = document.scrollingElement.scrollTop;
      row.click();
      const box = surface.getBoundingClientRect();
      const field = document.querySelector('#control-cards .control-card-answer textarea').getBoundingClientRect();
      return { scrolls: surface.scrollHeight > surface.clientHeight, inSight: field.bottom <= box.bottom + 1 && field.top >= box.top,
        pageMoved: document.scrollingElement.scrollTop !== pageBefore, focusedFromScript: window.__fieldFocus };
    })()`);
    assert.deepEqual({ scrolls: revealed.scrolls, inSight: revealed.inSight, pageMoved: revealed.pageMoved, focusedFromScript: revealed.focusedFromScript },
      { scrolls: true, inSight: true, pageMoved: false, focusedFromScript: [] },
      "the box a pick opens is brought into sight in the chat, not focused and without moving the page");

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
    await waitFor(`(() => { const panel = document.querySelector('#control-cards [data-card-id="card-option"] .control-card-note'); return !panel || panel.hidden; })()`,
      "a card sent without a note not to keep an empty note box open", 3_000);
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

    // --- a message on its way fades and says nothing about it -------------
    // "Waiting to sync" under the message and in the header was detail the
    // User does not need; the message fades until it is delivered (the User,
    // 2026-09-24).
    await evaluate(`AccordAgentsMobile.enqueueMessage({ conversationId: ${JSON.stringify(CHAT)}, content: "still on its way" }).then(() => { document.dispatchEvent(new Event("visibilitychange")); return true; })`);
    const pendingMessage = await waitFor(`(() => {
      const row = [...document.querySelectorAll("#message-list .message-row")].find((node) => node.innerText.includes("still on its way"));
      if (!row) return null;
      return { onItsWay: row.classList.contains("is-on-its-way"), status: row.querySelector(".message-status").textContent,
        opacity: getComputedStyle(row.querySelector(".message-bubble")).opacity, header: document.getElementById("connection-state").textContent };
    })()`, "the queued message on screen");
    assert.equal(pendingMessage.onItsWay, true, "the message on its way is faded");
    assert.equal(pendingMessage.opacity, "0.6");
    assert.doesNotMatch(pendingMessage.status + " " + pendingMessage.header, /Waiting to sync|Syncing/, "nothing says how far it has got");
    // A send that could not get through at all is still said, in the header:
    // nothing else would say it.
    assert.deepEqual(await evaluate(`["waiting-to-sync", undefined].map(AccordAgentsMobile.connectionStatusText)`), ["Synced", "Synced"],
      "a send on its way is not the chat's state");
    await evaluate(`AccordAgentsMobile.flushOutbox().then(() => { document.dispatchEvent(new Event("visibilitychange")); return true; })`);
    await waitFor(`(() => { const row = [...document.querySelectorAll("#message-list .message-row")].find((node) => node.innerText.includes("still on its way")); return row && !row.classList.contains("is-on-its-way"); })()`,
      "the delivered message at full strength");
    // "Not connected" stays from a send that reached nothing until one gets
    // through, not only on the render right after it (review, 2026-10-01).
    const header = `document.getElementById("connection-state").textContent`;
    mailboxDown = true;
    assert.equal(await evaluate(`AccordAgentsMobile.enqueueMessage({ conversationId: ${JSON.stringify(CHAT)}, content: "sent with nothing to reach" }).then(() => AccordAgentsMobile.flushOutbox()).then((result) => result.status)`),
      "unreachable");
    await evaluate(`(() => { document.dispatchEvent(new Event("visibilitychange")); return true; })()`);
    await sleep(500);
    await waitFor(`${header} === "Not connected"`, "the header to keep saying a send reaches nothing after a later redraw");
    mailboxDown = false;
    await evaluate(`AccordAgentsMobile.flushOutbox().then(() => { document.dispatchEvent(new Event("visibilitychange")); return true; })`);
    await waitFor(`${header} === "Synced"`, "the header to say Synced once a send got through");

    // --- a thread keeps its heading while a member writes into it ----------
    // Every update wrote the chat's name into the heading and "Thread" back
    // after its reads, so an open thread's heading flipped between the two
    // while a member streamed into it (the User, 2026-09-24).
    const threadBatch = (n) => {
      const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
      const row = (id, content, minutes, extra = {}) => ({ id, messageId: id, role: "participant", participantLabel: "@drew", content, status: "done", createdAt: at(minutes), ...extra });
      return { type: "mobile.timeline.events", conversationId: CHAT, cards: [], events: [
        row("thread-root", "A message with a thread under it", 10),
        row("thread-reply-1", "The first reply", 9, { threadRootId: "thread-root" }),
        row("thread-live-" + n, "update " + n, 0.01, { threadRootId: "thread-root" })
      ] };
    };
    await evaluate(`AccordAgentsMobile.handleRelayTimelinePayload(${JSON.stringify(threadBatch(0))}, ${JSON.stringify(CHAT)})`);
    await waitFor(`Boolean(document.querySelector('#message-list .thread-chip'))`, "the thread's reply chip");
    await evaluate(`document.querySelector('#message-list .thread-chip').click()`);
    await waitFor(`document.getElementById("chat-title").textContent === "Thread"`, "the thread to open");
    await evaluate(`(() => {
      window.__headings = [];
      const heading = document.getElementById("chat-title");
      new MutationObserver(() => window.__headings.push(heading.textContent)).observe(heading, { childList: true, characterData: true, subtree: true });
      return true;
    })()`);
    for (let n = 1; n <= 5; n += 1) {
      await evaluate(`AccordAgentsMobile.handleRelayTimelinePayload(${JSON.stringify(threadBatch(n))}, ${JSON.stringify(CHAT)})`);
      await sleep(200);
    }
    await waitFor(`document.querySelector('#message-list') && document.querySelector('#message-list').innerText.includes("update 5")`, "the last update in the thread");
    assert.deepEqual(await evaluate(`window.__headings.filter((text) => text !== "Thread")`), [], "the heading stays Thread through every update");
    await evaluate(`document.getElementById("back-to-timeline").click()`);
    await waitFor(`document.getElementById("chat-title").textContent === "Tap test"`, "the chat's name back on its main list");

    // --- waiting cards are in the chat, not in a strip of their own ---------
    // A strip above the composer cut the cards off against the chat and read
    // as a card going under the text (the User, 2026-09-24). A choice stands
    // under the message that asked it, as on the desktop; what has no message
    // on screen is the chat's last item. Both scroll with the chat.
    const askedCard = card("card-asked", { recommendedOptionId: "yes", sourceMessageId: "asked-message" });
    const loneCard = card("card-lone", { kind: "permission", title: "Run a command", summary: "npm test",
      options: [{ id: "allow", label: "Allow" }, { id: "deny", label: "Deny" }], allowsCustomAnswer: false, sourceMessageId: undefined });
    await seed([askedCard, loneCard]);
    const history = Array.from({ length: 12 }, (_, index) => ({
      id: "history-" + index, messageId: "history-" + index, role: "participant", participantLabel: "@drew",
      content: "Message " + index + " with enough words to take a couple of lines on a phone screen.",
      status: "done", createdAt: new Date(Date.now() - (60 - index) * 60_000).toISOString()
    }));
    history.push({ id: "asked-message", messageId: "asked-message", role: "participant", participantLabel: "@drew",
      content: "Which one should we take?", status: "done", createdAt: new Date(Date.now() - 30 * 60_000).toISOString() });
    history.push({ id: "after-ask", messageId: "after-ask", role: "participant", participantLabel: "@drew",
      content: "A message after the question.", status: "done", createdAt: new Date(Date.now() - 20 * 60_000).toISOString() });
    await evaluate(`AccordAgentsMobile.handleRelayTimelinePayload(${JSON.stringify({ type: "mobile.timeline.events", conversationId: CHAT, cards: [askedCard, loneCard], events: history })}, ${JSON.stringify(CHAT)})`);
    await waitFor(`document.getElementById("message-list").innerText.includes("A message after the question.")`, "the history on screen");
    await waitFor(`Boolean(document.querySelector('#message-list [data-card-id="card-asked"]'))`, "the choice in the chat");
    const placed = await evaluate(`(() => {
      const list = document.getElementById("message-list");
      const asked = list.querySelector('[data-card-id="card-asked"]');
      const askedRow = asked.closest(".message-row");
      const lone = list.querySelector('[data-card-id="card-lone"]');
      return {
        underItsMessage: Boolean(askedRow) && askedRow.innerText.includes("Which one should we take?"),
        loneLast: Boolean(lone) && list.lastElementChild.contains(lone),
        inChatScroll: Boolean(asked.closest(".thread-surface")) && Boolean(lone.closest(".thread-surface")),
        strip: Boolean(document.querySelector("#timeline-screen > .control-cards"))
      };
    })()`);
    assert.deepEqual(placed, { underItsMessage: true, loneLast: true, inChatScroll: true, strip: false },
      "the choice stands under its message, the permission ends the chat, both scroll with it");
    // Cancel and Submit end the card and scroll with it: pinned to the foot of
    // a long choice, they lay on top of the options (the User, 2026-09-24).
    const actions = await evaluate(`(() => {
      const card = document.querySelector('[data-card-id="card-asked"]');
      const row = card.querySelector('.control-card-actions');
      const before = card.querySelector('.control-card-choices').getBoundingClientRect();
      const afterOptions = Boolean(card.querySelector('.control-card-choices').compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING);
      return { position: getComputedStyle(row).position, afterOptions, clear: Math.round(row.getBoundingClientRect().top) >= Math.round(before.bottom) };
    })()`);
    assert.deepEqual(actions, { position: "static", afterOptions: true, clear: true }, "Cancel and Submit come after the options, not over them");
    // A row leaving above the question does not take the keyboard from its
    // card: the rows below it used to be moved one by one before the leaver
    // was removed, and a moved row loses the focus inside it (review,
    // 2026-09-24).
    await evaluate(`(() => {
      document.querySelector('[data-card-id="card-asked"] .control-card-note textarea').focus();
      const list = document.getElementById("message-list");
      const leaver = document.createElement("li");
      leaver.className = "message-row";
      leaver.dataset.rowKey = "a-row-no-longer-there";
      list.insertBefore(leaver, list.firstElementChild);
      return true;
    })()`);
    await evaluate(`AccordAgentsMobile.handleRelayTimelinePayload(${JSON.stringify({ type: "mobile.timeline.events", conversationId: CHAT, cards: [askedCard, loneCard], events: [
      { id: "later", messageId: "later", role: "participant", participantLabel: "@stephan", content: "Another member writing.", status: "done", createdAt: new Date().toISOString() }
    ] })}, ${JSON.stringify(CHAT)})`);
    await waitFor(`!document.querySelector('[data-row-key="a-row-no-longer-there"]') && document.getElementById("message-list").innerText.includes("Another member writing.")`, "the next render");
    assert.equal(await evaluate(`document.activeElement === document.querySelector('[data-card-id="card-asked"] .control-card-note textarea')`), true,
      "the note under its message keeps the focus while a row above leaves");
    await evaluate(`document.activeElement.blur()`);
    // Answering it from under its message sends it, and the row keeps the card.
    await evaluate(`document.querySelector('[data-card-id="card-asked"] .control-card-submit').click()`);
    await waitFor(`AccordAgentsMobile.isCardLocked("card-asked")`, "the answer from under its message", 3_000);
    assert.equal(await evaluate(`Boolean(document.querySelector('[data-card-id="card-asked"]').closest(".message-row"))`), true,
      "the sent card stays under its message");
    // On its way, the card folds at once to what was answered and fades;
    // how far the answer has got is not spelled out (the User, 2026-09-24).
    await waitFor(`Boolean(document.querySelector('[data-card-id="card-asked"].control-card-folded'))`, "the card folded", 3_000);
    assert.deepEqual(await evaluate(`(() => {
      const card = document.querySelector('[data-card-id="card-asked"]');
      const state = card.querySelector(".control-card-state");
      return { folded: card.classList.contains("control-card-folded"), onItsWay: card.classList.contains("is-on-its-way"),
        opacity: getComputedStyle(card).opacity, text: state ? state.innerText : "",
        options: card.querySelectorAll(".control-card-choice, .control-card-submit").length };
    })()`), { folded: true, onItsWay: true, opacity: "0.6", text: "Your answer: Yes", options: 0 },
      "a sent card folds to its answer and fades");

    // A question stands under the message that asked it and nowhere else, as
    // on the desktop: not at the chat's end before that message arrives, and
    // in the thread, not the main chat, when it was asked in a thread (the
    // User, 2026-10-01: a question asked in a thread stood at the bottom).
    const lateCard = card("card-late", { recommendedOptionId: "yes", sourceMessageId: "late-message" });
    const threadCard = card("card-in-thread", { recommendedOptionId: "yes", sourceMessageId: "thread-question" });
    const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
    await evaluate(`AccordAgentsMobile.handleRelayTimelinePayload(${JSON.stringify({ type: "mobile.timeline.events", conversationId: CHAT, cards: [lateCard, threadCard], events: [
      { id: "q-root", messageId: "q-root", role: "participant", participantLabel: "@drew", content: "A message with a question in its thread.", status: "done", createdAt: at(2) },
      { id: "thread-question", messageId: "thread-question", role: "participant", participantLabel: "@drew", content: "The question, asked in the thread.", status: "done", createdAt: at(1), threadRootId: "q-root" }
    ] })}, ${JSON.stringify(CHAT)})`);
    await waitFor(`document.getElementById("message-list").innerText.includes("A message with a question in its thread.")`, "the thread's first message");
    assert.deepEqual(await evaluate(`({ late: Boolean(document.querySelector('#message-list [data-card-id="card-late"]')),
      thread: Boolean(document.querySelector('#message-list [data-card-id="card-in-thread"]')) })`), { late: false, thread: false },
      "neither question stands in the main chat: one's message has not come, the other's is in a thread");
    await evaluate(`AccordAgentsMobile.handleRelayTimelinePayload(${JSON.stringify({ type: "mobile.timeline.events", conversationId: CHAT, cards: [lateCard, threadCard], events: [
      { id: "late-message", messageId: "late-message", role: "participant", participantLabel: "@drew", content: "The question, arriving late.", status: "done", createdAt: at(0) }
    ] })}, ${JSON.stringify(CHAT)})`);
    await waitFor(`Boolean(document.querySelector('#message-list .message-row [data-card-id="card-late"]'))`, "the late question under its message once that arrives");
    assert.equal(await evaluate(`document.querySelector('#message-list [data-card-id="card-late"]').closest(".message-row").innerText.includes("The question, arriving late.")`), true,
      "the late question stands under its own message");
    await evaluate(`[...document.querySelectorAll('#message-list .message-row')].find((row) => row.innerText.includes("A message with a question in its thread.")).querySelector('.thread-chip').click()`);
    await waitFor(`document.getElementById("chat-title").textContent === "Thread"`, "the thread to open");
    await waitFor(`Boolean(document.querySelector('#message-list .message-row [data-card-id="card-in-thread"]'))`, "the thread's question in the thread");
    assert.equal(await evaluate(`document.querySelector('#message-list [data-card-id="card-in-thread"]').closest(".message-row").innerText.includes("The question, asked in the thread.")`), true,
      "the question asked in a thread stands under its message in the thread");
    await evaluate(`document.getElementById("back-to-timeline").click()`);
    await waitFor(`document.getElementById("chat-title").textContent === "Tap test"`, "the chat's main list again");

    // --- a field being typed in stays put while a message lands above it ----
    // Chrome anchors the scroll itself; Safari on the iPhone does not, and the
    // field slid down under the keyboard mid-word. Anchoring is turned off here
    // to see what the iPhone sees (review, 2026-10-01). The question stands
    // under its message, the chat's last; a message from a longer run is
    // sorted in right above it, as one finished late with an earlier start is.
    const typingCard = card("card-typing", { recommendedOptionId: "yes", sourceMessageId: "typing-question" });
    const earlier = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
    const typingRows = Array.from({ length: 30 }, (_, index) => ({ id: "filler-" + index, messageId: "filler-" + index, role: "participant", participantLabel: "@drew",
      content: "Filler message " + index + ", long enough to take a line or two on a phone screen.", status: "done", createdAt: earlier(60 - index) }));
    typingRows.push({ id: "typing-question", messageId: "typing-question", role: "participant", participantLabel: "@drew",
      content: "The question being answered.", status: "done", createdAt: new Date(Date.now() + 60_000).toISOString() });
    await evaluate(`AccordAgentsMobile.handleRelayTimelinePayload(${JSON.stringify({ type: "mobile.timeline.events", conversationId: CHAT, cards: [typingCard], events: typingRows })}, ${JSON.stringify(CHAT)})`);
    const typingField = `document.querySelector('#message-list .message-row [data-card-id="card-typing"] .control-card-note textarea')`;
    await waitFor(`Boolean(${typingField})`, "the question's card under its message");
    await evaluate(`(() => {
      const style = document.createElement("style");
      style.textContent = "* { overflow-anchor: none !important; }";
      document.head.append(style);
      const surface = document.getElementById("message-list").closest(".thread-surface");
      surface.scrollTop = surface.scrollHeight;
      ${typingField}.focus();
      return true;
    })()`);
    // Typing for a moment: the bar has left for the keyboard by then.
    await sleep(600);
    const fieldTop = await evaluate(`${typingField}.getBoundingClientRect().top`);
    await evaluate(`AccordAgentsMobile.handleRelayTimelinePayload(${JSON.stringify({ type: "mobile.timeline.events", conversationId: CHAT, cards: [typingCard],
      events: [{ id: "arriving", messageId: "arriving", role: "participant", participantLabel: "@drew", content: "A message landing above while the note is typed.", status: "done", createdAt: earlier(0) }] })}, ${JSON.stringify(CHAT)})`);
    await waitFor(`document.getElementById("message-list").innerText.includes("A message landing above while the note is typed.")`, "the message to land");
    const afterArrival = await evaluate(`({ top: ${typingField}.getBoundingClientRect().top, focused: document.activeElement === ${typingField} })`);
    assert.ok(afterArrival.focused && Math.abs(afterArrival.top - fieldTop) <= 1,
      `the field being typed in stays where it was when a message lands above it: ${fieldTop} -> ${JSON.stringify(afterArrival)}`);
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    await new Promise((resolve) => site.close(resolve));
    await rm(profile, { recursive: true, force: true });
  }
});
