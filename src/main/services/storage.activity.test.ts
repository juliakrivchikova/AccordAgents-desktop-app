import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { StorageService } from "./storage";
import type { ChatAppToolApproval, ChatMessage, Conversation } from "../../shared/types";

function hexText(value: string): string {
  return Buffer.from(value, "utf8").toString("hex").toUpperCase();
}

function fakeStorage(queryJson: (sql: string) => Promise<unknown[]>): StorageService {
  const storage = Object.create(StorageService.prototype) as any;
  storage.init = async () => {};
  storage.queryJson = async (sql: string) => {
    const rows = await queryJson(sql);
    return rows.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return value;
      }
      const row = value as Record<string, unknown>;
      const encoded = { ...row };
      if (typeof row.bodyJson === "string") {
        encoded.bodyHex = hexText(row.bodyJson);
        delete encoded.bodyJson;
      }
      if (typeof row.payloadJson === "string") {
        encoded.payloadHex = hexText(row.payloadJson);
        delete encoded.payloadJson;
      }
      return encoded;
    });
  };
  return storage as StorageService;
}

test("listChatActivity finds pending messages outside the recent participant window", async () => {
  const queries: string[] = [];
  const chat = conversation("chat-1", "Activity chat");
  const oldPending = participantMessage("old-choice", {
    createdAt: "2026-01-01T00:00:00.000Z",
    metadata: {
      pendingChoice: {
        id: "choice-1",
        title: "Choose scope",
        question: "Phase 1 or full handoff?",
        options: [{ id: "phase-1", label: "Phase 1" }],
        status: "pending"
      }
    }
  });
  const storage = fakeStorage(async (sql) => {
    queries.push(sql);
    if (sql.includes("coalesce(nullif(body_json")) {
      return [{ id: chat.id, bodyJson: JSON.stringify({ ...chat, messages: [] }) }];
    }
    if (sql.includes("$.metadata.pendingChoice.status")) {
      return [{ conversationId: chat.id, sequence: 1, payloadJson: JSON.stringify(oldPending) }];
    }
    if (sql.includes("$.role") && sql.includes("participant") && sql.includes("$.status') = 'pending'")) {
      return [];
    }
    if (sql.includes("$.role") && sql.includes("participant") && sql.includes("$.status') = 'done'")) {
      return [];
    }
    throw new Error(`Unexpected query: ${sql}`);
  });

  const result = await storage.listChatActivity({ lastViewedAtByConversationId: { [chat.id]: "2026-01-08T00:00:00.000Z" } });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].kind, "choice");
  assert.equal(result.items[0].target.messageId, "old-choice");
  assert.equal(queries.length, 4);
  assert.match(queries[0], /hex\(coalesce\(nullif\(body_json/);
  assert.match(queries[1], /hex\(payload_json\) as payloadHex/);
  assert.ok(queries[1].includes("conversation_id in ('chat-1')"));
});

test("listChatActivity uses the payload fallback when body_json is empty", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-storage-activity-"));
  const storage = Object.create(StorageService.prototype) as any;
  storage.dbPath = path.join(directory, "accordagents.sqlite3");
  storage.initialized = true;
  const chat = conversation("fallback-chat", "Fallback chat");
  chat.messages = [participantMessage("fallback-choice", {
    content: "Choose \"one\"\nline two\t\u001f🙂",
    metadata: {
      pendingChoice: {
        id: "fallback-choice",
        title: "Choose",
        question: "Continue?",
        options: [{ id: "yes", label: "Yes" }],
        status: "pending"
      }
    }
  })];

  try {
    await storage.runSql(`
      create table conversations (
        id text primary key, title text not null, kind text not null, created_at text not null,
        updated_at text not null, repo_path text, body_json text, payload_json text not null
      );
      create table conversation_messages (
        conversation_id text not null, sequence integer not null, message_id text not null,
        created_at text not null, payload_json text not null,
        primary key (conversation_id, sequence), unique (conversation_id, message_id)
      );
    `);
    await storage.saveConversation(chat);
    await storage.runSql("update conversations set body_json = '' where id = 'fallback-chat';");

    const result = await storage.listChatActivity();

    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]?.kind, "choice");
    assert.equal(result.items[0]?.target.messageId, "fallback-choice");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("listChatActivity skips a malformed conversation body and keeps remaining activity", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "accordagents-storage-activity-"));
  const storage = Object.create(StorageService.prototype) as any;
  storage.dbPath = path.join(directory, "accordagents.sqlite3");
  storage.initialized = true;
  const goodChat = conversation("good-chat", "Good chat");
  goodChat.messages = [participantMessage("good-choice", {
    metadata: {
      pendingChoice: {
        id: "good-choice",
        title: "Choose",
        question: "Continue?",
        options: [{ id: "yes", label: "Yes" }],
        status: "pending"
      }
    }
  })];
  const badChat = conversation("bad-chat", "Bad chat");
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...values: unknown[]) => {
    warnings.push(values.map(String).join(" "));
  };

  try {
    await storage.runSql(`
      create table conversations (
        id text primary key, title text not null, kind text not null, created_at text not null,
        updated_at text not null, repo_path text, body_json text, payload_json text not null
      );
      create table conversation_messages (
        conversation_id text not null, sequence integer not null, message_id text not null,
        created_at text not null, payload_json text not null,
        primary key (conversation_id, sequence), unique (conversation_id, message_id)
      );
    `);
    await storage.saveConversation(goodChat);
    await storage.saveConversation(badChat);
    await storage.runSql("update conversations set body_json = '{oops' where id = 'bad-chat';");

    const result = await storage.listChatActivity();

    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]?.conversationId, "good-chat");
    assert.equal(result.items[0]?.target.messageId, "good-choice");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Skipping invalid chat activity conversation bad-chat: Invalid JSON/);
  } finally {
    console.warn = originalWarn;
    await rm(directory, { recursive: true, force: true });
  }
});

