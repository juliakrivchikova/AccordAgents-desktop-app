import assert from "node:assert/strict";
import test from "node:test";
import { chatDependencies, chatParts } from "./chat/test/chatParts";
import { consumeOneTimePermissionApprovals } from "./chat/approvals/permissionGrants";
import { defaultChatAgentPermissions } from "../../shared/agentPermissions";
import type { ChatAppToolApproval, ChatMessage, ChatParticipant, Conversation, ParticipantConfig } from "../../shared/types";
import {
  chatConversation, chatParticipant, completeParticipantRequest, inferredRequestMessages, NOW, participantReplyMessage,
  participantRequestActor, permissionApproval, testService, waitFor
} from "./chat/test/permissionFixtures";

test("one-time permission overlay is consumed after one run projection", () => {
  const service = testService().service as any;
  const participant = chatParticipant("claude-code");
  const approval = permissionApproval(participant, {
    kind: "shellRules",
    rules: [{ action: "allow", match: "prefix", pattern: "git diff" }]
  }, {
    approvalScope: "once",
    status: "approved"
  });
  const conversation = chatConversation([participant], { pendingAppToolApprovals: [approval] });
  const appliedIds: string[] = [];

  const projected = chatParts(service).permissionRequests.participantPermissionsForRun(conversation, participant, undefined, appliedIds);
  assert.equal(projected.shell.enabled, true);
  assert.deepEqual(projected.shell.rules, [{ action: "allow", match: "prefix", pattern: "git diff" }]);
  assert.deepEqual(appliedIds, [approval.id]);

  consumeOneTimePermissionApprovals(conversation, participant, appliedIds);
  const consumedApproval = (conversation.metadata.pendingAppToolApprovals as ChatAppToolApproval[])[0];
  assert.equal(Boolean(consumedApproval?.consumedAt), true);

  const after = chatParts(service).permissionRequests.participantPermissionsForRun(conversation, participant);
  assert.equal(after.shell.enabled, false);
  assert.deepEqual(after.shell.rules, []);
});

test("in the run an approval resumed it in, a member asking again gets the answer it has, not a second card", async () => {
  const participant = chatParticipant("claude-code", { webAccess: false });
  const approval = permissionApproval(participant, { kind: "portable", permissions: ["webAccess"] }, {
    status: "approved",
    approvalScope: "once",
    resumeContext: { runId: "asking-run", triggerMessageId: "user-message" }
  });
  const conversation = chatConversation([participant], { pendingAppToolApprovals: [approval] });
  const { service, storage } = testService({ conversation });
  const actor = (runId: string) => ({
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 0,
    capabilities: ["permissions.request" as const],
    runId,
    triggerMessageId: "user-message",
    runPermissions: defaultChatAgentPermissions()
  });

  const resumed = actor("turn-permission-resume-approval-1");
  assert.equal((await service.requestPermissionChangeFromTool(resumed, { requestId: approval.id })).status, "approved");
  const again = await service.requestPermissionChangeFromTool(resumed, { kind: "portable", permissions: ["webAccess"] });
  assert.equal(again.status, "approved");
  assert.equal(again.requestId, approval.id);
  assert.equal((storage.current.metadata.pendingAppToolApprovals as ChatAppToolApproval[]).length, 1, "no second card");
  // Any other run still asks for itself.
  assert.equal((await service.requestPermissionChangeFromTool(actor("another-run"), { requestId: approval.id })).status, "not_found");
});

