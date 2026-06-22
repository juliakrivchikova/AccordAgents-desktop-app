import assert from "node:assert/strict";
import test from "node:test";
import { ChatService } from "./chat";
import type {
  AgentContextUsage,
  ChatParticipant,
  ChatParticipantConfig,
  ChatParticipantSession,
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

test("setArchived archives a chat by stamping metadata and bumping updatedAt", async () => {
  const conversation = chatConversation({ title: "Archive me" });
  const { service, storage } = testService([conversation]);

  const saved = await service.setArchived({ conversationId: conversation.id, archived: true });

  assert.equal(saved?.metadata.archived, true);
  assert.equal(typeof saved?.metadata.archivedAt, "string");
  assert.notEqual(saved?.updatedAt, NOW);
  assert.equal(saved?.messages.length, conversation.messages.length);
  const stored = await storage.getConversation(conversation.id);
  assert.equal(stored?.metadata.archived, true);
  assert.equal(typeof stored?.metadata.archivedAt, "string");
});

test("setArchived unarchiving removes both archived and archivedAt", async () => {
  const conversation = chatConversation({
    title: "Archived chat",
    metadata: { archived: true, archivedAt: NOW }
  });
  const { service, storage } = testService([conversation]);

  const saved = await service.setArchived({ conversationId: conversation.id, archived: false });

  assert.equal("archived" in (saved?.metadata ?? {}), false);
  assert.equal("archivedAt" in (saved?.metadata ?? {}), false);
  const stored = await storage.getConversation(conversation.id);
  assert.equal("archived" in (stored?.metadata ?? {}), false);
  assert.equal("archivedAt" in (stored?.metadata ?? {}), false);
});

test("setArchived is a no-op when the archived state already matches", async () => {
  const conversation = chatConversation({
    title: "Already archived",
    metadata: { archived: true, archivedAt: NOW }
  });
  const { service } = testService([conversation]);

  const saved = await service.setArchived({ conversationId: conversation.id, archived: true });

  assert.equal(saved?.metadata.archivedAt, NOW);
  assert.equal(saved?.updatedAt, NOW);
});

test("setArchived rejects non-chat conversations", async () => {
  const conversation = chatConversation({ title: "Review", kind: "code-review" });
  const { service } = testService([conversation]);

  await assert.rejects(
    () => service.setArchived({ conversationId: conversation.id, archived: true }),
    /Only chat conversations can be archived/
  );
});

test("setArchived rejects running chats", async () => {
  const conversation = chatConversation({
    title: "Running chat",
    metadata: { running: true }
  });
  const { service, storage } = testService([conversation]);

  await assert.rejects(
    () => service.setArchived({ conversationId: conversation.id, archived: true }),
    /cannot be archived while participants are running/
  );
  assert.equal((await storage.getConversation(conversation.id))?.metadata.archived, undefined);
});

test("setArchived rejects when a chat run already owns the run queue", async () => {
  const conversation = chatConversation({ title: "Queued chat" });
  const { service, storage } = testService([conversation]);
  const releaseRun = await holdChatRunLock(service, conversation.id);

  try {
    await assert.rejects(
      () => service.setArchived({ conversationId: conversation.id, archived: true }),
      /cannot be archived while participants are running/
    );
    assert.equal((await storage.getConversation(conversation.id))?.metadata.archived, undefined);
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
  assert.equal(participant?.participantConfigId, "saved-drew");
  assert.equal(saved?.updatedAt, NOW);
  assert.equal(saved?.messages.length, conversation.messages.length);
  assert.equal(snapshotParticipants[0]?.avatarId, "codex-logo");
});

test("syncSavedParticipantConfig refreshes copied chat participant behavior rules", async () => {
  const conversation = chatConversation({
    metadata: {
      participants: [chatParticipant({ avatarId: "codex-cat", behaviorRuleIds: ["old-rule"] })],
      participantSessions: []
    }
  });
  const { service, storage, snapshots } = testService([conversation]);

  await service.syncSavedParticipantConfig(
    { handle: "drew", kind: "codex-cli" },
    {
      id: "saved-drew",
      handle: "drew",
      kind: "codex-cli",
      avatarId: "codex-logo",
      behaviorRuleIds: ["new-rule"]
    }
  );

  const saved = await storage.getConversation(conversation.id);
  const participant = ((saved?.metadata.participants ?? []) as ChatParticipant[])[0];
  const snapshotParticipant = ((snapshots.at(-1)?.metadata.participants ?? []) as ChatParticipant[])[0];
  assert.equal(participant?.participantConfigId, "saved-drew");
  assert.equal(participant?.avatarId, "codex-logo");
  assert.deepEqual(participant?.behaviorRuleIds, ["new-rule"]);
  assert.deepEqual(snapshotParticipant?.behaviorRuleIds, ["new-rule"]);
});

test("syncSavedParticipantConfig does not legacy-match participants linked to another preset", async () => {
  const conversation = chatConversation({
    metadata: {
      participants: [
        chatParticipant({
          participantConfigId: "other-preset",
          avatarId: "codex-cat",
          behaviorRuleIds: ["other-rule"]
        })
      ],
      participantSessions: []
    }
  });
  const { service, storage, snapshots } = testService([conversation]);

  await service.syncSavedParticipantConfig(
    { handle: "drew", kind: "codex-cli" },
    {
      id: "saved-drew",
      handle: "drew",
      kind: "codex-cli",
      avatarId: "codex-logo",
      behaviorRuleIds: ["new-rule"]
    }
  );

  const saved = await storage.getConversation(conversation.id);
  const participant = ((saved?.metadata.participants ?? []) as ChatParticipant[])[0];
  assert.equal(participant?.participantConfigId, "other-preset");
  assert.equal(participant?.avatarId, "codex-cat");
  assert.deepEqual(participant?.behaviorRuleIds, ["other-rule"]);
  assert.equal(snapshots.length, 0);
});

test("hydrateContextUsage refreshes copied participant avatars from saved settings", async () => {
  const conversation = chatConversation({
    metadata: {
      participants: [chatParticipant({ avatarId: "codex-cat", behaviorRuleIds: ["old-rule"] })],
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
      behaviorRuleIds: ["new-rule"],
      updatedAt: NOW
    }]
  });

  const hydrated = await service.hydrateContextUsage(conversation);

  const saved = await storage.getConversation(conversation.id);
  const hydratedParticipants = (hydrated.metadata.participants ?? []) as ChatParticipant[];
  const savedParticipants = (saved?.metadata.participants ?? []) as ChatParticipant[];
  assert.equal(hydratedParticipants[0]?.avatarId, "codex-logo");
  assert.equal(savedParticipants[0]?.avatarId, "codex-logo");
  assert.equal(hydratedParticipants[0]?.participantConfigId, "saved-drew");
  assert.deepEqual(hydratedParticipants[0]?.behaviorRuleIds, ["new-rule"]);
  assert.deepEqual(savedParticipants[0]?.behaviorRuleIds, ["new-rule"]);
  assert.equal(saved?.updatedAt, NOW);
  assert.equal(((snapshots.at(-1)?.metadata.participants ?? []) as ChatParticipant[])[0]?.avatarId, "codex-logo");
});

test("removeBehaviorRuleFromChatParticipants removes deleted behavior rules from copied chat participants", async () => {
  const conversation = chatConversation({
    metadata: {
      participants: [chatParticipant({ behaviorRuleIds: ["keep-rule", "deleted-rule"] })],
      participantSessions: []
    }
  });
  const { service, storage, snapshots } = testService([conversation]);

  await service.removeBehaviorRuleFromChatParticipants("deleted-rule");

  const saved = await storage.getConversation(conversation.id);
  const participant = ((saved?.metadata.participants ?? []) as ChatParticipant[])[0];
  const snapshotParticipant = ((snapshots.at(-1)?.metadata.participants ?? []) as ChatParticipant[])[0];
  assert.deepEqual(participant?.behaviorRuleIds, ["keep-rule"]);
  assert.deepEqual(snapshotParticipant?.behaviorRuleIds, ["keep-rule"]);
});

test("hydrateContextUsage refreshes stale stored context usage for existing sessions", async () => {
  const participant = chatParticipant({ model: "gpt-5.5" });
  const staleUsage: AgentContextUsage = {
    usedTokens: 26_000,
    contextWindowTokens: 258_000,
    percentage: 10,
    source: "codex-cli",
    updatedAt: "2026-05-19T12:00:00.000Z",
    model: "gpt-5.5"
  };
  const freshUsage: AgentContextUsage = {
    usedTokens: 193_000,
    contextWindowTokens: 258_000,
    percentage: 75,
    source: "codex-cli",
    updatedAt: "2026-05-19T12:01:00.000Z",
    model: "gpt-5.5"
  };
  const conversation = chatConversation({
    metadata: {
      participants: [participant],
      participantSessions: [chatSession(participant, "019ed183-1d77-7450-9070-6ea6f0b61aa7")],
      agentContextUsageByParticipant: {
        [participant.id]: staleUsage
      }
    }
  });
  const { service, storage } = testService([conversation], {
    contextUsageBySession: {
      "019ed183-1d77-7450-9070-6ea6f0b61aa7": freshUsage
    }
  });

  const hydrated = await service.hydrateContextUsage(conversation);
  const saved = await storage.getConversation(conversation.id);
  const hydratedUsage = hydrated.metadata.agentContextUsageByParticipant as Record<string, AgentContextUsage>;
  const savedUsage = saved?.metadata.agentContextUsageByParticipant as Record<string, AgentContextUsage> | undefined;

  assert.equal(hydratedUsage[participant.id]?.usedTokens, 193_000);
  assert.equal(savedUsage?.[participant.id]?.usedTokens, 193_000);
});

test("hydrateContextUsage does not overwrite newer stored context usage from a stale caller snapshot", async () => {
  const participant = chatParticipant({ model: "gpt-5.5" });
  const staleUsage: AgentContextUsage = {
    usedTokens: 26_000,
    contextWindowTokens: 258_000,
    percentage: 10,
    source: "codex-cli",
    updatedAt: "2026-05-19T12:00:00.000Z",
    model: "gpt-5.5"
  };
  const newerStoredUsage: AgentContextUsage = {
    usedTokens: 193_000,
    contextWindowTokens: 258_000,
    percentage: 75,
    source: "codex-cli",
    updatedAt: "2026-05-19T12:02:00.000Z",
    model: "gpt-5.5"
  };
  const staleLogUsage: AgentContextUsage = {
    usedTokens: 51_000,
    contextWindowTokens: 258_000,
    percentage: 20,
    source: "codex-cli",
    updatedAt: "2026-05-19T12:01:00.000Z",
    model: "gpt-5.5"
  };
  const conversation = chatConversation({
    metadata: {
      participants: [participant],
      participantSessions: [chatSession(participant, "019ed183-1d77-7450-9070-6ea6f0b61aa7")],
      agentContextUsageByParticipant: {
        [participant.id]: staleUsage
      }
    }
  });
  const { service, storage } = testService([conversation], {
    contextUsageBySession: {
      "019ed183-1d77-7450-9070-6ea6f0b61aa7": staleLogUsage
    }
  });
  const storedConversation = cloneConversation(conversation);
  storedConversation.metadata.agentContextUsageByParticipant = {
    [participant.id]: newerStoredUsage
  };
  await storage.saveConversation(storedConversation);

  const hydrated = await service.hydrateContextUsage(conversation);
  const saved = await storage.getConversation(conversation.id);
  const hydratedUsage = hydrated.metadata.agentContextUsageByParticipant as Record<string, AgentContextUsage>;
  const savedUsage = saved?.metadata.agentContextUsageByParticipant as Record<string, AgentContextUsage> | undefined;

  assert.equal(hydratedUsage[participant.id]?.usedTokens, 193_000);
  assert.equal(savedUsage?.[participant.id]?.usedTokens, 193_000);
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

function testService(conversationList: Conversation[], options: {
  participantConfigs?: ChatParticipantConfig[];
  contextUsageBySession?: Record<string, AgentContextUsage | undefined>;
} = {}): {
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
    },
    async contextUsageForSession(_participant: unknown, sessionId: string | undefined): Promise<AgentContextUsage | undefined> {
      return sessionId ? options.contextUsageBySession?.[sessionId] : undefined;
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

function chatSession(participant: ChatParticipant, sessionId: string): ChatParticipantSession {
  return {
    participantId: participant.id,
    sessionId,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: ROLE.version,
    participantKind: participant.kind,
    participantModel: participant.model,
    runtimeConfigVersion: 1,
    roleLabel: ROLE.label,
    roleInstructions: ROLE.instructions,
    updatedAt: NOW
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
