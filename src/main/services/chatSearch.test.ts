import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { ChatMessage, ChatParticipant, ChatSearchMessageMatch, ChatSearchResponse, Conversation } from "../../shared/types";
import { buildChatSearchMatchQuery, ChatSearchService } from "./chatSearch";
import { resolveSqliteExecutable } from "./sqliteCli";
import { StorageService, type ChatSearchConversationSnapshot } from "./storage";

const SQLITE_EXECUTABLE = resolveSqliteExecutable({ appPath: process.cwd() });

test("chat search rebuilds a derived index and excludes non-chat, hidden, control, raw, and debug content", async () => {
  await withStorage(async (storage) => {
    const active = conversation("active", "Active design", false, [
      message("a-user", "user", "Needle launch plan", "2026-01-01T00:00:01.000Z"),
      message("a-system", "system", "needle internal system", "2026-01-01T00:00:02.000Z"),
      message("a-hidden", "participant", "needle hidden draft", "2026-01-01T00:00:03.000Z", {
        hiddenFromTimeline: true
      }),
      message("a-pending", "participant", "needle pending partial", "2026-01-01T00:00:04.000Z", undefined, "pending"),
      message("a-processing", "participant", "Visible final answer", "2026-01-01T00:00:05.000Z", {
        processingTranscript: {
          content: "needle raw tool and debug content",
          capturedAt: "2026-01-01T00:00:05.000Z",
          originalLength: 33
        },
        activityEvents: [{
          id: "activity-1",
          sequence: 1,
          kind: "tool",
          label: "needle raw tool output",
          createdAt: "2026-01-01T00:00:05.000Z"
        }]
      }),
      message("a-inferred-carrier", "participant", "needle inferred request carrier", "2026-01-01T00:00:06.000Z", {
        participantRequest: {
          id: "request-1",
          requesterParticipantId: "participant-a",
          requesterHandle: "@drew",
          source: "inferred",
          resumeRequester: false,
          status: "running",
          depth: 0,
          createdAt: "2026-01-01T00:00:06.000Z",
          updatedAt: "2026-01-01T00:00:06.000Z",
          triggerMessageId: "a-user",
          items: []
        }
      }),
      message("a-artifact-note", "system", "needle artifact draft announcement", "2026-01-01T00:00:07.000Z")
    ]);
    const archived = conversation("archived", "Archived answer", true, [
      message("thread-root", "user", "Question before answer", "2026-01-02T00:00:00.000Z"),
      message("thread-reply", "participant", "Needle archived answer", "2026-01-02T00:00:01.000Z", {
        chatThreadRootId: "thread-root"
      })
    ]);
    await storage.saveConversation(active);
    await storage.saveConversation(archived);
    await storage.saveConversation({
      ...conversation("blind-draft", "Blind artifact draft", false, [
        message("blind-draft-body", "participant", "needle private draft body", "2026-01-03T00:00:00.000Z")
      ]),
      kind: "general"
    });
    const service = new ChatSearchService(storage);

    const first = await service.search({ requester: { kind: "user" }, query: "needle" });
    assert.equal(first.status, "ok");
    assert.equal(first.coverage.eligibleChatCount, 2);
    assert.equal(first.coverage.searchedChatCount, 2);
    assert.equal(first.coverage.completeness, "complete");
    assert.deepEqual(first.coverage.messagePeriod, {
      from: "2026-01-01T00:00:01.000Z",
      to: "2026-01-02T00:00:01.000Z"
    });
    assert.equal(first.messageMatchCount, 2);
    assert.equal(first.matchedChatCount, 2);
    assert.deepEqual(messageMatches(first).map((match) => match.messageId).sort(), ["a-user", "thread-reply"]);
    const threadReply = messageMatches(first).find((match) => match.messageId === "thread-reply");
    assert.equal(threadReply?.archived, true);
    assert.equal(threadReply?.threadRootId, "thread-root");
    assert.equal(threadReply?.snippetText.includes("Needle"), true);
    assert.deepEqual(threadReply?.highlightRanges.map((range) => threadReply.snippetText.slice(range.start, range.end)), ["Needle"]);

    await (storage as unknown as { runSql(sql: string): Promise<void> }).runSql(`
      drop table chat_search_fts;
      drop table chat_search_state;
      delete from schema_meta where key = 'chat-search-index-version';
    `);
    const rebuilt = await service.search({ requester: { kind: "user" }, query: "needle" });
    assert.equal(rebuilt.status, "ok");
    assert.deepEqual(messageMatches(rebuilt).map((match) => match.messageId).sort(), ["a-user", "thread-reply"]);
  });
});

