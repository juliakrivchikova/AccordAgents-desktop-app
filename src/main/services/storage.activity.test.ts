import assert from "node:assert/strict";
import test from "node:test";
import { StorageService } from "./storage";
import type { ChatAppToolApproval, ChatMessage, Conversation } from "../../shared/types";

function fakeStorage(queryJson: (sql: string) => Promise<unknown[]>): StorageService {
  const storage = Object.create(StorageService.prototype) as any;
  storage.init = async () => {};
  storage.queryJson = queryJson;
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
  assert.ok(queries[1].includes("conversation_id in ('chat-1')"));
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
      }]
    }
  };
}

function participantMessage(id: string, patch: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    role: "participant",
    participantId: "participant-1",
    participantLabel: "@drew-codex-engineer",
    content: `${id} content`,
    createdAt: "2026-01-08T12:00:00.000Z",
    status: "done",
    ...patch,
    metadata: {
      ...patch.metadata
    }
  };
}
