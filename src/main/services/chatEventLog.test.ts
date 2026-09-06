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
import { formatHlcKey, logicalOrderKey, parseHlcKey } from "../../shared/hlc";

test("accepted receive clocks survive restart and apply to local events in another chat", async () => {
  const { storage, reopen, cleanup } = await testStorage();
  try {
    const foreign = foreignEvent(1, 1_900_000_000_000);
    assert.equal((await storage.appendChatEvent(foreign)).status, "appended");
    const log = new ChatEventLogService(reopen(), fixedClock());
    const next = await log.appendLocalEvent(localRequest("different-chat"));
    assert.ok(next.event.logicalTs > foreign.logicalTs);
    const afterRestart = new ChatEventLogService(reopen(), () => new Date(1));
    const later = await afterRestart.appendLocalEvent(localRequest("third-chat"));
    assert.ok(later.event.logicalTs > next.event.logicalTs);
    assert.equal(later.event.originSeq, 1);
    const beforeDuplicate = await storage.getChatEventClock();
    assert.equal((await storage.appendChatEvent(foreign)).status, "duplicate");
    assert.deepEqual(await storage.getChatEventClock(), beforeDuplicate);
  } finally { await cleanup(); }
});

test("rejected future events cannot poison the receive clock", async () => {
  const { storage, cleanup } = await testStorage();
  try {
    const original = foreignEvent(1, 1_900_000_000_000);
    await storage.appendChatEvent(original);
    const future = foreignEvent(1, 2_900_000_000_000);
    const collision = { ...future, originId: original.originId };
    assert.equal((await storage.appendChatEvent(collision)).status, "conflict");
    const result = await new ChatEventLogService(storage, fixedClock()).appendLocalEvent(localRequest("new-chat"));
    assert.equal(parseHlcKey(result.event.logicalTs)?.wallMs, 1_900_000_000_000);
  } finally { await cleanup(); }
});

test("clock persistence failure rolls back the incoming event and retry preserves its identity", async () => {
  const { storage, sql, reopen, cleanup } = await testStorage();
  try {
    const initial = await storage.getChatEventClock();
    await sql(`create trigger reject_clock before update on schema_meta
      when new.key = 'chat-event-clock-v1' begin select raise(abort, 'SQLITE_FULL injected clock write'); end;`);
    const incoming = foreignEvent(1, 1_900_000_000_000);
    await assert.rejects(storage.appendChatEvent(incoming), (error: unknown) => {
      assert.match(String((error as { result?: { stderr?: string } }).result?.stderr), /SQLITE_FULL/);
      return true;
    });
    assert.deepEqual(await reopen().getChatEventClock(), initial);
    assert.equal((await storage.listChatEvents(incoming.conversationId, incoming.logScopeId)).length, 0);
    await sql("drop trigger reject_clock;");
    assert.equal((await storage.appendChatEvent(incoming)).status, "appended");
    assert.deepEqual(await storage.listChatEvents(incoming.conversationId, incoming.logScopeId), JSON.parse(JSON.stringify([incoming])));
  } finally { await cleanup(); }
});

test("accepted events commit with durable SQLite sync before they can be published", async () => {
  const { storage, cleanup } = await testStorage();
  try {
    const query = (storage as any).queryJson.bind(storage);
    (storage as any).queryJson = (sql: string) => query(sql.includes("insert or ignore into chat_events")
      ? sql.replace("begin immediate;", `
        create temp table require_durable_event(sync integer check(sync = 2), fullsync integer check(fullsync = 1));
        insert into require_durable_event select synchronous, fullfsync from pragma_synchronous, pragma_fullfsync;
        begin immediate;
      `)
      : sql);
    assert.equal((await storage.appendChatEvent(foreignEvent(1, 1_900_000_000_000))).status, "appended");
  } finally { await cleanup(); }
});

test("duplicate ids inside one receive batch report only the accepted event and do not advance its clock", async () => {
  const { storage, cleanup } = await testStorage();
  try {
    const original = foreignEvent(1, 1_900_000_000_000);
    const conflicting = { ...foreignEvent(2, 2_900_000_000_000), eventId: original.eventId };
    const results = await storage.appendChatEvents([original, conflicting, original]);
    assert.deepEqual(results.map((result) => result.status), ["appended", "conflict", "duplicate"]);
    assert.equal((await storage.getChatEventClock()).wallMs, 1_900_000_000_000);
    assert.equal((await storage.listChatEvents(original.conversationId, original.logScopeId)).length, 1);
  } finally { await cleanup(); }
});

