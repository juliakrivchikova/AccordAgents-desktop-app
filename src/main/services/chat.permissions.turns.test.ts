import assert from "node:assert/strict";
import test from "node:test";
import { APP_PERMISSIONS_REQUEST_CHANGE_TOOL } from "./appMcp";
import { chatDependencies, chatParts } from "./chat/test/chatParts";
import { mergeParticipantCompactions } from "./chat/store/mergeStoredMetadata";
import { hubTurnRunId } from "../../shared/hubOps";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { MAIN_SESSION_ROLE_ID } from "../../shared/mainSession";
import { selectedChatAccessOption } from "../../shared/chatAccessModes";
import type { ChatAppToolApproval, ChatMessage, ChatParticipant, Conversation, ParticipantConfig } from "../../shared/types";
import {
  ADMIN_ROLE, chatConversation, chatParticipant, clone, fakeServerLink, memberIds, memberRemovalFixture, NOW,
  participantRequestActor, pendingParticipantMessage, permissionApproval, removalTrio, ROLE, startMemberTurn, testService, waitFor
} from "./chat/test/permissionFixtures";

test("a Codex member's next message still waits for its running turn", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  let calls = 0;
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant) => {
      calls += 1;
      if (calls === 1) {
        await firstBlocked;
      }
      return { participant: runParticipant, ok: true, content: `Reply ${calls}.`, durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  await service.sendMessage({ conversationId: conversation.id, runId: "codex-first", content: `@${participant.handle} one` });
  await waitFor(() => calls === 1);
  await service.sendMessage({ conversationId: conversation.id, runId: "codex-second", content: `@${participant.handle} two` });
  await waitFor(() => storage.current.messages.some((message: ChatMessage) => message.metadata?.queuedBehind));
  assert.equal(calls, 1);
  releaseFirst();
  await waitFor(() => calls === 2);
});

test("Codex max and ultra survive runtime updates and later unrelated updates", async () => {
  const codex = chatParticipant("codex-cli");
  const conversation = chatConversation([codex]);
  const { service, storage } = testService({ conversation });
  for (const reasoningEffort of ["max", "ultra"] as const) {
    const updated = await service.updateParticipantRuntime({
      conversationId: conversation.id,
      participantId: codex.id,
      model: "gpt-6-astra",
      reasoningEffort
    });
    assert.equal((updated?.metadata.participants as ChatParticipant[])[0]?.reasoningEffort, reasoningEffort);
    await service.updateParticipantRuntime({
      conversationId: conversation.id,
      participantId: codex.id,
      agentMode: "auto"
    });
    assert.equal((storage.current.metadata.participants as ChatParticipant[])[0]?.reasoningEffort, reasoningEffort);
  }
});

test("creation cleanup only archives an empty chat after queued messages have been saved", { timeout: 10_000 }, async () => {
  const conversation = chatConversation([chatParticipant("codex-cli")]);
  conversation.messages = [];
  const { service, storage } = testService({ conversation });
  chatDependencies(service).cliRunner.closeConversationSessions = async () => undefined;
  let release!: () => void;
  let entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const mutation = chatParts(service).store.withChatMutation(conversation, async () => {
    entered();
    await hold;
    conversation.messages.push({ id: "concurrent-user", role: "user", content: "Keep this message", createdAt: NOW });
    await chatParts(service).store.saveConversation(conversation);
  });
  await reached;
  const cleanup = service.setArchived({ conversationId: conversation.id, archived: true, onlyIfEmpty: true });
  release();
  await mutation;
  const kept = await cleanup;
  assert.equal(kept?.metadata.archived, undefined);
  assert.equal(storage.current.messages[0].id, "concurrent-user");
  storage.current.messages = [];
  const archived = await service.setArchived({ conversationId: conversation.id, archived: true, onlyIfEmpty: true });
  assert.equal(archived?.metadata.archived, true);
});

test("participant reservation is released if turn controller setup fails", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const { service } = testService({ conversation });
  const serviceAny = service as any;
  const trigger = conversation.messages[0];
  const reservation = chatParts(serviceAny).turnQueue.reserveParticipantTurn(conversation.id, participant.id);
  chatParts(serviceAny).participantBatch.ensureChatTurnController = () => {
    throw new Error("controller setup failed");
  };

  await assert.rejects(
    () => chatParts(serviceAny).turnQueue.runParticipantTurnSerialized(conversation, participant, trigger, "failed-run", undefined, undefined, {
      warnings: [],
      turnReservation: reservation
    }),
    /controller setup failed/
  );

  const nextReservation = chatParts(serviceAny).turnQueue.reserveParticipantTurn(conversation.id, participant.id);
  assert.equal(nextReservation.queued, false);
  nextReservation.release();
});

