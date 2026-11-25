import assert from "node:assert/strict";
import test from "node:test";
import { chatParts } from "./chat/test/chatParts";
import { markStoredParticipantRunStoppedByUser } from "./chat/runs/runOwnerRecords";
import type { ChatMessage, Conversation } from "../../shared/types";
import {
  chatConversation, chatParticipant, clone, memberIds, memberRemovalFixture, NOW, participantRequestActor,
  pendingParticipantMessage, removalTrio, testService, waitFor
} from "./chat/test/permissionFixtures";

test("run owner heartbeat timer clears when final active run is forgotten", () => {
  const service = testService().service as any;

  chatParts(service).activeRuns.rememberActiveChatRun("conversation-1", "run-1");
  assert.ok(chatParts(service).runOwners.runOwnerHeartbeatTimer);

  chatParts(service).activeRuns.forgetActiveChatRun("conversation-1", "run-1");
  assert.equal(chatParts(service).runOwners.runOwnerHeartbeatTimer, undefined);
});

test("stored participant stop preserves nonblank pending and diagnostic content", () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  conversation.messages.push({
    id: "pending-message",
    role: "participant",
    participantId: participant.id,
    participantLabel: `@${participant.handle}`,
    content: "Partial remote content.",
    createdAt: NOW,
    status: "pending",
    metadata: { runId: "stored-run" }
  }, {
    id: "error-message",
    role: "participant",
    participantId: participant.id,
    participantLabel: `@${participant.handle}`,
    content: "Provider diagnostic.",
    createdAt: NOW,
    status: "error",
    metadata: { runId: "stored-run" }
  });
  const { service } = testService({ conversation });

  const changed = markStoredParticipantRunStoppedByUser(conversation, "stored-run");

  assert.equal(changed, true);
  assert.equal(conversation.messages.find((message) => message.id === "pending-message")?.status, "error");
  assert.equal(conversation.messages.find((message) => message.id === "pending-message")?.content, "Partial remote content.");
  assert.equal(conversation.messages.find((message) => message.id === "pending-message")?.metadata?.terminalReason, "user-stopped");
  assert.equal(conversation.messages.find((message) => message.id === "error-message")?.status, "error");
  assert.equal(conversation.messages.find((message) => message.id === "error-message")?.content, "Provider diagnostic.");
  assert.equal(conversation.messages.find((message) => message.id === "error-message")?.metadata?.terminalReason, "user-stopped");
});

test("duplicate chat run ids stay active until every owner ends", async () => {
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });

  await chatParts(service).activeRuns.beginChatRun(conversation, "shared-run");
  await chatParts(service).activeRuns.beginChatRun(conversation, "shared-run");
  await chatParts(service).activeRuns.endChatRun(conversation, "shared-run");

  assert.deepEqual(storage.current.metadata.activeRunIds, ["shared-run"]);
  assert.equal(storage.current.metadata.running, true);
  assert.equal(storage.current.metadata.activeRunOwnersByRunId?.["shared-run"]?.processId, process.pid);

  await chatParts(service).activeRuns.endChatRun(conversation, "shared-run");

  assert.equal(storage.current.metadata.activeRunIds, undefined);
  assert.equal(storage.current.metadata.running, false);
  assert.equal(storage.current.metadata.activeRunOwnersByRunId, undefined);
});

test("ending one active run preserves survivor metadata", async () => {
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });

  await chatParts(service).activeRuns.beginChatRun(conversation, "first-run");
  await chatParts(service).activeRuns.beginChatRun(conversation, "second-run");
  await chatParts(service).activeRuns.endChatRun(conversation, "first-run");

  assert.deepEqual(storage.current.metadata.activeRunIds, ["second-run"]);
  assert.equal(storage.current.metadata.running, true);
  assert.equal(storage.current.metadata.runId, "second-run");
  assert.equal(storage.current.metadata.activeRunOwnersByRunId?.["second-run"]?.processId, process.pid);
  assert.equal(storage.current.metadata.activeRunOwnersByRunId?.["first-run"], undefined);

  await chatParts(service).activeRuns.endChatRun(conversation, "second-run");

  assert.equal(storage.current.metadata.activeRunIds, undefined);
  assert.equal(storage.current.metadata.running, false);
  assert.equal(storage.current.metadata.runId, undefined);
  assert.equal(storage.current.metadata.activeRunOwnersByRunId, undefined);
});