test("chat search indexes title-only matches and refreshes title state independently", async () => {
  await withStorage(async (storage) => {
    const chat = conversation("title-only", "Orchid launch notes", false, [
      message("title-body", "user", "No matching words in this message", "2026-01-04T00:00:00.000Z")
    ]);
    await storage.saveConversation(chat);
    const service = new ChatSearchService(storage);
    const initial = await service.search({ requester: { kind: "user" }, query: "orchid" });
    assert.equal(initial.status, "ok");
    if (initial.status !== "ok") return;
    assert.equal(initial.messageMatchCount, 0);
    assert.equal(initial.matchedChatCount, 1);
    assert.deepEqual(initial.matches.map((match) => match.kind), ["title"]);
    assert.equal(initial.matches[0]?.conversationId, "title-only");

    chat.title = "Saffron launch notes";
    await storage.saveConversation(chat);
    const refreshed = await service.search({ requester: { kind: "user" }, query: "saffron" });
    assert.equal(refreshed.status, "ok");
    if (refreshed.status !== "ok") return;
    assert.deepEqual(refreshed.matches.map((match) => match.kind), ["title"]);
    const stale = await service.search({ requester: { kind: "user" }, query: "orchid" });
    assert.equal(stale.status, "ok");
    assert.equal(stale.matches.length, 0);
  });
});

test("chat search composite freshness detects a new message when conversation updatedAt does not move", async () => {
  await withStorage(async (storage) => {
    const chat = conversation("freshness", "Freshness", false, [
      message("initial", "user", "Initial searchable text", "2026-02-01T00:00:01.000Z")
    ]);
    await storage.saveConversation(chat);
    const service = new ChatSearchService(storage);
    const initial = await service.search({ requester: { kind: "user" }, query: "latearrival" });
    assert.equal(initial.status, "ok");
    assert.equal(initial.matches.length, 0);

    chat.messages.push(message("late", "participant", "LateArrival without conversation timestamp", "2026-02-01T00:00:05.000Z"));
    await storage.saveConversation(chat);
    const refreshed = await service.search({ requester: { kind: "user" }, query: "latearrival" });
    assert.equal(refreshed.status, "ok");
    assert.deepEqual(messageMatches(refreshed).map((match) => match.messageId), ["late"]);
  });
});

test("participant requester uses stable config identity and fails closed for ad-hoc or spoofed identities", async () => {
  await withStorage(async (storage) => {
    const savedA = participant("participant-a", "saved-config", "@drew");
    const savedB = participant("participant-b", "saved-config", "@drew");
    const other = participant("participant-other", "other-config", "@taylor");
    const adHoc = participant("participant-adhoc", undefined, "@guest");
    await storage.saveConversation(conversation("scope-a", "Scope A", false, [
      message("scope-a-match", "participant", "scopeword first", "2026-03-01T00:00:01.000Z")
    ], [savedA, adHoc]));
    await storage.saveConversation(conversation("scope-b", "Scope B", false, [
      message("scope-b-match", "participant", "scopeword second", "2026-03-02T00:00:01.000Z")
    ], [savedB]));
    await storage.saveConversation(conversation("scope-other", "Scope Other", false, [
      message("scope-other-match", "participant", "scopeword secret", "2026-03-03T00:00:01.000Z")
    ], [other]));
    const service = new ChatSearchService(storage);

    const savedScope = await service.search({
      requester: { kind: "participant", conversationId: "scope-a", participantId: "participant-a" },
      query: "scopeword"
    });
    assert.equal(savedScope.status, "ok");
    assert.equal(savedScope.coverage.eligibleChatCount, 2);
    assert.deepEqual(savedScope.matches.map((match) => match.conversationId).sort(), ["scope-a", "scope-b"]);

    const adHocScope = await service.search({
      requester: { kind: "participant", conversationId: "scope-a", participantId: "participant-adhoc" },
      query: "scopeword"
    });
    assert.equal(adHocScope.status, "ok");
    assert.deepEqual(adHocScope.matches.map((match) => match.conversationId), ["scope-a"]);

    const spoofed = await service.search({
      requester: { kind: "participant", conversationId: "scope-a", participantId: "participant-other" },
      query: "scopeword"
    });
    assert.equal(spoofed.status, "unavailable");
    assert.equal(spoofed.errorCode, "requester-not-authorized");
    assert.equal(spoofed.coverage.searchedChatCount, 0);
  });
});

