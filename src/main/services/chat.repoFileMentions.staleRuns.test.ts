import assert from "node:assert/strict";
import test from "node:test";
import { chatParts } from "./chat/test/chatParts";
import { mergeStoredChatMessages } from "./chat/store/mergeStoredChat";
import { mergeStoredChatMetadata } from "./chat/store/mergeStoredMetadata";
import { storageParts, storageWithoutDatabase } from "./storage/test/storageParts";
import { INTERRUPTED_RUN_WARNING } from "../../shared/warnings";
import type { ChatAppToolApproval, ChatMessage, Conversation } from "../../shared/types";
import {
  chatConversation, chatParticipant, cloneConversation, NOW, participantMessage, participantRequestApproval,
  participantRequestItem, participantRequestMessageWithItems, testService
} from "./chat/test/mentionFixtures";

test("hydrateContextUsage clears inactive stale running state without warning when no pending turn was lost", async () => {
  const conversation = chatConversation([chatParticipant()], "/repo");
  conversation.metadata = {
    ...conversation.metadata,
    running: true,
    runId: "stale-run"
  };
  const { service, storage } = testService({ conversations: [conversation] });

  const hydrated = await service.hydrateContextUsage(cloneConversation(conversation));
  const saved = await storage.getConversation(conversation.id);

  assert.equal(hydrated.metadata.running, false);
  assert.equal(hydrated.metadata.runId, undefined);
  assert.deepEqual(hydrated.metadata.warnings ?? [], []);
  assert.equal(saved?.metadata.running, false);
  assert.deepEqual(saved?.metadata.warnings ?? [], []);
});

test("hydrateContextUsage warns when stale recovery marks a pending participant turn interrupted", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation([participant], "/repo");
  const pending = participantMessage(participant, "pending-reply", "");
  pending.status = "pending";
  pending.metadata = { ...pending.metadata, runId: "stale-run" };
  conversation.messages.push(pending);
  conversation.metadata = {
    ...conversation.metadata,
    running: true,
    runId: "stale-run",
    activeRunOwnersByRunId: {
      "stale-run": {
        processId: process.pid,
        startedAt: NOW,
        updatedAt: NOW
      }
    },
    warnings: [INTERRUPTED_RUN_WARNING, INTERRUPTED_RUN_WARNING]
  };
  const { service, storage } = testService({ conversations: [conversation] });

  const hydrated = await service.hydrateContextUsage(cloneConversation(conversation));
  const saved = await storage.getConversation(conversation.id);
  const hydratedReply = hydrated.messages.find((message) => message.id === pending.id);
  const savedReply = saved?.messages.find((message) => message.id === pending.id);

  assert.equal(hydrated.metadata.running, false);
  assert.deepEqual(hydrated.metadata.warnings, [INTERRUPTED_RUN_WARNING]);
  assert.equal(hydratedReply?.status, "error");
  assert.equal(hydratedReply?.content, "Interrupted before completion.");
  assert.equal(Boolean(hydratedReply?.metadata?.staleRunRecovery), true);
  assert.equal(saved?.metadata.running, false);
  assert.deepEqual(saved?.metadata.warnings, [INTERRUPTED_RUN_WARNING]);
  assert.equal(savedReply?.status, "error");
});

test("hydrateContextUsage interrupts orphaned running participant requests when stale run owner is dead", async () => {
  const requester = chatParticipant({ repoRead: true }, { id: "participant-1", handle: "nikita" });
  const target = chatParticipant({ repoRead: true }, { id: "participant-2", handle: "taylor" });
  const runId = "stale-request-run";
  const conversation = chatConversation([requester, target], "/repo");
  conversation.metadata = {
    ...conversation.metadata,
    running: true,
    runId,
    activeRunIds: [runId],
    activeRunOwnersByRunId: {
      [runId]: {
        processId: process.pid,
        startedAt: NOW,
        updatedAt: NOW
      }
    }
  };
  const requestMessage = participantRequestMessageWithItems(requester, [
    participantRequestItem(target, "running")
  ]);
  requestMessage.metadata = {
    ...requestMessage.metadata,
    hiddenFromTimeline: true
  };
  const targetPending = participantMessage(target, "target-pending", "");
  targetPending.status = "pending";
  targetPending.metadata = {
    ...targetPending.metadata,
    runId: "stale-target-run",
    parentMessageId: requestMessage.id,
    sourceMessageId: requestMessage.id
  };
  conversation.messages.push(requestMessage, targetPending);
  const { service, storage } = testService({ conversations: [conversation] });
  const serviceAny = service as any;
  chatParts(serviceAny).participantRequests.participantRequestRunners.set(requestMessage.id, new Promise(() => undefined));

  const hydrated = await service.hydrateContextUsage(cloneConversation(conversation));
  const saved = await storage.getConversation(conversation.id);
  const hydratedBatch = hydrated.messages.find((message) => message.id === requestMessage.id)?.metadata?.participantRequest;
  const hydratedTargetPending = hydrated.messages.find((message) => message.id === targetPending.id);
  const savedBatch = saved?.messages.find((message) => message.id === requestMessage.id)?.metadata?.participantRequest;
  const savedTargetPending = saved?.messages.find((message) => message.id === targetPending.id);

  assert.equal(hydrated.metadata.running, false);
  assert.equal(hydrated.metadata.runId, undefined);
  assert.equal(hydrated.metadata.activeRunIds, undefined);
  assert.equal(hydrated.metadata.activeRunOwnersByRunId, undefined);
  assert.equal(hydratedBatch?.status, "interrupted");
  assert.equal(hydratedBatch?.items[0]?.status, "interrupted");
  assert.equal(hydratedTargetPending?.status, "error");
  assert.equal(hydratedTargetPending?.content, "Interrupted before completion.");
  assert.equal(saved?.metadata.running, false);
  assert.equal(savedBatch?.status, "interrupted");
  assert.equal(savedBatch?.items[0]?.status, "interrupted");
  assert.equal(savedTargetPending?.status, "error");
});

