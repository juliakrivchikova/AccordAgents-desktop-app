import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Conversation } from "../../shared/types";
import { ChatEventLogService } from "./chatEventLog";
import { MailboxSyncClient } from "./mailboxSyncClient";
import { MailboxSyncService } from "./mailboxSyncService";
import { StorageService } from "./storage";

const requireScript = createRequire(__filename);
const { createReferenceMailboxServer } = requireScript(path.join(process.cwd(), "scripts/mailbox-reference-server.cjs")) as {
  createReferenceMailboxServer: (options?: { storePath?: string }) => {
    listen(port?: number, host?: string): Promise<{ port: number; url: string }>;
    close(): Promise<void>;
  };
};

test("MailboxSyncService syncs a desktop event through mailbox into another local store", async () => {
  const mailbox = createReferenceMailboxServer();
  const address = await mailbox.listen();
  const source = await testStorage("source");
  const target = await testStorage("target");
  try {
    const sourceLog = new ChatEventLogService(source.storage, fixedClock());
    const created = await sourceLog.appendLocalEvent({
      conversationId: "conversation-1",
      logScopeId: "conversation-1",
      kind: "message.created",
      payload: { content: "from phone/mailbox path" }
    });
    const client = new MailboxSyncClient({ baseUrl: address.url });
    const sourceSync = new MailboxSyncService(source.storage, client);
    const targetSync = new MailboxSyncService(target.storage, client);

    const pushed = await sourceSync.pushConversationEvents(conversation());
    const pulled = await targetSync.pullMailboxRange({
      conversationId: "conversation-1",
      logScopeId: "conversation-1",
      originId: created.event.originId,
      afterSeq: 0
    });
    const stored = await target.storage.listChatEvents("conversation-1", "conversation-1");

    assert.deepEqual(pushed.pushedEventIds, [created.event.eventId]);
    assert.deepEqual(pulled.receivedEventIds, [created.event.eventId]);
    assert.deepEqual(pulled.appendResults, [{ status: "appended", eventId: created.event.eventId }]);
    assert.deepEqual(stored.map((event) => event.eventId), [created.event.eventId]);
  } finally {
    await mailbox.close();
    await source.cleanup();
    await target.cleanup();
  }
});

test("MailboxSyncService refuses to serialize local-only conversation events", async () => {
  const mailbox = createReferenceMailboxServer();
  const address = await mailbox.listen();
  const source = await testStorage("local-only");
  try {
    const sourceLog = new ChatEventLogService(source.storage, fixedClock());
    await sourceLog.appendLocalEvent({
      conversationId: "conversation-1",
      logScopeId: "conversation-1",
      kind: "message.created",
      payload: { content: "must stay local" }
    });
    const sync = new MailboxSyncService(source.storage, new MailboxSyncClient({ baseUrl: address.url }));

    await assert.rejects(
      () => sync.pushConversationEvents(conversation({ residency: "local-only" })),
      /Local-only conversation conversation-1 cannot serialize chat event/
    );
  } finally {
    await mailbox.close();
    await source.cleanup();
  }
});

test("MailboxSyncService surfaces mailbox import conflicts from storage append results", async () => {
  const mailbox = createReferenceMailboxServer();
  const address = await mailbox.listen();
  const source = await testStorage("conflict-source");
  const target = await testStorage("conflict-target");
  try {
    const sourceLog = new ChatEventLogService(source.storage, fixedClock());
    const created = await sourceLog.appendLocalEvent({
      conversationId: "conversation-1",
      logScopeId: "conversation-1",
      kind: "message.created",
      payload: { content: "source" }
    });
    await target.storage.appendChatEvent({
      ...created.event,
      eventId: "target-conflicting-event",
      payload: { content: "conflicting target" },
      payloadHash: "sha256:target-conflict",
      eventHash: "sha256:target-conflict"
    });
    const client = new MailboxSyncClient({ baseUrl: address.url });
    await new MailboxSyncService(source.storage, client).pushConversationEvents(conversation());

    const pulled = await new MailboxSyncService(target.storage, client).pullMailboxRange({
      conversationId: "conversation-1",
      logScopeId: "conversation-1",
      originId: created.event.originId,
      afterSeq: 0
    });

    assert.deepEqual(pulled.appendResults, [{
      status: "conflict",
      eventId: created.event.eventId,
      existingEventId: "target-conflicting-event",
      conflictReason: "origin-sequence-conflict"
    }]);
  } finally {
    await mailbox.close();
    await source.cleanup();
    await target.cleanup();
  }
});

async function testStorage(label: string): Promise<{ storage: StorageService; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(path.join(tmpdir(), `accordagents-mailbox-sync-${label}-`));
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

function conversation(metadata: Conversation["metadata"] = {}): Conversation {
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

function fixedClock(): () => Date {
  return () => new Date("2026-08-06T00:00:00.000Z");
}
