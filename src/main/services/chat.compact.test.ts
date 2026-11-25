import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ChatParticipant, ChatParticipantSession, ChatRoleConfig, Conversation, ParticipantConfig } from "../../shared/types";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { DEFAULT_CHAT_PROMPT_CONTEXT } from "../../shared/chatPromptContext";
import { readParticipantCompactions } from "../../shared/chatRunState";
import { ChatService } from "./chat";
import type { ChatServerLink } from "./chatServerOps";
import type { HubFeedEntry, HubOp, HubOpEffect, HubTurn } from "../../shared/hubOps";

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
    const debugEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];
    let compactCalls = 0;
    const { service, storage } = testService({
      conversation,
      debugEvents,
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
    assert.deepEqual(storage.current.messages.at(-1)?.metadata?.compaction, {
      triggeredBy: "user",
      participantId: participant.id,
      outcome: "completed",
      instructionsProvided: false
    });
    assert.deepEqual(debugEvents.map(({ event, payload }) => ({ event, triggeredBy: payload.triggeredBy, outcome: payload.outcome })), [
      { event: "chat.compaction.requested", triggeredBy: "user", outcome: undefined },
      { event: "chat.compaction.finished", triggeredBy: "user", outcome: "completed" }
    ]);
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

test("/compact on a member with an added provider carries the provider env, and fails cleanly without its key", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-compact-glm-"));
  try {
    const host = { id: "host-zai", label: "Z.ai GLM", cli: "claude-code" as const, vendor: "zai" as const, baseUrl: "https://api.z.ai/api/anthropic", hasApiKey: true, updatedAt: NOW };
    const participant = chatParticipant({ id: "glm-admin", kind: "claude-code", hostId: host.id, hostLabel: host.label, hostVendor: "zai" });
    const conversation = chatConversation([participant], [chatSession(participant, "session-1")]);
    const compactOptions: any[] = [];
    let usageLookups = 0;
    const { service, storage } = testService({
      conversation,
      compactSession: async (runParticipant, _repoPath, _diffMode, _kind, _signal, options) => {
        compactOptions.push({ model: runParticipant.model, options });
        return { participant: runParticipant, ok: true, sessionId: "session-1" };
      },
      contextUsageForSession: async () => {
        usageLookups += 1;
        return undefined;
      }
    });
    (service as any).ensureHistoryFiles = async () => tempRoot;
    let apiKey: string | undefined = "zai-secret";
    (service as any).settings.getManualAgentEnvironment = async () => ({ env: {}, version: "env-v1" });
    (service as any).settings.getCliProviderHostSecret = async (id: string) => (id === host.id ? { host, apiKey } : undefined);

    await service.sendMessage({ conversationId: conversation.id, runId: "compact-glm", content: "@admin /compact" });
    assert.equal(compactOptions.length, 1);
    assert.equal(compactOptions[0].model, "glm-5.3");
    assert.equal(compactOptions[0].options.agentEnv.ANTHROPIC_BASE_URL, host.baseUrl);
    assert.equal(compactOptions[0].options.agentEnv.ANTHROPIC_AUTH_TOKEN, "zai-secret");
    assert.match(compactOptions[0].options.agentEnvKey, /^env-v1\|host:host-zai\|/);
    assert.equal(storage.current.messages.at(-1)?.content, "Compacted @admin context.");
    const lookupsAfterSuccess = usageLookups;

    // The key is gone: nothing is spawned, nothing is probed, one clean sentence.
    apiKey = undefined;
    const result = await service.sendMessage({ conversationId: conversation.id, runId: "compact-glm-missing", content: "@admin /compact" });
    assert.equal(compactOptions.length, 1);
    assert.equal(usageLookups, lookupsAfterSuccess);
    const last = storage.current.messages.at(-1);
    assert.match(last?.content ?? "", /Could not compact @admin context: @admin cannot start: Z\.ai GLM has no API key\. Add one under Local CLI setup in Settings\.$/);
    assert.equal(last?.metadata?.compaction?.outcome, "failed");
    assert.equal(result.warnings.length, 1);
    assert.equal(storage.current.metadata.activeRunIds, undefined);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("/compact on an Antigravity member on a Gemini API key stays on that key", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-compact-gemini-key-"));
  try {
    const host = { id: "host-google", label: "Google Gemini API", cli: "gemini-cli" as const, vendor: "google" as const, baseUrl: "https://generativelanguage.googleapis.com", hasApiKey: true, updatedAt: NOW };
    const participant = chatParticipant({ id: "gemini-admin", kind: "gemini-cli", hostId: host.id, hostLabel: host.label, hostVendor: "google" });
    const conversation = chatConversation([participant], [chatSession(participant, "conversation-1")]);
    const compactRuns: Array<{ participant: any; options: any }> = [];
    const { service, storage } = testService({
      conversation,
      compactSession: async (runParticipant, _repoPath, _diffMode, _kind, _signal, options) => {
        compactRuns.push({ participant: runParticipant, options });
        return { participant: runParticipant, ok: true, sessionId: "conversation-2" };
      },
      contextUsageForSession: async () => undefined
    });
    (service as any).ensureHistoryFiles = async () => tempRoot;
    (service as any).settings.getManualAgentEnvironment = async () => ({ env: {}, version: "env-v1" });
    (service as any).settings.getCliProviderHostSecret = async (id: string) => (id === host.id ? { host, apiKey: "gemini-secret" } : undefined);

    await service.sendMessage({ conversationId: conversation.id, runId: "compact-gemini-key", content: "@admin /compact" });
    assert.equal(compactRuns.length, 1);
    // Both the summary turn and the fresh conversation run on the key, never the sign-in.
    assert.deepEqual(compactRuns[0].participant.geminiSettings, { modelProvider: "gemini" });
    assert.equal(compactRuns[0].options.agentEnv.GEMINI_API_KEY, "gemini-secret");
    assert.match(compactRuns[0].options.agentEnvKey, /^env-v1\|host:host-google\|/);
    assert.equal(storage.current.messages.at(-1)?.content, "Compacted @admin context.");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("compactParticipant refreshes stored context usage from the session after compact", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-compact-usage-"));
  try {
    const participant = chatParticipant();
    const conversation = chatConversation([participant], [{ ...chatSession(participant, "session-1"), instructionsAccessHash: "abc123" }]);
    conversation.metadata.agentContextUsageByParticipant = {
      [participant.id]: {
        usedTokens: 900,
        contextWindowTokens: 1000,
        percentage: 90,
        source: "claude-code",
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
          source: "claude-code",
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
    assert.deepEqual(readParticipantCompactions(storage.current.metadata), {});
    // The list of memory notes was in the compacted context: the next turn shows it again.
    assert.ok((service as any).memoryIndexDue.has((service as any).memoryIndexKey(conversation.id, participant.id)));
    // The CLI rebuilt its instructions from its launch's text: the next turn
    // says its access again.
    const session = (storage.current.metadata.participantSessions as ChatParticipantSession[]).find((item) => item.participantId === participant.id);
    assert.equal(session?.instructionsAccessHash, "restate");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("compactParticipant schedules prompt-fallback role redelivery after Gemini session swap", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-compact-gemini-role-"));
  try {
    const participant = chatParticipant({ kind: "gemini-cli" });
    const session = {
      ...chatSession(participant, "gemini-before"),
      roleRuntime: "prompt-fallback" as const
    };
    const conversation = chatConversation([participant], [session]);
    const { service, storage } = testService({
      conversation,
      compactSession: async (runParticipant) => ({
        participant: runParticipant,
        ok: true,
        sessionId: "gemini-after"
      })
    });
    (service as any).ensureHistoryFiles = async () => tempRoot;

    await service.compactParticipant({
      conversationId: conversation.id,
      participantId: participant.id,
      runId: "compact-gemini-role"
    });

    const storedSession = storage.current.metadata.participantSessions[0] as ChatParticipantSession;
    assert.equal(storedSession.sessionId, "gemini-after");
    assert.equal(storedSession.runtimeConfigVersion, undefined);
    const next = await (service as any).sessionForParticipant(storage.current, participant);
    assert.equal(next.instructionsRefreshed, true);
    assert.equal(typeof next.session.runtimeConfigVersion, "number");
    assert.ok(next.session.runtimeConfigVersion > 0);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("compactParticipant preserves sibling active runs while compacting an idle participant", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-compact-sibling-run-"));
  try {
    const running = chatParticipant({ id: "codex-running", handle: "running" });
    const idle = chatParticipant({ id: "codex-idle", handle: "idle" });
    const conversation = chatConversation([running, idle], [chatSession(running, "session-running"), chatSession(idle, "session-idle")]);
    conversation.metadata = {
      ...conversation.metadata,
      running: true,
      runId: "other-run",
      activeRunIds: ["other-run"]
    };
    let sawCompactState = false;
    const { service, storage } = testService({
      conversation,
      compactSession: async (runParticipant) => {
        const activeRunIds = storage.current.metadata.activeRunIds;
        assert.equal(runParticipant.id, idle.id);
        assert.deepEqual(activeRunIds, ["other-run", "compact-idle"]);
        assert.deepEqual(readParticipantCompactions(storage.current.metadata), {
          [idle.id]: {
            runId: "compact-idle",
            startedAt: readParticipantCompactions(storage.current.metadata)[idle.id]!.startedAt
          }
        });
        sawCompactState = true;
        return {
          participant: runParticipant,
          ok: true,
          sessionId: "session-idle"
        };
      }
    });
    (service as any).ensureHistoryFiles = async () => tempRoot;
    (service as any).rememberActiveChatRun(conversation.id, "other-run");

    await service.compactParticipant({
      conversationId: conversation.id,
      participantId: idle.id,
      runId: "compact-idle"
    });

    assert.equal(sawCompactState, true);
    assert.equal(storage.current.metadata.running, true);
    assert.equal(storage.current.metadata.runId, "other-run");
    assert.deepEqual(storage.current.metadata.activeRunIds, ["other-run"]);
    assert.deepEqual(readParticipantCompactions(storage.current.metadata), {});
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("compactParticipant waits for an existing same-participant turn reservation", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-compact-same-participant-wait-"));
  try {
    const participant = chatParticipant();
    const conversation = chatConversation([participant], [chatSession(participant, "session-1")]);
    let compactCalls = 0;
    const { service } = testService({
      conversation,
      compactSession: async (runParticipant) => {
        compactCalls += 1;
        return {
          participant: runParticipant,
          ok: true,
          sessionId: "session-1"
        };
      }
    });
    (service as any).ensureHistoryFiles = async () => tempRoot;
    const reservation = (service as any).reserveParticipantTurn(conversation.id, participant.id);

    const compact = service.compactParticipant({
      conversationId: conversation.id,
      participantId: participant.id,
      runId: "compact-waits"
    });
    await delay(25);
    assert.equal(compactCalls, 0);

    reservation.release();
    await compact;
    assert.equal(compactCalls, 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("compactParticipant serializes double compact requests for the same participant", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-compact-double-"));
  try {
    const participant = chatParticipant();
    const conversation = chatConversation([participant], [chatSession(participant, "session-1")]);
    let activeCompactions = 0;
    let maxActiveCompactions = 0;
    let calls = 0;
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const { service } = testService({
      conversation,
      compactSession: async (runParticipant) => {
        activeCompactions += 1;
        maxActiveCompactions = Math.max(maxActiveCompactions, activeCompactions);
        calls += 1;
        if (calls === 1) {
          await firstCanFinish;
        }
        activeCompactions -= 1;
        return {
          participant: runParticipant,
          ok: true,
          sessionId: "session-1"
        };
      }
    });
    (service as any).ensureHistoryFiles = async () => tempRoot;

    const first = service.compactParticipant({
      conversationId: conversation.id,
      participantId: participant.id,
      runId: "compact-1"
    });
    await waitFor(() => calls === 1);
    const second = service.compactParticipant({
      conversationId: conversation.id,
      participantId: participant.id,
      runId: "compact-2"
    });
    await delay(25);
    assert.equal(calls, 1);
    releaseFirst();

    await Promise.all([first, second]);
    assert.equal(calls, 2);
    assert.equal(maxActiveCompactions, 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("compactParticipant clears running state when compact fails", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-compact-failure-"));
  try {
    const participant = chatParticipant();
    const conversation = chatConversation([participant], [chatSession(participant, "session-1")]);
    const debugEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];
    conversation.metadata.agentContextUsageByParticipant = {
      [participant.id]: {
        usedTokens: 900,
        contextWindowTokens: 1000,
        percentage: 90,
        source: "claude-code",
        updatedAt: NOW
      }
    };
    const { service, storage } = testService({
      conversation,
      debugEvents,
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
          source: "claude-code",
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
    assert.equal(storage.current.messages.at(-1)?.metadata?.compaction?.outcome, "failed");
    assert.equal(debugEvents.filter(({ event }) => event === "chat.compaction.finished").at(-1)?.payload.outcome, "failed");
    // Nothing was compacted: the member still has its list of memory notes.
    assert.equal((service as any).memoryIndexDue.size, 0);
    assert.equal(storage.current.metadata.running, false);
    assert.equal(storage.current.metadata.runId, undefined);
    assert.equal(storage.current.metadata.activeRunIds, undefined);
    assert.deepEqual(readParticipantCompactions(storage.current.metadata), {});
    assert.equal(storage.current.metadata.agentContextUsageByParticipant?.[participant.id]?.usedTokens, 120);
    assert.equal(storage.current.metadata.agentContextUsageByParticipant?.[participant.id]?.percentage, 12);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("compactParticipant clears running and compaction state when compact throws", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-compact-throw-"));
  try {
    const participant = chatParticipant();
    const conversation = chatConversation([participant], [chatSession(participant, "session-1")]);
    const debugEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const { service, storage } = testService({
      conversation,
      debugEvents,
      compactSession: async () => {
        throw new Error("compact transport failed");
      }
    });
    (service as any).ensureHistoryFiles = async () => tempRoot;

    await assert.rejects(
      service.compactParticipant({
        conversationId: conversation.id,
        participantId: participant.id,
        runId: "compact-throw"
      }),
      /compact transport failed/
    );

    assert.equal(storage.current.metadata.running, false);
    assert.equal(storage.current.metadata.runId, undefined);
    assert.equal(storage.current.metadata.activeRunIds, undefined);
    assert.deepEqual(readParticipantCompactions(storage.current.metadata), {});
    assert.equal(debugEvents.filter(({ event }) => event === "chat.compaction.finished").at(-1)?.payload.outcome, "failed");
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
        source: "claude-code",
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
        source: "claude-code",
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
  const debugEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];
  let compactCalls = 0;
  const { service, storage } = testService({
    conversation,
    debugEvents,
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
  assert.equal(storage.current.messages.at(-1)?.metadata?.compaction?.outcome, "no-active-session");
  assert.equal(debugEvents.filter(({ event }) => event === "chat.compaction.finished").at(-1)?.payload.outcome, "no-active-session");
  assert.deepEqual(readParticipantCompactions(storage.current.metadata), {});
});

test("requestSelfCompactionFromTool asks for approval by default", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation([participant], [chatSession(participant, "session-1")]);
  let compactCalls = 0;
  const { service, storage } = testService({
    conversation,
    compactSession: async (runParticipant) => {
      compactCalls += 1;
      return { participant: runParticipant, ok: true, sessionId: "session-1" };
    }
  });

  const result = await service.requestSelfCompactionFromTool(selfCompactionActor(participant), {});

  assert.equal(result.ok, true);
  assert.equal(result.status, "pending_user_approval");
  assert.equal(compactCalls, 0);
  const approvals = storage.current.metadata.pendingAppToolApprovals as Array<Record<string, unknown>>;
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].toolName, "app_chat_request_compaction");
  assert.equal(approvals[0].capability, "compaction.request");
  assert.deepEqual(approvals[0].request, { type: "self_compaction" });
});

// The card's meter is the member's context indicator when it asked (the
// User's compaction card, 2026-11-22), set by the app: a figure the member
// writes into its arguments is not taken.
test("requestSelfCompactionFromTool puts the member's context indicator on the card, never the member's own figure", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation([participant], [chatSession(participant, "session-1")]);
  conversation.metadata.agentContextUsageByParticipant = {
    [participant.id]: { usedTokens: 820_000, contextWindowTokens: 1_000_000, percentage: 82, source: "claude-code", updatedAt: NOW }
  };
  const neverCompacts = async (runParticipant: ParticipantConfig) => ({ participant: runParticipant, ok: true, sessionId: "session-1" });
  const { service, storage } = testService({ conversation, compactSession: neverCompacts });

  const result = await service.requestSelfCompactionFromTool(selfCompactionActor(participant), {
    instructions: "beta.3 status, your rules, open defects",
    contextPercentage: 5
  });

  assert.equal(result.status, "pending_user_approval");
  const approvals = storage.current.metadata.pendingAppToolApprovals as Array<Record<string, unknown>>;
  assert.deepEqual(approvals[0].request, { type: "self_compaction", instructions: "beta.3 status, your rules, open defects", contextPercentage: 82 });

  // No figure yet (a member that never finished a turn): no meter.
  const fresh = chatParticipant({ id: "participant-fresh", handle: "fresh" });
  const second = chatConversation([fresh], [chatSession(fresh, "session-2")]);
  const other = testService({ conversation: second, compactSession: neverCompacts });
  await other.service.requestSelfCompactionFromTool(selfCompactionActor(fresh), { contextPercentage: 50 });
  const freshApprovals = other.storage.current.metadata.pendingAppToolApprovals as Array<Record<string, unknown>>;
  assert.deepEqual(freshApprovals[0].request, { type: "self_compaction" });

  // It asks in the middle of its turn: the session log read now gives the
  // figure, and the indicator shows the same.
  const live = chatParticipant({ id: "participant-live", handle: "live" });
  const third = chatConversation([live], [chatSession(live, "session-3")]);
  third.metadata.agentContextUsageByParticipant = {
    [live.id]: { usedTokens: 500_000, contextWindowTokens: 1_000_000, percentage: 50, source: "claude-code", updatedAt: "2026-01-01T00:00:00.000Z" }
  };
  const liveService = testService({
    conversation: third,
    compactSession: neverCompacts,
    contextUsageForSession: async (_participant, sessionId) => {
      assert.equal(sessionId, "session-3");
      return { usedTokens: 910_000, contextWindowTokens: 1_000_000, percentage: 91, source: "claude-code", updatedAt: new Date().toISOString() };
    }
  });
  await liveService.service.requestSelfCompactionFromTool(selfCompactionActor(live), {});
  const liveApprovals = liveService.storage.current.metadata.pendingAppToolApprovals as Array<Record<string, unknown>>;
  assert.deepEqual(liveApprovals[0].request, { type: "self_compaction", contextPercentage: 91 });
  assert.equal(liveService.storage.current.metadata.agentContextUsageByParticipant?.[live.id]?.percentage, 91);
});

test("requestSelfCompactionFromTool queues behind the current participant turn and resumes the same session", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-self-compact-queue-"));
  try {
    const participant = chatParticipant({
      permissions: normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), requestCompaction: "allow" })
    });
    const conversation = chatConversation([participant], [chatSession(participant, "session-1")]);
    const debugEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];
    let compactCalls = 0;
    const { service, storage } = testService({
      conversation,
      debugEvents,
      compactSession: async (runParticipant, _repoPath, _diffMode, _kind, _signal, options) => {
        compactCalls += 1;
        assert.equal(options.sessionId, "session-1");
        assert.equal(options.persistSession, true);
        assert.equal(options.compactInstructions, "Preserve the implementation decisions.");
        return { participant: runParticipant, ok: true, sessionId: "session-1" };
      }
    });
    (service as any).ensureHistoryFiles = async () => tempRoot;
    const activeTurn = (service as any).reserveParticipantTurn(conversation.id, participant.id);

    const result = await service.requestSelfCompactionFromTool(selfCompactionActor(participant), {
      instructions: "Preserve the implementation decisions."
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, "queued");
    await delay(25);
    assert.equal(compactCalls, 0);

    activeTurn.release();
    await waitFor(() => compactCalls === 1);
    const line = (): any => storage.current.messages.find((message: any) => message.content === "Compacted @admin context with focus instructions.");
    await waitFor(() => Boolean(line()));
    assert.deepEqual(line().metadata?.compaction, {
      triggeredBy: "agent",
      participantId: participant.id,
      outcome: "completed",
      instructionsProvided: true
    });
    assert.deepEqual(debugEvents.filter(({ event }) => event.startsWith("chat.compaction.")).map(({ event, payload }) => ({ event, triggeredBy: payload.triggeredBy, outcome: payload.outcome })), [
      { event: "chat.compaction.requested", triggeredBy: "agent", outcome: undefined },
      { event: "chat.compaction.finished", triggeredBy: "agent", outcome: "completed" }
    ]);
    assert.equal((storage.current.metadata.participantSelfCompactionRequestedAtByParticipantId as Record<string, string>)[participant.id] !== undefined, true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("queued self-compaction can be cancelled through the chat run controller", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-self-compact-cancel-"));
  try {
    const participant = chatParticipant({
      permissions: normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), requestCompaction: "allow" })
    });
    const conversation = chatConversation([participant], [chatSession(participant, "session-1")]);
    const debugEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];
    let compactSignal: AbortSignal | undefined;
    const { service, storage } = testService({
      conversation,
      debugEvents,
      compactSession: async (runParticipant, _repoPath, _diffMode, _kind, signal) => {
        compactSignal = signal;
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(Object.assign(new Error("Cancelled"), { name: "AbortError" }));
            return;
          }
          signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("Cancelled"), { name: "AbortError" }));
          }, { once: true });
        });
        return { participant: runParticipant, ok: true, sessionId: "session-1" };
      }
    });
    (service as any).ensureHistoryFiles = async () => tempRoot;

    const result = await service.requestSelfCompactionFromTool(selfCompactionActor(participant), {});
    assert.equal(result.status, "queued");
    const runId = String(result.runId);
    await waitFor(() => compactSignal !== undefined);

    assert.equal(service.cancelRun(runId), true);
    await waitFor(() => compactSignal?.aborted === true);
    await waitFor(() => storage.current.metadata.running === false);
    assert.equal(storage.current.messages.some((message: any) => message.content.startsWith("Could not compact @admin context:")), false);
    assert.equal(debugEvents.filter(({ event }) => event === "chat.compaction.finished").at(-1)?.payload.outcome, "cancelled");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("approving self-compaction for chat updates the roster override and queues compaction", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-self-compact-approval-"));
  try {
    const participant = chatParticipant();
    const conversation = chatConversation([participant], [chatSession(participant, "session-1")]);
    let compactCalls = 0;
    const { service, storage } = testService({
      conversation,
      compactSession: async (runParticipant) => {
        compactCalls += 1;
        return { participant: runParticipant, ok: true, sessionId: "session-1" };
      }
    });
    (service as any).ensureHistoryFiles = async () => tempRoot;
    const request = await service.requestSelfCompactionFromTool(selfCompactionActor(participant), {});

    await service.respondToAppToolApproval({
      conversationId: conversation.id,
      approvalId: String(request.approvalId),
      approve: true,
      scope: "chat"
    });

    await waitFor(() => compactCalls === 1);
    const storedParticipant = (storage.current.metadata.participants as ChatParticipant[])[0];
    assert.equal(normalizeChatAgentPermissions(storedParticipant.permissions).requestCompaction, "allow");
    const approval = (storage.current.metadata.pendingAppToolApprovals as Array<Record<string, unknown>>)[0];
    assert.equal(approval.status, "approved");
    assert.equal(approval.approvalScope, "chat");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("requestSelfCompactionFromTool guards missing sessions, duplicate approvals, and cooldown", async () => {
  const participant = chatParticipant();
  const noSession = chatConversation([participant], []);
  const missing = testService({
    conversation: noSession,
    compactSession: async (runParticipant) => ({ participant: runParticipant, ok: true })
  });
  const missingResult = await missing.service.requestSelfCompactionFromTool(selfCompactionActor(participant), {});
  assert.equal(missingResult.status, "no_active_session");

  const conversation = chatConversation([participant], [chatSession(participant, "session-1")]);
  const pending = testService({
    conversation,
    compactSession: async (runParticipant) => ({ participant: runParticipant, ok: true, sessionId: "session-1" })
  });
  await pending.service.requestSelfCompactionFromTool(selfCompactionActor(participant), {});
  const duplicate = await pending.service.requestSelfCompactionFromTool(selfCompactionActor(participant), {});
  assert.equal(duplicate.status, "pending_user_approval");
  assert.equal(duplicate.ok, false);

  const cooldownParticipant = chatParticipant({
    permissions: normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), requestCompaction: "allow" })
  });
  const cooldownConversation = chatConversation([cooldownParticipant], [chatSession(cooldownParticipant, "session-1")]);
  cooldownConversation.metadata.participantSelfCompactionRequestedAtByParticipantId = {
    [cooldownParticipant.id]: new Date().toISOString()
  };
  const cooldown = testService({
    conversation: cooldownConversation,
    compactSession: async (runParticipant) => ({ participant: runParticipant, ok: true, sessionId: "session-1" })
  });
  const cooldownResult = await cooldown.service.requestSelfCompactionFromTool(selfCompactionActor(cooldownParticipant), {});
  assert.equal(cooldownResult.status, "cooldown");
  assert.equal(typeof cooldownResult.retryAfterMs, "number");
});

test("requestSelfCompactionFromTool enforces a deny override even with a stale capability", async () => {
  const participant = chatParticipant({
    permissions: normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), requestCompaction: "deny" })
  });
  const conversation = chatConversation([participant], [chatSession(participant, "session-1")]);
  let compactCalls = 0;
  const { service } = testService({
    conversation,
    compactSession: async (runParticipant) => {
      compactCalls += 1;
      return { participant: runParticipant, ok: true, sessionId: "session-1" };
    }
  });

  const result = await service.requestSelfCompactionFromTool(selfCompactionActor(participant), {});

  assert.equal(result.ok, false);
  assert.equal(result.status, "rejected");
  assert.match(String(result.error), /disabled/);
  assert.equal(compactCalls, 0);
});

/** A message the server holds (a machine member's compaction is a turn
 *  placed against one). */
function acceptedMessage(id = "anchor"): any {
  return { id, role: "user", content: "Earlier.", createdAt: NOW, status: "done", metadata: { threadId: id, serverSeq: 7, serverWriter: "desktop-device" } };
}

/** The User's server as a chat sees it, played by the test. */
function fakeServerLink(deviceId: string) {
  const ops: HubOp[] = [];
  let seq = 100;
  const turnOf = (op: HubOp, state: HubTurn["state"]): HubTurn | undefined => op.kind === "turn.request" || op.kind === "turn.claim"
    ? { runId: op.runId, conversationId: op.conversationId, messageId: op.messageId, participantId: op.participantId, state,
      ...(state === "requested" ? { requestedBy: deviceId } : { executorDeviceId: deviceId }),
      ...(op.kind === "turn.request" && op.request ? { request: op.request } : {}) }
    : undefined;
  const link: ChatServerLink & { ops: HubOp[] } = {
    ops,
    deviceId: () => deviceId,
    queueSql: (queued) => { ops.push(...queued); return ""; },
    enqueue: async (queued) => { ops.push(...queued); },
    nudge: () => undefined,
    messageAccepted: async () => ({ status: "accepted", seq: ++seq }),
    opAnswered: async (opId) => {
      const op = ops.find((item) => item.opId === opId);
      if (op?.kind === "turn.request") return { status: "accepted", seq: ++seq, turn: turnOf(op, "requested") };
      if (op?.kind === "turn.claim") return { status: "accepted", seq: ++seq, claim: "claimed", turn: turnOf(op, "claimed") };
      return { status: "accepted", seq: ++seq };
    },
    waitingTurns: async () => ({ requested: [], claimed: [] }),
    machineName: () => "Box"
  };
  return link;
}

let feedSeq = 0;
function fromServer(deviceId: string, effect: HubOpEffect): HubFeedEntry {
  feedSeq += 1;
  return { seq: 500 + feedSeq, opId: `feed-${feedSeq}`, deviceId, conversationId: "chat-compact", acceptedAt: new Date().toISOString(), effect };
}

function compactionLine(runId: string, participantId: string, outcome: "completed" | "failed", content: string, threadId?: string): any {
  return { id: `line-${runId}`, role: "system", content, createdAt: NOW, status: "done",
    metadata: { runId, ...(threadId ? { threadId } : {}), compaction: { triggeredBy: "user", participantId, outcome, instructionsProvided: false }, serverSeq: 900, serverWriter: "machine-device" } };
}

test("/compact on a member hosted on a machine is asked of its machine on the server, and shows the line and context use the machine wrote", async () => {
  const participant = chatParticipant({ homeMachineId: "box" });
  const conversation = chatConversation([participant], []);
  conversation.messages.push(acceptedMessage());
  const debugEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const { service, storage } = testService({
    conversation,
    debugEvents,
    compactSession: async () => { throw new Error("a member on a machine is never compacted on the desktop"); }
  });
  const link = fakeServerLink("desktop-device");
  service.setServerLink(link);
  const lines: string[] = [];
  const running = service.sendMessage({ conversationId: conversation.id, runId: "machine-compact", content: "@admin /compact keep the plan", threadId: "thread-1" },
    undefined, (progress) => lines.push(progress.message));
  await waitFor(() => link.ops.some((op) => op.kind === "turn.request"));
  const request = link.ops.find((op) => op.kind === "turn.request") as Extract<HubOp, { kind: "turn.request" }>;
  assert.equal(request.runId, "turn-machine-compact");
  assert.equal(request.participantId, participant.id);
  assert.equal(request.messageId, "anchor", "placed against a message the server holds");
  assert.deepEqual(request.request, { kind: "compaction", triggeredBy: "user", instructions: "keep the plan", threadId: "thread-1" });
  assert.equal(readParticipantCompactions(storage.current.metadata)[participant.id]?.runId, "machine-compact", "the member shows as compacting while its machine works");
  const turn: HubTurn = { runId: request.runId, conversationId: conversation.id, messageId: "anchor", participantId: participant.id, state: "claimed", executorDeviceId: "machine-device" };
  const usage = { usedTokens: 300, contextWindowTokens: 1000, percentage: 30, source: "codex-cli", updatedAt: "2026-02-01T00:00:00.000Z" };
  await service.applyServerEntries([fromServer("machine-device", { kind: "turn.claim", turn })]);
  await service.applyServerEntries([fromServer("machine-device", { kind: "message.create",
    message: compactionLine(request.runId, participant.id, "completed", "Compacted @admin context with focus instructions.", "thread-1") })]);
  await service.applyServerEntries([fromServer("machine-device", { kind: "turn.finish", turn: { ...turn, state: "finished", outcome: "done", contextUsage: usage } })]);
  const result = await running;
  assert.equal(result.warnings.length, 0);
  assert.equal(storage.current.messages.at(-1)?.id, `line-${request.runId}`);
  assert.equal(storage.current.messages.at(-1)?.content, "Compacted @admin context with focus instructions.");
  assert.equal(storage.current.messages.filter((message: any) => message.role === "system").length, 1, "the machine's line only, not a second one from here");
  assert.equal(storage.current.metadata.agentContextUsageByParticipant?.[participant.id]?.usedTokens, 300);
  assert.deepEqual(readParticipantCompactions(storage.current.metadata), {});
  assert.equal(storage.current.metadata.activeRunIds, undefined);
  assert.deepEqual(lines, ["Compacting @admin.", "Compacting @admin. Waiting for machine Box", "Compacting @admin.", "Compacted @admin."]);
  assert.deepEqual(debugEvents.filter(({ event }) => event.startsWith("chat.compaction.")).map(({ event, payload }) => [event, payload.outcome]), [
    ["chat.compaction.requested", undefined],
    ["chat.compaction.finished", "completed"]
  ]);
});

test("Stop on a machine member's compaction is asked on the server and shown as waiting until the machine confirms", async () => {
  const participant = chatParticipant({ homeMachineId: "box" });
  const conversation = chatConversation([participant], []);
  conversation.messages.push(acceptedMessage());
  const { service, storage } = testService({ conversation, compactSession: async () => { throw new Error("not here"); } });
  const link = fakeServerLink("desktop-device");
  service.setServerLink(link);
  const lines: string[] = [];
  const stop = new AbortController();
  const running = service.compactParticipant({ conversationId: conversation.id, participantId: participant.id, runId: "waiting-run" }, stop.signal, (progress) => lines.push(progress.message));
  await waitFor(() => link.ops.some((op) => op.kind === "turn.request"));
  const turn: HubTurn = { runId: "turn-waiting-run", conversationId: conversation.id, messageId: "anchor", participantId: participant.id, state: "claimed", executorDeviceId: "machine-device" };
  await service.applyServerEntries([fromServer("machine-device", { kind: "turn.claim", turn })]);
  stop.abort();
  await waitFor(() => link.ops.some((op) => op.kind === "turn.stop"));
  await waitFor(() => lines.at(-1) === "Compacting @admin. Stop requested — waiting for machine Box");
  // The machine stops it and says how its compaction ended.
  await service.applyServerEntries([fromServer("machine-device", { kind: "message.create",
    message: compactionLine("turn-waiting-run", participant.id, "failed", "Could not compact @admin context: Compaction was cancelled.") })]);
  await service.applyServerEntries([fromServer("machine-device", { kind: "turn.finish", turn: { ...turn, state: "finished", outcome: "stopped" } })]);
  await running;
  assert.deepEqual(lines, [
    "Compacting @admin.",
    "Compacting @admin. Waiting for machine Box",
    "Compacting @admin.",
    "Compacting @admin. Stop requested — waiting for machine Box",
    "Could not compact @admin."
  ]);
  assert.equal(storage.current.messages.at(-1)?.content, "Could not compact @admin context: Compaction was cancelled.");
  assert.equal(storage.current.metadata.activeRunIds, undefined);
});

test("a machine compaction that could not start ends as a local one that could not", async () => {
  const participant = chatParticipant({ homeMachineId: "box" });
  const conversation = chatConversation([participant], []);
  conversation.messages.push(acceptedMessage());
  const { service, storage } = testService({ conversation, compactSession: async () => { throw new Error("not here"); } });
  // No link to the User's server: nothing can reach the machine.
  const offline = await service.compactParticipant({ conversationId: conversation.id, participantId: participant.id, runId: "machine-offline" });
  assert.equal(storage.current.messages.at(-1)?.content, "Could not compact @admin context: @admin runs on a cloud machine, which this device reaches only through your server; it is not linked to it yet.");
  assert.equal(storage.current.messages.at(-1)?.metadata?.compaction?.outcome, "failed");
  assert.equal(offline.warnings.length, 1);

  const link = fakeServerLink("desktop-device");
  service.setServerLink(link);
  // Stopped before it was asked: the words a local compaction stopped before it started writes.
  const stop = new AbortController();
  stop.abort();
  await service.compactParticipant({ conversationId: conversation.id, participantId: participant.id, runId: "machine-stopped" }, stop.signal);
  assert.equal(link.ops.some((op) => op.kind === "turn.request"), false, "a stopped compaction is never asked");
  assert.equal(storage.current.messages.at(-1)?.content, "Could not compact @admin context: Compaction was cancelled before native execution started.");
  assert.equal(storage.current.metadata.activeRunIds, undefined);

  // Stopped on the server before the machine took it: the same words.
  const asked = service.compactParticipant({ conversationId: conversation.id, participantId: participant.id, runId: "stopped-there" });
  await waitFor(() => link.ops.some((op) => op.kind === "turn.request"));
  await service.applyServerEntries([fromServer("phone-device", { kind: "turn.stop",
    turn: { runId: "turn-stopped-there", conversationId: conversation.id, messageId: "anchor", participantId: participant.id, state: "stopped", outcome: "stopped" } })]);
  await asked;
  assert.equal(storage.current.messages.at(-1)?.content, "Could not compact @admin context: Compaction was cancelled before native execution started.");

  // A member whose cloud machine was never prepared has never run.
  const pending = chatParticipant({ id: "cloud-pending", handle: "cloudy", cloudRun: { kind: "aws" } as any });
  storage.current.metadata.participants = [participant, pending];
  await service.compactParticipant({ conversationId: conversation.id, participantId: pending.id, runId: "machine-pending" });
  assert.equal(storage.current.messages.at(-1)?.content, "@cloudy does not have an active session to compact yet.");
  assert.equal(link.ops.filter((op) => op.kind === "turn.request").length, 1);
});

test("the machine takes a compaction turn asked of its member, runs it under the turn's id, and ends it on the server with the member's context use", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-compact-machine-"));
  try {
    const participant = chatParticipant({ homeMachineId: "box" });
    const conversation = chatConversation([participant], [chatSession(participant, "session-on-box")]);
    conversation.messages.push(acceptedMessage());
    let compactedSession: unknown;
    const { service, storage } = testService({
      conversation,
      compactSession: async (runParticipant, _repoPath, _diffMode, _kind, _signal, options) => {
        compactedSession = options.sessionId;
        return { participant: runParticipant, ok: true, sessionId: "session-on-box",
          contextUsage: { usedTokens: 50, contextWindowTokens: 1000, percentage: 5, source: "codex-cli", updatedAt: "2026-03-01T00:00:00.000Z" } };
      }
    });
    (service as any).ensureHistoryFiles = async () => tempRoot;
    service.setHostMachineId("box");
    const link = fakeServerLink("machine-device");
    service.setServerLink(link);
    await service.startServerTurn({ runId: "turn-desktop-run", conversationId: conversation.id, messageId: "anchor", participantId: participant.id, state: "requested",
      request: { kind: "compaction", triggeredBy: "agent", threadId: "t-9" } });
    await waitFor(() => link.ops.some((op) => op.kind === "turn.finish"));
    assert.equal(compactedSession, "session-on-box");
    assert.deepEqual(link.ops.filter((op) => op.kind.startsWith("turn.")).map((op) => op.kind), ["turn.claim", "turn.finish"], "taken before it ran, ended after");
    const finish = link.ops.find((op) => op.kind === "turn.finish") as Extract<HubOp, { kind: "turn.finish" }>;
    assert.equal(finish.outcome, "done");
    assert.equal((finish.contextUsage as { usedTokens?: number } | undefined)?.usedTokens, 50);
    const line = storage.current.messages.at(-1);
    assert.equal(line.content, "Compacted @admin context.");
    assert.equal(line.metadata?.runId, "turn-desktop-run");
    assert.equal(line.metadata?.threadId, "t-9");
    assert.equal(line.metadata?.compaction?.triggeredBy, "agent");
    // The line goes to the server before the turn's end.
    const lineOp = link.ops.findIndex((op) => op.kind === "message.create" && op.message.id === line.id);
    assert.ok(lineOp >= 0 && lineOp < link.ops.findIndex((op) => op.kind === "turn.finish"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("a /compact with no handle written to a member, asked of it on the server (the phone), compacts it as the desktop does; with a picture it is a message", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-compact-bare-"));
  try {
    const participant = chatParticipant({ homeMachineId: "box" });
    const conversation = chatConversation([participant], [chatSession(participant, "session-on-box")]);
    conversation.messages.push({ ...acceptedMessage("bare"), content: "/compact keep the API notes", metadata: { ...acceptedMessage("bare").metadata, deliveryTargets: [participant.id] } });
    conversation.messages.push({ ...acceptedMessage("pictured"), content: "/compact", metadata: { ...acceptedMessage("pictured").metadata, deliveryTargets: [participant.id],
      imageAttachments: [{ id: "img", filename: "a.png", mimeType: "image/png", sizeBytes: 10, width: 1, height: 1, storageKey: "attachments/img.png", createdAt: NOW }] } });
    const compacted: unknown[] = [];
    const ran: string[] = [];
    const { service } = testService({
      conversation,
      compactSession: async (runParticipant, _repoPath, _diffMode, _kind, _signal, options) => {
        compacted.push(options.compactInstructions);
        return { participant: runParticipant, ok: true, sessionId: "session-on-box" };
      },
      run: async (runParticipant, prompt) => {
        ran.push(prompt);
        return { participant: runParticipant, ok: true, content: "Seen.", durationMs: 1 };
      }
    });
    (service as any).ensureHistoryFiles = async () => tempRoot;
    service.setHostMachineId("box");
    const link = fakeServerLink("machine-device");
    service.setServerLink(link);
    await service.startServerTurn({ runId: "turn-bare", conversationId: conversation.id, messageId: "bare", participantId: participant.id, state: "requested" });
    await waitFor(() => link.ops.filter((op) => op.kind === "turn.finish").length === 1);
    assert.deepEqual(compacted, ["keep the API notes"]);
    assert.deepEqual(ran, [], "her text did not go to the CLI");
    await service.startServerTurn({ runId: "turn-pictured", conversationId: conversation.id, messageId: "pictured", participantId: participant.id, state: "requested" });
    await waitFor(() => link.ops.filter((op) => op.kind === "turn.finish").length === 2);
    assert.equal(compacted.length, 1);
    assert.equal(ran.length, 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("a member on a machine asking to compact itself asks it on the server, and its machine then takes it like any compaction", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-compact-self-"));
  try {
    const participant = chatParticipant({
      homeMachineId: "box",
      permissions: normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), requestCompaction: "allow" })
    });
    const conversation = chatConversation([participant], [chatSession(participant, "session-on-box")]);
    conversation.messages.push(acceptedMessage());
    let compactCalls = 0;
    const { service } = testService({
      conversation,
      compactSession: async (runParticipant) => { compactCalls += 1; return { participant: runParticipant, ok: true, sessionId: "session-on-box" }; }
    });
    (service as any).ensureHistoryFiles = async () => tempRoot;
    service.setHostMachineId("box");
    const link = fakeServerLink("machine-device");
    service.setServerLink(link);

    const asked = await service.requestSelfCompactionFromTool(selfCompactionActor(participant), { instructions: "Keep the API notes." });
    assert.equal(asked.status, "queued");
    await waitFor(() => link.ops.some((op) => op.kind === "turn.request"));
    const request = link.ops.find((op) => op.kind === "turn.request") as Extract<HubOp, { kind: "turn.request" }>;
    assert.equal(request.participantId, participant.id);
    const { resume, ...asked2 } = request.request as Record<string, any>;
    assert.deepEqual(asked2, { kind: "compaction", triggeredBy: "agent", instructions: "Keep the API notes." });
    assert.equal(resume.runId, "active-turn", "what to go on from travels with it");
    await delay(25);
    assert.equal(compactCalls, 0, "it runs when the server says so, so every device sees it and can stop it");
    // The server's word comes back: this machine takes it.
    await service.applyServerEntries([fromServer("machine-device", { kind: "turn.request",
      turn: { runId: request.runId, conversationId: conversation.id, messageId: request.messageId, participantId: participant.id, state: "requested",
        requestedBy: "machine-device", request: request.request } })]);
    await waitFor(() => compactCalls === 1);
    await waitFor(() => link.ops.some((op) => op.kind === "turn.finish"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("the desktop shows a compaction a machine member asked for itself as a run, and its Stop is asked on the server", async () => {
  const participant = chatParticipant({ homeMachineId: "box" });
  const conversation = chatConversation([participant], []);
  conversation.messages.push(acceptedMessage());
  const { service, storage } = testService({ conversation, compactSession: async () => { throw new Error("not here"); } });
  const link = fakeServerLink("desktop-device");
  service.setServerLink(link);
  const turn: HubTurn = { runId: "turn-self", conversationId: conversation.id, messageId: "anchor", participantId: participant.id, state: "requested",
    requestedBy: "machine-device", request: { kind: "compaction", triggeredBy: "agent" } };
  await service.applyServerEntries([fromServer("machine-device", { kind: "turn.request", turn })]);
  await waitFor(() => readParticipantCompactions(storage.current.metadata)[participant.id]?.runId === "turn-self");
  assert.equal(link.ops.some((op) => op.kind === "turn.request"), false, "not asked again: the machine asked it");
  // Shown once, whatever the feed says again.
  await service.applyServerEntries([fromServer("machine-device", { kind: "turn.claim", turn: { ...turn, state: "claimed", executorDeviceId: "machine-device" } })]);
  assert.equal(service.cancelRun("turn-self"), true);
  await waitFor(() => link.ops.some((op) => op.kind === "turn.stop"));
  await service.applyServerEntries([fromServer("machine-device", { kind: "message.create",
    message: compactionLine("turn-self", participant.id, "failed", "Could not compact @admin context: Compaction was cancelled.") })]);
  await service.applyServerEntries([fromServer("machine-device", { kind: "turn.finish", turn: { ...turn, state: "finished", outcome: "stopped", executorDeviceId: "machine-device" } })]);
  await waitFor(() => storage.current.metadata.activeRunIds === undefined && !readParticipantCompactions(storage.current.metadata)[participant.id]);
  assert.equal(storage.current.messages.filter((message: any) => message.role === "system").length, 1);
});

test("Stop by run id reaches a compaction the machine runs for another device, which ends it on the server as stopped", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-compact-machine-stop-"));
  try {
    const participant = chatParticipant({ homeMachineId: "box" });
    const conversation = chatConversation([participant], [chatSession(participant, "session-on-box")]);
    conversation.messages.push(acceptedMessage());
    let compactSignal: AbortSignal | undefined;
    const { service } = testService({
      conversation,
      compactSession: async (runParticipant, _repoPath, _diffMode, _kind, signal) => {
        compactSignal = signal;
        await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
        return { participant: runParticipant, ok: false, error: "Compaction was cancelled." };
      }
    });
    (service as any).ensureHistoryFiles = async () => tempRoot;
    service.setHostMachineId("box");
    const link = fakeServerLink("machine-device");
    service.setServerLink(link);
    const turn: HubTurn = { runId: "turn-stop-me", conversationId: conversation.id, messageId: "anchor", participantId: participant.id, state: "requested",
      request: { kind: "compaction", triggeredBy: "user" } };
    void service.startServerTurn(turn);
    await waitFor(() => compactSignal !== undefined);
    // The Stop arrives from the server: asked while this machine has it.
    await service.applyServerEntries([fromServer("desktop-device", { kind: "turn.stop",
      turn: { ...turn, state: "claimed", executorDeviceId: "machine-device", stopRequestedAt: NOW } })]);
    await waitFor(() => compactSignal?.aborted === true);
    await waitFor(() => link.ops.some((op) => op.kind === "turn.finish"));
    assert.equal((link.ops.find((op) => op.kind === "turn.finish") as Extract<HubOp, { kind: "turn.finish" }>).outcome, "stopped");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

// --- going on after a member's own compaction (the User, 2026-11-25) ---------

/** A chat whose one member's turns the test plays: what each prompt was, and
 *  the app tools each turn acts with (the grant its CLI got). */
function selfCompactingChat(options: {
  participant?: Partial<ChatParticipant>;
  others?: ChatParticipant[];
  turn: (context: { prompt: string; participantId: string; actor: any; service: ChatService; call: number }) => Promise<string>;
  compactSession?: (signal: AbortSignal | undefined) => Promise<Record<string, unknown>>;
}) {
  const participant = chatParticipant(options.participant);
  const members = [participant, ...(options.others ?? [])];
  const conversation = chatConversation(members, members.map((member) => chatSession(member, `session-${member.id}`)));
  const grants = new Map<string, any>();
  const note = (grant: any): { url: string; token: string } => {
    grants.set(grant.participantId, grant);
    return { url: "http://127.0.0.1:1/mcp", token: `token-${grant.participantId}` };
  };
  const prompts: Array<{ participantId: string; prompt: string }> = [];
  const order: string[] = [];
  const debugEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const made = testService({
    conversation,
    debugEvents,
    appMcp: { issueToken: note, updateToken: (_token: string, grant: any) => note(grant), clientStatus: () => undefined },
    compactSession: async (runParticipant, _repoPath, _diffMode, _kind, signal) => {
      order.push(`compact ${runParticipant.id}`);
      return options.compactSession ? await options.compactSession(signal) : { participant: runParticipant, ok: true, sessionId: `session-${runParticipant.id}` };
    },
    run: async (runParticipant, prompt) => {
      prompts.push({ participantId: runParticipant.id, prompt });
      order.push(`turn ${runParticipant.id}`);
      const content = await options.turn({
        prompt, participantId: runParticipant.id, actor: { ...grants.get(runParticipant.id), capabilities: ["compaction.request", "participants.request"] },
        service: made.service, call: prompts.filter((item) => item.participantId === runParticipant.id).length
      });
      return { participant: runParticipant, ok: true, content, durationMs: 1, sessionId: `session-${runParticipant.id}` };
    }
  });
  (made.service as any).ensureHistoryFiles = async () => tmpdir();
  const replies = (): any[] => made.storage.current.messages.filter((message: any) => message.role === "participant" && message.status === "done");
  const approvals = (): any[] => made.storage.current.metadata.pendingAppToolApprovals ?? [];
  return { ...made, participant, conversation, prompts, order, debugEvents, replies, approvals };
}

const ALLOWED = { permissions: normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), requestCompaction: "allow" }) };

test("a member that compacts its own context goes on by itself: compacted, then called once with what comes next, on the same session", async () => {
  const chat = selfCompactingChat({
    participant: ALLOWED,
    turn: async ({ actor, service, call }) => {
      if (call > 1) return "Stage two is done.";
      const asked = await service.requestSelfCompactionFromTool(actor, { instructions: "Stage two: the settings screen." });
      assert.equal(asked.status, "queued");
      assert.match(String(asked.next), /the app calls you again to go on/);
      return "Stage one is done, stage two next.";
    }
  });
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "user-run", content: "@admin do both stages" });
  await waitFor(() => chat.replies().length === 2, 5_000);
  assert.deepEqual(chat.order, ["turn codex-admin", "compact codex-admin", "turn codex-admin"]);
  const [, second] = chat.prompts;
  assert.match(second.prompt, /<<<EVENT [0-9a-f]{8}>>>\n@admin goes on after the compaction it asked for\.\nYour context was compacted\. Go on with the next step of your work now\./);
  assert.match(second.prompt, /What you asked the summary to keep: Stage two: the settings screen\./);
  assert.deepEqual(chat.replies().map((message) => message.content), ["Stage one is done, stage two next.", "Stage two is done."]);
  await waitFor(() => chat.storage.current.metadata.running === false, 5_000);
  await delay(50);
  assert.equal(chat.prompts.length, 2, "called once");
  // In the thread of the message it works on.
  const [first, last] = chat.replies();
  assert.equal(last.metadata.threadId, first.metadata.threadId);
});

test("a compaction that fails is said, and the member goes on without it; a Stop of the compaction leaves it to the User", async () => {
  const failing = selfCompactingChat({
    participant: ALLOWED,
    compactSession: async () => ({ ok: false, error: "No messages to compact." }),
    turn: async ({ actor, service, call }) => {
      if (call === 1) await service.requestSelfCompactionFromTool(actor, {});
      return `Reply ${call}.`;
    }
  });
  await failing.service.sendMessage({ conversationId: failing.conversation.id, runId: "user-run", content: "@admin go" });
  await waitFor(() => failing.replies().length === 2, 5_000);
  assert.match(failing.prompts[1].prompt, /Your context could not be compacted \(No messages to compact\.\): it is as it was\./);

  const stopped = selfCompactingChat({
    participant: ALLOWED,
    compactSession: async (signal) => {
      await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
      return { ok: false, error: "Compaction was cancelled." };
    },
    turn: async ({ actor, service }) => {
      await service.requestSelfCompactionFromTool(actor, {});
      return "Stage one is done.";
    }
  });
  await stopped.service.sendMessage({ conversationId: stopped.conversation.id, runId: "user-run", content: "@admin go" });
  await waitFor(() => stopped.order.includes("compact codex-admin"), 5_000);
  const compaction = readParticipantCompactions(stopped.storage.current.metadata)["codex-admin"];
  assert.equal(stopped.service.cancelRun(compaction!.runId), true);
  await waitFor(() => stopped.storage.current.metadata.running === false, 5_000);
  await delay(50);
  assert.equal(stopped.prompts.length, 1, "not called again after a Stop");
});

test("the User's answer to a compaction card calls the member again: compacted, or as it is after Not now; a Stop of its turn withdraws the card", async () => {
  for (const approve of [true, false]) {
    const chat = selfCompactingChat({
      turn: async ({ actor, service, call }) => {
        if (call === 1) {
          const asked = await service.requestSelfCompactionFromTool(actor, { instructions: "The open findings." });
          assert.equal(asked.status, "pending_user_approval");
          assert.match(String(asked.next), /Once User answers the card the app calls you again/);
        }
        return `Reply ${call}.`;
      }
    });
    await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "user-run", content: "@admin go" });
    await waitFor(() => chat.replies().length === 1 && chat.storage.current.metadata.running === false, 5_000);
    assert.equal(chat.prompts.length, 1, "it waits for her answer");
    await chat.service.respondToAppToolApproval({ conversationId: chat.conversation.id, approvalId: chat.approvals()[0].id, approve });
    await waitFor(() => chat.replies().length === 2, 5_000);
    assert.deepEqual(chat.order, approve ? ["turn codex-admin", "compact codex-admin", "turn codex-admin"] : ["turn codex-admin", "turn codex-admin"]);
    assert.match(chat.prompts[1].prompt, approve ? /Your context was compacted\./ : /User chose not to compact your context now: it is as it was\./);
  }

  // It went on at her word already: Not now only closes the card.
  const wentOn = selfCompactingChat({
    turn: async ({ actor, service, call }) => {
      if (call === 1) await service.requestSelfCompactionFromTool(actor, {});
      return `Reply ${call}.`;
    }
  });
  await wentOn.service.sendMessage({ conversationId: wentOn.conversation.id, runId: "user-run", content: "@admin go" });
  await waitFor(() => wentOn.replies().length === 1 && wentOn.storage.current.metadata.running === false, 5_000);
  await wentOn.service.sendMessage({ conversationId: wentOn.conversation.id, runId: "second-run", content: "@admin go on without it" });
  await waitFor(() => wentOn.replies().length === 2 && wentOn.storage.current.metadata.running === false, 5_000);
  await wentOn.service.respondToAppToolApproval({ conversationId: wentOn.conversation.id, approvalId: wentOn.approvals()[0].id, approve: false });
  await waitFor(() => wentOn.debugEvents.some(({ event, payload }) => event === "chat.self-compaction.not-resumed" && payload.reason === "not-continued"), 5_000);
  assert.equal(wentOn.prompts.length, 2);

  // Stopped: the card goes with the work it was for.
  let release!: () => void;
  const stopped = selfCompactingChat({
    turn: async ({ actor, service }) => {
      await service.requestSelfCompactionFromTool(actor, {});
      await new Promise<void>((resolve) => { release = resolve; });
      return "Late.";
    }
  });
  await stopped.service.sendMessage({ conversationId: stopped.conversation.id, runId: "user-run", content: "@admin go" });
  await waitFor(() => stopped.approvals().length === 1 && typeof release === "function", 5_000);
  const runId = stopped.storage.current.messages.find((message: any) => message.role === "participant").metadata.runId;
  assert.equal(stopped.service.cancelRun(runId), true);
  release();
  await waitFor(() => stopped.approvals()[0].status === "cancelled", 5_000);
  assert.equal(stopped.prompts.length, 1);
});

test("a turn stopped after it queued its own compaction is not gone on with", async () => {
  let release!: () => void;
  const chat = selfCompactingChat({
    participant: ALLOWED,
    turn: async ({ actor, service }) => {
      await service.requestSelfCompactionFromTool(actor, {});
      await new Promise<void>((resolve) => { release = resolve; });
      return "Late.";
    }
  });
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "user-run", content: "@admin go" });
  await waitFor(() => typeof release === "function", 5_000);
  const runId = chat.storage.current.messages.find((message: any) => message.role === "participant").metadata.runId;
  assert.equal(chat.service.cancelRun(runId), true);
  release();
  await waitFor(() => chat.debugEvents.some(({ event, payload }) => event === "chat.self-compaction.not-resumed" && payload.reason === "stopped"), 5_000);
  assert.equal(chat.prompts.length, 1);
});

test("a member that compacts in the middle of another member's request answers with the reply it goes on to", async () => {
  const asker = chatParticipant({ id: "asker", handle: "asker", permissions: normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), requestParticipants: "allow" }) });
  const chat = selfCompactingChat({
    participant: ALLOWED,
    others: [asker],
    turn: async ({ actor, service, participantId, call }) => {
      if (participantId === "asker") {
        if (call > 1) return "Thanks.";
        const asked = await service.requestParticipantsFromTool(actor, { requests: [{ target: "admin", prompt: "Do both stages" }] });
        assert.equal(asked.status, "running");
        return "Asked admin.";
      }
      if (call === 1) {
        await service.requestSelfCompactionFromTool(actor, {});
        return "Stage one is done, stage two next.";
      }
      // Its requester still waits for it.
      const batch = chat.storage.current.messages.find((message: any) => message.metadata?.participantRequest)!.metadata.participantRequest;
      assert.equal(batch.items[0].status, "running");
      assert.equal(chat.prompts.filter((item) => item.participantId === "asker").length, 1);
      return "Both stages are done.";
    }
  });
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "user-run", content: "@asker get both stages done" });
  await waitFor(() => chat.prompts.filter((item) => item.participantId === "asker").length === 2, 8_000);
  const item = chat.storage.current.messages.find((message: any) => message.metadata?.participantRequest)!.metadata.participantRequest.items[0];
  const replyOf = (content: string): any => chat.replies().find((message) => message.content === content);
  assert.equal(item.status, "answered");
  assert.equal(item.replyMessageId, replyOf("Both stages are done.").id);
  assert.deepEqual(item.earlierReplyMessageIds, [replyOf("Stage one is done, stage two next.").id]);
  const back = chat.prompts.filter((entry) => entry.participantId === "asker")[1].prompt;
  assert.match(back, /Stage one is done, stage two next\./);
  assert.match(back, /Both stages are done\./);
  await waitFor(() => chat.storage.current.metadata.running === false, 5_000);
});

test("a request whose member's own compaction the User stopped ends as stopped, never as answered with the half it wrote", async () => {
  const asker = chatParticipant({ id: "asker", handle: "asker", permissions: normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), requestParticipants: "allow" }) });
  const chat = selfCompactingChat({
    participant: ALLOWED,
    others: [asker],
    compactSession: async (signal) => {
      await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
      return { ok: false, error: "Compaction was cancelled." };
    },
    turn: async ({ actor, service, participantId, call }) => {
      if (participantId === "asker") {
        if (call === 1) await service.requestParticipantsFromTool(actor, { requests: [{ target: "admin", prompt: "Do both stages" }] });
        return call === 1 ? "Asked admin." : "Noted.";
      }
      await service.requestSelfCompactionFromTool(actor, {});
      return "Stage one is done, stage two next.";
    }
  });
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "user-run", content: "@asker get both stages done" });
  await waitFor(() => chat.order.includes("compact codex-admin"), 5_000);
  assert.equal(chat.service.cancelRun(readParticipantCompactions(chat.storage.current.metadata)["codex-admin"]!.runId), true);
  const item = (): any => chat.storage.current.messages.find((message: any) => message.metadata?.participantRequest)!.metadata.participantRequest.items[0];
  await waitFor(() => item().status === "interrupted", 5_000);
  assert.equal(item().error, "Stopped by User.");
  await waitFor(() => chat.storage.current.metadata.running === false, 5_000);
  assert.equal(chat.prompts.filter((entry) => entry.participantId === "codex-admin").length, 1);
});

