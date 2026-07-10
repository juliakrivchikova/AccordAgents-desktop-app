import assert from "node:assert/strict";
import test from "node:test";
import { ChatService } from "./chat";
import { normalizeAutoChatTitle, sanitizeAutoChatTitleSuggestion } from "../../shared/chatTitles";
import type {
  AgentContextUsage,
  ChatParticipant,
  ChatParticipantConfig,
  ChatParticipantSession,
  ChatRoleConfig,
  Conversation,
  ConversationSummary,
  RemoteSessionCleanupTombstone
} from "../../shared/types";

const NOW = "2026-05-19T12:00:00.000Z";

const ROLE: ChatRoleConfig = {
  id: "engineer",
  label: "Engineer",
  instructions: "Answer directly.",
  version: 1,
  appToolCapabilities: [],
  updatedAt: NOW
};

test("auto chat title sanitizer strips leading participant handles and slash skills", () => {
  assert.equal(
    normalizeAutoChatTitle("@drew-codex-engineer /office-hours I want new feature, assign chat title"),
    "I want new feature, assign chat title"
  );
  assert.equal(sanitizeAutoChatTitleSuggestion("@drew /office-hours"), undefined);
  assert.equal(sanitizeAutoChatTitleSuggestion("Codex"), undefined);
});

test("renameConversation updates chat title, emits a snapshot, and keeps the transcript unchanged", async () => {
  const conversation = chatConversation({ title: "Old chat" });
  const { service, storage, snapshots, historyWrites } = testService([conversation]);

  const saved = await service.renameConversation({
    conversationId: conversation.id,
    title: "  New chat name  "
  });

  assert.equal(saved?.title, "New chat name");
  assert.equal(saved?.messages.length, conversation.messages.length);
  assert.notEqual(saved?.updatedAt, NOW);
  assert.equal((await storage.getConversation(conversation.id))?.title, "New chat name");
  assert.equal(snapshots.at(-1)?.title, "New chat name");
  assert.deepEqual(historyWrites, ["New chat name"]);
});

test("renameConversation normalizes long and blank chat titles", async () => {
  const conversation = chatConversation({ title: "Old chat" });
  const { service, storage } = testService([conversation]);
  const longTitle = ` ${"x".repeat(90)} `;

  const longSaved = await service.renameConversation({
    conversationId: conversation.id,
    title: longTitle
  });
  assert.equal(longSaved?.title, "x".repeat(80));

  const blankSaved = await service.renameConversation({
    conversationId: conversation.id,
    title: "   "
  });
  assert.equal(blankSaved?.title, "Chat");
  assert.equal((await storage.getConversation(conversation.id))?.title, "Chat");
});

test("renameConversation marks the title as manual and clears first-agent title eligibility", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation({
    metadata: {
      participants: [participant],
      participantSessions: [],
      autoTitleEligibility: autoTitleEligibility(participant)
    }
  });
  const { service, storage } = testService([conversation]);

  const saved = await service.renameConversation({
    conversationId: conversation.id,
    title: "Manual title"
  });

  assert.equal(saved?.title, "Manual title");
  assert.equal((saved?.metadata.autoTitle as { source?: string; title?: string } | undefined)?.source, "manual");
  assert.equal((saved?.metadata.autoTitle as { source?: string; title?: string } | undefined)?.title, "Manual title");
  assert.equal(saved?.metadata.autoTitleEligibility, undefined);
  assert.equal((await storage.getConversation(conversation.id))?.metadata.autoTitleEligibility, undefined);
});

test("setChatTitleFromTool applies the first eligible participant title", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation({
    title: "@drew /office-hours I want new feature",
    messages: [
      systemMessage(),
      userMessage("user-message-1", "@drew /office-hours I want new feature")
    ],
    metadata: {
      participants: [participant],
      participantSessions: [],
      autoTitleEligibility: autoTitleEligibility(participant)
    }
  });
  const { service, storage, snapshots, historyWrites } = testService([conversation]);

  const result = await service.setChatTitleFromTool(autoTitleActor(participant), {
    title: "@drew /office-hours First Agent Auto Title?"
  });

  assert.deepEqual(result, {
    ok: true,
    status: "applied",
    title: "First Agent Auto Title",
    conversationId: conversation.id
  });
  const saved = await storage.getConversation(conversation.id);
  assert.equal(saved?.title, "First Agent Auto Title");
  assert.equal((saved?.metadata.autoTitle as { source?: string; participantId?: string; runId?: string } | undefined)?.source, "first-agent");
  assert.equal((saved?.metadata.autoTitle as { source?: string; participantId?: string; runId?: string } | undefined)?.participantId, participant.id);
  assert.equal((saved?.metadata.autoTitle as { source?: string; participantId?: string; runId?: string } | undefined)?.runId, "run-1");
  assert.equal(saved?.metadata.autoTitleEligibility, undefined);
  assert.equal(snapshots.at(-1)?.title, "First Agent Auto Title");
  assert.deepEqual(historyWrites, ["First Agent Auto Title"]);
});