test("participant scope ignores unreadable foreign chats without leaking their identity", async () => {
  await withStorage(async (storage) => {
    const savedA = participant("participant-a", "saved-config", "@drew");
    const savedB = participant("participant-b", "saved-config", "@drew");
    const other = participant("participant-other", "other-config", "@taylor");
    await storage.saveConversation(conversation("scope-current", "Scope Current", false, [
      message("scope-current-match", "participant", "isolatedword current", "2026-03-04T00:00:01.000Z")
    ], [savedA]));
    await storage.saveConversation(conversation("scope-allowed", "Scope Allowed", false, [
      message("scope-allowed-match", "participant", "isolatedword allowed", "2026-03-05T00:00:01.000Z")
    ], [savedB]));
    await storage.saveConversation(conversation("scope-foreign", "Scope Foreign", false, [
      message("scope-foreign-match", "participant", "isolatedword foreign", "2026-03-06T00:00:01.000Z")
    ], [other]));
    const preindexed = await new ChatSearchService(storage).search({ requester: { kind: "user" }, query: "isolatedword" });
    assert.equal(preindexed.status, "ok");
    assert.equal(preindexed.matches.length, 3);
    await (storage as unknown as { runSql(sql: string): Promise<void> }).runSql(`
      update conversations
      set body_json = '{invalid-json', payload_json = '{invalid-json'
      where id = 'scope-foreign';
    `);
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const service = new ChatSearchService(storage, {
      write: async (event, payload) => { events.push({ event, payload }); }
    });

    const isolated = await service.search({
      requester: { kind: "participant", conversationId: "scope-current", participantId: "participant-a" },
      query: "isolatedword"
    });
    assert.equal(isolated.status, "ok");
    assert.equal(isolated.coverage.eligibleChatCount, 2);
    assert.deepEqual(isolated.matches.map((match) => match.conversationId).sort(), ["scope-allowed", "scope-current"]);
    assert.equal("failure" in isolated, false);
    assert.deepEqual(events, []);

    await (storage as unknown as { runSql(sql: string): Promise<void> }).runSql(`
      update conversations
      set body_json = '{invalid-json', payload_json = '{invalid-json'
      where id = 'scope-current';
    `);
    const unreadableCurrent = await service.search({
      requester: { kind: "participant", conversationId: "scope-current", participantId: "participant-a" },
      query: "isolatedword"
    });
    assert.equal(unreadableCurrent.status, "unavailable");
    assert.equal(unreadableCurrent.errorCode, "requester-not-authorized");
    assert.equal(unreadableCurrent.coverage.searchedChatCount, 0);
    assert.equal("failure" in unreadableCurrent, false);
    assert.deepEqual(events, []);
  });
});

