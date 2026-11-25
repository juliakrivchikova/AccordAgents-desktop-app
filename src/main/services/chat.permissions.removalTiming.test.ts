import assert from "node:assert/strict";
import test from "node:test";
import { APP_PARTICIPANTS_REQUEST_CHANGE_TOOL } from "./appMcp";
import { chatDependencies, chatParts } from "./chat/test/chatParts";
import type { ChatAppToolApproval, ChatMessage, ChatParticipant, Conversation, ParticipantConfig } from "../../shared/types";
import {
  answeredCard, chatConversation, chatParticipant, feedCard, homeOnMachine, machineCard, memberIds, memberRemovalFixture, NOW,
  participantRequestApproval, permissionApproval, queuedRemovalApproval, removalTrio, testService, waitFor
} from "./chat/test/permissionFixtures";

test("a member removed while its turn waited does not run", async () => {
  const participant = { ...chatParticipant("claude-code"), id: "member", handle: "member" };
  const other = { ...chatParticipant("codex-cli"), id: "other", handle: "other" };
  const conversation = chatConversation([other]);
  let runs = 0;
  const { service, tempRoot } = testService({
    conversation,
    run: async (runParticipant: ParticipantConfig) => {
      runs += 1;
      return { participant: runParticipant, ok: true, content: "Done.", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  await assert.rejects(
    () => chatParts(service).turnQueue.runParticipantTurnSerialized(conversation, participant, conversation.messages[0], "late-run", undefined, undefined, { warnings: [], continuation: true }),
    /@member was removed from this chat/
  );
  assert.equal(runs, 0);
});

test("a member being dispatched cannot be removed before its turn registers", async () => {
  const { assistant, worker, target, conversation } = removalTrio();
  const { service, storage } = testService({ conversation });
  let failHistory!: (error: Error) => void;
  chatParts(service).chatHistory.ensureHistoryFiles = () => new Promise<string>((_resolve, reject) => { failHistory = reject; });
  const live = await storage.getConversation(conversation.id) as Conversation;
  const trigger = live.messages[0]!;
  const batch = chatParts(service).participantBatch.runParticipantBatch(live, [target], trigger, "batch-run", undefined, undefined, []) as Promise<void>;

  await assert.rejects(
    () => service.removeParticipant({ conversationId: conversation.id, participantId: target.id }),
    /@target is busy/
  );
  await service.removeParticipant({ conversationId: conversation.id, participantId: worker.id });
  assert.deepEqual(memberIds(storage.current), [assistant.id, target.id]);

  failHistory(new Error("history unavailable"));
  await assert.rejects(batch, /history unavailable/);
  await service.removeParticipant({ conversationId: conversation.id, participantId: target.id });
  assert.deepEqual(memberIds(storage.current), [assistant.id]);
});

test("an approved member removal in an idle chat uses the shared removal cleanup", async () => {
  const { service, storage, actor, target, manager } = memberRemovalFixture({
    metadata: {
      pendingAppToolApprovals: [
        permissionApproval({ ...chatParticipant("codex-cli"), id: "target-participant", handle: "target" }, {
          kind: "portable",
          permissions: ["webAccess"]
        }, { id: "target-permission" }),
        participantRequestApproval({ ...chatParticipant("claude-code"), id: "manager-participant", handle: "manager", roleConfigId: "removal-manager" }, [{
          target: "target",
          prompt: "Please review this."
        }], { id: "request-target-approval", requestMessageId: "request-message", batchId: "batch-1" })
      ]
    },
    messages: [{
      id: "request-message",
      role: "participant",
      participantId: "manager-participant",
      content: "@target Please review this.",
      createdAt: NOW,
      status: "done",
      metadata: {
        participantRequest: {
          id: "batch-1",
          requesterParticipantId: "manager-participant",
          requesterHandle: "manager",
          source: "mcp",
          resumeRequester: true,
          status: "pending_approval",
          depth: 1,
          createdAt: NOW,
          updatedAt: NOW,
          items: [{
            targetParticipantId: "target-participant",
            targetHandle: "target",
            prompt: "Please review this.",
            status: "pending_approval",
            createdAt: NOW,
            updatedAt: NOW
          }]
        }
      }
    }]
  });
  const requested = await service.requestParticipantChangeFromTool(actor, {
    operations: [{ type: "remove_participant_from_chat", participantId: target.id }]
  }) as { approvalId: string };

  await service.respondToAppToolApproval({ conversationId: storage.current.id, approvalId: requested.approvalId, approve: true });

  const saved = storage.current as Conversation;
  assert.equal(memberIds(saved).includes(target.id), false);
  assert.ok(memberIds(saved).includes(manager.id));
  assert.deepEqual(saved.metadata.participantSessions, []);
  const approvals = saved.metadata.pendingAppToolApprovals as ChatAppToolApproval[];
  const removal = approvals.find((approval) => approval.id === requested.approvalId);
  assert.equal(removal?.status, "approved");
  assert.equal(removal?.memberRemovalQueuedAt, undefined);
  assert.deepEqual(removal?.appliedParticipantIds, [target.id]);
  for (const id of ["target-permission", "request-target-approval"]) {
    const closed = approvals.find((approval) => approval.id === id);
    assert.equal(closed?.status, "denied");
    assert.equal(closed?.error, "Member was removed from this chat.");
  }
  const item = saved.messages.find((message) => message.id === "request-message")?.metadata?.participantRequest?.items[0];
  assert.equal(item?.status, "failed");
  assert.equal(item?.error, "Member was removed from this chat.");
  assert.ok(saved.messages.some((message) => message.content === "Removed @target from this chat at @manager's request."));
});

test("an approved member removal waits for the asking member's turn, then applies", async () => {
  const { service, storage, actor, target } = memberRemovalFixture();
  const requested = await service.requestParticipantChangeFromTool(actor, {
    operations: [{ type: "remove_participant_from_chat", handle: "target" }]
  }) as { approvalId: string };
  const live = await storage.getConversation("conversation-1") as Conversation;
  await chatParts(service).activeRuns.beginChatRun(live, "manager-run");
  await chatParts(service).store.waitForQueuedSave(live.id);

  await service.respondToAppToolApproval({ conversationId: live.id, approvalId: requested.approvalId, approve: true });

  let approval = (storage.current.metadata.pendingAppToolApprovals as ChatAppToolApproval[])[0];
  assert.equal(approval.status, "approved");
  assert.equal(typeof approval.memberRemovalQueuedAt, "string");
  assert.ok(memberIds(storage.current).includes(target.id), "the target stays while the turn runs");

  await chatParts(service).activeRuns.endChatRun(live, "manager-run");
  await waitFor(() => !memberIds(storage.current).includes(target.id));

  approval = (storage.current.metadata.pendingAppToolApprovals as ChatAppToolApproval[])[0];
  assert.equal(approval.status, "approved");
  assert.equal(approval.memberRemovalQueuedAt, undefined);
  assert.deepEqual(approval.appliedParticipantIds, [target.id]);
  assert.notEqual(storage.current.metadata.running, true);
});

test("an approved member removal also waits for the removed member's own turn", async () => {
  const { service, storage, actor, target } = memberRemovalFixture();
  const requested = await service.requestParticipantChangeFromTool(actor, {
    operations: [{ type: "remove_participant_from_chat", handle: "target" }]
  }) as { approvalId: string };
  const managerRun = await storage.getConversation("conversation-1") as Conversation;
  await chatParts(service).activeRuns.beginChatRun(managerRun, "manager-run");
  const targetRun = await storage.getConversation("conversation-1") as Conversation;
  await chatParts(service).activeRuns.beginChatRun(targetRun, "target-run");
  await service.respondToAppToolApproval({ conversationId: "conversation-1", approvalId: requested.approvalId, approve: true });

  await chatParts(service).activeRuns.endChatRun(managerRun, "manager-run");
  // Drain any pass the idle hook started, then try once more directly.
  await chatParts(service).queuedRosterChanges.applyQueuedMemberRemovalsOnce("conversation-1");
  assert.ok(memberIds(storage.current).includes(target.id), "the removed member's turn is still running");
  assert.equal(typeof storage.current.metadata.pendingAppToolApprovals[0].memberRemovalQueuedAt, "string");

  await chatParts(service).activeRuns.endChatRun(targetRun, "target-run");
  await waitFor(() => !memberIds(storage.current).includes(target.id));
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].memberRemovalQueuedAt, undefined);
});

test("a removal whose write fails stays approved and waiting, and applies at the next idle moment", async () => {
  const { service, storage, actor, target } = memberRemovalFixture();
  const requested = await service.requestParticipantChangeFromTool(actor, {
    operations: [{ type: "remove_participant_from_chat", handle: "target" }]
  }) as { approvalId: string };
  const closedWarm: string[] = [];
  chatDependencies(service).cliRunner.closeWarmAgents = async (_conversationId: string, participantId: string) => {
    closedWarm.push(participantId);
  };
  const save = storage.saveConversation.bind(storage);
  let failNextRemovalWrite = true;
  storage.saveConversation = async (conversation: Conversation) => {
    const removing = !(conversation.metadata.participants as ChatParticipant[]).some((participant) => participant.id === target.id);
    if (removing && failNextRemovalWrite) {
      failNextRemovalWrite = false;
      throw new Error("SQLITE_FULL while removing");
    }
    return save(conversation);
  };

  await service.respondToAppToolApproval({ conversationId: "conversation-1", approvalId: requested.approvalId, approve: true });

  assert.equal(failNextRemovalWrite, false, "the removal write was attempted");
  assert.ok(memberIds(storage.current).includes(target.id));
  assert.deepEqual(closedWarm, [], "a removal that was not stored leaves the member's process alone");
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "approved");
  assert.equal(typeof storage.current.metadata.pendingAppToolApprovals[0].memberRemovalQueuedAt, "string");

  // Within the retry delay an idle moment does not repeat the failing write.
  let writes = 0;
  const countingSave = storage.saveConversation;
  storage.saveConversation = async (conversation: Conversation) => {
    writes += 1;
    return countingSave(conversation);
  };
  chatParts(service).autoWatch.scheduleAutoWatchEvaluation("conversation-1", "run-idle");
  await chatParts(service).queuedRosterChanges.memberRemovalApplies.get("conversation-1");
  assert.equal(writes, 0);
  assert.ok(memberIds(storage.current).includes(target.id));

  chatParts(service).queuedRosterChanges.memberRemovalRetryAfter.set("conversation-1", Date.now() - 1);
  chatParts(service).autoWatch.scheduleAutoWatchEvaluation("conversation-1", "run-idle");
  await waitFor(() => !memberIds(storage.current).includes(target.id));
  assert.deepEqual(storage.current.metadata.pendingAppToolApprovals[0].appliedParticipantIds, [target.id]);
  assert.equal(storage.current.messages.filter((message: ChatMessage) => message.content.startsWith("Removed @target")).length, 1);
  await waitFor(() => closedWarm.length === 1);
  assert.deepEqual(closedWarm, [target.id]);
});

test("a machine member's approved removal is applied by the desktop once the User's answer is confirmed, also after a restart", async () => {
  const { service, storage, target } = memberRemovalFixture();
  homeOnMachine(storage);
  // The User's answer as the server held it when the desktop read it.
  const decisionId = `server:queued-target@${NOW}`;
  storage.current.metadata.pendingAppToolApprovals = [queuedRemovalApproval("target-participant", "target", { homeMachineId: "machine", machineAppliedDecisionId: decisionId })];
  storage.conversationIdsWithQueuedRosterChanges = async () => [storage.current.id];

  await service.resumeQueuedRosterChanges();

  assert.equal(memberIds(storage.current).includes(target.id), false);
  const approval = storage.current.metadata.pendingAppToolApprovals[0] as ChatAppToolApproval;
  assert.equal(approval.memberRemovalQueuedAt, undefined);
  assert.deepEqual(approval.appliedParticipantIds, [target.id]);
  assert.equal(typeof approval.rosterChangeSettledAt, "string");
  const said = storage.current.messages.filter((message: ChatMessage) => message.content === "Removed @target from this chat at @manager's request.");
  assert.equal(said.length, 1);
  assert.deepEqual(said[0].metadata?.rosterChange, { approvalId: "queued-target", outcome: "applied", appliedParticipantIds: [target.id] }, "the machine settles its card from this message");
});

test("a machine resumes its members' decided removals after a restart (Д2)", async () => {
  const { service, storage, target } = memberRemovalFixture({ manage: "allow" });
  service.setHostMachineId("machine");
  homeOnMachine(storage);
  storage.current.metadata.pendingAppToolApprovals = [{ ...queuedRemovalApproval("target-participant", "target"), status: "auto-applied", approvalScope: undefined }];
  storage.conversationIdsWithQueuedRosterChanges = async () => [storage.current.id];

  await service.resumeQueuedMemberRemovals();

  assert.equal(memberIds(storage.current).includes(target.id), false);
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].memberRemovalQueuedAt, undefined);
});

