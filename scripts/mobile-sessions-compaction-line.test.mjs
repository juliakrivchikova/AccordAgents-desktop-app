/**
 * The line a finished compaction leaves, on the phone's sessions view
 * (docs/main-session.md), through the real PWA against a real hub: the main
 * session's on the main timeline, a member's in that member's session, each
 * one muted line in the words of the CLI that compacted ("Conversation
 * compacted" for Claude Code and Antigravity, "Context compacted" for
 * Codex), a line from before the CLI was recorded worded by the member's
 * CLI. A failed compaction and one with nothing to compact leave no line;
 * the classic view shows none; a line that arrives while the chat is on
 * screen is drawn in its place.
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
const TAYLOR = member("taylor", { id: "p-taylor", kind: "codex-cli" });
const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const row = (id) => `document.querySelector('#message-list .message-row[data-thread-root="${id}"]')`;
const lines = `[...document.querySelectorAll('#message-list .message-row[data-sessions-kind="compaction"]')].map((node) => [
  node.dataset.rowKey.split("\\u0000")[2] || node.dataset.rowKey, node.textContent, Boolean(node.querySelector(".sessions-compaction-line > svg"))])`;
const compactionRows = `document.querySelectorAll('#message-list .sessions-compaction-line').length`;

const compaction = (id, participantId, outcome, minutes, cli) => ({
  id, role: "system", content: `Compacted @${participantId.slice(2)} context.`, status: "done", createdAt: at(minutes),
  metadata: { compaction: { triggeredBy: "user", participantId, outcome, instructionsProvided: false, ...(cli ? { cli } : {}) } }
});

function messages() {
  return [
    { id: "u1", role: "user", content: "Fix the login page", status: "done", createdAt: at(30), metadata: { deliveryTargets: [MAIN.id] } },
    { id: "r1", role: "participant", participantId: MAIN.id, participantLabel: "@main", content: "I asked a member to test it.", status: "done", createdAt: at(29),
      metadata: { sourceMessageId: "u1", workedMs: 12_000 } },
    { id: "req", role: "participant", participantId: MAIN.id, participantLabel: "@main", content: "@taylor Run the login tests", status: "done", createdAt: at(28),
      metadata: { sourceMessageId: "u1", participantRequest: {
        id: "batch-req", requesterParticipantId: MAIN.id, requesterHandle: "main", source: "mcp", resumeRequester: true, status: "running", depth: 1,
        createdAt: at(28), updatedAt: at(20), triggerMessageId: "u1",
        items: [{ targetParticipantId: TAYLOR.id, targetHandle: "taylor", prompt: "Run the login tests", status: "answered", createdAt: at(28), updatedAt: at(20),
          title: "Login tests", replyMessageId: "taylor-reply", targetKind: "codex-cli" }]
      } } },
    { id: "taylor-reply", role: "participant", participantId: TAYLOR.id, participantLabel: "@taylor", content: "All 42 login tests pass.", status: "done", createdAt: at(20),
      metadata: { sourceMessageId: "req" } },
    // A line from before the CLI was recorded: worded by the member's CLI.
    compaction("taylor-old", TAYLOR.id, "completed", 18),
    compaction("taylor-failed", TAYLOR.id, "failed", 17),
    compaction("main-nothing", MAIN.id, "no-active-session", 16),
    compaction("main-done", MAIN.id, "completed", 15, "claude-code"),
    compaction("taylor-done", TAYLOR.id, "completed", 14, "codex-cli"),
    { id: "u2", role: "user", content: "Thanks", status: "done", createdAt: at(10), metadata: { deliveryTargets: [MAIN.id] } }
  ];
}

test("a compaction's line on the phone: the main session's on the main timeline, a member's in its session, in its CLI's words; none in the classic view", { timeout: 240_000 }, async (t) => {
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: 8415, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-compaction-line-");
  const chrome = launchChrome({ port: 9565, profile, url: `${site.origin}/` });
  let app;
  t.after(async () => {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  await hub.createChat("conv-compact", {
    title: "Compact", participants: [MAIN, TAYLOR], createdAt: at(31),
    metadata: { mainSessionParticipantId: MAIN.id, chatView: "sessions" }, messages: messages()
  });
  app = await attachApp({ port: 9565 });
  await pairPage(app, { hub, siteOrigin: site.origin, query: "qa=1" });
  await openChat(app, "conv-compact");
  await app.waitFor(`Boolean(${row("r1")}) && Boolean(${row("u2")})`, "the main timeline");

  // --- the main session's line on the main timeline, and only it -----------
  await app.waitFor(`${compactionRows} === 1`, "the main session's line");
  assert.deepEqual(await app.evaluate(lines), [["main-done", "Conversation compacted", true]],
    "one muted line in Claude Code's words; a member's, a failed one and one with nothing to compact are not here");
  const order = await app.evaluate(`[...document.querySelectorAll("#message-list > .message-row")].map((node) => node.dataset.sessionsKind || node.dataset.threadRoot)`);
  assert.ok(order.indexOf("compaction") > order.indexOf("r1") && order.indexOf("compaction") < order.indexOf("u2"), `in its place in time: ${order.join(",")}`);
  const style = await app.evaluate(`(() => { const node = document.querySelector(".sessions-compaction-line"); const css = getComputedStyle(node);
    const muted = getComputedStyle(document.documentElement).getPropertyValue("--mut").trim();
    return { fontSize: css.fontSize, sameAsMuted: css.color === (() => { const probe = document.createElement("span"); probe.style.color = muted; document.body.append(probe);
      const color = getComputedStyle(probe).color; probe.remove(); return color; })(), threadRoot: node.closest(".message-row").dataset.threadRoot || "" }; })()`);
  assert.deepEqual(style, { fontSize: "13px", sameAsMuted: true, threadRoot: "" }, "muted, small, and nothing to open");

  // --- a member's lines in its session, in its CLI's words -------------------
  await app.evaluate(`${row("r1")}.querySelector(".sessions-worked-toggle").click()`);
  await app.waitFor(`Boolean(document.querySelector('#message-list [data-open-member="${TAYLOR.id}"]'))`, "the turn's task row");
  await app.evaluate(`document.querySelector('#message-list [data-open-member="${TAYLOR.id}"]').click()`);
  await app.waitFor(`document.getElementById("chat-title").textContent === "Login tests" && Boolean(${row("taylor-reply")})`, "taylor's session");
  await app.waitFor(`${compactionRows} === 2`, "taylor's lines");
  assert.deepEqual(await app.evaluate(lines), [["taylor-old", "Context compacted", true], ["taylor-done", "Context compacted", true]],
    "Codex's words, for the line that names the CLI and for the one from before it was recorded; the failed one leaves none");

  // --- a line that arrives while the session is on screen --------------------
  await hub.addMessages("conv-compact", [compaction("taylor-live", TAYLOR.id, "completed", 1, "codex-cli")]);
  await app.waitFor(`${compactionRows} === 3`, "the new line");
  assert.deepEqual((await app.evaluate(lines)).at(-1), ["taylor-live", "Context compacted", true]);
  await app.evaluate(`document.getElementById("back-to-timeline").click()`);
  await app.waitFor(`document.getElementById("chat-title").textContent === "Compact" && Boolean(${row("u2")})`, "back on the main timeline");
  assert.deepEqual((await app.evaluate(lines)).map((entry) => entry[0]), ["main-done"], "a member's new line stays in its session");

  // --- the classic view shows none --------------------------------------------
  await app.evaluate(`document.getElementById("chat-members-toggle").click()`);
  await app.waitFor(`Boolean(document.querySelector('#chat-title-menu [data-title-view="classic"]'))`, "the title's menu");
  await app.evaluate(`document.querySelector('#chat-title-menu [data-title-view="classic"]').click()`);
  await app.waitFor(`document.querySelectorAll("#message-list .message-row.is-sessions").length === 0 && Boolean(${row("u2")})`, "the classic timeline");
  assert.equal(await app.evaluate(compactionRows), 0, "no compaction line in the classic view");
  assert.equal(await app.evaluate(`[...document.querySelectorAll("#message-list .message-row")].filter((node) => node.dataset.author === "system").length`), 0,
    "and no empty system row in its place");
  await app.evaluate(`document.querySelector('#chat-view-switch [data-view="sessions"]').click()`);
  await app.waitFor(`document.querySelectorAll("#message-list .message-row.is-sessions").length > 0 && ${compactionRows} === 1`, "the sessions view again, with its line");
});
