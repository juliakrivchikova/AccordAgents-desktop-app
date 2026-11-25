import { NativeProcessUnavailableError } from "./nativeProcess";
import assert from "node:assert/strict";
import test from "node:test";
import { ChatService } from "./chat";
import { chatParts } from "./chat/test/chatParts";
import type { HubTurn } from "../../shared/hubOps";
import type { ChatAppToolApproval, ChatMessage, ParticipantConfig } from "../../shared/types";
import { activeRunIdsForConversation } from "../../shared/chatActiveRuns";
import {
  chatConversation, chatParticipant, clone, fakeServerLink, NOW, participantRequestActor, pendingParticipantMessage, testService,
  waitFor
} from "./chat/test/permissionFixtures";

test("conversation-scoped cancellation recognizes a live run before its state is persisted", () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const { service } = testService({ conversation });
  const controller = new AbortController();
  chatParts(service).activeRuns.registerTargetRun("live-mobile-run", controller, {
    conversationId: conversation.id,
    participantId: participant.id,
    participantHandle: participant.handle
  });

  assert.equal(service.hasActiveRunForConversation(conversation.id, "live-mobile-run"), true);
  assert.equal(service.hasActiveRunForConversation("another-conversation", "live-mobile-run"), false);
  assert.equal(service.cancelRun("live-mobile-run"), true);
  assert.equal(controller.signal.aborted, true);
});

test("running participant cancellation preserves output in one stopped bubble", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant, _prompt, _repoPath, _diffMode, _kind, signal: AbortSignal | undefined, runOptions: any) => {
      runOptions.onOutput?.({
        kind: "text",
        text: "Work in progress.",
        cumulative: "Work in progress."
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
        content: "provider cancellation notice",
        error: "cancelled",
        durationMs: 1
      };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  await service.sendMessage({
    conversationId: conversation.id,
    runId: "send-run",
    content: `@${participant.handle} start work`
  });
  await started;
  const pending = storage.current.messages.find((message: ChatMessage) =>
    message.role === "participant" && message.status === "pending"
  );
  assert.ok(pending?.metadata?.runId);

  assert.equal(service.cancelRun(pending.metadata.runId), true);
  await waitFor(() => storage.current.messages.some((message: ChatMessage) =>
    message.id === pending.id && message.metadata?.terminalReason === "user-stopped"
  ));

  const stopped = storage.current.messages.find((message: ChatMessage) => message.id === pending.id);
  assert.equal(stopped?.content, `@${participant.handle} stopped by user.`);
  assert.equal(
    stopped?.metadata?.processingTranscript?.content,
    `Work in progress.\n\n@${participant.handle} stopped by user.`
  );
  assert.equal(storage.current.messages.some((message: ChatMessage) =>
    message.role === "system" && message.content === `@${participant.handle} stopped by user.`
  ), false);
});

test("Stop cannot claim success when native process supervision was lost", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (_participant, _prompt, _path, _diff, _kind, signal: AbortSignal | undefined) => {
      started();
      await new Promise<void>((resolve) => { if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true }); });
      throw new NativeProcessUnavailableError("The supervisor disappeared without a shutdown receipt.");
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  await service.sendMessage({ conversationId: conversation.id, runId: "unconfirmed-native-stop", content: `@${participant.handle} work` });
  await ready;
  const pending = storage.current.messages.find((message: ChatMessage) => message.role === "participant" && message.status === "pending");
  assert.ok(pending?.metadata?.runId);
  service.cancelRun(pending.metadata.runId);
  await waitFor(() => storage.current.messages.some((message: ChatMessage) => message.id === pending.id && message.metadata?.terminalReason === "stop-unconfirmed"));
  assert.equal(storage.current.messages.some((message: ChatMessage) => message.content.includes("stopped by user")), false);
});

