import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSessionsViewIndex,
  isMainSessionTaskMessage,
  isSessionsHiddenTurnFinishedNote,
  mainTimelineMessages,
  memberSessionMessages,
  membersMainSessionWaitsOn,
  sessionsFormerMembers,
  sessionsTaskPlacement,
  sessionsViewLane,
  withoutLeadingMention
} from "./mainSession";
import {
  firstTextLine,
  isMainSessionDelegationRosterCard,
  latestTaskByMember,
  memberRunningSince,
  openMemberCardMessages,
  sessionsMemberRows,
  sessionsMemberActivity,
  sessionsMemberStatus,
  sessionsTaskGroupLabel,
  sessionsTaskReplyLine,
  sessionsTaskRunningSince,
  sessionsDelegationSummary,
  sessionsFormerMemberStatus,
  sessionsMemberDetail,
  sessionsMemberTitle,
  sessionsTaskEntries,
  sessionsTaskStatus,
  sessionsTaskTitle,
  shortenAtWord,
  sessionsMentionPieces,
  sessionsWaitingText
} from "./mainSessionView";
import type { ChatMessage, ChatParticipant, ChatParticipantRequestBatch, ChatParticipantRequestItem } from "./types";

const at = (minute: number): string => `2026-11-20T10:${String(minute).padStart(2, "0")}:00.000Z`;
const member = (id: string, handle: string): ChatParticipant =>
  ({ id, handle, roleConfigId: id === "p-main" ? "main-session" : "generic-participant", kind: "claude-code" }) as ChatParticipant;
const participants = [member("p-main", "main"), member("p-drew", "drew"), member("p-gera", "gera"), member("p-taylor", "taylor")];

function item(target: string, status: ChatParticipantRequestItem["status"], minute: number, replyMessageId?: string): ChatParticipantRequestItem {
  return { targetParticipantId: target, targetHandle: target.slice(2), prompt: `Task for ${target.slice(2)}\nwith details`, status, createdAt: at(minute), updatedAt: at(minute), ...(replyMessageId ? { replyMessageId } : {}) };
}

function batch(id: string, requester: string, items: ChatParticipantRequestItem[], extra: Partial<ChatParticipantRequestBatch> = {}): ChatParticipantRequestBatch {
  return { id, requesterParticipantId: requester, requesterHandle: requester.slice(2), source: "mcp", resumeRequester: true, status: "running", depth: 1, createdAt: items[0]!.createdAt, updatedAt: items[0]!.createdAt, items, ...extra };
}

function message(id: string, role: ChatMessage["role"], minute: number, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, content: id, createdAt: at(minute), status: "done", ...extra } as ChatMessage;
}

function chat(): ChatMessage[] {
  return [
    message("intro", "system", 0),
    message("ask", "user", 1, { content: "Fix the login bug", metadata: { askedParticipantIds: ["p-main"] } }),
    message("main-1", "participant", 2, { participantId: "p-main", content: "On it." }),
    message("tasks", "participant", 3, { participantId: "p-main", metadata: { participantRequest: batch("b1", "p-main", [item("p-drew", "running", 3), item("p-gera", "answered", 3, "gera-reply")]) } }),
    message("drew-question", "participant", 4, { participantId: "p-drew", metadata: { participantRequest: batch("b2", "p-drew", [item("p-main", "answered", 4, "main-answer")], { resumeRequester: true }) } }),
    message("main-answer", "participant", 5, { participantId: "p-main", content: "Use the staging config." }),
    message("gera-reply", "participant", 6, { participantId: "p-gera", content: "## Done: the token refresh is fixed\n\nDetails follow." }),
    message("to-drew", "user", 7, { content: "Also check logout", metadata: { askedParticipantIds: ["p-drew"] } }),
    message("drew-running", "participant", 8, { participantId: "p-drew", status: "pending", content: "" }),
    message("taylor-choice", "participant", 9, { participantId: "p-taylor", content: "Which DB?", metadata: { pendingChoice: { id: "c1", title: "DB", question: "Which?", options: [], status: "pending" } } })
  ];
}

