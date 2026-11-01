// A member's turn in progress on the phone, while the member posts during it.
//
// Reported by the User (2026-10-31): a member that posts with its reply tool
// while its turn goes on looks finished. The phone took any finished message
// of the run as the run's end: it deleted the turn's row (its text is the
// "@x is running..." placeholder) and barred it from coming back. So the turn
// in progress was gone from the chat and Activity could not open it.
//
// Played on a real hub (the User's own server) with the real PWA paired to it:
// the turn's row stays while the posts arrive, Activity's Running row opens
// the chat on that row (not at its end, where the posts are), and a turn that
// ends with nothing to say still ends on the phone.
import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { attachApp, launchChrome, member, openChat, pairPage, serveMobileShell, sleep, startMobileHub, tempProfile } from "./mobile-hub-fixture.mjs";

const SITE_PORT = 8217;
const CDP_PORT = 9387;
const CONVERSATION = "conv-running-turn-qa";
const TAYLOR = member("taylor");
const RUN_ID = "run-taylor-turn";
const at = (minute) => new Date(Date.UTC(2026, 9, 31, 20, minute)).toISOString();

const earlier = Array.from({ length: 8 }, (_, i) => ({
  id: `m${i}`,
  role: i % 2 ? "participant" : "user",
  ...(i % 2 ? { participantId: TAYLOR.id, participantLabel: "@taylor" } : {}),
  content: `Earlier message number ${i}.`,
  status: "done",
  createdAt: at(i)
}));
const turn = (fields = {}) => ({
  id: "t-turn",
  role: "participant",
  participantId: TAYLOR.id,
  participantLabel: "@taylor",
  content: "",
  status: "pending",
  createdAt: at(20),
  metadata: { runId: RUN_ID },
  ...fields
});
const post = (n) => ({
  id: `t-post-${n}`,
  role: "participant",
  participantId: TAYLOR.id,
  participantLabel: "@taylor",
  content: `Progress post ${n}: a long enough note to take a few lines on a phone screen, so the chat has to scroll to show all of them.`,
  status: "done",
  createdAt: at(20 + n),
  metadata: { runId: RUN_ID, appMessageSource: "app_chat_send_message" }
});