test("chat search distinguishes unavailable corpus from a complete zero-match result", async () => {
  const snapshot: ChatSearchConversationSnapshot = {
    conversationId: "unavailable",
    title: "Unavailable",
    archived: false,
    updatedAt: "2026-04-01T00:00:00.000Z",
    messageCount: 1,
    oldestMessageAt: "2026-04-01T00:00:00.000Z",
    newestMessageAt: "2026-04-01T00:00:00.000Z",
    participants: []
  };
  let rebuildAttempts = 0;
  const brokenStorage = {
    listChatSearchConversationSnapshots: async () => [snapshot],
    ensureChatSearchIndex: async () => { throw new Error("no fts5"); },
    rebuildChatSearchIndex: async () => {
      rebuildAttempts += 1;
      throw new Error("no fts5 after rebuild");
    }
  } as unknown as StorageService;
  const result = await new ChatSearchService(brokenStorage).search({ requester: { kind: "user" }, query: "anything" });
  assert.equal(result.status, "unavailable");
  assert.equal(result.errorCode, "search-unavailable");
  assert.equal(rebuildAttempts, 1);
  if (result.status !== "unavailable") return;
  assert.deepEqual(result.failure, { stage: "index-prepare" });
  assert.equal(result.coverage.eligibleChatCount, 1);
  assert.equal(result.coverage.searchedChatCount, 0);
  assert.equal(result.coverage.completeness, "none");
});

test("chat search query builder treats FTS syntax as text and prefixes only the final token", () => {
  assert.equal(buildChatSearchMatchQuery('hello OR "world'), '"hello" AND "OR" AND "world"*');
  assert.equal(buildChatSearchMatchQuery("привет мир"), '"привет" AND "мир"*');
  assert.equal(buildChatSearchMatchQuery("!?!"), undefined);
});

test("chat search cursor pagination returns every result exactly once and rejects a stale corpus", async () => {
  await withStorage(async (storage) => {
    const messages = Array.from({ length: 235 }, (_, index) => message(
      `page-${index.toString().padStart(3, "0")}`,
      index % 2 === 0 ? "user" : "participant",
      `paginationword result ${index}`,
      `2026-05-01T00:${Math.floor(index / 60).toString().padStart(2, "0")}:${(index % 60).toString().padStart(2, "0")}.000Z`
    ));
    const chat = conversation("pagination", "Pagination", false, messages);
    await storage.saveConversation(chat);
    const service = new ChatSearchService(storage);
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.search({ requester: { kind: "user" }, query: "paginationword", limit: 57, cursor });
      assert.equal(page.status, "ok");
      if (page.status !== "ok") return;
      ids.push(...messageMatches(page).map((match) => match.messageId));
      cursor = page.nextCursor;
      assert.equal(page.hasMore, Boolean(cursor));
    } while (cursor);
    assert.equal(ids.length, 235);
    assert.equal(new Set(ids).size, 235);

    const first = await service.search({ requester: { kind: "user" }, query: "paginationword", limit: 10 });
    assert.equal(first.status, "ok");
    if (first.status !== "ok" || !first.nextCursor) return;
    chat.messages.push(message("page-new", "user", "paginationword new", "2026-05-01T01:00:00.000Z"));
    await storage.saveConversation(chat);
    const stale = await service.search({
      requester: { kind: "user" },
      query: "paginationword",
      limit: 10,
      cursor: first.nextCursor
    });
    assert.equal(stale.status, "unavailable");
    assert.equal(stale.errorCode, "invalid-request");
  });
});

test("chat search retries a source race against the exact read snapshot", async () => {
  await withStorage(async (storage) => {
    const chat = conversation("race", "Race", false, [
      message("race-initial", "user", "initial", "2026-06-01T00:00:00.000Z")
    ]);
    await storage.saveConversation(chat);
    const originalRead = storage.readChatSearchConversations.bind(storage);
    let mutated = false;
    storage.readChatSearchConversations = async (conversationIds) => {
      if (!mutated) {
        mutated = true;
        chat.messages.push(message("race-new", "participant", "raceword exact", "2026-06-01T00:00:01.000Z"));
        await storage.saveConversation(chat);
      }
      return originalRead(conversationIds);
    };
    const result = await new ChatSearchService(storage).search({ requester: { kind: "user" }, query: "raceword" });
    assert.equal(result.status, "ok");
    assert.deepEqual(messageMatches(result).map((match) => match.messageId), ["race-new"]);
    assert.equal(result.coverage.messagePeriod?.to, "2026-06-01T00:00:01.000Z");
  });
});