test("the main timeline holds the User's messages to the main session, its own messages and its task requests, not members' replies", () => {
  const messages = chat();
  const index = buildSessionsViewIndex(messages, "p-main");
  assert.deepEqual(mainTimelineMessages(messages, index).map((entry) => entry.id), ["intro", "ask", "main-1", "tasks"]);
  assert.equal(isMainSessionTaskMessage(messages[3]!, index), true, "the main session's request is a task card");
  assert.equal(isMainSessionTaskMessage(messages[4]!, index), false, "a member's question to the main session is not");
});

test("a member's session holds its task, its replies, its questions with the main session's answers and the User's messages to it", () => {
  const messages = chat();
  const index = buildSessionsViewIndex(messages, "p-main");
  assert.deepEqual(memberSessionMessages(messages, "p-drew", index).map((entry) => entry.id), ["tasks", "drew-question", "main-answer", "to-drew", "drew-running"]);
  assert.deepEqual(memberSessionMessages(messages, "p-gera", index).map((entry) => entry.id), ["tasks", "gera-reply"]);
});

test("a member's open card stays on the main timeline; the main session waits on its running tasks only", () => {
  const messages = chat();
  const index = buildSessionsViewIndex(messages, "p-main");
  assert.deepEqual(openMemberCardMessages(messages, index).map((entry) => entry.id), ["taylor-choice"]);
  assert.deepEqual(membersMainSessionWaitsOn(messages, index), ["p-drew"]);
  const answered = messages.map((entry) => entry.id === "taylor-choice"
    ? { ...entry, metadata: { pendingChoice: { ...entry.metadata!.pendingChoice!, status: "selected" as const } } }
    : entry);
  assert.deepEqual(openMemberCardMessages(answered, index), [], "an answered card goes back to the member's session");
  const mention = message("gera-mention", "participant", 10, { participantId: "p-gera", content: "@taylor can you check?", metadata: { pendingMentions: [{ targetParticipantId: "p-taylor", targetHandle: "taylor", status: "pending" }] } });
  assert.deepEqual(openMemberCardMessages([...answered, mention], index).map((entry) => entry.id), ["gera-mention"], "so does a mention approval");
  const onServer = { ...mention, metadata: { ...mention.metadata, serverCard: { cardId: "mention:gera-mention", state: "answered" as const, answer: {}, answeredAt: at(11), machineName: "the machine" } } };
  assert.deepEqual(openMemberCardMessages([...answered, onServer], index), [], "answered on her server, it waits for the machine in the member's session");
});

test("a task's status follows its item and its member", () => {
  const given = (status: ChatParticipantRequestItem["status"]) => ({ status, createdAt: at(10) });
  assert.equal(sessionsTaskStatus(given("running"), "running"), "running");
  assert.equal(sessionsTaskStatus(given("running"), "pending"), "waiting", "the member waits on the User's card");
  assert.equal(sessionsTaskStatus(given("pending_approval")), "waiting");
  assert.equal(sessionsTaskStatus(given("answered")), "done");
  assert.equal(sessionsTaskStatus(given("resuming_requester")), "done");
  assert.equal(sessionsTaskStatus(given("completed")), "done");
  assert.equal(sessionsTaskStatus(given("failed")), "failed");
  assert.equal(sessionsTaskStatus(given("denied")), "failed");
  assert.equal(sessionsTaskStatus(given("interrupted")), "stopped");
  assert.equal(sessionsTaskStatus(given("running"), "stopped", at(11)), "stopped", "its turn was stopped after it was given");
  assert.equal(sessionsTaskStatus(given("running"), "error", at(10)), "failed");
});