test("same participant sends show queued bubble and serialize provider runs", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  let runCount = 0;
  let releaseFirst!: () => void;
  const firstCanFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let releaseSecond!: () => void;
  const secondCanFinish = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant) => {
      runCount += 1;
      const runNumber = runCount;
      if (runNumber === 1) {
        await firstCanFinish;
      } else if (runNumber === 2) {
        await secondCanFinish;
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
    (message: Conversation["messages"][number]) =>
      message.role === "participant" &&
      message.status === "pending" &&
      message.metadata?.queuedBehind?.handle === participant.handle
  ));
  const queuedMessage = storage.current.messages.find(
    (message: Conversation["messages"][number]) =>
      message.role === "participant" &&
      message.status === "pending" &&
      message.metadata?.queuedBehind?.handle === participant.handle
  );

  assert.equal(runCount, 1);
  releaseFirst();
  await waitFor(() => {
    const promoted = storage.current.messages.find((message: Conversation["messages"][number]) => message.id === queuedMessage?.id);
    return runCount === 2 &&
      promoted?.status === "pending" &&
      promoted.metadata?.queuedBehind === undefined;
  });
  const promoted = storage.current.messages.find((message: Conversation["messages"][number]) => message.id === queuedMessage?.id);
  assert.equal(queuedMessage?.metadata?.turnQueued, true, "queued, in words the User's server keeps (queuedBehind stays on the device)");
  assert.equal(promoted?.metadata?.turnQueued, undefined, "no longer queued once its turn began");
  assert.ok(promoted?.metadata?.turnStartedAt, "its own turn's start is stamped, so Working for does not count the wait");
  assert.ok(Date.parse(promoted!.metadata!.turnStartedAt!) >= Date.parse(promoted!.createdAt));

  releaseSecond();
  await waitFor(() =>
    storage.current.messages.some((message: Conversation["messages"][number]) => message.content === "reply 2") &&
    storage.current.metadata.running === false
  );
});

test("internal-mechanics phrasing in a draft is delivered as-is without retry", async () => {
  const participant = chatParticipant("claude-code", { workspaceWrite: false });
  const conversation = chatConversation([participant]);
  let runCount = 0;
  const draft = "The write tool is not enabled, so I cannot edit the file here.";
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant) => {
      runCount += 1;
      return {
        participant: runParticipant,
        ok: true,
        content: draft,
        durationMs: 1
      };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  const result = await service.sendMessage({
    conversationId: conversation.id,
    runId: "no-retry-run",
    content: "@drew please update the file"
  });
  await waitFor(() => runCount === 1);

  assert.equal(
    result.warnings.some((warning) =>
      warning.includes("rejected response that mentioned") ||
      warning.includes("blocked") ||
      warning.includes("Blocked")
    ),
    false
  );
  await waitFor(() => runCount === 1 && storage.current.messages.some(
    (message: Conversation["messages"][number]) => message.role === "participant" && message.content === draft
  ));
  const participantMessage = storage.current.messages.find(
    (message: Conversation["messages"][number]) => message.role === "participant"
  );
  assert.equal(participantMessage?.content, draft);
  assert.equal(participantMessage?.status, "done");
  assert.equal(typeof participantMessage?.metadata?.workedMs, "number");
  assert.ok((participantMessage?.metadata?.workedMs ?? -1) >= 0);
  const approvals = ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).filter(
    (item) => item.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL
  );
  assert.equal(approvals.length, 0);
});

test("verbose affirmative confirmations are delivered without retry or warning", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const verbose = [
    "Yes, I agree.",
    "",
    "- The plan is sound because it removes the retry gate.",
    "- The remaining concise-response guidance is independent."
  ].join("\n");
  const runs: ParticipantConfig[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant) => {
      runs.push(runParticipant);
      return {
        participant: runParticipant,
        ok: true,
        content: runs.length === 1 ? verbose : "Confirmed.",
        durationMs: 1
      };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  const result = await service.sendMessage({
    conversationId: conversation.id,
    runId: "verbose-confirmation-run",
    content: "@codex Do you agree?"
  });
  await waitFor(() => storage.current.messages.some(
    (message: Conversation["messages"][number]) => message.role === "participant" && message.status === "done"
  ));

  assert.equal(runs.length, 1);
  assert.equal(result.warnings.some((warning) => /verbose affirmative|confirmation-brevity/i.test(warning)), false);
  const participantMessage = storage.current.messages.find(
    (message: Conversation["messages"][number]) => message.role === "participant"
  );
  assert.equal(participantMessage?.content, verbose);
  assert.equal(participantMessage?.status, "done");
  const storedWarnings = (storage.current.metadata.warnings ?? []) as string[];
  assert.equal(storedWarnings.some((warning) => /verbose affirmative|confirmation-brevity/i.test(warning)), false);
});

