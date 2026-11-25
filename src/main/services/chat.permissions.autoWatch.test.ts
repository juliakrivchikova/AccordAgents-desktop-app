import assert from "node:assert/strict";
import test from "node:test";
import { chatParts } from "./chat/test/chatParts";
import { hubTurnRunId } from "../../shared/hubOps";
import { defaultChatAgentPermissions } from "../../shared/agentPermissions";
import type { ChatMessage, ChatParticipant, ChatParticipantConfig, ChatRoleConfig, ParticipantConfig } from "../../shared/types";
import {
  ADMIN_ROLE, chatConversation, chatParticipant, clone, fakeServerLink, NOW, participantManagerActor, participantReplyMessage,
  participantRequestActor, pendingParticipantMessage, removalTrio, ROLE, startMemberTurn, testService, timelineMessage, waitFor
} from "./chat/test/permissionFixtures";

test("auto-watch runtime update enforces one watcher and clears scheduler state on disable", async () => {
  const codex = chatParticipant("codex-cli");
  const drew = chatParticipant("claude-code");
  const conversation = chatConversation([codex, drew]);
  const { service, storage } = testService({ conversation });
  const scheduled: Array<{ conversationId: string; reason: string }> = [];
  chatParts(service).autoWatch.scheduleAutoWatchEvaluation = (conversationId: string, reason: string) => {
    scheduled.push({ conversationId, reason });
  };

  await service.updateParticipantRuntime({
    conversationId: conversation.id,
    participantId: codex.id,
    autoWatch: true
  });

  let participants = storage.current.metadata.participants as ChatParticipant[];
  assert.equal(participants.find((participant) => participant.id === codex.id)?.autoWatch, true);
  assert.equal(storage.current.metadata.participantWatchers[codex.id].wakeChainDepth, 0);
  assert.deepEqual(scheduled, [{ conversationId: conversation.id, reason: "toggle-on" }]);

  await assert.rejects(
    () => service.updateParticipantRuntime({
      conversationId: conversation.id,
      participantId: drew.id,
      autoWatch: true
    }),
    /Only one member can watch a chat/
  );

  await service.updateParticipantRuntime({
    conversationId: conversation.id,
    participantId: codex.id,
    autoWatch: false
  });

  participants = storage.current.metadata.participants as ChatParticipant[];
  assert.equal(participants.find((participant) => participant.id === codex.id)?.autoWatch, false);
  assert.equal(storage.current.metadata.participantWatchers, undefined);
});

test("permission runtime update with unchanged auto-watch does not schedule a watcher run", async () => {
  const codex = { ...chatParticipant("codex-cli"), autoWatch: true };
  const watcherState = {
    [codex.id]: {
      lastSeenMessageId: "user-message",
      wakeChainDepth: 1,
      updatedAt: NOW
    }
  };
  const conversation = chatConversation([codex], { participantWatchers: watcherState });
  const { service, storage } = testService({ conversation });
  const scheduled: Array<{ conversationId: string; reason: string }> = [];
  chatParts(service).autoWatch.scheduleAutoWatchEvaluation = (conversationId: string, reason: string) => {
    scheduled.push({ conversationId, reason });
  };
  const permissions = {
    ...defaultChatAgentPermissions(),
    repoRead: true,
    workspaceWrite: true
  };

  await service.updateParticipantRuntime({
    conversationId: conversation.id,
    participantId: codex.id,
    permissions,
    autoWatch: true
  });

  const participants = storage.current.metadata.participants as ChatParticipant[];
  const updated = participants.find((participant) => participant.id === codex.id);
  assert.equal(updated?.autoWatch, true);
  assert.equal(updated?.permissions?.repoRead, true);
  assert.equal(updated?.permissions?.workspaceWrite, true);
  assert.deepEqual(storage.current.metadata.participantWatchers, watcherState);
  assert.deepEqual(scheduled, []);
});