test("on a machine a member's own compaction carries what to go on from, and the machine goes on there once it compacted", async () => {
  const participant = chatParticipant({ homeMachineId: "box", ...ALLOWED });
  const conversation = chatConversation([participant], [chatSession(participant, "session-on-box")]);
  conversation.messages.push(acceptedMessage());
  const prompts: string[] = [];
  const { service, storage } = testService({
    conversation,
    compactSession: async (runParticipant) => ({ participant: runParticipant, ok: true, sessionId: "session-on-box" }),
    run: async (runParticipant, prompt) => {
      prompts.push(prompt);
      return { participant: runParticipant, ok: true, content: "Went on.", durationMs: 1, sessionId: "session-on-box" };
    }
  });
  (service as any).ensureHistoryFiles = async () => tmpdir();
  service.setHostMachineId("box");
  const link = fakeServerLink("machine-device");
  service.setServerLink(link);
  // Taken after a restart of the machine: nothing in memory, all in the turn.
  void service.startServerTurn({ runId: "turn-self", conversationId: conversation.id, messageId: "anchor", participantId: participant.id, state: "requested",
    requestedBy: "machine-device", request: { kind: "compaction", triggeredBy: "agent", instructions: "Stage two.", resume: { runId: "turn-asked", triggerMessageId: "anchor" } } });
  await waitFor(() => prompts.length === 1, 5_000);
  assert.match(prompts[0], /Your context was compacted\./);
  assert.match(prompts[0], /Stage two\./);
  await waitFor(() => storage.current.messages.some((message: any) => message.content === "Went on."), 5_000);
  const claims = link.ops.filter((op) => op.kind === "turn.claim").map((op) => (op as Extract<HubOp, { kind: "turn.claim" }>).runId);
  assert.deepEqual(claims, ["turn-self", "turn-compaction-resume-asked"], "a turn of its own on the server, named by the run that asked");
  // The same turn offered again (the feed repeats it) goes on once.
  await delay(30);
  assert.equal(prompts.length, 1);
});

