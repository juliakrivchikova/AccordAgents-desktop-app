import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage } from "../../shared/types";
import { takenBackMark, takenBackMessageIds } from "./chat/turns/takenBackMessages";

const reply = (participantId: string, messageId: string, metadata: Record<string, unknown> = {}): ChatMessage =>
  ({ id: `${participantId}-${messageId}`, role: "participant", participantId, content: "", createdAt: "", status: "error", metadata: { sourceMessageId: messageId, ...metadata } }) as unknown as ChatMessage;

test("a reply that ends before its turn began says which message was taken back; one that began says nothing", () => {
  assert.deepEqual(takenBackMark(reply("main", "u1", { turnQueued: true })), { takenBack: { participantId: "main", messageId: "u1" } });
  assert.deepEqual(takenBackMark(reply("main", "u1", { queuedBehind: { handle: "main" } })), { takenBack: { participantId: "main", messageId: "u1" } });
  assert.equal(takenBackMark(reply("main", "u1")), undefined);
});

test("a message taken back from one member is still read by another who took it, and by no one when no one did", () => {
  const taken = { takenBack: { participantId: "main", messageId: "u1" } };
  const shared = [reply("main", "u1", taken), reply("drew", "u1")];
  assert.deepEqual([...takenBackMessageIds(shared, "main")], ["u1"]);
  assert.deepEqual([...takenBackMessageIds(shared, "drew")], []);
  assert.deepEqual([...takenBackMessageIds([reply("main", "u1", taken)], "drew")], ["u1"]);
  assert.deepEqual([...takenBackMessageIds([reply("main", "u1")], "main")], []);
});
