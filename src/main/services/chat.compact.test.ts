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