/** A reply as another device's member wrote it, ended for its own compaction. */
function askingReply(participantId: string, mark: Record<string, unknown>): any {
  return { id: "asked-reply", role: "participant", participantId, content: "Stage one is done, stage two next.", createdAt: NOW, status: "done",
    metadata: { runId: "turn-asked", selfCompaction: mark, serverSeq: 940, serverWriter: "other-device" } };
}

test("a member's answer is waited for through its own compaction on another device, by what that device wrote on its reply", async () => {
  // Wherever the requester runs: the computer for a cloud member, a machine
  // for a member of the computer's (its compaction is no turn on the server).
  for (const here of ["desktop", "machine"]) {
    const participant = chatParticipant(here === "desktop" ? { homeMachineId: "box" } : {});
    const conversation = chatConversation([participant], []);
    conversation.messages.push(acceptedMessage(), askingReply(participant.id, { state: "waiting" }));
    const { service, storage } = testService({ conversation, compactSession: async () => { throw new Error("not here"); } });
    if (here === "machine") service.setHostMachineId("box");
    service.setServerLink(fakeServerLink(`${here}-device`));
    const asked = storage.current.messages.find((message: any) => message.id === "asked-reply");
    const waiting = (service as any).selfCompactedAnswer(conversation.id, participant.id, asked, undefined) as Promise<any>;
    await delay(20);
    const went = (content: string, status: string): any => ({ id: "went-on", role: "participant", participantId: participant.id, content, createdAt: NOW, status,
      metadata: { runId: "turn-compaction-resume-asked", serverSeq: 950, serverWriter: "other-device" } });
    const post: any = { ...went("On it.", "done"), id: "post", metadata: { ...went("", "done").metadata, appMessageSource: "app_chat_send_message", serverSeq: 951 } };
    await service.applyServerEntries([fromServer("other-device", { kind: "message.update", message: askingReply(participant.id, { state: "resumed" }) })]);
    await service.applyServerEntries([fromServer("other-device", { kind: "message.create", message: went("", "pending") })]);
    await service.applyServerEntries([fromServer("other-device", { kind: "message.create", message: post })]);
    await delay(20);
    await service.applyServerEntries([fromServer("other-device", { kind: "message.update", message: went("Both stages are done.", "done") })]);
    const answer = await waiting;
    assert.deepEqual([answer.kind, answer.reply.content], ["went-on", "Both stages are done."], `${here}: its reply, not a post it sent on the way`);
  }
});

