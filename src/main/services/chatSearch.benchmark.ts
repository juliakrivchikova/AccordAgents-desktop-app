import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type { ChatMessage, Conversation } from "../../shared/types";
import { ChatSearchService } from "./chatSearch";
import { resolveSqliteExecutable } from "./sqliteCli";
import { StorageService } from "./storage";

const CHAT_COUNT = 370;
const MESSAGES_PER_CHAT = 50;

void main();

async function main(): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-chat-search-benchmark-"));
  const storage = new StorageService({
    dbPath: path.join(directory, "accordagents.sqlite3"),
    sqliteExecutable: resolveSqliteExecutable({ appPath: process.cwd() })
  });
  try {
    await storage.init();
    let textBytes = 0;
    for (let chatIndex = 0; chatIndex < CHAT_COUNT; chatIndex += 1) {
      const chat = conversation(chatIndex);
      textBytes += chat.messages.reduce((total, message) => total + Buffer.byteLength(message.content, "utf8"), 0);
      await storage.saveConversation(chat);
    }
    const instrumented = storage as unknown as {
      queryJson(sql: string, timeoutMs?: number): Promise<unknown[]>;
      runSql(sql: string, timeoutMs?: number): Promise<void>;
    };
    const originalQueryJson = instrumented.queryJson.bind(storage);
    const originalRunSql = instrumented.runSql.bind(storage);
    let sqliteProcessCount = 0;
    instrumented.queryJson = async (sql, timeoutMs) => {
      sqliteProcessCount += 1;
      return originalQueryJson(sql, timeoutMs);
    };
    instrumented.runSql = async (sql, timeoutMs) => {
      sqliteProcessCount += 1;
      return originalRunSql(sql, timeoutMs);
    };
    const service = new ChatSearchService(storage);
    const coldStartedAt = performance.now();
    const cold = await service.search({ requester: { kind: "user" }, query: "benchmarkneedle" });
    const coldMs = performance.now() - coldStartedAt;
    const coldSqliteProcesses = sqliteProcessCount;
    sqliteProcessCount = 0;
    const warmStartedAt = performance.now();
    const warm = await service.search({ requester: { kind: "user" }, query: "benchmarkneedle" });
    const warmMs = performance.now() - warmStartedAt;
    const warmSqliteProcesses = sqliteProcessCount;
    const [indexStats] = await originalQueryJson(`
      select coalesce(sum(pgsize), 0) as bytes
      from dbstat
      where name = 'chat_search_state' or name like 'chat_search_fts%';
    `) as Array<{ bytes: number }>;
    assert.equal(cold.status, "ok");
    assert.equal(warm.status, "ok");
    assert.equal(cold.coverage.eligibleChatCount, CHAT_COUNT);
    assert.equal(cold.coverage.searchedChatCount, CHAT_COUNT);
    assert.equal(cold.coverage.completeness, "complete");
    assert.ok(coldMs < 20_000, `cold search exceeded 20s: ${coldMs.toFixed(1)}ms`);
    assert.ok(warmMs < 1_000, `warm search exceeded 1s: ${warmMs.toFixed(1)}ms`);
    assert.ok(coldSqliteProcesses < 50, `cold search used ${coldSqliteProcesses} sqlite3 processes`);
    assert.ok(warmSqliteProcesses <= 4, `warm search used ${warmSqliteProcesses} sqlite3 processes`);
    console.log(JSON.stringify({
      chats: CHAT_COUNT,
      messages: CHAT_COUNT * MESSAGES_PER_CHAT,
      textBytes,
      indexBytes: indexStats?.bytes ?? 0,
      coldMs: Number(coldMs.toFixed(1)),
      coldSqliteProcesses,
      warmMs: Number(warmMs.toFixed(1)),
      warmSqliteProcesses,
      firstPageMatches: cold.matches.length,
      hasMore: cold.status === "ok" && cold.hasMore
    }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function conversation(chatIndex: number): Conversation {
  const id = `benchmark-chat-${chatIndex.toString().padStart(3, "0")}`;
  const messages = Array.from({ length: MESSAGES_PER_CHAT }, (_, messageIndex) => {
    const absoluteIndex = chatIndex * MESSAGES_PER_CHAT + messageIndex;
    const createdAt = new Date(Date.UTC(2026, 0, 1) + absoluteIndex * 1_000).toISOString();
    const role: ChatMessage["role"] = messageIndex % 2 === 0 ? "user" : "participant";
    return {
      id: `${id}-message-${messageIndex}`,
      role,
      ...(role === "participant" ? { participantId: "benchmark-participant", participantLabel: "@benchmark" } : {}),
      content: absoluteIndex % 10 === 0
        ? `benchmarkneedle result ${absoluteIndex}`
        : `ordinary saved message ${absoluteIndex}`,
      createdAt,
      status: "done" as const
    };
  });
  return {
    id,
    title: `Benchmark chat ${chatIndex}`,
    kind: "chat",
    createdAt: messages[0].createdAt,
    updatedAt: messages[messages.length - 1].createdAt,
    repoPath: `/benchmark/project-${chatIndex % 20}`,
    messages,
    findings: [],
    metadata: {}
  };
}
