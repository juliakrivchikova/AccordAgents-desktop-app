/**
 * Fork to new chat on the phone (src/shared/forkToNewChat.ts), driven through
 * the real PWA in a browser against a real hub: the title's menu offers it
 * for the main session on the main timeline and for a member on its own
 * screen, as the computer's member menus do, and in the classic view a small
 * action on each member's row in the members sheet opens the same item under
 * it, as the computer's roster card offers it; disabled with the computer's
 * reason (a member that never ran, Antigravity, a machine with an older
 * program, a CLI not ready on the computer, a server or a computer from
 * before); chosen, it makes the new chat on the server as the computer makes
 * it ("<chat> (fork)", the member's project, the computer's view, one main
 * session on the member's provider, model, effort, access as it runs and
 * place, with where it comes from) and opens it at once.
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

const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const rights = (patch = {}) => ({ repoRead: true, workspaceWrite: false, webAccess: false, requestParticipants: "ask", requestCompaction: "ask",
  shell: { enabled: false, rules: [] }, ...patch });

// The main session: Codex, in Default, may read and reach the web.
const MAIN = member("main", { id: "p-main", roleConfigId: "main-session", kind: "codex-cli", model: "gpt-5.5", agentMode: "default",
  permissions: rights({ webAccess: true, requestParticipants: "allow" }) });
// Members it made. drew has more than the main session may give: it is
// copied as it runs, never above the main session.
const DREW = member("drew", { id: "p-drew", delegatedByParticipantId: MAIN.id, model: "sonnet", reasoningEffort: "high", agentMode: "auto",
  permissions: rights({ workspaceWrite: true, webAccess: true, cliApprovals: true, shell: { enabled: true, rules: [{ action: "deny", match: "prefix", pattern: "git push" }] } }) });
const TAYLOR = member("taylor", { id: "p-taylor", kind: "codex-cli", delegatedByParticipantId: MAIN.id });
const SAM = member("sam", { id: "p-sam", kind: "gemini-cli", delegatedByParticipantId: MAIN.id });
const BOX = member("box", { id: "p-box", homeMachineId: "m-box", delegatedByParticipantId: MAIN.id });

const item = (target, handle, prompt, status, extra = {}) => ({ targetParticipantId: target, targetHandle: handle, prompt, status, createdAt: at(28), updatedAt: at(20), ...extra });

function chatMessages() {
  return [
    { id: "u1", role: "user", content: "Fix the login page", status: "done", createdAt: at(30), metadata: { deliveryTargets: [MAIN.id] } },
    { id: "r1", role: "participant", participantId: MAIN.id, participantLabel: "@main", content: "I asked the members.", status: "done", createdAt: at(29.5),
      metadata: { sourceMessageId: "u1", workedMs: 30_000 } },
    { id: "req", role: "participant", participantId: MAIN.id, participantLabel: "@main", status: "done", createdAt: at(28),
      content: "@drew Restyle the login button\n@taylor Run the login tests\n@sam Read the logs\n@box Build it on the box",
      metadata: { sourceMessageId: "u1", participantRequest: {
        id: "batch-req", requesterParticipantId: MAIN.id, requesterHandle: "main", source: "mcp", resumeRequester: true, status: "running",
        depth: 1, createdAt: at(28), updatedAt: at(28), triggerMessageId: "u1", items: [
          item(DREW.id, "drew", "Restyle the login button", "answered", { replyMessageId: "drew-reply" }),
          item(TAYLOR.id, "taylor", "Run the login tests", "running"),
          item(SAM.id, "sam", "Read the logs", "running"),
          item(BOX.id, "box", "Build it on the box", "answered", { replyMessageId: "box-reply" })
        ] } } },
    // drew's reply ended a turn and recorded where its session stood; it
    // posted again during a later turn, still running.
    { id: "drew-reply", role: "participant", participantId: DREW.id, participantLabel: "@drew", content: "Restyled.", status: "done", createdAt: at(20),
      metadata: { sourceMessageId: "req", workedMs: 60_000, sessionCut: { sessionId: "s-drew", at: "drew-assistant-1" } } },
    { id: "drew-post", role: "participant", participantId: DREW.id, participantLabel: "@drew", content: "Now the colors.", status: "done", createdAt: at(10),
      metadata: { sourceMessageId: "req", appMessageSource: "app_chat_send_message" } },
    { id: "box-reply", role: "participant", participantId: BOX.id, participantLabel: "@box", content: "Built.", status: "done", createdAt: at(19),
      metadata: { sourceMessageId: "req" } }
  ];
}

// What the computer publishes for New chat: its main session as it would
// make one, and what the phone needs to fork as it does.
const OFFERED_MAIN = { id: "main-session", handle: "main", roleConfigId: "main-session", behaviorRuleIds: [], kind: "codex-cli", agentMode: "default",
  permissions: rights({ requestParticipants: "allow" }), remoteExecution: "local", skipToolchainPreflight: false, autoWatch: false };
const FORK_OFFER = {
  judged: true,
  localProviders: [{ kind: "claude-code" }, { kind: "codex-cli" }],
  machines: { "m-box": "outdated" },
  basePermissions: rights({ requestParticipants: "allow" })
};

const visible = (selector) => `(() => { const node = document.querySelector(${JSON.stringify(selector)}); return Boolean(node && !node.hidden && node.offsetParent !== null); })()`;
const title = `document.getElementById("chat-title").textContent`;
const forkItem = `(() => { const node = document.getElementById("chat-title-fork"); return { shown: !node.hidden && node.offsetParent !== null,
  disabled: node.getAttribute("aria-disabled"), label: node.querySelector(".chat-title-menu-label").textContent,
  detail: document.getElementById("chat-title-fork-detail").textContent,
  views: [...document.querySelectorAll("#chat-title-menu [data-title-view]")].filter((view) => !view.hidden).length }; })()`;

/** Opens the title's menu and waits until it says whether the fork can be made. */
async function openForkMenu(app) {
  if (!(await app.evaluate(visible("#chat-title-menu")))) await app.evaluate(`document.getElementById("chat-members-toggle").click()`);
  await app.waitFor(visible("#chat-title-menu"), "the title's menu");
  await app.waitFor(`document.getElementById("chat-title-fork-detail").textContent !== "Checking…"`, "the fork's answer");
  return app.evaluate(forkItem);
}