test("a machine member's removal approved on the server is made by its machine: the desktop shows it waiting, then the machine's outcome (Д2)", async () => {
  const { service, storage, target } = memberRemovalFixture();
  homeOnMachine(storage);
  const queued = queuedRemovalApproval("target-participant", "target", { homeMachineId: "machine", updatedAt: new Date().toISOString() });
  const card = machineCard(queued);

  // The machine raises its card on the server; the User approves it there
  // (on her phone).
  await feedCard(service, "card.raise", card);
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "pending", "shown as the member's card");
  const answer = answeredCard(card, { approve: true });
  await feedCard(service, "card.answer", answer);
  await chatParts(service).queuedRosterChanges.applyQueuedMemberRemovalsOnce("conversation-1");
  const waiting = storage.current.metadata.pendingAppToolApprovals[0] as ChatAppToolApproval;
  assert.equal(waiting.memberRemovalQueuedAt, undefined, "nothing is queued here");
  assert.equal(waiting.machineDecisionPending?.approve, true, "it waits for its machine");
  assert.ok(memberIds(storage.current).includes(target.id), "the desktop removes nobody itself");
  assert.equal(storage.current.messages.some((message: ChatMessage) => message.content.startsWith("Removed ")), false);

  // Read again (a reconnect lists the open cards): still only waiting.
  await feedCard(service, "card.raise", card);
  await feedCard(service, "card.answer", answer);
  await chatParts(service).queuedRosterChanges.applyQueuedMemberRemovalsOnce("conversation-1");
  assert.ok(memberIds(storage.current).includes(target.id));

  // The machine made it and settles its card: taken as is.
  const { memberRemovalQueuedAt: _queued, ...settledOnMachine } = queued;
  await feedCard(service, "card.settle", { ...answer, state: "settled", outcome: { result: "applied",
    approval: { ...settledOnMachine, status: "approved", appliedParticipantIds: [target.id], updatedAt: new Date(Date.now() + 1000).toISOString() } } });
  const final = storage.current.metadata.pendingAppToolApprovals[0] as ChatAppToolApproval;
  assert.equal(final.status, "approved");
  assert.deepEqual(final.appliedParticipantIds, [target.id]);
  assert.equal(final.machineDecisionPending, undefined);
});