test("active local run metadata stores participant attribution and clears it when idle", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  const serviceAny = service as any;
  const controller = new AbortController();

  chatParts(serviceAny).activeRuns.registerTargetRun("target-run", controller, {
    conversationId: conversation.id,
    participantId: participant.id,
    participantHandle: participant.handle
  });
  await chatParts(serviceAny).activeRuns.beginChatRun(conversation, "target-run");

  assert.deepEqual(storage.current.metadata.activeRunIds, ["target-run"]);
  assert.equal(storage.current.metadata.activeRunParticipantIdsByRunId?.["target-run"], participant.id);

  await chatParts(serviceAny).activeRuns.endChatRun(conversation, "target-run");

  assert.equal(storage.current.metadata.activeRunIds, undefined);
  assert.equal(storage.current.metadata.activeRunParticipantIdsByRunId, undefined);
  chatParts(serviceAny).activeRuns.unregisterTargetRun("target-run", controller);
});

test("ending one participant run preserves survivor participant attribution", async () => {
  const codex = chatParticipant("codex-cli");
  const claude = chatParticipant("claude-code");
  const conversation = chatConversation([codex, claude]);
  const { service, storage } = testService({ conversation });
  const serviceAny = service as any;
  const firstController = new AbortController();
  const secondController = new AbortController();

  chatParts(serviceAny).activeRuns.registerTargetRun("first-run", firstController, {
    conversationId: conversation.id,
    participantId: codex.id,
    participantHandle: codex.handle
  });
  chatParts(serviceAny).activeRuns.registerTargetRun("second-run", secondController, {
    conversationId: conversation.id,
    participantId: claude.id,
    participantHandle: claude.handle
  });
  await chatParts(serviceAny).activeRuns.beginChatRun(conversation, "first-run");
  await chatParts(serviceAny).activeRuns.beginChatRun(conversation, "second-run");
  await chatParts(serviceAny).activeRuns.endChatRun(conversation, "first-run");

  assert.deepEqual(storage.current.metadata.activeRunIds, ["second-run"]);
  assert.equal(storage.current.metadata.activeRunParticipantIdsByRunId?.["first-run"], undefined);
  assert.equal(storage.current.metadata.activeRunParticipantIdsByRunId?.["second-run"], claude.id);

  await chatParts(serviceAny).activeRuns.endChatRun(conversation, "second-run");

  assert.equal(storage.current.metadata.activeRunIds, undefined);
  assert.equal(storage.current.metadata.activeRunParticipantIdsByRunId, undefined);
  chatParts(serviceAny).activeRuns.unregisterTargetRun("first-run", firstController);
  chatParts(serviceAny).activeRuns.unregisterTargetRun("second-run", secondController);
});

test("run owner heartbeat stamps owners, preserves attribution, and sweeps ghost run ids", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  const serviceAny = service as any;
  const controller = new AbortController();
  chatParts(serviceAny).activeRuns.registerTargetRun("run-1", controller, {
    conversationId: conversation.id,
    participantId: participant.id,
    participantHandle: participant.handle
  });
  await chatParts(serviceAny).activeRuns.beginChatRun(conversation, "run-1");
  // A raced or failed cleanup can leave a finished run id stored with no
  // owner record; the heartbeat must sweep it instead of re-persisting it.
  storage.current.metadata.activeRunIds = ["run-1", "ghost-run"];

  await chatParts(serviceAny).runOwners.heartbeatActiveRunOwners();

  assert.deepEqual(storage.current.metadata.activeRunIds, ["run-1"]);
  assert.equal(storage.current.metadata.activeRunOwnersByRunId?.["run-1"]?.processId, process.pid);
  assert.deepEqual(storage.current.metadata.activeRunParticipantIdsByRunId, {
    "run-1": participant.id
  });

  await chatParts(serviceAny).activeRuns.endChatRun(conversation, "run-1");
  chatParts(serviceAny).activeRuns.unregisterTargetRun("run-1", controller);
});