test("listChatActivity transports every full JSON result through hex projections", async () => {
  const bodyQueries: string[] = [];
  const bodyStorage = fakeStorage(async (sql) => {
    bodyQueries.push(sql);
    return [];
  });

  await bodyStorage.listChatActivity();

  assert.equal(bodyQueries.length, 1);
  const bodySelect = bodyQueries[0].match(/\bselect\b[\s\S]*?\bfrom\b/i)?.[0] ?? "";
  assert.match(bodySelect, /hex\(coalesce\(nullif\(body_json[\s\S]*\)\) as bodyHex/i);
  assert.doesNotMatch(bodySelect, /\bbody_json\s+as\s+bodyJson\b/i);

  const messageQueries: string[] = [];
  const pending = participantMessage("pending", {
    metadata: {
      pendingChoice: {
        id: "choice",
        title: "Choose",
        question: "Continue?",
        options: [{ id: "yes", label: "Yes" }],
        status: "pending"
      },
      sourceMessageId: "source-message"
    }
  });
  const messageStorage = fakeStorage(async (sql) => {
    messageQueries.push(sql);
    if (sql.includes("$.metadata.pendingChoice.status")) {
      return [{ conversationId: "chat-1", sequence: 1, payloadJson: JSON.stringify(pending) }];
    }
    return [];
  });

  await (messageStorage as any).activityMessageRows(
    ["chat-1"],
    40,
    ["chat-1"],
    [["chat-1", "approval-trigger"]]
  );

  assert.equal(messageQueries.length, 6);
  for (const sql of messageQueries) {
    const outerSelect = sql.match(/\bselect\b[\s\S]*?\bfrom\b/i)?.[0] ?? "";
    assert.match(
      outerSelect,
      /select\s+(?:conversation_id as conversationId|conversationId),\s*sequence,\s*hex\((?:payload_json|payloadJson)\) as payloadHex/i
    );
    assert.doesNotMatch(
      outerSelect,
      /(?:payload_json|payloadJson)\s+as\s+payloadJson/i
    );
  }
});

test("listChatActivity finds pending participant messages outside the recent participant preview limit", async () => {
  const chat = conversation("chat-1", "Activity chat");
  const pendingParticipant = participantMessage("pending-run-message", {
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "pending",
    metadata: { runId: "legacy-running-run" }
  });
  const storage = fakeStorage(async (sql) => {
    if (sql.includes("coalesce(nullif(body_json")) {
      return [{ id: chat.id, bodyJson: JSON.stringify({ ...chat, messages: [] }) }];
    }
    if (sql.includes("$.metadata.pendingChoice.status")) {
      return [];
    }
    if (sql.includes("$.role") && sql.includes("participant") && sql.includes("$.status') = 'pending'")) {
      return [{ conversationId: chat.id, sequence: 2, payloadJson: JSON.stringify(pendingParticipant) }];
    }
    if (sql.includes("$.role") && sql.includes("participant") && sql.includes("$.status') = 'done'")) {
      return [];
    }
    throw new Error(`Unexpected query: ${sql}`);
  });

  const result = await storage.listChatActivity({ lastViewedAtByConversationId: { [chat.id]: "2026-01-08T00:00:00.000Z" } });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].status, "running");
  assert.equal(result.items[0].target.runId, "legacy-running-run");
  assert.equal(result.items[0].target.messageId, "pending-run-message");
});