test("dismissConversationWarnings removes persisted chat metadata warnings", async () => {
  const conversation = chatConversation([chatParticipant()], "/repo");
  conversation.metadata = {
    ...conversation.metadata,
    warnings: [INTERRUPTED_RUN_WARNING, "Other warning", INTERRUPTED_RUN_WARNING]
  };
  const { service, storage } = testService({ conversations: [conversation] });

  const updated = await service.dismissConversationWarnings({
    conversationId: conversation.id,
    warnings: [INTERRUPTED_RUN_WARNING]
  });
  const saved = await storage.getConversation(conversation.id);

  assert.deepEqual(updated?.metadata.warnings, ["Other warning"]);
  assert.deepEqual(saved?.metadata.warnings, ["Other warning"]);
});

test("stale recovery does not clear running while background runner is active", async () => {
  const conversation = chatConversation([chatParticipant()], "/repo");
  const { service, storage } = testService({ conversations: [conversation] });
  const serviceAny = service as any;

  await chatParts(serviceAny).activeRuns.beginChatRun(conversation, "origin-run");
  chatParts(serviceAny).activeRuns.incrementBackgroundRunner(conversation.id);
  await chatParts(serviceAny).activeRuns.endChatRun(conversation, "origin-run");

  let saved = await storage.getConversation(conversation.id);
  assert.equal(saved?.metadata.running, true);
  assert.equal(saved?.metadata.runId, undefined);

  const recoveredCandidate = cloneConversation(saved as Conversation);
  assert.equal(chatParts(serviceAny).runOwners.recoverStaleChatRun(recoveredCandidate), false);
  assert.equal(recoveredCandidate.metadata.running, true);
  assert.equal(recoveredCandidate.metadata.runId, undefined);

  chatParts(serviceAny).activeRuns.decrementBackgroundRunner(conversation.id);
  await chatParts(serviceAny).activeRuns.tryClearRunningIfIdle(conversation.id);

  saved = await storage.getConversation(conversation.id);
  assert.equal(saved?.metadata.running, false);
  assert.equal(saved?.metadata.runId, undefined);
});

test("tryClearRunningIfIdle waits for the chat run queue before clearing running", async () => {
  const conversation = chatConversation([chatParticipant()], "/repo");
  conversation.metadata = { ...conversation.metadata, running: true, runId: "origin-run" };
  const { service, storage } = testService({ conversations: [conversation] });
  const serviceAny = service as any;
  let releaseRunQueue!: () => void;
  chatParts(serviceAny).activeRuns.runQueues.set(conversation.id, new Promise<void>((resolve) => {
    releaseRunQueue = resolve;
  }));

  const clearing = chatParts(serviceAny).activeRuns.tryClearRunningIfIdle(conversation.id);
  await Promise.resolve();

  let saved = await storage.getConversation(conversation.id);
  assert.equal(saved?.metadata.running, true);
  assert.equal(saved?.metadata.runId, "origin-run");

  releaseRunQueue();
  await clearing;

  saved = await storage.getConversation(conversation.id);
  assert.equal(saved?.metadata.running, false);
  assert.equal(saved?.metadata.runId, undefined);
});

