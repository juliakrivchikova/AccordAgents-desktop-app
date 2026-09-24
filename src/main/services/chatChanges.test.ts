import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage, Conversation } from "../../shared/types";
import {
  applyChatChanges,
  chatChangeBaseline,
  diffChatChanges,
  isChatChangesPayload,
  type ChatChangeApplyPolicy,
  type ChatChangeDiffPolicy,
  type ChatChangesPayload
} from "./chatChanges";

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

const machinePolicy: ChatChangeApplyPolicy = {
  acceptsConversationFields: (origin) => origin === "desktop",
  acceptsMessageUpdate: (existing, _conversation, origin) => {
    if (existing.role === "participant" && existing.participantId === "remote") return false;
    if (existing.role === "participant") return origin === "desktop";
    return origin === (existing.metadata as Record<string, unknown> | undefined)?.remoteAuthorOriginId;
  }
};

function payload(changes: ChatChangesPayload["changes"], updatedAt = NOW): ChatChangesPayload {
  return { version: 1, conversationId: "chat-1", updatedAt, changes };
}

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

test("reactions from two devices merge instead of overwriting each other", () => {
  let copy = applyChatChanges(undefined, payload(diffChatChanges(undefined, chat(), desktop).changes), "desktop", machinePolicy);
  assert.equal(copy.status, "applied");
  const user = { actorId: "user", actorLabel: "User", actorKind: "user" as const, at: NOW };
  const bot = { actorId: "remote", actorLabel: "@drew", actorKind: "participant" as const, at: NOW };
  copy = applyChatChanges(copy.status === "applied" ? copy.conversation : undefined,
    payload([{ type: "message.reactions", messageId: "m2", added: [{ emoji: "👍", reactor: user }], removed: [] }]), "desktop", machinePolicy);
  copy = applyChatChanges(copy.status === "applied" ? copy.conversation : undefined,
    payload([{ type: "message.reactions", messageId: "m2", added: [{ emoji: "👍", reactor: bot }], removed: [] }]), "machine", machinePolicy);
  assert.equal(copy.status, "applied");
  const reactors = copy.status === "applied" ? copy.conversation.messages.find((message) => message.id === "m2")?.metadata?.reactions?.["👍"] : [];
  assert.deepEqual(reactors?.map((reactor) => reactor.actorId).sort(), ["remote", "user"]);
});

test("removal is a union: a removed message does not come back when its creation arrives late", () => {
  const stored = chat();
  const baseline = chatChangeBaseline(clone(stored));
  const next = clone(stored);
  next.metadata.removedChatMessageIds = ["m2"];
  next.messages = next.messages.filter((message) => message.id !== "m2");
  const { changes } = diffChatChanges(baseline, next, desktop);
  assert.deepEqual(changes, [{ type: "message.removed", messageId: "m2" }]);
  let copy = applyChatChanges(clone(stored), payload(changes), "desktop", machinePolicy);
  assert.equal(copy.status, "applied");
  copy = applyChatChanges(copy.status === "applied" ? copy.conversation : undefined,
    payload([{ type: "message.created", message: clone(stored.messages[1]) }]), "desktop", machinePolicy);
  assert.deepEqual(copy.status === "applied" ? copy.conversation.messages.map((message) => message.id) : [], ["m1"]);
});

test("the chat's own fields change only from the desktop, and only on a device that accepts them", () => {
  const stored = chat();
  const baseline = chatChangeBaseline(clone(stored));
  const next = clone(stored);
  next.title = "Renamed";
  next.metadata.archived = true;
  const fromDesktop = diffChatChanges(baseline, next, desktop).changes;
  assert.deepEqual(fromDesktop, [{ type: "conversation.updated", title: "Renamed", metadata: { archived: true } }]);
  assert.deepEqual(diffChatChanges(baseline, next, { ...desktop, emitsConversationFields: false }).changes, []);
  const fromMachine = applyChatChanges(clone(stored), payload(fromDesktop), "machine", machinePolicy);
  assert.equal(fromMachine.status === "applied" ? fromMachine.conversation.title : "", "Plan");
  const accepted = applyChatChanges(clone(stored), payload(fromDesktop), "desktop", machinePolicy);
  assert.equal(accepted.status === "applied" ? accepted.conversation.title : "", "Renamed");
  assert.equal(accepted.status === "applied" ? accepted.conversation.metadata.archived : undefined, true);
});

