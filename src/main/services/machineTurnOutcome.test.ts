import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatMessage } from "../../shared/types";
import { advanceInstanceSequence, markStopUnconfirmed, markStoppedByUser } from "./machineTurnOutcome";

function bubble(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "pending-1",
    role: "participant",
    participantId: "p1",
    participantLabel: "@bot",
    content: "",
    createdAt: "2026-09-06T00:00:00.000Z",
    status: "pending",
    metadata: { runId: "turn-run-1" },
    ...overrides
  } as ChatMessage;
}

test("a stop the member's machine confirmed reads as stopped by the User, keeping what it had written", () => {
  const empty = bubble();
  markStoppedByUser(empty, "bot");
  assert.equal(empty.status, "error");
  assert.equal(empty.content, "@bot stopped by user.");
  assert.equal(empty.metadata?.terminalReason, "user-stopped");
  const partial = bubble({ content: "half an answer" });
  markStoppedByUser(partial, "bot", { preserveContent: true });
  assert.equal(partial.content, "half an answer");
});

test("a stop its machine never confirmed (it restarted meanwhile) says so once, never as stopped by the User", () => {
  const target = bubble({ content: "half an answer" });
  markStopUnconfirmed(target, "bot", "The machine restarted before confirming the stop.");
  markStopUnconfirmed(target, "bot", "The machine restarted before confirming the stop.");
  assert.equal(target.status, "error");
  assert.equal(target.metadata?.terminalReason, "stop-unconfirmed");
  assert.match(target.content, /^half an answer\n\nStop not confirmed for @bot: the machine did not confirm the run is gone\. The machine restarted before confirming the stop\.$/);
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