test("setChatTitleFromTool ignores duplicate, invalid, and wrong-run title calls", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation({
    messages: [
      systemMessage(),
      userMessage("user-message-1", "@drew implement auto title")
    ],
    metadata: {
      participants: [participant],
      participantSessions: [],
      autoTitleEligibility: autoTitleEligibility(participant)
    }
  });
  const { service, storage } = testService([conversation]);

  const invalid = await service.setChatTitleFromTool(autoTitleActor(participant), { title: "@drew /office-hours" });
  assert.equal(invalid.reason, "invalid_title");
  assert.equal((await storage.getConversation(conversation.id))?.metadata.autoTitleEligibility !== undefined, true);

  const wrongRun = await service.setChatTitleFromTool({ ...autoTitleActor(participant), runId: "other-run" }, { title: "Auto Title Feature" });
  assert.equal(wrongRun.reason, "not_eligible");

  await service.setChatTitleFromTool(autoTitleActor(participant), { title: "Auto Title Feature" });
  const duplicate = await service.setChatTitleFromTool(autoTitleActor(participant), { title: "Second Auto Title" });
  assert.equal(duplicate.reason, "already_titled");
  assert.equal((await storage.getConversation(conversation.id))?.title, "Auto Title Feature");
});

test("sendMessage persists first-turn title eligibility and passes matching target run ids", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation({
    messages: [systemMessage()],
    metadata: {
      participants: [participant],
      participantSessions: []
    }
  });
  const { service, storage } = testService([conversation]);
  let captured: { triggerMessageId?: string; targetRunId?: string } | undefined;
  (service as unknown as {
    runParticipantBatch(
      conversation: Conversation,
      targets: ChatParticipant[],
      triggerMessage: Conversation["messages"][number],
      runId: string,
      signal: AbortSignal | undefined,
      progress: unknown,
      warnings: string[],
      options: { targetRunIds?: ReadonlyMap<string, string> }
    ): Promise<void>;
  }).runParticipantBatch = async (_conversation, targets, triggerMessage, _runId, _signal, _progress, _warnings, options) => {
    captured = {
      triggerMessageId: triggerMessage.id,
      targetRunId: options.targetRunIds?.get(targets[0]?.id ?? "")
    };
  };

  await service.sendMessage({
    conversationId: conversation.id,
    runId: "outer-run",
    content: "@drew /office-hours Please name this chat"
  });

  const saved = await storage.getConversation(conversation.id);
  const eligibility = saved?.metadata.autoTitleEligibility as {
    triggerMessageId?: string;
    targetParticipantIds?: string[];
    targetRunIds?: Record<string, string>;
  } | undefined;
  assert.ok(eligibility);
  assert.equal(eligibility.triggerMessageId, captured?.triggerMessageId);
  assert.deepEqual(eligibility.targetParticipantIds, [participant.id]);
  assert.equal(eligibility.targetRunIds?.[participant.id], captured?.targetRunId);
  assert.notEqual(eligibility.targetRunIds?.[participant.id], "outer-run");
});

test("stored first-agent title survives a later stale run mutation", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation({
    title: "Initial fallback title",
    messages: [
      systemMessage(),
      userMessage("user-message-1", "@drew please name this chat")
    ],
    metadata: {
      participants: [participant],
      participantSessions: [],
      autoTitleEligibility: autoTitleEligibility(participant)
    }
  });
  const staleRunConversation = cloneConversation(conversation);
  const { service, storage } = testService([conversation]);

  await service.setChatTitleFromTool(autoTitleActor(participant), { title: "Agent Chosen Title" });

  await (service as unknown as {
    withChatMutation(conversation: Conversation, fn: () => Promise<void>): Promise<void>;
    saveConversation(conversation: Conversation): Promise<void>;
  }).withChatMutation(staleRunConversation, async () => {
    staleRunConversation.messages.push({
      id: "participant-message-1",
      role: "participant",
      participantId: participant.id,
      participantLabel: "@drew",
      content: "Done.",
      createdAt: NOW,
      status: "done"
    });
    staleRunConversation.updatedAt = "2026-05-19T12:01:00.000Z";
    await (service as unknown as {
      saveConversation(conversation: Conversation): Promise<void>;
    }).saveConversation(staleRunConversation);
  });

  const saved = await storage.getConversation(conversation.id);
  assert.equal(saved?.title, "Agent Chosen Title");
  assert.equal(saved?.metadata.autoTitleEligibility, undefined);
  assert.equal((saved?.metadata.autoTitle as { source?: string } | undefined)?.source, "first-agent");
  assert.equal(saved?.messages.some((message) => message.id === "participant-message-1"), true);
});