test("switched to the sessions view, members with rights from the classic view run in their CLI's own mode from then on, here and when the phone switched it", async () => {
  const classicRights = { ...defaultChatAgentPermissions(), workspaceWrite: true, webAccess: true };
  const main = { ...chatParticipant("claude-code"), id: "main-participant", handle: "main", roleConfigId: MAIN_SESSION_ROLE_ID, agentMode: "auto" as const, permissions: classicRights };
  const helper = { ...chatParticipant("codex-cli"), id: "helper", handle: "helper", agentMode: "default" as const, permissions: { ...classicRights, workspaceWrite: false } };
  const mainChat = chatConversation([main, helper], { mainSessionParticipantId: main.id, chatView: "classic" });
  const { service, storage } = testService({ conversation: mainChat });
  await service.setChatView({ conversationId: mainChat.id, view: "sessions" });
  const modes = () => (storage.current.metadata.participants as ChatParticipant[]).map((member) =>
    [member.handle, member.agentMode, selectedChatAccessOption(member.kind, member.agentMode, member.permissions)?.id, normalizeChatAgentPermissions(member.permissions).webAccess]);
  assert.deepEqual(modes(), [["main", "auto", "auto", true], ["helper", "default", "read-only", true]], "the CLI mode each ran in, its other rights kept");
  await service.setChatView({ conversationId: mainChat.id, view: "classic" });
  assert.deepEqual(modes(), [["main", "auto", "auto", true], ["helper", "default", "read-only", true]], "for good: back in the classic view they stay in it");

  // Switched on the phone: the computer moves them when the switch reaches it.
  const phoneChat = chatConversation([main, helper], { mainSessionParticipantId: main.id, chatView: "sessions" });
  const phone = testService({ conversation: phoneChat });
  chatParts(phone.service).list.convertMembersForSessionsView(phoneChat.id);
  await waitFor(() => (phone.storage.current.metadata.participants as ChatParticipant[]).every((member) => normalizeChatAgentPermissions(member.permissions).cliApprovals === true));
});

