import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ChatParticipant, ParticipantConfig } from "../../shared/types";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { chatParts } from "./chat/test/chatParts";
import {
  chatConversation, chatParticipant, chatSession, NOW, selfCompactionActor, testService, waitFor
} from "./chat/test/compactionFixtures";

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
    chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
    const activeTurn = chatParts(service).turnQueue.reserveParticipantTurn(conversation.id, participant.id);

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
    chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

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
    chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
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