test("listChatActivity includes visible approval context messages for approval targets", async () => {
  const approval: ChatAppToolApproval = {
    id: "approval-1",
    conversationId: "chat-1",
    requesterParticipantId: "participant-1",
    requesterHandle: "drew-codex-engineer",
    requesterRoleConfigId: "engineer",
    toolName: "app_roles_request_change",
    capability: "participants.manage",
    status: "pending",
    request: { kind: "portable", permissions: ["workspaceWrite"] },
    summary: "Create role \"Mathematician\"",
    createdAt: "2026-01-08T11:00:00.000Z",
    updatedAt: "2026-01-08T11:00:00.000Z"
  };
  const chat = conversation("chat-1", "create a new role for mathematician");
  chat.metadata.pendingAppToolApprovals = [approval];
  const sourceMessage = participantMessage("approval-source", {
    content: "Requested a new `Mathematician` role. Please approve it in the app review card.",
    createdAt: "2026-01-08T10:59:00.000Z"
  });
  const storage = fakeStorage(async (sql) => {
    if (sql.includes("coalesce(nullif(body_json")) {
      return [{ id: chat.id, bodyJson: JSON.stringify({ ...chat, messages: [] }) }];
    }
    if (sql.includes("$.metadata.pendingChoice.status")) {
      return [];
    }
    if (sql.includes("$.role") && sql.includes("participant") && sql.includes("$.status') = 'pending'")) {
      return [];
    }
    if (sql.includes("$.role") && sql.includes("participant") && sql.includes("$.status') = 'done'")) {
      return [];
    }
    if (sql.includes("row_number() over")) {
      return [{ conversationId: chat.id, sequence: 2, payloadJson: JSON.stringify(sourceMessage) }];
    }
    throw new Error(`Unexpected query: ${sql}`);
  });

  const result = await storage.listChatActivity();

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].kind, "approval");
  assert.equal(result.items[0].target.messageId, "approval-source");
  assert.equal(result.items[0].preview, sourceMessage.content);
});