test("terminal title cleanup keeps eligibility while another target run is registered", async () => {
  const skippedParticipant = chatParticipant();
  const liveParticipant = chatParticipant({ id: "participant-2", handle: "taylor" });
  const conversation = chatConversation({
    metadata: {
      participants: [skippedParticipant, liveParticipant],
      participantSessions: [],
      autoTitleEligibility: {
        triggerMessageId: "user-message-1",
        targetParticipantIds: [skippedParticipant.id, liveParticipant.id],
        targetRunIds: {
          [skippedParticipant.id]: "run-skipped",
          [liveParticipant.id]: "run-live"
        },
        createdAt: NOW
      }
    }
  });
  const { service } = testService([conversation]);
  const internals = service as unknown as {
    registerTargetRun(runId: string, controller: AbortController, meta: { conversationId: string; participantId: string; participantHandle: string }): void;
    unregisterTargetRun(runId: string, controller?: AbortController): void;
    metadataAfterAutoTitleRunTerminal(conversationId: string, metadata: Record<string, unknown>, terminalRunId: string): Record<string, unknown>;
  };
  const controller = new AbortController();

  internals.registerTargetRun("run-live", controller, {
    conversationId: conversation.id,
    participantId: liveParticipant.id,
    participantHandle: liveParticipant.handle
  });

  const preserved = internals.metadataAfterAutoTitleRunTerminal(conversation.id, conversation.metadata, "run-skipped");
  assert.ok(preserved.autoTitleEligibility);

  internals.unregisterTargetRun("run-live", controller);
  const cleared = internals.metadataAfterAutoTitleRunTerminal(conversation.id, preserved, "run-live");
  assert.equal(cleared.autoTitleEligibility, undefined);
});

test("renameConversation rejects non-chat conversations", async () => {
  const conversation = chatConversation({
    title: "Review",
    kind: "code-review"
  });
  const { service } = testService([conversation]);

  await assert.rejects(
    () => service.renameConversation({ conversationId: conversation.id, title: "New title" }),
    /Only chat conversations can be renamed/
  );
});

test("renameConversation rejects running chats", async () => {
  const conversation = chatConversation({
    title: "Running chat",
    metadata: { running: true }
  });
  const { service, storage } = testService([conversation]);

  await assert.rejects(
    () => service.renameConversation({ conversationId: conversation.id, title: "New title" }),
    /cannot be edited while members are running/
  );
  assert.equal((await storage.getConversation(conversation.id))?.title, "Running chat");
});

test("renameConversation rejects when a chat run already owns the run queue", async () => {
  const conversation = chatConversation({ title: "Queued chat" });
  const { service, storage } = testService([conversation]);
  const releaseRun = await holdChatRunLock(service, conversation.id);

  try {
    await assert.rejects(
      () => service.renameConversation({ conversationId: conversation.id, title: "New title" }),
      /cannot be edited while members are running/
    );
    assert.equal((await storage.getConversation(conversation.id))?.title, "Queued chat");
  } finally {
    await releaseRun();
  }
});

test("setArchived archives a chat by stamping metadata and bumping updatedAt", async () => {
  const conversation = chatConversation({ title: "Archive me" });
  const { service, storage } = testService([conversation]);

  const saved = await service.setArchived({ conversationId: conversation.id, archived: true });

  assert.equal(saved?.metadata.archived, true);
  assert.equal(typeof saved?.metadata.archivedAt, "string");
  assert.notEqual(saved?.updatedAt, NOW);
  assert.equal(saved?.messages.length, conversation.messages.length);
  const stored = await storage.getConversation(conversation.id);
  assert.equal(stored?.metadata.archived, true);
  assert.equal(typeof stored?.metadata.archivedAt, "string");
});

test("setArchived unarchiving removes both archived and archivedAt", async () => {
  const conversation = chatConversation({
    title: "Archived chat",
    metadata: { archived: true, archivedAt: NOW }
  });
  const { service, storage } = testService([conversation]);

  const saved = await service.setArchived({ conversationId: conversation.id, archived: false });

  assert.equal("archived" in (saved?.metadata ?? {}), false);
  assert.equal("archivedAt" in (saved?.metadata ?? {}), false);
  const stored = await storage.getConversation(conversation.id);
  assert.equal("archived" in (stored?.metadata ?? {}), false);
  assert.equal("archivedAt" in (stored?.metadata ?? {}), false);
});

test("setArchived is a no-op when the archived state already matches", async () => {
  const conversation = chatConversation({
    title: "Already archived",
    metadata: { archived: true, archivedAt: NOW }
  });
  const { service } = testService([conversation]);

  const saved = await service.setArchived({ conversationId: conversation.id, archived: true });

  assert.equal(saved?.metadata.archivedAt, NOW);
  assert.equal(saved?.updatedAt, NOW);
});

test("setArchived rejects non-chat conversations", async () => {
  const conversation = chatConversation({ title: "Review", kind: "code-review" });
  const { service } = testService([conversation]);

  await assert.rejects(
    () => service.setArchived({ conversationId: conversation.id, archived: true }),
    /Only chat conversations can be archived/
  );
});

test("setArchived rejects running chats", async () => {
  const conversation = chatConversation({
    title: "Running chat",
    metadata: { running: true }
  });
  const { service, storage } = testService([conversation]);

  await assert.rejects(
    () => service.setArchived({ conversationId: conversation.id, archived: true }),
    /cannot be archived while members are running/
  );
  assert.equal((await storage.getConversation(conversation.id))?.metadata.archived, undefined);
});

