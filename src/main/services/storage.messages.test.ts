import assert from "node:assert/strict";
import test from "node:test";
import { StorageService } from "./storage";

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
    if (sql.includes("payload_json as payloadJson")) {
      // newest-first; limit+1 rows so hasMoreBefore is true
      return [4, 3, 2].map((sequence) => ({
        sequence,
        payloadJson: JSON.stringify({ id: `m-${sequence}`, role: "user", content: `m${sequence}`, createdAt: "2026-01-01T00:00:0" + sequence + ".000Z" })
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

test("listConversationMessages can page around a target message id", async () => {
  const queries: string[] = [];
  const storage = fakeStorage(async (sql) => {
    queries.push(sql);
    if (sql.includes("select sequence") && sql.includes("message_id")) {
      return [{ sequence: 3 }];
    }
    if (sql.includes("payload_json as payloadJson")) {
      return [
        { sequence: 3, payloadJson: JSON.stringify({ id: "target", role: "user", content: "target", createdAt: "2026-01-01T00:00:03.000Z" }) },
        { sequence: 2, payloadJson: JSON.stringify({ id: "before", role: "user", content: "before", createdAt: "2026-01-01T00:00:02.000Z" }) },
        { sequence: 1, payloadJson: JSON.stringify({ id: "older", role: "user", content: "older", createdAt: "2026-01-01T00:00:01.000Z" }) }
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