test("listChatActivity resolves explicit approval triggers outside the bounded context window", async () => {
  const approval: ChatAppToolApproval = {
    id: "approval-triggered",
    conversationId: "chat-1",
    requesterParticipantId: "participant-1",
    requesterHandle: "drew-codex-engineer",
    requesterRoleConfigId: "engineer",
    toolName: "app_roles_request_change",
    capability: "participants.manage",
    status: "pending",
    request: { kind: "portable", permissions: ["workspaceWrite"] },
    summary: "Create role",
    createdAt: "2026-01-01T11:00:00.000Z",
    updatedAt: "2026-01-01T11:00:00.000Z",
    resumeContext: { runId: "run-1", triggerMessageId: "exact-trigger" }
  };
  const chat = conversation("chat-1", "Approval chat");
  chat.metadata.pendingAppToolApprovals = [approval];
  const exactTrigger = participantMessage("exact-trigger", {
    content: "Internal approval trigger",
    createdAt: "2026-01-01T10:59:00.000Z",
    metadata: {
      hiddenFromTimeline: true,
      sourceMessageId: "visible-source",
      parentMessageId: "visible-source"
    }
  });
  const visibleSource = participantMessage("visible-source", {
    content: "Exact approval request",
    createdAt: "2026-01-01T10:58:00.000Z"
  });
  const unrelatedContext = participantMessage("newer-context", {
    content: "Unrelated newer message",
    createdAt: "2026-01-08T11:59:00.000Z"
  });
  const queries: string[] = [];
  const storage = fakeStorage(async (sql) => {
    queries.push(sql);
    if (sql.includes("coalesce(nullif(body_json")) {
      return [{ id: chat.id, bodyJson: JSON.stringify({ ...chat, messages: [] }) }];
    }
    if (sql.includes("$.metadata.pendingChoice.status")) return [];
    if (sql.includes("$.role") && sql.includes("$.status') = 'pending'")) return [];
    if (sql.includes("$.role") && sql.includes("$.status') = 'done'")) return [];
    if (sql.includes("row_number() over")) {
      return [{ conversationId: chat.id, sequence: 60, payloadJson: JSON.stringify(unrelatedContext) }];
    }
    if (sql.includes("(conversation_id, message_id) in") && sql.includes("exact-trigger")) {
      return [{ conversationId: chat.id, sequence: 1, payloadJson: JSON.stringify(exactTrigger) }];
    }
    if (sql.includes("(conversation_id, message_id) in") && sql.includes("visible-source")) {
      return [{ conversationId: chat.id, sequence: 2, payloadJson: JSON.stringify(visibleSource) }];
    }
    throw new Error(`Unexpected query: ${sql}`);
  });

  const result = await storage.listChatActivity();

  assert.equal(result.items[0]?.target.messageId, "visible-source");
  assert.equal(result.items[0]?.preview, "Exact approval request");
  assert.ok(queries.some((sql) => sql.includes("('chat-1', 'exact-trigger')")));
  assert.ok(queries.some((sql) => sql.includes("('chat-1', 'visible-source')")));
});

test("listChatActivity returns bounded sorted items with resolvable message targets", async () => {
  const chat = conversation("chat-1", "Activity chat");
  const message = participantMessage("recent-reply", {
    createdAt: "2026-01-08T11:00:00.000Z",
    metadata: { runId: "run-1" }
  });
  const storage = fakeStorage(async (sql) => {
    if (sql.includes("coalesce(nullif(body_json")) {
      return [{ id: chat.id, bodyJson: JSON.stringify({ ...chat, messages: [] }) }];
    }
    if (sql.includes("$.metadata.pendingChoice.status")) {
      return [];
    }
    if (sql.includes("$.role") && sql.includes("participant") && sql.includes("$.status') = 'pending'")) {
      return [];
    }
    if (sql.includes("$.role") && sql.includes("participant") && sql.includes("$.status') = 'done'")) {
      return [{ conversationId: chat.id, sequence: 3, payloadJson: JSON.stringify(message) }];
    }
    throw new Error(`Unexpected query: ${sql}`);
  }) as any;
  storage.listConversationMessages = async (request: { aroundMessageId?: string }) => ({
    messages: request.aroundMessageId === "recent-reply" ? [message] : [],
    oldestSequence: 3,
    newestSequence: 3,
    hasMoreBefore: false,
    totalMessages: 1
  });

  const result = await (storage as StorageService).listChatActivity({
    limit: 1,
    recentWindowDays: 400,
    lastViewedAtByConversationId: { [chat.id]: "2026-01-08T10:00:00.000Z" }
  });
  const targetMessageId = result.items[0]?.target.messageId;
  const page = await (storage as StorageService).listConversationMessages({
    conversationId: chat.id,
    aroundMessageId: targetMessageId,
    limit: 1
  });

  assert.equal(result.items.length, 1);
  assert.equal(targetMessageId, "recent-reply");
  assert.deepEqual(page.messages.map((item) => item.id), ["recent-reply"]);
});

