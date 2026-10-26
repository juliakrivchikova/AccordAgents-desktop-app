/**
 * Activity on the phone, driven through the real PWA in a browser.
 *
 * The desktop's part is played the way the desktop plays it now: its chat
 * changes and cards, signed and published on the User's own server (a real
 * hub here), which the paired phone reads. Nothing is written into the
 * phone's storage by hand, and no chat is read for the test: Activity lists
 * what the server's chat list carries for every chat, and the pages of the
 * chats the phone opens. Then the bottom bar is used: a permission is
 * allowed and a choice answered from Activity, a run is stopped from it, a
 * finished update opens its chat, and a card the desktop settles leaves the
 * list at once (the next list the phone asks for says so; the cards here
 * reached it seconds before).
 *
 * This is a browser check, not the installed phone: it runs the same files the
 * phone runs, under the same origin headers, but a physically installed PWA is
 * not claimed by it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { rm } from "node:fs/promises";
import { attachApp, launchChrome, member, pairPage, serveMobileShell, sleep, startMobileHub, tempProfile } from "./mobile-hub-fixture.mjs";

const require = createRequire(import.meta.url);
const SITE_PORT = 8215;
const CDP_PORT = 9385;
const CHAT_POLISH = "conv-activity-polish";
const CHAT_CLOUD = "conv-activity-cloud";
const DREW = member("drew");
const TAYLOR = member("taylor");
const MORGAN = member("morgan", { kind: "codex-cli" });

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const doneMessage = (id, author, content, minutes, metadata) => ({
  id, role: "participant", participantId: author.id, participantLabel: `@${author.handle}`, content, status: "done", createdAt: minutesAgo(minutes),
  ...(metadata ? { metadata } : {})
});
const pendingChoice = (id, title, question, options, status) => ({
  id, title, question, options, status,
  ...(status === "selected" ? { selectedOptionId: options[0].id, selectedAt: new Date().toISOString() } : {}),
  ...(status === "cancelled" ? { cancelledAt: new Date().toISOString() } : {})
});
const question = (status) => doneMessage("q1", TAYLOR, "Review is green. Which target should the deploy go to?", 1, { pendingChoice: pendingChoice("choice-deploy", "Deploy target", "Where should this deploy go?", [
  { id: "staging", label: "Deploy to staging now — the phone picks it up the next time it opens" },
  { id: "preview", label: "Publish a preview from main first" }
], status) });
// A run still in progress: the member's message while it works.
const taylorRun = {
  id: "t-run", role: "participant", participantId: TAYLOR.id, participantLabel: "@taylor",
  content: "Reviewing the diff now.", status: "pending", createdAt: minutesAgo(0.5), metadata: { runId: "run-taylor-1" }
};
const polishMessages = [
  { id: "u1", role: "user", content: "@drew can you check the unread dot?", status: "done", createdAt: minutesAgo(12) },
  doneMessage("m1", DREW, "Found it. The dot was only cleared on list taps.", 10),
  // A reply in the thread under @drew's first message.
  doneMessage("m2", DREW, "Fixed. The badge clears too now.", 6, { chatThreadRootId: "m1" }),
  question("pending"),
  taylorRun
];
const swipeQuestion = (status) => doneMessage("q2", TAYLOR, "Cancel me from the list?", 0, { pendingChoice: pendingChoice("choice-swipe", "Swipe target", "Cancel me from the list?", [
  { id: "yes", label: "Yes" }, { id: "no", label: "No" }
], status) });
const cloudQuestion = (status) => doneMessage("c-question", MORGAN, "Which region should the machine move to?", 5, { pendingChoice: pendingChoice("choice-cloud", "Region", "Which region should the machine move to?", [
  { id: "eu", label: "Stay in eu-west-1" }, { id: "us", label: "Move to us-east-1" }
], status) });
const cloudMessages = [doneMessage("c1", MORGAN, "The machine is up and the runtime connected.", 18), cloudQuestion("pending")];
const approvalOf = (fields) => ({
  conversationId: CHAT_POLISH, requesterRoleConfigId: "software-engineer", toolName: "Bash", capability: "shell", status: "pending",
  request: { command: "npm run deploy:mobile" }, updatedAt: new Date().toISOString(), ...fields
});
const deployApproval = approvalOf({
  id: "perm-deploy", requesterParticipantId: DREW.id, requesterHandle: "drew",
  summary: "Grant @drew shell allow prefix \"npm run deploy:mobile\"", createdAt: minutesAgo(3), codexDecisionId: "native-decision-9"
});
// A permission whose summary is long and multi-line: answered in the row, so
// every word of it has to be on screen, the end included.
const longCommand = "Codex wants to run: " + "echo checking; ".repeat(30) + "\nrm -rf build/cache";
const cloudApproval = approvalOf({
  id: "perm-cloud", conversationId: CHAT_CLOUD, requesterParticipantId: MORGAN.id, requesterHandle: "morgan",
  summary: longCommand, machineName: "Cloud · eu-west-1", createdAt: minutesAgo(4), request: { command: "rm -rf build/cache" }
});
const chatBarApproval = approvalOf({
  id: "perm-chat-bar", conversationId: CHAT_CLOUD, requesterParticipantId: MORGAN.id, requesterHandle: "morgan",
  summary: "Codex wants to run: npm run build:mobile", createdAt: new Date().toISOString(), request: { command: "npm run build:mobile" }
});

// Taps within this long of a redraw are ignored by the shell.
const TAP_SETTLE_MS = 600;

/** A left swipe on a row: the finger travels far enough for the list to hand
 *  the gesture over, and the row settles open. */