test("a new task is not shown Stopped or Failed by the member's earlier turn while it waits in the queue", () => {
  const task = { status: "running" as const, createdAt: at(10) };
  assert.equal(sessionsTaskStatus(task, "stopped", at(5)), "running", "a stop from before the task was given");
  assert.equal(sessionsTaskStatus(task, "error", at(9)), "running", "a failure from before the task was given");
  assert.equal(sessionsTaskStatus(task, "stopped"), "running", "no finished message known");
  assert.equal(sessionsMemberStatus("stopped", task, at(5)), "running", "the members panel too");
  assert.equal(sessionsMemberStatus("error", task, at(9)), "running");
  assert.equal(sessionsMemberStatus("stopped", task, at(12)), "stopped");
  assert.equal(sessionsMemberStatus("stopped", undefined, at(5)), "stopped", "a member without a task keeps its state");
  const messages = [
    message("old-stop", "participant", 5, { participantId: "p-drew", status: "error", metadata: { terminalReason: "user-stopped" } }),
    message("queued", "participant", 11, { participantId: "p-drew", status: "pending" })
  ];
  const activity = sessionsMemberActivity(messages);
  assert.equal(activity.finishedAt.get("p-drew"), at(5));
  assert.equal(activity.runningSince.get("p-drew"), at(11));
});

test("a member's status is what it does now, else how its latest task ended", () => {
  const given = (status: ChatParticipantRequestItem["status"]) => ({ status, createdAt: at(10) });
  assert.equal(sessionsMemberStatus("running", given("completed")), "running");
  assert.equal(sessionsMemberStatus("background", undefined), "running");
  assert.equal(sessionsMemberStatus("pending", undefined), "waiting");
  assert.equal(sessionsMemberStatus("idle", given("completed")), "done");
  assert.equal(sessionsMemberStatus(undefined, undefined), "idle");
  assert.equal(sessionsMemberStatus("error", given("running"), at(12)), "failed");
});

test("the result line is the reply's first line without markdown or a choice block", () => {
  const messages = chat();
  const byId = new Map(messages.map((entry) => [entry.id, entry]));
  assert.equal(sessionsTaskReplyLine({ replyMessageId: "gera-reply" }, byId), "Done: the token refresh is fixed");
  assert.equal(sessionsTaskReplyLine({ replyMessageId: "drew-running" }, byId), undefined, "no line while the reply streams");
  assert.equal(sessionsTaskReplyLine({}, byId), undefined);
  assert.equal(firstTextLine("\n\n- **Bold** item `code`"), "Bold item code");
  assert.equal(firstTextLine("Please review [the resolution](#artifact:3208efce) now"), "Please review the resolution now");
  assert.equal(firstTextLine("Pick one\n\nUser choice: Pick\nT: Pick\nQ: Which?\nO1: A\nO2: B\nR: O1"), "Pick one");
  assert.equal(firstTextLine("x".repeat(300), 10), "xxxxxxxxx…");
});

test("a running task counts its time from the member's reply in progress", () => {
  const messages = chat();
  assert.equal(sessionsTaskRunningSince({ targetParticipantId: "p-drew", createdAt: at(3) }, messages), at(8));
  assert.equal(sessionsTaskRunningSince({ targetParticipantId: "p-gera", createdAt: at(3) }, messages), at(3));
  assert.equal(memberRunningSince("p-drew", messages), at(8));
  assert.equal(memberRunningSince("p-gera", messages), undefined);
});

test("the members panel lists every member but the main session; ended ones under Previous", () => {
  const messages = chat();
  const tasks = latestTaskByMember(messages);
  assert.equal(tasks.get("p-drew")?.messageId, "tasks");
  assert.equal(tasks.get("p-main")?.messageId, "drew-question", "the main session's own task (a member's question) is known too");
  const statuses = new Map([["p-drew", "running" as const], ["p-gera", "idle" as const]]);
  const rows = sessionsMemberRows(participants, "p-main", statuses, tasks);
  assert.deepEqual(rows.current.map((row) => [row.participant.handle, row.status]), [["drew", "running"], ["taylor", "idle"]]);
  assert.deepEqual(rows.previous.map((row) => [row.participant.handle, row.status]), [["gera", "done"]]);
});

