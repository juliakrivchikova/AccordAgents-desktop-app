import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ChatParticipant, ChatParticipantSession, ChatRoleConfig, Conversation, ParticipantConfig } from "../../shared/types";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { ChatService } from "./chat";

const NOW = "2026-01-01T00:00:00.000Z";
const ROLE: ChatRoleConfig = {
  id: "administrator",
  label: "Administrator",
  instructions: "Answer directly.",
  version: 1,
  updatedAt: NOW
};

test("chat:send routes exact @participant /compact to participant compaction", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-compact-"));
  try {
    const participant = chatParticipant();
    const conversation = chatConversation([participant], [chatSession(participant, "session-1")]);
    let compactCalls = 0;
    const { service, storage } = testService({
      conversation,
      compactSession: async (runParticipant, _repoPath, _diffMode, kind, _signal, options) => {
        compactCalls += 1;
        assert.equal(runParticipant.id, participant.id);
        assert.equal(kind, "chat");
        assert.equal(options.sessionId, "session-1");
        assert.equal("compactInstructions" in options, false);
        return {
          participant: runParticipant,
          ok: true,
          sessionId: "session-1",
          contextUsage: {
            usedTokens: 100,
            contextWindowTokens: 1000,
            percentage: 10,
            source: "codex-cli",
            updatedAt: NOW
          }
        };
      }
    });
    (service as any).ensureHistoryFiles = async () => tempRoot;

    const result = await service.sendMessage({
      conversationId: conversation.id,
      runId: "compact-run",
      content: "@admin /compact"
    });

    assert.equal(compactCalls, 1);
    assert.equal(result.warnings.length, 0);
    assert.equal(storage.current.messages.some((message: any) => message.role === "user"), false);
    assert.equal(storage.current.messages.some((message: any) => message.role === "participant"), false);
    assert.equal(storage.current.messages.at(-1)?.content, "Compacted @admin context.");
    assert.equal(storage.current.metadata.agentContextUsageByParticipant?.[participant.id]?.usedTokens, 100);
    assert.equal(storage.current.metadata.running, false);
    assert.equal(storage.current.metadata.activeRunIds, undefined);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("chat:send routes @participant /compact instructions to participant compaction", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-compact-instructions-"));
  try {
    const participant = chatParticipant();
    const conversation = chatConversation([participant], [chatSession(participant, "session-1")]);
    let compactInstructions: unknown;
    const { service, storage } = testService({
      conversation,
      compactSession: async (runParticipant, _repoPath, _diffMode, _kind, _signal, options) => {
        compactInstructions = options.compactInstructions;
        return {
          participant: runParticipant,
          ok: true,
          sessionId: "session-1"
        };
      }
    });
    (service as any).ensureHistoryFiles = async () => tempRoot;

    await service.sendMessage({
      conversationId: conversation.id,
      runId: "compact-run",
      content: "@admin /compact keep focus on command parsing and Codex compact_prompt"
    });

    assert.equal(compactInstructions, "keep focus on command parsing and Codex compact_prompt");
    assert.equal(storage.current.messages.some((message: any) => message.role === "user"), false);
    assert.equal(storage.current.messages.at(-1)?.content, "Compacted @admin context with focus instructions.");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("compactParticipant refreshes stored context usage from the session after compact", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-compact-usage-"));
  try {
    const participant = chatParticipant();
    const conversation = chatConversation([participant], [chatSession(participant, "session-1")]);
    conversation.metadata.agentContextUsageByParticipant = {
      [participant.id]: {
        usedTokens: 900,
        contextWindowTokens: 1000,
        percentage: 90,
        source: "codex-cli",
        updatedAt: NOW
      }
    };
    const { service, storage } = testService({
      conversation,
      compactSession: async (runParticipant) => ({
        participant: runParticipant,
        ok: true,
        sessionId: "session-1"
      }),
      contextUsageForSession: async (_runParticipant, sessionId) => {
        assert.equal(sessionId, "session-1");
        return {
          usedTokens: 120,
          contextWindowTokens: 1000,
          percentage: 12,
          source: "codex-cli",
          updatedAt: NOW
        };
      }
    });
    (service as any).ensureHistoryFiles = async () => tempRoot;

    await service.compactParticipant({
      conversationId: conversation.id,
      participantId: participant.id,
      runId: "compact-usage"
    });

    assert.equal(storage.current.metadata.agentContextUsageByParticipant?.[participant.id]?.usedTokens, 120);
    assert.equal(storage.current.metadata.agentContextUsageByParticipant?.[participant.id]?.percentage, 12);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("compactParticipant clears running state when compact fails", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-compact-failure-"));
  try {
    const participant = chatParticipant();
    const conversation = chatConversation([participant], [chatSession(participant, "session-1")]);
    conversation.metadata.agentContextUsageByParticipant = {
      [participant.id]: {
        usedTokens: 900,
        contextWindowTokens: 1000,
        percentage: 90,
        source: "codex-cli",
        updatedAt: NOW
      }
    };
    const { service, storage } = testService({
      conversation,
      compactSession: async (runParticipant) => ({
        participant: runParticipant,
        ok: false,
        error: "codex app-server compact timed out after 300000ms"
      }),
      contextUsageForSession: async (_runParticipant, sessionId) => {
        assert.equal(sessionId, "session-1");
        return {
          usedTokens: 120,
          contextWindowTokens: 1000,
          percentage: 12,
          source: "codex-cli",
          updatedAt: "2026-01-01T00:01:00.000Z"
        };
      }
    });
    (service as any).ensureHistoryFiles = async () => tempRoot;

    const result = await service.compactParticipant({
      conversationId: conversation.id,
      participantId: participant.id,
      runId: "compact-failure"
    });

    assert.equal(result.warnings.length, 1);
    assert.equal(storage.current.messages.at(-1)?.content, "Could not compact @admin context: codex app-server compact timed out after 300000ms.");
    assert.equal(storage.current.metadata.running, false);
    assert.equal(storage.current.metadata.runId, undefined);
    assert.equal(storage.current.metadata.activeRunIds, undefined);
    assert.equal(storage.current.metadata.agentContextUsageByParticipant?.[participant.id]?.usedTokens, 120);
    assert.equal(storage.current.metadata.agentContextUsageByParticipant?.[participant.id]?.percentage, 12);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("compactParticipant does not overwrite newer context usage after compact failure", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-compact-stale-usage-"));
  try {
    const participant = chatParticipant();
    const conversation = chatConversation([participant], [chatSession(participant, "session-1")]);
    conversation.metadata.agentContextUsageByParticipant = {
      [participant.id]: {
        usedTokens: 300,
        contextWindowTokens: 1000,
        percentage: 30,
        source: "codex-cli",
        updatedAt: "2026-01-01T00:02:00.000Z"
      }
    };
    const { service, storage } = testService({
      conversation,
      compactSession: async (runParticipant) => ({
        participant: runParticipant,
        ok: false,
        error: "codex app-server compact timed out after 300000ms"
      }),
      contextUsageForSession: async () => ({
        usedTokens: 120,
        contextWindowTokens: 1000,
        percentage: 12,
        source: "codex-cli",
        updatedAt: "2026-01-01T00:01:00.000Z"
      })
    });
    (service as any).ensureHistoryFiles = async () => tempRoot;

    await service.compactParticipant({
      conversationId: conversation.id,
      participantId: participant.id,
      runId: "compact-stale-usage"
    });

    assert.equal(storage.current.metadata.agentContextUsageByParticipant?.[participant.id]?.usedTokens, 300);
    assert.equal(storage.current.metadata.agentContextUsageByParticipant?.[participant.id]?.percentage, 30);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("compactParticipant records a clear note when the participant has no active session", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation([participant], []);
  let compactCalls = 0;
  const { service, storage } = testService({
    conversation,
    compactSession: async (runParticipant) => {
      compactCalls += 1;
      return { participant: runParticipant, ok: true };
    }
  });

  const result = await service.compactParticipant({
    conversationId: conversation.id,
    participantId: participant.id,
    runId: "compact-empty-session"
  });

  assert.equal(compactCalls, 0);
  assert.equal(result.warnings.length, 0);
  assert.equal(storage.current.messages.at(-1)?.content, "@admin does not have an active session to compact yet.");
});

function testService(options: {
  conversation: Conversation;
  compactSession: (participant: ParticipantConfig, repoPath: string | undefined, diffMode: undefined, kind: "chat", signal: AbortSignal | undefined, options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  contextUsageForSession?: (participant: ParticipantConfig, sessionId: string | undefined) => Promise<Record<string, unknown> | undefined>;
}): { service: ChatService; storage: any } {
  const storage = {
    current: clone(options.conversation),
    async getConversation(id: string): Promise<Conversation | undefined> {
      return this.current?.id === id ? clone(this.current) : undefined;
    },
    async saveConversation(conversation: Conversation): Promise<void> {
      this.current = clone(conversation);
    }
  };
  const settings = {
    async getPublicSettings(): Promise<{ chatRoleConfigs: ChatRoleConfig[] }> {
      return { chatRoleConfigs: [ROLE] };
    }
  };
  const cliRunner = {
    async compactSession(...args: Parameters<typeof options.compactSession>): Promise<Record<string, unknown>> {
      return options.compactSession(...args);
    },
    async contextUsageForSession(participant: ParticipantConfig, sessionId: string | undefined): Promise<Record<string, unknown> | undefined> {
      return options.contextUsageForSession?.(participant, sessionId);
    }
  };
  const debugLogs = {
    async write(): Promise<void> {
      return undefined;
    }
  };
  return {
    service: new ChatService(storage as never, settings as never, cliRunner as never, debugLogs as never),
    storage
  };
}

function chatParticipant(patch: Partial<ChatParticipant> = {}): ChatParticipant {
  return {
    id: patch.id ?? "codex-admin",
    handle: patch.handle ?? "admin",
    roleConfigId: ROLE.id,
    kind: patch.kind ?? "codex-cli",
    agentMode: "default",
    permissions: normalizeChatAgentPermissions(defaultChatAgentPermissions()),
    ...patch
  };
}

function chatSession(participant: ChatParticipant, sessionId: string): ChatParticipantSession {
  return {
    participantId: participant.id,
    sessionId,
    roleConfigId: ROLE.id,
    roleConfigVersion: ROLE.version,
    roleRuntime: "codex-developer-instructions",
    participantKind: participant.kind,
    participantAgentMode: "default",
    participantPermissions: normalizeChatAgentPermissions(participant.permissions),
    runtimeConfigVersion: 1,
    roleLabel: ROLE.label,
    roleInstructions: ROLE.instructions,
    updatedAt: NOW
  };
}

function chatConversation(participants: ChatParticipant[], sessions: ChatParticipantSession[]): Conversation {
  return {
    id: "chat-compact",
    title: "Compact test",
    kind: "chat",
    createdAt: NOW,
    updatedAt: NOW,
    messages: [],
    findings: [],
    metadata: {
      participants,
      participantSessions: sessions
    }
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