async function swipeLeft(app, selector) {
  const point = await app.touchStart(selector);
  for (const dx of [-20, -50, -90, -110]) {
    await app.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: point.x + dx, y: point.y, radiusX: 1, radiusY: 1, force: 1 }]
    });
    await sleep(40);
  }
  await app.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: []
  });
  await sleep(300);
}

test("Activity lists what the server delivered and acts on it from the bottom bar", { timeout: 300_000 }, async (t) => {
  const { createChatEventDeviceIdentity } = require("../dist/main/main/services/chatEventLog.js");
  const machine = createChatEventDeviceIdentity(new Date().toISOString());
  const hub = await startMobileHub({ rosterDevices: [
    { deviceId: machine.originId, publicKeyDerBase64: machine.publicKeyDerBase64, role: "machine", name: "Cloud machine", machineId: "m1" }
  ] });
  const site = await serveMobileShell({ port: SITE_PORT, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-activity-");
  const chrome = launchChrome({ port: CDP_PORT, profile, url: `${site.origin}/` });
  let app;
  try {
    await hub.createChat(CHAT_POLISH, { title: "PWA polish round", participants: [DREW, TAYLOR], createdAt: minutesAgo(30), messages: polishMessages });
    await hub.createChat(CHAT_CLOUD, { title: "Cloud machine setup", participants: [MORGAN], createdAt: minutesAgo(30), messages: cloudMessages });
    await hub.raiseApproval(CHAT_POLISH, deployApproval);
    await hub.raiseApproval(CHAT_CLOUD, cloudApproval);
    app = await attachApp({ port: CDP_PORT });
    const evaluate = app.evaluate;
    const waitFor = async (expr, label, tries = 60) => {
      let value;
      for (let i = 0; i < tries; i += 1) {
        value = await evaluate(expr).catch(() => null);
        if (value) return value;
        await sleep(500);
      }
      assert.fail(`timed out waiting for ${label}`);
    };
    const reload = async () => {
      await app.send("Page.reload", {});
      await sleep(800);
      await waitFor(`document.readyState === "complete" && Boolean(globalThis.AccordAgentsMobile) ? true : null`, "the reloaded page");
    };
    // Any change to a chat on the server: the phone hears of it and reads
    // the chat list again (and the open chat's newest page, when it is open).
    const touchChat = (conversationId) => hub.changeChat(conversationId, [{ type: "conversation.updated", metadata: { autoTitle: false } }]);
    const storedEvents = (store, kind) => evaluate(`(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("accordagents-mobile-control");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const rows = await new Promise((resolve) => {
        const all = db.transaction(${JSON.stringify(store)}, "readonly").objectStore(${JSON.stringify(store)}).getAll();
        all.onsuccess = () => resolve(all.result);
        all.onerror = () => resolve([]);
      });
      db.close();
      return rows.filter((row) => row.kind === ${JSON.stringify(kind)});
    })()`);
    const tabCounts = `[...document.querySelectorAll(".act-tab")].map((tab) => tab.innerText.replace(/\\s+/g, " ").trim()).join("|")`;
    const listRows = (tab) => `(() => {
      const list = document.getElementById("activity-list");
      if (!document.getElementById("activity-screen").classList.contains("is-active") || list.dataset.activityTab !== ${JSON.stringify(tab)}) return null;
      return [...list.querySelectorAll(".act-row")].map((row) => ({
        key: row.dataset.activityKey, card: row.dataset.cardId || "", text: row.innerText.replace(/\\s+/g, " ").trim(), unread: row.classList.contains("is-unread")
      }));
    })()`;

    // The phone reads a chat's pages only while that chat is open. What the
    // members of every other chat run and last finished comes with the
    // server's chat list, and Activity lists that: no chat is read here.
    // Paired for every chat: no chat is preselected, so the phone opens on
    // its home screens.
    await pairPage(app, { hub, siteOrigin: site.origin });
    // The bar is there on the home screen, on Chats.
    assert.equal(await waitFor(`(() => {
      const dock = document.getElementById("home-dock");
      return dock && !dock.hidden && document.getElementById("chats-screen").classList.contains("is-active") ? "chats" : null;
    })()`, "the bottom bar on Chats"), "chats");

    // The Activity tab's number counts what waits for the User and the
    // unseen updates, once the server's chats have been read.
    const badge = await waitFor(`(() => {
      const badge = document.getElementById("activity-badge");
      return badge && !badge.hidden && Number(badge.textContent) >= 4 ? badge.textContent : null;
    })()`, "the Activity badge");
    t.diagnostic(`Activity badge: ${badge}`);

    await evaluate(`document.querySelector('[data-home-tab="activity"]').click()`);
    // The lists catch up with a burst of batches shortly after it, not on
    // every write, so the counts are waited for rather than read once.
    await waitFor(`${tabCounts} === "Running 1|Pending 4|Finished 2" ? true : null`,
      "the tab counts (the question's own message is not also a finished update)");
    const pending = await waitFor(`(() => { const rows = ${listRows("pending")}; return rows && rows.length === 4 ? rows : null; })()`, "the Pending list");
    t.diagnostic(`pending rows: ${JSON.stringify(pending.map((row) => row.text.slice(0, 80)))}`);
    const byCard = Object.fromEntries(pending.map((row) => [row.card, row.text]));
    assert.match(byCard["choice-deploy"], /PWA polish round by @taylor/);
    assert.match(byCard["choice-deploy"], /Where should this deploy go\?/);
    assert.match(byCard["perm-deploy"], /by @drew/);
    assert.match(byCard["perm-deploy"], /npm run deploy:mobile/);
    // Answered in the row, so every word is on screen, the dangerous end too,
    // and where it will run.
    assert.match(byCard["perm-cloud"], /Cloud machine setup by @morgan · Cloud · eu-west-1/);
    const permissionText = await evaluate(`document.querySelector('[data-card-id="perm-cloud"] .act-preview').innerText`);
    assert.equal(permissionText, longCommand, "the whole command, line break kept");
    const clipped = await evaluate(`(() => { const p = document.querySelector('[data-card-id="perm-cloud"] .act-preview'); return p.scrollHeight > p.clientHeight + 1; })()`);
    assert.equal(clipped, false, "nothing of it is hidden");
    // The tab stays where it was put: chosen once, then kept.
    assert.equal(await evaluate(`localStorage.getItem("accordagents.mobile.activityTab.v1")`), "pending");

    // Allow, straight from the row: a second tap on Deny beside it does not
    // send a second, contradicting answer.
    await sleep(TAP_SETTLE_MS);
    await evaluate(`(() => {
      document.querySelector('[data-card-id="perm-deploy"] [data-option-id="allow"]').click();
      document.querySelector('[data-card-id="perm-deploy"] [data-option-id="deny"]').click();
      return true;
    })()`);
    await waitFor(`document.querySelector('[data-card-id="perm-deploy"]')?.classList.contains("is-on-its-way") || null`, "the row to fade once answered");
    const decisions = await storedEvents("outbox", "permission.decided");
    assert.equal(decisions.length, 1, "one answer per card");
    assert.equal(decisions[0].conversationId, CHAT_POLISH);
    assert.equal(decisions[0].payload.targetKey, "approval:perm-deploy");
    assert.equal(decisions[0].payload.detail.approve, true);
    assert.equal(decisions[0].payload.detail.codexDecisionId, "native-decision-9");

    for (let i = 0; i < 40 && hub.phoneEvents("permission.decided").length === 0; i += 1) await sleep(250);
    assert.equal(hub.phoneEvents("permission.decided").length, 1, "the one answer reached the server");

    // Another chat's cards changing does not make that answer answerable again.
    await hub.raiseApproval(CHAT_CLOUD, { ...cloudApproval, status: "denied", updatedAt: new Date().toISOString() });
    await waitFor(`document.querySelector('[data-card-id="perm-cloud"]') ? null : true`, "the other chat's permission withdrawn");
    assert.equal(await evaluate(`document.querySelector('[data-card-id="perm-deploy"] [data-option-id="allow"]').disabled`), true,
      "an answer already sent stays sent when another chat's cards change");
    assert.deepEqual(await evaluate(`(() => { const row = document.querySelector('[data-card-id="perm-deploy"]'); return { onItsWay: row.classList.contains("is-on-its-way"), text: row.querySelector(".act-state") ? row.querySelector(".act-state").innerText : "" }; })()`),
      { onItsWay: true, text: "" }, "the row fades while the answer is on its way, and says nothing more");

    // The choice opens in full, with the bar out of reach behind it, and is
    // answered there.
    await sleep(TAP_SETTLE_MS);
    await evaluate(`document.querySelector('[data-card-id="choice-deploy"] .act-main').click()`);
    const item = await waitFor(`(() => {
      const view = document.getElementById("activity-item");
      return view && !view.hidden && view.querySelector('[data-card-id="choice-deploy"]') ? view.innerText : null;
    })()`, "the opened choice");
    assert.match(item, /Waiting for you · asked by @taylor/);
    assert.match(item, /Review is green/, "the message the question belongs to is shown with it");
    assert.equal(await evaluate(`document.getElementById("home-dock").hidden`), true, "the bar steps aside for the opened choice");
    await evaluate(`document.querySelector('#activity-item [data-option-id="staging"]').click()`);
    // A field on the opened choice raises the keyboard as the chat's do, so
    // the height is held while it is focused: iOS lifts the field itself, and
    // shrinking the screen as well would lift it twice (review, 2026-09-24).
    // The note is open under the pick; a tap focuses it.
    await evaluate(`document.querySelector('#activity-item .control-card-note textarea').focus()`);
    assert.equal(await evaluate(`Boolean(document.activeElement && document.activeElement.closest('#activity-item .control-card-note'))`), true,
      "the note box is open under the pick");
    const heldHeight = await evaluate(`document.documentElement.style.getPropertyValue("--app-h")`);
    // Only the height changes, as when the keyboard comes up: a change of
    // width is a rotation, which is measured either way.
    const width = await evaluate("window.innerWidth");
    await app.send("Emulation.setDeviceMetricsOverride", { width, height: 480, deviceScaleFactor: 1, mobile: false });
    await sleep(1200);
    const underKeyboard = await evaluate(`document.documentElement.style.getPropertyValue("--app-h")`);
    await app.send("Emulation.clearDeviceMetricsOverride");
    assert.equal(underKeyboard, heldHeight, "the keyboard coming up does not shrink the screen under the focused note");
    // Picking selects; Submit answers, as on the desktop.
    await evaluate(`document.querySelector('#activity-item .control-card-submit').click()`);
    await waitFor(`globalThis.AccordAgentsMobile.listOutboxEntries().then((rows) => rows.some((row) => row.kind === "choice.answered") ? true : null)`,
      "the choice answer in the phone's queue");
    const answers = await storedEvents("outbox", "choice.answered");
    assert.equal(answers.length, 1);
    assert.equal(answers[0].payload.targetKey, "choice:choice-deploy");
    assert.equal(answers[0].payload.detail.selectedOptionId, "staging");
    assert.equal(answers[0].payload.detail.sourceMessageId, "q1");
    // The desktop takes the answer and stops listing the card: the opened
    // choice goes by itself, and the bar comes back.
    await hub.updateMessages(CHAT_POLISH, [question("selected")]);
    await waitFor(`document.getElementById("activity-item").hidden && !document.getElementById("home-dock").hidden ? true : null`,
      "the withdrawn choice to close");

    // "Open in chat" from an opened choice goes to that chat.
    await sleep(TAP_SETTLE_MS);
    await evaluate(`document.querySelector('[data-card-id="choice-cloud"] .act-main').click()`);
    await waitFor(`!document.getElementById("activity-item").hidden ? true : null`, "the second choice");
    await evaluate(`document.getElementById("activity-item-open").click()`);
    await waitFor(`(() => document.getElementById("timeline-screen").classList.contains("is-active") &&
      document.getElementById("chat-title").textContent === "Cloud machine setup" ? true : null)()`, "the choice's chat");
    await evaluate(`document.getElementById("back-to-chats").click()`);
    await waitFor(`document.getElementById("activity-screen").classList.contains("is-active") ? true : null`, "Activity again");

    // Running: stop a run from the list.
    await evaluate(`document.querySelector('[data-activity-tab="running"]').click()`);
    const running = await waitFor(`(() => { const rows = ${listRows("running")}; return rows && rows.length === 1 ? rows[0].text : null; })()`, "the Running list");
    assert.match(running, /PWA polish round by @taylor/);
    assert.match(running, /Reviewing the diff now/);
    await sleep(TAP_SETTLE_MS);
    await evaluate(`document.querySelector('#activity-list .act-stop').click()`);
    await waitFor(`globalThis.AccordAgentsMobile.listOutboxEntries().then((rows) => rows.some((row) => row.kind === "run.cancel.requested") ? true : null)`,
      "the stop request queued for the server");
    const cancels = await storedEvents("outbox", "run.cancel.requested");
    assert.equal(cancels[0].conversationId, CHAT_POLISH, "a stop from Activity names the run's own chat");
    assert.equal(cancels[0].payload.runId, "run-taylor-1");

    // Finished: one row per chat and member. @drew's newest is a thread reply,
    // so tapping the row opens that thread; coming back finds it read.
    await evaluate(`document.querySelector('[data-activity-tab="finished"]').click()`);
    // The answered question's own message is a finished update now.
    const finished = await waitFor(`(() => { const rows = ${listRows("finished")}; return rows && rows.length === 3 ? rows : null; })()`, "the Finished list");
    t.diagnostic(`finished rows: ${JSON.stringify(finished)}`);
    const drewRow = finished.find((row) => row.text.includes("PWA polish round by @drew"));
    assert.ok(drewRow, "@drew's updates have a row");
    assert.match(drewRow.text, /Fixed\. The badge clears too now\./);
    // KNOWN GAP (reported): before the phone has read this chat, the list
    // carries only @drew's newest reply, so the row cannot count both; the
    // desktop counts every update of the last seven days. Pinned as it is,
    // so the gap cannot grow unseen; both are counted below, once the chat
    // has been opened.
    assert.equal(await evaluate(`document.querySelector('#activity-list .act-row[data-activity-key="${drewRow.key}"] .act-badge') ? document.querySelector('#activity-list .act-row[data-activity-key="${drewRow.key}"] .act-badge').textContent : "none"`),
      "none", "before the chat is read, @drew's row counts one update (the known gap)");
    assert.equal(drewRow.unread, true);
    assert.ok(finished.some((row) => /PWA polish round by @taylor/.test(row.text) && /Review is green/.test(row.text)));
    assert.ok(finished.some((row) => /Cloud machine setup by @morgan/.test(row.text)));
    await sleep(TAP_SETTLE_MS);
    // The row, not only its text, is the way in.
    await evaluate(`document.querySelector('#activity-list .act-row[data-activity-key="${drewRow.key}"] .act-avatar').click()`);
    await waitFor(`(() => document.getElementById("timeline-screen").classList.contains("is-active") &&
      !document.getElementById("home-dock").hidden &&
      document.querySelector(".mobile-phone").dataset.dock === "chat" &&
      sessionStorage.getItem("accordagents.mobile.openThreadRootId.v1") === "m1" ? true : null)()`, "the thread to open with the bar under it");
    // The phone had not read this chat: its page comes from the server as it
    // opens, and the thread is used once its rows are drawn.
    await waitFor(`document.getElementById("message-list").innerText.includes("Fixed. The badge clears too now.") ? true : null`, "the thread's rows from the server");
    await hub.quiet();

    // The bar under a chat sits below the composer, not over it, and leaves
    // while the keyboard is up.
    const placed = await evaluate(`(() => {
      const dock = document.getElementById("home-dock").getBoundingClientRect();
      const composer = document.getElementById("composer-form").getBoundingClientRect();
      return {
        below: dock.top >= composer.bottom - 1,
        height: Math.round(dock.height),
        inside: dock.bottom <= window.innerHeight + 1
      };
    })()`);
    assert.equal(placed.below, true, "the bar is under the composer, never on top of it");
    assert.equal(placed.inside, true, "the whole bar is on screen, not pushed past the bottom");
    assert.ok(placed.height > 40, `the bar has its height: ${placed.height}px`);
    await evaluate(`document.getElementById("composer-input").focus()`);
    await waitFor(`document.getElementById("home-dock").hidden ? true : null`, "the bar to leave while typing");
    await evaluate(`document.getElementById("composer-input").blur()`);
    await waitFor(`(() => !document.getElementById("home-dock").hidden &&
      document.querySelector(".mobile-phone").dataset.dock === "chat" ? true : null)()`, "the bar to come back when the keyboard goes");

    // A reader up in history is left there when the bar goes and comes back;
    // only a reader who was at the latest message is kept at it.
    const scrolledUp = await evaluate(`(() => {
      const surface = document.querySelector("#timeline-screen .thread-surface");
      if (!surface || surface.scrollHeight <= surface.clientHeight + 80) return null;
      surface.scrollTop = 0;
      return Math.round(surface.scrollTop);
    })()`);
    t.diagnostic(scrolledUp === null ? "thread too short to test scrolled-up reader here" : "reader parked at the top of the thread");
    if (scrolledUp !== null) {
      await evaluate(`document.getElementById("composer-input").focus()`);
      await waitFor(`document.getElementById("home-dock").hidden ? true : null`, "the bar to leave with the reader up in history");
      await evaluate(`document.getElementById("composer-input").blur()`);
      await waitFor(`!document.getElementById("home-dock").hidden ? true : null`, "the bar to come back");
      await sleep(400);
      const stayed = await evaluate(`Math.round(document.querySelector("#timeline-screen .thread-surface").scrollTop)`);
      assert.ok(stayed <= 2, `a reader up in history is not yanked to the latest message (scrollTop ${stayed})`);
      await evaluate(`(() => {
        const surface = document.querySelector("#timeline-screen .thread-surface");
        surface.scrollTop = surface.scrollHeight;
        return true;
      })()`);
    }

    // Inside a chat the bar is the only place the User is told that something
    // elsewhere is waiting, so its number has to keep counting in there: a
    // question that arrives for another chat while this one is open is counted
    // without leaving it, and the number is the same one the home screens show.
    const badgeBefore = Number(await evaluate(`document.getElementById("activity-badge").textContent`));
    const chatBeforeBadge = await evaluate(`document.getElementById("message-list").childElementCount + ":" +
      document.getElementById("message-list").innerText.length`);
    await hub.raiseApproval(CHAT_CLOUD, chatBarApproval);
    const countedInChat = await waitFor(`(() => {
      const badge = document.getElementById("activity-badge");
      return document.getElementById("timeline-screen").classList.contains("is-active") &&
        !badge.hidden && Number(badge.textContent) === ${badgeBefore} + 1 ? Number(badge.textContent) : null;
    })()`, "the Activity number to count the new question while a chat is open");
    const chatAfterBadge = await evaluate(`document.getElementById("message-list").childElementCount + ":" +
      document.getElementById("message-list").innerText.length`);
    assert.equal(chatAfterBadge, chatBeforeBadge, "the chat itself is not redrawn for another chat's question");

    // A tab tapped from inside a chat leaves the chat for that screen.
    await evaluate(`document.querySelector('[data-home-tab="settings"]').click()`);
    await waitFor(`(() => document.getElementById("settings-screen").classList.contains("is-active") &&
      !document.getElementById("timeline-screen").classList.contains("is-active") &&
      !localStorage.getItem("accordagents.mobile.activeConversationId.v1") ? true : null)()`, "Settings from inside a chat");
    const countedAtHome = Number(await evaluate(`document.getElementById("activity-badge").textContent`));
    assert.equal(countedInChat, countedAtHome, "the number inside a chat is the one the home screens show, not a stale one");
    assert.ok(countedInChat > 0, "the waiting questions are counted");
    await evaluate(`document.querySelector('[data-home-tab="activity"]').click()`);
    await waitFor(`document.getElementById("activity-screen").classList.contains("is-active") ? true : null`, "Activity again");
    await sleep(TAP_SETTLE_MS);
    await evaluate(`document.querySelector('#activity-list .act-row[data-activity-key="${drewRow.key}"] .act-avatar').click()`);
    await waitFor(`document.getElementById("timeline-screen").classList.contains("is-active") ? true : null`, "the chat again");

    // The search button from a chat opened off the Chats list: the remembered
    // tab is Chats already, so only the open chat can tell the app to leave it.
    // Without that the box would open on a screen the reader cannot see.
    await evaluate(`document.querySelector('[data-home-tab="chats"]').click()`);
    await waitFor(`document.getElementById("chats-screen").classList.contains("is-active") ? true : null`, "Chats");
    await sleep(TAP_SETTLE_MS);
    await evaluate(`document.querySelector('#chat-list .mobile-chat-row').click()`);
    await waitFor(`(() => document.getElementById("timeline-screen").classList.contains("is-active") &&
      localStorage.getItem("accordagents.mobile.homeTab.v1") === "chats" ? true : null)()`, "a chat opened from the list");
    await evaluate(`document.getElementById("chat-search-toggle").click()`);
    await waitFor(`(() => document.getElementById("chats-screen").classList.contains("is-active") &&
      !document.getElementById("chat-search").hidden &&
      !localStorage.getItem("accordagents.mobile.activeConversationId.v1") ? true : null)()`,
      "the chat search from a chat opened off the list");
    await evaluate(`document.getElementById("chat-search-close").click()`);
    await sleep(TAP_SETTLE_MS);
    await evaluate(`document.querySelector('[data-home-tab="activity"]').click()`);
    await waitFor(`document.getElementById("activity-screen").classList.contains("is-active") ? true : null`, "Activity before the second search pass");
    await sleep(TAP_SETTLE_MS);
    await evaluate(`document.querySelector('#activity-list .act-row[data-activity-key="${drewRow.key}"] .act-avatar').click()`);
    await waitFor(`document.getElementById("timeline-screen").classList.contains("is-active") ? true : null`, "the chat from Activity again");

    // And from a chat opened off Activity, where the remembered tab is not
    // Chats: it leaves the chat and switches tab in one go.
    await evaluate(`document.getElementById("chat-search-toggle").click()`);
    await waitFor(`(() => document.getElementById("chats-screen").classList.contains("is-active") &&
      !document.getElementById("chat-search").hidden &&
      !localStorage.getItem("accordagents.mobile.activeConversationId.v1") ? true : null)()`, "the chat search from inside a chat");
    await evaluate(`document.getElementById("chat-search-close").click()`);
    await sleep(TAP_SETTLE_MS);
    await evaluate(`document.querySelector('[data-home-tab="activity"]').click()`);
    await waitFor(`document.getElementById("activity-screen").classList.contains("is-active") ? true : null`, "Activity after the search");
    await sleep(TAP_SETTLE_MS);
    await evaluate(`document.querySelector('#activity-list .act-row[data-activity-key="${drewRow.key}"] .act-avatar').click()`);
    await waitFor(`document.getElementById("timeline-screen").classList.contains("is-active") ? true : null`, "the chat once more");
    await evaluate(`document.getElementById("back-to-chats").click()`);
    const afterBack = await waitFor(`(() => {
      const rows = ${listRows("finished")};
      const drew = rows && rows.find((row) => row.text.includes("by @drew"));
      return drew ? drew : null;
    })()`, "Activity again after going back");
    assert.equal(afterBack.unread, false, "an update is read once its chat was opened");
    assert.match(afterBack.text, /\b2\b/, "two updates from @drew in that chat share one row once the chat was read");

    // @taylor's run, stamped by the desktop before the chat was opened just
    // now, reaches the phone after it: that is news, whatever the stamp says.
    await hub.updateMessages(CHAT_POLISH, [{ ...taylorRun, status: "done", content: "Review done: two nits, both in the thread." }]);
    const settled = await waitFor(`(() => {
      const rows = ${listRows("finished")};
      const taylor = rows && rows.find((row) => row.text.includes("Review done"));
      return taylor ? { first: rows[0].key === taylor.key, unread: taylor.unread, text: taylor.text } : null;
    })()`, "the finished run in Finished");
    assert.equal(settled.unread, true, "a run that ended after the chat was opened is unseen");
    assert.equal(settled.first, true, "and it is the newest update");
    assert.match(settled.text, /Review done/);
    await waitFor(`${tabCounts}.startsWith("Running 0") ? true : null`, "Running to empty");
    // The same message delivered again, and under another id, keeps what the
    // phone knows about it: still unseen. Again from the server (any change
    // to the chat has the list read again, carrying it once more), and once
    // by hand under another row id, as a copy that names the message
    // differently would arrive.
    await touchChat(CHAT_POLISH);
    const tFinal = { messageId: taylorRun.id, role: "participant", participantLabel: "@taylor",
      content: "Review done: two nits, both in the thread.", status: "done", runId: "run-taylor-1", createdAt: taylorRun.createdAt };
    await evaluate(`AccordAgentsMobile.handleRelayTimelinePayload(${JSON.stringify({ type: "mobile.timeline.events", conversationId: CHAT_POLISH, events: [{ ...tFinal, id: "page:" + taylorRun.id }] })})`);
    await sleep(3500);
    const again = await evaluate(`(() => {
      const rows = ${listRows("finished")};
      const taylor = rows && rows.find((row) => row.text.includes("Review done"));
      return taylor ? taylor.unread : null;
    })()`);
    assert.equal(again, true, "a re-delivered finished message is still news");

    // A run watched to its end in the open chat is not news afterwards.
    await sleep(TAP_SETTLE_MS);
    await evaluate(`[...document.querySelectorAll("#activity-list .act-row")].find((row) => row.innerText.includes("by @morgan")).click()`);
    await waitFor(`document.getElementById("chat-title").textContent === "Cloud machine setup" ? true : null`, "the cloud chat");
    const morganRun = { id: "m-region", role: "participant", participantId: MORGAN.id, participantLabel: "@morgan", content: "Checking the region.",
      status: "pending", createdAt: minutesAgo(0), metadata: { runId: "run-morgan-2" } };
    await hub.addMessages(CHAT_CLOUD, [morganRun]);
    await waitFor(`document.getElementById("message-list").innerText.includes("Checking the region") ? true : null`, "the live row in the chat");
    await hub.updateMessages(CHAT_CLOUD, [{ ...morganRun, content: "Region checked: eu-west-1 is fine.", status: "done" }]);
    await waitFor(`document.getElementById("message-list").innerText.includes("Region checked") ? true : null`, "the answer in the chat");
    await evaluate(`document.getElementById("back-to-chats").click()`);
    const watched = await waitFor(`(() => {
      const rows = ${listRows("finished")};
      const morgan = rows && rows.find((row) => row.text.includes("Region checked"));
      return morgan ? morgan : null;
    })()`, "the watched answer in Finished");
    assert.equal(watched.unread, false, "an answer watched as it finished is not news");

    // Swipe left on a finished row and it can be cleared from this phone, the
    // way the desktop clears a row from its own Activity (the User,
    // 2026-09-20). The row stands for that member's updates in that chat up to
    // now, so clearing takes those with it and nothing newer.
    await sleep(TAP_SETTLE_MS);
    const clearedKey = await evaluate(`(() => {
      const row = [...document.querySelectorAll("#activity-list .act-row")].find((node) => node.innerText.includes("Region checked"));
      return row ? row.dataset.activityKey : null;
    })()`);
    assert.ok(clearedKey, "the row to clear is on screen");
    await swipeLeft(app, `#activity-list .act-swipe[data-activity-key="${clearedKey}"] .act-row`);
    const clearVisible = await evaluate(`(() => {
      const wrap = document.querySelector('#activity-list .act-swipe[data-activity-key="${clearedKey}"]');
      const action = wrap && wrap.querySelector(".act-swipe-clear");
      return wrap && wrap.dataset.swiped === "1" && action ? action.innerText.trim() : null;
    })()`);
    assert.equal(clearVisible, "Clear", "the swipe opens the row's Clear action");
    assert.equal(await evaluate(`document.getElementById("activity-screen").classList.contains("is-active")`), true,
      "the swipe did not open the chat behind the row");
    assert.equal(await evaluate(`localStorage.getItem("accordagents.mobile.activeConversationId.v1")`), null,
      "and no chat was opened by it");
    // A change landing between the swipe and the tap rebuilds the list; the
    // action must still be there under the finger.
    await touchChat(CHAT_POLISH);
    await sleep(1200);
    assert.equal(await evaluate(`(() => {
      const wrap = document.querySelector('#activity-list .act-swipe[data-activity-key="${clearedKey}"]');
      return wrap ? wrap.dataset.swiped : null;
    })()`), "1", "a redraw does not close the open action");
    await evaluate(`document.querySelector('#activity-list .act-swipe[data-activity-key="${clearedKey}"] .act-swipe-clear').click()`);
    await waitFor(`(() => {
      const rows = ${listRows("finished")};
      return rows && !rows.some((row) => row.text.includes("Region checked")) ? true : null;
    })()`, "the cleared row to go");
    await reload();
    await evaluate(`document.querySelector('[data-home-tab="activity"]').click()`);
    await waitFor(`document.getElementById("activity-screen").classList.contains("is-active") && document.querySelector('[data-activity-tab="finished"]') ? true : null`, "Activity after the reload");
    await evaluate(`document.querySelector('[data-activity-tab="finished"]').click()`);
    await sleep(1500);
    const stillCleared = await evaluate(`(() => {
      const rows = ${listRows("finished")};
      return rows ? rows.some((row) => row.text.includes("Region checked")) : null;
    })()`);
    assert.equal(stillCleared, false, "a cleared row stays cleared across a launch");
    // A newer update from the same member in the same chat is not covered by
    // what was cleared: the row comes back.
    await hub.addMessages(CHAT_CLOUD, [{ id: "m-region-2", role: "participant", participantId: MORGAN.id, participantLabel: "@morgan",
      content: "Region moved: eu-central-1 now.", status: "done", createdAt: minutesAgo(0), metadata: { runId: "run-morgan-3" } }]);
    await waitFor(`(() => {
      const rows = ${listRows("finished")};
      return rows && rows.some((row) => row.text.includes("Region moved")) ? true : null;
    })()`, "a newer update after a clear");

    // Swipe left on a waiting choice and it can be cancelled from the list,
    // the way the desktop's "Cancel pending card" does.
    await hub.addMessages(CHAT_POLISH, [swipeQuestion("pending")]);
    await evaluate(`document.querySelector('[data-activity-tab="pending"]').click()`);
    await waitFor(`document.querySelector('#activity-list .act-row[data-card-id="choice-swipe"]') ? true : null`,
      "the new waiting choice in Pending");
    await sleep(TAP_SETTLE_MS);
    const cancelKey = await evaluate(`(() => {
      const row = document.querySelector('#activity-list .act-row[data-card-id="choice-swipe"]');
      return row ? row.dataset.activityKey : null;
    })()`);
    assert.ok(cancelKey, "a waiting choice is on screen");
    await swipeLeft(app, `#activity-list .act-swipe[data-activity-key="${cancelKey}"] .act-row`);
    const cancelVisible = await evaluate(`(() => {
      const action = document.querySelector('#activity-list .act-swipe[data-activity-key="${cancelKey}"] .act-swipe-cancel');
      return action ? action.innerText.trim() : null;
    })()`);
    assert.equal(cancelVisible, "Cancel", "the swipe opens the row's Cancel action");
    await sleep(TAP_SETTLE_MS);
    await evaluate(`document.querySelector('#activity-list .act-swipe[data-activity-key="${cancelKey}"] .act-swipe-cancel').click()`);
    const cancelled = await waitFor(`globalThis.AccordAgentsMobile.listOutboxEntries().then((rows) => {
      const row = rows.filter((entry) => entry.kind === "choice.answered").find((entry) => entry.payload && entry.payload.detail && entry.payload.detail.cancel);
      return row ? row.payload.targetKey : null;
    })`, "the cancel in the phone's queue");
    assert.match(cancelled, /^choice:/, "the cancel is recorded against the choice card");

    // The desktop settles the last cards: Pending empties.
    await hub.updateMessages(CHAT_POLISH, [swipeQuestion("cancelled")]);
    await hub.raiseApproval(CHAT_POLISH, { ...deployApproval, status: "approved", updatedAt: new Date().toISOString() });
    await hub.raiseApproval(CHAT_CLOUD, { ...chatBarApproval, status: "approved", updatedAt: new Date().toISOString() });
    await hub.updateMessages(CHAT_CLOUD, [cloudQuestion("cancelled")]);
    await evaluate(`document.querySelector('[data-activity-tab="pending"]').click()`);
    const emptied = await waitFor(`(() => {
      const list = document.getElementById("activity-list");
      return list.dataset.activityTab === "pending" && list.querySelectorAll(".act-row").length === 0 ? list.innerText : null;
    })()`, "Pending to empty");
    assert.match(emptied, /Nothing is waiting for you/);

    // Settings says what this phone can do about itself, and nothing it cannot.
    await evaluate(`document.querySelector('[data-home-tab="settings"]').click()`);
    const settings = await waitFor(`document.getElementById("settings-screen").classList.contains("is-active") ? document.getElementById("settings-list").innerText : null`, "Settings");
    assert.match(settings, /Paired with your server/);
    assert.match(settings, /Message alerts/);
    assert.equal(await evaluate(`[...document.querySelectorAll("#settings-list button")].some((button) => button.innerText.trim() === "Wake")`), false,
      "no wake while the server holds no start key for the machine");

    // With a start key for the machine on the server, waking it is offered
    // here, in Settings: it is not a chat's business (the User, 2026-10-20).
    // The phone holds no key of its own; it asks the server.
    await hub.call("PUT", "/v1/machine-wake", { machines: [{
      machineId: "m1", instanceId: "i-0943b28f7231ab93c", region: "us-east-1",
      credentials: { accessKeyId: "AKIAEXAMPLEWAKEKEY001", secretAccessKey: "syntheticSecretKeyForQaOnly00000", region: "us-east-1" }
    }] });
    await reload();
    await evaluate(`document.querySelector('[data-home-tab="settings"]').click()`);
    const withKey = await waitFor(`(() => {
      const list = document.getElementById("settings-list");
      const wake = [...list.querySelectorAll("button")].find((button) => button.innerText.trim() === "Wake");
      return document.getElementById("settings-screen").classList.contains("is-active") && wake && !wake.disabled ? list.innerText : null;
    })()`, "Wake in Settings with the key for a machine");
    assert.match(withKey, /Cloud machine/);

    // Search sits on the bar and searches the chats, from any tab.
    await evaluate(`document.getElementById("chat-search-toggle").click()`);
    await waitFor(`(() => document.getElementById("chats-screen").classList.contains("is-active") &&
      !document.getElementById("chat-search").hidden && document.getElementById("home-dock").offsetParent === null ? true : null)()`,
      "search to open on Chats, with the bar out of the way");
    await evaluate(`document.getElementById("chat-search-close").click()`);

    // A phone that is not paired shows the pairing screen and no bar, whatever
    // tab it was left on.
    await evaluate(`(() => {
      localStorage.removeItem("accordagents.mobile.hub.v1");
      localStorage.setItem("accordagents.mobile.homeTab.v1", "activity");
      return true;
    })()`);
    await reload();
    await waitFor(`(() => document.getElementById("chats-screen").classList.contains("is-active") &&
      !document.getElementById("activity-screen").classList.contains("is-active") &&
      document.getElementById("home-dock").hidden ? true : null)()`, "no bar before pairing");
  } finally {
    app?.close();
    const exited = new Promise((resolve) => chrome.once("exit", resolve));
    chrome.kill("SIGKILL");
    await exited;
    await site.close();
    await hub.close();
    // Chrome's helpers can still be writing into the profile as it goes.
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