test("permission resume attaches resumed participant-request reply to the original batch", async () => {
  const runs: Array<{ participant: ParticipantConfig; options: any; prompt: string }> = [];
  const participant = chatParticipant("claude-code");
  const trigger = {
    id: "request-message",
    role: "system" as const,
    content: "@drew Run git diff.",
    createdAt: NOW,
    status: "done" as const,
    metadata: {
      threadId: "thread-1",
      participantRequest: {
        id: "batch-1",
        requesterParticipantId: "requester",
        requesterHandle: "codex",
        source: "mcp" as const,
        resumeRequester: false,
        status: "running" as const,
        depth: 2,
        requesterDepth: 1,
        chainRootId: "chain-root",
        createdAt: NOW,
        updatedAt: NOW,
        triggerMessageId: "user-message",
        items: [{
          targetParticipantId: participant.id,
          targetHandle: participant.handle,
          prompt: "Run git diff.",
          status: "running" as const,
          replyMessageId: "pending-reply",
          createdAt: NOW,
          updatedAt: NOW
        }]
      }
    }
  };
  const approval = permissionApproval(participant, {
    kind: "shellRules",
    rules: [{ action: "allow", match: "prefix", pattern: "git diff" }]
  }, {
    approvalScope: "once",
    status: "approved",
    resumeContext: {
      runId: "blocked-run",
      triggerMessageId: trigger.id,
      participantRequestBatchId: "batch-1"
    }
  });
  const conversation = chatConversation([participant], { pendingAppToolApprovals: [approval] });
  conversation.messages.push(trigger);
  const progressEvents: Array<{ runId: string; phase: string; message: string; agentProgress?: { state: string } }> = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant, prompt, _repoPath, _diffMode, _kind, _signal, options) => {
      runs.push({ participant: runParticipant, prompt, options });
      return {
        participant: runParticipant,
        ok: true,
        content: "Finished after approval.",
        durationMs: 1,
        sessionId: "session-1"
      };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  await chatParts(service).permissionRequests.autoResumePermissionApproval(conversation.id, approval.id, (progress: typeof progressEvents[number]) => {
    progressEvents.push(progress);
  });
  await waitFor(() => runs.length === 1 && storage.current.messages.some(
    (message: Conversation["messages"][number]) => message.content === "Finished after approval."
  ));

  assert.equal(runs.length, 1);
  // The request again (a new session: its access is in its instructions).
  assert.match(runs[0].prompt, /\n\n<<<REQUEST ([0-9a-f]{8}) from @codex>>>\nRun git diff\.\n<<<END REQUEST \1>>>(\n\n<<<APP \1>>>\nCompaction: when a big stage of this work is finished, (ask to )?compact your context before the next one, as your Compaction instructions say\.\n<<<END APP \1>>>)?$/, runs[0].prompt);
  assert.match(String(runs[0].options.role?.instructions), /allow prefix "git diff"/);
  assert.equal(runs[0].options.permissions.shell.enabled, true);
  assert.deepEqual(runs[0].options.permissions.shell.rules, [{ action: "allow", match: "prefix", pattern: "git diff" }]);
  const saved = storage.current;
  const batch = saved.messages.find((message: Conversation["messages"][number]) => message.id === trigger.id)?.metadata?.participantRequest;
  const reply = saved.messages.find((message: Conversation["messages"][number]) => message.content === "Finished after approval.");
  assert.equal(saved.metadata.running, false);
  assert.equal(saved.metadata.runId, undefined);
  assert.equal(batch?.status, "answered");
  assert.equal(batch?.items[0].status, "answered");
  assert.equal(batch?.items[0].replyMessageId, reply?.id);
  assert.equal(saved.metadata.pendingAppToolApprovals[0].consumedAt.length > 0, true);
  // A run of its own, never the blocked one: that turn is over on the User's server.
  assert.equal(progressEvents[0]?.runId, "turn-permission-resume-approval-1");
  assert.equal(progressEvents[0]?.phase, "initial");
  assert.equal(progressEvents.some((event) => event.agentProgress?.state === "running"), true);
  assert.equal(progressEvents.at(-1)?.phase, "done");
});

