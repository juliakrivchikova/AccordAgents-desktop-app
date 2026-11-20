import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage } from "../../shared/types";
import { sortByServerOrder } from "./chatServerOps";

const at = (time: string) => `2026-11-18T${time}.000Z`;

function accepted(id: string, seq: number, time: string): ChatMessage {
  return { id, role: "user", content: id, createdAt: at(time), status: "done", metadata: { serverSeq: seq } as ChatMessage["metadata"] };
}

function bubble(id: string, time: string, status: ChatMessage["status"], sourceMessageId: string): ChatMessage {
  return { id, role: "participant", participantId: "mia", content: id, createdAt: at(time), status,
    metadata: { serverPlaceholder: true, sourceMessageId, runId: `turn-${sourceMessageId}` } as ChatMessage["metadata"] };
}

const ids = (messages: ChatMessage[]) => messages.map((message) => message.id);

test("messages keep the server's order, and those it has not taken yet come last in the order they were written", () => {
  const unsent = { ...accepted("unsent", 0, "19:50:00"), metadata: {} } as ChatMessage;
  assert.deepEqual(ids(sortByServerOrder([unsent, accepted("b", 2, "18:41:00"), bubble("running", "19:41:00", "pending", "b"), accepted("a", 1, "18:40:00")])),
    ["a", "b", "unsent", "running"]);
});

test("a member's reply that ended here before its turn started stands where it was written, not after everything since", () => {
  const messages = [accepted("before", 1, "18:40:00"), accepted("asked", 2, "18:46:00"), accepted("later", 3, "19:40:00"), accepted("reply", 4, "19:40:30"),
    bubble("failed", "18:46:01", "error", "asked")];
  assert.deepEqual(ids(sortByServerOrder(messages)), ["before", "asked", "failed", "later", "reply"]);
  // Sorting again changes nothing.
  assert.deepEqual(ids(sortByServerOrder(sortByServerOrder(messages))), ["before", "asked", "failed", "later", "reply"]);
});

test("a device clock ahead does not put that reply above the message it answers", () => {
  // The phone's clock runs a few minutes ahead: its message reads as newer than the reply to it.
  const messages = [accepted("before", 1, "18:40:00"), accepted("asked", 2, "18:50:00"), accepted("later", 3, "19:40:00"), bubble("failed", "18:46:01", "error", "asked")];
  assert.deepEqual(ids(sortByServerOrder(messages)), ["before", "asked", "failed", "later"]);
});

test("a reply that ended here without a time it can be placed by stays last, and nothing is dropped", () => {
  const timeless = { ...bubble("timeless", "18:46:01", "error", "asked"), createdAt: "not a time" };
  const sorted = sortByServerOrder([bubble("failed", "18:46:01", "error", "asked"), accepted("asked", 2, "18:46:00"), timeless, accepted("later", 3, "19:40:00")]);
  assert.deepEqual(ids(sorted), ["asked", "failed", "later", "timeless"]);
});
