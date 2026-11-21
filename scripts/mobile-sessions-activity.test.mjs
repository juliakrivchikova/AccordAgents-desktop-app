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