test("existing chat submit still rejects an explicitly disabled local provider", async () => {
  const assistant = {
    ...chatParticipant("claude-code"),
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const conversation = chatConversation([assistant]);
  const initialMessageCount = conversation.messages.length;
  const { service, storage } = testService({
    conversation,
    settings: {
      chatRoleConfigs: [ADMIN_ROLE, ROLE],
      providers: [
        { kind: "codex-cli", label: "Codex CLI", enabled: true },
        { kind: "claude-code", label: "Claude Code", enabled: false }
      ]
    }
  });

  await assert.rejects(
    () => service.sendMessage({
      conversationId: conversation.id,
      runId: "disabled-submit",
      content: "@assistant this must remain blocked."
    }),
    /Claude Code is disabled/
  );
  assert.equal(storage.current.messages.length, initialMessageCount);
});

test("a run another app instance owns that names no member keeps every member", async () => {
  const freshOwner = { processId: process.ppid, instanceId: "other-instance", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const { target, conversation } = removalTrio({ running: true, runId: "elsewhere-run", activeRunIds: ["elsewhere-run"], activeRunOwnersByRunId: { "elsewhere-run": freshOwner } });
  const { service, storage } = testService({ conversation });

  await assert.rejects(
    () => service.removeParticipant({ conversationId: conversation.id, participantId: target.id }),
    /@target is busy/
  );
  assert.ok(memberIds(storage.current).includes(target.id));
});

test("a running member's older copy of the chat does not undo the User's changes to other members", async () => {
  const { worker, target, conversation } = removalTrio();
  conversation.metadata = {
    ...conversation.metadata,
    participants: (conversation.metadata.participants as ChatParticipant[]).map((participant) => participant.id === target.id
      ? { ...participant, autoWatch: true, permissions: { ...normalizeChatAgentPermissions(participant.permissions), requestParticipants: "allow" } }
      : participant),
    participantWatchers: { [target.id]: { wakeChainDepth: 3, pausedReason: "wake-limit", updatedAt: "2026-01-01T00:00:00.000Z" } }
  };
  const { service, storage } = testService({ conversation });
  // The worker's turn holds a copy read before the User's changes.
  const workerCopy = await startMemberTurn(service, storage, worker, "worker-run");

  await service.updateParticipantRuntime({
    conversationId: conversation.id,
    participantId: target.id,
    permissions: { ...normalizeChatAgentPermissions(target.permissions), requestParticipants: "ask" },
    autoWatch: false
  });
  await chatParts(service).store.withChatMutation(workerCopy, async () => {
    workerCopy.messages.push({ id: "worker-note", role: "system", content: "Worker progress.", createdAt: NOW, status: "done" });
    await chatParts(service).store.saveConversation(workerCopy);
  });

  const saved = (storage.current.metadata.participants as ChatParticipant[]).find((participant) => participant.id === target.id)!;
  assert.equal(normalizeChatAgentPermissions(saved.permissions).requestParticipants, "ask", "the revoked permission stays revoked");
  assert.equal(saved.autoWatch, false);
  assert.equal(storage.current.metadata.participantWatchers?.[target.id], undefined, "the watcher the User turned off does not come back");
  assert.ok(storage.current.messages.some((message: ChatMessage) => message.id === "worker-note"), "the worker's own change is saved");

  // A grant the flow itself makes on its copy still reaches the chat.
  await chatParts(service).store.withChatMutation(workerCopy, async () => {
    chatParts(service).requestGrants.setParticipantRequestPermission(workerCopy, target.id, "allow");
  });
  const regranted = await storage.getConversation(conversation.id) as Conversation;
  chatParts(service).requestGrants.setParticipantRequestPermission(regranted, worker.id, "allow");
  await chatParts(service).store.withChatMutation(regranted, async () => {
    await chatParts(service).store.saveConversation(regranted);
  });
  const workerSaved = (storage.current.metadata.participants as ChatParticipant[]).find((participant) => participant.id === worker.id)!;
  assert.equal(normalizeChatAgentPermissions(workerSaved.permissions).requestParticipants, "allow");
});

test("a member change waiting in the chat's queue is made on the chat as saved then, not on its earlier read", async () => {
  const { assistant, worker, target, conversation } = removalTrio({ queuedWriteMarker: "before" });
  const { service, storage } = testService({ conversation });
  const holder = await storage.getConversation(conversation.id) as Conversation;
  let release!: () => void;
  const held = chatParts(service).store.withChatMutation(holder, async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    holder.metadata = { ...holder.metadata, queuedWriteMarker: "written-while-queued" };
    await chatParts(service).store.saveConversation(holder);
  });
  const removal = service.removeParticipant({ conversationId: conversation.id, participantId: target.id });
  const update = service.updateParticipantRuntime({ conversationId: conversation.id, participantId: worker.id, model: "newer-model" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  await held;
  await removal;
  await update;

  assert.deepEqual(memberIds(storage.current), [assistant.id, worker.id]);
  assert.equal(storage.current.metadata.queuedWriteMarker, "written-while-queued", "what was saved while they waited is kept");
  assert.equal((storage.current.metadata.participants as ChatParticipant[]).find((participant) => participant.id === worker.id)!.model, "newer-model");
});

test("a turn uses the member's settings as they are when it starts", async () => {
  const participant = { ...chatParticipant("claude-code"), id: "member", handle: "member", model: "old-model" };
  const conversation = chatConversation([participant]);
  const models: Array<string | undefined> = [];
  const { service, tempRoot } = testService({
    conversation,
    run: async (runParticipant: ParticipantConfig) => {
      models.push(runParticipant.model);
      return { participant: runParticipant, ok: true, content: "Done.", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  const live = { ...conversation, metadata: { ...conversation.metadata, participants: [{ ...participant, model: "newer-model" }] } };

  await chatParts(service).turnQueue.runParticipantTurnSerialized(live, participant, live.messages[0], "continuation-run", undefined, undefined, { warnings: [], continuation: true });

  assert.deepEqual(models, ["newer-model"]);
});

test("an older copy's finished compaction does not hide the member's new one", async () => {
  const { conversation } = removalTrio();
  const { service } = testService({ conversation });
  const merged = mergeParticipantCompactions(
    { activeRunIds: ["second-run"], participantCompactionsByParticipantId: { "target-participant": { runId: "second-run", startedAt: NOW } } },
    { activeRunIds: ["first-run"], participantCompactionsByParticipantId: { "target-participant": { runId: "first-run", startedAt: NOW } } },
    new Set<string>()
  );
  assert.deepEqual(merged, { "target-participant": { runId: "second-run", startedAt: NOW } });
});

test("a message that starts no one keeps the run state of members that are working", async () => {
  const { worker, conversation } = removalTrio();
  const { service, storage } = testService({ conversation });
  await startMemberTurn(service, storage, worker, "worker-run");

  await service.sendMessage({ conversationId: conversation.id, content: "@nobody are you there?" } as any);

  assert.equal(storage.current.metadata.running, true);
  assert.deepEqual(storage.current.metadata.activeRunIds, ["worker-run"]);
});

test("a message sent to a member removed a moment before is told it is not here", async () => {
  const { worker, target, conversation } = removalTrio();
  const { service, storage } = testService({ conversation });
  // The removal is queued and not yet saved when the message reads the chat.
  const holder = await storage.getConversation(conversation.id) as Conversation;
  let release!: () => void;
  const removal = chatParts(service).store.withChatMutation(holder, async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    chatParts(service).members.removeParticipantsInMutation(holder, [target.id], NOW);
    await chatParts(service).store.saveConversation(holder);
  });
  let runs = 0;
  chatParts(service).participantBatch.runParticipantBatch = async () => { runs += 1; };

  const sending = service.sendMessage({ conversationId: conversation.id, content: "@target please check." } as any);
  await new Promise((resolve) => setTimeout(resolve, 30));
  release();
  await removal;
  const result = await sending;

  assert.equal(runs, 0, "no turn is started for the removed member");
  assert.ok(result.warnings.includes("No member named @target."), JSON.stringify(result.warnings));
  assert.ok(storage.current.messages.some((message: ChatMessage) => message.content === "No member named @target."));
  assert.ok(memberIds(storage.current).includes(worker.id));
});

test("a combined request numbers its errors as written, and may add a member and remove the asking one in a chat it had alone", async () => {
  {
    const { service, actor } = memberRemovalFixture({ manage: "allow" });
    await assert.rejects(
      () => service.requestParticipantChangeFromTool(actor, {
        operations: [
          { type: "remove_participant_from_chat", handle: "target" },
          { type: "add_existing_participant_to_chat" }
        ]
      }),
      /Member operation 2 needs participantConfigId/
    );
  }
  {
    const { service, storage, actor, manager } = memberRemovalFixture({ manage: "allow" });
    storage.current.metadata.participants = (storage.current.metadata.participants as ChatParticipant[]).filter((participant) => participant.id === manager.id);
    const result = await service.requestParticipantChangeFromTool(actor, {
      operations: [
        { type: "add_new_participant_to_chat", saveAsPreset: false, participant: { handle: "helper", roleConfigId: ROLE.id, kind: "codex-cli" } },
        { type: "remove_participant_from_chat", handle: "manager" }
      ]
    }) as { status: string; removals: { status: string } };
    assert.equal(result.status, "combined");
    assert.equal(result.removals.status, "auto_approved");
    await waitFor(() => !memberIds(storage.current).includes(manager.id));
    assert.deepEqual((storage.current.metadata.participants as ChatParticipant[]).map((participant) => participant.handle), ["helper"]);
  }
});

test("serialized participant turn invocations receive fresh segment ids even when runId is reused", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const { service } = testService({ conversation });
  const segmentIds: string[] = [];
  chatParts(service).participantTurn.runParticipantTurn = async (
    _conversation: Conversation,
    _participant: ChatParticipant,
    _trigger: ChatMessage,
    _runId: string,
    _signal: AbortSignal,
    _progress: unknown,
    options: { turnSegmentId: string }
  ) => {
    segmentIds.push(options.turnSegmentId);
    return [];
  };

  await chatParts(service).turnQueue.runParticipantTurnSerialized(
    conversation,
    participant,
    conversation.messages[0],
    "reused-run-id",
    undefined,
    undefined,
    { warnings: [] }
  );
  await chatParts(service).turnQueue.runParticipantTurnSerialized(
    conversation,
    participant,
    conversation.messages[0],
    "reused-run-id",
    undefined,
    undefined,
    { warnings: [] }
  );

  assert.equal(segmentIds.length, 2);
  assert.notEqual(segmentIds[0], segmentIds[1]);
});

test("refreshStoredChatState never takes back what the User's server said of a message (Д3, Д5)", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  // A running turn's copy of the chat, taken before the server answered.
  const staleConversation = clone(conversation);
  const runId = `turn-user-message-${participant.id}`;
  conversation.messages[0] = {
    ...conversation.messages[0],
    metadata: {
      ...(conversation.messages[0].metadata ?? {}),
      serverSeq: 12,
      serverWriter: "device-a",
      serverTurns: { [participant.id]: { runId, state: "claimed", executorDeviceId: "device-a" } }
    }
  };
  const { service } = testService({ conversation });

  await chatParts(service).store.refreshStoredChatState(staleConversation);

  const message = staleConversation.messages.find((item: any) => item.id === "user-message")!;
  assert.equal(message.metadata?.serverSeq, 12);
  assert.equal(message.metadata?.serverWriter, "device-a");
  assert.equal(message.metadata?.serverTurns?.[participant.id]?.state, "claimed");

  // The newer copy of a turn wins, whichever side holds it.
  message.metadata!.serverTurns![participant.id] = { runId, state: "finished", executorDeviceId: "device-a", outcome: "stopped" };
  await chatParts(service).store.refreshStoredChatState(staleConversation);
  assert.equal(message.metadata?.serverTurns?.[participant.id]?.state, "finished");
  assert.equal(message.metadata?.serverTurns?.[participant.id]?.outcome, "stopped");
});

test("refreshStoredChatState unions warnings added by a concurrent tool mutation", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant], {
    warnings: ["Existing warning."]
  });
  const staleConversation = clone(conversation);
  staleConversation.metadata.warnings = ["Existing warning.", "Requester warning."];
  const { service, storage } = testService({ conversation });
  storage.current.metadata.warnings = ["Existing warning.", "Inferred-request warning."];

  await chatParts(service).store.refreshStoredChatState(staleConversation);

  assert.deepEqual(staleConversation.metadata.warnings, [
    "Existing warning.",
    "Inferred-request warning.",
    "Requester warning."
  ]);
});

test("records of runs made through the removed transport survive a save", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant], {
    remoteRunHandles: {
      "old-run": {
        runId: "old-run",
        conversationId: "conversation-1",
        participantId: participant.id,
        participantHandle: participant.handle,
        worker: { host: "worker.example" },
        status: "completed",
        startedAt: NOW,
        updatedAt: NOW
      }
    },
    remoteRunReplay: { "old-run": { cursorSeq: 12, appliedRecordIds: ["r-1"] } }
  });
  const { service, storage } = testService({ conversation });

  await service.renameConversation({ conversationId: conversation.id, title: "Renamed" });
  await chatParts(service).store.waitForQueuedSave(conversation.id);

  const handles = storage.current.metadata.remoteRunHandles as Record<string, { status: string }>;
  const replay = storage.current.metadata.remoteRunReplay as Record<string, { cursorSeq: number }>;
  assert.equal(handles["old-run"].status, "completed", "an old run's record is not dropped by a later write");
  assert.equal(replay["old-run"].cursorSeq, 12);
});

