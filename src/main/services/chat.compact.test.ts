import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ChatParticipant, ChatParticipantSession, ChatRoleConfig, Conversation, ParticipantConfig } from "../../shared/types";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { readParticipantCompactions } from "../../shared/chatRunState";
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
    assert.deepEqual(readParticipantCompactions(storage.current.metadata), {});
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
        source: "codex-cli",
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
    assert.equal(storage.current.messages.at(-1)?.metadata?.compaction?.outcome, "failed");
    assert.equal(debugEvents.filter(({ event }) => event === "chat.compaction.finished").at(-1)?.payload.outcome, "failed");
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
    await waitFor(() => storage.current.messages.at(-1)?.content === "Compacted @admin context with focus instructions.");
    assert.deepEqual(storage.current.messages.at(-1)?.metadata?.compaction, {
      triggeredBy: "agent",
      participantId: participant.id,
      outcome: "completed",
      instructionsProvided: true
    });
    assert.deepEqual(debugEvents.map(({ event, payload }) => ({ event, triggeredBy: payload.triggeredBy, outcome: payload.outcome })), [
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

test("/compact on a member hosted on a machine is compacted there and shows the machine's outcome and context use", async () => {
  const participant = chatParticipant({ homeMachineId: "box" });
  const conversation = chatConversation([participant], []);
  const debugEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const { service, storage } = testService({
    conversation,
    debugEvents,
    compactSession: async () => { throw new Error("a member on a machine is never compacted on the desktop"); }
  });
  const dispatched: any[] = [];
  let acknowledged = false;
  let markerDuringDispatch: unknown;
  const usage = { usedTokens: 300, contextWindowTokens: 1000, percentage: 30, source: "codex-cli", updatedAt: "2026-02-01T00:00:00.000Z" };
  service.setMachineLink({
    runTurn: async () => { throw new Error("not a turn"); },
    compactOnMachine: async (request) => {
      dispatched.push(request);
      markerDuringDispatch = readParticipantCompactions(storage.current.metadata)[participant.id]?.runId;
      return {
        status: "completed",
        messages: [{ id: "machine-outcome", role: "system", content: "Compacted @admin context with focus instructions.", createdAt: NOW, status: "done",
          metadata: { runId: request.runId, threadId: "thread-1", compaction: { triggeredBy: "user", participantId: participant.id, outcome: "completed", instructionsProvided: true } } } as any],
        warnings: [],
        contextUsage: usage as any,
        acknowledge: async () => { acknowledged = true; }
      };
    }
  });

  const result = await service.sendMessage({ conversationId: conversation.id, runId: "machine-compact", content: "@admin /compact keep the plan", threadId: "thread-1" });

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].runId, "machine-compact");
  assert.equal(dispatched[0].participant.id, participant.id);
  assert.deepEqual(dispatched[0].compaction, { triggeredBy: "user", instructions: "keep the plan", threadId: "thread-1" });
  assert.equal(markerDuringDispatch, "machine-compact", "the member shows as compacting while its machine works");
  assert.equal(result.warnings.length, 0);
  assert.equal(storage.current.messages.at(-1)?.id, "machine-outcome");
  assert.equal(storage.current.messages.at(-1)?.content, "Compacted @admin context with focus instructions.");
  assert.equal(storage.current.metadata.agentContextUsageByParticipant?.[participant.id]?.usedTokens, 300);
  assert.equal(acknowledged, true, "the machine drops its result only after this desktop stored it");
  assert.deepEqual(readParticipantCompactions(storage.current.metadata), {});
  assert.equal(storage.current.metadata.activeRunIds, undefined);
  assert.deepEqual(debugEvents.filter(({ event }) => event.startsWith("chat.compaction.")).map(({ event, payload }) => [event, payload.outcome]), [
    ["chat.compaction.requested", undefined],
    ["chat.compaction.finished", "completed"]
  ]);
});

