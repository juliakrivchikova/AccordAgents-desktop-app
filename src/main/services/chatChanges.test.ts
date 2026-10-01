import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage, Conversation } from "../../shared/types";
import { createChatChangeTransport } from "./chatChangeTransport";
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
  },
  acceptsMessageCreate: (message, _conversation, origin) => message.role !== "participant" || origin === "desktop" ||
    (message.participantId === "remote" && origin === "machine"),
  acceptsMessageRemoval: (existing, _conversation, origin) => origin === "desktop" ||
    (existing !== undefined && origin === (existing.metadata as Record<string, unknown> | undefined)?.remoteAuthorOriginId),
  holdsUnknownChats: true
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
    acceptsMessageUpdate: (existing, _conversation, origin) => existing.participantId === "remote" && origin === "machine",
    acceptsMessageCreate: (message, _conversation, origin) => message.role !== "participant" || (message.participantId === "remote" && origin === "machine"),
    acceptsMessageRemoval: (existing, _conversation, origin) => existing?.participantId === "remote" && origin === "machine",
    holdsUnknownChats: false
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

test("the payload guard takes a safe chat id and a list; each change is checked when applied", () => {
  assert.equal(isChatChangesPayload(payload([])), true);
  assert.equal(isChatChangesPayload({ ...payload([]), version: 2 }), true, "a newer peer's event is folded as far as this device understands it");
  assert.equal(isChatChangesPayload({ ...payload([]), conversationId: "../../.." }), false, "a chat id names a directory");
  assert.equal(isChatChangesPayload({ ...payload([]), conversationId: "chat/1" }), false);
  assert.equal(isChatChangesPayload(undefined), false);
  const applied = applyChatChanges(clone(chat()), payload([
    { type: "message.exploded" } as never,
    { type: "message.reactions", messageId: "m1", added: [{ emoji: "x", reactor: null }], removed: [] } as never,
    { type: "message.created", message: { id: "m9", role: "user", content: "kept", createdAt: "2026-09-24T12:00:09.000Z", status: "done" } }
  ]), "desktop", machinePolicy);
  assert.equal(applied.status, "applied");
  if (applied.status !== "applied") return;
  assert.deepEqual(applied.ignored, ["invalid:message.exploded", "invalid:message.reactions"]);
  assert.ok(applied.conversation.messages.some((message) => message.id === "m9"), "the valid change still applies");
});

test("only the device allowed to set a chat's shared fields can create it, and it brings shared fields only", () => {
  const forged = chat();
  forged.metadata.participantWatchers = { local: { lastSeenMessageId: "x" } } as never;
  forged.metadata.pendingAppToolApprovals = [{ id: "a" }] as never;
  const changes = diffChatChanges(undefined, forged, desktop).changes;
  const refused = applyChatChanges(undefined, payload(changes), "machine", machinePolicy);
  assert.equal(refused.status, "missing-conversation", "a machine waits for the desktop's chat instead");
  const onDesktop = applyChatChanges(undefined, payload(changes), "machine", {
    acceptsConversationFields: () => false, acceptsMessageUpdate: () => false, acceptsMessageCreate: () => true, acceptsMessageRemoval: () => false, holdsUnknownChats: false
  });
  assert.equal(onDesktop.status, "ignored", "the desktop never takes a chat from a machine");
  const created = applyChatChanges(undefined, payload(changes), "desktop", machinePolicy);
  assert.equal(created.status, "applied");
  if (created.status !== "applied") return;
  assert.equal(created.conversation.metadata.participantWatchers, undefined);
  assert.equal(created.conversation.metadata.pendingAppToolApprovals, undefined);
  assert.equal(created.conversation.kind, "chat");
});