test("only the member's home raises a card for its approval on the User's server", async () => {
  const participant = { ...chatParticipant("codex-cli"), homeMachineId: "machine-home" };
  const conversation = chatConversation([participant]);
  conversation.metadata.pendingAppToolApprovals = [permissionApproval(participant,
    { kind: "portable", permissions: ["repoRead"], reason: "Read the project" }, { id: "owner-card" }),
  permissionApproval(participant, { kind: "portable", permissions: ["repoRead"], reason: "Read the project" }, { id: "done-card", status: "approved" })];
  const { service } = testService({ conversation });
  const wanted = () => (chatParts(service).serverCards.wantedServerCards(conversation) as Array<{ cardId: string }>).map((card) => card.cardId);
  assert.deepEqual(wanted(), [], "the desktop shows a machine member's card, never raises it");
  service.setHostMachineId("machine-home");
  assert.deepEqual(wanted(), ["owner-card"], "its machine raises it, and only while it waits");
});

test("a durable approval claim precedes permission changes and a failed claim leaves them untouched", async () => {
  const participant = chatParticipant("codex-cli", { webAccess: false });
  const approval = permissionApproval(participant, { kind: "portable", permissions: ["webAccess"] });
  const conversation = chatConversation([participant], { pendingAppToolApprovals: [approval] });
  const { service, storage } = testService({ conversation });
  const request = { conversationId: conversation.id, approvalId: approval.id, approve: true, scope: "chat" as const };
  await assert.rejects(service.respondToAppToolApproval(request, undefined, { beforeApply: async () => { throw new Error("SQLITE_FULL before claim"); } }), /SQLITE_FULL/);
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "pending");
  assert.equal(normalizeChatAgentPermissions(storage.current.metadata.participants[0].permissions).webAccess, false);
  let claims = 0;
  await service.respondToAppToolApproval(request, undefined, { beforeApply: async () => { claims++; } });
  assert.equal(claims, 1);
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "approved");
  assert.equal(normalizeChatAgentPermissions(storage.current.metadata.participants[0].permissions).webAccess, true);
});