test("Workflow Manager default-on seeding keeps only one active watcher", async () => {
  const workflowRole: ChatRoleConfig = {
    ...ROLE,
    id: "workflow-manager",
    label: "Workflow Manager",
    participantDefaults: {
      autoWatch: true,
      requestParticipants: "allow",
      manageRolesParticipants: "allow"
    }
  };
  const codex = { ...chatParticipant("codex-cli"), autoWatch: true };
  const conversation = chatConversation([codex]);
  const { service, storage, tempRoot } = testService({
    conversation,
    settings: { chatRoleConfigs: [ROLE, workflowRole] }
  });
  const scheduled: Array<{ conversationId: string; reason: string }> = [];
  chatParts(service).autoWatch.scheduleAutoWatchEvaluation = (conversationId: string, reason: string) => {
    scheduled.push({ conversationId, reason });
  };

  await service.addParticipant({
    conversationId: conversation.id,
    participant: { handle: "wm2", roleConfigId: workflowRole.id, kind: "codex-cli" }
  });

  let participants = storage.current.metadata.participants as ChatParticipant[];
  const added = participants.find((participant) => participant.handle === "wm2");
  assert.equal(added?.autoWatch, false);
  assert.equal(added?.permissions?.requestParticipants, "allow");
  assert.equal(added?.permissions?.manageRolesParticipants, undefined);
  assert.deepEqual(scheduled, []);

  participants = participants.map((participant) => ({ ...participant, autoWatch: false }));
  storage.current = chatConversation(participants, { participantWatchers: undefined });
  await service.addParticipant({
    conversationId: conversation.id,
    participant: { handle: "wm3", roleConfigId: workflowRole.id, kind: "codex-cli" }
  });

  participants = storage.current.metadata.participants as ChatParticipant[];
  assert.equal(participants.find((participant) => participant.handle === "wm3")?.autoWatch, true);
  assert.equal(participants.find((participant) => participant.handle === "wm3")?.permissions?.requestParticipants, "allow");
  assert.equal(participants.find((participant) => participant.handle === "wm3")?.permissions?.manageRolesParticipants, undefined);
  assert.deepEqual(scheduled, [{ conversationId: conversation.id, reason: "participant-added" }]);
});

