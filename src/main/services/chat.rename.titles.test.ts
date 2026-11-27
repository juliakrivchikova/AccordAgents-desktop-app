import assert from "node:assert/strict";
import test from "node:test";
import { chatParts } from "./chat/test/chatParts";
import { normalizeAutoChatTitle, sanitizeAutoChatTitleSuggestion } from "../../shared/chatTitles";
import type { ChatParticipant, Conversation } from "../../shared/types";
import {
  chatConversation, chatParticipant, cloneConversation, holdChatRunLock, NOW, ROLE, testService
} from "./chat/test/conversationFixtures";

test("auto chat title sanitizer strips leading participant handles and slash skills", () => {
  assert.equal(
    normalizeAutoChatTitle("@drew-codex-engineer /office-hours I want new feature, assign chat title"),
    "I want new feature, assign chat title"
  );
  assert.equal(sanitizeAutoChatTitleSuggestion("@drew /office-hours"), undefined);
  assert.equal(sanitizeAutoChatTitleSuggestion("Codex"), undefined);
});

test("auto chat title sanitizer keeps titles that use no Latin letters", () => {
  assert.equal(sanitizeAutoChatTitleSuggestion("Утюги в магазинах Лимассола"), "Утюги в магазинах Лимассола");
  assert.equal(sanitizeAutoChatTitleSuggestion("@drew Роль личного кулинара"), "Роль личного кулинара");
  assert.equal(sanitizeAutoChatTitleSuggestion("記憶の管理"), "記憶の管理");
  assert.equal(sanitizeAutoChatTitleSuggestion("🙂 — !!"), undefined);
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

test("artifact chat notes deduplicate replayed outbox event ids inside the mutation queue", async () => {
  const conversation = chatConversation();
  const { service, storage } = testService([conversation]);

  await Promise.all([
    service.postArtifactChatNote(conversation.id, "event-1", "First delivery"),
    service.postArtifactChatNote(conversation.id, "event-1", "Replayed delivery")
  ]);
  await service.postArtifactChatNote(conversation.id, "event-2", "Second event");

  const saved = await storage.getConversation(conversation.id);
  const artifactNotes = saved?.messages.filter((message) => message.metadata?.artifactEventId) ?? [];
  assert.equal(artifactNotes.length, 2);
  assert.deepEqual(artifactNotes.map((message) => message.metadata?.artifactEventId), ["event-1", "event-2"]);
  assert.equal(artifactNotes[0].content, "First delivery");
});

test("artifact chat note rejects and rolls back memory when durable storage fails", async () => {
  const conversation = chatConversation();
  const { service, storage } = testService([conversation], { failSaves: 1 });

  await assert.rejects(
    service.postArtifactChatNote(conversation.id, "event-fail", "Must stay pending"),
    /injected save failure/
  );
  const afterFailure = await storage.getConversation(conversation.id);
  assert.equal(afterFailure?.messages.some((message) => message.metadata?.artifactEventId === "event-fail"), false);

  await service.postArtifactChatNote(conversation.id, "event-fail", "Must stay pending");
  const afterRetry = await storage.getConversation(conversation.id);
  assert.equal(afterRetry?.messages.filter((message) => message.metadata?.artifactEventId === "event-fail").length, 1);
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

test("setChatTitleFromTool applies a title written in a non-Latin alphabet", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation({
    title: "Chat",
    messages: [
      systemMessage(),
      userMessage("user-message-1", "@drew надо посмотреть утюги в магазинах Лимассола")
    ],
    metadata: {
      participants: [participant],
      participantSessions: [],
      autoTitleEligibility: autoTitleEligibility(participant)
    }
  });
  const { service, storage } = testService([conversation]);

  const result = await service.setChatTitleFromTool(autoTitleActor(participant), {
    title: "Утюги в магазинах Лимассола"
  });

  assert.equal(result.status, "applied");
  assert.equal((await storage.getConversation(conversation.id))?.title, "Утюги в магазинах Лимассола");
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
  (chatParts(service).participantBatch as unknown as {
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

  await (chatParts(service).store as unknown as {
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
    await (chatParts(service).store as unknown as {
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
  const { activeRuns, titles } = chatParts(service);
  const controller = new AbortController();

  activeRuns.registerTargetRun("run-live", controller, {
    conversationId: conversation.id,
    participantId: liveParticipant.id,
    participantHandle: liveParticipant.handle
  });

  const preserved = titles.metadataAfterAutoTitleRunTerminal(conversation.id, conversation.metadata, "run-skipped");
  assert.ok(preserved.autoTitleEligibility);

  activeRuns.unregisterTargetRun("run-live", controller);
  const cleared = titles.metadataAfterAutoTitleRunTerminal(conversation.id, preserved, "run-live");
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

test("renameConversation renames a chat while its members are running", async () => {
  const conversation = chatConversation({
    title: "Running chat",
    metadata: { running: true, activeRunIds: ["run-live"] }
  });
  const { service, storage, historyWrites } = testService([conversation]);

  const saved = await service.renameConversation({ conversationId: conversation.id, title: "New title" });

  assert.equal(saved?.title, "New title");
  const stored = await storage.getConversation(conversation.id);
  assert.equal(stored?.title, "New title");
  assert.equal(stored?.metadata.running, true, "the run state is left as it was");
  assert.deepEqual(stored?.metadata.activeRunIds, ["run-live"]);
  assert.deepEqual(historyWrites, ["New title"]);
});

test("renameConversation does not wait for, or refuse, a chat run that holds the run queue", async () => {
  const conversation = chatConversation({ title: "Queued chat" });
  const { service, storage } = testService([conversation]);
  const releaseRun = await holdChatRunLock(service, conversation.id);

  try {
    const saved = await service.renameConversation({ conversationId: conversation.id, title: "New title" });
    assert.equal(saved?.title, "New title");
    assert.equal((await storage.getConversation(conversation.id))?.title, "New title");
  } finally {
    await releaseRun();
  }
});

test("a rename made while members' turns hold older copies of the chat keeps the new name", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation({
    title: "Agent title",
    metadata: {
      participants: [participant],
      participantSessions: [],
      autoTitle: { source: "first-agent", title: "Agent title", appliedAt: NOW, participantId: participant.id }
    }
  });
  const { service, storage } = testService([conversation]);
  // Two flows read the chat before the rename (a turn and its follow-up)...
  const first = (await storage.getConversation(conversation.id))!;
  const second = (await storage.getConversation(conversation.id))!;
  // ...the User renames it meanwhile...
  await service.renameConversation({ conversationId: conversation.id, title: "Mine" });
  // ...and each flow saves its copy, the way a running turn does.
  const store = chatParts(service).store as unknown as {
    withChatMutation(conversation: Conversation, mutate: () => Promise<void>): Promise<void>;
    saveConversation(conversation: Conversation): Promise<void>;
  };
  for (const stale of [first, second]) {
    await store.withChatMutation(stale, async () => {
      stale.updatedAt = new Date().toISOString();
      await store.saveConversation(stale);
    });
    const stored = await storage.getConversation(conversation.id);
    assert.equal(stored?.title, "Mine", "an older copy does not bring the old name back");
    const autoTitle = stored?.metadata.autoTitle as { source?: string; title?: string } | undefined;
    assert.equal(autoTitle?.source, "manual", "nor the old name's record");
    assert.equal(autoTitle?.title, "Mine");
    assert.equal(stale.title, "Mine", "the flow's own copy has the new name from then on");
  }
});

test("a rename made before the first member names the chat keeps that member from naming it", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation({
    metadata: {
      participants: [participant],
      participantSessions: [],
      autoTitleEligibility: autoTitleEligibility(participant)
    }
  });
  const { service, storage } = testService([conversation]);
  // The member's turn read the chat while it could still name it.
  const stale = (await storage.getConversation(conversation.id))!;
  await service.renameConversation({ conversationId: conversation.id, title: "Mine" });
  const store = chatParts(service).store as unknown as {
    withChatMutation(conversation: Conversation, mutate: () => Promise<void>): Promise<void>;
    saveConversation(conversation: Conversation): Promise<void>;
  };
  await store.withChatMutation(stale, async () => {
    await store.saveConversation(stale);
  });
  assert.equal((await storage.getConversation(conversation.id))?.metadata.autoTitleEligibility, undefined);

  const result = await service.setChatTitleFromTool(autoTitleActor(participant), { title: "Agent title" });

  assert.equal(result.status, "ignored");
  assert.equal(result.reason, "already_titled");
  assert.equal((await storage.getConversation(conversation.id))?.title, "Mine");
});

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