test("with nobody running or waiting, the members panel lists every member directly: no Previous group", () => {
  const messages = chat();
  const answered = new Map([...latestTaskByMember(messages)].map(([id, task]) => [id, { ...task, item: { ...task.item, status: "answered" as const } }]));
  const rows = sessionsMemberRows(participants, "p-main", new Map(), answered);
  assert.deepEqual(rows.current.map((row) => [row.participant.handle, row.status]), [["drew", "done"], ["gera", "done"], ["taylor", "idle"]]);
  assert.deepEqual(rows.previous, []);
  // One member waiting for the User is enough for the grouping to return.
  const waiting = sessionsMemberRows(participants, "p-main", new Map([["p-taylor", "pending" as const]]), answered);
  assert.deepEqual(waiting.current.map((row) => row.participant.handle), ["taylor"]);
  assert.deepEqual(waiting.previous.map((row) => row.participant.handle), ["drew", "gera"]);
});

test("no turn-finished note is on the main timeline of the sessions view, the main session's own included", () => {
  const note = (id: string, participantId: string) => ({
    id, role: "system", content: "Done", createdAt: at(20), status: "done",
    metadata: { appMessageSource: "app_turn_finished_note", turnFinishedNote: { messageId: "gera-reply", participantId, participantLabel: "@x" } }
  }) as ChatMessage;
  const messages = [...chat(), note("note-gera", "p-gera"), note("note-main", "p-main")];
  const index = buildSessionsViewIndex(messages, "p-main");
  assert.equal(isSessionsHiddenTurnFinishedNote(messages.at(-2)!), true);
  assert.equal(isSessionsHiddenTurnFinishedNote(messages.at(-1)!), true);
  assert.equal(isSessionsHiddenTurnFinishedNote(messages[0]!), false);
  const main = mainTimelineMessages(messages, index).map((entry) => entry.id);
  assert.ok(!main.includes("note-main") && !main.includes("note-gera"));
});

test("a task card with several tasks counts the running ones, and never says members", () => {
  assert.equal(sessionsTaskGroupLabel(["running", "done", "running"]), "3 tasks · 2 running");
  assert.equal(sessionsTaskGroupLabel(["done", "failed"]), "2 tasks");
});

test("a scheduled task's wake-up of one member is part of that member's session, a wake-up of the main session stays on the timeline", () => {
  const wakeDrew = message("script-drew", "script", 50, { metadata: { askedParticipantIds: ["p-drew"] } as ChatMessage["metadata"] });
  const wakeMain = message("script-main", "script", 51, { metadata: { askedParticipantIds: ["p-main"] } as ChatMessage["metadata"] });
  const quiet = message("script-none", "script", 52);
  const messages = [wakeDrew, wakeMain, quiet];
  const index = buildSessionsViewIndex(messages, "p-main");
  assert.deepEqual(mainTimelineMessages(messages, index).map((entry) => entry.id), ["script-main", "script-none"]);
  assert.deepEqual(memberSessionMessages(messages, "p-drew", index).map((entry) => entry.id), ["script-drew"]);
});

