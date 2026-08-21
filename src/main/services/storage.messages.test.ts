import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  STORAGE_SCHEMA_VERSION_META_KEY,
  SUPPORTED_STORAGE_SCHEMA_VERSION,
  StorageService,
  UnsupportedStorageSchemaVersionError
} from "./storage";
import { resolveSqliteExecutable } from "./sqliteCli";
import type { ChatEventEnvelope } from "../../shared/chatEvents";
import type { ChatMessage, Conversation } from "../../shared/types";

function hexJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("hex").toUpperCase();
}

const SQLITE_EXECUTABLE = resolveSqliteExecutable({ appPath: process.cwd() });

function fakeStorage(queryJson: (sql: string) => Promise<unknown[]>): StorageService {
  const storage = Object.create(StorageService.prototype) as any;
  storage.init = async () => {};
  storage.queryJson = queryJson;
  return storage as StorageService;
}

test("openConversation returns a message window consistent with messagePage", async () => {
  const storage = Object.create(StorageService.prototype) as any;
  storage.init = async () => {};
  // body_json carries an emptied messages array; the window comes from conversation_messages.
  storage.queryText = async () => JSON.stringify({
    id: "conversation",
    title: "Long chat",
    kind: "chat",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:05.000Z",
    messages: [],
    findings: [],
    metadata: {}
  });
  storage.queryJson = async (sql: string) => {
    if (sql.includes("hex(payload_json) as payloadHex")) {
      // newest-first; limit+1 rows so hasMoreBefore is true
      return [4, 3, 2].map((sequence) => ({
        sequence,
        payloadHex: hexJson({ id: `m-${sequence}`, role: "user", content: `m${sequence}`, createdAt: "2026-01-01T00:00:0" + sequence + ".000Z" })
      }));
    }
    if (sql.includes("count(*) as totalMessages")) {
      return [{ totalMessages: 5 }];
    }
    return [];
  };

  const result = await (storage as StorageService).openConversation("conversation", 2);
  assert.ok(result);
  // messages must equal the window (2), not the full history (5).
  assert.equal(result!.conversation.messages.length, 2);
  assert.deepEqual(result!.conversation.messages.map((m) => m.id), ["m-3", "m-4"]);
  assert.equal(result!.messagePage.totalMessages, 5);
  assert.equal(result!.messagePage.hasMoreBefore, true);
  assert.equal(result!.messagePage.oldestSequence, 3);
});

test("listConversationMessages decodes an escape-heavy message recipe", async () => {
  const [sequence, quoteCount, backslashCount] = [32, 36_182, 66_535];
  const count = (value: string, character: string) => value.length - value.replaceAll(character, "").length;
  const generateData = (): string => {
    const start = "{\"id\":\"x\",\"role\":\"participant\",\"content\":\"";
    const end = "\",\"createdAt\":\"2026-01-01T00:00:00.000Z\"}";
    const contentQuotes = quoteCount - count(start + end, "\"");
    const remainingBackslashes = backslashCount - contentQuotes;
    return start + "\\\"".repeat(contentQuotes)
      + "\\\\".repeat(Math.floor(remainingBackslashes / 2))
      + (remainingBackslashes % 2 ? "\\n" : "") + end;
  };
  const payloadJson = generateData();

  assert.equal(count(payloadJson, "\""), quoteCount);
  assert.equal(count(payloadJson, "\\"), backslashCount);

  const storage = fakeStorage(async (sql) => sql.includes("hex(payload_json) as payloadHex")
    ? [{
        sequence,
        payloadHex: Buffer.from(payloadJson, "utf8").toString("hex")
      }]
    : [{ totalMessages: 1 }]);
  const page = await storage.listConversationMessages({ conversationId: "redacted-conversation", limit: 1 });

  assert.deepEqual(page.messages, [JSON.parse(payloadJson) as ChatMessage]);
});