test("running participant cancellation preserves a successful reply returned after Stop", async () => {
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant]);
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant, _prompt, _repoPath, _diffMode, _kind, signal: AbortSignal | undefined, runOptions: any) => {
      runOptions.onOutput?.({ kind: "text", text: "Reply already delivered.", cumulative: "Reply already delivered." });
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
        ok: true,
        content: "Reply already delivered.",
        durationMs: 1
      };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  await service.sendMessage({
    conversationId: conversation.id,
    runId: "send-run-successful-stop",
    content: `@${participant.handle} start background work`
  });
  await started;
  const pending = storage.current.messages.find((message: ChatMessage) =>
    message.role === "participant" && message.status === "pending"
  );
  assert.ok(pending?.metadata?.runId);

  assert.equal(service.cancelRun(pending.metadata.runId), true);
  await waitFor(() => storage.current.messages.some((message: ChatMessage) =>
    message.id === pending.id && message.metadata?.terminalReason === "user-stopped"
  ));

  const stopped = storage.current.messages.find((message: ChatMessage) => message.id === pending.id);
  assert.equal(stopped?.status, "error");
  assert.equal(stopped?.metadata?.terminalReason, "user-stopped");
  assert.equal(stopped?.content, "Reply already delivered.");
});

test("stop from a non-owner instance records a cancel request the owning instance honors", async () => {
  const participant = chatParticipant("gemini-cli");
  const runId = "cross-instance-run";
  const ownerHeartbeat = new Date().toISOString();
  const conversation = chatConversation([participant], {
    running: true,
    runId,
    activeRunIds: [runId],
    activeRunOwnersByRunId: {
      [runId]: {
        processId: process.ppid,
        instanceId: "owner-instance",
        startedAt: ownerHeartbeat,
        updatedAt: ownerHeartbeat
      }
    }
  });
  const { service, storage } = testService({ conversation });

  // This instance has no controller for the run and the owner heartbeat is
  // fresh: Stop must enqueue a cancel request instead of silently no-oping or
  // sweeping the owner's live run state.
  assert.equal(service.cancelRun(runId), true);
  await waitFor(() => storage.cancelRequests.has(runId));
  assert.deepEqual(storage.current.metadata.activeRunIds, [runId]);
  assert.equal(storage.current.metadata.running, true);

  // The owning instance shares the same storage and holds the live controller.
  const ownerService = new ChatService(
    storage as never,
    {} as never,
    {} as never,
    { write: async () => undefined } as never
  );
  const controller = new AbortController();
  (chatParts(ownerService).activeRuns as never as {
    registerTargetRun(runId: string, controller: AbortController, meta: { conversationId: string; participantId: string; participantHandle: string }): void;
  }).registerTargetRun(runId, controller, {
    conversationId: conversation.id,
    participantId: participant.id,
    participantHandle: participant.handle
  });
  (chatParts(ownerService).activeRuns as never as {
    rememberActiveChatRun(conversationId: string, runId: string): void;
  }).rememberActiveChatRun(conversation.id, runId);

  await (chatParts(ownerService).runOwners as never as {
    consumeCrossInstanceCancelRequests(): Promise<void>;
  }).consumeCrossInstanceCancelRequests();

  assert.equal(controller.signal.aborted, true);
  assert.equal(storage.cancelRequests.size, 0);
});

test("cross-instance cancel requests stay queued until the run registers a controller", async () => {
  const participant = chatParticipant("gemini-cli");
  const runId = "early-active-run";
  const conversation = chatConversation([participant], {
    running: true,
    runId,
    activeRunIds: [runId]
  });
  const { storage } = testService({ conversation });
  storage.cancelRequests.set(runId, conversation.id);

  const ownerService = new ChatService(
    storage as never,
    {} as never,
    {} as never,
    { write: async () => undefined } as never
  );
  const ownerInternals = chatParts(ownerService);

  // beginChatRun marks the run active before the turn registers its abort
  // controller; a heartbeat tick in that window must leave the request queued
  // instead of consuming it with nothing to abort.
  ownerInternals.activeRuns.rememberActiveChatRun(conversation.id, runId);
  await ownerInternals.runOwners.consumeCrossInstanceCancelRequests();
  assert.equal(storage.cancelRequests.has(runId), true);
  assert.deepEqual(storage.current.metadata.activeRunIds, [runId]);
  assert.equal(storage.current.metadata.running, true);

  const controller = new AbortController();
  ownerInternals.activeRuns.registerTargetRun(runId, controller, {
    conversationId: conversation.id,
    participantId: participant.id,
    participantHandle: participant.handle
  });
  await ownerInternals.runOwners.consumeCrossInstanceCancelRequests();
  assert.equal(controller.signal.aborted, true);
  assert.equal(storage.cancelRequests.size, 0);
});