test("the main session's answer to a member's question is in that member's session from its first token", () => {
  const question = message("drew-asks", "participant", 30, { participantId: "p-drew", metadata: { participantRequest: batch("b-ask", "p-drew", [item("p-main", "running", 30)]) } });
  const streaming = message("main-answering", "participant", 31, {
    participantId: "p-main", status: "pending", content: "Use the",
    metadata: { sourceMessageId: "drew-asks", participantRequestBatchId: "b-ask", runId: "r1" }
  });
  const ownTurn = message("main-own", "participant", 32, { participantId: "p-main", metadata: { sourceMessageId: "ask", runId: "r2" } });
  const messages = [...chat(), question, streaming, ownTurn];
  const index = buildSessionsViewIndex(messages, "p-main");
  assert.deepEqual(sessionsViewLane(streaming, index), { kind: "member", participantId: "p-drew" }, "no reply id yet: placed by the request it answers");
  assert.deepEqual(sessionsViewLane(ownTurn, index), { kind: "main" });
  assert.ok(memberSessionMessages(messages, "p-drew", index).some((entry) => entry.id === "main-answering"));
  assert.ok(!mainTimelineMessages(messages, index).some((entry) => entry.id === "main-answering"));
  const otherBatch = { ...streaming, id: "main-other", metadata: { ...streaming.metadata, participantRequestBatchId: "b-other" } };
  assert.deepEqual(sessionsViewLane(otherBatch, index), { kind: "main" }, "a message of another request is not placed by this one");
});

test("the main session's tasks are shown inside the reply of the turn that gave them", () => {
  const ask = message("ask-2", "user", 40, { metadata: { askedParticipantIds: ["p-main"] } });
  const reply = message("reply-2", "participant", 41, { participantId: "p-main", status: "pending", content: "", metadata: { sourceMessageId: "ask-2", runId: "r" } });
  const taskA = message("task-a", "participant", 42, { participantId: "p-main", metadata: { sourceMessageId: "ask-2", participantRequest: batch("ba", "p-main", [item("p-drew", "running", 42)]) } });
  const taskB = message("task-b", "participant", 43, { participantId: "p-main", metadata: { sourceMessageId: "ask-2", participantRequest: batch("bb", "p-main", [item("p-gera", "running", 43)]) } });
  const orphan = message("task-c", "participant", 44, { participantId: "p-main", metadata: { sourceMessageId: "elsewhere", participantRequest: batch("bc", "p-main", [item("p-taylor", "running", 44)]) } });
  const messages = [ask, reply, taskA, taskB, orphan];
  const index = buildSessionsViewIndex(messages, "p-main");
  const placement = sessionsTaskPlacement(mainTimelineMessages(messages, index), index);
  assert.deepEqual(placement.tasksByReplyId.get("reply-2")?.map((entry) => entry.id), ["task-a", "task-b"]);
  assert.deepEqual([...placement.placedTaskIds], ["task-a", "task-b"]);
  assert.ok(!placement.placedTaskIds.has("task-c"), "a task without its reply stays on its own");
});

test("a member no longer in the chat is a former member with a readable session", () => {
  const messages = chat();
  const current = participants.filter((entry) => entry.id !== "p-gera" && entry.id !== "p-drew");
  assert.deepEqual(sessionsFormerMembers(messages, current, "p-main").map((entry) => [entry.id, entry.handle]), [["p-drew", "drew"], ["p-gera", "gera"]]);
  assert.deepEqual(sessionsFormerMembers(messages, participants, "p-main"), []);
  assert.equal(sessionsFormerMemberStatus(undefined), "idle");
  assert.equal(sessionsFormerMemberStatus({ status: "answered", createdAt: at(1) }), "done");
  assert.equal(sessionsFormerMemberStatus({ status: "running", createdAt: at(1) }), "idle", "a gone member is not shown running");
});

test("a former member keeps the provider its newest task named, so its logo stays", () => {
  const messages = chat().map((message) => {
    const batch = message.metadata?.participantRequest;
    if (!batch) return message;
    return { ...message, metadata: { ...message.metadata, participantRequest: { ...batch, items: batch.items.map((item) =>
      item.targetParticipantId === "p-gera" ? { ...item, targetKind: "gemini-cli" as const } : item) } } };
  });
  const current = participants.filter((entry) => entry.id !== "p-gera" && entry.id !== "p-drew");
  assert.deepEqual(sessionsFormerMembers(messages, current, "p-main").map((entry) => [entry.id, entry.kind]), [["p-drew", undefined], ["p-gera", "gemini-cli"]],
    "a task given before the provider was recorded leaves it unknown");
});