test("chat search fails closed when the source changes through both bounded attempts", async () => {
  await withStorage(async (storage) => {
    const chat = conversation("unstable", "Unstable", false, [
      message("unstable-initial", "user", "unstableword", "2026-06-02T00:00:00.000Z")
    ]);
    await storage.saveConversation(chat);
    const originalRead = storage.readChatSearchConversations.bind(storage);
    let mutation = 0;
    storage.readChatSearchConversations = async (conversationIds) => {
      mutation += 1;
      chat.messages.push(message(
        `unstable-${mutation}`,
        "participant",
        `unstableword ${mutation}`,
        `2026-06-02T00:00:0${mutation}.000Z`
      ));
      await storage.saveConversation(chat);
      return originalRead(conversationIds);
    };
    const result = await new ChatSearchService(storage).search({ requester: { kind: "user" }, query: "unstableword" });
    assert.equal(result.status, "unavailable");
    if (result.status !== "unavailable") return;
    assert.deepEqual(result.failure, { stage: "source-read", conversationId: "unstable" });
    assert.equal(result.coverage.searchedChatCount, 0);
    assert.equal(mutation, 2);
  });
});

test("chat search repairs a wrong derived schema and preserves literal legacy markers", async () => {
  await withStorage(async (storage) => {
    const legacyMarker = "\u{f0000}ACCORD_SEARCH_START\u{f0001}";
    await storage.saveConversation(conversation("repair", "Repair", false, [
      message("repair-message", "user", `${legacyMarker} <mark>repairword</mark>`, "2026-07-01T00:00:00.000Z")
    ]));
    const service = new ChatSearchService(storage);
    const initial = await service.search({ requester: { kind: "user" }, query: "repairword" });
    assert.equal(initial.status, "ok");
    await (storage as unknown as { runSql(sql: string): Promise<void> }).runSql(`
      drop table chat_search_state;
      create table chat_search_state (conversation_id text primary key);
    `);
    const repaired = await service.search({ requester: { kind: "user" }, query: "repairword" });
    assert.equal(repaired.status, "ok");
    const repairedMessage = messageMatches(repaired)[0];
    assert.equal(repairedMessage?.snippetText.includes(legacyMarker), true);
    assert.equal(repairedMessage?.snippetText.includes("<mark>repairword</mark>"), true);
    assert.deepEqual(
      repairedMessage?.highlightRanges.map((range) => repairedMessage.snippetText.slice(range.start, range.end)),
      ["repairword"]
    );

    await (storage as unknown as { runSql(sql: string): Promise<void> }).runSql(`
      drop table chat_search_fts;
      create table chat_search_fts (
        conversation_id text,
        message_id text,
        thread_root_id text,
        role text,
        author_label text,
        created_at text,
        body text
      );
    `);
    const repairedAfterQueryFailure = await service.search({ requester: { kind: "user" }, query: "repairword" });
    assert.equal(repairedAfterQueryFailure.status, "ok");
    assert.deepEqual(messageMatches(repairedAfterQueryFailure).map((match) => match.messageId), ["repair-message"]);
  });
});