test("a machine compaction that could not start ends as a local one that could not", async () => {
  const participant = chatParticipant({ homeMachineId: "box" });
  const conversation = chatConversation([participant], []);
  const { service, storage } = testService({ conversation, compactSession: async () => { throw new Error("not here"); } });
  const calls: string[] = [];
  service.setMachineLink({
    runTurn: async () => { throw new Error("not a turn"); },
    compactOnMachine: async (request) => {
      calls.push(request.runId);
      return { status: "failed", messages: [], warnings: [], sent: false, error: "@admin is hosted on Box, which is not connected." };
    }
  });
  const offline = await service.compactParticipant({ conversationId: conversation.id, participantId: participant.id, runId: "machine-offline" });
  assert.equal(storage.current.messages.at(-1)?.content, "Could not compact @admin context: @admin is hosted on Box, which is not connected.");
  assert.equal(storage.current.messages.at(-1)?.metadata?.compaction?.outcome, "failed");
  assert.deepEqual(offline.warnings, ["Could not compact @admin context: @admin is hosted on Box, which is not connected."]);

  // Stopped before it was sent: the words a local compaction stopped before it started writes.
  const stop = new AbortController();
  stop.abort();
  await service.compactParticipant({ conversationId: conversation.id, participantId: participant.id, runId: "machine-stopped" }, stop.signal);
  assert.deepEqual(calls, ["machine-offline"], "a stopped compaction is never sent");
  assert.equal(storage.current.messages.at(-1)?.content, "Could not compact @admin context: Compaction was cancelled before native execution started..");
  assert.equal(storage.current.metadata.activeRunIds, undefined);

  // A member whose cloud machine was never prepared has never run.
  const pending = chatParticipant({ id: "cloud-pending", handle: "cloudy", cloudRun: { kind: "aws" } as any });
  storage.current.metadata.participants = [participant, pending];
  await service.compactParticipant({ conversationId: conversation.id, participantId: pending.id, runId: "machine-pending" });
  assert.equal(storage.current.messages.at(-1)?.content, "@cloudy does not have an active session to compact yet.");
  assert.deepEqual(calls, ["machine-offline"]);
});