test("a stopped task's row says Stopped, muted", () => {
  const messages = chat();
  const byId = new Map(messages.map((entry) => [entry.id, entry]));
  const tasks = messages[3]!;
  const batch = tasks.metadata!.participantRequest!;
  const stopped = { ...batch, items: batch.items.map((item) => ({ ...item, status: "interrupted" as const, error: "Stopped by User." })) };
  const entries = sessionsTaskEntries(tasks, stopped, new Map(), sessionsMemberActivity(messages), byId);
  assert.deepEqual(entries.map((entry) => [entry.status, entry.line, entry.lineMuted]), [["stopped", "Stopped", true], ["stopped", "Stopped", true]]);
});

test("members are named by their task, not their handle", () => {
  assert.equal(sessionsMemberTitle({ handle: "drew" }, { prompt: "## Fix the login\n\nmore", targetHandle: "drew" }), "Fix the login");
  assert.equal(sessionsMemberTitle({ handle: "@drew" }), "drew");
  assert.equal(sessionsMemberDetail({ provider: "Claude Code", model: "opus", roleLabel: "Member", roleConfigId: "generic-participant" }), "Claude Code · opus");
  assert.equal(sessionsMemberDetail({ provider: "Codex CLI", roleLabel: "Reviewer", roleConfigId: "reviewer" }), "Codex CLI · Reviewer");
  assert.equal(sessionsWaitingText(["Fix the login", "Check logout"]), "Waiting on 2 tasks: Fix the login, Check logout");
  assert.equal(sessionsDelegationSummary(1), "Delegated 1 task");
  assert.equal(sessionsDelegationSummary(3), "Delegated 3 tasks");
  assert.equal(withoutLeadingMention("@main Reply to me", "main"), "Reply to me");
  assert.equal(withoutLeadingMention("@mainframe is down", "main"), "@mainframe is down");
  assert.equal(withoutLeadingMention("@main", "main"), "@main", "nothing left: the text stays");
});

test("a task is named by its short title: the main session's, else its first sentence cut at a word", () => {
  const task = "Назови столицу Италии. Ответь ровно одним словом, без пояснений и пунктуации.";
  // The main session's own title wins, its whitespace tidied.
  assert.equal(sessionsTaskTitle({ prompt: task, title: "  Столица\n Италии " }), "Столица Италии");
  assert.equal(sessionsMemberTitle({ handle: "claude" }, { prompt: task, targetHandle: "claude", title: "Столица Италии" }), "Столица Италии");
  // Without one: the first sentence, without its full stop.
  assert.equal(sessionsTaskTitle({ prompt: task }), "Назови столицу Италии");
  assert.equal(sessionsTaskTitle({ prompt: "Which database did User pick? Answer in one word." }), "Which database did User pick?");
  assert.equal(sessionsTaskTitle({ prompt: "Review src/app.ts and report the bugs" }), "Review src/app.ts and report the bugs", "a dot inside a word ends no sentence");
  // A long sentence is cut at a word, 40 characters with its "…".
  const long = sessionsTaskTitle({ prompt: "Check the server logs for every failed login attempt since Monday and group them by reason." });
  assert.equal(long, "Check the server logs for every failed…");
  assert.ok(long.length <= 40);
  assert.equal(sessionsTaskTitle({ prompt: "## Fix the **login** button\nwith the new tokens" }), "Fix the login button", "markdown left out");
  assert.equal(sessionsTaskTitle({ prompt: "" }), "");
  assert.equal(sessionsMemberTitle({ handle: "@drew" }, { prompt: "", targetHandle: "drew" }), "drew", "a task without text leaves the handle");
  // One word longer than the room is cut inside it.
  assert.equal(shortenAtWord("x".repeat(60), 40), `${"x".repeat(39)}…`);
  assert.equal(shortenAtWord("Short enough", 40), "Short enough");
  // A given title is kept to 80 characters.
  assert.ok(sessionsTaskTitle({ prompt: "x", title: "word ".repeat(40) }).length <= 80);
});