test("an answer that never comes after a compaction says why: stopped, cut short, could not start, nothing to go on with", async () => {
  const participant = chatParticipant({ homeMachineId: "box" });
  const start = (mark: Record<string, unknown>) => {
    const conversation = chatConversation([participant], []);
    conversation.messages.push(acceptedMessage(), askingReply(participant.id, mark));
    const made = testService({ conversation, compactSession: async () => { throw new Error("not here"); } });
    const link = fakeServerLink("desktop-device");
    made.service.setServerLink(link);
    const controller = new AbortController();
    const asked = made.storage.current.messages.find((message: any) => message.id === "asked-reply");
    const waiting = (made.service as any).selfCompactedAnswer(conversation.id, participant.id, asked, controller.signal) as Promise<any>;
    return { ...made, link, controller, waiting, conversation };
  };
  for (const reason of ["stopped", "interrupted", "failed", "not-continued"]) {
    const { service, waiting } = start({ state: "waiting" });
    await delay(10);
    await service.applyServerEntries([fromServer("machine-device", { kind: "message.update", message: askingReply(participant.id, { state: "ended", reason }) })]);
    assert.deepEqual(await waiting, { kind: "ended", reason });
  }
  // The machine lost the compaction: its turn says so.
  const lost = start({ state: "waiting" });
  await delay(10);
  const compaction: HubTurn = { runId: "turn-c", conversationId: lost.conversation.id, messageId: "anchor", participantId: participant.id, state: "finished", outcome: "interrupted",
    executorDeviceId: "machine-device", request: { kind: "compaction", triggeredBy: "agent", resume: { runId: "turn-asked" } } };
  await lost.service.applyServerEntries([fromServer("machine-device", { kind: "turn.finish", turn: compaction })]);
  assert.deepEqual(await lost.waiting, { kind: "ended", reason: "interrupted" });
  // Her Stop of the request: the compaction and the turn after it stop there too.
  const stopped = start({ state: "waiting" });
  await stopped.service.applyServerEntries([fromServer("machine-device", { kind: "turn.request", turn: { ...compaction, state: "claimed", outcome: undefined } })]);
  await delay(10);
  stopped.controller.abort();
  assert.deepEqual(await stopped.waiting, { kind: "ended", reason: "stopped" });
  await waitFor(() => stopped.link.ops.some((op) => op.kind === "turn.stop" && op.runId === "turn-c"));
  // The server gave the turn after it before this device's Stop got there:
  // stopped as it stands once it is told of it.
  await stopped.service.applyServerEntries([fromServer("machine-device", { kind: "turn.claim", turn: {
    runId: "turn-compaction-resume-asked", conversationId: stopped.conversation.id, messageId: "event-1", participantId: participant.id, state: "claimed", executorDeviceId: "machine-device" } })]);
  await waitFor(() => stopped.link.ops.some((op) => op.kind === "turn.stop" && op.runId === "turn-compaction-resume-asked" && op.messageId === "event-1"));
});

