import assert from "node:assert/strict";
import test from "node:test";
import { ChatService } from "./chat";
import type { ChatMessage, ChatParticipantRequestBatch, Conversation } from "../../shared/types";

/**
 * A member asking another member to do something, and then being asked for its
 * status.
 *
 * Observed: the status question is a new turn from the requester, and every
 * unfinished request it had issued was marked "interrupted" — while the target
 * carried on working. The User was told the delegation had been interrupted and
 * it had not been.
 */
function service(): ChatService {
  const instance = new ChatService(
    { getConversation: async () => undefined } as never,
    {} as never,
    {} as never,
    { write: async () => undefined } as never,
    undefined,
    () => undefined
  );
  return instance;
}

function batch(status: "running" | "completed"): ChatParticipantRequestBatch {
  return {
    id: "batch-1",
    requesterParticipantId: "requester",
    requesterHandle: "gera",
    source: "mcp",
    resumeRequester: true,
    status: status === "running" ? "running" : "completed",
    depth: 1,
    createdAt: "2026-09-07T09:00:00.000Z",
    updatedAt: "2026-09-07T09:00:00.000Z",
    items: [{
      targetParticipantId: "worker",
      targetHandle: "taylor",
      prompt: "Do the thing.",
      status: status === "running" ? "running" : "completed",
      createdAt: "2026-09-07T09:00:00.000Z",
      updatedAt: "2026-09-07T09:00:00.000Z"
    }]
  };
}

function conversation(request: ChatParticipantRequestBatch): Conversation {
  const message: ChatMessage = {
    id: "request-message",
    role: "participant",
    participantId: "requester",
    content: "Asked @taylor to do the thing.",
    createdAt: "2026-09-07T09:00:00.000Z",
    metadata: { participantRequest: request }
  };
  return {
    id: "chat", kind: "chat", title: "Delegation", createdAt: "2026-09-07T09:00:00.000Z",
    updatedAt: "2026-09-07T09:00:00.000Z", metadata: { participants: [] },
    messages: [message], findings: []
  } as unknown as Conversation;
}

type Internals = {
  resolveSupersededParticipantInteractions(conversation: Conversation, participantId: string, excludeMessageId?: string): boolean;
  chatRunMeta: Map<string, { conversationId: string; participantId: string; participantHandle: string }>;
};

function statusOf(value: Conversation): string {
  return (value.messages[0].metadata?.participantRequest as ChatParticipantRequestBatch).status;
}

test("a status question from the requester does not cancel a delegation still being worked on", () => {
  const chat = service() as unknown as Internals;
  const value = conversation(batch("running"));
  // The target really is running right now.
  chat.chatRunMeta.set("run-worker", { conversationId: "chat", participantId: "worker", participantHandle: "taylor" });

  const changed = chat.resolveSupersededParticipantInteractions(value, "requester", "new-turn-message");
  assert.equal(changed, false, "nothing may be rewritten while the target is working");
  assert.equal(statusOf(value), "running");
  assert.equal((value.messages[0].metadata?.participantRequest as ChatParticipantRequestBatch).items[0].status, "running");
});

test("a delegation that can no longer make progress is still closed", () => {
  const chat = service() as unknown as Internals;
  const value = conversation(batch("running"));
  // Nobody is working on it: the target's run is gone.
  const changed = chat.resolveSupersededParticipantInteractions(value, "requester", "new-turn-message");
  assert.equal(changed, true);
  assert.equal(statusOf(value), "interrupted");
});

test("another chat's run does not keep this delegation alive", () => {
  const chat = service() as unknown as Internals;
  const value = conversation(batch("running"));
  chat.chatRunMeta.set("run-elsewhere", { conversationId: "other-chat", participantId: "worker", participantHandle: "taylor" });
  assert.equal(chat.resolveSupersededParticipantInteractions(value, "requester", "new-turn-message"), true);
  assert.equal(statusOf(value), "interrupted");
});

test("a finished delegation is left exactly as it finished", () => {
  const chat = service() as unknown as Internals;
  const value = conversation(batch("completed"));
  assert.equal(chat.resolveSupersededParticipantInteractions(value, "requester", "new-turn-message"), false);
  assert.equal(statusOf(value), "completed");
});

test("another member's delegation is never touched by this member's turn", () => {
  const chat = service() as unknown as Internals;
  const value = conversation(batch("running"));
  assert.equal(chat.resolveSupersededParticipantInteractions(value, "someone-else", "new-turn-message"), false);
  assert.equal(statusOf(value), "running");
});
