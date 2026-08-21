import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PREVIOUS_STORAGE_SCHEMA_VERSION, StorageService } from "./storage";
import { resolveSqliteExecutable } from "./sqliteCli";
import type { ChatMessage, Conversation } from "../../shared/types";

const SQLITE_EXECUTABLE = resolveSqliteExecutable({ appPath: process.cwd() });

function message(id: string, content: string, index: number): ChatMessage {
  return {
    id,
    role: "user",
    content,
    createdAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    metadata: {}
  };
}

function conversation(messages: ChatMessage[]): Conversation {
  return {
    id: "chat-1",
    title: "Chat",
    kind: "chat",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messages,
    findings: [],
    metadata: {}
  } as Conversation;
}

async function openStorage(): Promise<{ storage: StorageService; directory: string; sql: string[] }> {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-storage-incremental-"));
  const storage = new StorageService({
    dbPath: path.join(directory, "accordagents.sqlite3"),
    sqliteExecutable: SQLITE_EXECUTABLE
  });
  const sql: string[] = [];
  const raw = storage as unknown as { runSql(statement: string, timeoutMs?: number): Promise<void> };
  const original = raw.runSql.bind(storage);
  raw.runSql = async (statement: string, timeoutMs?: number) => {
    sql.push(statement);
    await original(statement, timeoutMs);
  };
  return { storage, directory, sql };
}

function messageWrites(statement: string): number {
  return statement.split("insert into conversation_messages").length - 1;
}

async function storedMessageIds(storage: StorageService, id: string): Promise<string[]> {
  const rows = await (storage as unknown as {
    queryJson(sql: string): Promise<Array<{ messageId: string }>>;
  }).queryJson(
    `select message_id as messageId from conversation_messages where conversation_id = '${id}' order by sequence;`
  );
  return rows.map((row) => row.messageId);
}