test("listConversationMessages can page around a target message id", async () => {
  const queries: string[] = [];
  const storage = fakeStorage(async (sql) => {
    queries.push(sql);
    if (sql.includes("select sequence") && sql.includes("message_id")) {
      return [{ sequence: 3 }];
    }
    if (sql.includes("hex(payload_json) as payloadHex")) {
      return [
        { sequence: 3, payloadHex: hexJson({ id: "target", role: "user", content: "target", createdAt: "2026-01-01T00:00:03.000Z" }) },
        { sequence: 2, payloadHex: hexJson({ id: "before", role: "user", content: "before", createdAt: "2026-01-01T00:00:02.000Z" }) },
        { sequence: 1, payloadHex: hexJson({ id: "older", role: "user", content: "older", createdAt: "2026-01-01T00:00:01.000Z" }) }
      ];
    }
    if (sql.includes("count(*) as totalMessages")) {
      return [{ totalMessages: 5 }];
    }
    return [];
  });

  const page = await storage.listConversationMessages({ conversationId: "conversation", aroundMessageId: "target", limit: 2 });

  assert.match(queries[1], /sequence <= 3/);
  assert.deepEqual(page.messages.map((message) => message.id), ["before", "target"]);
  assert.equal(page.oldestSequence, 2);
  assert.equal(page.newestSequence, 3);
  assert.equal(page.hasMoreBefore, true);
  assert.equal(page.totalMessages, 5);
});