test("a Stop of what the User sent while a member compacted leaves the work to her", async () => {
  let release!: () => void;
  const chat = selfCompactingChat({
    participant: ALLOWED,
    compactSession: async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { ok: true };
    },
    turn: async ({ actor, service, call }) => {
      if (call === 1) {
        await service.requestSelfCompactionFromTool(actor, {});
        return "Stage one is done.";
      }
      await new Promise<void>((resolve) => { release = resolve; });
      return "Late.";
    }
  });
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "user-run", content: "@admin go" });
  await waitFor(() => chat.order.includes("compact codex-admin"), 5_000);
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "second-run", content: "@admin wait, look at this" });
  release();
  await waitFor(() => chat.prompts.length === 2, 5_000);
  const second = chat.storage.current.messages.findLast((message: any) => message.role === "participant" && message.status === "pending");
  assert.equal(chat.service.cancelRun(second.metadata.runId), true);
  release();
  await waitFor(() => chat.debugEvents.some(({ event, payload }) => event === "chat.self-compaction.not-resumed" && payload.reason === "stopped"), 5_000);
  await waitFor(() => chat.storage.current.metadata.running === false, 5_000);
  assert.equal(chat.prompts.length, 2);
});

test("a restart that cut a member's compaction short is said on its reply once; a card still open goes on waiting", async () => {
  const participant = chatParticipant();
  const marks = async (mark: Record<string, unknown>, approvals: unknown[] = []): Promise<any> => {
    const conversation = chatConversation([participant], [chatSession(participant, "session-1")]);
    conversation.messages.push({ ...askingReply(participant.id, mark), metadata: { runId: "turn-asked", selfCompaction: mark } });
    conversation.metadata.pendingAppToolApprovals = approvals as never;
    const { service, storage } = testService({ conversation, compactSession: async () => ({}) });
    await (service as any).requireChat(conversation.id);
    return storage.current.messages.find((message: any) => message.id === "asked-reply").metadata.selfCompaction;
  };
  assert.deepEqual(await marks({ state: "waiting" }), { state: "ended", reason: "interrupted" });
  assert.deepEqual(await marks({ state: "card" }), { state: "ended", reason: "interrupted" });
  assert.deepEqual(await marks({ state: "resumed" }), { state: "resumed", reason: "interrupted" }, "its turn never began");
  assert.deepEqual(await marks({ state: "ended", reason: "stopped" }), { state: "ended", reason: "stopped" });
  const card = { id: "card", conversationId: "chat-compact", requesterParticipantId: participant.id, requesterHandle: "admin", requesterRoleConfigId: ROLE.id,
    toolName: "app_chat_request_compaction", capability: "compaction.request", status: "pending", request: { type: "self_compaction" }, summary: "Compact",
    createdAt: NOW, updatedAt: NOW, resumeContext: { runId: "turn-asked", triggerMessageId: "anchor" } };
  assert.deepEqual(await marks({ state: "card" }, [card]), { state: "card" });
});