test("ending a current run preserves live external run metadata", async () => {
  const participant = chatParticipant("claude-code");
  const ownerPid = process.ppid > 0 ? process.ppid : 1;
  const fresh = new Date().toISOString();
  const conversation = chatConversation([participant], {
    activeRunIds: ["external-run"],
    runId: "external-run",
    running: true,
    activeRunOwnersByRunId: {
      "external-run": {
        processId: ownerPid,
        instanceId: "external-instance",
        startedAt: NOW,
        updatedAt: fresh
      }
    },
    activeRunParticipantIdsByRunId: {
      "external-run": participant.id
    }
  });
  const { service, storage } = testService({ conversation });

  await chatParts(service).activeRuns.beginChatRun(conversation, "current-run");
  await chatParts(service).activeRuns.endChatRun(conversation, "current-run");

  assert.deepEqual(storage.current.metadata.activeRunIds, ["external-run"]);
  assert.equal(storage.current.metadata.runId, "external-run");
  assert.equal(storage.current.metadata.running, true);
  assert.equal(storage.current.metadata.activeRunOwnersByRunId?.["external-run"]?.instanceId, "external-instance");
  assert.equal(storage.current.metadata.activeRunParticipantIdsByRunId?.["external-run"], participant.id);
  assert.equal(storage.current.metadata.activeRunOwnersByRunId?.["current-run"], undefined);
  assert.equal(storage.current.metadata.activeRunParticipantIdsByRunId?.["current-run"], undefined);
});

test("a compaction another flow's older copy did not see still keeps its member busy", async () => {
  const { assistant, worker, target, conversation } = removalTrio();
  const { service, storage } = testService({ conversation });
  // @worker's compaction holds a copy from before @target's started.
  const workerCompaction = await storage.getConversation(conversation.id) as Conversation;
  await chatParts(service).activeRuns.beginChatParticipantCompactionRun(workerCompaction, "worker-compaction", worker.id);
  await chatParts(service).store.waitForQueuedSave(conversation.id);
  const targetCompaction = await storage.getConversation(conversation.id) as Conversation;
  await chatParts(service).activeRuns.beginChatParticipantCompactionRun(targetCompaction, "target-compaction", target.id);
  await chatParts(service).store.waitForQueuedSave(conversation.id);

  // @worker's compaction ends and saves its copy.
  await chatParts(service).activeRuns.endChatRun(workerCompaction, "worker-compaction");
  await chatParts(service).store.waitForQueuedSave(conversation.id);

  assert.ok(storage.current.metadata.participantCompactionsByParticipantId?.[target.id], "the compaction is still recorded");
  await assert.rejects(
    () => service.removeParticipant({ conversationId: conversation.id, participantId: target.id }),
    /@target is busy/
  );
  await service.removeParticipant({ conversationId: conversation.id, participantId: worker.id });
  assert.deepEqual(memberIds(storage.current), [assistant.id, target.id]);
});

test("with Manage members allow, a member removing itself stays until its own turn ends", async () => {
  const { service, storage, actor, manager } = memberRemovalFixture({ manage: "allow" });
  const live = await storage.getConversation("conversation-1") as Conversation;
  await chatParts(service).activeRuns.beginChatRun(live, "manager-run");
  await chatParts(service).store.waitForQueuedSave(live.id);

  const result = await service.requestParticipantChangeFromTool(actor, {
    operations: [{ type: "remove_participant_from_chat", participantId: manager.id }]
  }) as { status: string };
  assert.equal(result.status, "auto_approved");
  // Its own reply is still being written: it is not taken out under it.
  assert.ok(memberIds(storage.current).includes(manager.id));

  await chatParts(service).activeRuns.endChatRun(live, "manager-run");
  await waitFor(() => !memberIds(storage.current).includes(manager.id));
  assert.ok(storage.current.messages.some((message: ChatMessage) => message.content === "Removed @manager from this chat at @manager's request."));
});

test("refreshStoredChatState preserves stored completed messages over stale pending copies", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const runId = "completed-run";
  conversation.messages.push(pendingParticipantMessage(participant, "answer", runId, {
    status: "done",
    content: "Finished answer.",
    metadata: { runId }
  }));
  const staleConversation = clone(conversation);
  staleConversation.messages = staleConversation.messages.map((message: any) =>
    message.id === "answer"
      ? pendingParticipantMessage(participant, "answer", runId)
      : message
  );
  const { service } = testService({ conversation });

  await chatParts(service).store.refreshStoredChatState(staleConversation);

  const answer = staleConversation.messages.find((message: any) => message.id === "answer")!;
  assert.equal(answer.status, "done");
  assert.equal(answer.content, "Finished answer.");
  assert.equal(chatParts(service).runOwners.recoverStaleChatRun(staleConversation), false);
  assert.equal(answer.metadata?.staleRunRecovery, undefined);
});