test("the machine compacts its own member with the desktop's run id and returns the outcome line and context use", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-compact-machine-"));
  try {
    const participant = chatParticipant({ homeMachineId: "box" });
    const conversation = chatConversation([participant], [chatSession(participant, "session-on-box")]);
    let compactedSession: unknown;
    const { service } = testService({
      conversation,
      compactSession: async (runParticipant, _repoPath, _diffMode, _kind, _signal, options) => {
        compactedSession = options.sessionId;
        return { participant: runParticipant, ok: true, sessionId: "session-on-box",
          contextUsage: { usedTokens: 50, contextWindowTokens: 1000, percentage: 5, source: "codex-cli", updatedAt: "2026-03-01T00:00:00.000Z" } };
      }
    });
    (service as any).ensureHistoryFiles = async () => tempRoot;
    service.setHostMachineId("box");
    const result = await service.runMachineHostedCompaction({ conversationId: conversation.id, participantId: participant.id, runId: "desktop-run", triggeredBy: "agent", threadId: "t-9" });
    assert.equal(compactedSession, "session-on-box");
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].content, "Compacted @admin context.");
    assert.equal(result.messages[0].metadata?.runId, "desktop-run");
    assert.equal(result.messages[0].metadata?.threadId, "t-9");
    assert.equal(result.messages[0].metadata?.compaction?.triggeredBy, "agent");
    assert.equal(result.contextUsage?.usedTokens, 50);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("a member on a machine asking to compact itself is run through the desktop when it is there", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-compact-delegate-"));
  try {
    const participant = chatParticipant({
      homeMachineId: "box",
      permissions: normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), requestCompaction: "allow" })
    });
    const conversation = chatConversation([participant], [chatSession(participant, "session-on-box")]);
    let compactCalls = 0;
    const { service } = testService({
      conversation,
      compactSession: async (runParticipant) => { compactCalls += 1; return { participant: runParticipant, ok: true, sessionId: "session-on-box" }; }
    });
    (service as any).ensureHistoryFiles = async () => tempRoot;
    service.setHostMachineId("box");
    const delegated: any[] = [];
    let desktopHere = true;
    service.setCompactionDelegate({ canDelegateCompaction: () => desktopHere, delegateCompaction: async (request) => { delegated.push(request); } });

    const asked = await service.requestSelfCompactionFromTool(selfCompactionActor(participant), { instructions: "Keep the API notes." });
    assert.equal(asked.status, "queued");
    await waitFor(() => delegated.length === 1);
    assert.deepEqual(delegated[0], { conversationId: conversation.id, participantId: participant.id, runId: asked.runId, instructions: "Keep the API notes." });
    await delay(25);
    assert.equal(compactCalls, 0, "the desktop runs it, and sends it back as a compaction command");

    // No desktop to take it: it runs here, as it always has.
    desktopHere = false;
    (service as any).storage.current.metadata.participantSelfCompactionRequestedAtByParticipantId = {};
    const alone = await service.requestSelfCompactionFromTool(selfCompactionActor(participant), {});
    assert.equal(alone.status, "queued");
    await waitFor(() => compactCalls === 1);
    assert.equal(delegated.length, 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("the desktop runs a compaction a machine asks for only for that machine's own member", async () => {
  const participant = chatParticipant({ homeMachineId: "box" });
  const conversation = chatConversation([participant], []);
  const debugEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const { service, storage } = testService({ conversation, debugEvents, compactSession: async () => { throw new Error("not here"); } });
  const dispatched: any[] = [];
  service.setMachineLink({
    runTurn: async () => { throw new Error("not a turn"); },
    compactOnMachine: async (request) => {
      dispatched.push(request);
      return { status: "completed", warnings: [], messages: [{ id: `outcome-${request.runId}`, role: "system", content: "Compacted @admin context.", createdAt: NOW, status: "done",
        metadata: { runId: request.runId, compaction: { triggeredBy: "agent", participantId: participant.id, outcome: "completed", instructionsProvided: false } } } as any] };
    }
  });
  await service.runDelegatedCompaction({ machineId: "another-box", conversationId: conversation.id, participantId: participant.id, runId: "foreign" });
  assert.equal(dispatched.length, 0);
  assert.equal(debugEvents.find(({ event }) => event === "chat.self-compaction.delegation-refused")?.payload.reason, "not-its-member");

  await service.runDelegatedCompaction({ machineId: "box", conversationId: conversation.id, participantId: participant.id, runId: "own", instructions: "Focus." });
  await waitFor(() => storage.current.messages.some((message: any) => message.id === "outcome-own"));
  assert.equal(dispatched.length, 1);
  assert.deepEqual(dispatched[0].compaction, { triggeredBy: "agent", instructions: "Focus." });
  // Delivered again: still one run.
  await service.runDelegatedCompaction({ machineId: "box", conversationId: conversation.id, participantId: participant.id, runId: "own" });
  assert.equal(debugEvents.filter(({ event }) => event === "chat.self-compaction.delegation-refused").at(-1)?.payload.reason, "already-run");
  assert.equal(dispatched.length, 1);
  await service.runDelegatedCompaction({ machineId: "box", conversationId: conversation.id, participantId: participant.id, runId: "../../etc" });
  assert.equal(debugEvents.filter(({ event }) => event === "chat.self-compaction.delegation-refused").at(-1)?.payload.reason, "invalid-run-id");
});

test("a delegated compaction is one run while it is in flight, and yields to one already running", async () => {
  const participant = chatParticipant({ homeMachineId: "box" });
  const conversation = chatConversation([participant], []);
  const debugEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const { service, storage } = testService({ conversation, debugEvents, compactSession: async () => { throw new Error("not here"); } });
  const dispatched: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  service.setMachineLink({
    runTurn: async () => { throw new Error("not a turn"); },
    compactOnMachine: async (request) => {
      dispatched.push(request.runId);
      await held;
      return { status: "completed", warnings: [], messages: [{ id: `outcome-${request.runId}`, role: "system", content: "Compacted @admin context.", createdAt: NOW, status: "done",
        metadata: { runId: request.runId, compaction: { triggeredBy: "agent", participantId: participant.id, outcome: "completed", instructionsProvided: false } } } as any] };
    }
  });
  const reasons = () => debugEvents.filter(({ event }) => event === "chat.self-compaction.delegation-refused").map(({ payload }) => payload.reason);
  await service.runDelegatedCompaction({ machineId: "box", conversationId: conversation.id, participantId: participant.id, runId: "first" });
  await waitFor(() => dispatched.length === 1);
  await service.runDelegatedCompaction({ machineId: "box", conversationId: conversation.id, participantId: participant.id, runId: "first" });
  assert.deepEqual(reasons(), ["already-run"]);
  // The member asks again while the first is running: the running one covers it.
  await service.runDelegatedCompaction({ machineId: "box", conversationId: conversation.id, participantId: participant.id, runId: "second" });
  assert.deepEqual(reasons(), ["already-run", "already-compacting"]);
  release();
  await waitFor(() => storage.current.messages.some((message: any) => message.id === "outcome-first"));
  assert.deepEqual(dispatched, ["first"]);
});

test("a member's own compaction the User switched off here ends with the line a refusal leaves", async () => {
  const participant = chatParticipant({ homeMachineId: "box", permissions: normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), requestCompaction: "deny" }) });
  const conversation = chatConversation([participant], []);
  const { service, storage } = testService({ conversation, compactSession: async () => { throw new Error("not here"); } });
  let dispatched = 0;
  service.setMachineLink({ runTurn: async () => { throw new Error("not a turn"); }, compactOnMachine: async () => { dispatched += 1; return { status: "completed", messages: [], warnings: [] }; } });
  await service.runDelegatedCompaction({ machineId: "box", conversationId: conversation.id, participantId: participant.id, runId: "refused" });
  assert.equal(dispatched, 0);
  await waitFor(() => storage.current.messages.at(-1)?.content === "Could not compact @admin context: Context compaction requests are disabled for @admin.");
  assert.equal(storage.current.messages.at(-1)?.metadata?.compaction?.triggeredBy, "agent");
});

