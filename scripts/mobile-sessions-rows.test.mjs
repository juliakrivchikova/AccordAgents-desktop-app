/**
 * The sessions view's rows on the phone kept in step while they are on
 * screen (docs/main-session.md), through the real PWA against a real hub:
 * a reply that finishes on screen gets its "Worked for …" (on the main
 * timeline and in a member's session); a view switch draws the rows of the
 * other view; a running main reply that gave tasks keeps its node and its
 * task rows while it streams; a mention chip follows its member's new task
 * title; a removed member keeps its provider's logo everywhere; a member's
 * handle in code is still its chip, the rest of the code as written; a
 * stopped task's line is muted.
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
const DREW = member("drew", { id: "p-drew" });
// Made by the main session for a task, removed once it was done: no longer a member.
const OLGA_ID = "p-olga";
const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const row = (id) => `document.querySelector('#message-list .message-row[data-thread-root="${id}"]')`;

const item = (target, handle, prompt, status, minutes, extra = {}) => ({
  targetParticipantId: target, targetHandle: handle, prompt, status, createdAt: at(minutes), updatedAt: at(extra.doneAt ?? minutes), ...extra
});
const request = (id, source, minutes, items) => ({
  id, role: "participant", participantId: MAIN.id, participantLabel: "@main", status: "done", createdAt: at(minutes),
  content: items.map((entry) => `@${entry.targetHandle} ${entry.prompt}`).join("\n"),
  metadata: { sourceMessageId: source, participantRequest: {
    id: `batch-${id}`, requesterParticipantId: MAIN.id, requesterHandle: "main", source: "mcp", resumeRequester: true, status: "running",
    depth: 1, createdAt: at(minutes), updatedAt: at(minutes), triggerMessageId: source, items
  } }
});
const runningReply = (content) => ({ id: "r1", role: "participant", participantId: MAIN.id, participantLabel: "@main", content, status: "pending", createdAt: at(20),
  metadata: { runId: "run-main", sourceMessageId: "u1" } });
const plainReply = (fields = {}) => ({ id: "r2", role: "participant", participantId: MAIN.id, participantLabel: "@main", content: "Thinking it over", status: "pending",
  createdAt: at(3), ...fields, metadata: { runId: "run-main-2", sourceMessageId: "u2", ...(fields.metadata || {}) } });
const drewReply = (fields = {}) => ({ id: "drew-run", role: "participant", participantId: DREW.id, participantLabel: "@drew", content: "Restyling", status: "pending",
  createdAt: at(10), ...fields, metadata: { runId: "run-drew", sourceMessageId: "req", ...(fields.metadata || {}) } });

function messages() {
  return [
    { id: "u0", role: "user", content: "Who did the old report?", status: "done", createdAt: at(40), metadata: { deliveryTargets: [MAIN.id] } },
    { id: "r0", role: "participant", participantId: MAIN.id, participantLabel: "@main", status: "done", createdAt: at(39), metadata: { sourceMessageId: "u0", workedMs: 4_000 },
      content: "@olga did. Ask `@drew` about it, run `npm i @types/node` and `ping @drew now`." },
    { id: "u1", role: "user", content: "Fix the login page", status: "done", createdAt: at(21), metadata: { deliveryTargets: [MAIN.id] } },
    runningReply("I gave the work out"),
    request("req", "u1", 19, [
      item(DREW.id, "drew", "Restyle the login button", "running", 19, { title: "Restyle button", targetKind: "claude-code" }),
      item(OLGA_ID, "olga", "Read the old report", "answered", 19, { title: "Old report", replyMessageId: "olga-reply", doneAt: 15, targetKind: "codex-cli" }),
      item("p-kim", "kim", "Measure the page", "interrupted", 19, { title: "Measure page", error: "Stopped by User.", doneAt: 14, targetKind: "gemini-cli" })
    ]),
    { id: "olga-reply", role: "participant", participantId: OLGA_ID, participantLabel: "@olga", content: "The old report is about logins.", status: "done", createdAt: at(15),
      metadata: { sourceMessageId: "req" } },
    drewReply(),
    { id: "u2", role: "user", content: "And the footer?", status: "done", createdAt: at(4), metadata: { deliveryTargets: [MAIN.id] } },
    plainReply()
  ];
}

test("sessions rows on the phone stay in step: Worked for, view switch, streaming tasks, chip titles, removed members' logos, code handles", { timeout: 240_000 }, async (t) => {
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: 8399, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-sessions-rows-");
  const chrome = launchChrome({ port: 9549, profile, url: `${site.origin}/` });
  let app;
  t.after(async () => {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  await hub.createChat("conv-rows", {
    title: "Rows", participants: [MAIN, DREW], createdAt: at(41),
    metadata: { mainSessionParticipantId: MAIN.id, chatView: "sessions" }, messages: messages()
  });
  app = await attachApp({ port: 9549 });
  await pairPage(app, { hub, siteOrigin: site.origin, query: "qa=1" });
  await openChat(app, "conv-rows");
  await app.waitFor(`Boolean(${row("r1")}) && Boolean(${row("r2")}) && ${row("r1")}.querySelectorAll(".sessions-delegation").length === 3`, "the main timeline with the running turn's tasks");

  // --- a removed member keeps its logo; a stopped task's line is muted ------
  const fold = await app.evaluate(`[...${row("r1")}.querySelectorAll(".sessions-delegation")].map((node) => [node.dataset.openMember,
    node.querySelector(".provider-logo").dataset.providerKind, node.querySelector(".sessions-delegation-result")?.textContent || "",
    Boolean(node.querySelector(".sessions-delegation-result.is-muted"))])`);
  assert.deepEqual(fold, [["p-drew", "claude-code", "", false], [OLGA_ID, "codex-cli", "The old report is about logins.", false], ["p-kim", "gemini-cli", "Stopped", true]],
    "each task's logo, removed members' too; a stopped task says so, muted");
  const r0 = await app.evaluate(`(() => { const node = ${row("r0")}.querySelector(".message-content");
    return { chips: [...node.querySelectorAll(".sessions-member-chip")].map((chip) => [chip.dataset.openMember, chip.querySelector(".provider-logo").dataset.providerKind, chip.textContent]),
      code: [...node.querySelectorAll("code")].map((code) => code.textContent) }; })()`);
  assert.deepEqual(r0.chips, [[OLGA_ID, "codex-cli", "Old report"], ["p-drew", "claude-code", "Restyle button"], ["p-drew", "claude-code", "Restyle button"]],
    "a removed member's chip keeps its logo; a member's handle in code, alone or among other code, is its chip");
  assert.deepEqual(r0.code, ["npm i @types/node", "ping ", " now"], "other @words in code stay as written; code around a member's chip too");

  // --- a running main reply with task rows keeps its node while it streams --
  await app.evaluate(`(() => { const node = ${row("r1")}; node.__kept = true; node.querySelector(".sessions-delegation").__kept = true; })()`);
  await hub.progress("conv-rows", "run-main", "I gave the work out and I am checking the styles", { participantLabel: "@main" });
  await app.waitFor(`${row("r1")}.querySelector(".message-copy > .message-content")?.textContent.includes("checking the styles")`, "the reply streams");
  assert.deepEqual(await app.evaluate(`[${row("r1")}.__kept === true, ${row("r1")}.querySelector(".sessions-delegation").__kept === true, ${row("r1")}.querySelectorAll(".sessions-delegation").length]`),
    [true, true, 3], "the row and its task rows are kept, not drawn again");

  // --- a reply that finishes on screen gets its "Worked for …" ---------------
  await app.evaluate(`${row("r2")}.__kept = true`);
  await hub.updateMessages("conv-rows", [plainReply({ status: "done", content: "The footer is fine.", metadata: { workedMs: 9_000 } })]);
  await app.waitFor(`${row("r2")}?.dataset.status === "Done"`, "the plain reply is done");
  const finished = await app.evaluate(`(() => { const node = ${row("r2")};
    return { kept: node.__kept === true, worked: node.querySelector(".sessions-worked")?.textContent || "",
      order: [...node.querySelector(".message-copy").children].map((child) => child.className.split(" ")[0]).slice(0, 3) }; })()`);
  assert.deepEqual(finished, { kept: true, worked: "Worked for 9s", order: ["message-meta", "sessions-worked", "message-content"] },
    "updated in place, with its Worked for above its words");

  // --- a chip follows its member's new task title -----------------------------
  await hub.addMessages("conv-rows", [request("req-2", "u2", 2, [item(DREW.id, "drew", "Tidy the footer", "running", 2, { title: "Tidy footer", targetKind: "claude-code" })])]);
  await app.waitFor(`[...${row("r0")}.querySelectorAll(".sessions-member-chip")].some((chip) => chip.textContent === "Tidy footer")`, "the chip's new title");

  // --- in a member's session, a reply that finishes gets its Worked for -------
  await app.evaluate(`document.querySelector('#message-list .sessions-member-chip[data-open-member="p-drew"]').click()`);
  await app.waitFor(`document.getElementById("chat-title").textContent === "Tidy footer" && Boolean(${row("drew-run")})`, "drew's session");
  await app.evaluate(`${row("drew-run")}.__kept = true`);
  await hub.updateMessages("conv-rows", [drewReply({ status: "done", content: "Restyled.", metadata: { workedMs: 61_000 } })]);
  await app.waitFor(`${row("drew-run")}?.dataset.status === "Done"`, "drew's reply is done");
  assert.deepEqual(await app.evaluate(`[${row("drew-run")}.__kept === true, ${row("drew-run")}.querySelector(".sessions-worked")?.textContent || ""]`),
    [true, "Worked for 1m 1s"]);
  await app.evaluate(`document.getElementById("back-to-timeline").click()`);
  await app.waitFor(`document.getElementById("chat-title").textContent === "Rows" && Boolean(${row("r2")})`, "back on the main timeline");

  // --- a removed member's logo in the panel and on its session's head ---------
  await app.evaluate(`document.getElementById("chat-members-button").click()`);
  await app.waitFor(`Boolean(document.querySelector('#members-sheet-list [data-members-removed]'))`, "the panel");
  await app.evaluate(`document.querySelector('#members-sheet-list [data-members-removed]').click()`);
  await app.waitFor(`Boolean(document.querySelector('#members-sheet-list .sessions-member-row.is-former[data-member-session="${OLGA_ID}"]'))`, "Removed opened");
  assert.deepEqual(await app.evaluate(`[...document.querySelectorAll('#members-sheet-list .sessions-member-row.is-former')].map((node) => [node.dataset.memberSession, node.querySelector(".provider-logo").dataset.providerKind])`),
    [[OLGA_ID, "codex-cli"], ["p-kim", "gemini-cli"]]);
  await app.evaluate(`document.querySelector('#members-sheet-list .sessions-member-row.is-former[data-member-session="${OLGA_ID}"]').click()`);
  await app.waitFor(`document.getElementById("chat-title").textContent === "Old report" && Boolean(document.querySelector(".member-session-head"))`, "olga's session");
  assert.deepEqual(await app.evaluate(`[document.querySelector(".member-session-head .provider-logo").dataset.providerKind, document.querySelector(".member-session-provider").textContent]`),
    ["codex-cli", "Removed from the chat"]);
  await app.evaluate(`document.getElementById("back-to-timeline").click()`);
  await app.waitFor(`document.getElementById("chat-title").textContent === "Rows" && Boolean(${row("r2")})`, "back again");

  // --- a view switch draws the rows of the other view ------------------------
  await app.evaluate(`document.getElementById("chat-members-toggle").click()`);
  await app.waitFor(`Boolean(document.querySelector('#chat-title-menu [data-title-view="classic"]'))`, "the title's menu");
  await app.evaluate(`document.querySelector('#chat-title-menu [data-title-view="classic"]').click()`);
  await app.waitFor(`document.querySelectorAll("#message-list .message-row.is-sessions").length === 0 && Boolean(document.querySelector('#message-list .message-row[data-thread-root="req"]'))`, "the classic timeline");
  assert.equal(await app.evaluate(`document.querySelectorAll("#message-list .sessions-worked, #message-list .sessions-delegations").length`), 0,
    "no sessions folds left in classic rows");
  await app.evaluate(`document.querySelector('#chat-view-switch [data-view="sessions"]').click()`);
  await app.waitFor(`document.querySelectorAll("#message-list .message-row.is-sessions").length > 0 && Boolean(${row("r2")})`, "the sessions view again");
  assert.equal(await app.evaluate(`${row("r2")}.querySelector(".sessions-worked")?.textContent || ""`), "Worked for 9s", "Worked for is back");
  assert.equal(await app.evaluate(`${row("r0")}.querySelector(".sessions-worked")?.textContent || ""`), "Worked for 4s");
});
