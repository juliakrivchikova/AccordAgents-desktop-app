import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ChatEventLogService,
  createChatEventDeviceIdentity,
  createSignedChatEvent,
  verifySignedChatEvent
} from "./chatEventLog";
import { StorageService } from "./storage";
import type { ChatMessage } from "../../shared/types";

test("ChatEventLogService persists one device identity", async () => {
  const { storage, cleanup } = await testStorage();
  try {
    const log = new ChatEventLogService(storage, fixedClock());

    const first = await log.getOrCreateDeviceIdentity();
    const second = await log.getOrCreateDeviceIdentity();

    assert.deepEqual(second, first);
    assert.match(first.originId, /^device-[0-9a-f]{32}$/);
    assert.match(first.keyId, /^ed25519-[0-9a-f]{32}$/);
  } finally {
    await cleanup();
  }
});

test("ChatEventLogService appends signed local events with scoped sequences", async () => {
  const { storage, cleanup } = await testStorage();
  try {
    const log = new ChatEventLogService(storage, fixedClock());
    const identity = await log.getOrCreateDeviceIdentity();

    const first = await log.appendLocalEvent({
      conversationId: "conversation-1",
      logScopeId: "conversation-1",
      kind: "message.created",
      payload: { message: message("message-1", "first") }
    });
    const second = await log.appendLocalEvent({
      conversationId: "conversation-1",
      logScopeId: "conversation-1",
      kind: "message.created",
      payload: { message: message("message-2", "second") }
    });
    const otherScope = await log.appendLocalEvent({
      conversationId: "conversation-2",
      logScopeId: "conversation-2",
      kind: "message.created",
      payload: { message: message("message-3", "third") }
    });

    assert.equal(first.status, "appended");
    assert.equal(first.event.originSeq, 1);
    assert.equal(second.event.originSeq, 2);
    assert.equal(second.event.prevHash, first.event.eventHash);
    assert.equal(otherScope.event.originSeq, 1);
    assert.equal(otherScope.event.prevHash, undefined);
    assert.equal(verifySignedChatEvent(first.event, identity.publicKeyDerBase64), true);
    assert.equal(verifySignedChatEvent(second.event, identity.publicKeyDerBase64), true);

    const stored = await storage.listChatEvents("conversation-1", "conversation-1");
    assert.deepEqual(stored.map((event) => event.eventId), [first.event.eventId, second.event.eventId]);
  } finally {
    await cleanup();
  }
});

test("ChatEventLogService serializes concurrent local appends in the same scope", async () => {
  const { storage, cleanup } = await testStorage();
  try {
    const log = new ChatEventLogService(storage, fixedClock());
    const appends = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      log.appendLocalEvent({
        conversationId: "conversation-1",
        logScopeId: "conversation-1",
        kind: "message.created",
        payload: { message: message(`message-${index + 1}`, `message ${index + 1}`) }
      })
    ));

    const sequences = appends.map((append) => append.event.originSeq).sort((left, right) => left - right);
    const originIds = new Set(appends.map((append) => append.event.originId));
    assert.equal(originIds.size, 1);
    assert.deepEqual(sequences, Array.from({ length: 20 }, (_, index) => index + 1));
    const stored = await storage.listChatEvents("conversation-1", "conversation-1");
    assert.equal(stored.length, 20);
    assert.deepEqual(
      stored.map((event) => event.originSeq),
      Array.from({ length: 20 }, (_, index) => index + 1)
    );
  } finally {
    await cleanup();
  }
});

test("verifySignedChatEvent rejects payload tampering", () => {
  const identity = createChatEventDeviceIdentity("2026-08-06T00:00:00.000Z");
  const event = createSignedChatEvent(identity, {
    conversationId: "conversation-1",
    logScopeId: "conversation-1",
    kind: "message.created",
    payload: { message: message("message-1", "original") },
    originSeq: 1,
    createdAt: "2026-08-06T00:00:00.000Z"
  });

  const tampered = {
    ...event,
    payload: { message: message("message-1", "tampered") }
  };

  assert.equal(verifySignedChatEvent(event, identity.publicKeyDerBase64), true);
  assert.equal(verifySignedChatEvent(tampered, identity.publicKeyDerBase64), false);
});

async function testStorage(): Promise<{ storage: StorageService; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-chat-event-log-"));
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

function message(id: string, content: string): ChatMessage {
  return {
    id,
    role: "user",
    content,
    createdAt: "2026-08-06T00:00:00.000Z",
    metadata: {}
  };
}
