import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { foldChatConversationEvents } from "../../shared/chatEventProjection";
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
