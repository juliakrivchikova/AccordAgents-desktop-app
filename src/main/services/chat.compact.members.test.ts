import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ChatParticipantSession, ParticipantConfig } from "../../shared/types";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { readParticipantCompactions } from "../../shared/chatRunState";
import { chatDependencies, chatParts } from "./chat/test/chatParts";
import { memoryIndexKey } from "./chat/members/roleRuntime";
import { compactionAccessLines } from "./chat/turns/promptSections";
import {
  chatConversation, chatParticipant, chatSession, NOW, selfCompactingChat, testService, waitFor
} from "./chat/test/compactionFixtures";

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
    chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

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
      instructionsProvided: false,
      cli: participant.kind
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
    chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

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
    chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
    let apiKey: string | undefined = "zai-secret";
    chatDependencies(service).settings.getManualAgentEnvironment = async () => ({ env: {}, version: "env-v1" });
    chatDependencies(service).settings.getCliProviderHostSecret = async (id: string) => (id === host.id ? { host, apiKey } : undefined);

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
    chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
    chatDependencies(service).settings.getManualAgentEnvironment = async () => ({ env: {}, version: "env-v1" });
    chatDependencies(service).settings.getCliProviderHostSecret = async (id: string) => (id === host.id ? { host, apiKey: "gemini-secret" } : undefined);

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
    chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

    await service.compactParticipant({
      conversationId: conversation.id,
      participantId: participant.id,
      runId: "compact-usage"
    });

    assert.equal(storage.current.metadata.agentContextUsageByParticipant?.[participant.id]?.usedTokens, 120);
    assert.equal(storage.current.metadata.agentContextUsageByParticipant?.[participant.id]?.percentage, 12);
    assert.deepEqual(readParticipantCompactions(storage.current.metadata), {});
    // The list of memory notes was in the compacted context: the next turn shows it again.
    assert.ok(chatParts(service).memberSessions.memoryIndexDue.has(memoryIndexKey(conversation.id, participant.id)));
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
    chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

    await service.compactParticipant({
      conversationId: conversation.id,
      participantId: participant.id,
      runId: "compact-gemini-role"
    });

    const storedSession = storage.current.metadata.participantSessions[0] as ChatParticipantSession;
    assert.equal(storedSession.sessionId, "gemini-after");
    assert.equal(storedSession.runtimeConfigVersion, undefined);
    const next = await chatParts(service).memberSessions.sessionForParticipant(storage.current, participant);
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
    chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
    chatParts(service).activeRuns.rememberActiveChatRun(conversation.id, "other-run");

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
    chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
    const reservation = chatParts(service).turnQueue.reserveParticipantTurn(conversation.id, participant.id);

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
    chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

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
    chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

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
    assert.equal(chatParts(service).memberSessions.memoryIndexDue.size, 0);
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
    chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

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
    chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

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

test("a member's access says when to compact: on its own when it may, on a card when it asks, nothing when it may not", () => {
  const { service } = testService({ conversation: chatConversation([], []), compactSession: async () => ({}) });
  const lines = (right: "allow" | "ask" | "deny"): string =>
    compactionAccessLines(normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), requestCompaction: right })).join("\n");
  assert.match(lines("allow"), /User is not asked\..*the app calls you again/s);
  // Between big finished stages, with the moments named; never mid-stage
  // or for size alone (the User, 2026-11-27), and never a figure of how full
  // the context is.
  assert.match(lines("allow"), /when a big stage of your work is finished, your next step is `app_chat_request_compaction`, not the next stage/);
  assert.match(lines("allow"), /inside one task given in stages too.*For example: findings written, compact/s);
  assert.match(lines("allow"), /your task is done and the next one starts; implementation is done and QA starts; QA or review is done and the report or the next fix starts; an investigation ended/);
  assert.match(lines("allow"), /Never in the middle of a stage, not because of context size alone/);
  assert.match(lines("allow"), /Say in the reply what is done and what comes next\..*Then end the reply/s);
  assert.match(lines("ask"), /asks User on a card/);
  assert.match(lines("ask"), /Ask between big finished stages .*never mid-stage or for size alone/);
  assert.doesNotMatch(lines("allow") + lines("ask"), /\d+ ?%|percent|how full|tokens/i);
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
    chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

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
      { ...chatSession(fallback, "fallback-session"), roleRuntime: "prompt-fallback" as const, runtimeConfigVersion: 26 }
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
    chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
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
    chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
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
    chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

    const firstCompaction = service.compactParticipant({ conversationId: conversation.id, participantId: first.id, runId: "first-compaction" });
    const secondCompaction = service.compactParticipant({ conversationId: conversation.id, participantId: second.id, runId: "second-compaction" });
    await firstCompaction;
    await waitFor(() => typeof finishSecond === "function");
    await chatParts(service).store.waitForQueuedSave(conversation.id);

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