test("a turn that could not start after the compaction, or was stopped before anyone took it, ends the wait for it", async () => {
  for (const [label, start, expected] of [
    ["refused", async () => { throw new Error("The server did not give @admin this turn: no."); }, { state: "resumed", reason: "failed" }],
    ["stopped before it was taken", async () => [], { state: "resumed", reason: "stopped" }]
  ] as Array<[string, () => Promise<any[]>, Record<string, unknown>]>) {
    const chat = selfCompactingChat({
      participant: ALLOWED,
      turn: async ({ actor, service }) => {
        await service.requestSelfCompactionFromTool(actor, {});
        const run = (service as any).runParticipantTurnSerialized.bind(service);
        (service as any).runParticipantTurnSerialized = async (...args: any[]) => {
          if (!String(args[3]).startsWith("turn-compaction-resume-")) return run(...args);
          args[6].turnReservation.release();
          return start();
        };
        return "Stage one is done.";
      }
    });
    await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "user-run", content: "@admin go" });
    await waitFor(() => chat.debugEvents.some(({ event }) => event === "chat.self-compaction.not-resumed"), 5_000);
    await waitFor(() => chat.storage.current.messages.some((message: any) => message.metadata?.selfCompaction?.reason), 5_000);
    const asking = chat.storage.current.messages.find((message: any) => message.metadata?.selfCompaction);
    const { error: _error, ...mark } = asking.metadata.selfCompaction;
    assert.deepEqual(mark, expected, label);
    const answer = await (chat.service as any).selfCompactedAnswer(chat.conversation.id, "codex-admin", asking, undefined);
    assert.equal(answer.kind, "ended", label);
    await waitFor(() => chat.storage.current.metadata.running === false, 5_000);
  }
});