test("the machine keeps its compaction result while this desktop cannot store it", async () => {
  const participant = chatParticipant({ homeMachineId: "box" });
  const conversation = chatConversation([participant], []);
  const debugEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const { service, storage } = testService({ conversation, debugEvents, compactSession: async () => { throw new Error("not here"); } });
  let acknowledged = 0;
  let failSaves = false;
  const save = storage.saveConversation.bind(storage);
  storage.saveConversation = async (next: Conversation) => {
    if (failSaves && next.messages.some((message: any) => message.id === "unsaved-outcome")) throw new Error("SQLITE_FULL: database or disk is full");
    return save(next);
  };
  service.setMachineLink({
    runTurn: async () => { throw new Error("not a turn"); },
    compactOnMachine: async (request) => {
      failSaves = request.runId === "unsaved";
      return { status: "completed", warnings: [],
        messages: [{ id: `${request.runId}-outcome`, role: "system", content: "Compacted @admin context.", createdAt: NOW, status: "done",
          metadata: { runId: request.runId, compaction: { triggeredBy: "user", participantId: participant.id, outcome: "completed", instructionsProvided: false } } } as any],
        acknowledge: async () => {
          acknowledged += 1;
          if (request.runId === "ack-fails") throw new Error("the receipt could not be sent");
        }
      };
    }
  });
  await assert.rejects(service.compactParticipant({ conversationId: conversation.id, participantId: participant.id, runId: "unsaved" }), /SQLITE_FULL/);
  assert.equal(acknowledged, 0, "no acknowledgement for a result this desktop did not store: the machine keeps it and sends it again");
  assert.ok(debugEvents.some(({ event, payload }) => event === "chat.compaction.finished" && payload.runId === "unsaved" && payload.outcome === "failed"));
  failSaves = false;
  await service.compactParticipant({ conversationId: conversation.id, participantId: participant.id, runId: "ack-fails" });
  assert.equal(acknowledged, 1);
  assert.ok(debugEvents.some(({ event, payload }) => event === "chat.compaction.ack-pending" && payload.runId === "ack-fails"));
  assert.equal(storage.current.messages.at(-1)?.id, "ack-fails-outcome");
  assert.deepEqual(readParticipantCompactions(storage.current.metadata), {});
  assert.equal(storage.current.metadata.activeRunIds, undefined);
});

