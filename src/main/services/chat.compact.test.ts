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
    assert.deepEqual(request.request, { kind: "compaction", triggeredBy: "agent", instructions: "Keep the API notes." });
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
      { ...chatSession(fallback, "fallback-session"), roleRuntime: "prompt-fallback" as const }
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