test("a stopped request stops its member's compaction, its card and the turn it would go on in, never begun after", async () => {
  // Waiting on the User's card.
  const card = selfCompactingChat({
    turn: async ({ actor, service }) => {
      await service.requestSelfCompactionFromTool(actor, {});
      return "Stage one is done.";
    }
  });
  await card.service.sendMessage({ conversationId: card.conversation.id, runId: "user-run", content: "@admin go" });
  await waitFor(() => card.replies().length === 1 && card.storage.current.metadata.running === false, 5_000);
  const controller = new AbortController();
  const waiting = (card.service as any).selfCompactedAnswer(card.conversation.id, "codex-admin", card.replies()[0], controller.signal) as Promise<any>;
  await delay(20);
  controller.abort();
  assert.deepEqual(await waiting, { kind: "ended", reason: "stopped" });
  assert.equal(card.approvals()[0].status, "cancelled");
  // A resume already on its way behind another turn is not begun.
  await (card.service as any).continueAfterSelfCompaction(card.conversation.id, "codex-admin", { runId: card.replies()[0].metadata.runId }, { kind: "completed" }, undefined);
  assert.equal(card.prompts.length, 1);
});

test("a card approved after the User stopped something else of the member's still brings it back", async () => {
  let release: (() => void) | undefined;
  const chat = selfCompactingChat({
    turn: async ({ actor, service, call }) => {
      if (call === 1) await service.requestSelfCompactionFromTool(actor, {});
      if (call === 2) await new Promise<void>((resolve) => { release = resolve; });
      return `Reply ${call}.`;
    }
  });
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "user-run", content: "@admin go" });
  await waitFor(() => chat.replies().length === 1 && chat.storage.current.metadata.running === false, 5_000);
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "second-run", content: "@admin look at this" });
  await waitFor(() => Boolean(release), 5_000);
  const second = chat.storage.current.messages.findLast((message: any) => message.role === "participant" && message.status === "pending");
  chat.service.cancelRun(second.metadata.runId);
  release!();
  await waitFor(() => chat.storage.current.metadata.running === false, 5_000);
  await delay(5);
  await chat.service.respondToAppToolApproval({ conversationId: chat.conversation.id, approvalId: chat.approvals()[0].id, approve: true });
  await waitFor(() => chat.prompts.length === 3, 5_000);
  assert.match(chat.prompts[2].prompt, /Your context was compacted\./);
});

test("a Stop from before the member asked to compact, told again by the server, is not a Stop since", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation([participant], [chatSession(participant, "session-1")]);
  const { service } = testService({ conversation, compactSession: async () => ({}) });
  service.setServerLink(fakeServerLink("desktop-device"));
  const stopped = (at: string): HubTurn => ({ runId: `turn-${at}`, conversationId: conversation.id, messageId: "anchor", participantId: participant.id, state: "stopped", finishedAt: at, outcome: "stopped" });
  const since = "2026-11-25T12:00:00.000Z";
  const check = async (): Promise<boolean> => (service as any).memberStoppedSince(await (service as any).requireChat(conversation.id), participant.id, { runId: "asked", since });
  await service.applyServerEntries([fromServer("phone", { kind: "turn.stop", turn: stopped("2026-11-25T11:00:00.000Z") })]);
  assert.equal(await check(), false);
  await service.applyServerEntries([fromServer("phone", { kind: "turn.stop", turn: stopped("2026-11-25T12:00:01.000Z") })]);
  assert.equal(await check(), true);
});

test("a request held through a permission approval's resume is not swept as interrupted", async () => {
  const asker = chatParticipant({ id: "asker", handle: "asker" });
  const target = chatParticipant();
  const conversation = chatConversation([asker, target], []);
  conversation.messages.push({ id: "request", role: "participant", participantId: "asker", content: "@admin do it", createdAt: NOW, status: "done", metadata: { participantRequest: {
    id: "batch", requesterParticipantId: "asker", requesterHandle: "asker", source: "mcp", resumeRequester: true, status: "running", depth: 1, createdAt: NOW, updatedAt: NOW,
    items: [{ targetParticipantId: target.id, targetHandle: "admin", prompt: "Do it", status: "running", createdAt: NOW, updatedAt: NOW }] } } } as any);
  const { service } = testService({ conversation, compactSession: async () => ({}) });
  const sweep = (): boolean => (service as any).markOrphanedParticipantRequestsInterrupted(clone(conversation));
  (service as any).heldParticipantRequests.add("request");
  assert.equal(sweep(), false);
  (service as any).heldParticipantRequests.delete("request");
  assert.equal(sweep(), true);
});

test("a machine that restarted after a compaction ended, before its member went on, says so once it knows what waits on the server", async () => {
  const participant = chatParticipant({ homeMachineId: "box" });
  const conversation = chatConversation([participant], [chatSession(participant, "session-on-box")]);
  conversation.messages.push(acceptedMessage(), { ...askingReply(participant.id, { state: "waiting" }), metadata: { runId: "turn-asked", selfCompaction: { state: "waiting" } } });
  const { service, storage } = testService({ conversation, compactSession: async () => ({}) });
  service.setHostMachineId("box");
  (service as any).setMachineRuntime?.(true);
  (service as any).machineRuntime = true;
  const mark = (): any => storage.current.messages.find((message: any) => message.id === "asked-reply").metadata.selfCompaction;
  await (service as any).requireChat(conversation.id);
  assert.deepEqual(mark(), { state: "waiting" }, "not known yet what waits there");
  service.setServerLink(fakeServerLink("machine-device"));
  await service.resumeServerTurns();
  await (service as any).requireChat(conversation.id);
  assert.deepEqual(mark(), { state: "ended", reason: "interrupted" });
});

test("the turn a member goes on in is never taken for its requester's resume after a restart", () => {
  const { service } = testService({ conversation: chatConversation([], []), compactSession: async () => ({}) });
  const text = (service as any).selfCompactionResumeText(chatParticipant(), { kind: "completed" }, undefined) as string;
  assert.doesNotMatch(text, /^Auto-resumed @/);
});

test("a member's access says when to compact: on its own when it may, on a card when it asks, nothing when it may not", () => {
  const { service } = testService({ conversation: chatConversation([], []), compactSession: async () => ({}) });
  const lines = (right: "allow" | "ask" | "deny"): string =>
    (service as any).compactionAccessLines(normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), requestCompaction: right })).join("\n");
  assert.match(lines("allow"), /User is not asked\..*the app calls you again/s);
  assert.match(lines("allow"), /before you start a new task or the next stage of a big task/);
  assert.match(lines("ask"), /asks User on a card/);
  assert.equal(lines("deny"), "");
});