test("clock upgrade restores old and foreign clocks without loading event payloads", async () => {
  const { storage, sql, reopen, cleanup } = await testStorage();
  try {
    const legacy = createSignedChatEvent(createChatEventDeviceIdentity("2026-08-06T00:00:00.000Z"), {
      ...localRequest("legacy-chat"), originSeq: 50, createdAt: "2031-01-01T00:00:00.000Z"
    });
    await storage.appendChatEvents([foreignEvent(1, 1_900_000_000_000), legacy]);
    await sql("delete from schema_meta where key = 'chat-event-clock-v1';");
    const restarted = reopen();
    const originalQuery = (restarted as any).queryJson.bind(restarted);
    (restarted as any).queryJson = async (query: string) => {
      const result = await originalQuery(query);
      if (query.includes("rowid as rowId")) {
        assert.ok(JSON.stringify(result).length < 1000);
        assert.ok(result.every((row: object) => !("payload" in row) && !("envelopeHex" in row)));
      }
      return result;
    };
    const next = await new ChatEventLogService(restarted, fixedClock()).appendLocalEvent(localRequest("new-chat"));
    assert.ok(next.event.logicalTs > logicalOrderKey(legacy));
  } finally { await cleanup(); }
});

test("concurrent first receives share one clock upgrade scan", async () => {
  const { storage, cleanup } = await testStorage();
  try {
    let scans = 0;
    const query = (storage as any).queryJson.bind(storage);
    (storage as any).queryJson = async (sql: string) => {
      if (sql.includes("coalesce(max(rowid)")) scans++;
      return query(sql);
    };
    await Promise.all(Array.from({ length: 8 }, (_, i) => storage.appendChatEvent(foreignEvent(i + 1, 1_900_000_000_000 + i))));
    assert.equal(scans, 1);
    assert.equal((await storage.getChatEventClock()).wallMs, 1_900_000_000_007);
  } finally { await cleanup(); }
});

test("corrupt persisted clock refuses to mint rather than silently resetting order", async () => {
  const { storage, sql, reopen, cleanup } = await testStorage();
  try {
    await storage.getChatEventClock();
    for (const corrupt of ["broken", ""]) {
      await sql(`update schema_meta set value = '${corrupt}' where key = 'chat-event-clock-v1';`);
      await assert.rejects(
        new ChatEventLogService(reopen(), fixedClock()).appendLocalEvent(localRequest("new-chat")),
        /clock is unreadable/
      );
    }
    assert.deepEqual(await storage.listChatEvents("new-chat", "new-chat"), []);
  } finally { await cleanup(); }
});

test("concurrent local scopes share one monotonically advancing machine clock", async () => {
  const { storage, reopen, cleanup } = await testStorage();
  try {
    const log = new ChatEventLogService(storage, fixedClock());
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => log.appendLocalEvent(localRequest(`chat-${i}`))));
    for (let i = 1; i < results.length; i++) assert.ok(results[i].event.logicalTs > results[i - 1].event.logicalTs);
    const restarted = new ChatEventLogService(reopen(), () => new Date(0));
    const next = await restarted.appendLocalEvent(localRequest("fresh-chat"));
    assert.ok(next.event.logicalTs > results[results.length - 1].event.logicalTs);
  } finally { await cleanup(); }
});

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

async function testStorage(): Promise<{
  storage: StorageService; reopen: () => StorageService; sql: (query: string) => Promise<void>; cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-chat-event-log-"));
  const storage = Object.create(StorageService.prototype) as any;
  storage.dbPath = path.join(directory, "accordagents.sqlite3");
  storage.initialized = false;
  await storage.init();
  return {
    storage: storage as StorageService,
    reopen: () => new StorageService({ dbPath: storage.dbPath }),
    sql: (query) => storage.runSql(query),
    cleanup: async () => {
      await rm(directory, { recursive: true, force: true });
    }
  };
}

function localRequest(scope: string) {
  return { conversationId: scope, logScopeId: scope, kind: "message.created", payload: { message: message("m", "hello") } };
}

const foreignIdentity = createChatEventDeviceIdentity("2026-08-06T00:00:00.000Z");
function foreignEvent(originSeq: number, wallMs: number) {
  return createSignedChatEvent(foreignIdentity, {
    ...localRequest("foreign-chat"), originSeq, createdAt: new Date(wallMs).toISOString(),
    logicalTs: formatHlcKey({ wallMs, counter: 9, originId: foreignIdentity.originId })
  });
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