test("a change for a chat this device does not have is held, and a created chat keeps its local state separate", () => {
  assert.deepEqual(applyChatChanges(undefined, payload([{ type: "message.created", message: chat().messages[0] }]), "desktop", machinePolicy),
    { status: "missing-conversation" });
  const created = applyChatChanges(undefined, payload(diffChatChanges(undefined, chat(), desktop).changes), "desktop", machinePolicy);
  assert.equal(created.status, "applied");
  if (created.status !== "applied") return;
  assert.deepEqual(created.conversation.metadata.participantSessions, []);
  assert.equal(created.conversation.metadata.running, false);
  assert.deepEqual(created.conversation.messages.map((message) => message.id), ["m1", "m2"]);
  assert.equal((created.conversation.messages[0].metadata as Record<string, unknown>).remoteAuthorOriginId, "desktop");
});

test("only the owner may change a message's content, and this device's own bookkeeping survives the update", () => {
  const stored = chat();
  const pending: ChatMessage = { id: "m3", role: "participant", participantId: "remote", content: "", createdAt: "2026-09-24T12:00:03.000Z", status: "pending",
    metadata: { runId: "run-1", queuedBehind: "run-0" } as never };
  stored.messages.push(pending);
  const desktopPolicy: ChatChangeApplyPolicy = {
    acceptsConversationFields: () => false,
    acceptsMessageUpdate: (existing, _conversation, origin) => existing.participantId === "remote" && origin === "machine"
  };
  const reply = { ...pending, content: "Done", status: "done" as const, metadata: { runId: "run-1" } };
  const fromDesktop = applyChatChanges(clone(stored), payload([{ type: "message.updated", message: reply }]), "desktop", desktopPolicy);
  assert.equal(fromDesktop.status === "applied" ? fromDesktop.conversation.messages[2].content : "x", "");
  const fromMachine = applyChatChanges(clone(stored), payload([{ type: "message.updated", message: reply }]), "machine", desktopPolicy);
  assert.equal(fromMachine.status, "applied");
  if (fromMachine.status !== "applied") return;
  assert.equal(fromMachine.conversation.messages[2].content, "Done");
  assert.equal((fromMachine.conversation.messages[2].metadata as Record<string, unknown>).queuedBehind, "run-0");
  // The same event twice changes nothing more.
  const again = applyChatChanges(clone(fromMachine.conversation), payload([{ type: "message.updated", message: reply }]), "machine", desktopPolicy);
  assert.deepEqual(again.status === "applied" ? again.conversation.messages : [], fromMachine.conversation.messages);
});

test("messages are kept in creation order whatever order they arrive in", () => {
  const base = applyChatChanges(undefined, payload(diffChatChanges(undefined, chat(), desktop).changes), "desktop", machinePolicy);
  const late = applyChatChanges(base.status === "applied" ? base.conversation : undefined, payload([
    { type: "message.created", message: { id: "m0", role: "user", content: "Earlier", createdAt: "2026-09-24T11:59:59.000Z", status: "done" } }
  ]), "machine", machinePolicy);
  assert.deepEqual(late.status === "applied" ? late.conversation.messages.map((message) => message.id) : [], ["m0", "m1", "m2"]);
});

test("the payload guard rejects unknown shapes", () => {
  assert.equal(isChatChangesPayload(payload([])), true);
  assert.equal(isChatChangesPayload({ ...payload([]), version: 2 }), false);
  assert.equal(isChatChangesPayload({ ...payload([]), changes: [{ type: "message.exploded" }] }), false);
  assert.equal(isChatChangesPayload(undefined), false);
});
