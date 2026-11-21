/**
 * A running reply of the sessions view on the phone (the User, 2026-11-21),
 * through the real PWA against a real hub: T3 Code's turn in progress, a
 * quiet "Working for 4s" over a hairline, then one muted row per step with
 * an outline icon by its kind (thinking, web search, shell, file read, edit,
 * other tools) saying what it is about, the newest shimmering; no Running
 * label, no "Thinking" word, no Stop on the reply (the composer's button is
 * Stop); its posts stay its words. Live steps arrive with its progress. Once
 * done, its "Worked for …" opens to the same rows. The classic view is as
 * it was.
 *
 * Desktop Chrome, not the installed phone: supporting evidence for the phone
 * check, not a stand-in for it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { attachApp, launchChrome, member, openChat, pairPage, serveMobileShell, startMobileHub, tempProfile } from "./mobile-hub-fixture.mjs";

const require = createRequire(import.meta.url);
const chatChanges = require("../dist/main/main/services/chatChanges.js");
for (const key of ["mainSessionParticipantId", "chatView"]) {
  if (!chatChanges.SHARED_CONVERSATION_METADATA_KEYS.includes(key)) chatChanges.SHARED_CONVERSATION_METADATA_KEYS.push(key);
}

const MAIN = member("main", { id: "p-main", roleConfigId: "main-session" });
const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const row = (id) => `document.querySelector('#message-list .message-row[data-thread-root="${id}"]')`;
const step = (n, kind, label, detail) => ({ id: `a${n}`, sequence: n, kind, label, createdAt: at(1), ...(detail ? { detail } : {}) });

/** A turn as T3 Code's work log shows it. */
const WORK = [
  step(1, "status", "Thinking", "I need the current exchange rate, so I'll run a standard web search."),
  step(2, "web", "Using web search", "EUR to USD exchange rate today"),
  step(3, "command", "Running command", "npm test -- --grep login\nsecond line"),
  step(4, "tool", "Reading file", "src/login.ts"),
  step(5, "file-edit", "Updating files", "src/login.css"),
  step(6, "tool", "Using mcp__accord_agents__app_chat_get_context")
];
const WORK_ROWS = [
  ["thinking", "I need the current exchange rate, so I'll run a standard web search."],
  ["web", "EUR to USD exchange rate today"],
  ["shell", "npm test -- --grep login"],
  ["read", "src/login.ts"],
  ["edit", "src/login.css"],
  ["tool", "Using mcp__accord_agents__app_chat_get_context"]
];

const running = (fields = {}) => ({ id: "r1", role: "participant", participantId: MAIN.id, participantLabel: "@main", content: "", status: "pending", createdAt: at(0.2),
  ...fields, metadata: { runId: "run-main", sourceMessageId: "u1", ...(fields.metadata || {}) } });

function messages() {
  return [
    { id: "u0", role: "user", content: "What is the rate?", status: "done", createdAt: at(30), metadata: { deliveryTargets: [MAIN.id] } },
    { id: "r0", role: "participant", participantId: MAIN.id, participantLabel: "@main", content: "The rate is 1.08.", status: "done", createdAt: at(29),
      metadata: { sourceMessageId: "u0", workedMs: 4_000, activityEvents: WORK } },
    { id: "u1", role: "user", content: "Fix the login page", status: "done", createdAt: at(1), metadata: { deliveryTargets: [MAIN.id] } },
    running()
  ];
}

const rowsOf = (selector) => `[...${selector}.querySelectorAll(".sessions-activity-row")].map((node) => [node.dataset.activityKind, node.textContent, node.classList.contains("is-current") ? "current" : ""])`;