test("listConversationMessages round-trips large escape-dense output across adjacent SQLite pages", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-storage-messages-"));
  const storage = Object.create(StorageService.prototype) as any;
  storage.dbPath = path.join(directory, "accordagents.sqlite3");
  storage.sqliteExecutable = SQLITE_EXECUTABLE;
  storage.initialized = true;
  const denseContent = `quotes "' slash \\\\ tabs\t lines\n separators \u001e\u001f unicode 🙂 lone \ud800 `
    .repeat(12_000);
  const messages: ChatMessage[] = [0, 1, 2, 3].map((sequence) => ({
    id: `dense-${sequence}`,
    role: sequence % 2 === 0 ? "user" : "participant",
    ...(sequence % 2 === 0 ? {} : {
      participantId: "participant-codex",
      participantLabel: "@codex",
      status: "done" as const
    }),
    content: sequence === 1 ? denseContent : `message-${sequence}`,
    createdAt: `2026-01-01T00:00:0${sequence}.000Z`,
    metadata: sequence === 1 ? { runId: "run-dense", nested: { ordered: ["a", "b"] } } : {}
  }));
  const chat = basicConversation("dense-chat", messages);

  try {
    await storage.runSql(`
      create table conversations (
        id text primary key, title text not null, kind text not null, created_at text not null,
        updated_at text not null, repo_path text, body_json text, save_token text, payload_json text not null
      );
      create table conversation_messages (
        conversation_id text not null, sequence integer not null, message_id text not null,
        created_at text not null, payload_json text not null,
        primary key (conversation_id, sequence), unique (conversation_id, message_id)
      );
    `);
    await storage.saveConversation(chat);

    const newest = await storage.listConversationMessages({ conversationId: chat.id, limit: 2 });
    const older = await storage.listConversationMessages({
      conversationId: chat.id,
      beforeSequence: newest.oldestSequence,
      limit: 2
    });

    assert.deepEqual([...older.messages, ...newest.messages], messages);
    assert.equal(older.hasMoreBefore, false);
    assert.equal(newest.hasMoreBefore, true);
    assert.equal(newest.totalMessages, messages.length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("listConversationMessages rejects malformed hexadecimal transport", async (context) => {
  const cases = [
    { name: "non-hexadecimal", payloadHex: "not-hex", error: /Invalid hexadecimal JSON/ },
    { name: "odd-length", payloadHex: "F", error: /Invalid hexadecimal JSON/ },
    { name: "invalid UTF-8", payloadHex: "FF", error: /Invalid UTF-8 JSON/ },
    { name: "invalid JSON", payloadHex: Buffer.from("not JSON", "utf8").toString("hex"), error: /Invalid JSON/ }
  ];
  for (const testCase of cases) {
    await context.test(testCase.name, async () => {
      const storage = fakeStorage(async (sql) => {
        if (sql.includes("hex(payload_json) as payloadHex")) {
          return [{ sequence: 1, payloadHex: testCase.payloadHex }];
        }
        if (sql.includes("count(*) as totalMessages")) {
          return [{ totalMessages: 1 }];
        }
        return [];
      });

      await assert.rejects(
        () => storage.listConversationMessages({ conversationId: "conversation", limit: 1 }),
        testCase.error
      );
    });
  }
});

test("listConversations normalizes the archived flag from json_extract values", async () => {
  const storage = fakeStorage(async (sql) => {
    if (sql.includes("from conversations") && sql.includes("metadata.archived")) {
      return [
        { id: "a", title: "Archived int", kind: "chat", createdAt: "", updatedAt: "", archived: 1 },
        { id: "b", title: "Archived str", kind: "chat", createdAt: "", updatedAt: "", archived: "1" },
        { id: "c", title: "Archived bool", kind: "chat", createdAt: "", updatedAt: "", archived: true },
        { id: "d", title: "Not archived null", kind: "chat", createdAt: "", updatedAt: "", archived: null },
        { id: "e", title: "Not archived zero", kind: "chat", createdAt: "", updatedAt: "", archived: 0 }
      ];
    }
    throw new Error(`Unexpected query: ${sql}`);
  });

  const summaries = await storage.listConversations();

  assert.deepEqual(
    summaries.map((summary) => [summary.id, summary.archived]),
    [["a", true], ["b", true], ["c", true], ["d", false], ["e", false]]
  );
});

test("listConversations includes normalized chat participant refs", async () => {
  const storage = fakeStorage(async (sql) => {
    if (sql.includes("from conversations") && sql.includes("metadata.participants")) {
      return [
        {
          id: "chat",
          title: "Chat",
          kind: "chat",
          createdAt: "",
          updatedAt: "",
          archived: 0,
          chatParticipantsJson: JSON.stringify([
            { participantConfigId: " saved-drew ", handle: "@drew-codex-engineer", kind: "codex-cli", ignored: true },
            { handle: "taylor-claude-engineer", kind: "claude-code" },
            { participantConfigId: "invalid", handle: "", kind: "codex-cli" },
            { participantConfigId: "invalid-kind", handle: "jamie", kind: "openai" }
          ])
        },
        {
          id: "plan",
          title: "Plan",
          kind: "implementation-plan",
          createdAt: "",
          updatedAt: "",
          archived: 0,
          chatParticipantsJson: JSON.stringify([{ participantConfigId: "ignored", handle: "ignored", kind: "codex-cli" }])
        }
      ];
    }
    throw new Error(`Unexpected query: ${sql}`);
  });

  const summaries = await storage.listConversations();

  assert.deepEqual(summaries[0].chatParticipants, [
    { participantConfigId: "saved-drew", handle: "drew-codex-engineer", kind: "codex-cli" },
    { handle: "taylor-claude-engineer", kind: "claude-code" }
  ]);
  assert.equal(summaries[1].chatParticipants, undefined);
});

test("listConversationMessages returns an empty page when target message id is missing", async () => {
  const storage = fakeStorage(async (sql) => {
    if (sql.includes("select sequence") && sql.includes("message_id")) {
      return [];
    }
    if (sql.includes("count(*) as totalMessages")) {
      return [{ totalMessages: 4 }];
    }
    throw new Error(`Unexpected query: ${sql}`);
  });

  const page = await storage.listConversationMessages({ conversationId: "conversation", aroundMessageId: "missing", limit: 2 });

  assert.deepEqual(page.messages, []);
  assert.equal(page.oldestSequence, undefined);
  assert.equal(page.newestSequence, undefined);
  assert.equal(page.hasMoreBefore, false);
  assert.equal(page.totalMessages, 4);
});

test("normalizeInferredParticipantRequestThreads runs once and avoids blob queryJson", async () => {
  const legacy = legacyInferredConversation();
  const { storage, queryJsonSql, queryTextSql, runSqlStatements, saved } = maintenanceStorage({
    ids: [legacy.id],
    payloads: new Map([[legacy.id, JSON.stringify(legacy)]])
  });

  await (storage as any).normalizeInferredParticipantRequestThreads();

  assert.equal(saved.length, 1);
  assert.equal(saved[0].messages.find((message) => message.id === "legacy-request")?.metadata?.hiddenFromTimeline, true);
  assert.equal(saved[0].messages.find((message) => message.id === "legacy-reply")?.metadata?.chatThreadRootId, "source-root");
  // Two reads: the id prefilter, then that conversation's message rows. Neither
  // pulls a conversation-sized blob through queryJson.
  assert.equal(queryJsonSql.length, 2);
  assert.match(queryJsonSql[0], /select id from conversations/);
  assert.doesNotMatch(queryJsonSql[0], /payload_json as payloadJson/);
  // This marker lives in message metadata, so the prefilter has to look in the
  // message rows; the body does not contain it.
  assert.match(queryJsonSql[0], /from conversation_messages/);
  assert.match(queryJsonSql[1], /from conversation_messages/);
  assert.ok(queryTextSql.some((sql) => /coalesce\(nullif\(body_json/.test(sql)));
  assert.equal(queryTextSql.some((sql) => sql.includes("select payload_json from conversations")), false);
  assert.ok(runSqlStatements.some((sql) => sql.includes("inferred-participant-request-threads-v1") && sql.includes("complete")));
});

test("normalizeInferredParticipantRequestThreads skips when migration is marked complete", async () => {
  const { storage, queryJsonSql, queryTextSql, runSqlStatements } = maintenanceStorage({
    metaValue: "complete"
  });

  await (storage as any).normalizeInferredParticipantRequestThreads();

  assert.deepEqual(queryJsonSql, []);
  assert.equal(queryTextSql.length, 1);
  assert.match(queryTextSql[0], /schema_meta/);
  assert.deepEqual(runSqlStatements, []);
});

test("normalizeInferredParticipantRequestThreads marks zero-row migration complete", async () => {
  const { storage, runSqlStatements } = maintenanceStorage({ ids: [] });

  await (storage as any).normalizeInferredParticipantRequestThreads();

  assert.ok(runSqlStatements.some((sql) => sql.includes("inferred-participant-request-threads-v1") && sql.includes("complete")));
});

test("normalizeInferredParticipantRequestThreads does not mark complete when saving fails", async () => {
  const legacy = legacyInferredConversation();
  const { storage, runSqlStatements } = maintenanceStorage({
    ids: [legacy.id],
    payloads: new Map([[legacy.id, JSON.stringify(legacy)]]),
    saveError: new Error("write failed")
  });

  await assert.rejects(() => (storage as any).normalizeInferredParticipantRequestThreads(), /write failed/);

  assert.equal(runSqlStatements.some((sql) => sql.includes("inferred-participant-request-threads-v1")), false);
});

test("clearInterruptedRuns reads payloads by id and preserves local run state", async () => {
  const conversation = basicConversation("running-conversation", [
    {
      id: "pending",
      role: "participant",
      participantId: "participant",
      participantLabel: "@participant",
      content: "contains newline\nand separator \u001f safely",
      createdAt: "2026-01-01T00:00:01.000Z",
      status: "pending",
      metadata: {}
    }
  ]);
  conversation.metadata = { running: true, runId: "stale-run" };
  const { storage, queryJsonSql, saved } = maintenanceStorage({
    ids: [conversation.id],
    payloads: new Map([[conversation.id, JSON.stringify(conversation)]])
  });

  await (storage as any).clearInterruptedRuns();

  assert.equal(saved.length, 0);
  // The id prefilter, then that conversation's message rows.
  assert.equal(queryJsonSql.length, 2);
  assert.match(queryJsonSql[0], /select id from conversations/);
  assert.doesNotMatch(queryJsonSql[0], /payload_json as payloadJson/);
  // Run state is read from the body, not from the frozen full payload.
  assert.match(queryJsonSql[0], /coalesce\(nullif\(body_json/);
  assert.match(queryJsonSql[1], /from conversation_messages/);
});

test("deleteConversation removes messages and conversation in one transaction", async () => {
  const statements: string[] = [];
  const storage = Object.create(StorageService.prototype) as any;
  storage.initialized = true;
  storage.queryText = async () => "conversation-1";
  storage.runSql = async (sql: string) => {
    statements.push(sql);
  };

  assert.equal(await (storage as StorageService).deleteConversation("conversation-1"), true);
  assert.equal(statements.length, 1);
  assert.match(statements[0], /^\s*begin;/);
  assert.match(statements[0], /delete from conversation_messages where conversation_id = 'conversation-1'/);
  assert.match(statements[0], /delete from conversations where id = 'conversation-1'/);
  assert.match(statements[0], /commit;/);
});

test("init records the supported storage schema version for a legacy database", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-storage-floor-"));
  const storage = Object.create(StorageService.prototype) as any;
  const runSqlStatements: string[] = [];
  const queryTextSql: string[] = [];
  const calls: string[] = [];
  storage.dbPath = path.join(directory, "accordagents.sqlite3");
  storage.initialized = false;
  storage.runSql = async (sql: string) => {
    runSqlStatements.push(sql);
  };
  storage.queryText = async (sql: string) => {
    queryTextSql.push(sql);
    return "";
  };
  storage.pruneStaleRunCancelRequests = async () => calls.push("prune");
  storage.ensureColumn = async () => calls.push("ensureColumn");
  storage.backfillConversationBodiesAndMessages = async () => calls.push("backfill");
  storage.normalizeInferredParticipantRequestThreads = async () => calls.push("normalize");
  storage.clearInterruptedRuns = async () => calls.push("clear");

  try {
    await (storage as StorageService).init();

    assert.equal(storage.initialized, true);
    assert.match(runSqlStatements[0], /create table if not exists schema_meta/);
    assert.match(queryTextSql[0], new RegExp(STORAGE_SCHEMA_VERSION_META_KEY));
    // Two columns are ensured: body_json, then save_token.
    assert.deepEqual(calls, ["prune", "ensureColumn", "ensureColumn", "backfill", "normalize", "clear"]);
    assert.ok(runSqlStatements.some((sql) =>
      sql.includes(STORAGE_SCHEMA_VERSION_META_KEY) &&
      sql.includes(String(SUPPORTED_STORAGE_SCHEMA_VERSION))
    ));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("init refuses a database written by a newer storage schema before migrations run", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-storage-floor-newer-"));
  const storage = Object.create(StorageService.prototype) as any;
  const runSqlStatements: string[] = [];
  const queryTextSql: string[] = [];
  storage.dbPath = path.join(directory, "accordagents.sqlite3");
  storage.initialized = false;
  storage.runSql = async (sql: string) => {
    runSqlStatements.push(sql);
  };
  storage.queryText = async (sql: string) => {
    queryTextSql.push(sql);
    return String(SUPPORTED_STORAGE_SCHEMA_VERSION + 1);
  };
  storage.pruneStaleRunCancelRequests = async () => {
    throw new Error("migration should not run");
  };
  storage.ensureColumn = async () => {
    throw new Error("migration should not run");
  };
  storage.backfillConversationBodiesAndMessages = async () => {
    throw new Error("migration should not run");
  };

  try {
    await assert.rejects(
      () => (storage as StorageService).init(),
      UnsupportedStorageSchemaVersionError
    );

    assert.equal(storage.initialized, false);
    assert.equal(runSqlStatements.length, 1);
    assert.match(runSqlStatements[0], /create table if not exists schema_meta/);
    assert.equal(queryTextSql.length, 1);
    assert.match(queryTextSql[0], new RegExp(STORAGE_SCHEMA_VERSION_META_KEY));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sqlite invocations bail on the first error and install the timeout and synchronous pragmas", () => {
  const storage = Object.create(StorageService.prototype) as any;

  // `.bail on` is load-bearing, not cosmetic: without it the CLI continues past
  // a failed statement and commits the rest of the transaction.
  assert.deepEqual(storage.sqliteArgs(["database.sqlite3", "select 1;"]), [
    "-cmd",
    ".timeout 30000",
    "-cmd",
    ".bail on",
    "-cmd",
    "pragma synchronous = normal;",
    "database.sqlite3",
    "select 1;"
  ]);
});

test("appendChatEvent is idempotent and detects visible-scope sequence conflicts", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-storage-events-"));
  const storage = Object.create(StorageService.prototype) as any;
  storage.dbPath = path.join(directory, "accordagents.sqlite3");
  storage.initialized = false;
  const firstEvent = chatEvent({
    eventId: "event-1",
    originSeq: 1,
    payload: { content: "hello" },
    payloadHash: "hash-hello",
    prevHash: "hash-prev"
  });

  try {
    assert.deepEqual(await (storage as StorageService).appendChatEvent(firstEvent), {
      status: "appended",
      eventId: "event-1"
    });
    assert.deepEqual(await (storage as StorageService).appendChatEvent(firstEvent), {
      status: "duplicate",
      eventId: "event-1"
    });

    const conflict = await (storage as StorageService).appendChatEvent(chatEvent({
      eventId: "event-2",
      originSeq: 1,
      payload: { content: "conflict" },
      payloadHash: "hash-conflict"
    }));

    assert.deepEqual(conflict, {
      status: "conflict",
      eventId: "event-2",
      existingEventId: "event-1",
      conflictReason: "origin-sequence-conflict"
    });
    const events = await (storage as StorageService).listChatEvents("conversation-1", "conversation-1");
    assert.deepEqual(events, [firstEvent]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("appendChatEvent detects event id reuse with a different envelope", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-storage-event-id-conflict-"));
  const storage = Object.create(StorageService.prototype) as any;
  storage.dbPath = path.join(directory, "accordagents.sqlite3");
  storage.initialized = false;
  const firstEvent = chatEvent({
    eventId: "event-1",
    originSeq: 1,
    payload: { content: "hello" },
    payloadHash: "hash-hello"
  });

  try {
    await (storage as StorageService).appendChatEvent(firstEvent);
    const conflict = await (storage as StorageService).appendChatEvent({
      ...firstEvent,
      originSeq: 2,
      payload: { content: "different" },
      payloadHash: "hash-different"
    });

    assert.deepEqual(conflict, {
      status: "conflict",
      eventId: "event-1",
      existingEventId: "event-1",
      conflictReason: "event-id-conflict"
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("appendChatEvents preserves input-order results while batching inserts", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-storage-event-batch-"));
  const storage = Object.create(StorageService.prototype) as any;
  storage.dbPath = path.join(directory, "accordagents.sqlite3");
  storage.initialized = false;
  const events = [1, 2, 3].map((sequence) => chatEvent({
    eventId: `event-${sequence}`,
    originSeq: sequence,
    payload: { content: `message-${sequence}` },
    payloadHash: `hash-${sequence}`,
    prevHash: sequence === 1 ? "genesis" : `hash-${sequence - 1}`
  }));

  try {
    assert.deepEqual(await (storage as StorageService).appendChatEvents(events), [
      { status: "appended", eventId: "event-1" },
      { status: "appended", eventId: "event-2" },
      { status: "appended", eventId: "event-3" }
    ]);

    const duplicate = events[1];
    const conflict = chatEvent({
      eventId: "event-4",
      originSeq: 3,
      payload: { content: "conflict" },
      payloadHash: "hash-conflict"
    });
    assert.deepEqual(await (storage as StorageService).appendChatEvents([duplicate, conflict]), [
      { status: "duplicate", eventId: "event-2" },
      {
        status: "conflict",
        eventId: "event-4",
        existingEventId: "event-3",
        conflictReason: "origin-sequence-conflict"
      }
    ]);

    const stored = await (storage as StorageService).listChatEvents("conversation-1", "conversation-1");
    assert.deepEqual(stored.map((event) => event.eventId), ["event-1", "event-2", "event-3"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("chat event projection rows upsert independently from legacy conversation saves", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-storage-projection-"));
  const storage = Object.create(StorageService.prototype) as any;
  storage.dbPath = path.join(directory, "accordagents.sqlite3");
  storage.initialized = false;

  try {
    await (storage as StorageService).saveChatEventProjection({
      conversationId: "conversation-1",
      projectionKey: "messages",
      version: 1,
      lastEventId: "event-1",
      payload: { messageIds: ["message-1"] },
      updatedAt: "2026-08-06T00:00:00.000Z"
    });
    await (storage as StorageService).saveConversation(basicConversation("conversation-1", [
      { id: "message-1", role: "user", content: "hello", createdAt: "2026-08-06T00:00:00.000Z", metadata: {} }
    ]));
    await (storage as StorageService).saveChatEventProjection({
      conversationId: "conversation-1",
      projectionKey: "messages",
      version: 2,
      lastEventId: "event-2",
      payload: { messageIds: ["message-1", "message-2"] },
      updatedAt: "2026-08-06T00:01:00.000Z"
    });

    const row = await (storage as StorageService).getChatEventProjection<{ messageIds: string[] }>(
      "conversation-1",
      "messages"
    );

    assert.deepEqual(row, {
      conversationId: "conversation-1",
      projectionKey: "messages",
      version: 2,
      lastEventId: "event-2",
      payload: { messageIds: ["message-1", "message-2"] },
      updatedAt: "2026-08-06T00:01:00.000Z"
    });
    const stored = await (storage as StorageService).getConversation("conversation-1");
    assert.equal(stored?.messages.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("createPreMigrationBackup produces a standalone SQLite backup", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-storage-backup-"));
  const storage = Object.create(StorageService.prototype) as any;
  storage.dbPath = path.join(directory, "accordagents.sqlite3");
  storage.initialized = false;

  try {
    await (storage as StorageService).saveConversation(basicConversation("backup-chat", [
      { id: "message-1", role: "user", content: "keep me", createdAt: "2026-08-06T00:00:00.000Z", metadata: {} }
    ]));

    const backupPath = await (storage as StorageService).createPreMigrationBackup("event owned conversion");
    const backup = await stat(backupPath);

    assert.equal(path.basename(backupPath), "accordagents.sqlite3.event-owned-conversion.bak");
    assert.ok(backup.size > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function maintenanceStorage(options: {
  ids?: string[];
  payloads?: Map<string, string>;
  metaValue?: string;
  saveError?: Error;
}): {
  storage: StorageService;
  queryJsonSql: string[];
  queryTextSql: string[];
  runSqlStatements: string[];
  saved: Conversation[];
} {
  const queryJsonSql: string[] = [];
  const queryTextSql: string[] = [];
  const runSqlStatements: string[] = [];
  const saved: Conversation[] = [];
  const storage = Object.create(StorageService.prototype) as any;
  // Maintenance reads a conversation the way everything else does now: the body
  // from the conversation row, the messages from their own rows.
  storage.queryJson = async (sql: string) => {
    queryJsonSql.push(sql);
    if (sql.includes("select id from conversations")) {
      return (options.ids ?? []).map((id) => ({ id }));
    }
    if (sql.includes("from conversation_messages")) {
      const id = sql.match(/conversation_id = '([^']+)'/)?.[1];
      const payload = id ? options.payloads?.get(id) : undefined;
      const messages = payload ? (JSON.parse(payload) as Conversation).messages : [];
      return messages.map((message, sequence) => ({ sequence, payloadHex: hexJson(message) }));
    }
    throw new Error(`Unexpected queryJson: ${sql}`);
  };
  storage.queryText = async (sql: string) => {
    queryTextSql.push(sql);
    if (sql.includes("schema_meta")) {
      return options.metaValue ?? "";
    }
    if (sql.includes("from conversations")) {
      const id = sql.match(/where id = '([^']+)'/)?.[1];
      const payload = id ? options.payloads?.get(id) : undefined;
      if (!payload) {
        return "";
      }
      return JSON.stringify({ ...JSON.parse(payload) as Conversation, messages: [] });
    }
    throw new Error(`Unexpected queryText: ${sql}`);
  };
  storage.runSql = async (sql: string) => {
    runSqlStatements.push(sql);
  };
  storage.saveConversation = async (conversation: Conversation) => {
    if (options.saveError) {
      throw options.saveError;
    }
    saved.push(JSON.parse(JSON.stringify(conversation)) as Conversation);
  };
  return { storage: storage as StorageService, queryJsonSql, queryTextSql, runSqlStatements, saved };
}

function chatEvent(overrides: Partial<ChatEventEnvelope<{ content: string }>> = {}): ChatEventEnvelope<{ content: string }> {
  return {
    eventId: "event-1",
    conversationId: "conversation-1",
    logScopeId: "conversation-1",
    originId: "device-1",
    originSeq: 1,
    logicalTs: "0000000000000001",
    kind: "message.created",
    payload: { content: "hello" },
    payloadHash: "hash-hello",
    eventHash: "event-hash-hello",
    signature: "signature-1",
    keyId: "key-1",
    createdAt: "2026-08-06T00:00:00.000Z",
    ...overrides
  };
}

function legacyInferredConversation(): Conversation {
  const source: ChatMessage = {
    id: "source",
    role: "participant",
    participantId: "participant-drew",
    participantLabel: "@drew",
    content: "Ask Taylor.\nIncludes separator \u001f in legacy content.",
    createdAt: "2026-01-01T00:00:01.000Z",
    status: "done",
    metadata: { chatThreadRootId: "source-root" }
  };
  const request: ChatMessage = {
    id: "legacy-request",
    role: "participant",
    participantId: "participant-drew",
    participantLabel: "@drew",
    content: "Taylor request",
    createdAt: "2026-01-01T00:00:02.000Z",
    status: "done",
    metadata: {
      participantRequest: {
        id: "batch",
        requesterParticipantId: "participant-drew",
        requesterHandle: "drew",
        source: "inferred",
        resumeRequester: true,
        status: "answered",
        depth: 1,
        createdAt: "2026-01-01T00:00:02.000Z",
        updatedAt: "2026-01-01T00:00:03.000Z",
        triggerMessageId: "source",
        items: [{
          targetParticipantId: "participant-taylor",
          targetHandle: "taylor",
          prompt: "Review this.",
          status: "answered",
          replyMessageId: "legacy-reply",
          createdAt: "2026-01-01T00:00:02.000Z",
          updatedAt: "2026-01-01T00:00:03.000Z"
        }]
      }
    }
  };
  const reply: ChatMessage = {
    id: "legacy-reply",
    role: "participant",
    participantId: "participant-taylor",
    participantLabel: "@taylor",
    content: "Reviewed.",
    createdAt: "2026-01-01T00:00:03.000Z",
    status: "done",
    metadata: { chatThreadRootId: "legacy-request" }
  };
  return basicConversation("legacy-conversation", [source, request, reply]);
}

function basicConversation(id: string, messages: ChatMessage[]): Conversation {
  return {
    id,
    title: id,
    kind: "chat",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:04.000Z",
    messages,
    findings: [],
    metadata: {}
  };
}