test("appending one message to a long chat writes one row, not the whole chat", async () => {
  const { storage, directory, sql } = await openStorage();
  try {
    const messages = Array.from({ length: 400 }, (_, index) => message(`m-${index}`, `body ${index}`, index));
    await storage.saveConversation(conversation(messages));
    sql.length = 0;

    await storage.saveConversation(conversation([...messages, message("m-400", "new", 400)]));

    const writes = sql.reduce((total, statement) => total + messageWrites(statement), 0);
    assert.equal(writes, 1, `expected a single row write, saw ${writes}`);
    assert.deepEqual(
      (await storedMessageIds(storage, "chat-1")).slice(-2),
      ["m-399", "m-400"]
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("editing one message in the middle writes only that row", async () => {
  const { storage, directory, sql } = await openStorage();
  try {
    const messages = Array.from({ length: 50 }, (_, index) => message(`m-${index}`, `body ${index}`, index));
    await storage.saveConversation(conversation(messages));
    sql.length = 0;

    const edited = messages.map((item, index) => index === 20 ? { ...item, content: "corrected" } : item);
    await storage.saveConversation(conversation(edited));

    const writes = sql.reduce((total, statement) => total + messageWrites(statement), 0);
    assert.equal(writes, 1, `expected a single row write, saw ${writes}`);
    const page = await storage.listConversationMessages({ conversationId: "chat-1", limit: 50 });
    assert.equal(page.messages.find((item) => item.id === "m-20")?.content, "corrected");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a message spliced into the middle does not collide with its own id at another sequence", async () => {
  // The chat service inserts a message into the middle of the array rather than
  // only appending. That shifts every later message's sequence while its content
  // stays identical, so deciding by content alone would leave stale sequences
  // behind and re-insert a message id that still exists at another sequence,
  // which `unique (conversation_id, message_id)` rejects and which would fail
  // the whole save.
  const { storage, directory } = await openStorage();
  try {
    const messages = Array.from({ length: 20 }, (_, index) => message(`m-${index}`, `body ${index}`, index));
    await storage.saveConversation(conversation(messages));

    const spliced = [...messages];
    spliced.splice(5, 0, message("inserted", "wedged in", 99));
    await storage.saveConversation(conversation(spliced));

    assert.deepEqual(
      await storedMessageIds(storage, "chat-1"),
      spliced.map((item) => item.id),
      "the stored rows must match the in-memory array exactly, in order"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("removing messages from the middle leaves no orphaned rows behind", async () => {
  const { storage, directory } = await openStorage();
  try {
    const messages = Array.from({ length: 30 }, (_, index) => message(`m-${index}`, `body ${index}`, index));
    await storage.saveConversation(conversation(messages));

    const removed = messages.filter((item) => !["m-3", "m-4", "m-29"].includes(item.id));
    await storage.saveConversation(conversation(removed));

    assert.deepEqual(await storedMessageIds(storage, "chat-1"), removed.map((item) => item.id));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a write from another app instance is not spliced into, it forces a full rewrite", async () => {
  // A second instance shares this database. Without the ownership check, this
  // process would skip rows the other one changed and truncate its appends,
  // leaving a state neither instance ever wrote.
  const { storage, directory } = await openStorage();
  try {
    const messages = Array.from({ length: 10 }, (_, index) => message(`m-${index}`, `body ${index}`, index));
    await storage.saveConversation(conversation(messages));

    const other = new StorageService({
      dbPath: (storage as unknown as { dbPath: string }).dbPath,
      sqliteExecutable: SQLITE_EXECUTABLE
    });
    const foreign = [...messages, message("from-other-instance", "theirs", 10)];
    await other.saveConversation(conversation(foreign));

    const mine = [...messages, message("mine", "ours", 10)];
    await storage.saveConversation(conversation(mine));

    assert.deepEqual(
      await storedMessageIds(storage, "chat-1"),
      mine.map((item) => item.id),
      "last writer wins as a whole conversation, never a mix of both"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a conversation survives a save and reload unchanged", async () => {
  const { storage, directory } = await openStorage();
  try {
    const messages = Array.from({ length: 12 }, (_, index) => message(`m-${index}`, `body ${index}`, index));
    const chat = conversation(messages);
    await storage.saveConversation(chat);
    await storage.saveConversation({ ...chat, messages: [...messages, message("m-12", "later", 12)] });

    const loaded = await storage.getConversation("chat-1");
    assert.equal(loaded?.messages.length, 13);
    assert.deepEqual(loaded?.messages.map((item) => item.id), [...messages.map((item) => item.id), "m-12"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a saved conversation stops carrying a second full copy of itself", async () => {
  const { storage, directory } = await openStorage();
  try {
    const messages = Array.from({ length: 40 }, (_, index) =>
      message(`m-${index}`, `a reasonably wordy message body number ${index}`, index));
    await storage.saveConversation(conversation(messages));

    const rows = await (storage as unknown as {
      queryJson(sql: string): Promise<Array<{ payloadLength: number; bodyLength: number }>>;
    }).queryJson(
      `select length(payload_json) as payloadLength, length(body_json) as bodyLength
       from conversations where id = 'chat-1';`
    );
    const stored = rows[0];
    assert.ok(stored, "the conversation row must exist");
    // The messages live in their own rows. Duplicating them in the conversation
    // row is what made every save cost megabytes.
    assert.equal(
      stored.payloadLength <= stored.bodyLength,
      true,
      `payload_json (${stored.payloadLength}) must not exceed body_json (${stored.bodyLength})`
    );
    assert.equal(
      (await storage.getConversation("chat-1"))?.messages.length,
      40,
      "the conversation still reads back whole"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a conversation written before the split still reads back whole", async () => {
  const { storage, directory } = await openStorage();
  try {
    // Seed the row the way an older build wrote it: everything inside
    // payload_json, no body and no message rows at all. The first read creates
    // the schema.
    await storage.getConversation("does-not-exist");
    const legacy = conversation([message("legacy-0", "written by an older build", 0)]);
    await (storage as unknown as { runSql(sql: string): Promise<void> }).runSql(`
      insert into conversations (id, title, kind, created_at, updated_at, repo_path, payload_json)
      values ('legacy-chat', 'Legacy', 'chat', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
        null, '${JSON.stringify({ ...legacy, id: "legacy-chat" }).replace(/'/g, "''")}');
    `);

    const loaded = await storage.getConversation("legacy-chat");
    assert.equal(loaded?.messages.length, 1, "the legacy payload is still the source when nothing was split out");
    assert.equal(loaded?.messages[0].content, "written by an older build");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("no query reads the conversation payload without its body fallback", async () => {
  // Reading `conversations.payload_json` directly means reading a copy that is
  // no longer written, so it would act on a frozen snapshot. Conversation-level
  // reads must go through the body, with payload only as the fallback for rows
  // that predate the split. Per-message `conversation_messages.payload_json` is
  // a different column and stays as it is; the backfill migration is the one
  // sanctioned reader of the legacy payload, since converting it is its job.
  const source = await readFile(path.join(process.cwd(), "src", "main", "services", "storage.ts"), "utf8");
  const backfillStart = source.indexOf("private async backfillConversationBodiesAndMessages");
  assert.ok(backfillStart > 0, "the backfill migration should still exist");
  const backfillEnd = source.indexOf("\n  private async ", backfillStart + 1);
  const guarded = source.slice(0, backfillStart) + source.slice(backfillEnd);

  const conversationLevelReads = [
    "select payload_json from conversations",
    "json_extract(payload_json, '$.metadata.running')",
    "json_extract(payload_json, '$.metadata.archived')",
    "json_extract(payload_json, '$.metadata.participants')",
    "json_array_length(payload_json, '$.metadata.activeRunIds')"
  ];
  for (const shape of conversationLevelReads) {
    assert.equal(guarded.includes(shape), false, `storage.ts still reads the frozen payload: ${shape}`);
  }

  // A `like` prefilter over the conversation row is only allowed when it is
  // explicitly scoped to rows that have no body yet.
  const unguardedPrefilters = guarded.split("\n").filter((line) =>
    /(?<!m\.)payload_json like/.test(line) && !/coalesce\(body_json, ''\) = ''/.test(line)
  );
  assert.deepEqual(unguardedPrefilters.map((line) => line.trim()), []);
});

test("a failed statement rolls the whole save back instead of committing half of it", async () => {
  // The sqlite3 CLI carries on past a failed statement by default and commits
  // what the rest of the batch wrote, so a save that fails part way through
  // would leave a half-applied conversation on disk. Verified against a real
  // database rather than asserted from the flag.
  const { storage, directory } = await openStorage();
  try {
    const messages = Array.from({ length: 5 }, (_, index) => message(`m-${index}`, `body ${index}`, index));
    await storage.saveConversation(conversation(messages));
    const before = await storedMessageIds(storage, "chat-1");

    const raw = storage as unknown as { runSql(sql: string): Promise<void> };
    await assert.rejects(() => raw.runSql(`
      begin immediate;
      insert into conversation_messages (conversation_id, sequence, message_id, created_at, payload_json)
        values ('chat-1', 99, 'survivor', '2026-01-01T00:00:99.000Z', '{}');
      insert into conversation_messages (conversation_id, sequence, message_id, created_at, payload_json)
        values ('chat-1', 100, 'm-0', '2026-01-01T00:01:00.000Z', '{}');
      insert into conversation_messages (conversation_id, sequence, message_id, created_at, payload_json)
        values ('chat-1', 101, 'after', '2026-01-01T00:01:01.000Z', '{}');
      commit;
    `));

    assert.deepEqual(
      await storedMessageIds(storage, "chat-1"),
      before,
      "nothing from the failed batch may survive, not even the statements that succeeded"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("upgrading an older database leaves a copy of it next to the live one", async () => {
  const { storage, directory } = await openStorage();
  try {
    // A database an older build left behind: schema 1, no body, no message rows.
    await storage.getConversation("does-not-exist");
    const raw = storage as unknown as { runSql(sql: string): Promise<void>; initialized: boolean };
    await raw.runSql(`
      update schema_meta set value = '1' where key = 'storage-schema-version';
      insert into conversations (id, title, kind, created_at, updated_at, repo_path, payload_json)
      values ('old-chat', 'Old', 'chat', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', null,
        '${JSON.stringify({ ...conversation([message("old-0", "from the previous version", 0)]), id: "old-chat" }).replace(/'/g, "''")}');
    `);
    raw.initialized = false;

    await storage.getConversation("old-chat");

    const backup = path.join(directory, "accordagents.sqlite3.schema-1.bak");
    const copied = await readFile(backup).then(() => true, () => false);
    assert.equal(copied, true, `expected a pre-upgrade copy at ${backup}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a database can be put back into the shape an older version opens", async () => {
  // Raising the schema version stops an older build from destroying this
  // database, but it also locks that build out. This is the way back.
  const { storage, directory } = await openStorage();
  try {
    const messages = Array.from({ length: 8 }, (_, index) => message(`m-${index}`, `body ${index}`, index));
    await storage.saveConversation(conversation(messages));

    const result = await storage.prepareStorageForOlderVersion();
    assert.equal(result.schemaVersion, PREVIOUS_STORAGE_SCHEMA_VERSION);

    const raw = storage as unknown as {
      queryJson(sql: string): Promise<Array<{ payloadHex: string; storedVersion: string }>>;
    };
    const rows = await raw.queryJson(`
      select hex(payload_json) as payloadHex,
        (select value from schema_meta where key = 'storage-schema-version') as storedVersion
      from conversations where id = 'chat-1';
    `);
    assert.equal(rows[0]?.storedVersion, String(PREVIOUS_STORAGE_SCHEMA_VERSION));
    // What an older build reads is `payload_json`, and it must be the whole
    // conversation again — in order, nothing missing.
    const restored = JSON.parse(Buffer.from(rows[0].payloadHex, "hex").toString("utf8")) as Conversation;
    assert.deepEqual(restored.messages.map((item) => item.id), messages.map((item) => item.id));
    assert.equal(restored.messages[3].content, "body 3");
    assert.equal(restored.title, "Chat");

    // And the current build still reads it correctly afterwards.
    assert.equal((await storage.getConversation("chat-1"))?.messages.length, 8);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
