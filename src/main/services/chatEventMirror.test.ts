import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { foldChatConversationEvents } from "../../shared/chatEventProjection";
import type { ChatEventEnvelope } from "../../shared/chatEvents";
import type { ChatMessage, Conversation } from "../../shared/types";
import { ChatEventLogService } from "./chatEventLog";
import {
  CHAT_CONVERSATION_PROJECTION_KEY,
  ChatEventMirrorService,
  type ChatEventMirrorLogger
} from "./chatEventMirror";
import { ChatService } from "./chat";
import { StorageService } from "./storage";

test("ChatEventMirrorService is disabled by default", async () => {
  const { storage, cleanup } = await testStorage("accordagents-chat-event-mirror-disabled-");
  try {
    const mirror = new ChatEventMirrorService(storage, new ChatEventLogService(storage, fixedClock()), testLogger());
    const conversation = basicConversation();

    const result = await mirror.mirrorSavedConversation(undefined, conversation);

    assert.equal(result.status, "disabled");
    assert.deepEqual(await storage.listChatEvents(conversation.id, conversation.id), []);
  } finally {
    await cleanup();
  }
});

test("ChatEventMirrorService mirrors legacy saves into a replayable projection", async () => {
  const { storage, cleanup } = await testStorage("accordagents-chat-event-mirror-direct-");
  try {
    const mirror = new ChatEventMirrorService(
      storage,
      new ChatEventLogService(storage, fixedClock()),
      testLogger(),
      { enabled: true, strict: true, now: fixedClock() }
    );
    const initial = basicConversation();
    const updated = {
      ...initial,
      title: "Updated",
      updatedAt: "2026-08-06T00:00:03.000Z",
      messages: [...initial.messages, message("message-2", "second", "2026-08-06T00:00:03.000Z")]
    };

    assert.equal((await mirror.mirrorSavedConversation(undefined, initial)).status, "mirrored");
    assert.equal((await mirror.mirrorSavedConversation(initial, updated)).status, "mirrored");

    const events = await storage.listChatEvents(initial.id, initial.id);
    const folded = foldChatConversationEvents(events, {
      conversationId: initial.id,
      logScopeId: initial.id
    });
    const projection = await storage.getChatEventProjection<{
      conversation?: Conversation;
      divergence: unknown[];
    }>(initial.id, CHAT_CONVERSATION_PROJECTION_KEY);

    assert.deepEqual(events.map((event) => event.kind), ["conversation.imported", "conversation.snapshot.replaced"]);
    assert.deepEqual(folded.conversation, updated);
    assert.deepEqual(projection?.payload.conversation, updated);
    assert.deepEqual(projection?.payload.divergence, []);
  } finally {
    await cleanup();
  }
});

test("ChatService queued snapshots use the event mirror when enabled", async () => {
  const { storage, cleanup } = await testStorage("accordagents-chat-event-mirror-chat-service-");
  try {
    const mirror = new ChatEventMirrorService(
      storage,
      new ChatEventLogService(storage, fixedClock()),
      testLogger(),
      { enabled: true, strict: true, now: fixedClock() }
    );
    const service = new ChatService(
      storage,
      {} as never,
      {} as never,
      testLogger() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      mirror
    );
    const initial = basicConversation();
    const updated = {
      ...initial,
      updatedAt: "2026-08-06T00:00:04.000Z",
      messages: [...initial.messages, message("message-2", "second", "2026-08-06T00:00:04.000Z")]
    };

    (service as unknown as { queueSnapshot(conversation: Conversation): void }).queueSnapshot(initial);
    await (service as unknown as { waitForQueuedSave(conversationId: string): Promise<void> }).waitForQueuedSave(initial.id);
    (service as unknown as { queueSnapshot(conversation: Conversation): void }).queueSnapshot(updated);
    await (service as unknown as { waitForQueuedSave(conversationId: string): Promise<void> }).waitForQueuedSave(updated.id);

    const events = await storage.listChatEvents(initial.id, initial.id);
    const projection = await storage.getChatEventProjection<{
      conversation?: Conversation;
      divergence: unknown[];
    }>(initial.id, CHAT_CONVERSATION_PROJECTION_KEY);

    assert.deepEqual(events.map((event) => event.kind), ["conversation.imported", "conversation.snapshot.replaced"]);
    assert.deepEqual(projection?.payload.conversation, updated);
    assert.deepEqual(projection?.payload.divergence, []);
  } finally {
    await cleanup();
  }
});