test("a turn stays running through its own posts, opens from Activity, and ends even when it ends empty", { timeout: 240_000 }, async () => {
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: SITE_PORT, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-running-turn-");
  const chrome = launchChrome({ port: CDP_PORT, profile, url: `${site.origin}/`, width: 390, height: 640 });
  let app;
  try {
    await hub.createChat(CONVERSATION, { title: "Running turn QA", participants: [TAYLOR], messages: earlier });
    app = await attachApp({ port: CDP_PORT });
    await pairPage(app, { hub, siteOrigin: site.origin });
    await openChat(app, CONVERSATION);
    const evaluate = app.evaluate;
    await app.waitFor(`document.getElementById("message-list").textContent.includes("Earlier message number 7.")`, "the chat's history is shown");
    const turnRow = `document.querySelector('#message-list .message-row[data-thread-root="t-turn"]')`;

    await hub.addMessages(CONVERSATION, [turn()]);
    await app.waitFor(`Boolean(${turnRow}) && ${turnRow}.dataset.status === "Running"`, "the turn's row appears");
    const storedTurnText = `(async () => {
      const db = await new Promise((res, rej) => { const r = indexedDB.open("accordagents-mobile-control"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const row = await new Promise((res) => { const one = db.transaction("timeline", "readonly").objectStore("timeline").get(${JSON.stringify(`${CONVERSATION}:t-turn`)}); one.onsuccess = () => res(one.result); one.onerror = () => res(undefined); });
      db.close();
      return row ? row.content : "";
    })()`;
    await hub.progress(CONVERSATION, RUN_ID, "Reading the first file", { participantLabel: "@taylor" });
    await app.waitFor(`${storedTurnText}.then((text) => text === "Reading the first file")`, "the turn's live text arrives");

    // The member posts during its turn.
    await hub.addMessages(CONVERSATION, [post(1), post(2), post(3), post(4)]);
    await app.waitFor(`document.getElementById("message-list").textContent.includes("Progress post 4")`, "the posts arrive");
    await sleep(1500);
    assert.equal(await evaluate(`Boolean(${turnRow}) && ${turnRow}.dataset.status`), "Running", "the posts do not end the turn on the phone");
    // The turn's live text keeps coming after the posts: the server did not
    // take a post for the turn's end and drop the turn's progress.
    await hub.progress(CONVERSATION, RUN_ID, "Reading the first file, then the second", { participantLabel: "@taylor" });
    await app.waitFor(`${storedTurnText}.then((text) => text === "Reading the first file, then the second")`, "the turn's live text keeps coming after the posts");

    // Activity's Running row opens the chat on the turn, not at its end.
    await evaluate(`document.querySelector(".mobile-back, #timeline-back, [data-action='back']")?.click()`);
    await evaluate(`document.querySelector('[data-home-tab="activity"]').click()`);
    await app.waitFor(`document.getElementById("activity-screen").classList.contains("is-active")`, "Activity is open");
    await evaluate(`document.querySelector('[data-activity-tab="running"]')?.click()`);
    await app.waitFor(`[...document.querySelectorAll("#activity-list .act-row")].some((row) => row.innerText.includes("@taylor"))`, "the turn is listed as running");
    await sleep(700);
    await evaluate(`[...document.querySelectorAll("#activity-list .act-row")].find((row) => row.innerText.includes("@taylor")).querySelector(".act-avatar").click()`);
    await app.waitFor(`document.getElementById("timeline-screen").classList.contains("is-active") && Boolean(${turnRow}) && ${turnRow}.classList.contains("message-focused")`,
      "the chat opens on the turn, marked");
    const placed = await evaluate(`(() => {
      const surface = document.querySelector("#timeline-screen .thread-surface");
      const row = ${turnRow}.getBoundingClientRect();
      const box = surface.getBoundingClientRect();
      return { top: Math.round(row.top - box.top), height: Math.round(box.height), fromEnd: Math.round(surface.scrollHeight - surface.scrollTop - surface.clientHeight) };
    })()`);
    assert.ok(placed.top >= 0 && placed.top < placed.height / 2, `the turn is at the top of the chat, not below the fold: ${JSON.stringify(placed)}`);
    assert.ok(placed.fromEnd > 0, `the chat is not left at its end: ${JSON.stringify(placed)}`);

    // In the chat, the members list says who is running, and a tap on a
    // running member lands on its turn in progress, as on the desktop.
    await evaluate(`document.querySelector("#timeline-screen .thread-surface").scrollTo({ top: document.querySelector("#timeline-screen .thread-surface").scrollHeight }); true`);
    await sleep(700);
    await evaluate(`document.getElementById("chat-members-toggle").click()`);
    await app.waitFor(`(() => { const row = document.querySelector('#members-sheet-list .members-sheet-row[data-handle="taylor"]'); return Boolean(row) && !document.getElementById("members-sheet").hidden && row.dataset.running === "1" && row.innerText.includes("Running") && row.classList.contains("is-openable"); })()`,
      "the members list marks the running member");
    await evaluate(`document.querySelector('#members-sheet-list .members-sheet-row[data-handle="taylor"]').click()`);
    await app.waitFor(`document.getElementById("members-sheet").hidden && Boolean(${turnRow}) && ${turnRow}.classList.contains("message-focused")`,
      "a tap on the running member lands on its turn");
    await sleep(1000);
    const fromMembers = await evaluate(`(() => {
      const surface = document.querySelector("#timeline-screen .thread-surface");
      const row = ${turnRow}.getBoundingClientRect();
      const box = surface.getBoundingClientRect();
      return { top: Math.round(row.top - box.top), height: Math.round(box.height) };
    })()`);
    assert.ok(fromMembers.top >= 0 && fromMembers.top < fromMembers.height / 2, `the turn is in view at the top: ${JSON.stringify(fromMembers)}`);
    assert.equal(await evaluate(`document.querySelectorAll("#message-list .message-row.message-focused").length`), 1, "one message is marked at a time");

    // A turn whose own message ends empty (everything went out as posts)
    // still ends on the phone.
    await hub.updateMessages(CONVERSATION, [turn({ status: "done", content: "" })]);
    await app.waitFor(`!${turnRow}`, "the ended turn's row goes");
    await evaluate(`document.querySelector('[data-home-tab="activity"]')?.click()`);
    await sleep(500);
    await evaluate(`document.querySelector('[data-activity-tab="running"]')?.click()`);
    await app.waitFor(`![...document.querySelectorAll("#activity-list .act-row")].some((row) => row.innerText.includes("@taylor") && row.closest("#activity-list").dataset.activityTab === "running")`,
      "the ended turn leaves Running");
  } finally {
    app?.close();
    const exited = new Promise((resolve) => chrome.once("exit", resolve));
    chrome.kill("SIGKILL");
    await exited;
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// A long turn in a busy chat, on a phone that never saw it start: the turn
// began an hour ago and 95 messages came after it, so it is neither among
// the chat's newest messages the chat list reads nor on the chat's newest
// page. The server still lists it (it reads the turns in progress of a chat
// with an open turn), Activity's Running row opens the chat on it (reading
// the pages back to it), and a later reply does not delete it as a run that
// died half an hour ago.
test("a long turn buried under a busy chat stays running on the phone and opens from Activity", { timeout: 240_000 }, async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { hubTurnRunId } = require("../dist/main/shared/hubOps.js");
  const DREW = member("drew", { kind: "codex-cli" });
  const CHAT = "conv-long-turn-qa";
  const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: SITE_PORT + 1, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-long-turn-");
  const chrome = launchChrome({ port: CDP_PORT + 1, profile, url: `${site.origin}/`, width: 390, height: 640 });
  let app;
  try {
    const ask = { id: "u-long", role: "user", content: "@taylor take the long task", status: "done", createdAt: minutesAgo(61) };
    const runId = hubTurnRunId(ask.id, TAYLOR.id);
    await hub.createChat(CHAT, { title: "Long turn QA", participants: [TAYLOR, DREW], createdAt: minutesAgo(70), messages: [ask] });
    await hub.claimTurn(CHAT, ask.id, TAYLOR.id);
    const longTurn = { id: "long-turn", role: "participant", participantId: TAYLOR.id, participantLabel: "@taylor", content: "",
      status: "pending", createdAt: minutesAgo(60), metadata: { runId, sourceMessageId: ask.id, parentMessageId: ask.id } };
    // A message a crash left "running" long ago, answering no open turn: it
    // must not be listed as running because another member's turn is.
    const dead = { id: "dead-turn", role: "participant", participantId: DREW.id, participantLabel: "@drew", content: "",
      status: "pending", createdAt: minutesAgo(600), metadata: { runId: "dead-run", sourceMessageId: "long-gone" } };
    await hub.addMessages(CHAT, [dead, longTurn].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
    const chatter = Array.from({ length: 95 }, (_, i) => ({
      id: `d${String(i).padStart(3, "0")}`, role: "participant", participantId: DREW.id, participantLabel: "@drew",
      content: `Drew's note ${i}.`, status: "done", createdAt: minutesAgo(59 - i * 0.5)
    }));
    for (let start = 0; start < chatter.length; start += 25) await hub.addMessages(CHAT, chatter.slice(start, start + 25));

    app = await attachApp({ port: CDP_PORT + 1 });
    await pairPage(app, { hub, siteOrigin: site.origin });
    const evaluate = app.evaluate;
    await evaluate(`document.querySelector('[data-home-tab="activity"]').click()`);
    await app.waitFor(`document.getElementById("activity-screen").classList.contains("is-active")`, "Activity is open");
    await evaluate(`document.querySelector('[data-activity-tab="running"]')?.click()`);
    await app.waitFor(`[...document.querySelectorAll("#activity-list .act-row")].some((row) => row.innerText.includes("@taylor"))`,
      "the buried long turn is listed as running", 20_000);
    assert.equal(await evaluate(`[...document.querySelectorAll("#activity-list .act-row")].some((row) => row.innerText.includes("@drew"))`), false,
      "a dead message of no open turn is not listed as running");
    await sleep(700);
    await evaluate(`[...document.querySelectorAll("#activity-list .act-row")].find((row) => row.innerText.includes("@taylor")).querySelector(".act-avatar").click()`);
    const turnRow = `document.querySelector('#message-list .message-row[data-thread-root="long-turn"]')`;
    await app.waitFor(`Boolean(${turnRow}) && ${turnRow}.classList.contains("message-focused")`, "the chat opens on the buried turn, read back to it", 30_000);
    const placed = await evaluate(`(() => {
      const surface = document.querySelector("#timeline-screen .thread-surface");
      const row = ${turnRow}.getBoundingClientRect();
      const box = surface.getBoundingClientRect();
      return { top: Math.round(row.top - box.top), height: Math.round(box.height) };
    })()`);
    assert.ok(placed.top >= 0 && placed.top < placed.height / 2, `the turn is at the top of the chat: ${JSON.stringify(placed)}`);
    // The chat has no hole: the notes between the turn and the newest page are there.
    assert.equal(await evaluate(`document.getElementById("message-list").textContent.includes("Drew's note 0.")`), true);

    // The turn's live text still reaches the phone, though its message is far
    // above the newest messages the live poll reads.
    await hub.progress(CHAT, runId, "Still working on the long task", { participantLabel: "@taylor", agentProgress: { messageId: "long-turn" } });
    await app.waitFor(`(async () => {
      const db = await new Promise((res, rej) => { const r = indexedDB.open("accordagents-mobile-control"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const row = await new Promise((res) => { const one = db.transaction("timeline", "readonly").objectStore("timeline").get(${JSON.stringify(`${CHAT}:long-turn`)}); one.onsuccess = () => res(one.result); one.onerror = () => res(undefined); });
      db.close();
      return Boolean(row) && row.content === "Still working on the long task";
    })()`, "the buried turn's live text reaches the phone", 20_000);

    // Another reply arrives: the hour-old turn is not taken for a dead run.
    await hub.addMessages(CHAT, [{ id: "d-late", role: "participant", participantId: DREW.id, participantLabel: "@drew",
      content: "A late note.", status: "done", createdAt: minutesAgo(0) }]);
    await app.waitFor(`document.getElementById("message-list").textContent.includes("A late note.")`, "the late reply arrives");
    await sleep(1500);
    assert.equal(await evaluate(`Boolean(${turnRow}) && ${turnRow}.dataset.status`), "Running", "the long turn is still running on the phone");

    // The turn ends with its answer, written where it started (far above
    // the newest page): the phone shows the answer there, and Running is empty.
    // The server closes the turn before the answer is saved (its fallback
    // finish can come first): the phone's first read finds the message still
    // running, keeps the row, and reads it again until the answer is there.
    await hub.finishTurn(CHAT, ask.id, TAYLOR.id);
    await hub.addMessages(CHAT, [{ id: "d-later", role: "participant", participantId: DREW.id, participantLabel: "@drew",
      content: "Another note.", status: "done", createdAt: minutesAgo(0) }]);
    await sleep(4000);
    assert.equal(await evaluate(`Boolean(${turnRow}) && ${turnRow}.dataset.status`), "Running", "the turn not yet answered stays running");
    await hub.updateMessages(CHAT, [{ ...longTurn, status: "done", content: "Final answer of the long task." }]);
    await app.waitFor(`Boolean(${turnRow}) && ${turnRow}.dataset.status === "Done" && ${turnRow}.textContent.includes("Final answer of the long task.")`,
      "the buried turn's answer reaches the phone on a later read", 60_000);
    await evaluate(`document.getElementById("back-to-chats")?.click()`);
    await evaluate(`document.querySelector('[data-home-tab="activity"]').click()`);
    await sleep(500);
    await evaluate(`document.querySelector('[data-activity-tab="running"]')?.click()`);
    await app.waitFor(`![...document.querySelectorAll("#activity-list .act-row")].some((row) => row.innerText.includes("@taylor") && document.getElementById("activity-list").dataset.activityTab === "running")`,
      "the ended turn leaves Running");
  } finally {
    app?.close();
    const exited = new Promise((resolve) => chrome.once("exit", resolve));
    chrome.kill("SIGKILL");
    await exited;
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// A member's own follow-up reply runs with no turn on the server (nothing
// lists it once it is buried). The phone held its row from the open chat;
// buried past the newest page, it is asked about by message until it ends,
// and its answer shows where it started.
test("a turn with no turn on the server, buried past the page, still ends on the phone", { timeout: 240_000 }, async () => {
  const DREW = member("drew", { kind: "codex-cli" });
  const CHAT = "conv-follow-up-qa";
  const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: SITE_PORT + 2, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-follow-up-");
  const chrome = launchChrome({ port: CDP_PORT + 2, profile, url: `${site.origin}/`, width: 390, height: 640 });
  let app;
  try {
    await hub.createChat(CHAT, { title: "Follow-up QA", participants: [TAYLOR, DREW], createdAt: minutesAgo(90),
      messages: [{ id: "u0", role: "user", content: "hello", status: "done", createdAt: minutesAgo(90) }] });
    app = await attachApp({ port: CDP_PORT + 2 });
    await pairPage(app, { hub, siteOrigin: site.origin });
    await openChat(app, CHAT);
    const followUp = { id: "follow-up", role: "participant", participantId: TAYLOR.id, participantLabel: "@taylor", content: "",
      status: "pending", createdAt: minutesAgo(60), metadata: { runId: "self-resumed-run" } };
    const chatter = Array.from({ length: 95 }, (_, i) => ({
      id: `n${String(i).padStart(3, "0")}`, role: "participant", participantId: DREW.id, participantLabel: "@drew",
      content: `Note ${i}.`, status: "done", createdAt: minutesAgo(59 - i * 0.5)
    }));
    // Written together with more than the chat list reads, so the list never
    // carries it: the phone holds it only from the open chat's page.
    await hub.addMessages(CHAT, [followUp, ...chatter.slice(0, 15)]);
    const row = `document.querySelector('#message-list .message-row[data-thread-root="follow-up"]')`;
    await app.waitFor(`Boolean(${row}) && ${row}.dataset.status === "Running"`, "the follow-up's row appears");
    assert.equal(await app.evaluate(`JSON.parse(localStorage.getItem("accordagents.mobile.chatList.v1") || "[]")
      .some((chat) => (chat.activity || []).some((event) => event.messageId === "follow-up"))`), false, "the chat list never carried it");
    for (let start = 15; start < chatter.length; start += 25) await hub.addMessages(CHAT, chatter.slice(start, start + 25));
    await app.waitFor(`document.getElementById("message-list").textContent.includes("Note 94.")`, "the newest notes arrive");
    await sleep(3000);
    assert.equal(await app.evaluate(`Boolean(${row}) && ${row}.dataset.status`), "Running", "the buried follow-up is not taken for a dead run");
    // The User leaves the chat; the follow-up ends while it is closed, so no
    // change of the open chat brings the end: only asking about it does.
    await app.evaluate(`document.getElementById("back-to-chats").click()`);
    await app.waitFor(`document.getElementById("chats-screen").classList.contains("is-active")`, "back on the chat list");
    await hub.updateMessages(CHAT, [{ ...followUp, status: "done", content: "Follow-up answer." }]);
    const stored = `(async () => {
      const db = await new Promise((res, rej) => { const r = indexedDB.open("accordagents-mobile-control"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const one = await new Promise((res) => { const q = db.transaction("timeline", "readonly").objectStore("timeline").get(${JSON.stringify(`${CHAT}:follow-up`)}); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); });
      db.close();
      return Boolean(one) && one.status === "done" && one.content === "Follow-up answer.";
    })()`;
    await app.waitFor(stored, "the follow-up's answer reaches the phone while the chat is closed", 60_000);
    await openChat(app, CHAT);
    await app.waitFor(`Boolean(${row}) && ${row}.dataset.status === "Done" && ${row}.textContent.includes("Follow-up answer.")`,
      "the answer shows where the follow-up started");
  } finally {
    app?.close();
    const exited = new Promise((resolve) => chrome.once("exit", resolve));
    chrome.kill("SIGKILL");
    await exited;
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