test("cancelRun force clears stale local and orphaned active run ids", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant], {
    running: true,
    runId: "local-run",
    activeRunIds: ["local-run", "orphan-run"],
    activeRunOwnersByRunId: {
      "local-run": {
        processId: process.pid,
        instanceId: "dead-instance",
        startedAt: NOW,
        updatedAt: NOW
      }
    },
    activeRunParticipantIdsByRunId: {
      "local-run": participant.id,
      "orphan-run": participant.id
    }
  });
  conversation.messages.push(pendingParticipantMessage(participant, "pending-local", "local-run"));
  conversation.messages.push(pendingParticipantMessage(participant, "pending-orphan", "orphan-run"));
  const { service, storage } = testService({ conversation });

  assert.equal(service.cancelRun("local-run"), true);
  assert.equal(service.cancelRun("orphan-run"), true);

  await waitFor(() => storage.current.metadata.activeRunIds === undefined);
  assert.equal(storage.current.metadata.running, false);
  assert.equal(storage.current.metadata.runId, undefined);
  assert.equal(storage.current.metadata.activeRunOwnersByRunId, undefined);
  assert.equal(storage.current.metadata.activeRunParticipantIdsByRunId, undefined);
  for (const messageId of ["pending-local", "pending-orphan"]) {
    const message = storage.current.messages.find((item: ChatMessage) => item.id === messageId);
    assert.equal(message?.status, "error");
    assert.equal(message?.metadata?.terminalReason, "user-stopped");
  }
});

test("cancelling same participant queued response removes bubble before earlier turn releases", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  let runCount = 0;
  let releaseFirst!: () => void;
  const firstCanFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let releaseThird!: () => void;
  const thirdCanFinish = new Promise<void>((resolve) => {
    releaseThird = resolve;
  });
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant) => {
      runCount += 1;
      const runNumber = runCount;
      if (runNumber === 1) {
        await firstCanFinish;
      } else if (runNumber === 2) {
        await thirdCanFinish;
      }
      return {
        participant: runParticipant,
        ok: true,
        content: `reply ${runNumber}`,
        durationMs: 1,
        sessionId: `session-${runNumber}`
      };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  await service.sendMessage({
    conversationId: conversation.id,
    runId: "first-send",
    content: "@codex first"
  });
  await waitFor(() => runCount === 1);

  await service.sendMessage({
    conversationId: conversation.id,
    runId: "second-send",
    content: "@codex second"
  });
  await waitFor(() => storage.current.messages.some(
    (message: ChatMessage) =>
      message.role === "participant" &&
      message.status === "pending" &&
      message.metadata?.queuedBehind?.handle === participant.handle
  ));
  const queuedMessage = storage.current.messages.find(
    (message: ChatMessage) =>
      message.role === "participant" &&
      message.status === "pending" &&
      message.metadata?.queuedBehind?.handle === participant.handle
  );
  const queuedRunId = queuedMessage?.metadata?.runId;
  assert.ok(queuedMessage);
  assert.ok(queuedRunId);

  assert.equal(service.cancelRun(queuedRunId), true);
  await waitFor(() => {
    const activeRunIds = storage.current.metadata.activeRunIds ?? [];
    return !storage.current.messages.some((message: ChatMessage) => message.id === queuedMessage.id) &&
      storage.current.messages.some((message: ChatMessage) =>
        message.role === "system" &&
        message.content === `@${participant.handle} stopped by user.`
      ) &&
      activeRunIds.length === 1 &&
      !activeRunIds.includes(queuedRunId) &&
      runCount === 1;
  });
  assert.notEqual(
    storage.current.metadata.lastMessageByParticipant?.[participant.id]?.messageId,
    queuedMessage.id
  );
  assert.equal(
    ((storage.current.metadata.removedChatMessageIds as string[] | undefined) ?? []).includes(queuedMessage.id),
    true
  );

  storage.current.messages.push(clone(queuedMessage));
  await chatParts(service).store.refreshStoredChatState(storage.current);
  assert.equal(storage.current.messages.some((message: ChatMessage) => message.id === queuedMessage.id), false);
  assert.equal(
    storage.current.messages.some((message: ChatMessage) => message.metadata?.queuedBehind?.handle === participant.handle),
    false
  );

  await service.sendMessage({
    conversationId: conversation.id,
    runId: "third-send",
    content: "@codex third"
  });
  await waitFor(() => storage.current.messages.some(
    (message: ChatMessage) =>
      message.role === "participant" &&
      message.status === "pending" &&
      message.metadata?.queuedBehind?.handle === participant.handle
  ));
  const thirdQueuedMessage = storage.current.messages.find(
    (message: ChatMessage) =>
      message.role === "participant" &&
      message.status === "pending" &&
      message.metadata?.queuedBehind?.handle === participant.handle
  );
  assert.ok(thirdQueuedMessage);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(runCount, 1);

  releaseFirst();
  await waitFor(() => {
    const promoted = storage.current.messages.find((message: ChatMessage) => message.id === thirdQueuedMessage.id);
    return runCount === 2 &&
      promoted?.status === "pending" &&
      promoted.metadata?.queuedBehind === undefined;
  });

  releaseThird();
  await waitFor(() =>
    storage.current.messages.some((message: ChatMessage) =>
      message.id === thirdQueuedMessage.id &&
      message.content === "reply 2" &&
      message.status === "done"
    ) &&
    storage.current.metadata.running === false
  );
  assert.equal(storage.current.messages.some((message: ChatMessage) => message.id === queuedMessage.id), false);
});