test("a later message from another device does not ask for a title", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  conversation.messages.push({ id: "second", role: "user", content: "And this.", createdAt: NOW, status: "done", metadata: { threadId: "second", deliveryTargets: [participant.id] } as any });
  const prompts: string[] = [];
  const { service, storage, tempRoot } = testService({ conversation, run: async (member, prompt) => {
    prompts.push(String(prompt));
    return { participant: member, ok: true, content: "Answer", durationMs: 1 };
  } });
  service.setServerLink(fakeServerLink("desktop-device"));
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  await service.startServerTurn({ runId: hubTurnRunId("second", participant.id), conversationId: conversation.id, messageId: "second", participantId: participant.id, state: "requested" });
  await waitFor(() => prompts.length === 1);
  assert.doesNotMatch(prompts[0], /app_chat_set_title/);
  assert.equal(storage.current.metadata.autoTitleEligibility, undefined);
});

test("member ownership: native entry and compact refuse a foreign member before creating a session", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation, run: async () => { throw new Error("must not run native"); } });
  service.setHostMachineId("machine-1");
  const link = fakeServerLink("machine-device");
  service.setServerLink(link);
  // A turn the server asks of a member that is not this machine's is not taken here.
  await service.startServerTurn({ runId: "turn-foreign-run", conversationId: conversation.id, messageId: "user-message", participantId: participant.id, state: "requested" });
  assert.equal(link.ops.some((op) => op.kind === "turn.claim"), false);
  service.setServerLink(undefined);
  await assert.rejects(service.compactParticipant({ conversationId: conversation.id, participantId: participant.id }), /another machine/);
  await assert.rejects(service.requestParticipantsFromTool(participantRequestActor(participant), {
    requests: [{ target: "someone", prompt: "Do work" }]
  }), /another machine/);
  assert.equal(storage.current.metadata.participantSessions, undefined);
});

