import assert from "node:assert/strict";
import test from "node:test";
import { ChatService } from "./chat";
import type {
  ChatParticipant,
  ChatParticipantConfig,
  ChatRoleConfig,
  Conversation,
  ConversationSummary
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

test("renameConversation updates chat title, emits a snapshot, and keeps the transcript unchanged", async () => {
  const conversation = chatConversation({ title: "Old chat" });
  const { service, storage, snapshots, historyWrites } = testService([conversation]);

  const saved = await service.renameConversation({
    conversationId: conversation.id,
    title: "  New chat name  "
  });

  assert.equal(saved?.title, "New chat name");
  assert.equal(saved?.messages.length, conversation.messages.length);
  assert.notEqual(saved?.updatedAt, NOW);
  assert.equal((await storage.getConversation(conversation.id))?.title, "New chat name");
  assert.equal(snapshots.at(-1)?.title, "New chat name");
  assert.deepEqual(historyWrites, ["New chat name"]);
});

test("renameConversation normalizes long and blank chat titles", async () => {
  const conversation = chatConversation({ title: "Old chat" });
  const { service, storage } = testService([conversation]);
  const longTitle = ` ${"x".repeat(90)} `;

  const longSaved = await service.renameConversation({
    conversationId: conversation.id,
    title: longTitle
  });
  assert.equal(longSaved?.title, "x".repeat(80));

  const blankSaved = await service.renameConversation({
    conversationId: conversation.id,
    title: "   "
  });
  assert.equal(blankSaved?.title, "Chat");
  assert.equal((await storage.getConversation(conversation.id))?.title, "Chat");
});

test("renameConversation rejects non-chat conversations", async () => {
  const conversation = chatConversation({
    title: "Review",
    kind: "code-review"
  });
  const { service } = testService([conversation]);

  await assert.rejects(
    () => service.renameConversation({ conversationId: conversation.id, title: "New title" }),
    /Only chat conversations can be renamed/
  );
});

test("renameConversation rejects running chats", async () => {
  const conversation = chatConversation({
    title: "Running chat",
    metadata: { running: true }
  });
  const { service, storage } = testService([conversation]);

  await assert.rejects(
    () => service.renameConversation({ conversationId: conversation.id, title: "New title" }),
    /cannot be edited while participants are running/
  );
  assert.equal((await storage.getConversation(conversation.id))?.title, "Running chat");
});

test("renameConversation rejects when a chat run already owns the run queue", async () => {
  const conversation = chatConversation({ title: "Queued chat" });
  const { service, storage } = testService([conversation]);
  const releaseRun = await holdChatRunLock(service, conversation.id);

  try {
    await assert.rejects(
      () => service.renameConversation({ conversationId: conversation.id, title: "New title" }),
      /cannot be edited while participants are running/
    );
    assert.equal((await storage.getConversation(conversation.id))?.title, "Queued chat");
  } finally {
    await releaseRun();
  }
});

test("addParticipant serializes concurrent roster additions without dropping a participant", async () => {
  const conversation = chatConversation({ title: "Roster chat" });
  const { service, storage } = testService([conversation]);

  await Promise.all([
    service.addParticipant({
      conversationId: conversation.id,
      participant: {
        handle: "taylor",
        roleConfigId: ROLE.id,
        kind: "claude-code"
      }
    }),
    service.addParticipant({
      conversationId: conversation.id,
      participant: {
        handle: "alex",
        roleConfigId: ROLE.id,
        kind: "codex-cli"
      }
    })
  ]);

  const saved = await storage.getConversation(conversation.id);
  const participants = (saved?.metadata.participants ?? []) as ChatParticipant[];
  assert.deepEqual(
    participants.map((participant) => participant.handle).sort(),
    ["alex", "drew", "taylor"]
  );
  assert.equal(saved?.messages.filter((message) => message.content === "Added @taylor to the chat.").length, 1);
  assert.equal(saved?.messages.filter((message) => message.content === "Added @alex to the chat.").length, 1);
});

test("syncSavedParticipantAvatar refreshes copied chat participant avatars", async () => {
  const conversation = chatConversation({
    metadata: {
      participants: [chatParticipant({ avatarId: "codex-cat" })],
      participantSessions: []
    }
  });
  const { service, storage, snapshots } = testService([conversation]);

  await service.syncSavedParticipantAvatar(
    { handle: "drew", kind: "codex-cli" },
    { id: "saved-drew", handle: "drew", kind: "codex-cli", avatarId: "codex-logo" }
  );

  const saved = await storage.getConversation(conversation.id);
  const savedParticipants = (saved?.metadata.participants ?? []) as ChatParticipant[];
  const snapshotParticipants = (snapshots.at(-1)?.metadata.participants ?? []) as ChatParticipant[];
  const participant = savedParticipants[0];
  assert.equal(participant?.avatarId, "codex-logo");
  assert.equal(saved?.updatedAt, NOW);
  assert.equal(saved?.messages.length, conversation.messages.length);
  assert.equal(snapshotParticipants[0]?.avatarId, "codex-logo");
});

test("hydrateContextUsage refreshes copied participant avatars from saved settings", async () => {
  const conversation = chatConversation({
    metadata: {
      participants: [chatParticipant({ avatarId: "codex-cat" })],
      participantSessions: []
    }
  });
  const { service, storage, snapshots } = testService([conversation], {
    participantConfigs: [{
      id: "saved-drew",
      handle: "drew",
      roleConfigId: ROLE.id,
      kind: "codex-cli",
      avatarId: "codex-logo",
      updatedAt: NOW
    }]
  });

  const hydrated = await service.hydrateContextUsage(conversation);

  const saved = await storage.getConversation(conversation.id);
  const hydratedParticipants = (hydrated.metadata.participants ?? []) as ChatParticipant[];
  const savedParticipants = (saved?.metadata.participants ?? []) as ChatParticipant[];
  assert.equal(hydratedParticipants[0]?.avatarId, "codex-logo");
  assert.equal(savedParticipants[0]?.avatarId, "codex-logo");
  assert.equal(saved?.updatedAt, NOW);
  assert.equal(((snapshots.at(-1)?.metadata.participants ?? []) as ChatParticipant[])[0]?.avatarId, "codex-logo");
});

test("hydrateContextUsage preserves newer stored messages when syncing participant avatars", async () => {
  const staleConversation = chatConversation({
    metadata: {
      participants: [chatParticipant({ avatarId: "codex-cat" })],
      participantSessions: []
    }
  });
  const storedConversation = cloneConversation(staleConversation);
  storedConversation.messages.push({
    id: "message-2",
    role: "participant",
    participantId: "participant-1",
    participantLabel: "@drew",
    content: "Already saved.",
    createdAt: NOW,
    status: "done"
  });
  const { service, storage } = testService([storedConversation], {
    participantConfigs: [{
      id: "saved-drew",
      handle: "drew",
      roleConfigId: ROLE.id,
      kind: "codex-cli",
      avatarId: "codex-logo",
      updatedAt: NOW
    }]
  });

  const hydrated = await service.hydrateContextUsage(staleConversation);

  const saved = await storage.getConversation(staleConversation.id);
  assert.equal(saved?.messages.some((message) => message.id === "message-2"), true);
  assert.equal(hydrated.messages.some((message) => message.id === "message-2"), true);
  assert.equal(((saved?.metadata.participants ?? []) as ChatParticipant[])[0]?.avatarId, "codex-logo");
});

function testService(conversationList: Conversation[], options: { participantConfigs?: ChatParticipantConfig[] } = {}): {
  service: ChatService;
  storage: {
    listConversations(): Promise<ConversationSummary[]>;
    getConversation(id: string): Promise<Conversation | undefined>;
    saveConversation(conversation: Conversation): Promise<void>;
  };
  snapshots: Conversation[];
  historyWrites: string[];
} {
  const conversations = new Map(conversationList.map((conversation) => [conversation.id, cloneConversation(conversation)]));
  const snapshots: Conversation[] = [];
  const historyWrites: string[] = [];
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
      const conversation = conversations.get(id);
      return conversation ? cloneConversation(conversation) : undefined;
    },
    async saveConversation(conversation: Conversation): Promise<void> {
      conversations.set(conversation.id, cloneConversation(conversation));
    }
  };
  const settings = {
    async getPublicSettings(): Promise<{ chatRoleConfigs: ChatRoleConfig[]; chatParticipantConfigs: ChatParticipantConfig[] }> {
      return { chatRoleConfigs: [ROLE], chatParticipantConfigs: options.participantConfigs ?? [] };
    }
  };
  const cliRunner = {
    async detectAgents(): Promise<[]> {
      return [];
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
    (conversation) => snapshots.push(cloneConversation(conversation))
  );
  (service as unknown as { ensureHistoryFiles(conversation: Conversation): Promise<string> }).ensureHistoryFiles = async (conversation) => {
    historyWrites.push(conversation.title);
    return "/mock/history";
  };
  return { service, storage, snapshots, historyWrites };
}