test("recoverStaleChatRun leaves a pending message whose run is still live", () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const runId = "live-run";
  conversation.messages.push(pendingParticipantMessage(participant, "pending-live", runId));
  const { service } = testService({ conversation });
  chatParts(service).activeRuns.chatRunMeta.set(runId, {
    conversationId: conversation.id,
    participantId: participant.id,
    participantHandle: participant.handle
  });

  const changed = chatParts(service).runOwners.recoverStaleChatRun(conversation);

  assert.equal(changed, false);
  const pending = conversation.messages.find((message: any) => message.id === "pending-live")!;
  assert.equal(pending.status, "pending");
  assert.equal(pending.metadata?.staleRunRecovery, undefined);
});

test("a native resume publishes its outcome after the caller appends final messages", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const runId = "native-settlement";
  conversation.messages.push(pendingParticipantMessage(participant, "native-result", runId));
  const { service } = testService({ conversation });
  const internal = service as any;
  await chatParts(internal).activeRuns.beginChatRun(conversation, runId);
  const controller = new AbortController();
  chatParts(internal).activeRuns.registerTargetRun(runId, controller, { conversationId: conversation.id, participantId: participant.id, participantHandle: participant.handle });
  let result: Promise<{ messages: ChatMessage[]; warnings: string[] }> | undefined;
  let published = false;
  service.onParticipantRunSettled((run) => { result = service.settledParticipantRunResult(run).then((value) => { published = true; return value; }); });
  chatParts(internal).activeRuns.unregisterTargetRun(runId, controller);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(published, false, "controller release is earlier than the caller's final append");
  await chatParts(internal).store.withChatMutation(conversation, () => {
    const message = conversation.messages.find((item) => item.id === "native-result")!;
    message.status = "done";
    message.content = "final result appended by the resume caller";
    chatParts(internal).store.queueSnapshot(conversation);
  });
  await chatParts(internal).activeRuns.endChatRun(conversation, runId);
  const outcome = await result!;
  assert.equal(outcome.messages[0].status, "done");
  assert.equal(outcome.messages[0].content, "final result appended by the resume caller");
});

test("recoverStaleChatRun preserves runs owned by another live app instance", () => {
  const participant = chatParticipant("codex-cli");
  const runId = "external-live-run";
  const ownerPid = process.ppid > 0 ? process.ppid : 1;
  const fresh = new Date().toISOString();
  const conversation = chatConversation([participant], {
    activeRunIds: [runId],
    runId,
    running: true,
    activeRunOwnersByRunId: {
      [runId]: {
        processId: ownerPid,
        instanceId: "external-instance",
        startedAt: NOW,
        updatedAt: fresh
      }
    },
    activeRunParticipantIdsByRunId: {
      [runId]: participant.id
    }
  });
  conversation.messages.push(pendingParticipantMessage(participant, "pending-external", runId));
  const { service } = testService({ conversation });

  const changed = chatParts(service).runOwners.recoverStaleChatRun(conversation);

  assert.equal(changed, false);
  assert.deepEqual(conversation.metadata.activeRunIds, [runId]);
  assert.equal(conversation.metadata.activeRunParticipantIdsByRunId?.[runId], participant.id);
  assert.equal(conversation.metadata.running, true);
  assert.equal(conversation.messages.find((message: any) => message.id === "pending-external")!.status, "pending");
});

test("recoverStaleChatRun interrupts old local run metadata without an owner", () => {
  const participant = chatParticipant("codex-cli");
  const runId = "pre-owner-run";
  const conversation = chatConversation([participant], {
    activeRunIds: [runId],
    runId,
    running: true,
    activeRunParticipantIdsByRunId: {
      [runId]: participant.id
    }
  });
  conversation.messages.push(pendingParticipantMessage(participant, "pending-old", runId));
  const { service } = testService({ conversation });

  const changed = chatParts(service).runOwners.recoverStaleChatRun(conversation);

  assert.equal(changed, true);
  assert.equal(conversation.metadata.activeRunIds, undefined);
  assert.equal(conversation.metadata.activeRunOwnersByRunId, undefined);
  assert.equal(conversation.metadata.activeRunParticipantIdsByRunId, undefined);
  assert.equal(conversation.metadata.running, false);
  const pending = conversation.messages.find((message: any) => message.id === "pending-old")!;
  assert.equal(pending.status, "error");
  assert.equal(pending.content, "Interrupted before completion.");
});