test("setArchived rejects when a chat run already owns the run queue", async () => {
  const conversation = chatConversation({ title: "Queued chat" });
  const { service, storage } = testService([conversation]);
  const releaseRun = await holdChatRunLock(service, conversation.id);

  try {
    await assert.rejects(
      () => service.setArchived({ conversationId: conversation.id, archived: true }),
      /cannot be archived while members are running/
    );
    assert.equal((await storage.getConversation(conversation.id))?.metadata.archived, undefined);
  } finally {
    await releaseRun();
  }
});

test("setArchived stops an idle warm remote session without discarding its durable handle", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation({
    metadata: {
      participants: [participant],
      participantSessions: [{
        participantId: participant.id,
        sessionId: "session-1",
        roleConfigId: ROLE.id,
        roleConfigVersion: ROLE.version,
        roleLabel: ROLE.label,
        roleInstructions: ROLE.instructions,
        remoteSession: {
          sessionKey: "remote-session",
          sessionDir: "/srv/worker/sessions/remote-session",
          worker: { host: "worker.example", workerRoot: "/srv/worker" },
          protocolVersion: 1,
          runtimeFingerprint: "fingerprint",
          updatedAt: NOW
        },
        updatedAt: NOW
      } satisfies ChatParticipantSession]
    }
  });
  const { service, storage, cleanupTombstones } = testService([conversation]);
  service.setRemoteRunService({
    async startDetachedRun(): Promise<never> { throw new Error("not used"); },
    async pollDetachedRun(): Promise<never> { throw new Error("not used"); },
    async cancelDetachedRun(): Promise<never> { throw new Error("not used"); },
    async stopParticipantSessionIfIdle(): Promise<boolean> { return true; }
  });

  await service.setArchived({ conversationId: conversation.id, archived: true });
  const saved = await storage.getConversation(conversation.id);
  const sessions = saved?.metadata.participantSessions as ChatParticipantSession[];
  assert.equal(saved?.metadata.archived, true);
  assert.equal(sessions[0]?.remoteSession?.sessionKey, "remote-session");
  assert.deepEqual(cleanupTombstones, []);
});

test("deleteConversation requires archive, records remote cleanup before deleting, and removes storage", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation({
    metadata: {
      archived: true,
      participants: [participant],
      participantSessions: [{
        participantId: participant.id,
        sessionId: "session-1",
        roleConfigId: ROLE.id,
        roleConfigVersion: ROLE.version,
        roleLabel: ROLE.label,
        roleInstructions: ROLE.instructions,
        remoteSession: {
          sessionKey: "remote-session",
          sessionDir: "/srv/worker/sessions/remote-session",
          worker: { host: "worker.example", workerRoot: "/srv/worker" },
          protocolVersion: 1,
          runtimeFingerprint: "fingerprint",
          updatedAt: NOW
        },
        updatedAt: NOW
      } satisfies ChatParticipantSession]
    }
  });
  const { service, storage, cleanupTombstones } = testService([conversation]);
  let cleanupCalls = 0;
  service.setRemoteRunService({
    async startDetachedRun(): Promise<never> { throw new Error("not used"); },
    async pollDetachedRun(): Promise<never> { throw new Error("not used"); },
    async cancelDetachedRun(): Promise<never> { throw new Error("not used"); },
    async stopParticipantSessionIfIdle(): Promise<boolean> {
      cleanupCalls += 1;
      return false;
    }
  });

  assert.equal(await service.deleteConversation({ conversationId: conversation.id }), true);
  assert.equal(await storage.getConversation(conversation.id), undefined);
  assert.equal(cleanupCalls, 1);
  assert.equal(cleanupTombstones.length, 1);
  assert.equal(cleanupTombstones[0].reason, "chat-deleted");
});

test("deleteConversation rejects an unarchived chat", async () => {
  const conversation = chatConversation();
  const { service, storage } = testService([conversation]);
  await assert.rejects(
    () => service.deleteConversation({ conversationId: conversation.id }),
    /Archive the chat before deleting it permanently/
  );
  assert.ok(await storage.getConversation(conversation.id));
});

