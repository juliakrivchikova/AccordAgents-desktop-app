import assert from "node:assert/strict";
import test from "node:test";
import {
  foldChatConversationEvents,
  type ChatConversationEventEnvelope
} from "../../shared/chatEventProjection";
import type { ChatMessage, Conversation } from "../../shared/types";

test("foldChatConversationEvents is deterministic for shuffled visible events", () => {
  const imported = conversationImportedEvent({ originSeq: 1, logicalTs: "0001" });
  const laterMessage = messageCreatedEvent({
    eventId: "event-message-2",
    originSeq: 3,
    logicalTs: "0003",
    message: message("message-2", "second", "2026-08-06T00:00:02.000Z")
  });
  const earlierMessage = messageCreatedEvent({
    eventId: "event-message-1",
    originSeq: 2,
    logicalTs: "0002",
    message: message("message-1", "first", "2026-08-06T00:00:01.000Z")
  });

  const folded = foldChatConversationEvents([laterMessage, imported, earlierMessage]);

  assert.deepEqual(folded.gaps, []);
  assert.deepEqual(folded.forks, []);
  assert.deepEqual(folded.appliedEventIds, ["event-import", "event-message-1", "event-message-2"]);
  assert.deepEqual(folded.conversation?.messages.map((item) => item.id), ["message-1", "message-2"]);
});

test("foldChatConversationEvents blocks only the origin/log scope with a visible gap", () => {
  const imported = conversationImportedEvent({ originSeq: 1, logicalTs: "0001" });
  const hiddenLocalOnlyEvent = messageCreatedEvent({
    eventId: "event-local-only",
    logScopeId: "local-only-conversation",
    originSeq: 1,
    logicalTs: "0002",
    message: message("local-only", "hidden", "2026-08-06T00:00:02.000Z")
  });
  const sharedEvent = messageCreatedEvent({
    eventId: "event-shared",
    originSeq: 2,
    logicalTs: "0003",
    message: message("shared", "visible", "2026-08-06T00:00:03.000Z")
  });

  const folded = foldChatConversationEvents([hiddenLocalOnlyEvent, sharedEvent, imported], {
    conversationId: "conversation-1",
    logScopeId: "conversation-1"
  });

  assert.deepEqual(folded.gaps, []);
  assert.deepEqual(folded.forks, []);
  assert.deepEqual(folded.conversation?.messages.map((item) => item.id), ["shared"]);
});

test("foldChatConversationEvents reports gaps inside the visible origin/log scope", () => {
  const imported = conversationImportedEvent({ originSeq: 1, logicalTs: "0001" });
  const afterGap = messageCreatedEvent({
    eventId: "event-after-gap",
    originSeq: 3,
    logicalTs: "0003",
    message: message("after-gap", "blocked", "2026-08-06T00:00:03.000Z")
  });

  const folded = foldChatConversationEvents([afterGap, imported]);

  assert.deepEqual(folded.gaps, [{
    originId: "device-1",
    logScopeId: "conversation-1",
    fromSeq: 2,
    toSeq: 2
  }]);
  assert.deepEqual(folded.appliedEventIds, ["event-import"]);
  assert.deepEqual(folded.conversation?.messages, []);
});

test("foldChatConversationEvents quarantines same-scope forks", () => {
  const imported = conversationImportedEvent({ originSeq: 1, logicalTs: "0001" });
  const first = messageCreatedEvent({
    eventId: "event-fork-a",
    originSeq: 2,
    eventHash: "hash-a",
    message: message("fork-a", "a", "2026-08-06T00:00:02.000Z")
  });
  const second = messageCreatedEvent({
    eventId: "event-fork-b",
    originSeq: 2,
    eventHash: "hash-b",
    message: message("fork-b", "b", "2026-08-06T00:00:02.000Z")
  });

  const folded = foldChatConversationEvents([imported, second, first]);

  assert.deepEqual(folded.forks, [{
    originId: "device-1",
    logScopeId: "conversation-1",
    originSeq: 2,
    eventIds: ["event-fork-a", "event-fork-b"]
  }]);
  assert.deepEqual(folded.appliedEventIds, ["event-import"]);
});

function conversationImportedEvent(overrides: Partial<ChatConversationEventEnvelope> = {}): ChatConversationEventEnvelope {
  return {
    eventId: "event-import",
    conversationId: "conversation-1",
    logScopeId: "conversation-1",
    originId: "device-1",
    originSeq: 1,
    logicalTs: "0001",
    kind: "conversation.imported",
    payload: {
      source: "legacy-storage",
      importedAt: "2026-08-06T00:00:00.000Z",
      conversation: conversation()
    },
    payloadHash: "payload-import",
    eventHash: "event-import-hash",
    signature: "signature-import",
    keyId: "key-1",
    createdAt: "2026-08-06T00:00:00.000Z",
    ...overrides
  };
}

function messageCreatedEvent(options: {
  eventId: string;
  message: ChatMessage;
  logScopeId?: string;
  originSeq?: number;
  logicalTs?: string;
  eventHash?: string;
}): ChatConversationEventEnvelope {
  return {
    eventId: options.eventId,
    conversationId: "conversation-1",
    logScopeId: options.logScopeId ?? "conversation-1",
    originId: "device-1",
    originSeq: options.originSeq ?? 2,
    logicalTs: options.logicalTs ?? "0002",
    kind: "message.created",
    payload: { message: options.message },
    payloadHash: `payload-${options.eventId}`,
    eventHash: options.eventHash ?? `hash-${options.eventId}`,
    signature: `signature-${options.eventId}`,
    keyId: "key-1",
    createdAt: "2026-08-06T00:00:00.000Z"
  };
}

function conversation(): Conversation {
  return {
    id: "conversation-1",
    title: "Conversation",
    kind: "chat",
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
    messages: [],
    findings: [],
    metadata: {}
  };
}

function message(id: string, content: string, createdAt: string): ChatMessage {
  return {
    id,
    role: "user",
    content,
    createdAt,
    metadata: {}
  };
}