test("permission resume preserves target depth instead of requester depth", async () => {
  const requester = chatParticipant("codex-cli");
  const target = chatParticipant("claude-code");
  const trigger: ChatMessage = {
    id: "request-message",
    role: "system",
    content: "@target continue after permission.",
    createdAt: NOW,
    status: "done",
    metadata: {
      threadId: "thread-1",
      participantRequest: {
        id: "batch-1",
        requesterParticipantId: requester.id,
        requesterHandle: requester.handle,
        source: "mcp",
        resumeRequester: true,
        status: "running",
        depth: 2,
        requesterDepth: 1,
        chainRootId: "chain-root",
        createdAt: NOW,
        updatedAt: NOW,
        triggerMessageId: "user-message",
        items: [{
          targetParticipantId: target.id,
          targetHandle: target.handle,
          prompt: "Continue after permission.",
          status: "running",
          createdAt: NOW,
          updatedAt: NOW
        }]
      }
    }
  };
  const approval = permissionApproval(target, {
    kind: "portable",
    permissions: ["webAccess"]
  }, {
    approvalScope: "once",
    status: "approved",
    resumeContext: {
      runId: "blocked-run",
      triggerMessageId: trigger.id,
      participantRequestBatchId: "batch-1"
    }
  });
  const conversation = chatConversation([requester, target], { pendingAppToolApprovals: [approval] });
  conversation.messages.push(trigger);
  const { service, storage, tempRoot } = testService({ conversation });
  const serviceAny = service as any;
  const capturedRuns: Array<{ participantId: string; options: any }> = [];
  chatParts(serviceAny).chatHistory.ensureHistoryFiles = async () => tempRoot;
  chatParts(serviceAny).turnQueue.runParticipantTurnSerialized = async (
    _conversation: Conversation,
    participant: ChatParticipant,
    _trigger: ChatMessage,
    _runId: string,
    _signal: AbortSignal | undefined,
    _progress: unknown,
    options: any
  ) => {
    capturedRuns.push({ participantId: participant.id, options });
    return [{
      id: "target-reply",
      role: "participant",
      participantId: participant.id,
      participantLabel: `@${participant.handle}`,
      content: "Target resumed at preserved depth.",
      createdAt: NOW,
      status: "done",
      metadata: {
        threadId: "thread-1",
        parentMessageId: trigger.id,
        sourceMessageId: trigger.id
      }
    }];
  };

  await chatParts(serviceAny).permissionRequests.autoResumePermissionApproval(conversation.id, approval.id);
  await waitFor(() => storage.current.messages.some((message: ChatMessage) => message.id === "target-reply"));

  const targetRun = capturedRuns.find((run) => run.participantId === target.id);
  assert.equal(targetRun?.options.participantRequestDepth, 2);
  assert.equal(targetRun?.options.participantRequestBatchId, "batch-1");
  assert.equal(targetRun?.options.chainRootId, "chain-root");
  await waitFor(() => capturedRuns.some((run) => run.participantId === requester.id));
  const requesterRun = capturedRuns.find((run) => run.participantId === requester.id);
  assert.equal(requesterRun?.options.participantRequestDepth, 1);
  assert.equal(requesterRun?.options.participantRequestBatchId, "batch-1");
  assert.equal(requesterRun?.options.chainRootId, "chain-root");
});

