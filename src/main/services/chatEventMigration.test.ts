import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { foldChatConversationEvents } from "../../shared/chatEventProjection";
import type { ChatMessage, Conversation } from "../../shared/types";
import { ChatEventLogService } from "./chatEventLog";
import {
  detectChatConversationProjectionDivergence,
  importConversationToEventLog
} from "./chatEventMigration";
import { StorageService } from "./storage";

test("importConversationToEventLog creates one replayable genesis event", async () => {
  const { storage, cleanup } = await testStorage();
  try {
    const eventLog = new ChatEventLogService(storage, fixedClock());
    const conversation = basicConversation();

    const first = await importConversationToEventLog(storage, eventLog, conversation);
    const second = await importConversationToEventLog(storage, eventLog, conversation);
    const events = await storage.listChatEvents(conversation.id, conversation.id);
    const folded = foldChatConversationEvents(events, {
      conversationId: conversation.id,
      logScopeId: conversation.id
    });

    assert.equal(first.status, "imported");
    assert.equal(second.status, "already-imported");
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "conversation.imported");
    assert.deepEqual(folded.conversation, conversation);
    assert.deepEqual(detectChatConversationProjectionDivergence(conversation, events), []);
  } finally {
    await cleanup();
  }
});

test("detectChatConversationProjectionDivergence reports changed materialized state", async () => {
  const { storage, cleanup } = await testStorage();
  try {
    const eventLog = new ChatEventLogService(storage, fixedClock());
    const conversation = basicConversation();
    await importConversationToEventLog(storage, eventLog, conversation);
    const events = await storage.listChatEvents(conversation.id, conversation.id);

    const changed = {
      ...conversation,
      title: "Changed"
    };

    assert.deepEqual(detectChatConversationProjectionDivergence(changed, events), [{
      field: "title",
      materialized: "Changed",
      projected: "Imported"
    }]);
  } finally {
    await cleanup();
  }
});

async function testStorage(): Promise<{ storage: StorageService; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-chat-event-migration-"));
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

function basicConversation(): Conversation {
  return {
    id: "conversation-1",
    title: "Imported",
    kind: "chat",
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:02.000Z",
    messages: [
      message("message-1", "first", "2026-08-06T00:00:01.000Z"),
      message("message-2", "second", "2026-08-06T00:00:02.000Z")
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