test("endChatRun does not clear a newer run id", async () => {
  const conversation = chatConversation([chatParticipant()], "/repo");
  conversation.metadata = { ...conversation.metadata, running: true, runId: "newer-run" };
  const { service } = testService({ conversations: [conversation] });
  const serviceAny = service as any;
  chatParts(serviceAny).activeRuns.activeRunIds.add("older-run");

  await chatParts(serviceAny).activeRuns.endChatRun(conversation, "older-run");

  assert.equal(conversation.metadata.running, true);
  assert.equal(conversation.metadata.runId, "newer-run");
  assert.equal(chatParts(serviceAny).activeRuns.activeRunIds.has("older-run"), false);
});

test("clearInterruptedRuns preserves local run metadata because storage cannot own recovery", async () => {
  const conversation = chatConversation([chatParticipant()], "/repo");
  conversation.metadata = {
    ...conversation.metadata,
    running: true,
    runId: "stale-run"
  };
  let saved = false;
  const storage = storageWithoutDatabase();
  storageParts(storage).sqlite.queryJson = async (sql: string) => {
    if (sql.includes("from conversation_messages")) {
      return conversation.messages.map((message, sequence) => ({
        sequence,
        payloadHex: Buffer.from(JSON.stringify(message), "utf8").toString("hex").toUpperCase()
      }));
    }
    assert.match(sql, /select id from conversations/);
    assert.doesNotMatch(sql, /payload_json as payloadJson/);
    return [{ id: conversation.id }];
  };
  // The body carries everything but the messages; those come from their rows.
  storageParts(storage).sqlite.queryText = async () => JSON.stringify({ ...conversation, messages: [] });
  storageParts(storage).conversationSaves.saveConversation = async () => {
    saved = true;
  };

  await storageParts(storage).startupRepairs.clearInterruptedRuns();

  assert.equal(saved, false);
});

test("clearInterruptedRuns preserves local participant compaction metadata because storage cannot own recovery", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation([participant], "/repo");
  conversation.metadata = {
    ...conversation.metadata,
    participantCompactionsByParticipantId: {
      [participant.id]: {
        runId: "stale-compact-run",
        startedAt: "2026-01-01T00:00:00.000Z"
      }
    }
  };
  let saved = false;
  const storage = storageWithoutDatabase();
  storageParts(storage).sqlite.queryJson = async (sql: string) => {
    if (sql.includes("from conversation_messages")) {
      return conversation.messages.map((message, sequence) => ({
        sequence,
        payloadHex: Buffer.from(JSON.stringify(message), "utf8").toString("hex").toUpperCase()
      }));
    }
    assert.match(sql, /select id from conversations/);
    assert.doesNotMatch(sql, /payload_json as payloadJson/);
    return [{ id: conversation.id }];
  };
  // The body carries everything but the messages; those come from their rows.
  storageParts(storage).sqlite.queryText = async () => JSON.stringify({ ...conversation, messages: [] });
  storageParts(storage).conversationSaves.saveConversation = async () => {
    saved = true;
  };

  await storageParts(storage).startupRepairs.clearInterruptedRuns();

  assert.equal(saved, false);
});

test("clearInterruptedRuns does not mark local pending turns interrupted at storage startup", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation([participant], "/repo");
  const pending = participantMessage(participant, "pending-reply", "");
  pending.status = "pending";
  pending.metadata = { ...pending.metadata, runId: "stale-run" };
  conversation.messages.push(pending);
  conversation.metadata = {
    ...conversation.metadata,
    running: true,
    runId: "stale-run"
  };
  let saved = false;
  const storage = storageWithoutDatabase();
  storage.machineProgress = () => ({ overlay: async (_id: string, messages: ChatMessage[]) => messages });
  storageParts(storage).sqlite.queryJson = async (sql: string) => {
    if (sql.includes("from conversation_messages")) {
      return conversation.messages.map((message, sequence) => ({
        sequence,
        payloadHex: Buffer.from(JSON.stringify(message), "utf8").toString("hex").toUpperCase()
      }));
    }
    assert.match(sql, /select id from conversations/);
    assert.doesNotMatch(sql, /payload_json as payloadJson/);
    return [{ id: conversation.id }];
  };
  // The body carries everything but the messages; those come from their rows.
  storageParts(storage).sqlite.queryText = async () => JSON.stringify({ ...conversation, messages: [] });
  storageParts(storage).conversationSaves.saveConversation = async () => {
    saved = true;
  };

  await storageParts(storage).startupRepairs.clearInterruptedRuns();

  assert.equal(saved, false);
});