test("a placeholder that went (its member's bubble arrived, or its turn never ran) does not come back with a copy of the chat read before it went", async () => {
  const participant = { ...chatParticipant("codex-cli"), homeMachineId: "machine-1" };
  const conversation = chatConversation([participant]);
  conversation.messages.push(pendingParticipantMessage(participant, "placeholder-1", "turn-1", { metadata: { runId: "turn-1", serverPlaceholder: true, machinePending: { machineName: "Cloud machine", at: NOW } } }));
  const { service, storage } = testService({ conversation });
  const internals = chatParts(service);
  // Another send holds its own copy, read while the placeholder stood.
  const stale = clone(storage.current) as Conversation;
  const current = clone(storage.current) as Conversation;
  await internals.serverPlaceholders.dropServerPlaceholder(current, "placeholder-1");
  await service.settleChatSaves();
  assert.equal(storage.current.messages.some((message: ChatMessage) => message.id === "placeholder-1"), false);
  // That copy writes next: what it adds stays, the placeholder does not return.
  await internals.store.withChatMutation(stale, async () => {
    stale.messages.push({ id: "later", role: "system", content: "Later.", createdAt: NOW, status: "done" } as ChatMessage);
    internals.store.queueSnapshot(stale);
  });
  await service.settleChatSaves();
  assert.deepEqual(storage.current.messages.map((message: ChatMessage) => message.id).filter((id: string) => id === "placeholder-1" || id === "later"), ["later"]);
});