test("ChatService imports canonical mailbox message.created events through the mutation queue", async () => {
  const { storage, cleanup } = await testStorage("accordagents-chat-mailbox-message-import-");
  try {
    const service = new ChatService(
      storage,
      {} as never,
      {} as never,
      testLogger() as never
    );
    await storage.saveConversation(basicConversation());
    const participantMessage: ChatMessage = {
      id: "worker-message-1",
      role: "participant",
      participantId: "participant-codex",
      participantLabel: "@codex",
      content: "Worker result",
      status: "done",
      createdAt: "2026-08-06T00:00:05.000Z",
      metadata: {
        runId: "mobile-worker-event-1",
        appMessageSource: "remote-run-provider-output"
      }
    };
    const event = mailboxMessageEvent(participantMessage);

    assert.equal(await service.acceptMobileMailboxMessageEvent(event), true);
    assert.equal(await service.acceptMobileMailboxMessageEvent(event), false);

    const conversation = await storage.getConversation("conversation-1");
    const events = await storage.listChatEvents("conversation-1", "conversation-1");
    assert.equal(conversation?.messages.filter((item) => item.id === participantMessage.id).length, 1);
    assert.equal(conversation?.updatedAt, "2026-08-06T00:00:05.000Z");
    assert.deepEqual(events.map((item) => item.eventId), ["mailbox-message-event-1"]);
  } finally {
    await cleanup();
  }
});

test("ChatService imports fulfilled mobile mailbox outbox events without retriggering a run", async () => {
  const { storage, cleanup } = await testStorage("accordagents-chat-mailbox-mobile-fulfilled-");
  try {
    const service = new ChatService(
      storage,
      {} as never,
      {} as never,
      testLogger() as never
    );
    await storage.saveConversation(basicConversation());
    const participantMessage: ChatMessage = {
      id: "worker-message-closed-lid",
      role: "participant",
      participantId: "participant-codex",
      participantLabel: "@codex",
      content: "Worker result after lid closed",
      status: "done",
      createdAt: "2026-08-06T00:00:05.000Z",
      metadata: {
        runId: "mobile-mobile-event-1",
        appMessageSource: "remote-run-provider-output",
        sourceMessageId: "mobile-event-1",
        mobileEventId: "mobile-event-1"
      }
    };
    const mobileEvent = mobileOutboxEvent("mobile-event-1", "@codex run while desktop is closed");

    assert.equal(await service.acceptMobileMailboxMessageEvent(mailboxMessageEvent(participantMessage)), true);
    assert.equal(await service.hasMobileMailboxResultForMobileEvent("conversation-1", "mobile-event-1"), true);
    assert.equal(await service.hasAcceptedMobileEvent("conversation-1", "mobile-event-1"), false);
    assert.equal(await service.acceptMobileMailboxOutboxEvent(mobileEvent), true);
    assert.equal(await service.acceptMobileMailboxOutboxEvent(mobileEvent), false);

    const conversation = await storage.getConversation("conversation-1");
    assert.equal(conversation?.messages.filter((item) =>
      item.role === "user" &&
        item.metadata?.appMessageSource === "mobile-relay" &&
        item.metadata?.mobileEventId === "mobile-event-1"
    ).length, 1);
    assert.equal(conversation?.messages.filter((item) => item.id === participantMessage.id).length, 1);
    assert.equal(await service.hasAcceptedMobileEvent("conversation-1", "mobile-event-1"), true);
    assert.deepEqual(conversation?.messages.map((item) => item.id), [
      "message-1",
      "mobile-mobile-event-1",
      "worker-message-closed-lid"
    ]);
  } finally {
    await cleanup();
  }
});

