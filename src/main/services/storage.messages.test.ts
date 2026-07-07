import assert from "node:assert/strict";
import test from "node:test";
import { StorageService } from "./storage";
import type { ChatMessage, Conversation } from "../../shared/types";

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
  assert.equal(queryJsonSql.length, 1);
  assert.match(queryJsonSql[0], /select id from conversations/);
  assert.doesNotMatch(queryJsonSql[0], /payload_json as payloadJson/);
  assert.ok(queryTextSql.some((sql) => sql.includes("select payload_json from conversations")));
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
  assert.equal(queryJsonSql.length, 1);
  assert.match(queryJsonSql[0], /select id from conversations/);
  assert.doesNotMatch(queryJsonSql[0], /payload_json as payloadJson/);
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
  storage.queryJson = async (sql: string) => {
    queryJsonSql.push(sql);
    if (sql.includes("select id from conversations")) {
      return (options.ids ?? []).map((id) => ({ id }));
    }
    throw new Error(`Unexpected queryJson: ${sql}`);
  };
  storage.queryText = async (sql: string) => {
    queryTextSql.push(sql);
    if (sql.includes("schema_meta")) {
      return options.metaValue ?? "";
    }
    if (sql.includes("select payload_json from conversations")) {
      const id = sql.match(/where id = '([^']+)'/)?.[1];
      return id ? options.payloads?.get(id) ?? "" : "";
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