test("a moved member's note goes with its turns until one is answered, and only then is gone", async () => {
  const prompts: string[] = [];
  let ok = false;
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant], {
    participantSessions: [{ participantId: participant.id, sessionId: "sess-moved", roleConfigId: ROLE.id, roleConfigVersion: ROLE.version, roleLabel: ROLE.label,
      roleInstructions: ROLE.instructions, updatedAt: NOW, movedHere: { from: "cloud machine Box", to: "the User's computer", at: NOW } }]
  });
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant, prompt) => {
      prompts.push(String(prompt));
      return ok
        ? { participant: runParticipant, ok: true, content: "done", durationMs: 1, sessionId: "sess-moved" }
        : { participant: runParticipant, ok: false, content: "", error: "The command was cancelled before native execution started.", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  const turn = (runId: string) => chatParts(service).turnQueue.runParticipantTurnSerialized(storage.current, participant, storage.current.messages[0], runId, undefined, undefined, { warnings: [] })
    .catch(() => undefined);
  const moved = () => storage.current.metadata.participantSessions.find((session: any) => session.participantId === participant.id)?.movedHere;

  await turn("never-started");
  assert.match(prompts[0], /Your session was moved from cloud machine Box to the User's computer/);
  assert.ok(moved(), "a turn its CLI never answered leaves the note for the next one");
  ok = true;
  await turn("answered");
  assert.match(prompts[1], /Note from AccordAgents: you moved/);
  assert.equal(moved(), undefined, "told once");
  await turn("later");
  assert.equal(prompts[2].includes("Note from AccordAgents"), false);
});

test("the effort's Default really resets: an effort sent as none is the CLI's own again; one not sent stays", async () => {
  const codex = { ...chatParticipant("codex-cli"), reasoningEffort: "high" as const };
  const conversation = chatConversation([codex]);
  const { service, storage } = testService({ conversation });
  const effort = (): unknown => (storage.current.metadata.participants as ChatParticipant[])[0]?.reasoningEffort;
  await service.updateParticipantRuntime({ conversationId: conversation.id, participantId: codex.id, model: "gpt-5.5-mini" });
  assert.equal(effort(), "high", "a change that does not name the effort keeps it");
  await service.updateParticipantRuntime({ conversationId: conversation.id, participantId: codex.id, reasoningEffort: "" as never });
  assert.equal(effort(), undefined, "the sessions picker's Default (\"\")");
  await service.updateParticipantRuntime({ conversationId: conversation.id, participantId: codex.id, reasoningEffort: "low" });
  await service.updateParticipantRuntime({ conversationId: conversation.id, participantId: codex.id, reasoningEffort: undefined, model: undefined });
  assert.equal(effort(), undefined, "the classic picker's Default (sent as undefined) resets too");
  await service.updateParticipantRuntime({ conversationId: conversation.id, participantId: codex.id, model: "" });
  assert.equal((storage.current.metadata.participants as ChatParticipant[])[0]?.model, undefined, "the model's Default (\"\") resets the model");
});

test("a member's first turn that fails on a CLI that is not ready on this computer says why in the reply (a chat the phone made); the run still decides", async () => {
  const runs: unknown[] = [];
  const claude = chatParticipant("claude-code");
  const conversation = chatConversation([claude]);
  const { service, storage, tempRoot } = testService({
    conversation,
    agents: [
      { kind: "codex-cli", label: "Codex CLI", installed: true, detection: "detected", runnable: "ready", authentication: "ready" },
      { kind: "claude-code", label: "Claude Code", installed: true, detection: "detected", runnable: "ready", authentication: "required" }
    ],
    run: async (participant: ParticipantConfig) => { runs.push(participant); return { participant, ok: false, content: "", error: "Not logged in", durationMs: 1 }; }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  await service.sendMessage({ conversationId: conversation.id, runId: "run-first", content: "@drew hello" });
  await waitFor(() => storage.current.messages.some((message: ChatMessage) => message.participantId === claude.id && message.status === "error"));
  const reply = storage.current.messages.find((message: ChatMessage) => message.participantId === claude.id)!;
  assert.equal(reply.content, "@drew cannot start on this computer: Claude Code requires sign-in. Fix it in Settings → Local CLI setup, or start the chat on another provider.");
  assert.equal(runs.length, 1, "the CLI was tried: readiness can be stale, the run decides");
});

test("a model list that fails is tried again after a minute, never replacing the last good one, and a failure alone publishes nothing", { timeout: 10_000 }, async () => {
  const { service } = testService({
    agents: [{ kind: "codex-cli", label: "Codex CLI", installed: true, detection: "detected", runnable: "ready", authentication: "ready" }],
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE], providers: [{ kind: "codex-cli", label: "Codex CLI", enabled: true }] }
  });
  let fail = true;
  let reads = 0;
  (chatDependencies(service).cliRunner).listModelCatalog = async () => {
    reads += 1;
    if (fail) throw new Error("Codex is signed out");
    return { kind: "codex-cli", authoritative: true, fetchedAt: NOW, models: [{ id: "gpt-5.5", label: "GPT-5.5", recommended: true, source: "cli" }, { id: "gpt-5.5-mini", label: "GPT-5.5 mini", source: "cli" }] };
  };
  let republished = 0;
  chatParts(service).newChatOffers.onNewChatOffersChanged = () => { republished += 1; };
  await service.newChatOptions([]);
  await service.settleNewChatModelCatalogsForTests();
  await service.newChatOptions([]);
  await service.settleNewChatModelCatalogsForTests();
  assert.equal(reads, 1, "a failed read is not tried again at once (a signed-out CLI is not asked on every publish)");
  assert.equal(republished, 0, "nothing changed");
  const entry = Array.from((chatParts(service).newChatOffers.mainSessionCatalogs as Map<string, { failedAt?: number; readAt: number }>).values())[0]!;
  entry.failedAt = Date.now() - 61_000;
  fail = false;
  await service.newChatOptions([]);
  await service.settleNewChatModelCatalogsForTests();
  assert.equal(reads, 2);
  assert.equal(republished, 1);
  fail = true;
  entry.readAt = Date.now() - 11 * 60_000;
  await service.newChatOptions([]);
  await service.settleNewChatModelCatalogsForTests();
  const offer = await service.newChatOptions([]);
  assert.deepEqual(offer?.mainSessionProviders?.[0]?.models.map((model) => model.id), ["gpt-5.5-mini"], "the last good list stays through a failed refresh");
  assert.equal(republished, 1, "and a flapping read publishes nothing");
});

test("a member's own failure in the last seconds of a quit still says what failed", async () => {
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant]);
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant) => ({ participant: runParticipant, ok: false,
      content: `${runParticipant.label} could not finish because Claude Code needs authorization.`, error: "Please run /login: authentication required", durationMs: 1 })
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  service.beginQuit();
  await chatParts(service).turnQueue.runParticipantTurnSerialized(storage.current, participant, storage.current.messages[0], "run-quit-auth", undefined, undefined, { warnings: [] })
    .catch(() => undefined);
  const reply = storage.current.messages.filter((message: ChatMessage) => message.role === "participant").at(-1)!;
  assert.equal(reply.status, "error");
  assert.match(reply.content, /needs authorization/);
  assert.equal(reply.metadata?.terminalReason, undefined, "not stopped by the quit");
});