test("clearInterruptedRuns preserves active remote run handles without warning", async () => {
  const participant = chatParticipant();
  const conversation = chatConversation([participant], "/repo");
  const pending = participantMessage(participant, "pending-remote", "");
  pending.status = "pending";
  pending.metadata = {
    ...pending.metadata,
    runId: "remote-run",
    appMessageSource: "remote-run-provider-output"
  };
  conversation.messages.push(pending);
  conversation.metadata = {
    ...conversation.metadata,
    running: true,
    runId: "remote-run",
    activeRunIds: ["remote-run"],
    activeRunParticipantIdsByRunId: {
      "remote-run": participant.id
    },
    remoteRunHandles: {
      "remote-run": {
        runId: "remote-run",
        conversationId: conversation.id,
        participantId: participant.id,
        participantHandle: participant.handle,
        worker: { host: "worker.example" },
        status: "running",
        startedAt: "2026-06-27T22:00:00.000Z",
        updatedAt: "2026-06-27T22:00:00.000Z"
      }
    }
  };
  let saved: Conversation | undefined;
  const storage = storageWithoutDatabase();
  storage.machineProgress = () => ({ overlay: async (_id: string, messages: ChatMessage[]) => messages });
  storageParts(storage).sqlite.queryJson = async (sql: string) => {
    if (sql.includes("from conversation_messages")) {
      return conversation.messages.map((message, sequence) => ({
        sequence,
        payloadHex: Buffer.from(JSON.stringify(message), "utf8").toString("hex").toUpperCase()
      }));
    }
    assert.match(sql, /select id from conversations/);
    assert.doesNotMatch(sql, /payload_json as payloadJson/);
    return [{ id: conversation.id }];
  };
  // The body carries everything but the messages; those come from their rows.
  storageParts(storage).sqlite.queryText = async () => JSON.stringify({ ...conversation, messages: [] });
  storageParts(storage).conversationSaves.saveConversation = async (next: Conversation) => {
    saved = cloneConversation(next);
  };

  await storageParts(storage).startupRepairs.clearInterruptedRuns();

  assert.equal(saved?.metadata.running, true);
  assert.equal(saved?.metadata.runId, "remote-run");
  assert.deepEqual(saved?.metadata.activeRunIds, ["remote-run"]);
  assert.equal(saved?.metadata.activeRunParticipantIdsByRunId, undefined);
  assert.equal(saved?.metadata.warnings, undefined);
});

test("stale chat metadata merge cannot resurrect terminal pending states", () => {
  const requester = chatParticipant();
  const target = chatParticipant({ repoRead: true }, { id: "participant-2", handle: "taylor" });
  const storedMessage = participantRequestMessageWithItems(requester, [
    participantRequestItem(target, "pending_approval", "2026-05-19T12:02:00.000Z")
  ]);
  const storedBatch = storedMessage.metadata?.participantRequest;
  assert.ok(storedBatch);
  const storedItem = storedBatch.items[0];
  assert.ok(storedItem);
  storedMessage.metadata = {
    ...storedMessage.metadata,
    pendingChoice: {
      id: "choice-1",
      title: "Decision",
      question: "Proceed?",
      options: [{ id: "yes", label: "Yes" }],
      status: "pending"
    }
  };
  const currentMessage = JSON.parse(JSON.stringify(storedMessage)) as ChatMessage;
  currentMessage.metadata = {
    ...currentMessage.metadata,
    pendingChoice: {
      id: "choice-1",
      title: "Decision",
      question: "Proceed?",
      options: [{ id: "yes", label: "Yes" }],
      status: "cancelled",
      cancelledAt: "2026-05-19T12:01:00.000Z"
    },
    participantRequest: {
      ...storedBatch,
      status: "denied",
      updatedAt: "2026-05-19T12:01:00.000Z",
      items: [{
        ...storedItem,
        status: "denied",
        updatedAt: "2026-05-19T12:01:00.000Z"
      }]
    }
  };
  const storedApproval: ChatAppToolApproval = {
    ...participantRequestApproval(requester, target, storedMessage, "approval-run"),
    updatedAt: "2026-05-19T12:02:00.000Z"
  };
  const currentApproval: ChatAppToolApproval = {
    ...storedApproval,
    status: "denied",
    updatedAt: "2026-05-19T12:01:00.000Z"
  };
  const { service } = testService();
  const serviceAny = service as any;

  const mergedMessages = mergeStoredChatMessages([storedMessage], [currentMessage]) as ChatMessage[];
  const mergedMetadata = mergeStoredChatMetadata(
    { pendingAppToolApprovals: [storedApproval] },
    { pendingAppToolApprovals: [currentApproval] }
  );

  assert.equal(mergedMessages[0]?.metadata?.pendingChoice?.status, "cancelled");
  assert.equal(mergedMessages[0]?.metadata?.participantRequest?.status, "denied");
  assert.equal(mergedMessages[0]?.metadata?.participantRequest?.items[0]?.status, "denied");
  assert.equal((mergedMetadata.pendingAppToolApprovals as ChatAppToolApproval[])[0]?.status, "denied");
});
