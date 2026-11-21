/**
 * The sessions view names nobody by handle on the phone either (the User,
 * 2026-11-21: "and so that I never see this crap '@main' anywhere in the UI").
 * What the app wrote — a failed or stopped reply, a task's failure, a
 * permission card, a document's note, Activity's rows — names a member by its
 * task and the main session by nothing; a classic chat keeps every handle.
 *
 * Driven through the real PWA in a browser against a real hub: supporting
 * evidence for the phone check, not a stand-in for it.
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
const DREW = member("drew", { id: "p-drew", kind: "codex-cli" });
const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const HANDLES = /(^|[^A-Za-z0-9_@./-])@(main|drew)\b/i;

function chatMessages() {
  return [
    { id: "u1", role: "user", content: "Fix the login page", status: "done", createdAt: at(30), metadata: { deliveryTargets: [MAIN.id] } },
    { id: "r1", role: "participant", participantId: MAIN.id, participantLabel: "@main", content: "I asked for help.", status: "done", createdAt: at(29),
      metadata: { sourceMessageId: "u1", workedMs: 30_000 } },
    { id: "req", role: "participant", participantId: MAIN.id, participantLabel: "@main", status: "done", createdAt: at(28),
      content: "@drew Restyle the login button",
      metadata: { sourceMessageId: "u1", participantRequest: {
        id: "batch-req", requesterParticipantId: MAIN.id, requesterHandle: "main", source: "mcp", resumeRequester: true, status: "running", depth: 1,
        createdAt: at(28), updatedAt: at(20), triggerMessageId: "u1",
        items: [{ targetParticipantId: DREW.id, targetHandle: "drew", prompt: "Restyle the login button", title: "Restyle the button", status: "failed",
          error: "@drew run failed before a response was produced: @drew belongs to another machine; no local session was started.", createdAt: at(28), updatedAt: at(20) }]
      } } },
    { id: "u2", role: "user", content: "Try again", status: "done", createdAt: at(10), metadata: { deliveryTargets: [MAIN.id] } },
    { id: "r2", role: "participant", participantId: MAIN.id, participantLabel: "@main", content: "@main stopped before it returned a response.", status: "error", createdAt: at(9),
      metadata: { sourceMessageId: "u2" } },
    { id: "note", role: "system", content: "@main revised [Login plan](#artifact:art-1) · v3", status: "done", createdAt: at(8),
      metadata: { appMessageSource: "app_artifact_note", artifactEventId: "e-note" } }
  ];
}

const permission = (conversationId, requester, id) => ({
  id, conversationId, requesterParticipantId: requester.id, requesterHandle: requester.handle, requesterRoleConfigId: requester.roleConfigId,
  toolName: "app_tool_permission", capability: "permissions.request", status: "pending",
  request: { kind: "toolPermission", toolName: "Bash", toolInput: { command: "npm test" } },
  summary: `Grant @${requester.handle} shell access`, createdAt: at(5), updatedAt: at(5)
});

test("a sessions-view chat names nobody by handle on the phone (failed replies, task rows, cards, notes, Activity); a classic chat keeps its handles", { timeout: 240_000 }, async (t) => {
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: 8397, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-nohandles-");
  const chrome = launchChrome({ port: 9547, profile, url: `${site.origin}/` });
  let app;
  t.after(async () => {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  await hub.createChat("conv-sessions", { title: "Login page", participants: [MAIN, DREW], createdAt: at(31),
    metadata: { mainSessionParticipantId: MAIN.id, chatView: "sessions" }, messages: chatMessages() });
  await hub.createChat("conv-classic", { title: "Login page classic", participants: [MAIN, DREW], createdAt: at(31),
    metadata: { mainSessionParticipantId: MAIN.id, chatView: "classic" }, messages: chatMessages().map((message) => ({ ...message, id: `c-${message.id}` })) });
  await hub.raiseApproval("conv-sessions", permission("conv-sessions", MAIN, "card-main"), { participantId: MAIN.id });
  await hub.raiseApproval("conv-sessions", permission("conv-sessions", DREW, "card-drew"), { participantId: DREW.id });
  await hub.raiseApproval("conv-classic", permission("conv-classic", MAIN, "card-classic"), { participantId: MAIN.id });
  app = await attachApp({ port: 9547 });
  await pairPage(app, { hub, siteOrigin: site.origin, query: "qa=1" });

  // --- the sessions view ---------------------------------------------------
  await openChat(app, "conv-sessions");
  await app.waitFor(`document.querySelector('#message-list .message-row[data-thread-root="r2"]') !== null && document.querySelector('[data-card-id="card-main"]') !== null`,
    "the failed reply and the main session's card");
  const shown = await app.evaluate(`(() => {
    const row = document.querySelector('#message-list .message-row[data-thread-root="r2"]');
    const card = document.querySelector('[data-card-id="card-main"]');
    return { failed: row.querySelector(".message-content").textContent.trim(), card: card.innerText, who: card.querySelector(".control-card-who")?.textContent ?? "",
      note: document.querySelector(".artifact-note-title")?.textContent ?? "", list: document.getElementById("message-list").innerText,
      labels: [...document.querySelectorAll("#message-list [title], #message-list [aria-label]")].map((node) => (node.getAttribute("title") || "") + " " + (node.getAttribute("aria-label") || "")).join("\\n") };
  })()`);
  assert.equal(shown.failed, "Stopped before it returned a response.", "the main session's failure without a name");
  assert.equal(shown.who, "", "the main session's card names nobody");
  assert.doesNotMatch(shown.card, HANDLES, shown.card);
  assert.match(shown.note, /^Revised/, "the main session's note without a name");
  assert.doesNotMatch(shown.list, HANDLES, shown.list);
  assert.doesNotMatch(shown.labels, HANDLES, shown.labels);
  assert.doesNotMatch(shown.list, /Main session/, "no label for the main session");
  // The task's failure in its row inside the reply's Worked fold, the member by its task.
  await app.evaluate(`document.querySelector('#message-list .message-row[data-thread-root="r1"] .sessions-worked-toggle')?.click()`);
  await app.waitFor(`document.querySelector('#message-list .sessions-delegation .sessions-delegation-result') !== null`, "the failed task's row");
  const task = await app.evaluate(`document.querySelector('#message-list .sessions-delegation .sessions-delegation-result').textContent`);
  assert.equal(task, "“Restyle the button” run failed before a response was produced: “Restyle the button” belongs to another machine; no local session was started.");
  const drewCard = await app.evaluate(`(() => { const card = document.querySelector('[data-card-id="card-drew"]'); return card ? { text: card.innerText, who: card.querySelector(".control-card-who")?.textContent ?? "" } : null; })()`);
  if (drewCard) {
    assert.equal(drewCard.who, "Restyle the button", "a member's card by its task");
    assert.doesNotMatch(drewCard.text, HANDLES, drewCard.text);
  }
  // Activity: the main session by nothing, a member by its task.
  await app.evaluate(`document.getElementById("timeline-back")?.click()`);
  await app.waitFor(`(() => { const dock = document.getElementById("home-dock"); return Boolean(dock && !dock.hidden); })()`, "the bottom bar");
  await app.evaluate(`document.querySelector('[data-home-tab="activity"]').click()`);
  await app.evaluate(`document.querySelector('[data-activity-tab="pending"]')?.click()`);
  await app.waitFor(`document.querySelectorAll("#activity-list .act-row[data-card-id]").length >= 3`, "the Pending list");
  const rows = await app.evaluate(`[...document.querySelectorAll("#activity-list .act-row")].map((row) => ({ card: row.dataset.cardId || "", text: row.innerText.replace(/\\s+/g, " ").trim() }))`);
  t.diagnostic(`pending rows: ${JSON.stringify(rows)}`);
  const sessionsRows = rows.filter((row) => row.card === "card-main" || row.card === "card-drew");
  assert.ok(sessionsRows.length >= 2, "both cards of the sessions-view chat are listed");
  for (const row of sessionsRows) assert.doesNotMatch(row.text, HANDLES, row.text);
  const classicRow = rows.find((row) => row.card === "card-classic");
  assert.ok(classicRow, "the classic chat's card is listed");
  assert.match(classicRow.text, /@main/, "a classic chat keeps the handle in Activity");

  // --- the classic view keeps its handles ---------------------------------
  await app.evaluate(`document.querySelector('[data-home-tab="chats"]').click()`);
  await openChat(app, "conv-classic");
  await app.waitFor(`document.querySelector('#message-list .message-row[data-row-key="c-r2"], #message-list .message-row[data-thread-root="c-r2"]') !== null`, "the classic chat's failed reply");
  const classic = await app.evaluate(`document.getElementById("message-list").innerText`);
  assert.match(classic, /@main stopped before it returned a response\./);
});