test("a member's message is added only by where it runs or by the desktop, and removal needs the same right", () => {
  const stored = chat();
  const reply: ChatMessage = { id: "r1", role: "participant", participantId: "local", content: "forged", createdAt: "2026-09-24T12:00:05.000Z", status: "done" };
  const forged = applyChatChanges(clone(stored), payload([{ type: "message.created", message: reply }]), "machine", machinePolicy);
  assert.deepEqual(forged.status === "applied" ? forged.ignored : [], ["message.created:r1"]);
  const own = applyChatChanges(clone(stored), payload([{ type: "message.created", message: { ...reply, participantId: "remote" } }]), "machine", machinePolicy);
  assert.ok(own.status === "applied" && own.conversation.messages.some((message) => message.id === "r1"));
  const removal = applyChatChanges(clone(stored), payload([{ type: "message.removed", messageId: "m1" }]), "machine", machinePolicy);
  assert.deepEqual(removal.status === "applied" ? removal.ignored : [], ["message.removed:m1"]);
  assert.ok(removal.status === "applied" && removal.conversation.messages.some((message) => message.id === "m1"), "the User's message stays");
});

test("a reaction that arrives before its message is kept and applied when the message comes", () => {
  const user = { actorId: "user", actorLabel: "User", actorKind: "user" as const, at: NOW };
  const early = applyChatChanges(clone(chat()), payload([{ type: "message.reactions", messageId: "r9", added: [{ emoji: "ok", reactor: user }], removed: [] }]), "desktop", machinePolicy);
  assert.equal(early.status, "applied");
  const reply = applyChatChanges(early.status === "applied" ? early.conversation : undefined, payload([{ type: "message.created",
    message: { id: "r9", role: "participant", participantId: "remote", content: "Done", createdAt: "2026-09-24T12:00:05.000Z", status: "done" } }]), "machine", machinePolicy);
  assert.equal(reply.status, "applied");
  if (reply.status !== "applied") return;
  assert.deepEqual(reply.conversation.messages.find((message) => message.id === "r9")?.metadata?.reactions?.ok?.map((reactor) => reactor.actorId), ["user"]);
  assert.equal((reply.conversation.metadata as Record<string, unknown>).pendingChatReactions, undefined);
});

test("the transport's rules: no member message without a member, and the desktop settles a turn it never sent", () => {
  const unused = {} as never;
  const desktop = createChatChangeTransport({ role: "desktop", storage: unused, log: unused, recipients: () => [],
    machineOriginId: (machineId) => (machineId === "machine-1" ? "machine" : undefined) });
  const machine = createChatChangeTransport({ role: "machine", storage: unused, log: unused, recipients: () => [],
    hostMachineId: () => "machine-1", desktopOriginId: () => "desktop" });
  const stored = chat();
  const anonymous: ChatMessage = { id: "x", role: "participant", content: "who wrote this?", createdAt: NOW, status: "done" };
  assert.equal(desktop.applyPolicy(stored).acceptsMessageCreate(anonymous, stored, "machine"), false);
  assert.equal(machine.applyPolicy(stored).acceptsMessageCreate(anonymous, stored, "desktop"), true, "only the desktop may");

  const bubble: ChatMessage = { id: "b", role: "participant", participantId: "remote", content: "", createdAt: NOW, status: "pending" };
  const settled: ChatMessage = { ...bubble, status: "error", content: "@drew stopped by user.", metadata: { machineTurnNotSent: true } };
  assert.equal(machine.applyPolicy(stored).acceptsMessageUpdate(bubble, stored, "desktop", settled), true);
  assert.equal(machine.applyPolicy(stored).acceptsMessageUpdate(bubble, stored, "desktop", { ...settled, metadata: {} }), false,
    "a turn the machine runs stays the machine's");
  assert.equal(desktop.diffPolicy(stored).ownsMessage(settled), true);
  assert.equal(machine.diffPolicy(stored).ownsMessage(settled), false);
  assert.equal(desktop.applyPolicy(stored).acceptsMessageUpdate(settled, stored, "machine", { ...settled, content: "Interrupted" }), false);
});