test("listChatActivity excludes cleared items before applying the result limit", async () => {
  const chat = conversation("chat-1", "Activity chat");
  const newest = participantMessage("newest-reply", {
    createdAt: "2026-01-08T11:00:00.000Z",
    metadata: { runId: "newest-run" }
  });
  const older = participantMessage("older-reply", {
    createdAt: "2026-01-08T10:00:00.000Z",
    metadata: { runId: "older-run" }
  }, {
    id: "participant-2",
    handle: "taylor-claude-engineer"
  });
  const storage = fakeStorage(async (sql) => {
    if (sql.includes("coalesce(nullif(body_json")) {
      return [{ id: chat.id, bodyJson: JSON.stringify({ ...chat, messages: [] }) }];
    }
    if (sql.includes("$.metadata.pendingChoice.status")) return [];
    if (sql.includes("$.role") && sql.includes("participant") && sql.includes("$.status') = 'pending'")) return [];
    if (sql.includes("$.role") && sql.includes("participant") && sql.includes("$.status') = 'done'")) {
      return [
        { conversationId: chat.id, sequence: 2, payloadJson: JSON.stringify(newest) },
        { conversationId: chat.id, sequence: 1, payloadJson: JSON.stringify(older) }
      ];
    }
    throw new Error(`Unexpected query: ${sql}`);
  });

  const result = await storage.listChatActivity({
    limit: 1,
    recentWindowDays: 400,
    excludedItemIds: ["recent:chat-1:newest-run"]
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.target.messageId, "older-reply");
});

test("listChatActivity does not backfill older finished rows for the same participant after clear", async () => {
  const chat = conversation("chat-1", "Activity chat");
  const newest = participantMessage("newest-reply", {
    createdAt: "2026-01-08T11:00:00.000Z",
    metadata: { runId: "newest-run" }
  });
  const older = participantMessage("older-reply", {
    createdAt: "2026-01-08T10:00:00.000Z",
    metadata: { runId: "older-run" }
  });
  const storage = fakeStorage(async (sql) => {
    if (sql.includes("coalesce(nullif(body_json")) {
      return [{ id: chat.id, bodyJson: JSON.stringify({ ...chat, messages: [] }) }];
    }
    if (sql.includes("$.metadata.pendingChoice.status")) return [];
    if (sql.includes("$.role") && sql.includes("participant") && sql.includes("$.status') = 'pending'")) return [];
    if (sql.includes("$.role") && sql.includes("participant") && sql.includes("$.status') = 'done'")) {
      return [
        { conversationId: chat.id, sequence: 2, payloadJson: JSON.stringify(newest) },
        { conversationId: chat.id, sequence: 1, payloadJson: JSON.stringify(older) }
      ];
    }
    throw new Error(`Unexpected query: ${sql}`);
  });

  const result = await storage.listChatActivity({
    limit: 1,
    recentWindowDays: 400,
    excludedItemIds: ["recent:chat-1:newest-run"]
  });

  assert.deepEqual(result.items, []);
});

function conversation(id: string, title: string): Conversation {
  return {
    id,
    title,
    kind: "chat",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-08T12:00:00.000Z",
    repoPath: "/repo",
    messages: [],
    findings: [],
    metadata: {
      participants: [{
        id: "participant-1",
        handle: "drew-codex-engineer",
        roleConfigId: "engineer",
        kind: "codex-cli"
      }, {
        id: "participant-2",
        handle: "taylor-claude-engineer",
        roleConfigId: "engineer",
        kind: "claude-code"
      }]
    }
  };
}

function participantMessage(
  id: string,
  patch: Partial<ChatMessage> = {},
  participant: { id: string; handle: string } = { id: "participant-1", handle: "drew-codex-engineer" }
): ChatMessage {
  return {
    id,
    role: "participant",
    participantId: participant.id,
    participantLabel: `@${participant.handle}`,
    content: `${id} content`,
    createdAt: "2026-01-08T12:00:00.000Z",
    status: "done",
    ...patch,
    metadata: {
      ...patch.metadata
    }
  };
}