test("permanent deletion cannot be resurrected by an already queued stale mutation", async () => {
  const conversation = chatConversation({ metadata: { archived: true } });
  const { service, storage } = testService([conversation]);
  const stale = structuredClone(conversation);
  let release!: () => void;
  let entered!: () => void;
  const blocker = new Promise<void>((resolve) => { release = resolve; });
  const mutationEntered = new Promise<void>((resolve) => { entered = resolve; });
  const staleMutation = (service as any).withChatMutation(stale, async () => {
    entered();
    await blocker;
    stale.title = "resurrected";
    await (service as any).saveConversation(stale);
  }) as Promise<void>;
  await mutationEntered;

  const deletion = service.deleteConversation({ conversationId: conversation.id });
  for (let attempt = 0; attempt < 100 && !(service as any).deletedConversationIds.has(conversation.id); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  release();
  await assert.rejects(staleMutation, /permanently deleted/);
  assert.equal(await deletion, true);
  assert.equal(await storage.getConversation(conversation.id), undefined);
});

test("addParticipant serializes concurrent roster additions without dropping a participant", async () => {
  const conversation = chatConversation({ title: "Roster chat" });
  const { service, storage } = testService([conversation]);

  await Promise.all([
    service.addParticipant({
      conversationId: conversation.id,
      participant: {
        handle: "taylor",
        roleConfigId: ROLE.id,
        kind: "claude-code"
      }
    }),
    service.addParticipant({
      conversationId: conversation.id,
      participant: {
        handle: "alex",
        roleConfigId: ROLE.id,
        kind: "codex-cli"
      }
    })
  ]);

  const saved = await storage.getConversation(conversation.id);
  const participants = (saved?.metadata.participants ?? []) as ChatParticipant[];
  assert.deepEqual(
    participants.map((participant) => participant.handle).sort(),
    ["alex", "drew", "taylor"]
  );
  assert.equal(saved?.messages.filter((message) => message.content === "Added @taylor to the chat.").length, 1);
  assert.equal(saved?.messages.filter((message) => message.content === "Added @alex to the chat.").length, 1);
});

test("syncSavedParticipantAvatar refreshes copied chat participant avatars", async () => {
  const conversation = chatConversation({
    metadata: {
      participants: [chatParticipant({ avatarId: "codex-cat" })],
      participantSessions: []
    }
  });
  const { service, storage, snapshots } = testService([conversation]);

  await service.syncSavedParticipantAvatar(
    { handle: "drew", kind: "codex-cli" },
    { id: "saved-drew", handle: "drew", kind: "codex-cli", avatarId: "codex-logo" }
  );

  const saved = await storage.getConversation(conversation.id);
  const savedParticipants = (saved?.metadata.participants ?? []) as ChatParticipant[];
  const snapshotParticipants = (snapshots.at(-1)?.metadata.participants ?? []) as ChatParticipant[];
  const participant = savedParticipants[0];
  assert.equal(participant?.avatarId, "codex-logo");
  assert.equal(participant?.participantConfigId, "saved-drew");
  assert.equal(saved?.updatedAt, NOW);
  assert.equal(saved?.messages.length, conversation.messages.length);
  assert.equal(snapshotParticipants[0]?.avatarId, "codex-logo");
});

test("syncSavedParticipantConfig refreshes copied chat participant behavior rules", async () => {
  const conversation = chatConversation({
    metadata: {
      participants: [chatParticipant({ avatarId: "codex-cat", behaviorRuleIds: ["old-rule"] })],
      participantSessions: []
    }
  });
  const { service, storage, snapshots } = testService([conversation]);

  await service.syncSavedParticipantConfig(
    { handle: "drew", kind: "codex-cli" },
    {
      id: "saved-drew",
      handle: "drew",
      kind: "codex-cli",
      avatarId: "codex-logo",
      behaviorRuleIds: ["new-rule"]
    }
  );

  const saved = await storage.getConversation(conversation.id);
  const participant = ((saved?.metadata.participants ?? []) as ChatParticipant[])[0];
  const snapshotParticipant = ((snapshots.at(-1)?.metadata.participants ?? []) as ChatParticipant[])[0];
  assert.equal(participant?.participantConfigId, "saved-drew");
  assert.equal(participant?.avatarId, "codex-logo");
  assert.deepEqual(participant?.behaviorRuleIds, ["new-rule"]);
  assert.deepEqual(snapshotParticipant?.behaviorRuleIds, ["new-rule"]);
});

test("syncSavedParticipantConfig does not legacy-match participants linked to another preset", async () => {
  const conversation = chatConversation({
    metadata: {
      participants: [
        chatParticipant({
          participantConfigId: "other-preset",
          avatarId: "codex-cat",
          behaviorRuleIds: ["other-rule"]
        })
      ],
      participantSessions: []
    }
  });
  const { service, storage, snapshots } = testService([conversation]);

  await service.syncSavedParticipantConfig(
    { handle: "drew", kind: "codex-cli" },
    {
      id: "saved-drew",
      handle: "drew",
      kind: "codex-cli",
      avatarId: "codex-logo",
      behaviorRuleIds: ["new-rule"]
    }
  );

  const saved = await storage.getConversation(conversation.id);
  const participant = ((saved?.metadata.participants ?? []) as ChatParticipant[])[0];
  assert.equal(participant?.participantConfigId, "other-preset");
  assert.equal(participant?.avatarId, "codex-cat");
  assert.deepEqual(participant?.behaviorRuleIds, ["other-rule"]);
  assert.equal(snapshots.length, 0);
});

test("hydrateContextUsage refreshes copied participant avatars from saved settings", async () => {
  const conversation = chatConversation({
    metadata: {
      participants: [chatParticipant({ avatarId: "codex-cat", behaviorRuleIds: ["old-rule"] })],
      participantSessions: []
    }
  });
  const { service, storage, snapshots } = testService([conversation], {
    participantConfigs: [{
      id: "saved-drew",
      handle: "drew",
      roleConfigId: ROLE.id,
      kind: "codex-cli",
      avatarId: "codex-logo",
      behaviorRuleIds: ["new-rule"],
      updatedAt: NOW
    }]
  });

  const hydrated = await service.hydrateContextUsage(conversation);

  const saved = await storage.getConversation(conversation.id);
  const hydratedParticipants = (hydrated.metadata.participants ?? []) as ChatParticipant[];
  const savedParticipants = (saved?.metadata.participants ?? []) as ChatParticipant[];
  assert.equal(hydratedParticipants[0]?.avatarId, "codex-logo");
  assert.equal(savedParticipants[0]?.avatarId, "codex-logo");
  assert.equal(hydratedParticipants[0]?.participantConfigId, "saved-drew");
  assert.deepEqual(hydratedParticipants[0]?.behaviorRuleIds, ["new-rule"]);
  assert.deepEqual(savedParticipants[0]?.behaviorRuleIds, ["new-rule"]);
  assert.equal(saved?.updatedAt, NOW);
  assert.equal(((snapshots.at(-1)?.metadata.participants ?? []) as ChatParticipant[])[0]?.avatarId, "codex-logo");
});

test("removeBehaviorRuleFromChatParticipants removes deleted behavior rules from copied chat participants", async () => {
  const conversation = chatConversation({
    metadata: {
      participants: [chatParticipant({ behaviorRuleIds: ["keep-rule", "deleted-rule"] })],
      participantSessions: []
    }
  });
  const { service, storage, snapshots } = testService([conversation]);

  await service.removeBehaviorRuleFromChatParticipants("deleted-rule");

  const saved = await storage.getConversation(conversation.id);
  const participant = ((saved?.metadata.participants ?? []) as ChatParticipant[])[0];
  const snapshotParticipant = ((snapshots.at(-1)?.metadata.participants ?? []) as ChatParticipant[])[0];
  assert.deepEqual(participant?.behaviorRuleIds, ["keep-rule"]);
  assert.deepEqual(snapshotParticipant?.behaviorRuleIds, ["keep-rule"]);
});

test("hydrateContextUsage refreshes stale stored context usage for existing sessions", async () => {
  const participant = chatParticipant({ model: "gpt-5.5" });
  const staleUsage: AgentContextUsage = {
    usedTokens: 26_000,
    contextWindowTokens: 258_000,
    percentage: 10,
    source: "codex-cli",
    updatedAt: "2026-05-19T12:00:00.000Z",
    model: "gpt-5.5"
  };
  const freshUsage: AgentContextUsage = {
    usedTokens: 193_000,
    contextWindowTokens: 258_000,
    percentage: 75,
    source: "codex-cli",
    updatedAt: "2026-05-19T12:01:00.000Z",
    model: "gpt-5.5"
  };
  const conversation = chatConversation({
    metadata: {
      participants: [participant],
      participantSessions: [chatSession(participant, "019ed183-1d77-7450-9070-6ea6f0b61aa7")],
      agentContextUsageByParticipant: {
        [participant.id]: staleUsage
      }
    }
  });
  const { service, storage } = testService([conversation], {
    contextUsageBySession: {
      "019ed183-1d77-7450-9070-6ea6f0b61aa7": freshUsage
    }
  });

  const hydrated = await service.hydrateContextUsage(conversation);
  const saved = await storage.getConversation(conversation.id);
  const hydratedUsage = hydrated.metadata.agentContextUsageByParticipant as Record<string, AgentContextUsage>;
  const savedUsage = saved?.metadata.agentContextUsageByParticipant as Record<string, AgentContextUsage> | undefined;

  assert.equal(hydratedUsage[participant.id]?.usedTokens, 193_000);
  assert.equal(savedUsage?.[participant.id]?.usedTokens, 193_000);
});

test("hydrateContextUsage does not overwrite newer stored context usage from a stale caller snapshot", async () => {
  const participant = chatParticipant({ model: "gpt-5.5" });
  const staleUsage: AgentContextUsage = {
    usedTokens: 26_000,
    contextWindowTokens: 258_000,
    percentage: 10,
    source: "codex-cli",
    updatedAt: "2026-05-19T12:00:00.000Z",
    model: "gpt-5.5"
  };
  const newerStoredUsage: AgentContextUsage = {
    usedTokens: 193_000,
    contextWindowTokens: 258_000,
    percentage: 75,
    source: "codex-cli",
    updatedAt: "2026-05-19T12:02:00.000Z",
    model: "gpt-5.5"
  };
  const staleLogUsage: AgentContextUsage = {
    usedTokens: 51_000,
    contextWindowTokens: 258_000,
    percentage: 20,
    source: "codex-cli",
    updatedAt: "2026-05-19T12:01:00.000Z",
    model: "gpt-5.5"
  };
  const conversation = chatConversation({
    metadata: {
      participants: [participant],
      participantSessions: [chatSession(participant, "019ed183-1d77-7450-9070-6ea6f0b61aa7")],
      agentContextUsageByParticipant: {
        [participant.id]: staleUsage
      }
    }
  });
  const { service, storage } = testService([conversation], {
    contextUsageBySession: {
      "019ed183-1d77-7450-9070-6ea6f0b61aa7": staleLogUsage
    }
  });
  const storedConversation = cloneConversation(conversation);
  storedConversation.metadata.agentContextUsageByParticipant = {
    [participant.id]: newerStoredUsage
  };
  await storage.saveConversation(storedConversation);

  const hydrated = await service.hydrateContextUsage(conversation);
  const saved = await storage.getConversation(conversation.id);
  const hydratedUsage = hydrated.metadata.agentContextUsageByParticipant as Record<string, AgentContextUsage>;
  const savedUsage = saved?.metadata.agentContextUsageByParticipant as Record<string, AgentContextUsage> | undefined;

  assert.equal(hydratedUsage[participant.id]?.usedTokens, 193_000);
  assert.equal(savedUsage?.[participant.id]?.usedTokens, 193_000);
});

test("hydrateContextUsage preserves newer stored messages when syncing participant avatars", async () => {
  const staleConversation = chatConversation({
    metadata: {
      participants: [chatParticipant({ avatarId: "codex-cat" })],
      participantSessions: []
    }
  });
  const storedConversation = cloneConversation(staleConversation);
  storedConversation.messages.push({
    id: "message-2",
    role: "participant",
    participantId: "participant-1",
    participantLabel: "@drew",
    content: "Already saved.",
    createdAt: NOW,
    status: "done"
  });
  const { service, storage } = testService([storedConversation], {
    participantConfigs: [{
      id: "saved-drew",
      handle: "drew",
      roleConfigId: ROLE.id,
      kind: "codex-cli",
      avatarId: "codex-logo",
      updatedAt: NOW
    }]
  });

  const hydrated = await service.hydrateContextUsage(staleConversation);

  const saved = await storage.getConversation(staleConversation.id);
  assert.equal(saved?.messages.some((message) => message.id === "message-2"), true);
  assert.equal(hydrated.messages.some((message) => message.id === "message-2"), true);
  assert.equal(((saved?.metadata.participants ?? []) as ChatParticipant[])[0]?.avatarId, "codex-logo");
});

test("participant-session metadata merge preserves newer handles and respects newer intentional clears", () => {
  const { service } = testService([]);
  const merge = (service as any).mergeStoredChatMetadata.bind(service) as (
    stored: Record<string, unknown>,
    current: Record<string, unknown>
  ) => Record<string, unknown>;
  const remoteSession = {
    sessionKey: "warm",
    sessionDir: "/worker/sessions/warm",
    worker: { host: "worker.example" },
    protocolVersion: 2,
    runtimeFingerprint: "fingerprint",
    updatedAt: "2026-07-10T00:00:02.000Z"
  };
  const stored = {
    participantId: "participant",
    sessionId: "session-id",
    remoteSession,
    updatedAt: "2026-07-10T00:00:02.000Z"
  };
  const stale = {
    participantId: "participant",
    sessionId: "",
    updatedAt: "2026-07-10T00:00:01.000Z"
  };
  const preserved = merge(
    { participantSessions: [stored] },
    { participantSessions: [stale] }
  ).participantSessions as Array<Record<string, unknown>>;
  assert.equal((preserved[0].remoteSession as { sessionKey: string }).sessionKey, "warm");
  assert.equal(preserved[0].sessionId, "session-id");

  const cleared = merge(
    { participantSessions: [stored] },
    { participantSessions: [{ ...stale, updatedAt: "2026-07-10T00:00:03.000Z", remoteSession: undefined }] }
  ).participantSessions as Array<Record<string, unknown>>;
  assert.equal(cleared[0].remoteSession, undefined);
  assert.equal(cleared[0].sessionId, "");
});

function testService(conversationList: Conversation[], options: {
  participantConfigs?: ChatParticipantConfig[];
  contextUsageBySession?: Record<string, AgentContextUsage | undefined>;
} = {}): {
  service: ChatService;
  storage: {
    listConversations(): Promise<ConversationSummary[]>;
    getConversation(id: string): Promise<Conversation | undefined>;
    saveConversation(conversation: Conversation): Promise<void>;
    deleteConversation(id: string): Promise<boolean>;
  };
  snapshots: Conversation[];
  historyWrites: string[];
  cleanupTombstones: RemoteSessionCleanupTombstone[];
} {
  const conversations = new Map(conversationList.map((conversation) => [conversation.id, cloneConversation(conversation)]));
  const snapshots: Conversation[] = [];
  const historyWrites: string[] = [];
  const cleanupTombstones: RemoteSessionCleanupTombstone[] = [];
  const storage = {
    async listConversations(): Promise<ConversationSummary[]> {
      return Array.from(conversations.values()).map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        kind: conversation.kind,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        repoPath: conversation.repoPath,
        running: Boolean(conversation.metadata.running)
      }));
    },
    async getConversation(id: string): Promise<Conversation | undefined> {
      const conversation = conversations.get(id);
      return conversation ? cloneConversation(conversation) : undefined;
    },
    async saveConversation(conversation: Conversation): Promise<void> {
      conversations.set(conversation.id, cloneConversation(conversation));
    },
    async deleteConversation(id: string): Promise<boolean> {
      return conversations.delete(id);
    }
  };
  const settings = {
    async getPublicSettings(): Promise<{ chatRoleConfigs: ChatRoleConfig[]; chatParticipantConfigs: ChatParticipantConfig[] }> {
      return { chatRoleConfigs: [ROLE], chatParticipantConfigs: options.participantConfigs ?? [] };
    },
    async enqueueRemoteSessionCleanup(
      handle: RemoteSessionCleanupTombstone["handle"],
      reason: RemoteSessionCleanupTombstone["reason"]
    ): Promise<RemoteSessionCleanupTombstone> {
      const tombstone = { id: `cleanup-${cleanupTombstones.length + 1}`, handle, reason, createdAt: NOW };
      cleanupTombstones.push(tombstone);
      return tombstone;
    },
    async removeRemoteSessionCleanupTombstone(id: string): Promise<void> {
      const index = cleanupTombstones.findIndex((item) => item.id === id);
      if (index >= 0) cleanupTombstones.splice(index, 1);
    }
  };
  const cliRunner = {
    async detectAgents(): Promise<[]> {
      return [];
    },
    async contextUsageForSession(_participant: unknown, sessionId: string | undefined): Promise<AgentContextUsage | undefined> {
      return sessionId ? options.contextUsageBySession?.[sessionId] : undefined;
    }
  };
  const debugLogs = {
    async write(): Promise<void> {
      return undefined;
    }
  };
  const service = new ChatService(
    storage as never,
    settings as never,
    cliRunner as never,
    debugLogs as never,
    undefined,
    (conversation) => snapshots.push(cloneConversation(conversation))
  );
  (service as unknown as { ensureHistoryFiles(conversation: Conversation): Promise<string> }).ensureHistoryFiles = async (conversation) => {
    historyWrites.push(conversation.title);
    return "/mock/history";
  };
  (service as unknown as { cleanupDeletedConversationArtifacts(conversation: Conversation): Promise<void> })
    .cleanupDeletedConversationArtifacts = async () => undefined;
  return { service, storage, snapshots, historyWrites, cleanupTombstones };
}