async function closeMenu(app) {
  if (await app.evaluate(visible("#chat-title-menu"))) await app.evaluate(`document.getElementById("chat-members-toggle").click()`);
  await app.waitFor(`!(${visible("#chat-title-menu")})`, "the menu closed");
}

const mainShown = `(${title} === "Login page" && document.querySelector('#message-list .message-row[data-thread-root="r1"]') !== null)`;

/** Opens a member's session from the side panel, as a tap on its row does. */
async function openMemberFromTimeline(app, participantId, name) {
  const row = `#members-sheet-list .sessions-member-row[data-member-session="${participantId}"]`;
  await app.evaluate(`document.getElementById("chat-members-button").click()`);
  await app.waitFor(visible("#members-sheet"), "the side panel");
  // A member whose task ended is under Previous.
  await app.evaluate(`(() => { const previous = document.querySelector('#members-sheet-list [data-members-previous]');
    if (!document.querySelector(${JSON.stringify(row)}) && previous && previous.getAttribute("aria-expanded") !== "true") previous.click(); })()`);
  await app.waitFor(`document.querySelector(${JSON.stringify(row)}) !== null`, `${participantId} in the side panel`);
  await app.evaluate(`document.querySelector(${JSON.stringify(row)}).click()`);
  await app.waitFor(`${title} === ${JSON.stringify(name)}`, `${participantId}'s session`);
}

async function backToMain(app) {
  await app.evaluate(`document.getElementById("back-to-timeline").click()`);
  await app.waitFor(mainShown, "the main timeline");
}

/** Every answer of the server's New chat read passes through `change`
 *  (a server or a computer from before, a CLI that stopped being ready). */
async function rewriteForkAnswers(app, change) {
  await app.evaluate(`(() => { const real = window.__realFetch || window.fetch; window.__realFetch = real;
    const change = ${change};
    window.fetch = async function (input, init) {
      const response = await real.call(window, input, init);
      if (String(input && input.url || input).indexOf("/v1/phone/new-chat") < 0 || !change) return response;
      const body = change(await response.clone().json());
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }; })()`);
}

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

