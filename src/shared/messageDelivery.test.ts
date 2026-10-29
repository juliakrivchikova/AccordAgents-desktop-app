import assert from "node:assert/strict";
import test from "node:test";
import { messageDelivery } from "./messageDelivery";
import type { ChatMessage, ChatMessageMetadata } from "./types";

function userMessage(metadata: ChatMessageMetadata = {}): ChatMessage {
  return { id: "message-1", role: "user", content: "@drew are you there?", createdAt: "2026-10-29T00:00:00.000Z", metadata };
}

test("a message her server has not answered yet is shown as not sent yet", () => {
  assert.deepEqual(messageDelivery(userMessage()), { state: "unsent" });
});

test("a message her server took is shown as any message, whatever its turns", () => {
  assert.equal(messageDelivery(userMessage({ serverSeq: 7 })), undefined);
  assert.equal(messageDelivery(userMessage({ serverSeq: 0 })), undefined, "a message moved to the server has place 0");
  assert.equal(messageDelivery(userMessage({ serverSeq: 7, serverTurns: { "p-drew": { runId: "turn-message-1-p-drew", state: "claimed" } } })), undefined);
});

test("a message her server refused says so with the server's reason", () => {
  assert.deepEqual(messageDelivery(userMessage({ serverRejected: "the chat was deleted" })), { state: "refused", text: "Not taken by your server: the chat was deleted" });
});

test("only the User's messages have a delivery state", () => {
  assert.equal(messageDelivery({ ...userMessage(), role: "participant" }), undefined);
});