test("auto-watch evaluation dispatches watcher from new participant output", async () => {
  const manager = { ...chatParticipant("codex-cli"), autoWatch: true };
  const worker = chatParticipant("claude-code");
  const conversation = chatConversation([manager, worker], {
    participantWatchers: {
      [manager.id]: {
        lastSeenMessageId: "user-message",
        wakeChainDepth: 0,
        updatedAt: NOW
      }
    }
  });
  conversation.messages.push(timelineMessage("worker-reply", "Worker is done.", {
    role: "participant",
    participantId: worker.id,
    participantLabel: `@${worker.handle}`,
    metadata: { threadId: "user-message" }
  }));
  const runs: Array<{ participant: ParticipantConfig; prompt: string }> = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    agents: [
      { kind: "codex-cli", label: "Codex CLI", installed: true },
      { kind: "claude-code", label: "Claude Code", installed: true }
    ],
    run: async (participant, prompt) => {
      runs.push({ participant, prompt });
      return {
        participant,
        ok: true,
        content: "Manager evaluated.",
        durationMs: 1
      };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  await chatParts(service).autoWatch.runAutoWatchEvaluation(conversation.id, "test");
  await waitFor(() => runs.length === 1);

  assert.equal(runs[0].participant.id, manager.id);
  assert.match(runs[0].prompt, /Auto-watch trigger/);
  const trigger = storage.current.messages.find((message: ChatMessage) => message.metadata?.autoWatchTrigger);
  assert.ok(trigger);
  assert.equal(trigger.metadata?.autoWatchTrigger?.participantId, manager.id);
  assert.deepEqual(trigger.metadata?.autoWatchTrigger?.messageIds, ["worker-reply"]);
});

test("auto-watch cursor is not advanced when watcher dispatch fails before run starts", async () => {
  const manager = { ...chatParticipant("codex-cli"), autoWatch: true };
  const worker = chatParticipant("claude-code");
  const conversation = chatConversation([manager, worker], {
    participantWatchers: {
      [manager.id]: {
        lastSeenMessageId: "user-message",
        wakeChainDepth: 0,
        updatedAt: NOW
      }
    }
  });
  conversation.messages.push(timelineMessage("worker-reply", "Worker is done.", {
    role: "participant",
    participantId: worker.id,
    participantLabel: `@${worker.handle}`,
    metadata: { threadId: "user-message" }
  }));
  const { service, storage } = testService({
    conversation,
    agents: [
      { kind: "codex-cli", label: "Codex CLI", installed: true },
      { kind: "claude-code", label: "Claude Code", installed: true }
    ]
  });
  let dispatchCalled = false;
  chatParts(service).participantBatch.runParticipantBatch = async () => {
    dispatchCalled = true;
    throw new Error("dispatch failed before begin");
  };

  await chatParts(service).autoWatch.runAutoWatchEvaluation(conversation.id, "test");
  await waitFor(() => storage.current.metadata.participantWatchers?.[manager.id]?.pausedReason === "error");

  assert.equal(dispatchCalled, true);
  assert.equal(storage.current.metadata.participantWatchers?.[manager.id]?.lastSeenMessageId, "user-message");
  assert.equal(storage.current.metadata.participantWatchers?.[manager.id]?.wakeChainDepth, 0);
  assert.ok(storage.current.messages.find((message: ChatMessage) => message.metadata?.autoWatchTrigger));
});

test("auto-watch schedules after background participant output drains", async () => {
  const manager = { ...chatParticipant("codex-cli"), autoWatch: true };
  const worker = chatParticipant("claude-code");
  const conversation = chatConversation([manager, worker], {
    running: true,
    participantWatchers: {
      [manager.id]: {
        lastSeenMessageId: "user-message",
        wakeChainDepth: 0,
        updatedAt: NOW
      }
    }
  });
  const { service, storage } = testService({ conversation });
  const scheduled: Array<{ conversationId: string; reason: string }> = [];
  chatParts(service).autoWatch.scheduleAutoWatchEvaluation = (conversationId: string, reason: string) => {
    scheduled.push({ conversationId, reason });
  };

  chatParts(service).activeRuns.incrementBackgroundRunner(conversation.id);
  await chatParts(service).pendingReplies.appendParticipantTurnMessages(conversation, worker, [
    timelineMessage("worker-delayed", "Delayed reply.", {
      role: "participant",
      participantId: worker.id,
      participantLabel: `@${worker.handle}`,
      metadata: { threadId: "user-message" }
    })
  ]);
  storage.current = clone(conversation);

  assert.deepEqual(scheduled, []);

  chatParts(service).activeRuns.decrementBackgroundRunner(conversation.id);
  await waitFor(() => scheduled.length === 1);

  assert.deepEqual(scheduled, [{ conversationId: conversation.id, reason: "background-runner-idle" }]);
  assert.equal(storage.current.metadata.running, false);
});

test("auto-watch evaluation launches the watcher from another member's output", async () => {
  const manager = { ...chatParticipant("codex-cli"), autoWatch: true };
  const worker = chatParticipant("claude-code");
  const conversation = chatConversation([manager, worker], {
    participantWatchers: {
      [manager.id]: {
        lastSeenMessageId: "user-message",
        wakeChainDepth: 0,
        updatedAt: NOW
      }
    }
  });
  conversation.messages.push(timelineMessage("worker-reply", "Worker is done.", {
    role: "participant",
    participantId: worker.id,
    participantLabel: `@${worker.handle}`,
    metadata: { threadId: "user-message" }
  }));
  const runs: Array<{ participantId: string; prompt: string }> = [];
  const { service, tempRoot } = testService({
    conversation,
    agents: [
      { kind: "codex-cli", label: "Codex CLI", installed: true },
      { kind: "claude-code", label: "Claude Code", installed: true }
    ],
    run: async (participant, prompt) => {
      runs.push({ participantId: participant.id, prompt: String(prompt ?? "") });
      return { participant, ok: true, content: "watched", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  await chatParts(service).autoWatch.runAutoWatchEvaluation(conversation.id, "test");
  await waitFor(() => runs.length > 0);

  assert.equal(runs[0].participantId, manager.id);
  assert.match(runs[0].prompt, /Auto-watch trigger/);
});

test("directly targeted auto-watch participant does not reprocess the trigger user message", async () => {
  const manager = { ...chatParticipant("codex-cli"), autoWatch: true };
  const conversation = chatConversation([manager]);
  const runs: ParticipantConfig[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    agents: [{ kind: "codex-cli", label: "Codex CLI", installed: true }],
    run: async (participant) => {
      runs.push(participant);
      return {
        participant,
        ok: true,
        content: "Direct response.",
        durationMs: 1
      };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  await service.sendMessage({ conversationId: conversation.id, content: "@codex please handle this." });
  await waitFor(() => runs.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 150));

  const userMessage = storage.current.messages.find((message: ChatMessage) =>
    message.role === "user" && message.content.includes("please handle this")
  );
  assert.ok(userMessage);
  assert.equal(storage.current.metadata.participantWatchers?.[manager.id]?.lastSeenMessageId, userMessage.id);
  assert.equal(storage.current.messages.some((message: ChatMessage) => message.metadata?.autoWatchTrigger), false);
  assert.equal(runs.length, 1);
});

test("auto-watch wake limit pauses and toggle off-on clears pause state", async () => {
  const manager = { ...chatParticipant("codex-cli"), autoWatch: true };
  const worker = chatParticipant("claude-code");
  const conversation = chatConversation([manager, worker], {
    participantWatchers: {
      [manager.id]: {
        lastSeenMessageId: "user-message",
        wakeChainDepth: 1,
        updatedAt: NOW
      }
    }
  });
  conversation.messages.push(timelineMessage("worker-reply", "Worker is done.", {
    role: "participant",
    participantId: worker.id,
    participantLabel: `@${worker.handle}`,
    metadata: { threadId: "user-message" }
  }));
  const runs: ParticipantConfig[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    settings: { chatRoleConfigs: [ROLE], chatAutoWatchWakeLimit: 1 },
    run: async (participant) => {
      runs.push(participant);
      return {
        participant,
        ok: true,
        content: "Should not run while paused.",
        durationMs: 1
      };
    }
  });

  await chatParts(service).autoWatch.runAutoWatchEvaluation(conversation.id, "test");

  assert.equal(runs.length, 0);
  assert.equal(storage.current.metadata.participantWatchers?.[manager.id]?.pausedReason, "wake-limit");

  await service.updateParticipantRuntime({
    conversationId: conversation.id,
    participantId: manager.id,
    autoWatch: false
  });
  await service.updateParticipantRuntime({
    conversationId: conversation.id,
    participantId: manager.id,
    autoWatch: true
  });

  const watcher = storage.current.metadata.participantWatchers?.[manager.id];
  assert.equal(watcher?.pausedReason, undefined);
  assert.equal(watcher?.wakeChainDepth, 0);
});

test("auto-watch eligible scan excludes self, system, pending, and hidden messages", async () => {
  const manager = { ...chatParticipant("codex-cli"), autoWatch: true };
  const worker = chatParticipant("claude-code");
  const conversation = chatConversation([manager, worker], {
    participantWatchers: {
      [manager.id]: {
        lastSeenMessageId: "user-message",
        wakeChainDepth: 0,
        updatedAt: NOW
      }
    }
  });
  // All pushed after the cursor. Only the final worker reply is eligible;
  // the manager's own output, a system message, a pending (streaming) message,
  // and a hidden message must be excluded from the scan.
  conversation.messages.push(timelineMessage("manager-self", "Manager's own note.", {
    role: "participant",
    participantId: manager.id,
    participantLabel: `@${manager.handle}`,
    metadata: { threadId: "user-message" }
  }));
  conversation.messages.push(timelineMessage("system-note", "System notice.", {
    role: "system",
    metadata: { threadId: "user-message" }
  }));
  conversation.messages.push(timelineMessage("pending-reply", "Still streaming.", {
    role: "participant",
    participantId: worker.id,
    participantLabel: `@${worker.handle}`,
    status: "pending",
    metadata: { threadId: "user-message" }
  }));
  conversation.messages.push(timelineMessage("hidden-note", "Hidden housekeeping.", {
    role: "participant",
    participantId: worker.id,
    participantLabel: `@${worker.handle}`,
    metadata: { threadId: "user-message", hiddenFromTimeline: true }
  }));
  conversation.messages.push(timelineMessage("worker-reply", "Worker is done.", {
    role: "participant",
    participantId: worker.id,
    participantLabel: `@${worker.handle}`,
    metadata: { threadId: "user-message" }
  }));
  const runs: Array<{ participant: ParticipantConfig; prompt: string }> = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    agents: [
      { kind: "codex-cli", label: "Codex CLI", installed: true },
      { kind: "claude-code", label: "Claude Code", installed: true }
    ],
    run: async (participant, prompt) => {
      runs.push({ participant, prompt });
      return { participant, ok: true, content: "Manager evaluated.", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  await chatParts(service).autoWatch.runAutoWatchEvaluation(conversation.id, "test");
  await waitFor(() => runs.length === 1);

  assert.equal(runs[0].participant.id, manager.id);
  const trigger = storage.current.messages.find((message: ChatMessage) => message.metadata?.autoWatchTrigger);
  assert.ok(trigger);
  // Only the eligible worker reply is carried into the trigger; the excluded
  // messages would appear here if the scan let them through.
  assert.deepEqual(trigger.metadata?.autoWatchTrigger?.messageIds, ["worker-reply"]);
});

test("auto-watch depth resets when the user sends a new message", async () => {
  const manager = { ...chatParticipant("codex-cli"), autoWatch: true };
  const conversation = chatConversation([manager], {
    participantWatchers: {
      [manager.id]: {
        lastSeenMessageId: "user-message",
        wakeChainDepth: 4,
        updatedAt: NOW
      }
    }
  });
  const runs: ParticipantConfig[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    agents: [{ kind: "codex-cli", label: "Codex CLI", installed: true }],
    run: async (participant) => {
      runs.push(participant);
      return { participant, ok: true, content: "Handled.", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  // Keep the assertion about depth-reset only: suppress the follow-on evaluation
  // so it cannot re-increment the counter we are checking.
  chatParts(service).autoWatch.scheduleAutoWatchEvaluation = () => {};

  await service.sendMessage({ conversationId: conversation.id, content: "@codex next step." });
  await waitFor(() => runs.length === 1);

  assert.equal(storage.current.metadata.participantWatchers?.[manager.id]?.wakeChainDepth, 0);
});

test("auto-watch does not wake a watcher after it is toggled off", async () => {
  const manager = { ...chatParticipant("codex-cli"), autoWatch: true };
  const worker = chatParticipant("claude-code");
  const conversation = chatConversation([manager, worker], {
    participantWatchers: {
      [manager.id]: {
        lastSeenMessageId: "user-message",
        wakeChainDepth: 0,
        updatedAt: NOW
      }
    }
  });
  conversation.messages.push(timelineMessage("worker-reply", "Worker is done.", {
    role: "participant",
    participantId: worker.id,
    participantLabel: `@${worker.handle}`,
    metadata: { threadId: "user-message" }
  }));
  const runs: ParticipantConfig[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    agents: [
      { kind: "codex-cli", label: "Codex CLI", installed: true },
      { kind: "claude-code", label: "Claude Code", installed: true }
    ],
    run: async (participant) => {
      runs.push(participant);
      return { participant, ok: true, content: "Should not run.", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  await service.updateParticipantRuntime({
    conversationId: conversation.id,
    participantId: manager.id,
    autoWatch: false
  });
  assert.equal(storage.current.metadata.participantWatchers, undefined);

  await chatParts(service).autoWatch.runAutoWatchEvaluation(conversation.id, "test");
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(runs.length, 0);
  assert.equal(storage.current.messages.some((message: ChatMessage) => message.metadata?.autoWatchTrigger), false);
});

test("a watcher the User turns back on is not paused again by a running member's older copy", async () => {
  const { worker, target, conversation } = removalTrio();
  conversation.metadata = {
    ...conversation.metadata,
    participants: (conversation.metadata.participants as ChatParticipant[]).map((participant) => participant.id === target.id ? { ...participant, autoWatch: true } : participant),
    participantWatchers: { [target.id]: { wakeChainDepth: 3, pausedReason: "wake-limit", updatedAt: "2026-01-01T00:00:00.000Z" } }
  };
  const { service, storage } = testService({ conversation });
  const workerCopy = await startMemberTurn(service, storage, worker, "worker-run");
  await service.updateParticipantRuntime({ conversationId: conversation.id, participantId: target.id, autoWatch: false });
  await service.updateParticipantRuntime({ conversationId: conversation.id, participantId: target.id, autoWatch: true });

  await chatParts(service).store.withChatMutation(workerCopy, async () => {
    await chatParts(service).store.saveConversation(workerCopy);
  });
  const watcher = storage.current.metadata.participantWatchers?.[target.id];
  assert.ok(watcher, "the target still watches");
  assert.equal(watcher.pausedReason, undefined);
  assert.equal(watcher.wakeChainDepth, 0);
});

test("adding saved auto-watch participant through app tool keeps the existing watcher", async () => {
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const currentWatcher = {
    ...chatParticipant("claude-code"),
    id: "current-watcher",
    handle: "watcher",
    autoWatch: true
  };
  const savedParticipant: ChatParticipantConfig = {
    id: "saved-manager",
    handle: "saved-manager",
    roleConfigId: ROLE.id,
    behaviorRuleIds: [],
    kind: "codex-cli",
    autoWatchEnabled: true,
    updatedAt: NOW
  };
  const conversation = chatConversation([assistant, currentWatcher]);
  const { service, storage } = testService({
    conversation,
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE], chatParticipantConfigs: [savedParticipant] }
  });
  const actor = participantManagerActor(conversation.id, assistant);

  const requested = await service.requestParticipantChangeFromTool(actor, {
    operations: [{
      type: "add_existing_participant_to_chat",
      participantConfigId: savedParticipant.id
    }]
  });

  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: requested.approvalId as string,
    approve: true
  });

  const participants = storage.current.metadata.participants as ChatParticipant[];
  assert.equal(participants.find((participant) => participant.id === currentWatcher.id)?.autoWatch, true);
  assert.equal(participants.find((participant) => participant.handle === "saved-manager")?.autoWatch, false);
});

for (const route of [
  { label: "desktop watcher on desktop", runtime: false, host: undefined, home: undefined, expected: 1 },
  { label: "cloud watcher on desktop", runtime: false, host: undefined, home: "machine-1", expected: 0 },
  { label: "own watcher on machine", runtime: true, host: "machine-1", home: "machine-1", expected: 1 },
  { label: "desktop watcher on machine", runtime: true, host: "machine-1", home: undefined, expected: 0 },
  { label: "another machine's watcher", runtime: true, host: "machine-1", home: "machine-2", expected: 0 },
  { label: "machine awaiting identity", runtime: true, host: undefined, home: undefined, expected: 0 }
]) {
  test(`member ownership: auto-watch ${route.label}`, async () => {
    const watcher = { ...chatParticipant("codex-cli"), autoWatch: true, homeMachineId: route.home };
    const worker = chatParticipant("claude-code");
    const conversation = chatConversation([watcher, worker], {
      participantWatchers: { [watcher.id]: { lastSeenMessageId: "user-message", wakeChainDepth: 0, updatedAt: NOW } }
    });
    conversation.messages.push(participantReplyMessage(worker, "worker-reply", "Done."));
    const runs: string[] = [];
    const { service, storage, tempRoot } = testService({ conversation, run: async participant => {
      runs.push(participant.id);
      return { participant, ok: true, content: "Noted", durationMs: 1 };
    } });
    chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
    if (route.runtime) service.setHostMachineId(route.host);

    await chatParts(service).autoWatch.runAutoWatchEvaluation(conversation.id, "ownership-test");
    if (route.expected) await waitFor(() => runs.length === 1 && !storage.current.metadata.running);
    assert.equal(runs.length, route.expected);
    assert.equal(storage.current.messages.filter((m: ChatMessage) => m.metadata?.autoWatchTrigger).length, route.expected);
    if (!route.expected) assert.equal(storage.current.metadata.participantSessions, undefined);

    // A new service reads the durable cursor rather than waking again for the
    // same replicated message after a restart.
    const restarted = testService({ conversation: storage.current, run: async () => { throw new Error("duplicate watcher run"); } });
    if (route.runtime) restarted.service.setHostMachineId(route.host);
    await chatParts(restarted.service).autoWatch.runAutoWatchEvaluation(conversation.id, "restart");
    assert.equal(restarted.storage.current.messages.filter((m: ChatMessage) => m.metadata?.autoWatchTrigger).length, route.expected);
  });
}

test("member ownership: direct machine turn advances its own watcher cursor", async () => {
  const participant = { ...chatParticipant("codex-cli"), homeMachineId: "machine-1", autoWatch: true };
  const conversation = chatConversation([participant]);
  const runs: string[] = [];
  const { service, storage, tempRoot } = testService({ conversation, run: async participant => {
    runs.push(participant.id);
    return { participant, ok: true, content: "Direct answer", durationMs: 1 };
  } });
  service.setHostMachineId("machine-1");
  service.setServerLink(fakeServerLink("machine-device"));
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  await service.startServerTurn({ runId: "turn-direct-machine-run", conversationId: conversation.id, messageId: "user-message", participantId: participant.id,
    state: "requested", pendingMessageId: "direct-machine-pending" });
  await chatParts(service).autoWatch.runAutoWatchEvaluation(conversation.id, "after-direct-turn");
  assert.deepEqual(runs, [participant.id]);
  assert.equal(storage.current.metadata.participantWatchers[participant.id].lastSeenMessageId, "user-message");
  assert.equal(storage.current.messages.some((m: ChatMessage) => m.metadata?.autoWatchTrigger), false);
});

test("auto-watch never wakes a member for a User's message asked of it, and its late own turn does not wake it again for what came after", async () => {
  // As on a machine: the User's message (asking the watcher and another
  // member) is there before the watcher's own turn starts.
  const watcher = { ...chatParticipant("codex-cli"), homeMachineId: "machine-1", autoWatch: true };
  const worker = chatParticipant("claude-code");
  const conversation = chatConversation([watcher, worker], {
    participantWatchers: { [watcher.id]: { wakeChainDepth: 0, updatedAt: NOW } }
  });
  conversation.messages[0].metadata = { threadId: "user-message", deliveryTargets: [watcher.id, worker.id] } as any;
  const runs: string[] = [];
  const { service, storage, tempRoot } = testService({ conversation, run: async participant => {
    runs.push(participant.id);
    return { participant, ok: true, content: "Observed", durationMs: 1 };
  } });
  service.setHostMachineId("machine-1");
  service.setServerLink(fakeServerLink("machine-device"));
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  const triggers = () => storage.current.messages.filter((m: ChatMessage) => m.metadata?.autoWatchTrigger);

  await chatParts(service).autoWatch.runAutoWatchEvaluation(conversation.id, "server-messages");
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(runs, [], "its own turn answers the message it was asked");
  assert.equal(triggers().length, 0);

  // The other member's reply arrives while the watcher's own turn is still
  // being readied: news to the watcher, it wakes for that alone.
  storage.current.messages.push(participantReplyMessage(worker, "worker-reply", "Done"));
  await chatParts(service).autoWatch.runAutoWatchEvaluation(conversation.id, "server-messages");
  await waitFor(() => runs.length === 1 && !storage.current.metadata.running);
  assert.deepEqual(triggers().map((m: ChatMessage) => m.metadata!.autoWatchTrigger!.messageIds), [["worker-reply"]]);

  // Its own turn starts now; the cursor stays past the reply it already read.
  await service.startServerTurn({ runId: hubTurnRunId("user-message", watcher.id), conversationId: conversation.id, messageId: "user-message",
    participantId: watcher.id, state: "requested" });
  await waitFor(() => runs.length === 2 && !storage.current.metadata.running);
  assert.equal(storage.current.metadata.participantWatchers[watcher.id].lastSeenMessageId, "worker-reply", "the cursor never moves back");
  await chatParts(service).autoWatch.runAutoWatchEvaluation(conversation.id, "run-idle");
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(runs.length, 2, "once for the User's message, once for the reply");
  assert.equal(triggers().length, 1);
});

test("auto-watch does not wake a member for a User's message that asks it but leaves asking it to the computer", async () => {
  // A cloud member whose machine still gets the project, or an Accord's
  // facilitator: the computer asks it later, the server does not.
  const watcher = { ...chatParticipant("codex-cli"), homeMachineId: "machine-1", autoWatch: true };
  const conversation = chatConversation([watcher], {
    participantWatchers: { [watcher.id]: { wakeChainDepth: 0, updatedAt: NOW } }
  });
  conversation.messages[0].metadata = { threadId: "user-message", deliveryTargets: [], askedParticipantIds: [watcher.id] } as any;
  const runs: string[] = [];
  const { service, storage, tempRoot } = testService({ conversation, run: async participant => {
    runs.push(participant.id);
    return { participant, ok: true, content: "Observed", durationMs: 1 };
  } });
  service.setHostMachineId("machine-1");
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  await chatParts(service).autoWatch.runAutoWatchEvaluation(conversation.id, "server-messages");
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(runs, []);
  assert.equal(storage.current.messages.some((m: ChatMessage) => m.metadata?.autoWatchTrigger), false);
});

test("auto-watch still wakes a member for a User's message that asks only other members", async () => {
  const watcher = { ...chatParticipant("codex-cli"), homeMachineId: "machine-1", autoWatch: true };
  const worker = chatParticipant("claude-code");
  const conversation = chatConversation([watcher, worker], {
    participantWatchers: { [watcher.id]: { wakeChainDepth: 0, updatedAt: NOW } }
  });
  conversation.messages[0].metadata = { threadId: "user-message", deliveryTargets: [worker.id], askedParticipantIds: [worker.id] } as any;
  const runs: string[] = [];
  const { service, storage, tempRoot } = testService({ conversation, run: async participant => {
    runs.push(participant.id);
    return { participant, ok: true, content: "Observed", durationMs: 1 };
  } });
  service.setHostMachineId("machine-1");
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  await chatParts(service).autoWatch.runAutoWatchEvaluation(conversation.id, "server-messages");
  await waitFor(() => runs.length === 1 && !storage.current.metadata.running);
  const trigger = storage.current.messages.find((m: ChatMessage) => m.metadata?.autoWatchTrigger);
  assert.deepEqual(trigger.metadata.autoWatchTrigger.messageIds, ["user-message"]);
});

test("member ownership: replicated replies wake only the owner after the copy barrier", async () => {
  const watcher = { ...chatParticipant("codex-cli"), homeMachineId: "machine-1", autoWatch: true };
  const worker = chatParticipant("claude-code");
  const conversation = chatConversation([watcher, worker], {
    participantWatchers: { [watcher.id]: { lastSeenMessageId: "user-message", wakeChainDepth: 0, updatedAt: NOW } }
  });
  const runs: string[] = [];
  const { service, storage, tempRoot } = testService({ conversation, run: async participant => {
    runs.push(participant.id);
    return { participant, ok: true, content: "Observed", durationMs: 1 };
  } });
  service.setHostMachineId("machine-1");
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  await service.applyReplicatedConversation(conversation.id, previous => ({ ...previous!,
    messages: [...previous!.messages, participantReplyMessage(worker, "replicated-reply", "Done")] }));
  assert.deepEqual(runs, [], "a partial copy must not activate a participant");
  service.onReplicatedConversationReady(conversation.id);
  await waitFor(() => runs.length === 1 && !storage.current.metadata.running);
  service.onReplicatedConversationReady(conversation.id);
  await chatParts(service).autoWatch.runAutoWatchEvaluation(conversation.id, "redelivery");
  assert.deepEqual(runs, [watcher.id]);
  assert.equal(storage.current.metadata.participantWatchers[watcher.id].lastSeenMessageId, "replicated-reply");

  // Disabling and re-enabling is an explicit reset, not a stale cursor from
  // a desktop refresh; the owner must still honor that control.
  await service.applyReplicatedConversation(conversation.id, previous => ({ ...previous!,
    metadata: { ...previous!.metadata, participants: [{ ...watcher, autoWatch: false }, worker] } }));
  await service.applyReplicatedConversation(conversation.id, previous => ({ ...previous!,
    metadata: { ...previous!.metadata, participants: [watcher, worker],
      participantWatchers: { [watcher.id]: { wakeChainDepth: 50, pausedReason: "wake-limit", updatedAt: NOW } } } }));
  assert.equal(storage.current.metadata.participantWatchers[watcher.id].pausedReason, undefined);
  assert.equal(storage.current.metadata.participantWatchers[watcher.id].wakeChainDepth, 0);
});

test("member ownership: a machine watcher waits for the desktop's pending run to finish", async () => {
  const watcher = { ...chatParticipant("codex-cli"), homeMachineId: "machine-1", autoWatch: true };
  const worker = chatParticipant("claude-code");
  const conversation = chatConversation([watcher, worker], {
    participantWatchers: { [watcher.id]: { wakeChainDepth: 0, updatedAt: NOW } }
  });
  conversation.messages.push(pendingParticipantMessage(worker, "desktop-reply", "desktop-run"));
  const runs: string[] = [];
  const { service, storage, tempRoot } = testService({ conversation, run: async participant => {
    runs.push(participant.id);
    return { participant, ok: true, content: "Observed", durationMs: 1 };
  } });
  service.setHostMachineId("machine-1");
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  await chatParts(service).autoWatch.runAutoWatchEvaluation(conversation.id, "replicated-request");
  assert.deepEqual(runs, [], "a remote pending row must hold the same idle gate as a local run");
  await service.applyReplicatedConversation(conversation.id, previous => ({ ...previous!,
    messages: previous!.messages.map(message => message.id === "desktop-reply"
      ? participantReplyMessage(worker, message.id, "Done") : message) }));
  service.onReplicatedConversationReady(conversation.id);
  await waitFor(() => runs.length === 1 && !storage.current.metadata.running);
  const triggers = storage.current.messages.filter((message: ChatMessage) => message.metadata?.autoWatchTrigger);
  assert.equal(triggers.length, 1);
  assert.deepEqual(triggers[0].metadata.autoWatchTrigger.messageIds, ["user-message", "desktop-reply"]);
});

for (const source of ["tool", "inferred"] as const) {
  test(`member ownership: ${source} request does not also auto-watch its source`, async () => {
    const requester = chatParticipant("codex-cli", { requestParticipants: "allow" });
    const watcher = { ...chatParticipant("claude-code"), autoWatch: true };
    const conversation = chatConversation([requester, watcher], {
      participantWatchers: { [watcher.id]: { lastSeenMessageId: "user-message", wakeChainDepth: 0, updatedAt: NOW } }
    });
    const message = participantReplyMessage(requester, "direct-request-source", "@drew Please review.");
    conversation.messages.push(message);
    const runs: string[] = [];
    const { service, storage, tempRoot } = testService({ conversation, run: async participant => {
      runs.push(participant.id);
      return { participant, ok: true, content: "Reviewed", durationMs: 1 };
    } });
    chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
    if (source === "tool") {
      await service.requestParticipantsFromTool({ ...participantRequestActor(requester), triggerMessageId: message.id }, {
        requests: [{ target: watcher.handle, prompt: "Please review." }], timeoutMs: 5000, resumeRequester: false
      });
    } else {
      const requests = await chatParts(service).inferredRequests.createImplicitParticipantRequestApproval(conversation, requester, [message]);
      for (const m of conversation.messages) if (m.metadata?.participantRequest) m.metadata.participantRequest.resumeRequester = false;
      await storage.saveConversation(conversation);
      chatParts(service).participantRequests.startDeferredParticipantRequestRunners(conversation.id, requests);
      await waitFor(() => runs.length === 1 && !storage.current.metadata.running);
    }
    await chatParts(service).autoWatch.runAutoWatchEvaluation(conversation.id, "after-direct-request");
    assert.deepEqual(runs, [watcher.id]);
    assert.equal(storage.current.messages.some((m: ChatMessage) => m.metadata?.autoWatchTrigger), false);
  });
}