test("permission resume clears running and emits terminal error when resumed participant fails", async () => {
  const participant = chatParticipant("claude-code");
  const approval = permissionApproval(participant, {
    kind: "shellRules",
    rules: [{ action: "allow", match: "prefix", pattern: "git diff" }]
  }, {
    approvalScope: "once",
    status: "approved",
    resumeContext: {
      runId: "blocked-run",
      triggerMessageId: "user-message"
    }
  });
  const conversation = chatConversation([participant], { pendingAppToolApprovals: [approval] });
  const progressEvents: Array<{ runId: string; phase: string; message: string }> = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async () => {
      throw new Error("resume exploded");
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  await chatParts(service).permissionRequests.autoResumePermissionApproval(
    conversation.id,
    approval.id,
    (progress: typeof progressEvents[number]) => {
      progressEvents.push(progress);
    }
  );
  await waitFor(() =>
    progressEvents.some((item) => item.phase === "error" && item.message === "resume exploded") &&
    storage.current.metadata.running === false
  );

  assert.equal(storage.current.metadata.running, false);
  assert.equal(storage.current.metadata.runId, undefined);
  assert.equal(progressEvents.some((item) => item.phase === "error" && item.message === "resume exploded"), true);
});

test("permission resume registers a cancellable chat run controller", async () => {
  const participant = chatParticipant("claude-code");
  const approval = permissionApproval(participant, {
    kind: "shellRules",
    rules: [{ action: "allow", match: "prefix", pattern: "git diff" }]
  }, {
    approvalScope: "once",
    status: "approved",
    resumeContext: {
      runId: "blocked-run",
      triggerMessageId: "user-message"
    }
  });
  const conversation = chatConversation([participant], { pendingAppToolApprovals: [approval] });
  let capturedSignal: AbortSignal | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant, _prompt, _repoPath, _diffMode, _kind, signal: AbortSignal | undefined, runOptions: any) => {
      capturedSignal = signal;
      runOptions.onOutput?.({
        kind: "text",
        text: "Partial reply.",
        cumulative: "Partial reply."
      });
      runOptions.onOutput?.({
        kind: "tool",
        text: "Running command\n",
        activityKind: "command",
        activityDetail: "npm test"
      });
      markStarted();
      await new Promise<void>((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        participant: runParticipant,
        ok: false,
        content: "",
        error: "cancelled",
        durationMs: 1,
        sessionId: "session-1"
      };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  const resume = chatParts(service).permissionRequests.autoResumePermissionApproval(conversation.id, approval.id);
  await started;
  await waitFor(() => {
    const pending = storage.current.messages.find((message: ChatMessage) =>
      message.role === "participant" &&
      message.participantId === participant.id &&
      message.status === "pending"
    );
    return Boolean(pending && storage.current.metadata.lastMessageByParticipant?.[participant.id]?.messageId === pending.id);
  });
  const pendingMessageId = storage.current.metadata.lastMessageByParticipant?.[participant.id]?.messageId;

  assert.equal(service.cancelRun("turn-permission-resume-approval-1"), true);
  await resume;
  await waitFor(() => storage.current.metadata.running === false);

  assert.equal(capturedSignal?.aborted, true);
  assert.equal(storage.current.metadata.running, false);
  assert.equal(storage.current.metadata.runId, undefined);
  const stoppedMessage = storage.current.messages.find((message: ChatMessage) => message.role === "participant");
  assert.equal(stoppedMessage?.status, "error");
  assert.equal(stoppedMessage?.metadata?.terminalReason, "user-stopped");
  assert.equal(stoppedMessage?.content, "@drew stopped by user.");
  assert.equal(
    stoppedMessage?.metadata?.processingTranscript?.content,
    "Partial reply.\n\n@drew stopped by user."
  );
  assert.equal(stoppedMessage?.metadata?.activityEvents?.[0]?.label, "Running command");
  assert.equal(stoppedMessage?.metadata?.activityEvents?.[0]?.detail, "npm test");
  assert.equal(stoppedMessage?.id, pendingMessageId);
  assert.equal(storage.current.metadata.lastMessageByParticipant?.[participant.id]?.messageId, stoppedMessage?.id);
});

test("a once-only approval applied by a running turn is not applied again by an overlapping one", () => {
  const { service } = testService();
  chatParts(service).activeRuns.chatRunControllers.set("run-a", new Set([new AbortController()]));
  chatParts(service).permissionRequests.oneTimeApprovalClaims.set("approval-1", "run-a");
  assert.equal(chatParts(service).permissionRequests.oneTimeApprovalClaimedByOtherRun("approval-1", "run-b"), true);
  assert.equal(chatParts(service).permissionRequests.oneTimeApprovalClaimedByOtherRun("approval-1", "run-a"), false);
  chatParts(service).activeRuns.chatRunControllers.delete("run-a");
  assert.equal(chatParts(service).permissionRequests.oneTimeApprovalClaimedByOtherRun("approval-1", "run-b"), false, "a finished run's claim lapses");
});

test("approved permission resume ignores duplicate concurrent resume attempts", async () => {
  const participant = chatParticipant("claude-code");
  const approval = permissionApproval(participant, {
    kind: "portable",
    permissions: ["webAccess"]
  }, {
    approvalScope: "once",
    status: "approved",
    resumeContext: {
      runId: "auto-resume-run",
      triggerMessageId: "user-message"
    }
  });
  const conversation = chatConversation([participant], { pendingAppToolApprovals: [approval] });
  let runCount = 0;
  let releaseRun!: () => void;
  const runCanFinish = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant) => {
      runCount += 1;
      await runCanFinish;
      return {
        participant: runParticipant,
        ok: true,
        content: "Finished auto-applied resume.",
        durationMs: 1,
        sessionId: "session-1"
      };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  const first = chatParts(service).permissionRequests.autoResumePermissionApproval(conversation.id, approval.id);
  const second = chatParts(service).permissionRequests.autoResumePermissionApproval(conversation.id, approval.id);
  await waitFor(() => runCount === 1);
  await Promise.all([first, second]);
  releaseRun();
  await waitFor(() => storage.current.metadata.running === false);

  assert.equal(runCount, 1);
  assert.equal(storage.current.metadata.running, false);
  assert.equal(storage.current.metadata.runId, undefined);
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].consumedAt.length > 0, true);
});