test("a compaction that finds no live process starts the member's process exactly as its next turn would, and that turn continues in it", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-compact-member-process-"));
  try {
    const participant = chatParticipant({ id: "claude-admin", kind: "claude-code", model: "claude-opus-5-5[1m]" });
    const session = { ...chatSession(participant, "session-1"), roleRuntime: "claude-agent" as const };
    const conversation = chatConversation([participant], [session]);
    const issued: Array<Record<string, unknown>> = [];
    const updated: Array<Record<string, unknown>> = [];
    const appMcp = {
      issueToken: (grant: Record<string, unknown>) => {
        issued.push(grant);
        return { url: "http://127.0.0.1:1/mcp", token: `token-${issued.length}` };
      },
      updateToken: (token: string, grant: Record<string, unknown>) => {
        updated.push(grant);
        return { url: "http://127.0.0.1:1/mcp", token };
      },
      clientStatus: () => undefined
    };
    const calls: Array<{ what: "compact" | "turn"; participant: ParticipantConfig; repoPath: string | undefined; options: any }> = [];
    const { service } = testService({
      conversation,
      appMcp,
      compactSession: async (runParticipant, repoPath, _diffMode, _kind, _signal, options) => {
        calls.push({ what: "compact", participant: runParticipant, repoPath, options });
        return { participant: runParticipant, ok: true, sessionId: "session-1" };
      },
      run: async (runParticipant, _prompt, repoPath, _diffMode, _kind, _signal, options: any) => {
        calls.push({ what: "turn", participant: runParticipant, repoPath, options });
        // The CLI hands the message to a step of the live process.
        options.warm.onReplyStarted?.();
        return { participant: runParticipant, ok: true, content: "Done.", durationMs: 1, sessionId: "session-1" };
      }
    });
    (service as any).ensureHistoryFiles = async () => tempRoot;

    // After a restart: no live process, no app tool connection yet.
    await service.sendMessage({ conversationId: conversation.id, runId: "compact-run", content: "@admin /compact" });
    await service.sendMessage({ conversationId: conversation.id, runId: "turn-run", content: "@admin continue" });
    await waitFor(() => calls.some((call) => call.what === "turn"));

    const compaction = calls.find((call) => call.what === "compact")!;
    const turn = calls.find((call) => call.what === "turn")!;
    assert.ok(compaction && turn);
    // What decides which live process a turn uses, and how it is started.
    assert.equal(compaction.repoPath, turn.repoPath);
    assert.equal(compaction.participant.model, turn.participant.model);
    assert.equal(compaction.participant.reasoningEffort, turn.participant.reasoningEffort);
    assert.equal(compaction.options.warm.contextKey, turn.options.warm.contextKey, "the turn finds the process the compaction started");
    assert.equal(compaction.options.warm.conversationId, turn.options.warm.conversationId);
    assert.equal(compaction.options.warm.participantId, turn.options.warm.participantId);
    assert.equal(compaction.options.warm.idleTimeoutMs, turn.options.warm.idleTimeoutMs);
    for (const field of ["sessionId", "persistSession", "agentMode", "agentEnvKey"]) {
      assert.deepEqual(compaction.options[field], turn.options[field], field);
    }
    assert.deepEqual(compaction.options.extraReadableDirs, turn.options.extraReadableDirs);
    assert.deepEqual(compaction.options.permissions, turn.options.permissions);
    assert.ok(compaction.options.role, "started with the member's role");
    assert.equal(compaction.options.role.name, turn.options.role.name);
    assert.equal(compaction.options.role.instructions, turn.options.role.instructions);
    assert.ok(compaction.options.appMcp, "started with the member's app tools");
    assert.equal(compaction.options.appMcp.url, turn.options.appMcp.url);
    assert.equal(compaction.options.appMcp.token, turn.options.appMcp.token, "the turn's app tools act through the connection the process was started with");
    assert.deepEqual(compaction.options.appMcp.toolNames, turn.options.appMcp.toolNames);
    assert.deepEqual(compaction.options.appMcp.autoPreauthorizedToolNames, turn.options.appMcp.autoPreauthorizedToolNames);
    assert.equal(compaction.options.appMcp.clientGenerationId, turn.options.appMcp.clientGenerationId);
    for (const observer of ["onSelfResumedTurn", "onBackgroundTasksChanged", "onPromptSuggestion"]) {
      assert.equal(typeof compaction.options.warm[observer], "function", observer);
      assert.equal(typeof turn.options.warm[observer], "function", observer);
    }
    assert.equal(issued.length, 1, "one app tool connection, issued for the compaction's process");
    assert.equal(issued[0].runId, "compact-run");
    assert.deepEqual(issued[0].expectedToolNames, turn.options.appMcp.toolNames);
    assert.equal(compaction.options.warm.onReplyStarted, undefined, "the grant was issued before the process was started");
    assert.equal(updated.at(-1)?.runId, turn.options.warm.origin.runId, "the next turn's reply moved the grant to itself when it started");

    // With a connection already live, a compaction leaves its grant alone,
    // unless it has to start the process: then the member's current grant
    // applies before the process connects, as for a turn.
    const grantsBefore = updated.length;
    await service.sendMessage({ conversationId: conversation.id, runId: "compact-run-2", content: "@admin /compact" });
    await waitFor(() => calls.filter((call) => call.what === "compact").length === 2);
    const second = calls.filter((call) => call.what === "compact")[1];
    assert.equal(second.options.appMcp.token, turn.options.appMcp.token);
    assert.equal(issued.length, 1);
    assert.equal(updated.length, grantsBefore, "the compaction did not move the member's app tool grant");
    second.options.warm.onReplyStarted();
    assert.equal(updated.at(-1)?.runId, "compact-run-2");
    assert.equal(updated.at(-1)?.clientGenerationId, turn.options.appMcp.clientGenerationId);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("a compaction gives Codex its app tools as a Codex turn does, gives Gemini none, and a prompt-fallback member no native role", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-compact-providers-"));
  try {
    const codex = chatParticipant({ id: "codex-member", handle: "cx", kind: "codex-cli" });
    const gemini = chatParticipant({ id: "gemini-member", handle: "gm", kind: "gemini-cli" });
    const fallback = chatParticipant({ id: "claude-fallback", handle: "cf", kind: "claude-code" });
    const conversation = chatConversation([codex, gemini, fallback], [
      chatSession(codex, "codex-session"),
      chatSession(gemini, "gemini-session"),
      // At the current config version: one at an older version tries the
      // CLI's own mechanism again (refreshExistingSessionForParticipant).
      { ...chatSession(fallback, "fallback-session"), roleRuntime: "prompt-fallback" as const, runtimeConfigVersion: 24 }
    ]);
    const issued: Array<Record<string, unknown>> = [];
    const appMcp = {
      issueToken: (grant: Record<string, unknown>) => {
        issued.push(grant);
        return { url: "http://127.0.0.1:1/mcp", token: `token-${issued.length}` };
      },
      updateToken: (token: string) => ({ url: "http://127.0.0.1:1/mcp", token }),
      clientStatus: () => undefined
    };
    const options = new Map<string, any>();
    const { service } = testService({
      conversation,
      appMcp,
      compactSession: async (runParticipant, _repoPath, _diffMode, _kind, _signal, compactOptions) => {
        options.set(runParticipant.id, compactOptions);
        return { participant: runParticipant, ok: true, sessionId: compactOptions.sessionId as string };
      }
    });
    (service as any).ensureHistoryFiles = async () => tempRoot;
    for (const handle of ["cx", "gm", "cf"]) {
      await service.sendMessage({ conversationId: conversation.id, runId: `compact-${handle}`, content: `@${handle} /compact` });
    }
    assert.equal(options.get("codex-member").appMcp?.token, "token-1", "Codex: granted before it runs, as its turns are");
    assert.equal(issued[0].participantId, "codex-member");
    assert.ok(options.get("codex-member").role, "Codex: its role, as a turn starts it");
    assert.equal(options.get("gemini-member").appMcp, undefined, "Gemini's compaction runs no app tools");
    assert.equal(issued.some((grant) => grant.participantId === "gemini-member"), false);
    assert.equal(options.get("claude-fallback").role, undefined, "a prompt-fallback session has no native role");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("a compaction failure line ends with one period whatever the reason ends with", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-compact-line-"));
  try {
    const participant = chatParticipant();
    const conversation = chatConversation([participant], [chatSession(participant, "session-1")]);
    const errors: Array<string | undefined> = ["Compaction was cancelled.", undefined, "No messages to compact", " . "];
    const { service, storage } = testService({
      conversation,
      compactSession: async (runParticipant) => ({ participant: runParticipant, ok: false, error: errors.shift() })
    });
    (service as any).ensureHistoryFiles = async () => tempRoot;
    const lines: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      await service.sendMessage({ conversationId: conversation.id, runId: `compact-${index}`, content: "@admin /compact" });
      lines.push(storage.current.messages.at(-1)?.content);
    }
    assert.deepEqual(lines, [
      "Could not compact @admin context: Compaction was cancelled.",
      "Could not compact @admin context: unknown error.",
      "Could not compact @admin context: No messages to compact.",
      "Could not compact @admin context: unknown error."
    ]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

function testService(options: {
  conversation: Conversation;
  compactSession: (participant: ParticipantConfig, repoPath: string | undefined, diffMode: undefined, kind: "chat", signal: AbortSignal | undefined, options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  contextUsageForSession?: (participant: ParticipantConfig, sessionId: string | undefined) => Promise<Record<string, unknown> | undefined>;
  run?: (participant: ParticipantConfig, prompt: string, repoPath: string | undefined, diffMode: undefined, kind: "chat", signal: AbortSignal | undefined, options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  appMcp?: Record<string, unknown>;
  debugEvents?: Array<{ event: string; payload: Record<string, unknown> }>;
}): { service: ChatService; storage: any } {
  const storage = {
    current: clone(options.conversation),
    async getConversation(id: string): Promise<Conversation | undefined> {
      return this.current?.id === id ? clone(this.current) : undefined;
    },
    async saveConversation(conversation: Conversation): Promise<void> {
      this.current = clone(conversation);
    },
    // What the User's server's feed asks of a device's storage.
    conversationTombstones() {
      return { isDeleted: async () => false, mark: async () => undefined, pendingCopies: async () => [] };
    }
  };
  const settings = {
    async getPublicSettings(): Promise<{ chatRoleConfigs: ChatRoleConfig[]; chatPromptContext: typeof DEFAULT_CHAT_PROMPT_CONTEXT }> {
      return { chatRoleConfigs: [ROLE], chatPromptContext: DEFAULT_CHAT_PROMPT_CONTEXT };
    }
  };
  const cliRunner = {
    async compactSession(...args: Parameters<typeof options.compactSession>): Promise<Record<string, unknown>> {
      return options.compactSession(...args);
    },
    async contextUsageForSession(participant: ParticipantConfig, sessionId: string | undefined): Promise<Record<string, unknown> | undefined> {
      return options.contextUsageForSession?.(participant, sessionId);
    },
    async detectAgents(): Promise<[]> {
      return [];
    },
    async run(...args: Parameters<NonNullable<typeof options.run>>): Promise<Record<string, unknown>> {
      if (!options.run) throw new Error("No turn expected in this test.");
      return options.run(...args);
    }
  };
  const debugLogs = {
    async write(event: string, payload: Record<string, unknown>): Promise<void> {
      options.debugEvents?.push({ event, payload });
    }
  };
  return {
    service: new ChatService(storage as never, settings as never, cliRunner as never, debugLogs as never, options.appMcp as never),
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

function selfCompactionActor(participant: ChatParticipant): any {
  return {
    conversationId: "chat-compact",
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: ROLE.version,
    capabilities: ["compaction.request"],
    runId: "active-turn"
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

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await delay(10);
  }
  assert.fail("Timed out waiting for condition.");
}

test("a member compacting while another member's compaction finishes stays compacting and cannot be removed", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-compact-"));
  try {
    const first = chatParticipant({ id: "first", handle: "first" });
    const second = chatParticipant({ id: "second", handle: "second" });
    const third = chatParticipant({ id: "third", handle: "third" });
    const conversation = chatConversation([first, second, third], [chatSession(first, "first-session"), chatSession(second, "second-session")]);
    let finishSecond!: () => void;
    const { service, storage } = testService({
      conversation,
      compactSession: async (runParticipant) => {
        if (runParticipant.id === "second") {
          await new Promise<void>((resolve) => { finishSecond = resolve; });
        }
        return { participant: runParticipant, ok: true, sessionId: `${runParticipant.id}-session` };
      }
    });
    (service as any).ensureHistoryFiles = async () => tempRoot;

    const firstCompaction = service.compactParticipant({ conversationId: conversation.id, participantId: first.id, runId: "first-compaction" });
    const secondCompaction = service.compactParticipant({ conversationId: conversation.id, participantId: second.id, runId: "second-compaction" });
    await firstCompaction;
    await waitFor(() => typeof finishSecond === "function");
    await (service as any).waitForQueuedSave(conversation.id);

    assert.ok(storage.current.metadata.participantCompactionsByParticipantId?.second, "the second member still shows as compacting");
    await assert.rejects(
      () => service.removeParticipant({ conversationId: conversation.id, participantId: second.id }),
      /@second is busy/
    );

    finishSecond();
    await secondCompaction;
    assert.equal(storage.current.metadata.participantCompactionsByParticipantId, undefined);
    await service.removeParticipant({ conversationId: conversation.id, participantId: second.id });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
