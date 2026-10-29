import assert from "node:assert/strict";
import test from "node:test";
import { messageDeliveryMark } from "./messageDelivery";
import type { ChatMessage, ChatMessageMetadata } from "./types";

function userMessage(metadata: ChatMessageMetadata = {}): ChatMessage {
  return { id: "message-1", role: "user", content: "@drew are you there?", createdAt: "2026-10-29T00:00:00.000Z", metadata };
}

const handles: Record<string, string> = { "p-drew": "drew", "p-gera": "@gera" };
const handleOf = (participantId: string) => handles[participantId];
const turn = (state: "requested" | "claimed" | "stopped" | "finished") => ({ runId: "turn-message-1", state });

test("a message her server has not answered yet says it is not sent and retrying", () => {
  assert.equal(messageDeliveryMark(userMessage(), handleOf), "Not sent, retrying");
});

test("a message her server took says Sent until a member's own device takes its turn", () => {
  assert.equal(messageDeliveryMark(userMessage({ serverSeq: 7, serverTurns: { "p-drew": turn("requested") } }), handleOf), "Sent");
  assert.equal(messageDeliveryMark(userMessage({ serverSeq: 7, serverTurns: { "p-drew": turn("stopped") } }), handleOf), "Sent");
});

test("taken turns name every member whose device claimed or finished one", () => {
  assert.equal(messageDeliveryMark(userMessage({ serverSeq: 7, serverTurns: { "p-drew": turn("claimed") } }), handleOf), "Taken to work by @drew");
  assert.equal(
    messageDeliveryMark(userMessage({ serverSeq: 7, serverTurns: { "p-drew": turn("finished"), "p-gera": turn("claimed"), "p-gone": turn("claimed") } }), handleOf),
    "Taken to work by @drew, @gera and a member"
  );
});

test("a message her server refused says so with the server's reason, even before any number", () => {
  assert.equal(messageDeliveryMark(userMessage({ serverRejected: "the chat was deleted" }), handleOf), "Not taken by your server: the chat was deleted");
});

test("only the User's messages carry a mark", () => {
  assert.equal(messageDeliveryMark({ ...userMessage({ serverSeq: 7 }), role: "participant" }, handleOf), undefined);
});