test("a late result does not resurrect a non-recovery error (user-stopped) message", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  conversation.messages.push(pendingParticipantMessage(participant, "stopped", "stopped-run", {
    status: "error",
    content: "Stopped by user.",
    metadata: { runId: "stopped-run" }
  }));
  const { service } = testService({ conversation });

  await chatParts(service).pendingReplies.appendParticipantTurnMessages(conversation, participant, [
    pendingParticipantMessage(participant, "stopped", "stopped-run", {
      status: "done",
      content: "Late answer that should be ignored.",
      metadata: { runId: "stopped-run" }
    })
  ]);

  const after = conversation.messages.find((message: any) => message.id === "stopped")!;
  assert.equal(after.status, "error");
  assert.equal(after.content, "Stopped by user.");
});

test("a member request returns at once and every target runs on its own, so Stop on the requester or one target leaves the rest running", async () => {
  const requester = chatParticipant("codex-cli", { requestParticipants: "allow" });
  const first = chatParticipant("claude-code");
  const second = chatParticipant("gemini-cli");
  const conversation = chatConversation([requester, first, second]);
  const release = new Map<string, () => void>();
  const aborted = new Set<string>();
  const runs: string[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (participant: any, _prompt: unknown, _path: unknown, _unused: unknown, _mode: unknown, signal?: AbortSignal) => {
      runs.push(participant.id);
      if (participant.id !== requester.id) {
        await new Promise<void>((resolve) => {
          release.set(participant.id, resolve);
          signal?.addEventListener("abort", () => {
            aborted.add(participant.id);
            resolve();
          }, { once: true });
        });
      }
      return { participant, ok: true, content: `${participant.id} done.`, durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  const requesterTurn = new AbortController();
  chatParts(service).activeRuns.registerRunController("requester-run", requesterTurn);

  const startedAt = Date.now();
  const result = await service.requestParticipantsFromTool({ ...participantRequestActor(requester), runId: "requester-run" }, {
    requests: [{ target: first.handle, prompt: "Review A." }, { target: second.handle, prompt: "Review B." }],
    timeoutMs: 5000
  });
  assert.ok(Date.now() - startedAt < 1000, "a resumed request does not hold the requester for its wait");
  assert.equal(result.status, "running", "the call returns while both targets are still working");
  await waitFor(() => release.size === 2);
  assert.ok(service.liveRunIds().some((id) => id.startsWith("participant-request:")),
    "a request still collecting answers counts as live work for restart and idle checks");

  service.cancelRun("requester-run");
  assert.equal(requesterTurn.signal.aborted, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(aborted.size, 0, "stopping the requester does not stop the members it asked");

  const runIdOf = (participantId: string): string | undefined => storage.current.messages
    .find((message: ChatMessage) => message.participantId === participantId && message.status === "pending")?.metadata?.runId;
  const firstRunId = runIdOf(first.id);
  const secondRunId = runIdOf(second.id);
  assert.ok(firstRunId && secondRunId, "each target shows its own running reply");
  assert.notEqual(firstRunId, secondRunId);
  assert.notEqual(firstRunId, "requester-run");
  service.cancelRun(firstRunId!);
  await waitFor(() => aborted.has(first.id));
  assert.equal(aborted.has(second.id), false, "stopping one member leaves the other running");

  release.get(second.id)!();
  const batchOf = () => storage.current.messages
    .find((message: ChatMessage) => message.metadata?.participantRequest)?.metadata?.participantRequest;
  await waitFor(() => batchOf()?.status === "completed" && batchOf()?.autoResumeMessageId !== undefined, 2000);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(runs.filter((id) => id === requester.id), [requester.id], "the requester gets exactly one fresh turn with the replies");
  const items = batchOf()?.items ?? [];
  assert.equal(items.find((item: any) => item.targetParticipantId === first.id)?.status, "interrupted",
    "a member the User stopped is recorded as interrupted, not failed");
  assert.equal(items.find((item: any) => item.targetParticipantId === second.id)?.status, "answered");
});

test("Stop all reaches a requested member that is still queued behind its own turn", async () => {
  const requester = chatParticipant("gemini-cli", { requestParticipants: "allow" });
  const target = chatParticipant("codex-cli");
  const conversation = chatConversation([requester, target]);
  const runs: string[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (participant: any) => {
      runs.push(participant.id);
      return { participant, ok: true, content: "done.", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  // The target is busy with a turn of its own, so the request waits its turn.
  let releaseOwnTurn!: () => void;
  const ownTurn = new Promise<void>((resolve) => {
    releaseOwnTurn = resolve;
  });
  chatParts(service).turnQueue.participantTurnQueues.set(`${conversation.id}:${target.id}`, ownTurn);

  const result = await service.requestParticipantsFromTool(participantRequestActor(requester), {
    requests: [{ target: target.handle, prompt: "Review." }]
  });
  assert.equal(result.status, "running");
  await waitFor(() => activeRunIdsForConversation(storage.current).length > 0);
  for (const runId of activeRunIdsForConversation(storage.current)) {
    service.cancelRun(runId);
  }
  releaseOwnTurn();
  const itemStatus = () => storage.current.messages
    .find((message: ChatMessage) => message.metadata?.participantRequest)?.metadata?.participantRequest?.items[0]?.status;
  await waitFor(() => itemStatus() !== "running", 2000);
  assert.equal(runs.includes(target.id), false, "the queued member never starts after Stop all");
  assert.equal(itemStatus(), "interrupted");
});

test("run termination preserves Codex Stop and provider-exit lifecycle states", () => {
  const participant = chatParticipant("codex-cli");
  const approval = {
    id: "codex-run-terminal",
    conversationId: "conversation",
    requesterParticipantId: participant.id,
    requesterHandle: participant.handle,
    requesterRoleConfigId: participant.roleConfigId,
    toolName: "codex_auto_review_approval",
    capability: "permissions.request",
    status: "pending",
    request: {
      kind: "codexApproval",
      method: "item/fileChange/requestApproval",
      requestId: "request-1",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      action: "fileChange",
      options: [
        { id: "accept", label: "Allow once", outcome: "approve" },
        { id: "cancel", label: "Cancel", outcome: "cancel" }
      ]
    },
    summary: "Codex wants to apply protected file changes.",
    createdAt: NOW,
    updatedAt: NOW,
    resumeContext: { runId: "run-1", triggerMessageId: "user-message" }
  } satisfies ChatAppToolApproval;
  const stopped = chatConversation([participant], { pendingAppToolApprovals: [approval] });
  const failed = chatConversation([participant], { pendingAppToolApprovals: [{ ...approval, id: "codex-provider-exit" }] });
  const service = testService().service as any;

  assert.equal(chatParts(service).approvalDecisions.markPendingAppToolApprovalsForRunTerminal(stopped, "run-1", "Stopped by user."), true);
  assert.equal((stopped.metadata.pendingAppToolApprovals as ChatAppToolApproval[])[0].status, "cancelled");
  assert.equal(chatParts(service).approvalDecisions.markPendingAppToolApprovalsForRunTerminal(failed, "run-1", "Codex app-server process exited."), true);
  assert.equal((failed.metadata.pendingAppToolApprovals as ChatAppToolApproval[])[0].status, "expired");
});

test("member ownership: Stop cannot sweep another host's pending run", async () => {
  for (const machineRuntime of [false, true]) {
    const participant = { ...chatParticipant("codex-cli"), homeMachineId: machineRuntime ? undefined : "machine-1" };
    const conversation = chatConversation([participant], { activeRunIds: ["foreign-run"], running: true });
    conversation.messages.push(pendingParticipantMessage(participant, "foreign-pending", "foreign-run"));
    const { service, storage } = testService({ conversation });
    if (machineRuntime) service.setHostMachineId("machine-1");
    assert.equal(await chatParts(service).runCancel.cancelStoredRun("foreign-run"), false);
    assert.equal(storage.current.messages.find((m: ChatMessage) => m.id === "foreign-pending").status, "pending");
    assert.equal(storage.current.metadata.running, true);
  }
});

test("a turn this device took and left behind (it restarted) is closed as interrupted, never as stopped, with a Stop it never confirmed said so", async () => {
  const participant = { ...chatParticipant("codex-cli"), homeMachineId: "machine-1" };
  const conversation = chatConversation([participant]);
  conversation.messages.push(
    pendingParticipantMessage(participant, "left-running", "turn-left-running", { content: "Half an answer", metadata: { runId: "turn-left-running", sourceMessageId: "user-message" } }),
    pendingParticipantMessage(participant, "left-stopping", "turn-left-stopping", { content: "", metadata: { runId: "turn-left-stopping", sourceMessageId: "user-message" } }));
  const { service, storage } = testService({ conversation });
  service.setHostMachineId("machine-1");
  const link = fakeServerLink("machine-device");
  const claimed = (runId: string, stop: boolean): HubTurn => ({ runId, conversationId: conversation.id, messageId: "user-message", participantId: participant.id,
    state: "claimed", executorDeviceId: "machine-device", claimedAt: NOW, ...(stop ? { stopRequestedAt: NOW } : {}) });
  link.waitingTurns = async () => ({ requested: [], claimed: [claimed("turn-left-running", false), claimed("turn-left-stopping", true)] });
  service.setServerLink(link);
  await service.resumeServerTurns();
  await waitFor(() => link.ops.filter((op) => op.kind === "turn.finish").length === 2);
  assert.deepEqual(link.ops.filter((op) => op.kind === "turn.finish").map((op) => [(op as { runId: string }).runId, (op as { outcome: string }).outcome]),
    [["turn-left-running", "interrupted"], ["turn-left-stopping", "interrupted"]], "ended for whoever waits, never as stopped");
  const running = storage.current.messages.find((message: ChatMessage) => message.id === "left-running");
  assert.equal(running.status, "error");
  assert.equal(running.content, "Half an answer", "what it had written stays");
  const stopping = storage.current.messages.find((message: ChatMessage) => message.id === "left-stopping");
  assert.equal(stopping.metadata.terminalReason, "stop-unconfirmed");
  assert.match(stopping.content, /restarted before confirming the stop/);
  // Asked again (the link came back): closed once.
  await service.resumeServerTurns();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(link.ops.filter((op) => op.kind === "turn.finish").length, 2);
});

test("a member's turn whose process closes as the User quits ends stopped and interrupted, never as the member's failure", async () => {
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant]);
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant) => ({ participant: runParticipant, ok: false, content: `${runParticipant.label} stopped before it returned a response.`,
      error: "claude warm process exited with code 143", durationMs: 1 })
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  const warnings: string[] = [];
  service.beginQuit();
  await chatParts(service).turnQueue.runParticipantTurnSerialized(storage.current, participant, storage.current.messages[0], "run-quit", undefined, undefined, { warnings })
    .catch(() => undefined);
  const reply = storage.current.messages.filter((message: ChatMessage) => message.role === "participant").at(-1)!;
  assert.equal(reply.status, "error");
  assert.equal(reply.content, "Interrupted before completion.");
  assert.equal(reply.metadata?.terminalReason, "user-stopped");
  assert.equal(warnings.some((warning) => warning.includes("exited")), false, "a quit is not the member's failure");
});

test("what a member wrote before the User's quit stays in its reply, stopped", async () => {
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant]);
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant: ParticipantConfig, _prompt: string, _path: string, _unused: unknown, _kind: string, _signal: AbortSignal,
      options: { onOutput?: (event: unknown) => void }) => {
      options.onOutput?.({ kind: "text", text: "Half of the essay.", cumulative: "Half of the essay." });
      return { participant: runParticipant, ok: false, content: `${runParticipant.label} stopped before it returned a response.`,
        error: "claude warm process exited with code 143", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  service.beginQuit();
  await chatParts(service).turnQueue.runParticipantTurnSerialized(storage.current, participant, storage.current.messages[0], "run-quit-partial", undefined, undefined, { warnings: [] })
    .catch(() => undefined);
  const reply = storage.current.messages.filter((message: ChatMessage) => message.role === "participant").at(-1)!;
  assert.equal(reply.content, "Half of the essay.");
  assert.equal(reply.status, "error");
  assert.equal(reply.metadata?.terminalReason, "user-stopped");
});

test("a turn the quit closed that ends after the quit was cancelled is still stopped, keeping its text", async () => {
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant]);
  let service: ChatService;
  const harness = testService({
    conversation,
    run: async (runParticipant: ParticipantConfig, _prompt: string, _path: string, _unused: unknown, _kind: string, _signal: AbortSignal,
      options: { onOutput?: (event: unknown) => void }) => {
      options.onOutput?.({ kind: "text", text: "Half of the essay.", cumulative: "Half of the essay." });
      // The quit closed the process; the window kept its page meanwhile, so
      // the quit did not happen before this end arrives.
      service.endQuit();
      return { participant: runParticipant, ok: false, content: `${runParticipant.label} stopped before it returned a response.`,
        error: "claude warm process exited with code 143", durationMs: 1 };
    }
  });
  service = harness.service;
  const { storage, tempRoot } = harness;
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  chatParts(service).activeRuns.registerTargetRun("run-quit-cancelled", new AbortController(), {
    conversationId: conversation.id, participantId: participant.id, participantHandle: participant.handle
  });
  service.beginQuit();
  const warnings: string[] = [];
  await chatParts(service).turnQueue.runParticipantTurnSerialized(storage.current, participant, storage.current.messages[0], "run-quit-cancelled", undefined, undefined, { warnings })
    .catch(() => undefined);
  const reply = storage.current.messages.filter((message: ChatMessage) => message.role === "participant").at(-1)!;
  assert.equal(reply.content, "Half of the essay.");
  assert.equal(reply.metadata?.terminalReason, "user-stopped");
  assert.equal(warnings.some((warning) => /stopped before it returned/.test(warning)), false, "no failure of the member");
  // A turn that starts after the cancel and fails the same way is a failure.
  assert.equal(chatParts(service).appQuit.endsByQuit("a-later-run"), false);
});

test("a cancelled quit drops the members' app tool connections, so the next turn gets one on the restarted server", () => {
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant]);
  const { service } = testService({ conversation });
  const key = `${conversation.id}:${participant.id}`;
  chatParts(service).appMcpGrants.appMcpTokens.set(key, "token-before-quit");
  chatParts(service).appMcpGrants.appMcpConnections.set(key, { url: "http://127.0.0.1:1111/mcp", token: "token-before-quit" });
  service.beginQuit();
  service.endQuit();
  assert.equal(chatParts(service).appMcpGrants.appMcpTokens.has(key), false);
  assert.equal(chatParts(service).appMcpGrants.appMcpConnections.has(key), false);
});