for (const kind of ["codex-cli", "claude-code"] as const) {
test(`permission resume waits behind an in-flight same-participant ${kind === "codex-cli" ? "turn" : "exclusive operation"} (${kind})`, async () => {
  const participant = chatParticipant(kind);
  const approval = permissionApproval(participant, {
    kind: "portable",
    permissions: ["webAccess"]
  }, {
    approvalScope: "once",
    status: "approved",
    resumeContext: {
      runId: "auto-resume-run",
      triggerMessageId: "user-message"
    }
  });
  const conversation = chatConversation([participant], { pendingAppToolApprovals: [approval] });
  let runStarted = false;
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant) => {
      runStarted = true;
      return {
        participant: runParticipant,
        ok: true,
        content: "resumed",
        durationMs: 1,
        sessionId: "session-1"
      };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  // Simulate an in-flight turn for the same participant holding the per-participant
  // serialization queue; the resume must serialize behind it. A Claude Code
  // member takes messages while it works (as its CLI does), so for it only an
  // exclusive operation such as compaction holds the resume back.
  const queueKey = `${conversation.id}:${participant.id}`;
  let releaseInFlight!: () => void;
  const inFlight = new Promise<void>((resolve) => {
    releaseInFlight = resolve;
  });
  chatParts(service).turnQueue.participantTurnQueues.set(queueKey, inFlight);
  if (kind === "claude-code") {
    chatParts(service).turnQueue.participantExclusiveTurnQueues.set(queueKey, inFlight);
  }

  const resume = chatParts(service).permissionRequests.autoResumePermissionApproval(conversation.id, approval.id);
  // Allow the resume to reach the queue wait; it must not start the run while blocked.
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(runStarted, false);

  releaseInFlight();
  await resume;
  await waitFor(() => runStarted && storage.current.metadata.running === false);

  assert.equal(runStarted, true);
  assert.equal(storage.current.metadata.running, false);
  assert.equal(storage.current.metadata.runId, undefined);
});
}

test("approved permission without resumeContext does not auto-run", async () => {
  const runs: ParticipantConfig[] = [];
  const participant = chatParticipant("claude-code");
  const approval = permissionApproval(participant, {
    kind: "portable",
    permissions: ["webAccess"]
  }, {
    approvalScope: "once",
    status: "approved"
  });
  const conversation = chatConversation([participant], { pendingAppToolApprovals: [approval] });
  const { service } = testService({
    conversation,
    run: async (runParticipant) => {
      runs.push(runParticipant);
      return {
        participant: runParticipant,
        ok: true,
        content: "Unexpected run.",
        durationMs: 1
      };
    }
  });

  await chatParts(service).permissionRequests.autoResumePermissionApproval(conversation.id, approval.id);

  assert.equal(runs.length, 0);
});

test("tool provenance suppresses final restatements across permission resume but permits a new tool post", async () => {
  const requester = chatParticipant("codex-cli", { requestParticipants: "ask" });
  const target = chatParticipant("claude-code");
  const conversation = chatConversation([requester, target]);
  const { service, storage } = testService({ conversation });
  const debugEntries: Array<{ event: string; payload: Record<string, unknown> }> = [];
  chatDependencies(service).debugLogs.write = async (event: string, payload: Record<string, unknown>) => {
    debugEntries.push({ event, payload });
  };
  const runId = "permission-resume-run";

  await service.sendChatMessageFromTool({
    ...participantRequestActor(requester),
    runId,
    turnSegmentId: "before-permission"
  }, { content: "@drew do X." });
  completeParticipantRequest(inferredRequestMessages(storage.current)[0]);

  const resumedFinal = participantReplyMessage(requester, "resumed-final", "I asked @drew to do X.");
  resumedFinal.metadata = {
    ...resumedFinal.metadata,
    runId,
    turnSegmentId: "after-permission",
    participantRequestDepth: 0
  };
  await chatParts(service).pendingReplies.appendParticipantTurnMessages(storage.current, requester, [resumedFinal]);
  assert.equal(inferredRequestMessages(storage.current).length, 1);
  assert.equal(
    debugEntries.find((entry) => entry.event === "chat.participant-request.inferred-skipped-existing")?.payload.decidingScope,
    "final-source-tool-origin-run"
  );

  await service.sendChatMessageFromTool({
    ...participantRequestActor(requester),
    runId,
    turnSegmentId: "after-permission"
  }, { content: "@drew now do Y." });
  assert.equal(inferredRequestMessages(storage.current).length, 2);
});

test("pure final-output inference remains unchanged across permission resume", async () => {
  const requester = chatParticipant("codex-cli", { requestParticipants: "ask" });
  const target = chatParticipant("claude-code");
  const conversation = chatConversation([requester, target]);
  const { service } = testService({ conversation });
  const runId = "pure-final-resume-run";
  const first = participantReplyMessage(requester, "pure-final-one", "@drew do X.");
  first.metadata = { ...first.metadata, runId, turnSegmentId: "pure-final-segment-one" };
  await chatParts(service).pendingReplies.appendParticipantTurnMessages(conversation, requester, [first]);
  completeParticipantRequest(inferredRequestMessages(conversation)[0]);

  const second = participantReplyMessage(requester, "pure-final-two", "@drew now do Y.");
  second.metadata = { ...second.metadata, runId, turnSegmentId: "pure-final-segment-two" };
  await chatParts(service).pendingReplies.appendParticipantTurnMessages(conversation, requester, [second]);

  assert.equal(inferredRequestMessages(conversation).length, 2);
});
