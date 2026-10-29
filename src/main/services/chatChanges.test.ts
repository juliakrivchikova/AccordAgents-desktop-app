import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage, Conversation } from "../../shared/types";
import { chatChangeBaseline, diffChatChanges, isSafeChatId, type ChatChangeDiffPolicy } from "./chatChanges";

const NOW = "2026-09-24T12:00:00.000Z";

function chat(patch: Partial<Conversation> = {}): Conversation {
  return {
    id: "chat-1",
    title: "Plan",
    kind: "chat",
    createdAt: NOW,
    updatedAt: NOW,
    repoPath: "/repo",
    messages: [
      { id: "m1", role: "user", content: "Hello", createdAt: "2026-09-24T12:00:01.000Z", status: "done" },
      { id: "m2", role: "participant", participantId: "local", content: "Hi", createdAt: "2026-09-24T12:00:02.000Z", status: "done" }
    ],
    findings: [],
    metadata: {
      participants: [
        { id: "local", handle: "taylor", kind: "claude-cli" },
        { id: "remote", handle: "drew", kind: "codex-cli", homeMachineId: "machine-1" }
      ],
      participantSessions: [{ participantId: "local", sessionId: "s-1" }],
      running: false,
      warnings: []
    },
    ...patch
  } as Conversation;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const desktop: ChatChangeDiffPolicy = {
  emitsConversationFields: true,
  ownsMessage: (message) => !(message.role === "participant" && message.participantId === "remote") && !message.metadata?.["remoteAuthorOriginId" as never]
};

test("a chat the database does not hold yet is announced once, with every message", () => {
  const { changes } = diffChatChanges(undefined, chat(), desktop);
  assert.deepEqual(changes.map((change) => change.type), ["conversation.created", "message.created", "message.created"]);
  const created = changes[0] as Extract<typeof changes[number], { type: "conversation.created" }>;
  assert.equal(created.conversation.title, "Plan");
  assert.ok(Array.isArray(created.conversation.metadata.participants));
  assert.equal(created.conversation.metadata.participantSessions, undefined, "sessions are this device's own");
  assert.equal(created.conversation.metadata.running, undefined);
});

test("after a restart the diff is against the database: one new message is one change, not the whole chat", () => {
  const stored = chat();
  const baseline = chatChangeBaseline(clone(stored));
  const next = clone(stored);
  next.messages.push({ id: "m3", role: "user", content: "More", createdAt: "2026-09-24T12:00:03.000Z", status: "done" });
  const { changes } = diffChatChanges(baseline, next, desktop);
  assert.deepEqual(changes.map((change) => [change.type, "message" in change ? change.message.id : ""]), [["message.created", "m3"]]);
});

test("device-local bookkeeping produces no change", () => {
  const stored = chat();
  const baseline = chatChangeBaseline(clone(stored));
  const next = clone(stored);
  next.metadata.running = true;
  next.metadata.activeRunIds = ["run-1"];
  next.metadata.participantSessions = [{ participantId: "local", sessionId: "s-2" }];
  next.messages[1] = { ...next.messages[1], metadata: { executionLease: { holderId: "desktop" }, queuedBehind: "x" } as never };
  assert.deepEqual(diffChatChanges(baseline, next, desktop).changes, []);
});

test("a content change to a message another device owns stays local", () => {
  const stored = chat();
  stored.messages.push({ id: "m3", role: "participant", participantId: "remote", content: "", createdAt: "2026-09-24T12:00:03.000Z", status: "pending" });
  const baseline = chatChangeBaseline(clone(stored));
  const next = clone(stored);
  next.messages[2] = { ...next.messages[2], status: "error", content: "Interrupted before completion." };
  const diff = diffChatChanges(baseline, next, desktop);
  assert.deepEqual(diff.changes, []);
  assert.deepEqual(diff.suppressedMessageIds, ["m3"]);
});

test("an owned content change travels without reactions", () => {
  const stored = chat();
  const baseline = chatChangeBaseline(clone(stored));
  const next = clone(stored);
  next.messages[1] = { ...next.messages[1], content: "Hi there", metadata: { reactions: { "👍": [{ actorId: "user", actorLabel: "User", actorKind: "user", at: NOW }] } } };
  const { changes } = diffChatChanges(baseline, next, desktop);
  assert.deepEqual(changes.map((change) => change.type), ["message.updated", "message.reactions"]);
  const updated = changes[0] as Extract<typeof changes[number], { type: "message.updated" }>;
  assert.equal(updated.message.content, "Hi there");
  assert.equal(updated.message.metadata?.reactions, undefined);
});

test("a removal is one change, sent once", () => {
  const stored = chat();
  const baseline = chatChangeBaseline(clone(stored));
  const next = clone(stored);
  next.metadata.removedChatMessageIds = ["m2"];
  next.messages = next.messages.filter((message) => message.id !== "m2");
  assert.deepEqual(diffChatChanges(baseline, next, desktop).changes, [{ type: "message.removed", messageId: "m2" }]);
  assert.deepEqual(diffChatChanges(chatChangeBaseline(clone(next)), next, desktop).changes, [], "not again on the next save");
});

test("the chat's own fields go only from a device that writes them", () => {
  const stored = chat();
  const baseline = chatChangeBaseline(clone(stored));
  const next = clone(stored);
  next.title = "Renamed";
  next.metadata.archived = true;
  assert.deepEqual(diffChatChanges(baseline, next, desktop).changes, [{ type: "conversation.updated", title: "Renamed", metadata: { archived: true } }]);
  assert.deepEqual(diffChatChanges(baseline, next, { ...desktop, emitsConversationFields: false }).changes, []);
});

test("a chat id from another device is a plain token, never a path", () => {
  assert.equal(isSafeChatId("chat-1"), true);
  assert.equal(isSafeChatId("../../.."), false);
  assert.equal(isSafeChatId("chat/1"), false);
  assert.equal(isSafeChatId(undefined), false);
});