function chatConversation(patch: Partial<Conversation> = {}): Conversation {
  return {
    id: "conversation-1",
    title: "Test chat",
    kind: "chat",
    createdAt: NOW,
    updatedAt: NOW,
    repoPath: "/repo",
    messages: [{
      id: "message-1",
      role: "system",
      content: "Chat started.",
      createdAt: NOW,
      status: "done"
    }],
    findings: [],
    metadata: {
      participants: [chatParticipant()],
      participantSessions: [],
      ...(patch.metadata ?? {})
    },
    ...patch
  };
}

function chatParticipant(patch: Partial<ChatParticipant> = {}): ChatParticipant {
  return {
    id: "participant-1",
    handle: "drew",
    roleConfigId: ROLE.id,
    kind: "codex-cli",
    ...patch
  };
}

function cloneConversation(conversation: Conversation): Conversation {
  return JSON.parse(JSON.stringify(conversation)) as Conversation;
}

async function holdChatRunLock(service: ChatService, conversationId: string): Promise<() => Promise<void>> {
  let release!: () => void;
  let runFinished!: () => void;
  const started = new Promise<void>((resolve) => {
    void (service as unknown as {
      withChatRunLock<T>(conversationId: string, run: () => Promise<T>): Promise<T>;
    }).withChatRunLock(conversationId, async () => {
      resolve();
      await new Promise<void>((unlock) => {
        release = unlock;
      });
    }).finally(() => runFinished());
  });
  const finished = new Promise<void>((resolve) => {
    runFinished = resolve;
  });
  await started;
  return async () => {
    release();
    await finished;
  };
}
