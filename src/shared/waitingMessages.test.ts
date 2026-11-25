import assert from "node:assert/strict";
import test from "node:test";
import { isWaitingReply, runningReplyOf, waitingMessages } from "./waitingMessages";
import type { ChatMessage } from "./types";

const message = (id: string, role: ChatMessage["role"], extra: Record<string, unknown> = {}): ChatMessage =>
  ({ id, role, content: "", createdAt: "2026-11-25T10:00:00.000Z", status: "done", ...extra }) as ChatMessage;
const reply = (id: string, participantId: string, source: string, metadata: Record<string, unknown> = {}, status = "pending"): ChatMessage =>
  message(id, "participant", { participantId, status, metadata: { runId: `run-${id}`, sourceMessageId: source, ...metadata } });

test("a message its member has not taken is known with the run it waits as and the one it waits behind", () => {
  const messages = [
    message("u1", "user"), reply("a1", "main", "u1"),
    message("u2", "user"), reply("a2", "main", "u2", { turnQueued: true }),
    message("u3", "user"), reply("a3", "main", "u3", { queuedBehind: { handle: "main" } })
  ];
  const waiting = waitingMessages(messages);
  assert.deepEqual([...waiting.keys()], ["u2", "u3"]);
  assert.deepEqual(waiting.get("u2"), { participantId: "main", runId: "run-a2", behind: { runId: "run-a1", messageId: "u1" } });
  assert.deepEqual(waiting.get("u3")?.behind, { runId: "run-a1", messageId: "u1" }, "what was sent first still runs first");
  assert.equal(runningReplyOf(messages, "main")?.id, "a1");
});

test("another member's reply is not what a message waits behind, and one waiting for no reply names none", () => {
  const waiting = waitingMessages([message("u1", "user"), reply("a1", "drew", "u1"), message("u2", "user"), reply("a2", "main", "u2", { turnQueued: true })]);
  assert.deepEqual(waiting.get("u2"), { participantId: "main", runId: "run-a2" });
});

test("a reply that runs, has ended or has no run waits for nothing", () => {
  assert.equal(isWaitingReply(reply("a", "main", "u")), false);
  assert.equal(isWaitingReply(reply("a", "main", "u", { turnQueued: true }, "done")), false);
  assert.equal(waitingMessages([reply("a", "main", "u", { turnQueued: true, runId: undefined })]).size, 0);
});
