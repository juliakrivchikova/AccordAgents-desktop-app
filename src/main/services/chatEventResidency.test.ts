import assert from "node:assert/strict";
import test from "node:test";
import type { ChatEventEnvelope } from "../../shared/chatEvents";
import {
  assertChatEventsCanEnterSyncNetwork,
  chatConversationResidency
} from "../../shared/chatEventResidency";
import type { Conversation } from "../../shared/types";

test("chatConversationResidency defaults to syncable", () => {
  assert.equal(chatConversationResidency(conversation({})), "syncable");
});

test("assertChatEventsCanEnterSyncNetwork refuses local-only conversation events", () => {
  const localOnly = conversation({ residency: "local-only" });

  assert.throws(
    () => assertChatEventsCanEnterSyncNetwork(localOnly, [event("event-1", localOnly.id)]),
    /Local-only conversation conversation-1 cannot serialize chat event event-1 to sync/
  );
});

test("assertChatEventsCanEnterSyncNetwork ignores other conversations", () => {
  const localOnly = conversation({ residency: "local-only" });

  assert.doesNotThrow(() => assertChatEventsCanEnterSyncNetwork(localOnly, [event("event-1", "conversation-2")]));
});

function conversation(metadata: Conversation["metadata"]): Conversation {
  return {
    id: "conversation-1",
    title: "Conversation",
    kind: "chat",
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
    messages: [],
    findings: [],
    metadata
  };
}

function event(eventId: string, conversationId: string): ChatEventEnvelope {
  return {
    eventId,
    conversationId,
    logScopeId: conversationId,
    originId: "device-1",
    originSeq: 1,
    logicalTs: "0001",
    kind: "message.created",
    payload: {},
    payloadHash: "payload-hash",
    eventHash: "event-hash",
    signature: "signature",
    keyId: "key-1",
    createdAt: "2026-08-06T00:00:00.000Z"
  };
}
