import assert from "node:assert/strict";
import test from "node:test";
import { ChatService } from "./chat";
import type {
  AgentContextUsage,
  ChatParticipant,
  ChatRoleConfig,
  Conversation,
  ConversationSummary,
  ConversationUpdate,
  RemoteSessionCleanupTombstone
} from "../../shared/types";

const NOW = "2026-05-19T12:00:00.000Z";
const ROLE: ChatRoleConfig = {
  id: "engineer",
  label: "Engineer",
  instructions: "Answer directly.",
  version: 1,
  appToolCapabilities: [],
  updatedAt: NOW
};

function cloneConversation(conversation: Conversation): Conversation {
  return JSON.parse(JSON.stringify(conversation)) as Conversation;
}

function chatConversation(patch: Partial<Conversation> = {}): Conversation {
  const participant: ChatParticipant = { id: "participant-1", handle: "drew", roleConfigId: ROLE.id, kind: "codex-cli" };
  return {
    id: "conversation-1",
    title: "Test chat",
    kind: "chat",
    createdAt: NOW,
    updatedAt: NOW,
    repoPath: "/repo",
    messages: [
      { id: "message-1", role: "system", content: "Chat started.", createdAt: NOW, status: "done" },
      { id: "message-2", role: "user", content: "Hello", createdAt: NOW, status: "done" }
    ],
    findings: [],
    metadata: { participants: [participant], participantSessions: [] },
    ...patch
  };
}

/** In-memory storage that reports save tokens like the real one, so the
 *  in-memory refresh path is exercised; `owned` simulates a foreign write. */
function testService(conversationList: Conversation[]): {
  service: ChatService;
  storage: { owned: boolean; reads: string[]; tokens: string[]; ownershipChecks: Array<{ conversationId: string; token: string }> };
  updates: ConversationUpdate[];
} {
  const conversations = new Map(conversationList.map((conversation) => [conversation.id, cloneConversation(conversation)]));
  const updates: ConversationUpdate[] = [];
  const state = { owned: true, reads: [] as string[], tokens: [] as string[], ownershipChecks: [] as Array<{ conversationId: string; token: string }> };
  const storage = {
    async listConversations(): Promise<ConversationSummary[]> {
      return Array.from(conversations.values()).map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        kind: conversation.kind,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        repoPath: conversation.repoPath,
        running: Boolean(conversation.metadata.running)
      }));
    },
    async getConversation(id: string): Promise<Conversation | undefined> {
      state.reads.push(id);
      const conversation = conversations.get(id);
      return conversation ? cloneConversation(conversation) : undefined;
    },
    async saveConversation(conversation: Conversation): Promise<string> {
      conversations.set(conversation.id, cloneConversation(conversation));
      const token = `token-${state.tokens.length + 1}`;
      state.tokens.push(token);
      return token;
    },
    async isConversationSaveOwned(conversationId: string, token: string): Promise<boolean> {
      state.ownershipChecks.push({ conversationId, token });
      return state.owned && token === state.tokens[state.tokens.length - 1];
    },
    async deleteConversation(id: string): Promise<boolean> {
      return conversations.delete(id);
    }
  };
  const settings = {
    async getPublicSettings(): Promise<{ chatRoleConfigs: ChatRoleConfig[]; chatParticipantConfigs: [] }> {
      return { chatRoleConfigs: [ROLE], chatParticipantConfigs: [] };
    },
    async removeRemoteSessionCleanupTombstone(): Promise<void> {
      return undefined;
    }
  };
  const cliRunner = {
    async detectAgents(): Promise<[]> {
      return [];
    },
    async contextUsageForSession(): Promise<AgentContextUsage | undefined> {
      return undefined;
    }
  };
  const debugLogs = {
    async write(): Promise<void> {
      return undefined;
    }
  };
  const service = new ChatService(
    storage as never,
    settings as never,
    cliRunner as never,
    debugLogs as never,
    undefined,
    (_conversation, update) => updates.push(update)
  );
  (service as unknown as { ensureHistoryFiles(conversation: Conversation): Promise<string> }).ensureHistoryFiles = async () => "/mock/history";
  return { service, storage: state, updates };
}

test("a mutation after this process's own save merges from memory and only re-reads storage after a foreign write", async () => {
  const conversation = chatConversation();
  const { service, storage, updates } = testService([conversation]);
  // renameConversation saves through the direct path, which remembers the snapshot with its token.
  const renamed = await service.renameConversation({ conversationId: conversation.id, title: "Renamed" });
  assert.ok(renamed);
  assert.equal(storage.tokens.length, 1);
  assert.equal(updates.at(-1)?.title, "Renamed");
  assert.equal(updates.at(-1)?.messageDelta, undefined, "the first emission for a chat is a full update");

  storage.reads.length = 0;
  // hydrateContextUsage runs withChatMutation -> refreshStoredChatState.
  const hydrated = await service.hydrateContextUsage(cloneConversation(renamed));
  assert.deepEqual(storage.reads, [], "the row still carries our token, so nothing is re-read");
  assert.deepEqual(storage.ownershipChecks.at(-1), { conversationId: conversation.id, token: "token-1" });
  assert.equal(hydrated.title, "Renamed");
  assert.deepEqual(hydrated.messages.map((message) => message.id), ["message-1", "message-2"]);

  storage.owned = false;
  await service.hydrateContextUsage(cloneConversation(renamed));
  assert.deepEqual(storage.reads, [conversation.id], "a foreign write falls back to reading storage");
});

test("messages adopted from the shared saved snapshot are copies, and the next update is a delta", async () => {
  const conversation = chatConversation();
  const { service, updates } = testService([conversation]);
  const renamed = await service.renameConversation({ conversationId: conversation.id, title: "Renamed" });
  assert.ok(renamed);
  // A live conversation that lacks message-2 adopts it from the saved snapshot during refresh.
  const live = cloneConversation(renamed);
  live.messages = live.messages.slice(0, 1);
  const refreshed = await service.hydrateContextUsage(live);
  const adopted = refreshed.messages.find((message) => message.id === "message-2");
  assert.ok(adopted);
  const internal = service as unknown as { lastSavedSnapshots: Map<string, { snapshot: Conversation; token: string }> };
  const saved = internal.lastSavedSnapshots.get(conversation.id)?.snapshot;
  assert.ok(saved);
  assert.notEqual(adopted, saved.messages[1], "the live conversation must not hold the snapshot's object");
  adopted.content = "edited in place";
  assert.equal(saved.messages[1].content, "Hello", "in-place edits of the live conversation stay out of the saved snapshot");

  const renamedAgain = await service.renameConversation({ conversationId: conversation.id, title: "Renamed twice" });
  assert.ok(renamedAgain);
  const latest = updates.at(-1);
  assert.ok(latest?.messageDelta, "a later emission for the same chat is a delta");
  assert.equal(latest.messageDelta.totalMessages, 2);
  assert.equal(latest.title, "Renamed twice");
});
