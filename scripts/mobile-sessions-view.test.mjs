/**
 * The main session and the chat's two views on the phone (docs/main-session.md),
 * driven through the real PWA in a browser against a real hub. The sessions
 * view is T3 Code's: the main timeline holds the User and the main session;
 * the tasks a turn gave are rows inside its reply's "Worked for …" fold
 * (provider logo with a status dot, task, one line of result, time), and a
 * row or a member's chip in the text opens that member's session at the
 * message it refers to; members are named by their task with their provider's
 * logo, never by handle or avatar; one icon opens one panel (main session,
 * Accord, members, Previous, Removed); a removed member's session reads only;
 * Stop reaches a member that has written nothing yet; the Accord is one quiet
 * line that opens its own screen; the main composer writes to the main
 * session whatever it says; the view is picked in the title's menu. The
 * classic view is today's timeline, and a chat without a main session has the
 * classic view only. New chat leads with the main session, with its logo.
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
const SAM = member("sam", { id: "p-sam", kind: "gemini-cli" });
// A member the main session made for a task and removed once it was done.
const OLGA_ID = "p-olga";
const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

const visible = (selector) => `(() => { const node = document.querySelector(${JSON.stringify(selector)}); return Boolean(node && !node.hidden && node.offsetParent !== null); })()`;
const rowsSummary = `[...document.querySelectorAll("#message-list > .message-row")].map((row) =>
  (row.dataset.sessionsKind || row.dataset.author) + ":" + (row.dataset.threadRoot || row.dataset.rowKey))`;
const title = `document.getElementById("chat-title").textContent`;
// The main timeline is drawn again (the heading changes before the rows do).
const mainShown = `(document.getElementById("chat-title").textContent === "Login page" && document.querySelector('#message-list .message-row[data-thread-root="r1"]') !== null)`;

const launchPrompt = (subject, members) => [
  "@main /accord", "", "Subject:", subject, "",
  `Selected accord members: ${members}.`,
  "Run the accord skill for exactly those selected members and this subject. Use app_chat_request_participants for those members only. The app has enabled request-members permission for you in this chat; the user can revoke it from your member controls."
].join("\n");

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

function sessionsChatMessages() {
  return [
    // An earlier turn: a task to a member that has left the chat since.
    { id: "u0", role: "user", content: "Look at the old report", status: "done", createdAt: at(50), metadata: { deliveryTargets: [MAIN.id] } },
    { id: "r0", role: "participant", participantId: MAIN.id, participantLabel: "@main", content: "I asked a member to read it.", status: "done", createdAt: at(49.5),
      metadata: { sourceMessageId: "u0", workedMs: 20_000 } },
    request("req-old", "u0", 49, [item(OLGA_ID, "olga", "Summarise the old report", "answered", 49, { replyMessageId: "olga-reply", doneAt: 48 })]),
    { id: "olga-reply", role: "participant", participantId: OLGA_ID, participantLabel: "@olga", content: "The old report is about logins.", status: "done", createdAt: at(48),
      metadata: { sourceMessageId: "req-old" } },
    // This turn: three tasks, one done, two still going.
    { id: "u1", role: "user", content: "@main Fix the login page", status: "done", createdAt: at(30), metadata: { deliveryTargets: [MAIN.id] } },
    { id: "r1", role: "participant", participantId: MAIN.id, participantLabel: "@main",
      content: "I split this: @drew restyles it, @taylor tests it and @sam reads the logs. Ask @main or @nobody. See `@drew`, `ask @taylor now`, `npm i @types/node` and `@main`; mail me@drew.dev, @drew/pkg or @olga.",
      status: "done", createdAt: at(29.5),
      metadata: { sourceMessageId: "u1", workedMs: 54_000 } },
    request("req", "u1", 28, [
      item(DREW.id, "drew", "Restyle the login button\nUse the new tokens.", "running", 28),
      // The main session titled this one; the others are named by their task's first sentence.
      item(TAYLOR.id, "taylor", "Run the login tests", "answered", 28, { replyMessageId: "taylor-reply", doneAt: 5, title: "Login tests" }),
      item(SAM.id, "sam", "Check the server logs for every failed login since Monday and group them by reason. Report the counts.", "running", 28)
    ]),
    { id: "taylor-reply", role: "participant", participantId: TAYLOR.id, participantLabel: "@taylor", content: "All 42 login tests pass.\nDetails below.", status: "done", createdAt: at(6),
      metadata: { sourceMessageId: "req" } },
    // Another member's turn-finished note: its task already says it is done.
    { id: "taylor-note", role: "system", content: "All 42 login tests pass.", status: "done", createdAt: at(5.5),
      metadata: { appMessageSource: "app_turn_finished_note", turnFinishedNote: { messageId: "taylor-reply", participantId: TAYLOR.id, participantLabel: "@taylor" } } },
    { id: "u2", role: "user", content: "Drew, keep the old colour for now", status: "done", createdAt: at(4), metadata: { deliveryTargets: [DREW.id] } },
    { id: "drew-run", role: "participant", participantId: DREW.id, participantLabel: "@drew", content: "Looking at the button styles", status: "pending", createdAt: at(3),
      metadata: { runId: "run-drew", sourceMessageId: "req" } },
    // A member at work with nothing written yet: still stoppable.
    { id: "sam-run", role: "participant", participantId: SAM.id, participantLabel: "@sam", content: "", status: "pending", createdAt: at(2.5),
      metadata: { runId: "run-sam", sourceMessageId: "req" } },
    // An Accord the main session started, and its document's first step.
    { id: "launch", role: "participant", participantId: MAIN.id, participantLabel: "@main", content: launchPrompt("Pick the button colour", "drew, taylor"),
      status: "done", createdAt: at(2), metadata: { accordLaunchByMainSession: true } },
    { id: "n-1", role: "system", content: "@drew created draft collection [Button colour](#artifact:art-1) · Drafts 0/2", status: "done", createdAt: at(1.5),
      metadata: { appMessageSource: "app_artifact_note", artifactEventId: "e-n-1", accordLaunchMessageId: "launch" } },
    // A quick question the main session answered itself, and its own
    // turn-finished note: the sessions view shows no such note.
    { id: "u3", role: "user", content: "Which city is the capital of Italy?", status: "done", createdAt: at(1.4), metadata: { deliveryTargets: [MAIN.id] } },
    { id: "r3", role: "participant", participantId: MAIN.id, participantLabel: "@main", content: "Rome.", status: "done", createdAt: at(1.3),
      metadata: { sourceMessageId: "u3", workedMs: 7_000 } },
    { id: "main-note", role: "system", content: "Rome.", status: "done", createdAt: at(1.2),
      metadata: { appMessageSource: "app_turn_finished_note", turnFinishedNote: { messageId: "r3", participantId: MAIN.id, participantLabel: "@main" } } }
  ];
}

test("the sessions view (T3 Code's way): tasks inside the turn's Worked fold, chips not handles, one panel, Stop without text, removed members, the Accord's line", { timeout: 240_000 }, async (t) => {
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
    title: "Login page", participants: [MAIN, DREW, TAYLOR, SAM], createdAt: at(51),
    metadata: { mainSessionParticipantId: MAIN.id, chatView: "sessions" }, messages: sessionsChatMessages()
  });
  await hub.createChat("conv-old", { title: "Before main sessions", participants: [member("admin", { id: "p-admin", roleConfigId: "administrator" }), DREW],
    createdAt: at(60), messages: [{ id: "o1", role: "user", content: "hello", status: "done", createdAt: at(59) },
      { id: "o2", role: "participant", participantId: DREW.id, participantLabel: "@drew", content: "Hi there", status: "done", createdAt: at(58) }] });
  app = await attachApp({ port: 9541 });
  await pairPage(app, { hub, siteOrigin: site.origin, query: "qa=1" });

  // --- the main timeline ---------------------------------------------------
  await openChat(app, "conv-main");
  await app.waitFor(`document.querySelector('#message-list .message-row[data-thread-root="r3"]') !== null && document.querySelector("#accord-dock .accord-strip") !== null`,
    "the main timeline and the Accord's line");
  assert.deepEqual(await app.evaluate(rowsSummary), ["you:u0", "agent:r0", "you:u1", "agent:r1", "agent:launch", "you:u3", "agent:r3"],
    "the User and the main session only: no task cards, no member's message, no turn-finished note (the main session's own neither), no Accord document note, and no Waiting line (removed, the User 2026-11-22: each task is a row of the reply, a member stops from its session)");
  assert.equal(await app.evaluate(`document.querySelectorAll("#message-list .sessions-waiting, #message-list .message-row[data-sessions-kind='waiting']").length`), 0);
  // A reply that gave no tasks says how long it worked the same quiet way as the fold: muted text, no pill.
  assert.deepEqual(await app.evaluate(`(() => { const row = document.querySelector('#message-list .message-row[data-thread-root="r3"]');
    const worked = row.querySelector(".sessions-worked");
    return { worked: worked?.textContent, plain: worked?.classList.contains("is-plain"), toggle: row.querySelectorAll(".sessions-worked-toggle").length,
      order: [...row.querySelector(".message-copy").children].map((node) => node.className.split(" ")[0]).slice(0, 3),
      border: worked ? getComputedStyle(worked.querySelector(".sessions-worked-label")).borderTopWidth : "" }; })()`),
  { worked: "Worked for 7s", plain: true, toggle: 0, order: ["message-meta", "sessions-worked", "message-content"], border: "0px" });
  // The header: no text buttons; the view is in the title's menu, the
  // members icon counts who works and has a dot for the open Accord.
  const header = await app.evaluate(`(() => ({
    switch: ${visible("#chat-view-switch")}, chevron: ${visible("#chat-title-chevron")},
    label: document.getElementById("chat-members-button").getAttribute("aria-label"), count: document.getElementById("chat-members-count").textContent,
    dot: ${visible("#chat-members-dot")}
  }))()`);
  assert.deepEqual(header, { switch: false, chevron: true, label: "Side panel (2 running)", count: "2", dot: true });
  // The User's message to the main session reads without its @main.
  assert.equal(await app.evaluate(`document.querySelector('#message-list .message-row[data-thread-root="u1"] .message-content').textContent.trim()`), "Fix the login page");
  // Only a current or former member's exact @handle is its chip (its
  // provider's logo and its task), in prose and in code, by the desktop's
  // rule; everything else stays as written.
  const reply = await app.evaluate(`(() => { const row = document.querySelector('#message-list .message-row[data-thread-root="r1"]');
    return { text: row.querySelector(".message-content").textContent.replace(/\\s+/g, " ").trim(),
      code: [...row.querySelectorAll(".message-content code")].map((node) => node.textContent),
      chips: [...row.querySelectorAll(".sessions-member-chip")].map((chip) => [chip.dataset.openMember, chip.querySelector(".provider-logo").dataset.providerKind, chip.textContent]),
      worked: row.querySelector(".sessions-worked-toggle")?.textContent, open: row.querySelectorAll(".sessions-delegation").length,
      order: [...row.querySelector(".message-copy").children].map((node) => node.className.split(" ")[0]) }; })()`);
  assert.equal(reply.text, "I split this: Restyle the login button restyles it, Login tests tests it and Check the server logs for every failed… reads the logs. " +
    "Ask main or @nobody. See Restyle the login button, ask Login tests now, npm i @types/node and @main; mail me@drew.dev, @drew/pkg or Summarise the old report.");
  assert.deepEqual(reply.chips, [["p-drew", "claude-code", "Restyle the login button"], ["p-taylor", "codex-cli", "Login tests"], ["p-sam", "gemini-cli", "Check the server logs for every failed…"],
    ["p-drew", "claude-code", "Restyle the login button"], ["p-taylor", "codex-cli", "Login tests"], [OLGA_ID, "unknown", "Summarise the old report"]],
    "short titles: the main session's, else the task's first sentence cut at a word; in code too, and a removed member's");
  assert.deepEqual(reply.code, ["ask ", " now", "npm i @types/node", "@main"], "code around a member's chip, and every other code as written");
  assert.equal(reply.worked, "Worked for 54s", "the turn's work, folded");
  assert.equal(reply.open, 0, "folded once the reply is finished");
  assert.deepEqual(reply.order.slice(0, 3), ["message-meta", "sessions-worked", "message-content"], "the fold comes before the reply's text");
  assert.equal(await app.evaluate(`/@(drew|taylor|sam|olga)\\b(?![./])/.test(document.getElementById("message-list").innerText)`), false, "no member's handle on the main timeline");
  // No avatar picture anywhere in the view.
  assert.equal(await app.evaluate(`[...document.querySelectorAll("#message-list .message-avatar, #message-list .avatar-icon, #message-list img")].filter((node) => node.offsetParent !== null).length`), 0);
  // The logo pictures are served as pictures.
  assert.deepEqual(await app.evaluate(`Promise.all(["./assets/providers/claude.png", "./assets/providers/antigravity.png"].map((url) => fetch(url).then((response) => response.status + " " + response.headers.get("content-type"))))`),
    ["200 image/png", "200 image/png"]);
  // Open the fold: a summary line, then a row per task.
  await app.evaluate(`document.querySelector('#message-list .message-row[data-thread-root="r1"] .sessions-worked-toggle').click()`);
  await app.waitFor(`document.querySelectorAll('#message-list .message-row[data-thread-root="r1"] .sessions-delegation').length === 3`, "the turn's tasks");
  const fold = await app.evaluate(`(() => { const row = document.querySelector('#message-list .message-row[data-thread-root="r1"]');
    return { summary: row.querySelector(".sessions-worked-summary").textContent, rows: [...row.querySelectorAll(".sessions-delegation")].map((node) => ({
      member: node.dataset.openMember, status: node.dataset.taskStatus, focus: node.dataset.focusMessage,
      logo: node.querySelector(".sessions-logo .provider-logo").dataset.providerKind, dot: node.querySelector(".sessions-logo-dot").className,
      title: node.querySelector(".sessions-delegation-title").textContent, result: node.querySelector(".sessions-delegation-result")?.textContent || "",
      time: node.querySelector(".sessions-delegation-time")?.textContent || "" })) }; })()`);
  assert.equal(fold.summary, "Delegated 3 tasks");
  assert.deepEqual(fold.rows.map((row) => [row.member, row.status, row.focus, row.logo, row.dot, row.title, row.result]), [
    ["p-drew", "running", "drew-run", "claude-code", "sessions-logo-dot is-running", "Restyle the login button", ""],
    ["p-taylor", "done", "taylor-reply", "codex-cli", "sessions-logo-dot is-done", "Login tests", "All 42 login tests pass."],
    ["p-sam", "running", "sam-run", "gemini-cli", "sessions-logo-dot is-running", "Check the server logs for every failed…", ""]
  ]);
  assert.match(fold.rows[0].time, /^\d+m \d+s$/, "a running task counts up");
  assert.equal(fold.rows[1].time, "23m 0s", "an ended task says how long it took");
  // No Stop on the main timeline stops the tasks: a member stops from its session.
  assert.equal(await app.evaluate(`document.querySelectorAll("#message-list .sessions-stop").length`), 0);

  // --- a delegation row opens the member's session at its message ----------
  await app.evaluate(`document.querySelector('#message-list .sessions-delegation[data-open-member="p-taylor"]').click()`);
  await app.waitFor(`${title} === "Login tests" && document.querySelector('#message-list .message-row.message-focused[data-thread-root="taylor-reply"]') !== null`,
    "taylor's session, at its reply");
  assert.deepEqual(await app.evaluate(rowsSummary), ["member-head:member-session-head\u0000p-taylor", "task-fold:req", "agent:taylor-reply"]);
  await app.evaluate(`document.getElementById("back-to-timeline").click()`);
  await app.waitFor(mainShown, "back");

  // --- a chip opens its member's session: drew, which writes to drew only --
  await app.evaluate(`document.querySelector('#message-list .sessions-member-chip[data-open-member="p-drew"]').click()`);
  await app.waitFor(`${title} === "Restyle the login button" && document.querySelector('#message-list .message-row.message-focused[data-thread-root="drew-run"]') !== null`,
    "drew's session, at its reply in progress");
  assert.equal(await app.evaluate(visible("#back-to-timeline")), true);
  assert.equal(await app.evaluate(`document.getElementById("composer-input").placeholder`), "Message this member...");
  assert.equal(await app.evaluate(visible("#mention-button")), false, "no @ to type in the sessions view");
  assert.deepEqual(await app.evaluate(rowsSummary), ["member-head:member-session-head\u0000p-drew", "task-fold:req", "you:u2", "agent:drew-run"]);
  const head = await app.evaluate(`(() => { const head = document.querySelector(".member-session-head");
    return [head.querySelector(".provider-logo").dataset.providerKind, head.querySelector(".member-session-provider").textContent, head.querySelector(".sessions-status").textContent,
      document.querySelector(".member-task-label").textContent, document.querySelector(".member-task-preview").textContent]; })()`);
  assert.deepEqual(head, ["claude-code", "Claude Code · Software Engineer · Local · desktop", "Running", "Task", "Restyle the login button"]);
  await app.evaluate(`(() => { const input = document.getElementById("composer-input"); input.value = "Please also check dark mode"; input.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("composer-form").requestSubmit(); })()`);
  const toDrew = await waitForOp(hub, (op) => op.kind === "message.create" && op.message && op.message.content === "Please also check dark mode");
  assert.deepEqual(toDrew.message.metadata.deliveryTargets, [DREW.id], "to that member only");
  await app.evaluate(`document.getElementById("back-to-timeline").click()`);
  await app.waitFor(mainShown, "back");

  // --- the one panel: no title, no main session; Accord, tasks, Removed -----
  await app.evaluate(`document.getElementById("chat-members-button").click()`);
  await app.waitFor(`${visible("#members-sheet")} && document.querySelectorAll("#members-sheet-list .sessions-member-row").length >= 2`, "the panel");
  const sheet = await app.evaluate(`(() => ({
    title: document.getElementById("members-sheet-title").textContent,
    titleHidden: document.getElementById("members-sheet-title").hidden,
    stopAll: !document.getElementById("members-sheet-stop-all").hidden,
    main: document.querySelector(".sessions-main-row") !== null,
    accord: document.querySelector(".sessions-accord-row")?.textContent || "",
    rows: [...document.querySelectorAll("#members-sheet-list .sessions-member-row")].map((row) => [row.dataset.memberSession, row.dataset.memberStatus,
      row.querySelector(".members-sheet-task").textContent, row.querySelector(".provider-logo").dataset.providerKind, Boolean(row.querySelector(".sessions-stop"))]),
    // Every row the computer's anatomy: a dot on its glyph, its task, its time; no state words, no model.
    anatomy: [...document.querySelectorAll("#members-sheet-list .sessions-member-row")].map((row) => [
      row.querySelector(".sessions-agent-dot")?.className || "",
      Boolean(row.querySelector(".sessions-agent-meta .sessions-elapsed.is-compact, .sessions-agent-meta .sessions-agent-time")),
      /Running|Waiting for you|Done|Failed|Stopped|Claude Code|Antigravity/.test(row.innerText)]),
    groups: [...document.querySelectorAll("#members-sheet-list .members-previous-toggle")].map((node) => node.textContent),
    handles: /@[A-Za-z]/.test(document.getElementById("members-sheet-list").innerText),
    members: /members?/i.test(document.getElementById("members-sheet").innerText),
    bare: [...document.querySelectorAll("#members-sheet-list .provider-logo")].every((logo) => logo.classList.contains("is-bare"))
  }))()`);
  assert.equal(sheet.title, "", "the panel has no title");
  assert.equal(sheet.titleHidden, true);
  assert.equal(sheet.stopAll, false, "no Stop all: each session is stopped from its row");
  assert.equal(sheet.main, false, "the main session is not listed: its settings are its composer chip");
  assert.equal(sheet.members, false, "the sessions view never says members");
  assert.equal(sheet.bare, true, "provider marks are bare glyphs");
  assert.match(sheet.accord, /^AccordButton colour · Drafts/, "the chat's Accord, by its document");
  assert.deepEqual(sheet.rows, [["p-drew", "running", "Restyle the login button", "claude-code", true], ["p-sam", "running", "Check the server logs for every failed…", "gemini-cli", true]],
    "the members at work, by task, with Stop; the one that ended under Previous agents");
  assert.deepEqual(sheet.anatomy, [["sessions-agent-dot is-running", true, false], ["sessions-agent-dot is-running", true, false]],
    "a pulsing dot and its time; no state words, no model");
  assert.deepEqual(sheet.groups, ["Previous agents1", "Removed1"]);
  assert.equal(sheet.handles, false, "no handles in the panel");
  // Stop on sam, which has written nothing yet, names its turn.
  await app.evaluate(`document.querySelector('#members-sheet-list .sessions-member-row[data-member-session="p-sam"] .sessions-stop').click()`);
  const stopSam = await waitForOp(hub, (op) => op.kind === "turn.stop" && op.participantId === SAM.id);
  assert.deepEqual([stopSam.messageId, stopSam.runId], ["req", "turn-run-sam"], "the Stop names sam's turn by its run");
  // A removed member's session reads, and writes nothing.
  await app.evaluate(`document.querySelector('#members-sheet-list [data-members-removed]').click()`);
  await app.waitFor(`document.querySelector('#members-sheet-list .sessions-member-row.is-former[data-member-session="${OLGA_ID}"]') !== null`, "Removed opened");
  assert.equal(await app.evaluate(`document.querySelector('#members-sheet-list .is-former .members-sheet-task').textContent`), "Summarise the old report");
  assert.equal(await app.evaluate(`document.querySelector('#members-sheet-list .is-former .sessions-agent-dot')`), null, "an ended session has no dot");
  await app.evaluate(`document.querySelector('#members-sheet-list .is-former').click()`);
  await app.waitFor(`${title} === "Summarise the old report" && document.querySelector('#message-list .message-row[data-thread-root="olga-reply"]') !== null`, "the removed member's session");
  const former = await app.evaluate(`({ composer: getComputedStyle(document.getElementById("composer-form")).display, stop: document.querySelectorAll("#message-list .sessions-stop").length,
    rows: ${rowsSummary}, detail: document.querySelector(".member-session-provider").textContent })`);
  assert.deepEqual(former, { composer: "none", stop: 0, rows: ["member-head:member-session-head\u0000p-olga", "task-fold:req-old", "agent:olga-reply"], detail: "Removed from the chat" });
  await app.evaluate(`document.getElementById("back-to-timeline").click()`);
  await app.waitFor(`${mainShown} && getComputedStyle(document.getElementById("composer-form")).display !== "none"`, "back, with the composer");

  // --- the Accord: a quiet line, its own screen ----------------------------
  const strip = await app.evaluate(`document.querySelector("#accord-dock .accord-strip").textContent`);
  assert.match(strip, /^Button colour · Drafts/);
  assert.equal(await app.evaluate(`document.querySelector("#accord-dock .accord-dock-card") === null`), true, "no framed card in the sessions view");
  await app.evaluate(`document.querySelector("#accord-dock .accord-strip").click()`);
  await app.waitFor(`${title} === "Accord" && document.querySelector('#message-list .sessions-accord-screen .accord-dock-card') !== null`, "the Accord's screen");
  assert.equal(await app.evaluate(`/@[A-Za-z]/.test(document.querySelector(".sessions-accord-screen").innerText)`), false, "its members by their tasks");
  await app.evaluate(`document.getElementById("back-to-timeline").click()`);
  await app.waitFor(mainShown, "back");

  // --- the main composer writes to the main session, whatever it says ------
  for (const text of ["Plain question", "@drew do this too"]) {
    await app.evaluate(`(() => { const input = document.getElementById("composer-input"); input.value = ${JSON.stringify(text)}; input.dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("composer-form").requestSubmit(); })()`);
    const sent = await waitForOp(hub, (op) => op.kind === "message.create" && op.message && op.message.content === text);
    assert.deepEqual(sent.message.metadata.deliveryTargets, [MAIN.id], `"${text}" goes to the main session`);
  }
  assert.equal(await app.evaluate(`document.getElementById("composer-input").placeholder`), "Ask anything");
  // The @ button is gone in the sessions view (its display rule must not beat [hidden]).
  assert.equal(await app.evaluate(`getComputedStyle(document.getElementById("mention-button")).display`), "none", "no @ button in the sessions view");

  // --- the main session's answer to a member is in that member's session ---
  await hub.addMessages("conv-main", [
    { id: "drew-q", role: "participant", participantId: DREW.id, participantLabel: "@drew", content: "@main which shade?", status: "done", createdAt: at(1),
      metadata: { participantRequest: { id: "batch-q", requesterParticipantId: DREW.id, requesterHandle: "drew", source: "mcp", resumeRequester: true, status: "running",
        depth: 1, createdAt: at(1), updatedAt: at(1), items: [item(MAIN.id, "main", "Which shade?", "running", 1)] } } },
    { id: "main-answer", role: "participant", participantId: MAIN.id, participantLabel: "@main", content: "Use the", status: "pending", createdAt: at(0.5),
      metadata: { runId: "run-answer", sourceMessageId: "drew-q" } }
  ]);
  await app.evaluate(`document.querySelector('#message-list .sessions-member-chip[data-open-member="p-drew"]').click()`);
  await app.waitFor(`${title} === "Restyle the login button" && document.querySelector('#message-list .message-row[data-thread-root="main-answer"]') !== null`, "in drew's session");
  // The main session's answer is told apart by its provider's logo, named by
  // nothing (no label for it in this view).
  assert.deepEqual(await app.evaluate(`(() => { const row = document.querySelector('#message-list .message-row[data-thread-root="main-answer"]');
    const handle = row.querySelector(".message-handle");
    return { logo: handle.querySelector(".provider-logo")?.dataset.providerKind ?? "", text: handle.textContent }; })()`), { logo: "claude-code", text: "" });
  assert.doesNotMatch(await app.evaluate(`document.getElementById("message-list").innerText`), /main session/i);
  // Its question to the main session reads alone, as on the desktop.
  assert.equal(await app.evaluate(`document.querySelector('#message-list .message-row[data-thread-root="drew-q"] .message-content')?.textContent.trim()`), "which shade?");
  await app.evaluate(`document.getElementById("back-to-timeline").click()`);
  await app.waitFor(mainShown, "back");
  assert.equal(await app.evaluate(`document.querySelector('#message-list .message-row[data-thread-root="main-answer"]') === null`), true, "not on the main timeline while it is written");
  // The main session itself runs: with nothing typed, the main composer's
  // button is its Stop (as on the desktop, T3 Code and Claude); typing makes
  // it Send again.
  const sendMode = `document.getElementById("send-button").dataset.mode`;
  const typeIn = (text) => app.evaluate(`(() => { const input = document.getElementById("composer-input"); input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await app.waitFor(`${sendMode} === "stop"`, "the composer's Stop");
  assert.equal(await app.evaluate(`document.getElementById("send-button").getAttribute("aria-label")`), "Stop");
  const sideStop = `(() => { const node = document.getElementById("composer-stop-button");
    return { shown: !node.hidden && getComputedStyle(node).display !== "none", label: node.getAttribute("aria-label"), disabled: node.disabled }; })()`;
  assert.equal((await app.evaluate(sideStop)).shown, false, "nothing typed: the send button itself is Stop, nothing beside it");
  await typeIn("one more thing");
  assert.equal(await app.evaluate(sendMode), "send", "typing turns it back into Send");
  assert.deepEqual(await app.evaluate(sideStop), { shown: true, label: "Stop", disabled: false },
    "with something typed Stop stands beside Send: the CLI interrupts whatever is in the prompt");
  await typeIn("");
  assert.equal(await app.evaluate(sendMode), "stop");
  assert.equal((await app.evaluate(sideStop)).shown, false);
  // A picture is something to send too: picking one with nothing typed
  // turns Stop into Send, and taking it off brings Stop back.
  await app.evaluate(`(() => {
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const picked = new DataTransfer();
    picked.items.add(new File([bytes], "dot.png", { type: "image/png" }));
    const input = document.getElementById("composer-image-input");
    input.files = picked.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await app.waitFor(`document.querySelectorAll("#composer-attachments .composer-attachment-chip").length === 1`, "the picture waits in the composer");
  assert.equal(await app.evaluate(sendMode), "send", "a picked picture turns Stop into Send");
  await app.evaluate(`document.querySelector("#composer-attachments .composer-attachment-remove").click()`);
  await app.waitFor(`document.querySelectorAll("#composer-attachments .composer-attachment-chip").length === 0`, "the picture is taken off");
  assert.equal(await app.evaluate(sendMode), "stop", "with nothing left to send, Stop again");
  // Stop beside Send stops the run and leaves what is typed to be sent.
  await typeIn("keep this for later");
  await app.evaluate(`document.getElementById("composer-stop-button").click()`);
  const stopMain = await waitForOp(hub, (op) => op.kind === "turn.stop" && op.participantId === MAIN.id);
  assert.equal(stopMain.messageId, "drew-q", "the main session's run, named by the message it answers");
  assert.equal(await app.evaluate(`document.getElementById("composer-input").value`), "keep this for later", "what is typed stays");
  assert.equal(await app.evaluate(sendMode), "send", "still Send: the words are for sending");
  await typeIn("");
  // Back before a member's session is drawn is back: the reply its chip
  // leads to does not open that session again once the rows are read.
  await app.evaluate(`(() => { document.querySelector('#message-list .sessions-member-chip[data-open-member="p-drew"]').click(); document.getElementById("back-to-timeline").click(); })()`);
  await app.waitFor(mainShown, "back at once");
  await sleep(1500);
  assert.equal(await app.evaluate(mainShown), true, "still the main timeline once the rows are read");
  await app.evaluate(`document.querySelector('#message-list .sessions-member-chip[data-open-member="p-drew"]').click()`);
  await app.waitFor(`${title} === "Restyle the login button"`, "drew's session again");
  // A task's end its request message has not been read again for: its reply says it.
  await hub.rewriteMessage("conv-main", { id: "drew-run", role: "participant", participantId: DREW.id, participantLabel: "@drew", content: "Restyled the button.", status: "done", createdAt: at(3),
    metadata: { runId: "run-drew", sourceMessageId: "req" } });
  await app.evaluate(`document.getElementById("back-to-timeline").click()`);
  await app.waitFor(mainShown, "back");
  await app.evaluate(`document.querySelector('#message-list .message-row[data-thread-root="r1"] .sessions-delegation') || document.querySelector('#message-list .message-row[data-thread-root="r1"] .sessions-worked-toggle').click()`);
  await app.waitFor(`document.querySelector('#message-list .sessions-delegation[data-open-member="p-drew"]')?.dataset.taskStatus === "done"`, "drew's task is done");
  assert.equal(await app.evaluate(`document.querySelector('#message-list .sessions-delegation[data-open-member="p-drew"] .sessions-delegation-result').textContent`), "Restyled the button.");

  // --- a member's question waits on the main timeline, named by its task ----
  const asking = { id: "drew-asks", role: "participant", participantId: DREW.id, participantLabel: "@drew", content: "Which shade of blue?", status: "done", createdAt: at(0.2),
    metadata: { pendingChoice: { id: "choice-shade", title: "Shade", question: "Which shade of blue?", status: "pending", askedAt: at(0.2),
      options: [{ id: "a", label: "Navy" }, { id: "b", label: "Sky" }] } } };
  await hub.writeMessage("conv-main", asking);
  await hub.raiseChoice("conv-main", asking);
  await app.waitFor(`(() => { const row = document.querySelector('#message-list .message-row[data-sessions-kind="choice"]');
    return Boolean(row && row.querySelector(".sessions-choice-from").textContent === "Restyle the login button asks" &&
      row.querySelector('.sessions-choice-from .provider-logo[data-provider-kind="claude-code"]') && row.querySelector('.control-card[data-card-id="choice-shade"]')); })()`,
  "drew's question with its card, on the main timeline, by its task and logo");

  // --- a member's reply reached from Activity opens its session -------------
  await app.evaluate(`document.querySelector('[data-home-tab="activity"]').click()`);
  await app.waitFor(`document.getElementById("activity-screen").classList.contains("is-active") && Boolean(document.querySelector('.act-tab[data-activity-tab="finished"]'))`, "Activity");
  await app.evaluate(`document.querySelector('.act-tab[data-activity-tab="finished"]').click()`);
  await app.waitFor(`[...document.querySelectorAll("#activity-list .act-row")].some((row) => row.innerText.includes("All 42 login tests pass"))`, "taylor's reply in Activity");
  await sleep(700);
  await app.evaluate(`[...document.querySelectorAll("#activity-list .act-row")].find((row) => row.innerText.includes("All 42 login tests pass")).click()`);
  await app.waitFor(`${title} === "Login tests" && document.querySelector('#message-list .message-row[data-thread-root="taylor-reply"]') !== null`,
    "taylor's session, from Activity");
  await app.evaluate(`document.getElementById("back-to-timeline").click()`);
  await app.waitFor(mainShown, "back");

  // --- the title's menu switches the view -----------------------------------
  await app.evaluate(`document.getElementById("chat-members-toggle").click()`);
  await app.waitFor(visible("#chat-title-menu"), "the title's menu");
  assert.deepEqual(await app.evaluate(`[...document.querySelectorAll("#chat-title-menu [data-title-view]")].map((node) => node.textContent + ":" + node.getAttribute("aria-checked"))`),
    ["View: Sessions:true", "View: Classic:false"]);
  await app.evaluate(`document.querySelector('#chat-title-menu [data-title-view="classic"]').click()`);
  await app.waitFor(`document.querySelectorAll("#message-list .message-row.is-sessions").length === 0 && document.querySelector('#message-list .message-row[data-thread-root="req"]') !== null`,
    "the classic timeline");
  const update = await waitForOp(hub, (op) => op.kind === "conversation.update" && op.metadata && op.metadata.chatView === "classic");
  assert.deepEqual(update.metadata, { chatView: "classic" }, "the view, written through her server");
  const classic = await app.evaluate(`(() => ({
    switch: ${visible("#chat-view-switch")}, pressed: document.querySelector('#chat-view-switch [data-view="classic"]').getAttribute("aria-pressed"),
    avatars: [...document.querySelectorAll('#message-list .message-row[data-author="agent"] .message-avatar')].filter((node) => getComputedStyle(node).display !== "none").length,
    handles: [...document.querySelectorAll('#message-list .message-row[data-author="agent"] .message-handle')].map((node) => node.textContent),
    note: document.querySelector('#message-list .message-row[data-finished-note="1"]') !== null,
    button: document.getElementById("chat-members-button").getAttribute("aria-label")
  }))()`);
  assert.equal(classic.switch, true, "the classic view keeps its switch");
  assert.equal(classic.pressed, "true");
  assert.ok(classic.avatars >= 2, `avatars are back: ${JSON.stringify(classic)}`);
  assert.ok(classic.handles.includes("@main") && classic.handles.includes("@drew"), `authors are back: ${JSON.stringify(classic.handles)}`);
  assert.equal(classic.note, true, "the turn-finished note is back");
  assert.equal(classic.button, "Members: 4 members", "the classic members button");
  // A message without an addressee goes to the main session here too.
  await app.evaluate(`(() => { const input = document.getElementById("composer-input"); input.value = "Classic question"; input.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("composer-form").requestSubmit(); })()`);
  const classicSent = await waitForOp(hub, (op) => op.kind === "message.create" && op.message && op.message.content === "Classic question");
  assert.deepEqual(classicSent.message.metadata.deliveryTargets, [MAIN.id], "the main session takes a message that names nobody");
  // The classic main composer keeps today's routing: an @handle is for that member.
  await app.evaluate(`(() => { const input = document.getElementById("composer-input"); input.value = "@drew classic task"; input.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("composer-form").requestSubmit(); })()`);
  const classicMention = await waitForOp(hub, (op) => op.kind === "message.create" && op.message && op.message.content === "@drew classic task");
  assert.deepEqual(classicMention.message.metadata.deliveryTargets, [DREW.id], "a message to @drew in the classic view goes to drew, not the main session");

  // --- a chat made before main sessions ------------------------------------
  await app.evaluate(`document.getElementById("back-to-chats").click()`);
  await openChat(app, "conv-old");
  await app.waitFor(`document.querySelector('#message-list .message-row[data-thread-root="o2"]') !== null`, "the old chat");
  const old = await app.evaluate(`(() => ({
    group: document.getElementById("chat-view-switch").classList.contains("is-disabled"),
    chevron: ${visible("#chat-title-chevron")},
    sessionsRows: document.querySelectorAll("#message-list .message-row.is-sessions").length,
    avatar: getComputedStyle(document.querySelector('#message-list .message-row[data-thread-root="o2"] .message-avatar')).display,
    why: document.getElementById("chat-view-switch").title
  }))()`);
  assert.deepEqual(old, { group: true, chevron: false, sessionsRows: 0, avatar: "flex",
    why: "This chat was made before the Sessions view, so it has the Classic view only." }, "why, in the switch's own words: no main session named");
});

test("classic New chat on the phone names the main session by its provider, never as a main session", { timeout: 120_000 }, async (t) => {
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: 8394, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-sessions-classic-new-");
  const chrome = launchChrome({ port: 9544, profile, url: `${site.origin}/` });
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
  const newChat = { projects: [], assistant: mainSession, mainSession, defaultChatView: "classic", members: [{ configId: "c-drew", uses: 1, participant: drew }] };
  await hub.call("PUT", "/v1/catalog", { catalog: { version: 1, publishedAt: new Date().toISOString(),
    roles: { "software-engineer": "Engineer", "main-session": "Main session" }, prompts: [], skills: [], avatars: {}, newChat } });
  app = await attachApp({ port: 9544 });
  await pairPage(app, { hub, siteOrigin: site.origin, query: "qa=1" });
  await app.waitFor(`!document.getElementById("new-chat-button").hidden`, "New chat");
  await app.evaluate(`document.getElementById("new-chat-button").click()`);
  await app.waitFor(`document.querySelectorAll("#new-chat-members .new-chat-member").length === 2`, "the main session and the saved member");
  const shown = await app.evaluate(`(() => {
    const row = document.querySelector('#new-chat-members .new-chat-member[data-handle="main"]');
    return {
      name: row.querySelector("strong").textContent,
      role: row.querySelector(".members-sheet-role").textContent,
      button: document.getElementById("new-chat-members-button").getAttribute("aria-label"),
      words: document.querySelector(".new-chat-card").textContent + " " + document.getElementById("new-chat-members").textContent
    };
  })()`);
  assert.deepEqual([shown.name, shown.role, shown.button], ["Claude Code", "@main", "Members: Claude Code"], "its provider's name, as the computer names it");
  assert.doesNotMatch(shown.words, /main session/i, "no main session named");

  // On an added provider: that provider's own name; on Antigravity: the
  // computer's name for it.
  for (const [lead, name] of [
    [{ ...mainSession, hostId: "zai", hostLabel: "Z.ai GLM", hostVendor: "zai" }, "Z.ai GLM"],
    [{ ...mainSession, kind: "gemini-cli" }, "Antigravity"]
  ]) {
    await app.evaluate(`document.getElementById("new-chat-close").click()`);
    await hub.call("PUT", "/v1/catalog", { catalog: { version: 1, publishedAt: new Date().toISOString(),
      roles: { "software-engineer": "Engineer", "main-session": "Main session" }, prompts: [], skills: [], avatars: {},
      newChat: { ...newChat, assistant: lead, mainSession: lead } } });
    await app.evaluate(`document.getElementById("new-chat-button").click()`);
    await app.waitFor(`document.querySelector('#new-chat-members .new-chat-member[data-handle="main"] strong')?.textContent === ${JSON.stringify(name)}`, name);
    assert.equal(await app.evaluate(`document.getElementById("new-chat-members-button").getAttribute("aria-label")`), `Members: ${name}`);
  }
});

test("a view picked on the phone stays while her server catches up with the one picked before it", { timeout: 120_000 }, async (t) => {
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: 8397, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-view-pick-");
  const chrome = launchChrome({ port: 9547, profile, url: `${site.origin}/` });
  let app;
  t.after(async () => {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  await hub.createChat("conv-pick", {
    title: "Pick", participants: [MAIN], createdAt: at(10),
    metadata: { mainSessionParticipantId: MAIN.id, chatView: "sessions" },
    messages: [
      { id: "u1", role: "user", content: "Hello", status: "done", createdAt: at(9), metadata: { deliveryTargets: [MAIN.id] } },
      { id: "r1", role: "participant", participantId: MAIN.id, participantLabel: "@main", content: "Hi.", status: "done", createdAt: at(8), metadata: { sourceMessageId: "u1" } }
    ]
  });
  app = await attachApp({ port: 9547 });
  await pairPage(app, { hub, siteOrigin: site.origin, query: "qa=1" });
  await openChat(app, "conv-pick");
  const sessionsDrawn = `document.querySelectorAll("#message-list .message-row.is-sessions").length > 0`;
  await app.waitFor(sessionsDrawn, "the sessions view");
  // Her server is slow to take a view: each change waits a while on the way.
  hub.setGate((seen) => (seen.ops || []).some((op) => op.kind === "conversation.update" && op.metadata && op.metadata.chatView) ? { delayMs: 1500 } : undefined);
  const pick = async (view) => {
    await app.evaluate(`document.getElementById("chat-members-toggle").click()`);
    await app.waitFor(`Boolean(document.querySelector('#chat-title-menu [data-title-view="${view}"]'))`, "the title's menu");
    await app.evaluate(`document.querySelector('#chat-title-menu [data-title-view="${view}"]').click()`);
  };
  await pick("classic");
  await app.waitFor(`document.querySelectorAll("#message-list .message-row.is-sessions").length === 0 && document.querySelector('#message-list .message-row[data-thread-root="r1"]') !== null`, "the classic view, at once");
  // Back to the sessions view before her server has taken the classic one:
  // the phone keeps showing what she picked while the server catches up.
  await pick("sessions");
  await app.waitFor(sessionsDrawn, "the sessions view, at once");
  await app.evaluate(`(() => { window.__drawnViews = []; const t0 = performance.now();
    const tick = () => { const drawn = document.querySelectorAll("#message-list .message-row.is-sessions").length > 0 ? "sessions" : "classic";
      if (window.__drawnViews[window.__drawnViews.length - 1] !== drawn) window.__drawnViews.push(drawn);
      if (performance.now() - t0 < 6000) setTimeout(tick, 20); };
    tick(); })()`);
  const taken = await waitForOp(hub, (op) => op.kind === "conversation.update" && op.metadata && op.metadata.chatView === "sessions");
  assert.deepEqual(taken.metadata, { chatView: "sessions" });
  await sleep(6500);
  assert.deepEqual(await app.evaluate(`window.__drawnViews`), ["sessions"], "never the classic view again while the server caught up");
  assert.equal((await hub.storage.getConversation("conv-pick")).metadata.chatView, "sessions", "her server holds the view she picked last");
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
  // A new chat that opens in the sessions view has no members on New chat:
  // the chip names the main session's provider (a computer from before
  // offers no model list: its CLI's name).
  await app.waitFor(`!document.getElementById("new-chat-model-button").hidden && !document.getElementById("new-chat-model-button").disabled`, "the model chip");
  const lead = await app.evaluate(`(() => ({
    members: !document.getElementById("new-chat-members-button").hidden,
    listed: document.querySelectorAll("#new-chat-members .new-chat-member").length,
    chip: document.getElementById("new-chat-model-label").textContent,
    glyph: document.querySelector("#new-chat-model-label .provider-logo")?.dataset.providerKind ?? null,
    avatar: document.querySelector(".new-chat-card .mobile-mention-avatar") !== null,
    text: document.querySelector(".new-chat-card").innerText
  }))()`);
  assert.deepEqual([lead.members, lead.listed, lead.chip, lead.glyph, lead.avatar], [false, 0, "Claude Code", "claude-code", false], "no members, the chip instead");
  assert.equal(/Assistant|members?/i.test(lead.text), false, "nothing says Assistant or members");

  await app.evaluate(`(() => { const input = document.getElementById("new-chat-input"); input.value = "Plan the release"; input.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("new-chat-start").click(); })()`);
  const create = await waitForOp(hub, (op) => op.kind === "conversation.create");
  const participants = create.conversation.metadata.participants;
  const made = participants.find((participant) => participant.roleConfigId === "main-session");
  assert.ok(made && made.id !== "t-main", "the main session, with an id of its own");
  assert.equal(participants[0].id, made.id, "first");
  assert.equal(participants.length, 1, "alone: it makes members itself");
  assert.equal(create.conversation.metadata.mainSessionParticipantId, made.id, "the chat says which member is its main session");
  assert.equal(create.conversation.metadata.chatView, "sessions", "and opens in the sessions view");
  // Its first message names nobody: it goes to the main session (a member
  // list without roles once sent it to nobody, and nobody ran).
  const first = await waitForOp(hub, (op) => op.kind === "message.create" && op.message && op.message.content === "Plan the release");
  assert.deepEqual(first.message.metadata.deliveryTargets, [made.id], "the first message goes to the main session");
  // The chat opens in the sessions view at once.
  await app.waitFor(`document.getElementById("timeline-screen").classList.contains("is-active") &&
    document.querySelector('#chat-title-menu [data-title-view="sessions"]').getAttribute("aria-checked") === "true"`, "the new chat in the sessions view");
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

test("the phone's side panel names a member by its delegation's title and shows one its permission holds up as Waiting for you, out of the running count", { timeout: 180_000 }, async (t) => {
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: 8391, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-side-panel-");
  const chrome = launchChrome({ port: 9541, profile, url: `${site.origin}/` });
  let app;
  t.after(async () => {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  // drew keeps its delegation's title with it (its delegation is not among
  // the messages); taylor's titled delegation and an untitled follow-up are.
  const drew = { ...DREW, taskTitle: "Restyle the button" };
  await hub.createChat("conv-panel", {
    title: "Side panel", participants: [MAIN, drew, TAYLOR, SAM], createdAt: at(40),
    metadata: { mainSessionParticipantId: MAIN.id, chatView: "sessions" },
    messages: [
      { id: "pu1", role: "user", content: "Go", status: "done", createdAt: at(30), metadata: { deliveryTargets: [MAIN.id] } },
      request("pd-taylor", "pu1", 29, [item(TAYLOR.id, "taylor", "Run the login tests and report.", "answered", 29, { title: "Login tests", doneAt: 20 })]),
      request("pf-drew", "pu1", 10, [item(DREW.id, "drew", "Two additions to your task \"Restyle the button\": the phone too.", "running", 10)]),
      request("pf-taylor", "pu1", 9, [item(TAYLOR.id, "taylor", "Two additions to your task \"Login tests\": add the logout test.", "running", 9)]),
      request("pd-sam", "pu1", 8, [item(SAM.id, "sam", "Read the logs.", "running", 8, { title: "Server logs" })]),
      { id: "pdrew-run", role: "participant", participantId: DREW.id, participantLabel: "@drew", content: "", status: "pending", createdAt: at(5),
        metadata: { runId: "run-pdrew", sourceMessageId: "pf-drew" } },
      { id: "ptaylor-run", role: "participant", participantId: TAYLOR.id, participantLabel: "@taylor", content: "Adding it", status: "pending", createdAt: at(4),
        metadata: { runId: "run-ptaylor", sourceMessageId: "pf-taylor" } },
      { id: "psam-run", role: "participant", participantId: SAM.id, participantLabel: "@sam", content: "Reading", status: "pending", createdAt: at(3),
        metadata: { runId: "run-psam", sourceMessageId: "pd-sam" } }
    ]
  });
  // drew's turn waits on its CLI's permission prompt; sam's script request
  // does not hold its turn.
  const now = new Date().toISOString();
  const approval = (id, participantId, handle, toolName, summary) => ({
    id, conversationId: "conv-panel", requesterParticipantId: participantId, requesterHandle: handle, requesterRoleConfigId: "software-engineer",
    toolName, capability: "permissions.request", status: "pending", request: { toolName: "Write", input: { file_path: "/tmp/x" } }, summary, createdAt: now, updatedAt: now
  });
  await hub.raiseApproval("conv-panel", approval("ap-drew", DREW.id, "drew", "app_tool_permission", "Grant @drew Write"));
  await hub.raiseApproval("conv-panel", approval("ap-sam", SAM.id, "sam", "app_scripts_request_change", "Add a scheduled script"));
  app = await attachApp({ port: 9541 });
  await pairPage(app, { hub, siteOrigin: site.origin, query: "qa=1" });
  await openChat(app, "conv-panel");
  await app.waitFor(`${visible("#chat-members-button")}`, "the panel's icon");
  await app.waitFor(`document.getElementById("chat-members-button").getAttribute("aria-label") === "Side panel (2 running)"`,
    "taylor and sam run; drew waits for the User", 20_000);
  await app.evaluate(`document.getElementById("chat-members-button").click()`);
  await app.waitFor(`${visible("#members-sheet")} && document.querySelectorAll("#members-sheet-list .sessions-member-row").length >= 3`, "the panel");
  const rows = await app.evaluate(`[...document.querySelectorAll("#members-sheet-list .sessions-member-row")].map((row) =>
    [row.dataset.memberSession, row.dataset.memberStatus, row.querySelector(".members-sheet-task").textContent])`);
  assert.deepEqual(rows, [
    [DREW.id, "waiting", "Restyle the button"],
    [TAYLOR.id, "running", "Login tests"],
    [SAM.id, "running", "Server logs"]
  ], "titles from the delegations, never a follow-up's words; only the held-up turn waits");
  // Every row: its dot and its time; no state words, no model.
  const meta = await app.evaluate(`[...document.querySelectorAll("#members-sheet-list .sessions-member-row")].map((row) =>
    [row.querySelector(".sessions-agent-dot").className, /^\\d/.test(row.querySelector(".sessions-agent-meta .sessions-elapsed, .sessions-agent-meta .sessions-agent-time")?.textContent || ""),
      /Running|Waiting for you|Done|Failed|Stopped|Claude Code|Codex|Antigravity/.test(row.innerText), row.getAttribute("aria-label")])`);
  assert.deepEqual(meta, [
    ["sessions-agent-dot is-waiting", true, false, "Restyle the button, Waiting for you"],
    ["sessions-agent-dot is-running", true, false, "Login tests, Running"],
    ["sessions-agent-dot is-running", true, false, "Server logs, Running"]
  ], "a dot per state, a time on every row (drew: how long it worked before it began to wait), the state in words only for a screen reader");
  assert.deepEqual(await app.evaluate(`[...document.querySelectorAll("#members-sheet-list .sessions-member-row")].map((row) => Boolean(row.querySelector(".sessions-stop")))`),
    [false, true, true], "Stop only while it runs: not on drew, which waits for the User though its turn is live");
});