test("ChatService records an acted-on mobile mailbox cancellation exactly once", async () => {
  const { storage, cleanup } = await testStorage("accordagents-chat-mailbox-mobile-cancel-");
  try {
    const service = new ChatService(
      storage,
      {} as never,
      {} as never,
      testLogger() as never
    );
    await storage.saveConversation(basicConversation());
    const event: ChatEventEnvelope<{ runId: string }> = {
      eventId: "mobile-cancel-event-1",
      conversationId: "conversation-1",
      logScopeId: "conversation-1",
      originId: "mobile-test",
      originSeq: 1,
      logicalTs: "0000000000000001:mobile-test:conversation-1",
      kind: "run.cancel.requested",
      payload: { runId: "participant-run-1" },
      payloadHash: "sha256:mobile-cancel-payload",
      eventHash: "sha256:mobile-cancel-event",
      createdAt: "2026-08-06T00:00:05.000Z"
    };

    assert.equal(await service.hasAcceptedMobileEvent("conversation-1", event.eventId), false);
    assert.equal(await service.acceptMobileMailboxOutboxEvent(event), true);
    assert.equal(await service.acceptMobileMailboxOutboxEvent(event), false);
    assert.equal(await service.hasAcceptedMobileEvent("conversation-1", event.eventId), true);
    assert.deepEqual((await storage.listChatEvents("conversation-1", "conversation-1")).map((item) => item.eventId), [
      "mobile-cancel-event-1"
    ]);
  } finally {
    await cleanup();
  }
});

async function testStorage(prefix: string): Promise<{ storage: StorageService; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  const storage = Object.create(StorageService.prototype) as any;
  storage.dbPath = path.join(directory, "accordagents.sqlite3");
  storage.initialized = false;
  await storage.init();
  return {
    storage: storage as StorageService,
    cleanup: async () => {
      await rm(directory, { recursive: true, force: true });
    }
  };
}

function fixedClock(): () => Date {
  return () => new Date("2026-08-06T00:00:00.000Z");
}

function testLogger(): ChatEventMirrorLogger {
  return {
    async write(): Promise<void> {
      return undefined;
    }
  };
}

function basicConversation(): Conversation {
  return {
    id: "conversation-1",
    title: "Imported",
    kind: "chat",
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:02.000Z",
    messages: [
      message("message-1", "first", "2026-08-06T00:00:01.000Z")
    ],
    findings: [],
    metadata: {
      participants: [{
        id: "participant-codex",
        handle: "codex",
        displayName: "Codex"
      }]
    }
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

function mailboxMessageEvent(message: ChatMessage): ChatEventEnvelope<{ message: ChatMessage }> {
  return {
    eventId: "mailbox-message-event-1",
    conversationId: "conversation-1",
    logScopeId: "conversation-1",
    originId: "worker-origin-1",
    originSeq: 1,
    logicalTs: "0000000000000001:worker-origin-1:conversation-1",
    kind: "message.created",
    payload: { message },
    payloadHash: "sha256:payload",
    eventHash: "sha256:event",
    keyId: "worker-origin-1",
    signature: "test-signature",
    createdAt: message.createdAt
  };
}

function mobileOutboxEvent(eventId: string, content: string): ChatEventEnvelope<{ content: string }> {
  return {
    eventId,
    conversationId: "conversation-1",
    logScopeId: "conversation-1",
    originId: "mobile-origin-1",
    originSeq: 1,
    logicalTs: "0000000000000001:mobile-origin-1:conversation-1",
    kind: "message.created",
    payload: { content },
    payloadHash: "sha256:mobile-payload",
    eventHash: "sha256:mobile-event",
    keyId: "mobile-origin-1",
    signature: "test-mobile-signature",
    createdAt: "2026-08-06T00:00:04.000Z"
  };
}