function chatConversation(patch: Partial<Conversation> = {}): Conversation {
  return {
    id: "conversation-1",
    title: "Test chat",
    kind: "chat",
    createdAt: NOW,
    updatedAt: NOW,
    repoPath: "/repo",
    messages: [{
      id: "message-1",
      role: "system",
      content: "Chat started.",
      createdAt: NOW,
      status: "done"
    }],
    findings: [],
    metadata: {
      participants: [chatParticipant()],
      participantSessions: [],
      ...(patch.metadata ?? {})
    },
    ...patch
  };
}

function chatParticipant(patch: Partial<ChatParticipant> = {}): ChatParticipant {
  return {
    id: "participant-1",
    handle: "drew",
    roleConfigId: ROLE.id,
    kind: "codex-cli",
    ...patch
  };
}

function autoTitleEligibility(participant: ChatParticipant): Record<string, unknown> {
  return {
    triggerMessageId: "user-message-1",
    targetParticipantIds: [participant.id],
    targetRunIds: {
      [participant.id]: "run-1"
    },
    createdAt: NOW
  };
}

function autoTitleActor(participant: ChatParticipant): {
  conversationId: string;
  participantId: string;
  roleConfigId: string;
  roleConfigVersion: number;
  capabilities: [];
  triggerMessageId: string;
  runId: string;
} {
  return {
    conversationId: "conversation-1",
    participantId: participant.id,
    roleConfigId: ROLE.id,
    roleConfigVersion: ROLE.version,
    capabilities: [],
    triggerMessageId: "user-message-1",
    runId: "run-1"
  };
}