test("a running reply on the phone: Working for, one row per step, the newest shimmering; finished, its Worked for opens to the same rows", { timeout: 240_000 }, async (t) => {
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: 8395, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-sessions-activity-");
  const chrome = launchChrome({ port: 9545, profile, url: `${site.origin}/` });
  let app;
  t.after(async () => {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  await hub.createChat("conv-work", {
    title: "Work", participants: [MAIN], createdAt: at(31),
    metadata: { mainSessionParticipantId: MAIN.id, chatView: "sessions" }, messages: messages()
  });
  app = await attachApp({ port: 9545 });
  await pairPage(app, { hub, siteOrigin: site.origin, query: "qa=1" });
  await openChat(app, "conv-work");
  await app.waitFor(`Boolean(${row("r1")}?.querySelector(".sessions-working"))`, "the running reply's Working for");

  // --- before its first step: the header alone, no Thinking, no Running, no Stop
  const fresh = await app.evaluate(`(() => { const node = ${row("r1")};
    return { head: node.querySelector(".sessions-working-head").textContent, rows: node.querySelectorAll(".sessions-activity-row").length,
      text: node.innerText, stop: node.querySelectorAll(".message-stop").length,
      order: [...node.querySelector(".message-copy").children].filter((child) => child.offsetParent !== null).map((child) => child.className.split(" ")[0]),
      rule: getComputedStyle(node.querySelector(".sessions-working-head")).borderBottomWidth }; })()`);
  assert.match(fresh.head, /^Working for \d+s$/);
  assert.equal(fresh.rows, 0);
  assert.doesNotMatch(fresh.text, /Thinking|Running|is running/, "no placeholder word, no status label");
  assert.equal(fresh.stop, 0, "no Stop on the reply: the composer's button is Stop");
  assert.equal(fresh.order[0], "sessions-working", "nothing above it (no meta line)");
  assert.equal(fresh.rule, "1px", "the hairline under the header");
  assert.equal(await app.evaluate(`document.getElementById("send-button").getAttribute("aria-label")`), "Stop the main session");

  // --- the classic view is as it was: its Thinking and its status, no sessions rows
  await app.evaluate(`document.getElementById("chat-members-toggle").click()`);
  await app.waitFor(`Boolean(document.querySelector('#chat-title-menu [data-title-view="classic"]'))`, "the title's menu");
  await app.evaluate(`document.querySelector('#chat-title-menu [data-title-view="classic"]').click()`);
  await app.waitFor(`document.querySelectorAll("#message-list .message-row.is-sessions").length === 0 && Boolean(${row("r1")}?.querySelector(".thinking-label"))`, "the classic timeline");
  assert.deepEqual(await app.evaluate(`[${row("r1")}.querySelector(".thinking-label").textContent, ${row("r1")}.querySelector(".message-status").textContent,
    document.querySelectorAll("#message-list .sessions-working, #message-list .sessions-activity-row").length]`), ["Thinking", "Running", 0]);
  await app.evaluate(`document.querySelector('#chat-view-switch [data-view="sessions"]').click()`);
  await app.waitFor(`Boolean(${row("r1")}?.querySelector(".sessions-working")) && document.querySelectorAll("#message-list .message-row.is-sessions").length > 0`, "the sessions view again");

  // --- its steps arrive with its progress, one row each, the newest current
  // Marked once the view switch's own redraw has settled (a loaded machine
  // can redraw once more after it): what is checked is that the progress
  // keeps the row in place.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await app.evaluate(`${row("r1")}.__kept = true`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (await app.evaluate(`${row("r1")}.__kept === true`)) break;
  }
  await hub.progress("conv-work", "run-main", "", { participantLabel: "@main", agentProgress: { activity: "Using mcp__accord_agents__app_chat_get_context", activityEvents: WORK } });
  await app.waitFor(`${row("r1")}.querySelectorAll(".sessions-activity-row").length === 6`, "the live steps");
  assert.deepEqual(await app.evaluate(rowsOf(row("r1"))), WORK_ROWS.map((entry, index) => [...entry, index === WORK_ROWS.length - 1 ? "current" : ""]));
  const live = await app.evaluate(`(() => { const node = ${row("r1")};
    const current = node.querySelector(".sessions-activity-row.is-current .sessions-activity-text");
    return { kept: node.__kept === true, words: node.querySelector(".message-copy > .message-content:not(.message-interim-post)").textContent.trim(),
      icons: [...node.querySelectorAll(".sessions-activity-row svg")].length, shimmer: getComputedStyle(current).animationName,
      groups: node.querySelectorAll(".chat-inline-activity-group, .thinking-label").length }; })()`);
  assert.deepEqual(live, { kept: true, words: "", icons: 6, shimmer: "thinking-transfusion", groups: 0 },
    "kept in place; the step in progress is a step, not the reply's words; an outline icon per row; the newest shimmers; no boxed groups");

  // --- its words, then done: the Worked for opens to the same rows
  await hub.progress("conv-work", "run-main", "The login form is fixed.", { participantLabel: "@main", agentProgress: { activityEvents: WORK } });
  await app.waitFor(`${row("r1")}.querySelector(".message-copy > .message-content:not(.message-interim-post)").textContent.includes("The login form is fixed.")`, "its words");
  await hub.updateMessages("conv-work", [running({ status: "done", content: "The login form is fixed.", metadata: { workedMs: 12_000, activityEvents: WORK } })]);
  await app.waitFor(`${row("r1")}?.dataset.status === "Done"`, "the reply is done");
  const done = await app.evaluate(`(() => { const node = ${row("r1")};
    return { working: node.querySelectorAll(".sessions-working").length, toggle: node.querySelector(".sessions-worked-toggle")?.textContent || "",
      rows: node.querySelectorAll(".sessions-activity-row").length }; })()`);
  assert.deepEqual(done, { working: 0, toggle: "Worked for 12s", rows: 0 }, "folded once it is done");
  await app.evaluate(`${row("r1")}.querySelector(".sessions-worked-toggle").click()`);
  await app.waitFor(`${row("r1")}.querySelectorAll(".sessions-activity-row").length === 6`, "the fold open");
  assert.deepEqual(await app.evaluate(rowsOf(row("r1"))), WORK_ROWS.map((entry) => [...entry, ""]), "the same rows, none shimmering");

  // --- an earlier finished reply reads the same, from the page --------------
  await app.evaluate(`${row("r0")}.querySelector(".sessions-worked-toggle").click()`);
  await app.waitFor(`${row("r0")}.querySelectorAll(".sessions-activity-row").length === 6`, "the earlier reply's fold");
  assert.equal(await app.evaluate(`${row("r0")}.querySelector(".sessions-worked-toggle").textContent`), "Worked for 4s");

});

async function waitForOp(hub, matches, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const request of hub.opsRequests) {
      const op = (request.ops || []).find(matches);
      if (op) return op;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the phone did not send the operation");
}

test("a queued reply on the phone says Queued and is taken back from its own ×; a running one works for the time its own run took; a member's session stops that member", { timeout: 240_000 }, async (t) => {
  const DREW = member("drew", { id: "p-drew", kind: "codex-cli" });
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: 8396, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-sessions-queued-");
  const chrome = launchChrome({ port: 9546, profile, url: `${site.origin}/` });
  let app;
  t.after(async () => {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const runStarted = at(0.05);
  await hub.createChat("conv-queued", {
    title: "Queued", participants: [MAIN, DREW], createdAt: at(31),
    metadata: { mainSessionParticipantId: MAIN.id, chatView: "sessions" },
    messages: [
      { id: "u1", role: "user", content: "Fix the login page", status: "done", createdAt: at(3), metadata: { deliveryTargets: [MAIN.id] } },
      // Made two minutes ago, its run on a machine began seconds ago.
      running({ createdAt: at(2), metadata: { remoteRunStatus: { phase: "waiting-for-response", label: "Working", startedAt: runStarted, updatedAt: runStarted } } }),
      { id: "u2", role: "user", content: "And the signup page", status: "done", createdAt: at(1), metadata: { deliveryTargets: [MAIN.id] } },
      { id: "q1", role: "participant", participantId: MAIN.id, participantLabel: "@main", content: "", status: "pending", createdAt: at(0.9),
        metadata: { runId: "run-queued", sourceMessageId: "u2", queuedBehind: { handle: "main" } } },
      { id: "u3", role: "user", content: "Check the tests", status: "done", createdAt: at(0.8), metadata: { deliveryTargets: [DREW.id] } },
      { id: "d1", role: "participant", participantId: DREW.id, participantLabel: "@drew", content: "", status: "pending", createdAt: at(0.7),
        metadata: { runId: "run-drew", sourceMessageId: "u3" } }
    ]
  });
  app = await attachApp({ port: 9546 });
  await pairPage(app, { hub, siteOrigin: site.origin, query: "qa=1" });
  await openChat(app, "conv-queued");
  await app.waitFor(`Boolean(${row("r1")}?.querySelector(".sessions-working")) && Boolean(${row("q1")})`, "the running reply and the queued one");

  // --- its Working for counts from when its own run began, not when it was made
  const seconds = await app.evaluate(`Number((${row("r1")}.querySelector(".sessions-working-head").textContent.match(/(\\d+)s$/) || [])[1])`);
  assert.ok(Number.isFinite(seconds) && seconds < 60, `Working for ${seconds}s: from its run's start, not the two minutes since it was made`);

  // --- queued: "Queued", no Working for, a small × to take it back ----------
  const queued = await app.evaluate(`(() => { const node = ${row("q1")}; const cancel = node.querySelector(".message-stop");
    const box = cancel ? cancel.getBoundingClientRect() : { width: 0, height: 0 };
    return { status: node.querySelector(".message-status").textContent, working: node.querySelectorAll(".sessions-working").length,
      cancel: cancel ? [cancel.textContent, cancel.getAttribute("aria-label"), cancel.classList.contains("is-queued-cancel")] : null,
      target: box.width >= 32 && box.height >= 32, shown: Boolean(cancel) && getComputedStyle(node.querySelector(".message-meta")).display !== "none" }; })()`);
  assert.deepEqual(queued, { status: "Queued", working: 0, cancel: ["×", "Cancel this queued reply", true], target: true, shown: true });
  assert.equal(await app.evaluate(`${row("r1")}.querySelectorAll(".message-stop").length`), 0, "the running reply still has no Stop of its own (the composer stops it)");
  await app.evaluate(`${row("q1")}.querySelector(".message-stop").click()`);
  const cancelled = await waitForOp(hub, (op) => op.kind === "turn.stop" && op.messageId === "u2");
  assert.equal(cancelled.participantId, MAIN.id, "the queued turn, named by the message it answers");

  // --- a member's session: its composer stops that member, typed or not -----
  await app.evaluate(`document.getElementById("chat-members-button").click()`);
  await app.waitFor(`Boolean(document.querySelector('#members-sheet-list .sessions-member-row[data-member-session="p-drew"]'))`, "drew in the side panel");
  await app.evaluate(`document.querySelector('#members-sheet-list .sessions-member-row[data-member-session="p-drew"]').click()`);
  await app.waitFor(`Boolean(document.querySelector('#message-list .message-row[data-thread-root="d1"]'))`, "drew's session");
  const sendMode = `document.getElementById("send-button").dataset.mode`;
  await app.waitFor(`${sendMode} === "stop"`, "the member's composer is its Stop");
  assert.equal(await app.evaluate(`document.getElementById("send-button").getAttribute("aria-label")`), "Stop this member");
  await app.evaluate(`(() => { const input = document.getElementById("composer-input"); input.value = "also the e2e ones"; input.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  assert.deepEqual(await app.evaluate(`(() => { const node = document.getElementById("composer-stop-button"); return [!node.hidden, node.getAttribute("aria-label"), document.getElementById("send-button").dataset.mode]; })()`),
    [true, "Stop this member", "send"], "Stop beside Send for the member, Send still sends");
  await app.evaluate(`(() => { const input = document.getElementById("composer-input"); input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await app.evaluate(`document.getElementById("send-button").dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }))`);
  const stopDrew = await waitForOp(hub, (op) => op.kind === "turn.stop" && op.participantId === DREW.id);
  assert.equal(stopDrew.messageId, "u3", "the member's run, named by the message it answers");
});
