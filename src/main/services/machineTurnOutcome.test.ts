import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatMessage } from "../../shared/types";
import { advanceInstanceSequence, foldMachineTurnResult, isStoredTerminal } from "./machineTurnOutcome";

function bubble(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "pending-1",
    role: "participant",
    participantId: "p1",
    participantLabel: "@bot",
    content: "",
    createdAt: "2026-09-06T00:00:00.000Z",
    status: "pending",
    metadata: { runId: "run-1", stopPending: { machineName: "Box", at: "2026-09-06T00:00:01.000Z" } },
    ...overrides
  } as ChatMessage;
}

function reply(content: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { ...bubble({ content, status: "done", metadata: { runId: "run-1", activityEvents: [] } }), ...overrides } as ChatMessage;
}

test("a completed result folds the machine's bubble and returns the other messages", () => {
  const target = bubble();
  const extra = { ...reply("note"), id: "note-1" } as ChatMessage;
  const others = foldMachineTurnResult(target, "bot", "run-1", { status: "completed", messages: [reply("hello"), extra] });
  assert.equal(target.status, "done");
  assert.equal(target.content, "hello");
  assert.equal(target.metadata?.stopPending, undefined);
  assert.deepEqual(others.map((message) => message.id), ["note-1"]);
});

test("an interrupted result keeps the machine's partial text and the run's other messages", () => {
  const target = bubble();
  const others = foldMachineTurnResult(target, "bot", "run-1", { status: "interrupted", messages: [reply("half an answer"), { ...reply("tool note"), id: "note-2" } as ChatMessage] });
  assert.equal(target.status, "error");
  assert.equal(target.content, "half an answer");
  assert.equal(target.metadata?.terminalReason, "user-stopped");
  assert.deepEqual(others.map((message) => message.id), ["note-2"]);
});

test("a failed result keeps the delivered text and records the failure, never as a stop", () => {
  const target = bubble({ content: "streamed so far" });
  foldMachineTurnResult(target, "bot", "run-1", { status: "failed", messages: [], error: "provider exited" });
  assert.equal(target.status, "error");
  assert.match(target.content, /^streamed so far\n\n@bot failed on its machine: provider exited$/);
  assert.equal(target.metadata?.terminalReason, undefined);
});

test("an unconfirmed stop is marked as such, not as stopped by user", () => {
  const target = bubble({ content: "text" });
  foldMachineTurnResult(target, "bot", "run-1", { status: "unconfirmed", messages: [], error: "machine restarted" });
  assert.equal(target.metadata?.terminalReason, "stop-unconfirmed");
  assert.match(target.content, /Stop not confirmed for @bot/);
  assert.match(target.content, /machine restarted/);
});

test("the instance counter advances past both the stored value and the clock, and is not published on any file error", () => {
  let stored = JSON.stringify({ sequence: 1000 });
  const io = { read: () => stored, write: (content: string) => { stored = content; }, now: () => 100 };
  assert.deepEqual(advanceInstanceSequence(io), { sequence: 1001 });
  assert.deepEqual(advanceInstanceSequence({ ...io, now: () => 5000 }), { sequence: 5000 });
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  assert.deepEqual(advanceInstanceSequence({ ...io, read: () => { throw missing; }, now: () => 42 }), { sequence: 42 });
  assert.equal(advanceInstanceSequence({ ...io, read: () => "not json" }).sequence, undefined);
  const denied = Object.assign(new Error("EACCES"), { code: "EACCES" });
  assert.equal(advanceInstanceSequence({ ...io, read: () => { throw denied; } }).sequence, undefined);
  assert.equal(advanceInstanceSequence({ ...io, write: () => { throw new Error("ENOSPC"); } }).sequence, undefined);
});

test("outbox entries are accepted only with the full expected shape", () => {
  const good = {
    type: "machine.turn.finished", runId: "r", conversationId: "c", participantId: "p", status: "completed",
    messages: [{ id: "m", role: "participant", content: "x", createdAt: "2026-09-06T00:00:00.000Z" }], warnings: ["w"], finishedAt: "2026-09-06T00:00:00.000Z"
  };
  assert.equal(isStoredTerminal(good), true);
  assert.equal(isStoredTerminal({ ...good, status: "weird" }), false);
  assert.equal(isStoredTerminal({ ...good, messages: [{ id: "m" }] }), false);
  assert.equal(isStoredTerminal({ ...good, warnings: [1] }), false);
  assert.equal(isStoredTerminal({ ...good, runId: "" }), false);
});
