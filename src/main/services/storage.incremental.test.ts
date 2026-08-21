import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { StorageService } from "./storage";
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