test("after a restart a removal keeps waiting while a turn another live instance owns still runs", async () => {
  const freshOwner = () => ({ processId: process.ppid, instanceId: "other-instance", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const { service, storage, target } = memberRemovalFixture({
    metadata: {
      pendingAppToolApprovals: [queuedRemovalApproval("target-participant", "target")],
      running: true,
      runId: "elsewhere-run",
      activeRunIds: ["elsewhere-run"],
      activeRunOwnersByRunId: { "elsewhere-run": freshOwner() }
    },
    messages: [{
      id: "elsewhere-reply",
      role: "participant",
      participantId: "target-participant",
      participantLabel: "@target",
      content: "",
      createdAt: NOW,
      status: "pending",
      metadata: { runId: "elsewhere-run" }
    }]
  });
  storage.conversationIdsWithQueuedRosterChanges = async () => [storage.current.id];

  await service.resumeQueuedRosterChanges();
  assert.ok(memberIds(storage.current).includes(target.id), "the other instance's turn is still running");

  // That turn ends and its instance records the result.
  storage.current.metadata = { ...storage.current.metadata, running: false, activeRunIds: [], activeRunOwnersByRunId: {} };
  storage.current.messages = storage.current.messages.map((message: ChatMessage) =>
    message.id === "elsewhere-reply" ? { ...message, status: "done", content: "Done." } : message
  );
  chatParts(service).autoWatch.scheduleAutoWatchEvaluation("conversation-1", "replicated-messages");
  await waitFor(() => !memberIds(storage.current).includes(target.id));
});

test("with Manage members allow, a removal the member's turn cannot see end is made after a restart", async () => {
  const { service, storage, target } = memberRemovalFixture({
    manage: "allow",
    metadata: {
      pendingAppToolApprovals: [{
        ...queuedRemovalApproval("target-participant", "target"),
        status: "auto-applied",
        approvalScope: undefined
      }]
    }
  });
  storage.conversationIdsWithQueuedRosterChanges = async () => [storage.current.id];

  await service.resumeQueuedRosterChanges();

  assert.equal(memberIds(storage.current).includes(target.id), false);
  const approval = storage.current.metadata.pendingAppToolApprovals[0] as ChatAppToolApproval;
  assert.equal(approval.status, "auto-applied");
  assert.equal(approval.memberRemovalQueuedAt, undefined);
});

test("a second removal of the same member is refused while the first waits", async () => {
  const { service, actor } = memberRemovalFixture();
  await service.requestParticipantChangeFromTool(actor, { operations: [{ type: "remove_participant_from_chat", handle: "target" }] });

  await assert.rejects(
    () => service.requestParticipantChangeFromTool(actor, { operations: [{ type: "remove_participant_from_chat", handle: "target" }] }),
    /A removal of @target is already waiting for the User/
  );
});

test("an approved removal still waiting when the app quit is applied after the restart", async () => {
  const queued = (targetId: string, handle: string): ChatAppToolApproval => ({
    id: `queued-${handle}`,
    conversationId: "conversation-1",
    requesterParticipantId: "manager-participant",
    requesterHandle: "manager",
    requesterRoleConfigId: "removal-manager",
    toolName: APP_PARTICIPANTS_REQUEST_CHANGE_TOOL,
    capability: "participants.manage",
    status: "approved",
    approvalScope: "once",
    request: { kind: "participant_removal", operations: [{ type: "remove_participant_from_chat", participantId: targetId, handle }] },
    summary: `Remove @${handle} from this chat`,
    memberRemovalQueuedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW
  });
  // The asking member's turn was running when the app quit: its run is
  // still recorded as running, owned by a process that is gone.
  const { service, storage, target } = memberRemovalFixture({
    metadata: {
      pendingAppToolApprovals: [queued("target-participant", "target"), queued("gone-participant", "gone")],
      running: true,
      runId: "run-before-quit",
      activeRunIds: ["run-before-quit"]
    },
    messages: [{
      id: "interrupted-reply",
      role: "participant",
      participantId: "manager-participant",
      participantLabel: "@manager",
      content: "",
      createdAt: NOW,
      status: "pending",
      metadata: { runId: "run-before-quit" }
    }]
  });
  storage.conversationIdsWithQueuedRosterChanges = async () => [storage.current.id];

  await service.resumeQueuedRosterChanges();

  assert.notEqual(storage.current.metadata.running, true);
  assert.equal(storage.current.messages.find((message: ChatMessage) => message.id === "interrupted-reply")?.status, "error");
  assert.equal(memberIds(storage.current).includes(target.id), false);
  const approvals = storage.current.metadata.pendingAppToolApprovals as ChatAppToolApproval[];
  assert.deepEqual(approvals.find((item) => item.id === "queued-target")?.appliedParticipantIds, [target.id]);
  // A member that already left is simply gone; the card closes without a second message.
  assert.deepEqual(approvals.find((item) => item.id === "queued-gone")?.appliedParticipantIds, []);
  assert.ok(approvals.every((item) => item.memberRemovalQueuedAt === undefined && item.updatedAt > NOW));
  assert.equal(storage.current.messages.filter((message: ChatMessage) => message.content.startsWith("Removed ")).length, 1);
  assert.ok(storage.current.messages.some((message: ChatMessage) =>
    message.content === "@gone had already left this chat; nothing was removed at @manager's request."
  ));
});
