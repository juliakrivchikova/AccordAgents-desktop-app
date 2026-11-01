import assert from "node:assert/strict";
import test from "node:test";

import type { ChatMessage, Conversation, ConversationUpdate } from "../../shared/types";
import { upsertConversationSummary } from "./conversation-summaries";

// The chat list row shows work while a run of this device is in the chat, and
// also while a member's reply has not ended anywhere — a machine member's turn
// asked from the phone leaves no run here, only its reply. Only a run of this
// device blocks what a run blocks (`running`).
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

const stateOf = (conversation: ConversationUpdate): { running: boolean; replyPending: boolean } => {
  const summary = upsertConversationSummary([], conversation)[0];
  return { running: summary?.running === true, replyPending: summary?.replyPending === true };
};
const replyPendingOf = (conversation: ConversationUpdate): boolean => stateOf(conversation).replyPending;

test("a full update with a member's reply not ended shows it, with no run of this device", () => {
  assert.deepEqual(stateOf(chat([asked, replying])), { running: false, replyPending: true });
  assert.deepEqual(stateOf(chat([asked, { ...replying, status: "done", content: "Done." }])), { running: false, replyPending: false });
  assert.deepEqual(stateOf(chat([asked], { activeRunIds: ["run-here"] })), { running: true, replyPending: false }, "a run of this device");
});

test("a delta is read for the whole chat, not only for the messages it carries", () => {
  const later: ChatMessage = { id: "later", role: "user", content: "meanwhile", createdAt: "2026-11-01T10:00:02.000Z", status: "done" };
  const delta = (replyPending: boolean | undefined): ConversationUpdate => ({
    ...chat([later]),
    messageDelta: { totalMessages: 3, tailCount: 1, removedIds: [], ...(replyPending === undefined ? {} : { replyPending }) }
  });
  assert.equal(replyPendingOf(delta(true)), true, "the pending reply is outside the carried window");
  assert.equal(replyPendingOf(delta(false)), false);
  assert.equal(replyPendingOf({ ...delta(false), messages: [replying] }), true, "a carried pending reply counts as well");
  // A delta that does not say (none is made so now) is read from what it carries.
  assert.equal(replyPendingOf(delta(undefined)), false);
  assert.equal(replyPendingOf({ ...delta(undefined), messages: [replying] }), true);
});