test("recoverStaleChatRun does not preserve stale heartbeat owners even if the pid is live", () => {
  const participant = chatParticipant("codex-cli");
  const runId = "stale-heartbeat-run";
  const ownerPid = process.ppid > 0 ? process.ppid : 1;
  const conversation = chatConversation([participant], {
    activeRunIds: [runId],
    runId,
    running: true,
    activeRunOwnersByRunId: {
      [runId]: {
        processId: ownerPid,
        instanceId: "external-instance",
        startedAt: NOW,
        updatedAt: "2000-01-01T00:00:00.000Z"
      }
    },
    activeRunParticipantIdsByRunId: {
      [runId]: participant.id
    }
  });
  conversation.messages.push(pendingParticipantMessage(participant, "pending-stale-owner", runId));
  const { service } = testService({ conversation });

  const changed = chatParts(service).runOwners.recoverStaleChatRun(conversation);

  assert.equal(changed, true);
  assert.equal(conversation.metadata.activeRunIds, undefined);
  assert.equal(conversation.metadata.activeRunOwnersByRunId, undefined);
  assert.equal(conversation.metadata.activeRunParticipantIdsByRunId, undefined);
  assert.equal(conversation.metadata.running, false);
  assert.equal(conversation.messages.find((message: any) => message.id === "pending-stale-owner")!.status, "error");
});

test("recoverStaleChatRun keeps run metadata when a pending bubble is live only via the registry", () => {
  const participant = chatParticipant("codex-cli");
  const runId = "registry-only-run";
  const conversation = chatConversation([participant], { activeRunIds: [runId], running: true });
  conversation.messages.push(pendingParticipantMessage(participant, "pending-registry", runId));
  const { service } = testService({ conversation });
  // Stale metadata lists the run, the in-memory activeRunIds Set has lost it, but
  // the controller/meta registry still tracks it as live.
  chatParts(service).activeRuns.chatRunMeta.set(runId, {
    conversationId: conversation.id,
    participantId: participant.id,
    participantHandle: participant.handle
  });

  const changed = chatParts(service).runOwners.recoverStaleChatRun(conversation);

  assert.equal(changed, false);
  assert.deepEqual(conversation.metadata.activeRunIds, [runId]);
  assert.equal(conversation.metadata.running, true);
  const warnings = (conversation.metadata.warnings as string[] | undefined) ?? [];
  assert.equal(warnings.some((warning) => /interrupt/i.test(warning)), false);
  assert.equal(conversation.messages.find((message: any) => message.id === "pending-registry")!.status, "pending");
});

test("an inline member request is the requester's foreground work: stopping the requester stops it", async () => {
  const requester = chatParticipant("codex-cli", { requestParticipants: "allow" });
  const target = chatParticipant("claude-code");
  const conversation = chatConversation([requester, target]);
  let targetAborted = false;
  let targetStarted = false;
  const { service, tempRoot } = testService({
    conversation,
    run: async (participant: any, _prompt: unknown, _path: unknown, _unused: unknown, _mode: unknown, signal?: AbortSignal) => {
      if (participant.id === target.id) {
        targetStarted = true;
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => {
          targetAborted = true;
          resolve();
        }, { once: true }));
      }
      return { participant, ok: true, content: "done.", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  const requesterTurn = new AbortController();
  chatParts(service).activeRuns.registerRunController("requester-run", requesterTurn);

  const call = service.requestParticipantsFromTool({ ...participantRequestActor(requester), runId: "requester-run" }, {
    requests: [{ target: target.handle, prompt: "Review." }],
    resumeRequester: false,
    timeoutMs: 1000
  });
  await waitFor(() => targetStarted);
  service.cancelRun("requester-run");
  await waitFor(() => targetAborted);
  await call;
});
