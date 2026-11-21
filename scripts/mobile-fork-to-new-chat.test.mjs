/**
 * Fork to new chat on the phone (src/shared/forkToNewChat.ts), driven through
 * the real PWA in a browser against a real hub: the title's menu offers it
 * for the main session on the main timeline and for a member on its own
 * screen, as the computer's member menus do, disabled with the computer's
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
    { id: "drew-reply", role: "participant", participantId: DREW.id, participantLabel: "@drew", content: "Restyled.", status: "done", createdAt: at(20),
      metadata: { sourceMessageId: "req" } },
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
  assert.deepEqual(mainItem, { shown: true, disabled: "false", label: "Fork to new chat", detail: "A new chat whose main session starts from a copy of this session", views: 2 },
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
  assert.deepEqual({ disabled: drewItem.disabled, detail: drewItem.detail }, { disabled: "false", detail: "A new chat whose main session starts from a copy of this session" });
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
  assert.deepEqual(forked.permissions, rights({ webAccess: true, requestParticipants: "allow",
    shell: { enabled: false, rules: [{ action: "deny", match: "prefix", pattern: "git push" }] } }),
  "what it may do as it runs (no edits, commands or CLI mode above the main session), with the main session's say over members");
  assert.deepEqual(forked.forkOrigin, { conversationId: "conv-main", participantId: DREW.id, handle: "drew", conversationTitle: "Login page", kind: "claude-code" });
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