test("canonical corruption fails closed with a safe detail and recovers after repair", async () => {
  await withStorage(async (storage) => {
    const chat = conversation("corrupt", "Corrupt", false, [
      message("corrupt-message", "user", "corruptword", "2026-08-01T00:00:00.000Z")
    ]);
    await storage.saveConversation(chat);
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const service = new ChatSearchService(storage, {
      write: async (event, payload) => { events.push({ event, payload }); }
    });
    await (storage as unknown as { runSql(sql: string): Promise<void> }).runSql(`
      update conversations set body_json = '{invalid-json', payload_json = '{invalid-json' where id = 'corrupt';
    `);
    const unavailable = await service.search({ requester: { kind: "user" }, query: "corruptword" });
    assert.equal(unavailable.status, "unavailable");
    if (unavailable.status !== "unavailable") return;
    assert.equal(unavailable.coverage.eligibleChatCount, 1);
    assert.equal(unavailable.coverage.searchedChatCount, 0);
    assert.equal(unavailable.coverage.completeness, "none");
    assert.deepEqual(unavailable.failure, { stage: "source-snapshot", conversationId: "corrupt" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events[0], {
      event: "chat-search.unavailable",
      payload: { stage: "source-snapshot", conversationId: "corrupt" }
    });

    await storage.saveConversation(chat);
    const recovered = await service.search({ requester: { kind: "user" }, query: "corruptword" });
    assert.equal(recovered.status, "ok");
    assert.deepEqual(messageMatches(recovered).map((match) => match.messageId), ["corrupt-message"]);
  });
});

test("archive metadata refreshes and deleted chats are removed from the derived corpus", async () => {
  await withStorage(async (storage) => {
    const first = conversation("lifecycle-a", "Lifecycle A", false, [
      message("lifecycle-a-message", "user", "lifecycleword first", "2026-09-01T00:00:00.000Z")
    ]);
    const second = conversation("lifecycle-b", "Lifecycle B", false, [
      message("lifecycle-b-message", "user", "lifecycleword second", "2026-09-02T00:00:00.000Z")
    ]);
    await storage.saveConversation(first);
    await storage.saveConversation(second);
    const service = new ChatSearchService(storage);
    const initial = await service.search({ requester: { kind: "user" }, query: "lifecycleword" });
    assert.equal(initial.status, "ok");
    assert.equal(initial.matches.length, 2);

    first.archived = true;
    first.metadata.archived = true;
    first.updatedAt = "2026-09-03T00:00:00.000Z";
    await storage.saveConversation(first);
    await storage.deleteConversation("lifecycle-b");
    const refreshed = await service.search({ requester: { kind: "user" }, query: "lifecycleword" });
    assert.equal(refreshed.status, "ok");
    assert.deepEqual(refreshed.matches.map((match) => ({ id: match.conversationId, archived: match.archived })), [
      { id: "lifecycle-a", archived: true }
    ]);
    assert.deepEqual((await storage.listChatSearchIndexStates()).map((state) => state.conversationId), ["lifecycle-a"]);
  });
});

async function withStorage(run: (storage: StorageService) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-chat-search-"));
  const storage = new StorageService({
    dbPath: path.join(directory, "accordagents.sqlite3"),
    sqliteExecutable: SQLITE_EXECUTABLE
  });
  try {
    await storage.init();
    await run(storage);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function conversation(
  id: string,
  title: string,
  archived: boolean,
  messages: ChatMessage[],
  participants: ChatParticipant[] = []
): Conversation {
  return {
    id,
    title,
    kind: "chat",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:10:00.000Z",
    repoPath: `/repo/${id}`,
    archived,
    messages,
    findings: [],
    metadata: { archived, participants }
  };
}

function participant(id: string, participantConfigId: string | undefined, handle: string): ChatParticipant {
  return {
    id,
    ...(participantConfigId ? { participantConfigId } : {}),
    handle,
    roleConfigId: "engineer",
    kind: "codex-cli"
  };
}

function message(
  id: string,
  role: ChatMessage["role"],
  content: string,
  createdAt: string,
  metadata?: ChatMessage["metadata"],
  status: ChatMessage["status"] = "done"
): ChatMessage {
  return {
    id,
    role,
    ...(role === "participant" ? { participantId: "participant-a", participantLabel: "@drew" } : {}),
    content,
    createdAt,
    status,
    ...(metadata ? { metadata } : {})
  };
}

function messageMatches(response: ChatSearchResponse): ChatSearchMessageMatch[] {
  return response.status === "ok"
    ? response.matches.filter((match): match is ChatSearchMessageMatch => match.kind === "message")
    : [];
}