test("the phone forks a member to a new chat from the title's menu as the computer does, refusing with the computer's words", { timeout: 180_000 }, async (t) => {
  const { createDeviceIdentity } = require("../dist/main/main/services/deviceIdentity.js");
  const box = createDeviceIdentity(new Date().toISOString());
  const hub = await startMobileHub({ rosterDevices: [
    { deviceId: box.originId, publicKeyDerBase64: box.publicKeyDerBase64, role: "machine", name: "Box", machineId: "m-box" }
  ] });
  const site = await serveMobileShell({ port: 8411, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-fork-");
  const chrome = launchChrome({ port: 9561, profile, url: `${site.origin}/` });
  let app;
  t.after(async () => {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  await hub.createChat("conv-main", {
    title: "Login page", repoPath: "/Users/u/site", participants: [MAIN, DREW, TAYLOR, SAM, BOX], createdAt: at(31),
    metadata: { mainSessionParticipantId: MAIN.id, chatView: "sessions" }, messages: chatMessages()
  });
  const published = await hub.call("PUT", "/v1/catalog", { catalog: { version: 1, publishedAt: new Date().toISOString(),
    roles: { "software-engineer": "Engineer", "main-session": "Main session" }, prompts: [], skills: [], avatars: {},
    newChat: { projects: [{ path: "/Users/u/site", label: "site" }], defaultProject: "/Users/u/site", mainSession: OFFERED_MAIN, assistant: OFFERED_MAIN,
      defaultChatView: "sessions", members: [], fork: FORK_OFFER } } });
  assert.equal(published.ok, true);
  app = await attachApp({ port: 9561 });
  await pairPage(app, { hub, siteOrigin: site.origin, query: "qa=1" });
  await openChat(app, "conv-main");
  await app.waitFor(mainShown, "the main timeline");

  // --- the main session, on the main timeline ------------------------------
  const mainItem = await openForkMenu(app);
  assert.deepEqual(mainItem, { shown: true, disabled: "false", label: "Fork to new chat", detail: "A new chat that starts from a copy of this session", views: 2 },
    "beside the chat's view, offered for the main session");
  await closeMenu(app);

  // --- members on their own screens, each with the computer's reason ------
  const reasons = {};
  for (const [id, name] of [["p-taylor", "Run the login tests"], ["p-sam", "Read the logs"], ["p-box", "Build it on the box"]]) {
    await openMemberFromTimeline(app, id, name);
    assert.equal(await app.evaluate(visible("#chat-title-chevron")), true, `${id}: its screen has the menu`);
    const shown = await openForkMenu(app);
    assert.equal(shown.views, 0, `${id}: no view choice off the main timeline`);
    assert.equal(shown.disabled, "true", id);
    reasons[id] = shown.detail;
    // A tap on it does nothing: its line says why.
    await app.evaluate(`document.getElementById("chat-title-fork").click()`);
    assert.equal(await app.evaluate(visible("#chat-title-menu")), true, `${id}: the menu stays with its reason`);
    await closeMenu(app);
    await backToMain(app);
  }
  assert.deepEqual(reasons, {
    "p-taylor": "It has not run yet, so it has no session to copy.",
    "p-sam": "Antigravity has no session fork.",
    "p-box": "Its machine runs an older program. Upgrade its runtime in Settings → Machines."
  });

  // A CLI the computer cannot run now, a computer and a server from before.
  await openMemberFromTimeline(app, "p-drew", "Restyle the login button");
  await rewriteForkAnswers(app, `(body) => ({ ...body, options: { ...body.options, fork: { ...body.options.fork,
    localProviders: [{ kind: "claude-code", unavailable: "Claude Code requires sign-in." }, { kind: "codex-cli" }] } } })`);
  assert.equal((await openForkMenu(app)).detail, "Claude Code requires sign-in.");
  await closeMenu(app);
  await rewriteForkAnswers(app, `(body) => ({ ...body, options: { ...body.options, fork: undefined } })`);
  assert.equal((await openForkMenu(app)).detail, "Your computer does not fork chats from the phone yet. Update AccordAgents on your computer.");
  await closeMenu(app);
  await rewriteForkAnswers(app, `(body) => ({ ...body, fork: undefined })`);
  assert.equal((await openForkMenu(app)).detail, "Your server does not fork chats from the phone yet. It will once AccordAgents on your computer has updated.");
  await closeMenu(app);
  // The member left its chat meanwhile; the computer never told the server
  // what it offers.
  await rewriteForkAnswers(app, `(body) => ({ ...body, fork: { ...body.fork, member: undefined } })`);
  assert.equal((await openForkMenu(app)).detail, "That member is no longer in its chat.");
  await closeMenu(app);
  await rewriteForkAnswers(app, `(body) => ({ ok: true, type: "mobile.new-chat", unavailable: "Your computer has not told your server about its projects and members yet.", fork: body.fork })`);
  assert.equal((await openForkMenu(app)).detail, "Your computer has not told your server about its projects and members yet.");
  await closeMenu(app);
  await rewriteForkAnswers(app, "undefined");
  // The chat is gone from the server; the server cannot be reached.
  for (const [answer, said] of [
    [`new Response(JSON.stringify({ ok: false, error: "chat_not_found" }), { status: 404, headers: { "content-type": "application/json" } })`, /^This chat is not on your server\.$/],
    [`Promise.reject(new TypeError("Failed to fetch"))`, /^Could not reach your server/]
  ]) {
    await app.evaluate(`(() => { const real = window.__realFetch; window.fetch = function (input, init) {
      return String(input && input.url || input).indexOf("/v1/phone/new-chat") >= 0 ? ${answer} : real.call(window, input, init); }; })()`);
    assert.match((await openForkMenu(app)).detail, said);
    await closeMenu(app);
  }
  await app.evaluate(`window.fetch = window.__realFetch`);

  // The phone cannot write its queue: nothing is queued, nothing is listed,
  // and the menu says why.
  await openForkMenu(app);
  await app.evaluate(`(() => { const real = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function () {
      if (this.name !== "outbox") return real.apply(this, arguments);
      IDBObjectStore.prototype.put = real;
      throw new Error("QA: the phone's storage is full");
    };
    document.getElementById("chat-title-fork").click(); })()`);
  await app.waitFor(`document.getElementById("chat-title-fork-detail").textContent === "Could not start the chat: QA: the phone's storage is full"`, "the failure, in the menu");
  assert.equal(await app.evaluate(visible("#send-log-button")), false, "said where she tapped: not in the send log");
  assert.equal(await app.evaluate(`localStorage.getItem("accordagents.mobile.startedChats.v1")`), null, "nothing left in the list");
  assert.equal(hub.opsRequests.flatMap((request) => request.ops || []).some((op) => op.kind === "conversation.create"), false);
  await closeMenu(app);

  // Open on the main timeline when the screen under it changes without a
  // tap (here: taylor's session opened by a redraw): read for taylor.
  await backToMain(app);
  assert.equal((await openForkMenu(app)).disabled, "false");
  await app.evaluate(`sessionStorage.setItem("accordagents.mobile.openMemberSessionId.v1", "p-taylor")`);
  await hub.addMessages("conv-main", [{ id: "u-later", role: "user", content: "Any news?", status: "done", createdAt: new Date().toISOString(), metadata: { deliveryTargets: [MAIN.id] } }]);
  await app.waitFor(`${title} === "Run the login tests" && document.getElementById("chat-title-fork-detail").textContent === "It has not run yet, so it has no session to copy."`,
    "the menu read again for the member under it");
  await closeMenu(app);
  await backToMain(app);
  await openMemberFromTimeline(app, "p-drew", "Restyle the login button");

  // --- drew, forked ---------------------------------------------------------
  const drewItem = await openForkMenu(app);
  assert.deepEqual({ disabled: drewItem.disabled, detail: drewItem.detail }, { disabled: "false", detail: "A new chat that starts from a copy of this session" });
  await app.evaluate(`document.getElementById("chat-title-fork").click()`);
  const create = await waitForOp(hub, (op) => op.kind === "conversation.create");
  assert.equal(create.conversation.title, "Login page (fork)");
  assert.equal(create.conversation.repoPath, "/Users/u/site", "the member's project");
  const [forked, ...others] = create.conversation.metadata.participants;
  assert.equal(others.length, 0, "the main session alone");
  assert.deepEqual({ mainSessionParticipantId: create.conversation.metadata.mainSessionParticipantId, chatView: create.conversation.metadata.chatView },
    { mainSessionParticipantId: forked.id, chatView: "sessions" });
  assert.deepEqual({ handle: forked.handle, roleConfigId: forked.roleConfigId, kind: forked.kind, model: forked.model, reasoningEffort: forked.reasoningEffort,
    agentMode: forked.agentMode, homeMachineId: forked.homeMachineId, avatarId: forked.avatarId },
  { handle: "main", roleConfigId: "main-session", kind: "claude-code", model: "sonnet", reasoningEffort: "high", agentMode: "default", homeMachineId: undefined, avatarId: undefined },
  "the member's provider, model and effort, in its mode as it runs under the main session, here on the computer");
  assert.deepEqual(forked.permissions, { ...rights({ webAccess: true, requestParticipants: "allow",
    shell: { enabled: false, rules: [{ action: "deny", match: "prefix", pattern: "git push" }] } }), cliApprovals: true },
  "what it may do as it runs (no edits or commands above the main session), in Claude Code's own mode (Manual: what it may not do it asks about; the User, 2026-11-22: no Custom in the sessions view), with the main session's say over members");
  const drewReply = (await hub.storage.getConversation("conv-main"))?.messages.find((message) => message.id === "drew-reply");
  assert.deepEqual(forked.forkOrigin, { conversationId: "conv-main", participantId: DREW.id, handle: "drew", conversationTitle: "Login page", kind: "claude-code",
    seen: { messageId: "drew-reply", sessionCut: { sessionId: "s-drew", at: "drew-assistant-1" }, finishedAt: new Date(Date.parse(drewReply.createdAt) + 60_000).toISOString() } },
  "with the reply she saw last (not the post of the turn still running): the copy ends with its turn");
  const intro = await waitForOp(hub, (op) => op.kind === "message.create" && op.conversationId === create.conversationId && op.message.role === "system");
  assert.equal(intro.message.content, "Chat started.\nMembers:\n- User\n- @main");
  assert.equal((hub.opsRequests.flatMap((request) => request.ops || [])).some((op) => op.conversationId === create.conversationId && op.kind === "message.create" && op.message.role === "user"),
    false, "nothing is sent for her: the first message makes the copy");

  // Open at once, empty, in the sessions view.
  await app.waitFor(`document.getElementById("message-list").dataset.conversationId === ${JSON.stringify(create.conversationId)} && ${title} === "Login page (fork)"`,
    "the new chat, open");
  assert.equal(await app.evaluate(`document.getElementById("composer-input").placeholder`), "Ask anything", "its main composer");
  assert.equal(await app.evaluate(visible("#back-to-chats")), true);
  const stored = await hub.storage.getConversation(create.conversationId);
  assert.deepEqual(stored?.metadata.participants[0].forkOrigin, forked.forkOrigin, "on the server with where it comes from");
  const source = await hub.storage.getConversation("conv-main");
  assert.equal(source?.metadata.participants.length, 5, "the member and its chat are not touched");
});

// --- the classic view ---------------------------------------------------
// A chat from before with its Assistant: no main session, so the phone shows
// it in the classic view and lists its members in the members sheet.
const ASSISTANT = member("assistant", { id: "p-assistant", roleConfigId: "administrator", kind: "codex-cli", model: "gpt-5.5", reasoningEffort: "medium",
  agentMode: "default", permissions: rights({ webAccess: true }) });
const GERA = member("gera", { id: "p-gera" });
const SAGE = member("sage", { id: "p-sage", kind: "gemini-cli" });

const sheetRow = (id) => `document.querySelector('#members-sheet-list .members-sheet-row [data-member-fork=${JSON.stringify(id)}]')?.closest(".members-sheet-row")`;
const sheetFork = `(() => { const node = document.getElementById("members-sheet-fork"); if (!node) return undefined;
  const row = node.previousElementSibling;
  return { under: row && row.querySelector("[data-member-fork]") ? row.querySelector("[data-member-fork]").dataset.memberFork : undefined,
    disabled: node.getAttribute("aria-disabled"), label: node.querySelector(".chat-title-menu-label").textContent,
    detail: document.getElementById("members-sheet-fork-detail").textContent,
    open: [...document.querySelectorAll("#members-sheet-list [data-member-fork]")].filter((button) => button.getAttribute("aria-expanded") === "true").map((button) => button.dataset.memberFork) }; })()`;

/** Taps a member's fork action in the members sheet and waits for its item's answer. */
async function openSheetFork(app, participantId) {
  await app.evaluate(`${sheetRow(participantId)}.querySelector("[data-member-fork]").click()`);
  await app.waitFor(`(() => { const node = document.getElementById("members-sheet-fork");
    return Boolean(node && node.dataset.forkParticipant === ${JSON.stringify(participantId)} &&
      document.getElementById("members-sheet-fork-detail").textContent !== "Checking…"); })()`, `${participantId}'s fork answer`);
  return app.evaluate(sheetFork);
}

test("in the classic view the phone forks a member from a small action on its row in the members sheet, with the same read, words and chat", { timeout: 180_000 }, async (t) => {
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: 8412, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-fork-classic-");
  const chrome = launchChrome({ port: 9562, profile, url: `${site.origin}/` });
  let app;
  t.after(async () => {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  await hub.createChat("conv-old", {
    title: "Old notes", repoPath: "/Users/u/site", participants: [ASSISTANT, GERA, SAGE], createdAt: at(41),
    messages: [
      { id: "u1", role: "user", content: "Sum up the notes", status: "done", createdAt: at(40), metadata: { deliveryTargets: [ASSISTANT.id, SAGE.id] } },
      // From before replies recorded where their session stood: the copy
      // ends by its finish.
      { id: "a1", role: "participant", participantId: ASSISTANT.id, participantLabel: "@assistant", content: "Summed up.", status: "done", createdAt: at(39),
        metadata: { sourceMessageId: "u1", workedMs: 5_000 } },
      { id: "s1", role: "participant", participantId: SAGE.id, participantLabel: "@sage", content: "Read them.", status: "done", createdAt: at(38),
        metadata: { sourceMessageId: "u1" } }
    ]
  });
  const published = await hub.call("PUT", "/v1/catalog", { catalog: { version: 1, publishedAt: new Date().toISOString(),
    roles: { "software-engineer": "Engineer", "main-session": "Main session", administrator: "Assistant" }, prompts: [], skills: [], avatars: {},
    newChat: { projects: [{ path: "/Users/u/site", label: "site" }], defaultProject: "/Users/u/site", mainSession: OFFERED_MAIN, assistant: OFFERED_MAIN,
      defaultChatView: "sessions", members: [], fork: FORK_OFFER } } });
  assert.equal(published.ok, true);
  app = await attachApp({ port: 9562 });
  await pairPage(app, { hub, siteOrigin: site.origin, query: "qa=1" });
  await openChat(app, "conv-old");
  await app.waitFor(`${title} === "Old notes"`, "the classic chat");
  assert.equal(await app.evaluate(visible("#chat-title-chevron")), false, "the classic view: no title menu");

  // The title opens the members; each row ends with its fork action, no item yet.
  await app.evaluate(`document.getElementById("chat-members-toggle").click()`);
  await app.waitFor(`${visible("#members-sheet")} && document.querySelectorAll("#members-sheet-list .members-sheet-row").length === 3`, "the members sheet");
  const actions = await app.evaluate(`[...document.querySelectorAll("#members-sheet-list .members-sheet-row")].map((row) => {
    const button = row.querySelector("[data-member-fork]"); const box = button.getBoundingClientRect(); const end = row.getBoundingClientRect();
    return { id: button.dataset.memberFork, label: button.getAttribute("aria-label"), expanded: button.getAttribute("aria-expanded"),
      atEnd: end.right - box.right <= 12, tappable: box.width >= 40 && box.height >= 40, last: row.lastElementChild === button }; })`);
  assert.deepEqual(actions, [
    { id: "p-assistant", label: "Fork to new chat: Chat Assistant", expanded: "false", atEnd: true, tappable: true, last: true },
    { id: "p-gera", label: "Fork to new chat: @gera", expanded: "false", atEnd: true, tappable: true, last: true },
    { id: "p-sage", label: "Fork to new chat: @sage", expanded: "false", atEnd: true, tappable: true, last: true }
  ]);
  assert.equal(await app.evaluate(`document.getElementById("members-sheet-fork")`), null);

  // A member that never ran: its item, under it, disabled with the computer's words.
  const gera = await openSheetFork(app, "p-gera");
  assert.deepEqual(gera, { under: "p-gera", disabled: "true", label: "Fork to new chat", detail: "It has not run yet, so it has no session to copy.", open: ["p-gera"] });
  // A tap on it makes nothing: the sheet and its line stay.
  await app.evaluate(`document.getElementById("members-sheet-fork").click()`);
  assert.equal(await app.evaluate(visible("#members-sheet")), true);
  assert.equal((await app.evaluate(sheetFork)).detail, "It has not run yet, so it has no session to copy.");
  // Antigravity: one item at a time, read for that member.
  assert.deepEqual(await openSheetFork(app, "p-sage"), { under: "p-sage", disabled: "true", label: "Fork to new chat", detail: "Antigravity has no session fork.", open: ["p-sage"] });
  // A second tap closes it.
  await app.evaluate(`${sheetRow("p-sage")}.querySelector("[data-member-fork]").click()`);
  await app.waitFor(`document.getElementById("members-sheet-fork") === null`, "the item closed");
  // A computer from before says so here too.
  await rewriteForkAnswers(app, `(body) => ({ ...body, options: { ...body.options, fork: undefined } })`);
  assert.equal((await openSheetFork(app, "p-assistant")).detail, "Your computer does not fork chats from the phone yet. Update AccordAgents on your computer.");
  await app.evaluate(`${sheetRow("p-assistant")}.querySelector("[data-member-fork]").click()`);
  await rewriteForkAnswers(app, "undefined");
  assert.equal(hub.opsRequests.flatMap((request) => request.ops || []).some((op) => op.kind === "conversation.create"), false, "nothing made yet");

  // The item closes with the sheet: reopened, no member's item is open.
  await openSheetFork(app, "p-gera");
  await app.evaluate(`document.getElementById("members-sheet-close").click()`);
  await app.waitFor(`!(${visible("#members-sheet")})`, "the sheet closed");
  await app.evaluate(`document.getElementById("chat-members-toggle").click()`);
  await app.waitFor(`${visible("#members-sheet")} && document.querySelectorAll("#members-sheet-list [data-member-fork]").length === 3`, "the sheet again");
  assert.equal(await app.evaluate(`document.getElementById("members-sheet-fork")`), null);
  assert.deepEqual(await app.evaluate(`[...document.querySelectorAll("#members-sheet-list [data-member-fork]")].map((button) => button.getAttribute("aria-expanded"))`), ["false", "false", "false"]);
  // A member's row is no button around its fork action: what it opens is beside it.
  assert.equal(await app.evaluate(`document.querySelector("#members-sheet-list [data-member-fork]").closest('[role="button"]')`), null);

  // The chat drawn again under the open item (a new message): it keeps its answer.
  assert.equal((await openSheetFork(app, "p-assistant")).disabled, "false");
  await hub.addMessages("conv-old", [{ id: "u-later", role: "user", content: "Anything else?", status: "done", createdAt: new Date().toISOString(), metadata: { deliveryTargets: [ASSISTANT.id] } }]);
  await app.waitFor(`[...document.querySelectorAll("#message-list .message-row")].some((row) => row.textContent.includes("Anything else?"))`, "the new message");
  assert.deepEqual(await app.evaluate(sheetFork), { under: "p-assistant", disabled: "false", label: "Fork to new chat",
    detail: "A new chat that starts from a copy of this session", open: ["p-assistant"] });

  // The phone cannot write its queue: nothing is queued or listed, and the item says why.
  await app.evaluate(`(() => { const real = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function () {
      if (this.name !== "outbox") return real.apply(this, arguments);
      IDBObjectStore.prototype.put = real;
      throw new Error("QA: the phone's storage is full");
    };
    document.getElementById("members-sheet-fork").click(); })()`);
  await app.waitFor(`document.getElementById("members-sheet-fork-detail").textContent === "Could not start the chat: QA: the phone's storage is full"`, "the failure, in the item");
  assert.equal(await app.evaluate(visible("#send-log-button")), false, "said where she tapped: not in the send log");
  assert.equal(await app.evaluate(visible("#members-sheet")), true);
  assert.equal(await app.evaluate(`localStorage.getItem("accordagents.mobile.startedChats.v1")`), null, "nothing left in the list");
  assert.equal(hub.opsRequests.flatMap((request) => request.ops || []).some((op) => op.kind === "conversation.create"), false);
  await app.evaluate(`${sheetRow("p-assistant")}.querySelector("[data-member-fork]").click()`);
  await app.waitFor(`document.getElementById("members-sheet-fork") === null`, "the item closed");

  // The Assistant, forked: the same chat the title's menu makes.
  const ready = await openSheetFork(app, "p-assistant");
  assert.deepEqual({ disabled: ready.disabled, detail: ready.detail }, { disabled: "false", detail: "A new chat that starts from a copy of this session" });
  // The Assistant finishes another reply while the item is open: the copy
  // ends with what she sees when she taps, so with this one.
  const later = { id: "a2", role: "participant", participantId: ASSISTANT.id, participantLabel: "@assistant", content: "Summed up again.", status: "done", createdAt: at(1),
    metadata: { sourceMessageId: "u1", workedMs: 2_000, sessionCut: { sessionId: "s-assistant", at: "019a-turn-2" } } };
  await hub.addMessages("conv-old", [later]);
  await app.evaluate(`document.getElementById("members-sheet-fork").click()`);
  const create = await waitForOp(hub, (op) => op.kind === "conversation.create");
  assert.equal(create.conversation.title, "Old notes (fork)");
  assert.equal(create.conversation.repoPath, "/Users/u/site");
  const [forked, ...others] = create.conversation.metadata.participants;
  assert.equal(others.length, 0, "the main session alone");
  assert.deepEqual({ mainSessionParticipantId: create.conversation.metadata.mainSessionParticipantId, chatView: create.conversation.metadata.chatView },
    { mainSessionParticipantId: forked.id, chatView: "sessions" });
  assert.deepEqual({ handle: forked.handle, roleConfigId: forked.roleConfigId, kind: forked.kind, model: forked.model, reasoningEffort: forked.reasoningEffort, agentMode: forked.agentMode },
    { handle: "main", roleConfigId: "main-session", kind: "codex-cli", model: "gpt-5.5", reasoningEffort: "medium", agentMode: "default" });
  const summedAgain = (await hub.storage.getConversation("conv-old"))?.messages.find((message) => message.id === "a2");
  assert.deepEqual(forked.forkOrigin, { conversationId: "conv-old", participantId: ASSISTANT.id, handle: "assistant", conversationTitle: "Old notes", kind: "codex-cli",
    seen: { messageId: "a2", sessionCut: { sessionId: "s-assistant", at: "019a-turn-2" }, finishedAt: new Date(Date.parse(summedAgain.createdAt) + 2_000).toISOString() } },
  "read again at the tap: the reply that finished while the item was open");
  const intro = await waitForOp(hub, (op) => op.kind === "message.create" && op.conversationId === create.conversationId && op.message.role === "system");
  assert.equal(intro.message.content, "Chat started.\nMembers:\n- User\n- @main");
  // Open at once, the members sheet gone with the chat it was over.
  await app.waitFor(`document.getElementById("message-list").dataset.conversationId === ${JSON.stringify(create.conversationId)} && ${title} === "Old notes (fork)"`,
    "the new chat, open");
  assert.equal(await app.evaluate(visible("#members-sheet")), false);
  const source = await hub.storage.getConversation("conv-old");
  assert.equal(source?.metadata.participants.length, 3, "the member and its chat are not touched");
});

// --- she leaves before the fork is made -----------------------------------
// Making the chat waits on her server (the reply the copy ends with, up to
// 4 s): a chat or screen she opened meanwhile stays on screen with its
// keyboard, and the new chat is in her list. Staying, it opens (above).
test("a fork made after she opened another chat or went back to her chats leaves her there, the new chat in her list", { timeout: 180_000 }, async (t) => {
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: 8413, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-fork-left-");
  const chrome = launchChrome({ port: 9563, profile, url: `${site.origin}/` });
  let app;
  t.after(async () => {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  await hub.createChat("conv-main", {
    title: "Login page", repoPath: "/Users/u/site", participants: [MAIN], createdAt: at(31),
    metadata: { mainSessionParticipantId: MAIN.id, chatView: "sessions" }, messages: chatMessages().slice(0, 2)
  });
  await hub.createChat("conv-other", {
    title: "Other work", repoPath: "/Users/u/site", participants: [MAIN], createdAt: at(32),
    metadata: { mainSessionParticipantId: MAIN.id, chatView: "sessions" },
    messages: [{ id: "o1", role: "user", content: "Something else", status: "done", createdAt: at(32), metadata: { deliveryTargets: [MAIN.id] } },
      { id: "o2", role: "participant", participantId: MAIN.id, participantLabel: "@main", content: "Done.", status: "done", createdAt: at(31.5),
        metadata: { sourceMessageId: "o1", workedMs: 10_000 } }]
  });
  const published = await hub.call("PUT", "/v1/catalog", { catalog: { version: 1, publishedAt: new Date().toISOString(),
    roles: { "software-engineer": "Engineer", "main-session": "Main session" }, prompts: [], skills: [], avatars: {},
    newChat: { projects: [{ path: "/Users/u/site", label: "site" }], defaultProject: "/Users/u/site", mainSession: OFFERED_MAIN, assistant: OFFERED_MAIN,
      defaultChatView: "sessions", members: [], fork: FORK_OFFER } } });
  assert.equal(published.ok, true);
  app = await attachApp({ port: 9563 });
  await pairPage(app, { hub, siteOrigin: site.origin, query: "qa=1" });
  const creates = () => hub.opsRequests.flatMap((request) => request.ops || []).filter((op) => op.kind === "conversation.create");
  const onScreen = `({ open: document.getElementById("timeline-screen").classList.contains("is-active") ? document.getElementById("message-list").dataset.conversationId : undefined,
    chats: document.getElementById("chats-screen").classList.contains("is-active"), title: document.getElementById("chat-title").textContent,
    keyboard: document.activeElement ? document.activeElement.id : "", menu: !document.getElementById("chat-title-menu").hidden })`;
  const listed = (conversationId) => `Boolean(document.querySelector('.mobile-chat-row[data-conversation-id=${JSON.stringify(conversationId)}]'))`;
  // A chat she made herself is not news to her: no unread dot on its row,
  // in the list nor in what the phone keeps as unread.
  const unread = (conversationId) => `(() => { const row = document.querySelector('.mobile-chat-row[data-conversation-id=${JSON.stringify(conversationId)}]');
    const kept = JSON.parse(localStorage.getItem("accordagents.mobile.unreadConversationIds.v1") || "[]");
    return Boolean(row && row.querySelector(".mobile-unread-dot")) || kept.includes(${JSON.stringify(conversationId)}); })()`;
  /** Her server lists the new chat, and the list is read again (as a pull
   *  or the next sync does), long enough for a late dot to have come. */
  async function settleList(conversationId) {
    const end = Date.now() + 10_000;
    while (Date.now() < end && !(await app.evaluate(`(JSON.parse(localStorage.getItem("accordagents.mobile.chatList.v1") || "[]") || []).some((chat) => chat && chat.id === ${JSON.stringify(conversationId)})`))) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    assert.ok(await app.evaluate(`(JSON.parse(localStorage.getItem("accordagents.mobile.chatList.v1") || "[]") || []).some((chat) => chat && chat.id === ${JSON.stringify(conversationId)})`),
      "her server lists the new chat");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }

  /** Taps Fork for the main session of "Login page" with her server holding
   *  the read at the tap until she has done `leave`. */
  async function forkAndLeave(leave) {
    await openChat(app, "conv-main");
    await app.waitFor(mainShown, "the main timeline");
    assert.equal((await openForkMenu(app)).disabled, "false");
    const before = creates().length;
    // Only the fork's own read of "Login page" waits; any other read goes through.
    await app.evaluate(`(() => { const real = window.__realFetch || window.fetch; window.__realFetch = real;
      window.__forkReadHeld = new Promise((resolve) => { window.__releaseForkRead = resolve; });
      window.fetch = async function (input, init) {
        const url = String(input && input.url || input);
        if (url.indexOf("/v1/phone/new-chat") >= 0 && url.indexOf("forkOf=conv-main") >= 0) await window.__forkReadHeld;
        return real.call(window, input, init);
      }; })()`);
    await app.evaluate(`document.getElementById("chat-title-fork").click()`);
    await app.waitFor(`document.getElementById("chat-title-fork-detail").textContent === "Starting the new chat…"`, "the fork on its way");
    await app.evaluate(`document.getElementById("back-to-chats").click()`);
    await app.waitFor(`document.getElementById("chats-screen").classList.contains("is-active")`, "her chats");
    await leave();
    assert.equal(creates().length, before, "she left before it was made");
    await app.evaluate(`window.__releaseForkRead()`);
    const end = Date.now() + 15_000;
    while (creates().length === before && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 100));
    const create = creates()[before];
    assert.ok(create, "the fork was made");
    assert.equal(create.conversation.title, "Login page (fork)");
    await app.evaluate(`window.fetch = window.__realFetch`);
    await app.waitFor(listed(create.conversationId), "the new chat in her list");
    // Long enough for a late opening to have shown.
    await new Promise((resolve) => setTimeout(resolve, 800));
    return create;
  }

  // She opened another chat, its title menu, and is typing there.
  await forkAndLeave(async () => {
    await openChat(app, "conv-other");
    await app.evaluate(`document.getElementById("chat-members-toggle").click()`);
    await app.waitFor(visible("#chat-title-menu"), "her other chat's menu");
    assert.equal(await app.evaluate(`document.getElementById("chat-title-fork-detail").textContent`), "Starting the new chat…", "while the fork is made");
    await app.evaluate(`document.getElementById("composer-input").focus()`);
  });
  assert.deepEqual(await app.evaluate(onScreen), { open: "conv-other", chats: false, title: "Other work", keyboard: "composer-input", menu: true },
    "the chat she opened stays, with its keyboard and the menu she opened");
  {
    const made = creates()[creates().length - 1];
    await settleList(made.conversationId);
    assert.equal(await app.evaluate(unread(made.conversationId)), false, "the fork she made is not unread");
  }
  // Its Fork item is hers again, not left "Starting the new chat…".
  await app.waitFor(`document.getElementById("chat-title-fork-detail").textContent !== "Checking…"`, "its fork's answer");
  assert.deepEqual(await app.evaluate(forkItem), { shown: true, disabled: "false", label: "Fork to new chat", detail: "A new chat that starts from a copy of this session", views: 2 });
  await closeMenu(app);

  // She went back to her chats and stays there.
  await app.evaluate(`document.getElementById("back-to-chats").click()`);
  await app.waitFor(`document.getElementById("chats-screen").classList.contains("is-active")`, "her chats");
  const second = await forkAndLeave(async () => undefined);
  const shown = await app.evaluate(onScreen);
  assert.deepEqual({ open: shown.open, chats: shown.chats, menu: shown.menu }, { open: undefined, chats: true, menu: false }, "her chats stay");
  assert.notEqual(shown.keyboard, "composer-input");
  await settleList(second.conversationId);
  assert.equal(await app.evaluate(unread(second.conversationId)), false, "made while she was in her chats: not unread either");
  // A member's reply in it afterwards is news, as in any chat.
  const mainId = second.conversation.metadata.mainSessionParticipantId;
  await hub.addMessages(second.conversationId, [{ id: "fork-reply", role: "participant", participantId: mainId, participantLabel: "@main", content: "Picked it up.",
    status: "done", createdAt: new Date().toISOString(), metadata: { workedMs: 1_000 } }]);
  await app.waitFor(unread(second.conversationId), "a reply in it after she made it is news", 20_000);

  // A fork that fails once she has left: said in the send log as a New chat
  // the phone could not start, the header pointing at it; she stays where she is.
  await openChat(app, "conv-main");
  await app.waitFor(mainShown, "the main timeline");
  assert.equal((await openForkMenu(app)).disabled, "false");
  const createsBefore = creates().length;
  const forkRows = `[...document.querySelectorAll(".mobile-chat-row")].filter((row) => /Login page \\(fork\\)/.test(row.textContent)).length`;
  const rowsBefore = await app.evaluate(forkRows);
  await app.evaluate(`(() => { const real = window.__realFetch || window.fetch; window.__realFetch = real;
    window.__forkReadHeld = new Promise((resolve) => { window.__releaseForkRead = resolve; });
    window.fetch = async function (input, init) {
      const url = String(input && input.url || input);
      if (url.indexOf("/v1/phone/new-chat") >= 0 && url.indexOf("forkOf=conv-main") >= 0) await window.__forkReadHeld;
      return real.call(window, input, init);
    }; })()`);
  await app.evaluate(`document.getElementById("chat-title-fork").click()`);
  await app.waitFor(`document.getElementById("chat-title-fork-detail").textContent === "Starting the new chat…"`, "the fork on its way");
  await openChat(app, "conv-other");
  assert.equal(await app.evaluate(visible("#send-log-button")), false, "nothing to look at yet");
  // The phone cannot keep what it would send.
  await app.evaluate(`(() => { const real = IDBDatabase.prototype.transaction; window.__realTransaction = real;
    IDBDatabase.prototype.transaction = function (names, mode) {
      if (mode === "readwrite" && [].concat(names).includes("outbox")) throw new DOMException("The phone's storage is full.", "QuotaExceededError");
      return real.apply(this, arguments);
    }; })()`);
  await app.evaluate(`window.__releaseForkRead()`);
  await app.waitFor(visible("#send-log-button"), "the header points at the send log");
  await app.evaluate(`IDBDatabase.prototype.transaction = window.__realTransaction; window.fetch = window.__realFetch`);
  assert.equal(await app.evaluate(`document.getElementById("send-log-button").getAttribute("aria-label")`), "Send log: a chat you started did not start");
  assert.equal(creates().length, createsBefore, "nothing was sent");
  const stayed = await app.evaluate(onScreen);
  assert.deepEqual({ open: stayed.open, title: stayed.title }, { open: "conv-other", title: "Other work" }, "she stays where she is");
  await openChat(app, "conv-other");
  await app.evaluate(`document.getElementById("back-to-chats").click()`);
  await app.waitFor(`document.getElementById("chats-screen").classList.contains("is-active")`, "her chats");
  assert.equal(await app.evaluate(forkRows), rowsBefore, "no chat was made");
  await openChat(app, "conv-other");
  await app.evaluate(`document.getElementById("send-log-button").click()`);
  await app.waitFor(visible("#send-log-sheet"), "the send log");
  const logged = await app.evaluate(`[...document.querySelectorAll("#send-log-list .send-log-row")].map((row) => [row.querySelector(".send-log-what").textContent, row.querySelector(".send-log-why").textContent])`);
  assert.deepEqual(logged[0], ["New chat: Login page (fork)", "Could not start the chat: The phone's storage is full."], JSON.stringify(logged));
  // It opens from the list as any chat does.
  await openChat(app, second.conversationId);
  assert.equal(await app.evaluate(title), "Login page (fork)");
});
