import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

async function openStorage(): Promise<{ storage: StorageService; directory: string; runSql: (sql: string) => Promise<void> }> {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-storage-ownership-"));
  const storage = new StorageService({
    dbPath: path.join(directory, "accordagents.sqlite3"),
    sqliteExecutable: SQLITE_EXECUTABLE
  });
  const raw = storage as unknown as { runSql(statement: string, timeoutMs?: number): Promise<void> };
  return { storage, directory, runSql: (sql) => raw.runSql.call(storage, sql) };
}

test("a save returns the token it stamped, and the row is owned by that token until anyone else writes it", async () => {
  const { storage, directory, runSql } = await openStorage();
  try {
    assert.equal(await storage.isConversationSaveOwned("chat-1", "never-issued"), false);
    assert.equal(await storage.isConversationSaveOwned("chat-1", ""), false);
    const first = await storage.saveConversation(conversation([message("m1", "one", 1)]));
    assert.equal(typeof first, "string");
    assert.ok(first.length > 0);
    assert.equal(await storage.isConversationSaveOwned("chat-1", first), true);
    // A later save by the same process is another writer as far as the first token is concerned.
    const second = await storage.saveConversation(conversation([message("m1", "one", 1), message("m2", "two", 2)]));
    assert.notEqual(second, first);
    assert.equal(await storage.isConversationSaveOwned("chat-1", first), false);
    assert.equal(await storage.isConversationSaveOwned("chat-1", second), true);
    await runSql("update conversations set save_token = 'someone-else' where id = 'chat-1';");
    assert.equal(await storage.isConversationSaveOwned("chat-1", second), false);
    const third = await storage.saveConversation(conversation([message("m1", "one", 1), message("m2", "two", 2), message("m3", "three", 3)]));
    assert.equal(await storage.isConversationSaveOwned("chat-1", third), true, "a save reclaims the row");
    const stored = await storage.getConversation("chat-1");
    assert.deepEqual(stored?.messages.map((item) => item.id), ["m1", "m2", "m3"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a save uses the caller's serialized rows only when they line up with the messages", async () => {
  const { storage, directory } = await openStorage();
  try {
    await storage.saveConversation(conversation([message("m1", "one", 1)]));
    const next = conversation([message("m1", "one", 1), message("m2", "two", 2)]);
    const rowsFor = (messages: ChatMessage[]) => messages.map((item, index) => {
      // The caller's row is what gets written, so a marker proves it was used.
      const json = JSON.stringify(index === 1 ? { ...item, metadata: { fromRows: true } } : item);
      return { index, id: item.id, createdAt: item.createdAt, json, hash: createHash("sha1").update(json).digest("hex") };
    });
    await storage.saveConversation(next, { rows: rowsFor(next.messages) });
    const stored = await storage.getConversation("chat-1");
    assert.deepEqual(stored?.messages.map((item) => item.id), ["m1", "m2"]);
    assert.deepEqual(stored?.messages[1].metadata, { fromRows: true });

    // Same length but a different message id: the rows are ignored and the messages themselves are written.
    const swapped = conversation([message("m1", "one", 1), message("m9", "nine", 9)]);
    await storage.saveConversation(swapped, { rows: rowsFor(next.messages) });
    const stored2 = await storage.getConversation("chat-1");
    assert.deepEqual(stored2?.messages.map((item) => item.id), ["m1", "m9"]);
    assert.deepEqual(stored2?.messages[1].metadata, {});

    // A different length is ignored as well.
    const longer = conversation([message("m1", "one", 1), message("m9", "nine", 9), message("m10", "ten", 10)]);
    await storage.saveConversation(longer, { rows: rowsFor(next.messages) });
    const stored3 = await storage.getConversation("chat-1");
    assert.deepEqual(stored3?.messages.map((item) => item.id), ["m1", "m9", "m10"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
