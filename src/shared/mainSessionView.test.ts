import assert from "node:assert/strict";
import test from "node:test";

import { buildSessionsViewIndex, isMainSessionTaskMessage, mainTimelineMessages, memberSessionMessages, membersMainSessionWaitsOn } from "./mainSession";
import {
  firstTextLine,
  latestTaskByMember,
  memberRunningSince,
  openMemberCardMessages,
  sessionsMemberRows,
  sessionsMemberStatus,
  sessionsTaskGroupLabel,
  sessionsTaskReplyLine,
  sessionsTaskRunningSince,
  sessionsTaskStatus
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
  assert.equal(sessionsTaskStatus({ status: "running" }, "running"), "running");
  assert.equal(sessionsTaskStatus({ status: "running" }, "pending"), "waiting", "the member waits on the User's card");
  assert.equal(sessionsTaskStatus({ status: "pending_approval" }), "waiting");
  assert.equal(sessionsTaskStatus({ status: "answered" }), "done");
  assert.equal(sessionsTaskStatus({ status: "resuming_requester" }), "done");
  assert.equal(sessionsTaskStatus({ status: "completed" }), "done");
  assert.equal(sessionsTaskStatus({ status: "failed" }), "failed");
  assert.equal(sessionsTaskStatus({ status: "denied" }), "failed");
  assert.equal(sessionsTaskStatus({ status: "interrupted" }), "stopped");
  assert.equal(sessionsTaskStatus({ status: "running" }, "stopped"), "stopped");
  assert.equal(sessionsTaskStatus({ status: "running" }, "error"), "failed");
});

test("a member's status is what it does now, else how its latest task ended", () => {
  assert.equal(sessionsMemberStatus("running", { status: "completed" }), "running");
  assert.equal(sessionsMemberStatus("background", undefined), "running");
  assert.equal(sessionsMemberStatus("pending", undefined), "waiting");
  assert.equal(sessionsMemberStatus("idle", { status: "completed" }), "done");
  assert.equal(sessionsMemberStatus(undefined, undefined), "idle");
  assert.equal(sessionsMemberStatus("error", { status: "running" }), "failed");
});

test("the result line is the reply's first line without markdown or a choice block", () => {
  const messages = chat();
  const byId = new Map(messages.map((entry) => [entry.id, entry]));
  assert.equal(sessionsTaskReplyLine({ replyMessageId: "gera-reply" }, byId), "Done: the token refresh is fixed");
  assert.equal(sessionsTaskReplyLine({ replyMessageId: "drew-running" }, byId), undefined, "no line while the reply streams");
  assert.equal(sessionsTaskReplyLine({}, byId), undefined);
  assert.equal(firstTextLine("\n\n- **Bold** item `code`"), "Bold item code");
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

test("a task card with several members counts the running ones", () => {
  assert.equal(sessionsTaskGroupLabel(["running", "done", "running"]), "3 members · 2 running");
  assert.equal(sessionsTaskGroupLabel(["done", "failed"]), "2 members");
});
