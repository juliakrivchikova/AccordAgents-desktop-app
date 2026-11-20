/**
 * The main session and the chat's two views on the phone (docs/main-session.md),
 * driven through the real PWA in a browser against a real hub:
 *  - a chat with a main session opens in the sessions view: the main timeline
 *    holds the User and the main session only, without avatars; each task the
 *    main session gave is a card (member, task, state, time, one line of the
 *    result) and the line "Waiting on N members" says whom it waits on;
 *  - a task card's row opens that member's whole session, whose composer
 *    writes to that member only (deliveryTargets = [member], no fallback);
 *  - the members sheet lists each member's state, task and Stop;
 *  - the header's switch writes the chat's view through the server, and the
 *    classic view is today's timeline; a chat without a main session has the
 *    classic view only, and the switch says why;
 *  - New chat leads with the main session (never the Assistant), and the
 *    chat it makes says which member that is and the view it opens in.
 *
 * Desktop Chrome, not the installed phone: supporting evidence for the phone
 * check, not a stand-in for it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { attachApp, launchChrome, member, openChat, pairPage, serveMobileShell, sleep, startMobileHub, tempProfile } from "./mobile-hub-fixture.mjs";

const require = createRequire(import.meta.url);
// The server shares a chat's main session and its view like the pin (part M1
// of this feature). Where the server this build tests does not share them
// yet, the test shares them the same way, so the phone's side can be checked
// on its own; once it does, this changes nothing.
const chatChanges = require("../dist/main/main/services/chatChanges.js");
for (const key of ["mainSessionParticipantId", "chatView"]) {
  if (!chatChanges.SHARED_CONVERSATION_METADATA_KEYS.includes(key)) chatChanges.SHARED_CONVERSATION_METADATA_KEYS.push(key);
}

const MAIN = member("main", { id: "p-main", roleConfigId: "main-session" });
const DREW = member("drew", { id: "p-drew" });
const TAYLOR = member("taylor", { id: "p-taylor", kind: "codex-cli" });
const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

const visible = (selector) => `(() => { const node = document.querySelector(${JSON.stringify(selector)}); return Boolean(node && !node.hidden && node.offsetParent !== null); })()`;
const rowsSummary = `[...document.querySelectorAll("#message-list > .message-row")].map((row) =>
  (row.dataset.sessionsKind || row.dataset.author) + ":" + (row.dataset.threadRoot || row.dataset.rowKey))`;

function sessionsChatMessages() {
  return [
    { id: "u1", role: "user", content: "Fix the login page", status: "done", createdAt: at(30), metadata: { deliveryTargets: [MAIN.id] } },
    { id: "r1", role: "participant", participantId: MAIN.id, participantLabel: "@main", content: "I'll split this between two members.", status: "done", createdAt: at(29) },
    {
      id: "req", role: "participant", participantId: MAIN.id, participantLabel: "@main", status: "done", createdAt: at(28),
      content: "@drew Restyle the login button\nUse the new tokens.\n@taylor Run the login tests",
      metadata: { participantRequest: {
        id: "batch-1", requesterParticipantId: MAIN.id, requesterHandle: "main", source: "tool", resumeRequester: true, status: "running",
        depth: 1, createdAt: at(28), updatedAt: at(5),
        items: [
          { targetParticipantId: DREW.id, targetHandle: "drew", prompt: "Restyle the login button\nUse the new tokens.", status: "running", createdAt: at(28), updatedAt: at(28) },
          { targetParticipantId: TAYLOR.id, targetHandle: "taylor", prompt: "Run the login tests", status: "answered", replyMessageId: "taylor-reply", createdAt: at(28), updatedAt: at(5) }
        ]
      } }
    },
    { id: "taylor-reply", role: "participant", participantId: TAYLOR.id, participantLabel: "@taylor", content: "All 42 login tests pass.\nDetails below.", status: "done", createdAt: at(6) },
    { id: "u2", role: "user", content: "Drew, keep the old colour for now", status: "done", createdAt: at(4), metadata: { deliveryTargets: [DREW.id] } },
    { id: "drew-run", role: "participant", participantId: DREW.id, participantLabel: "@drew", content: "Looking at the button styles", status: "pending", createdAt: at(3),
      metadata: { runId: "run-drew", sourceMessageId: "req" } }
  ];
}

test("the sessions view: main timeline, task card, a member's session that writes to it only, the members sheet, and the switch", { timeout: 180_000 }, async (t) => {
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: 8391, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-sessions-");
  const chrome = launchChrome({ port: 9541, profile, url: `${site.origin}/` });
  let app;
  t.after(async () => {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  await hub.createChat("conv-main", {
    title: "Login page", participants: [MAIN, DREW, TAYLOR], createdAt: at(31),
    metadata: { mainSessionParticipantId: MAIN.id, chatView: "sessions" }, messages: sessionsChatMessages()
  });
  await hub.createChat("conv-old", { title: "Before main sessions", participants: [member("admin", { id: "p-admin", roleConfigId: "administrator" }), DREW],
    createdAt: at(60), messages: [{ id: "o1", role: "user", content: "hello", status: "done", createdAt: at(59) },
      { id: "o2", role: "participant", participantId: DREW.id, participantLabel: "@drew", content: "Hi there", status: "done", createdAt: at(58) }] });
  app = await attachApp({ port: 9541 });
  await pairPage(app, { hub, siteOrigin: site.origin, query: "qa=1" });

  // --- the main timeline ---------------------------------------------------
  await openChat(app, "conv-main");
  await app.waitFor(`document.querySelectorAll('#message-list .message-row[data-sessions-kind="task"]').length === 1`, "the task card");
  assert.equal(await app.evaluate(visible("#chat-view-switch")), true, "the switch is in the header");
  assert.deepEqual(await app.evaluate(`[...document.querySelectorAll("#chat-view-switch [data-view]")].map((node) => node.dataset.view + ":" + node.getAttribute("aria-pressed") + ":" + node.getAttribute("aria-disabled"))`),
    ["sessions:true:false", "classic:false:false"]);
  await app.waitFor(`document.querySelector('#message-list .message-row[data-sessions-kind="waiting"]') !== null`, "the Waiting on line");
  const main = await app.evaluate(rowsSummary);
  assert.deepEqual(main, ["you:u1", "agent:r1", "task:req", "waiting:sessions-waiting"],
    "the User's message to the main session, its reply, its task card and the Waiting line; no member's message, and not the User's message to a member");
  const looks = await app.evaluate(`(() => {
    const reply = document.querySelector('#message-list .message-row[data-thread-root="r1"]');
    const avatar = reply.querySelector(".message-avatar");
    const you = document.querySelector('#message-list .message-row[data-thread-root="u1"]');
    return { avatar: avatar ? getComputedStyle(avatar).display : "none", handle: reply.querySelector(".message-handle").textContent,
      yourSide: getComputedStyle(you).justifyContent, chips: document.querySelectorAll("#message-list .thread-chip").length,
      replyWidth: Math.round(reply.querySelector(".message-copy").getBoundingClientRect().width), listWidth: Math.round(document.getElementById("message-list").getBoundingClientRect().width) };
  })()`);
  assert.equal(looks.avatar, "none", "no avatar");
  assert.equal(looks.handle, "", "no author name");
  assert.equal(looks.yourSide, "flex-end", "the User's message stays on the right");
  assert.equal(looks.chips, 0, "no threads");
  assert.ok(looks.listWidth - looks.replyWidth <= 2, `the main session's reply takes the whole width: ${JSON.stringify(looks)}`);
  const card = await app.evaluate(`(() => { const card = document.querySelector('#message-list .message-row[data-sessions-kind="task"]');
    return { head: card.querySelector(".sessions-task-card-head")?.textContent,
      rows: [...card.querySelectorAll(".sessions-task-row")].map((row) => ({ member: row.dataset.openMember, status: row.dataset.taskStatus,
        text: row.querySelector(".sessions-task-handle").textContent + " " + row.querySelector(".sessions-task-title").textContent,
        result: row.querySelector(".sessions-task-result")?.textContent || "", label: row.querySelector(".sessions-status").textContent,
        elapsed: row.querySelector(".sessions-elapsed")?.textContent || "" })) }; })()`);
  assert.equal(card.head, "2 members · 1 running");
  assert.deepEqual(card.rows.map((row) => [row.member, row.status, row.text, row.result, row.label]), [
    ["p-drew", "running", "@drew Restyle the login button", "", "Running"],
    ["p-taylor", "done", "@taylor Run the login tests", "All 42 login tests pass.", "Done"]
  ]);
  assert.match(card.rows[0].elapsed, /^\d+m \d+s$/, "the time a running task has taken, as the desktop counts it");
  assert.equal(card.rows[1].elapsed, "");
  assert.match(await app.evaluate(`document.querySelector(".sessions-waiting-text").textContent`), /^Waiting on 1 member: @drew$/);
  assert.equal(await app.evaluate(`document.querySelector(".sessions-waiting .sessions-stop").disabled`), false, "the Waiting line has Stop");
  // The header's button counts the members at work.
  assert.equal(await app.evaluate(`document.getElementById("chat-members-button").getAttribute("aria-label")`), "Members (1 running)");
  assert.equal(await app.evaluate(`document.getElementById("chat-members-count").textContent`), "1");

  // --- a member's session --------------------------------------------------
  await app.evaluate(`document.querySelector('.sessions-task-row[data-open-member="p-drew"]').click()`);
  await app.waitFor(`document.getElementById("chat-title").textContent === "@drew" && document.querySelector('#message-list .message-row[data-sessions-kind="member-head"]') !== null`,
    "drew's session");
  assert.equal(await app.evaluate(visible("#back-to-timeline")), true, "the way back");
  assert.equal(await app.evaluate(visible("#chat-view-switch")), false, "a session's header has room for its way back");
  assert.equal(await app.evaluate(`document.getElementById("composer-input").placeholder`), "Message @drew...");
  assert.deepEqual(await app.evaluate(rowsSummary), ["member-head:member-session-head\u0000p-drew", "task-fold:req", "you:u2", "agent:drew-run"],
    "its task folded to one line, the User's message to it, and its own reply");
  assert.deepEqual(await app.evaluate(`(() => { const fold = document.querySelector(".member-task"); return [fold.querySelector(".member-task-label").textContent,
    fold.querySelector(".member-task-preview").textContent, document.querySelector(".member-session-head .sessions-status").textContent]; })()`),
  ["Task from the main session", "Restyle the login button", "Running"]);
  // The task opens to its whole text.
  await app.evaluate(`document.querySelector(".member-task-toggle").click()`);
  await app.waitFor(`(document.querySelector(".member-task-body")?.textContent || "").includes("@taylor Run the login tests")`, "the task's whole text");

  // A message written here goes to drew only.
  await app.evaluate(`(() => { const input = document.getElementById("composer-input"); input.value = "Please also check dark mode"; input.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("composer-form").requestSubmit(); })()`);
  await app.waitFor(`[...document.querySelectorAll('#message-list .message-row[data-author="you"]')].some((row) => row.textContent.includes("Please also check dark mode"))`,
    "the message stays in drew's session");
  const sent = await waitForOp(hub, (op) => op.kind === "message.create" && op.message && op.message.content === "Please also check dark mode");
  assert.deepEqual(sent.message.metadata.deliveryTargets, [DREW.id], "to that member only");
  assert.equal(sent.message.metadata.chatThreadRootId, undefined, "not in a thread");

  // Back to the main timeline: the message to drew is not on it.
  await app.evaluate(`document.getElementById("back-to-timeline").click()`);
  await app.waitFor(`document.getElementById("chat-title").textContent === "Login page" && document.querySelector('#message-list .message-row[data-sessions-kind="task"]') !== null`,
    "the main timeline again");
  assert.equal(await app.evaluate(`document.getElementById("message-list").textContent.includes("Please also check dark mode")`), false);

  // --- the members sheet ---------------------------------------------------
  await app.evaluate(`document.getElementById("chat-members-button").click()`);
  await app.waitFor(`${visible("#members-sheet")} && document.querySelectorAll("#members-sheet-list .sessions-member-row").length === 1`, "the members list");
  const sheet = await app.evaluate(`(() => ({
    title: document.getElementById("members-sheet-title").textContent,
    stopAll: !document.getElementById("members-sheet-stop-all").hidden,
    rows: [...document.querySelectorAll("#members-sheet-list .sessions-member-row")].map((row) => [row.dataset.memberSession, row.dataset.memberStatus,
      row.querySelector(".members-sheet-task")?.textContent, Boolean(row.querySelector(".sessions-stop")), Boolean(row.querySelector(".sessions-elapsed"))]),
    previous: document.querySelector("#members-sheet-list .members-previous-toggle")?.textContent
  }))()`);
  assert.deepEqual(sheet, {
    title: "Members", stopAll: true, rows: [["p-drew", "running", "Restyle the login button", true, true]], previous: "Previous1"
  }, "drew at work with its task, time and Stop; taylor, done, under Previous; never the main session");
  await app.evaluate(`document.querySelector("#members-sheet-list .members-previous-toggle").click()`);
  await app.waitFor(`document.querySelectorAll("#members-sheet-list .sessions-member-row").length === 2`, "Previous opened");
  assert.deepEqual(await app.evaluate(`[...document.querySelectorAll("#members-sheet-list .sessions-member-row")].map((row) => row.dataset.memberSession + ":" + row.dataset.memberStatus)`),
    ["p-drew:running", "p-taylor:done"]);
  // Stop on drew's row names drew's turn to the server.
  await app.evaluate(`document.querySelector('#members-sheet-list .sessions-member-row[data-member-session="p-drew"] .sessions-stop').click()`);
  const stop = await waitForOp(hub, (op) => op.kind === "turn.stop");
  assert.deepEqual([stop.participantId, stop.messageId], [DREW.id, "req"], "the Stop names drew's turn");
  // A tap on taylor opens its session.
  await app.evaluate(`document.querySelector('#members-sheet-list .sessions-member-row[data-member-session="p-taylor"]').click()`);
  await app.waitFor(`document.getElementById("chat-title").textContent === "@taylor" && !${visible("#members-sheet")}`, "taylor's session from the list");
  assert.deepEqual(await app.evaluate(rowsSummary), ["member-head:member-session-head\u0000p-taylor", "task-fold:req", "agent:taylor-reply"]);
  await app.evaluate(`document.getElementById("back-to-timeline").click()`);
  await app.waitFor(`document.getElementById("chat-title").textContent === "Login page"`, "back");

  // --- a member's reply reached from Activity opens its session -------------
  await app.evaluate(`document.querySelector('[data-home-tab="activity"]').click()`);
  await app.waitFor(`document.getElementById("activity-screen").classList.contains("is-active") && Boolean(document.querySelector('.act-tab[data-activity-tab="finished"]'))`, "Activity");
  await app.evaluate(`document.querySelector('.act-tab[data-activity-tab="finished"]').click()`);
  await app.waitFor(`[...document.querySelectorAll("#activity-list .act-row")].some((row) => row.innerText.includes("All 42 login tests pass"))`, "taylor's reply in Activity");
  await sleep(700);
  await app.evaluate(`[...document.querySelectorAll("#activity-list .act-row")].find((row) => row.innerText.includes("All 42 login tests pass")).click()`);
  await app.waitFor(`document.getElementById("chat-title").textContent === "@taylor" && document.querySelector('#message-list .message-row[data-thread-root="taylor-reply"]') !== null`,
    "taylor's session, from Activity");
  await app.evaluate(`document.getElementById("back-to-timeline").click()`);
  await app.waitFor(`document.getElementById("chat-title").textContent === "Login page"`, "back to the main timeline");

  // --- a member's question stays on the main timeline while it waits --------
  const asking = { id: "drew-asks", role: "participant", participantId: DREW.id, participantLabel: "@drew", content: "Which shade of blue?", status: "done", createdAt: at(1),
    metadata: { pendingChoice: { id: "choice-shade", title: "Shade", question: "Which shade of blue?", status: "pending", askedAt: at(1),
      options: [{ id: "a", label: "Navy" }, { id: "b", label: "Sky" }] } } };
  await hub.writeMessage("conv-main", asking);
  await hub.raiseChoice("conv-main", asking);
  await app.waitFor(`(() => { const row = document.querySelector('#message-list .message-row[data-sessions-kind="choice"]');
    return Boolean(row && row.querySelector(".sessions-choice-from").textContent === "@drew asks" && row.querySelector('.control-card[data-card-id="choice-shade"]')); })()`,
  "drew's question with its card, on the main timeline");
  assert.equal(await app.evaluate(`document.querySelector('.message-row[data-thread-root="drew-asks"] .message-avatar') === null || getComputedStyle(document.querySelector('.message-row[data-thread-root="drew-asks"] .message-avatar')).display === "none"`), true);
  // "@drew asks" opens drew's session, where the question is too.
  await app.evaluate(`document.querySelector(".sessions-choice-from").click()`);
  await app.waitFor(`document.getElementById("chat-title").textContent === "@drew" && document.querySelector('#message-list .message-row[data-thread-root="drew-asks"] .control-card') !== null`,
    "drew's session, with its question");
  await app.evaluate(`document.getElementById("back-to-timeline").click()`);
  await app.waitFor(`document.getElementById("chat-title").textContent === "Login page"`, "back to the main timeline");

  // --- the switch ----------------------------------------------------------
  await app.evaluate(`document.querySelector('#chat-view-switch [data-view="classic"]').click()`);
  await app.waitFor(`document.querySelectorAll("#message-list .message-row.is-sessions").length === 0 && document.querySelector('#message-list .message-row[data-thread-root="req"]') !== null`,
    "the classic timeline");
  const update = await waitForOp(hub, (op) => op.kind === "conversation.update" && op.metadata && op.metadata.chatView === "classic");
  assert.deepEqual(update.metadata, { chatView: "classic" }, "the view, written through her server");
  for (let tries = 0; tries < 50 && (await hub.storage.getConversation("conv-main")).metadata.chatView !== "classic"; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal((await hub.storage.getConversation("conv-main")).metadata.chatView, "classic", "the server keeps it for every device");
  const classic = await app.evaluate(`(() => ({
    pressed: document.querySelector('#chat-view-switch [data-view="classic"]').getAttribute("aria-pressed"),
    avatars: [...document.querySelectorAll('#message-list .message-row[data-author="agent"] .message-avatar')].filter((node) => getComputedStyle(node).display !== "none").length,
    handles: [...document.querySelectorAll('#message-list .message-row[data-author="agent"] .message-handle')].map((node) => node.textContent),
    waiting: document.querySelector('#message-list .message-row[data-sessions-kind="waiting"]') !== null,
    button: document.getElementById("chat-members-button").getAttribute("aria-label")
  }))()`);
  assert.equal(classic.pressed, "true");
  assert.ok(classic.avatars >= 2, `avatars are back: ${JSON.stringify(classic)}`);
  assert.ok(classic.handles.includes("@main") && classic.handles.includes("@drew"), `authors are back: ${JSON.stringify(classic.handles)}`);
  assert.equal(classic.waiting, false);
  assert.equal(classic.button, "Members: 3 members", "the classic members button");
  // The server's list says classic now: the view stays after the list is read again.
  await app.evaluate(`document.getElementById("back-to-chats").click()`);
  await openChat(app, "conv-main");
  await app.waitFor(`document.querySelector('#chat-view-switch [data-view="classic"]').getAttribute("aria-pressed") === "true" &&
    document.querySelectorAll("#message-list .message-row.is-sessions").length === 0`, "still classic once opened again");
  // A refusal puts the view back.
  hub.setGate(async (request) => request.method === "POST" && request.path === "/v3/ops" && (request.ops || []).some((op) => op.kind === "conversation.update")
    ? { status: 200, body: { ok: true, results: request.ops.map((op) => ({ opId: op.opId, status: "rejected", reason: "QA: not now" })) } }
    : undefined);
  await app.evaluate(`document.querySelector('#chat-view-switch [data-view="sessions"]').click()`);
  await app.waitFor(`document.querySelector('#chat-view-switch [data-view="classic"]').getAttribute("aria-pressed") === "true" &&
    document.querySelectorAll("#message-list .message-row.is-sessions").length === 0`, "the refused switch went back", 20_000);
  hub.setGate(undefined);

  // --- a chat made before main sessions ------------------------------------
  await app.evaluate(`document.getElementById("back-to-chats").click()`);
  await openChat(app, "conv-old");
  await app.waitFor(`document.querySelector('#message-list .message-row[data-thread-root="o2"]') !== null`, "the old chat");
  const old = await app.evaluate(`(() => ({
    group: document.getElementById("chat-view-switch").classList.contains("is-disabled"),
    reason: document.getElementById("chat-view-switch").dataset.disabledReason,
    pressed: [...document.querySelectorAll("#chat-view-switch [data-view]")].map((node) => node.dataset.view + ":" + node.getAttribute("aria-pressed")),
    sessionsRows: document.querySelectorAll("#message-list .message-row.is-sessions").length,
    avatar: getComputedStyle(document.querySelector('#message-list .message-row[data-thread-root="o2"] .message-avatar')).display
  }))()`);
  assert.deepEqual(old, { group: true, reason: "This chat was made before main sessions, so it has the classic view only.",
    pressed: ["sessions:false", "classic:true"], sessionsRows: 0, avatar: "flex" });
  const opsBefore = hub.opsRequests.length;
  await app.evaluate(`document.querySelector('#chat-view-switch [data-view="sessions"]').click()`);
  await app.waitFor(`${visible("#chat-view-note")} && document.getElementById("chat-view-note").textContent.includes("classic view only")`, "says why");
  assert.equal(hub.opsRequests.slice(opsBefore).some((request) => request.ops.some((op) => op.kind === "conversation.update")), false, "nothing is written");
});

test("New chat on the phone leads with the main session, and the chat it makes has it", { timeout: 120_000 }, async (t) => {
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: 8393, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-sessions-new-");
  const chrome = launchChrome({ port: 9543, profile, url: `${site.origin}/` });
  let app;
  t.after(async () => {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  await hub.createChat("conv-seed", { title: "Seed", participants: [DREW] });
  const mainSession = { id: "t-main", handle: "main", roleConfigId: "main-session", kind: "claude-code" };
  const drew = member("drew", { id: "t-drew", participantConfigId: "c-drew" });
  // As the computer publishes it: the main session, and under `assistant`
  // the same member for phones from before main sessions.
  const newChat = { projects: [], assistant: mainSession, mainSession, members: [{ configId: "c-drew", uses: 1, participant: drew }] };
  await hub.call("PUT", "/v1/catalog", { catalog: { version: 1, publishedAt: new Date().toISOString(),
    roles: { "software-engineer": "Engineer", "main-session": "Main session" }, prompts: [], skills: [], avatars: {}, newChat } });
  app = await attachApp({ port: 9543 });
  await pairPage(app, { hub, siteOrigin: site.origin, query: "qa=1" });
  await app.waitFor(`!document.getElementById("new-chat-button").hidden`, "New chat");
  await app.evaluate(`document.getElementById("new-chat-button").click()`);
  await app.waitFor(`document.querySelectorAll("#new-chat-members .new-chat-member").length === 2`, "the members");
  const lead = await app.evaluate(`(() => { const row = document.querySelector("#new-chat-members .new-chat-member");
    return { name: row.querySelector("strong").textContent, line: row.querySelector(".members-sheet-role").textContent, locked: row.getAttribute("aria-disabled"),
      pressed: row.getAttribute("aria-pressed"), text: document.getElementById("new-chat-members").textContent,
      label: document.getElementById("new-chat-members-button").getAttribute("aria-label") }; })()`);
  assert.deepEqual([lead.name, lead.line, lead.locked, lead.pressed], ["Main session", "@main · Claude Code", "true", "true"], "the locked first row");
  assert.equal(/Assistant/.test(lead.text), false, "nothing says Assistant");
  assert.equal(lead.label, "Members: Main session");

  await app.evaluate(`(() => { const input = document.getElementById("new-chat-input"); input.value = "Plan the release"; input.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("new-chat-start").click(); })()`);
  const create = await waitForOp(hub, (op) => op.kind === "conversation.create");
  const participants = create.conversation.metadata.participants;
  const made = participants.find((participant) => participant.roleConfigId === "main-session");
  assert.ok(made && made.id !== "t-main", "the main session, with an id of its own");
  assert.equal(participants[0].id, made.id, "first");
  assert.equal(create.conversation.metadata.mainSessionParticipantId, made.id, "the chat says which member is its main session");
  assert.equal(create.conversation.metadata.chatView, "sessions", "and opens in the sessions view");
  // The chat opens in the sessions view at once.
  await app.waitFor(`document.getElementById("timeline-screen").classList.contains("is-active") &&
    document.querySelector('#chat-view-switch [data-view="sessions"]').getAttribute("aria-pressed") === "true"`, "the new chat in the sessions view");
});

/** The phone's operation the hub was sent that matches, once it is there. */
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
