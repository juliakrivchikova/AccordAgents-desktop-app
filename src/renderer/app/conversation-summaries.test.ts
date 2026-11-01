import assert from "node:assert/strict";
import test from "node:test";

import type { ChatMessage, Conversation, ConversationUpdate } from "../../shared/types";
import { upsertConversationSummary } from "./conversation-summaries";

// The chat list row's spinner: a chat works while a run of this device is in
// it, and also while a member's reply has not ended anywhere — a machine
// member's turn asked from the phone leaves no run here, only its reply.
const asked: ChatMessage = { id: "asked", role: "user", content: "@victor go", createdAt: "2026-11-01T10:00:00.000Z", status: "done" };
const replying: ChatMessage = {
  id: "reply", role: "participant", participantId: "victor", content: "", createdAt: "2026-11-01T10:00:01.000Z", status: "pending",
  metadata: { runId: "turn-asked-victor" }
};

function chat(messages: ChatMessage[], metadata: Record<string, unknown> = {}): Conversation {
  return {
    id: "chat-1", title: "Chat", kind: "chat", createdAt: "2026-11-01T09:00:00.000Z", updatedAt: "2026-11-01T10:00:02.000Z",
    findings: [], messages, metadata: { participantSessions: [], running: false, ...metadata } as Conversation["metadata"]
  };
}

const runningOf = (conversation: Conversation | ConversationUpdate): boolean | undefined =>
  upsertConversationSummary([], conversation)[0]?.running;

test("a full update with a member's reply not ended shows the chat working, with no run of this device", () => {
  assert.equal(runningOf(chat([asked, replying])), true);
  assert.equal(runningOf(chat([asked, { ...replying, status: "done", content: "Done." }])), false);
  assert.equal(runningOf(chat([asked], { activeRunIds: ["run-here"] })), true, "a run of this device still counts");
});

test("a delta is read for the whole chat, not only for the messages it carries", () => {
  const later: ChatMessage = { id: "later", role: "user", content: "meanwhile", createdAt: "2026-11-01T10:00:02.000Z", status: "done" };
  const delta = (replyPending: boolean | undefined): ConversationUpdate => ({
    ...chat([later]),
    messageDelta: { totalMessages: 3, tailCount: 1, removedIds: [], ...(replyPending === undefined ? {} : { replyPending }) }
  });
  assert.equal(runningOf(delta(true)), true, "the pending reply is outside the carried window");
  assert.equal(runningOf(delta(false)), false);
  assert.equal(runningOf({ ...delta(false), messages: [replying] }), true, "a carried pending reply counts as well");
});