function systemMessage(): Conversation["messages"][number] {
  return {
    id: "system-message-1",
    role: "system",
    content: "Chat started.",
    createdAt: NOW,
    status: "done"
  };
}

function userMessage(id: string, content: string): Conversation["messages"][number] {
  return {
    id,
    role: "user",
    content,
    createdAt: NOW,
    status: "done",
    metadata: {
      threadId: id
    }
  };
}

function chatSession(participant: ChatParticipant, sessionId: string): ChatParticipantSession {
  return {
    participantId: participant.id,
    sessionId,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: ROLE.version,
    participantKind: participant.kind,
    participantModel: participant.model,
    runtimeConfigVersion: 1,
    roleLabel: ROLE.label,
    roleInstructions: ROLE.instructions,
    updatedAt: NOW
  };
}

function cloneConversation(conversation: Conversation): Conversation {
  return JSON.parse(JSON.stringify(conversation)) as Conversation;
}

async function holdChatRunLock(service: ChatService, conversationId: string): Promise<() => Promise<void>> {
  let release!: () => void;
  let runFinished!: () => void;
  const started = new Promise<void>((resolve) => {
    void (service as unknown as {
      withChatRunLock<T>(conversationId: string, run: () => Promise<T>): Promise<T>;
    }).withChatRunLock(conversationId, async () => {
      resolve();
      await new Promise<void>((unlock) => {
        release = unlock;
      });
    }).finally(() => runFinished());
  });
  const finished = new Promise<void>((resolve) => {
    runFinished = resolve;
  });
  await started;
  return async () => {
    release();
    await finished;
  };
}