test("a task entry carries its title, its state, its time and one line of its result", () => {
  const messages = chat();
  const byId = new Map(messages.map((entry) => [entry.id, entry]));
  const tasks = messages[3]!;
  const entries = sessionsTaskEntries(tasks, tasks.metadata!.participantRequest!, new Map([["p-drew", "running" as const]]), sessionsMemberActivity(messages), byId);
  assert.deepEqual(entries.map((entry) => [entry.item.targetParticipantId, entry.title, entry.status, entry.since, entry.line]), [
    ["p-drew", "Task for drew", "running", at(8), undefined],
    ["p-gera", "Task for gera", "done", undefined, "Done: the token refresh is fixed"]
  ]);
  assert.equal(entries[1]!.durationMs, 0);
});

test("the member-added card of the main session's delegation is not shown; cards that need the User stay", () => {
  const added = { status: "auto-applied" as const, toolName: "app_participants_request_change", requesterParticipantId: "p-main", request: { operations: [{ type: "add_new_participant_to_chat" }] } } as Parameters<typeof isMainSessionDelegationRosterCard>[0];
  assert.equal(isMainSessionDelegationRosterCard(added, "p-main"), true);
  assert.equal(isMainSessionDelegationRosterCard({ ...added, status: "pending" }, "p-main"), false, "waits for the User");
  assert.equal(isMainSessionDelegationRosterCard({ ...added, requesterParticipantId: "p-drew" }, "p-main"), false, "another member's change");
  assert.equal(isMainSessionDelegationRosterCard({ ...added, request: { operations: [{ type: "remove_participant_from_chat" }] } } as typeof added, "p-main"), false, "a removal");
});

test("a member's handle is its chip only as an exact @handle of a current or former member; everything else stays as written", () => {
  const members = new Set(["gera", "drew-2"]);
  const isMember = (key: string): boolean => members.has(key);
  const pieces = (text: string) => sessionsMentionPieces(text, isMember);
  assert.deepEqual(pieces("Asked @gera and @Drew-2, then @main and @nobody."), [
    { text: "Asked " }, { handle: "gera" }, { text: " and " }, { handle: "Drew-2" }, { text: ", then @main and @nobody." }
  ], "members by their handle in any case; the main session and nobody as written");
  assert.deepEqual(sessionsMentionPieces("@main ping @gera", isMember, (key) => key === "main"), [
    { text: "main" }, { text: " ping " }, { handle: "gera" }
  ], "the main session's handle is a plain word without its @ (the sessions view has no handles)");
  assert.deepEqual(pieces("@gera"), [{ handle: "gera" }]);
  assert.deepEqual(pieces("ask @gera now"), [{ text: "ask " }, { handle: "gera" }, { text: " now" }]);
  assert.deepEqual(pieces("(@gera), @gera: @gera."), [{ text: "(" }, { handle: "gera" }, { text: "), " }, { handle: "gera" }, { text: ": " }, { handle: "gera" }, { text: "." }]);
  for (const asWritten of [
    "npm i @gera/node", // a package name
    "node_modules/@gera", // a path
    "mail me at me@gera", // an e-mail address
    "@@gera", "x.@gera", "a-@gera",
    "@gera_x and @gerah", // a longer word
    "@gera-", // a longer handle
    `@${"g".repeat(33)}` // longer than a handle
  ]) {
    assert.deepEqual(pieces(asWritten), [{ text: asWritten }], asWritten);
  }
  members.add("g".repeat(32));
  assert.deepEqual(pieces(`@${"g".repeat(32)}`), [{ handle: "g".repeat(32) }], "a 32-character handle is one");
  assert.deepEqual(pieces(`@${"g".repeat(33)}`), [{ text: `@${"g".repeat(33)}` }], "33 is not");
  assert.deepEqual(pieces(""), []);
});