test("a compaction result that arrives after a desktop restart lands its line and the member's context use", async () => {
  const participant = chatParticipant({ homeMachineId: "box" });
  const local = chatParticipant({ id: "local-member", handle: "local" });
  const conversation = chatConversation([participant, local], []);
  conversation.metadata.participantCompactionsByParticipantId = { [participant.id]: { runId: "late-run", startedAt: NOW } };
  conversation.metadata.activeRunIds = ["late-run"];
  const { service, storage } = testService({ conversation, compactSession: async () => { throw new Error("not here"); } });
  const usage = { usedTokens: 70, contextWindowTokens: 1000, percentage: 7, source: "codex-cli", updatedAt: "2026-04-01T00:00:00.000Z" };
  const line = { id: "late-outcome", role: "system", content: "Compacted @admin context.", createdAt: NOW, status: "done",
    metadata: { runId: "late-run", compaction: { triggeredBy: "user", participantId: participant.id, outcome: "completed", instructionsProvided: false } } } as any;
  await service.applyMachineLateTerminal({ conversationId: conversation.id, runId: "late-run", status: "completed", messages: [line], warnings: [],
    machineName: "Box", machineId: "box", participantId: participant.id, contextUsage: usage as any });
  assert.equal(storage.current.messages.at(-1)?.content, "Compacted @admin context.");
  assert.deepEqual(readParticipantCompactions(storage.current.metadata), {});
  assert.equal(storage.current.metadata.agentContextUsageByParticipant?.[participant.id]?.usedTokens, 70);
  // A compaction stopped on the machine before it ran, learned after a restart, still says so.
  await service.applyMachineLateTerminal({ conversationId: conversation.id, runId: "late-stopped", status: "interrupted", messages: [], warnings: [],
    machineName: "Box", machineId: "box", participantId: participant.id, compaction: { triggeredBy: "user" } });
  assert.equal(storage.current.messages.at(-1)?.content, "Could not compact @admin context: Compaction was cancelled before native execution started..");
  assert.equal(storage.current.messages.at(-1)?.metadata?.runId, "late-stopped");
  await service.applyMachineLateTerminal({ conversationId: conversation.id, runId: "late-failed", status: "failed", messages: [], warnings: [],
    machineName: "Box", machineId: "box", participantId: participant.id, compaction: { triggeredBy: "agent" },
    error: "The machine runtime ended after accepting this command; its execution outcome is uncertain and it was not run again." });
  assert.equal(storage.current.messages.at(-1)?.content, "Could not compact @admin context: The machine runtime ended after accepting this command; its execution outcome is uncertain and it was not run again.");
  // Another machine cannot set the context use of a member that is not its own.
  await service.applyMachineLateTerminal({ conversationId: conversation.id, runId: "other-run", status: "completed", messages: [], warnings: [],
    machineName: "Other", machineId: "other-box", participantId: local.id, contextUsage: { ...usage, usedTokens: 999, updatedAt: "2099-01-01T00:00:00.000Z" } as any });
  assert.equal(storage.current.metadata.agentContextUsageByParticipant?.[local.id], undefined);
});

test("a member's own compaction runs on its machine when handing it to the desktop fails", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-compact-delegate-fail-"));
  try {
    const participant = chatParticipant({ homeMachineId: "box", permissions: normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), requestCompaction: "allow" }) });
    const conversation = chatConversation([participant], [chatSession(participant, "session-on-box")]);
    const debugEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];
    let compactCalls = 0;
    const { service } = testService({ conversation, debugEvents,
      compactSession: async (runParticipant) => { compactCalls += 1; return { participant: runParticipant, ok: true, sessionId: "session-on-box" }; } });
    (service as any).ensureHistoryFiles = async () => tempRoot;
    service.setHostMachineId("box");
    service.setCompactionDelegate({ canDelegateCompaction: () => true, delegateCompaction: async () => { throw new Error("outbox full"); } });
    const asked = await service.requestSelfCompactionFromTool(selfCompactionActor(participant), {});
    assert.equal(asked.status, "queued");
    await waitFor(() => compactCalls === 1);
    assert.ok(debugEvents.some(({ event, payload }) => event === "chat.self-compaction.delegate-error" && payload.runId === asked.runId));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Stop by run id reaches a compaction the machine runs for the desktop", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-chat-compact-machine-stop-"));
  try {
    const participant = chatParticipant({ homeMachineId: "box" });
    const conversation = chatConversation([participant], [chatSession(participant, "session-on-box")]);
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
    const running = service.runMachineHostedCompaction({ conversationId: conversation.id, participantId: participant.id, runId: "stop-me", triggeredBy: "user" });
    await waitFor(() => compactSignal !== undefined);
    assert.equal(service.cancelRun("stop-me"), true);
    const result = await running;
    assert.equal(compactSignal?.aborted, true);
    assert.equal(result.messages[0]?.metadata?.compaction?.outcome, "failed");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

function testService(options: {
  conversation: Conversation;
  compactSession: (participant: ParticipantConfig, repoPath: string | undefined, diffMode: undefined, kind: "chat", signal: AbortSignal | undefined, options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  contextUsageForSession?: (participant: ParticipantConfig, sessionId: string | undefined) => Promise<Record<string, unknown> | undefined>;
  debugEvents?: Array<{ event: string; payload: Record<string, unknown> }>;
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
    async write(event: string, payload: Record<string, unknown>): Promise<void> {
      options.debugEvents?.push({ event, payload });
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
