import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { chatParts } from "./chat/test/chatParts";
import type { ChatMessage, ChatParticipant, Conversation } from "../../shared/types";
import {
  chatConversation, chatParticipant, participantMessage, participantRequestItem, participantRequestMessageWithItems, testService,
  waitFor, withTimeout
} from "./chat/test/mentionFixtures";

test("respondToMentions returns after ingest and emits terminal error when participant run fails", async () => {
  const requester = chatParticipant();
  const target = chatParticipant({}, { id: "participant-2", handle: "taylor" });
  const conversation = chatConversation([requester, target], "/repo");
  const sourceMessage = participantMessage(requester, "source-message", "@taylor please review");
  sourceMessage.metadata = {
    ...sourceMessage.metadata,
    pendingMentions: [{
      targetParticipantId: target.id,
      targetHandle: target.handle,
      status: "pending"
    }]
  };
  conversation.messages.push(sourceMessage);
  const { service, storage } = testService({ conversations: [conversation] });
  const progress: Array<{ phase: string; message: string }> = [];
  chatParts(service).participantBatch.runParticipantBatch = async () => {
    throw new Error("mention exploded");
  };

  await service.respondToMentions(
    {
      conversationId: conversation.id,
      runId: "mention-failure",
      sourceMessageId: sourceMessage.id,
      targetParticipantIds: [target.id],
      approve: true
    },
    undefined,
    (item) => progress.push({ phase: item.phase, message: item.message })
  );
  await waitFor(async () => {
    const saved = await storage.getConversation(conversation.id);
    return saved?.metadata.running === false &&
      progress.some((item) => item.phase === "error" && item.message === "mention exploded");
  });

  const saved = await storage.getConversation(conversation.id);
  assert.equal(saved?.metadata.running, false);
  assert.equal(saved?.metadata.runId, undefined);
  assert.equal(progress.some((item) => item.phase === "error" && item.message === "mention exploded"), true);
});

test("respondToChoice returns after ingest and emits terminal error when requester run fails", async () => {
  const requester = chatParticipant();
  const conversation = chatConversation([requester], "/repo");
  const sourceMessage = participantMessage(requester, "choice-message", "Choose an option.");
  sourceMessage.metadata = {
    ...sourceMessage.metadata,
    pendingChoice: {
      id: "choice-1",
      title: "Decision",
      question: "Proceed?",
      options: [{ id: "yes", label: "Yes" }],
      status: "pending"
    }
  };
  conversation.messages.push(sourceMessage);
  const { service, storage } = testService({ conversations: [conversation] });
  const progress: Array<{ phase: string; message: string }> = [];
  chatParts(service).turnQueue.runParticipantTurnSerialized = async () => {
    throw new Error("choice exploded");
  };

  await service.respondToChoice(
    {
      conversationId: conversation.id,
      runId: "choice-failure",
      sourceMessageId: sourceMessage.id,
      choiceId: "choice-1",
      selectedOptionId: "yes"
    },
    undefined,
    (item) => progress.push({ phase: item.phase, message: item.message })
  );
  await waitFor(async () => {
    const saved = await storage.getConversation(conversation.id);
    return saved?.metadata.running === false &&
      progress.some((item) => item.phase === "error" && item.message === "choice exploded");
  });

  const saved = await storage.getConversation(conversation.id);
  assert.equal(saved?.metadata.running, false);
  assert.equal(saved?.metadata.runId, undefined);
  assert.equal(progress.some((item) => item.phase === "error" && item.message === "choice exploded"), true);
});

// A phone's own answer was refused as "Selected option was not found." and the
// phone, told nothing, showed it on its way for an hour (the User, 2026-10-01).
test("a durable choice answer is taken with the own-answer option and kept on the choice when refused", async () => {
  const requester = chatParticipant();
  const conversation = chatConversation([requester], "/repo");
  const sourceMessage = participantMessage(requester, "choice-message", "Choose an option.");
  sourceMessage.metadata = {
    ...sourceMessage.metadata,
    pendingChoice: { id: "choice-1", title: "Decision", question: "Proceed?", options: [{ id: "yes", label: "Yes" }], status: "pending" }
  };
  conversation.messages.push(sourceMessage);
  const { service, storage } = testService({ conversations: [conversation] });
  const serviceAny = service as any;
  chatParts(serviceAny).chatHistory.ensureHistoryFiles = async () => "/tmp/accordagents-test-history";
  chatParts(serviceAny).turnQueue.runParticipantTurnSerialized = async () => [participantMessage(requester, "choice-reply", "Choice handled.")];
  // An answer from the User's server, as its card's device applies it: named
  // by the card's answer, refused under the operation it came in.
  const guard = (operationId: string) => ({ decisionEventId: `card-answer:choice:${sourceMessage.id}:${operationId}`, operationId, beforeApply: async () => undefined });
  const answer = (patch: Record<string, unknown>, operationId?: string) => service.respondToChoice({
    conversationId: conversation.id, sourceMessageId: sourceMessage.id, choiceId: "choice-1", ...patch
  } as never, undefined, undefined, operationId ? guard(operationId) : undefined);
  // A longer flow in the same chat holds a copy read before any refusal.
  const stale = structuredClone(await storage.getConversation(conversation.id)) as Conversation;
  const refusals = async () => (await storage.getConversation(conversation.id))?.messages
    .find((message) => message.id === sourceMessage.id)?.metadata?.pendingChoice?.refusals?.map((item) => [item.operationId, item.reason]);

  await assert.rejects(answer({ selectedOptionId: "nope" }, "choice:choice-1:nope"), /Selected option was not found\./);
  await assert.rejects(answer({ selectedOptionId: "__custom__", customAnswer: " " }, "choice:choice-1:__custom__:empty"), /Custom choice answer is required\./);
  await assert.rejects(answer({ selectedOptionId: "nope" }, "choice:choice-1:nope"), /Selected option was not found\./);
  assert.deepEqual(await refusals(), [
    ["choice:choice-1:__custom__:empty", "Custom choice answer is required."],
    ["choice:choice-1:nope", "Selected option was not found."]
  ], "each refused answer is kept once, by the operation it was sent under");
  await assert.rejects(answer({ selectedOptionId: "nope-again" }), /Selected option was not found\./);
  assert.equal((await refusals())?.length, 2, "an answer that was not a durable decision names no operation to keep");
  await chatParts(serviceAny).store.withChatMutation(stale, async () => {
    stale.updatedAt = new Date().toISOString();
    await chatParts(serviceAny).store.saveConversation(stale);
  });
  assert.equal((await refusals())?.length, 2, "a flow holding an older copy of the waiting choice keeps the refusals recorded since");

  await answer({ selectedOptionId: "__custom__", customAnswer: "the third one" }, "choice:choice-1:__custom__:abc");
  const choice = (await storage.getConversation(conversation.id))?.messages.find((message) => message.id === sourceMessage.id)?.metadata?.pendingChoice;
  assert.equal(choice?.status, "selected", "the phone's own answer is taken");
  assert.equal(choice?.customAnswer, "the third one");
});

test("respondToChoice releases chat run queue while requester turn continues", async () => {
  const requester = chatParticipant();
  const conversation = chatConversation([requester], "/repo");
  const sourceMessage = participantMessage(requester, "choice-message", "Choose an option.");
  sourceMessage.metadata = {
    ...sourceMessage.metadata,
    pendingChoice: {
      id: "choice-1",
      title: "Decision",
      question: "Proceed?",
      options: [{ id: "yes", label: "Yes" }],
      status: "pending"
    }
  };
  conversation.messages.push(sourceMessage);
  const { service, storage } = testService({ conversations: [conversation] });
  const serviceAny = service as any;
  let runStarted = false;
  let choiceTriggerMessage: ChatMessage | undefined;
  let releaseRun!: () => void;
  const runCanFinish = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  chatParts(serviceAny).chatHistory.ensureHistoryFiles = async () => "/tmp/accordagents-test-history";
  chatParts(serviceAny).turnQueue.runParticipantTurnSerialized = async (
    _conversation: Conversation,
    _requester: ChatParticipant,
    triggerMessage: ChatMessage
  ) => {
    runStarted = true;
    choiceTriggerMessage = triggerMessage;
    await runCanFinish;
    return [participantMessage(requester, "choice-reply", "Choice handled.")];
  };

  await withTimeout(
    service.respondToChoice({
      conversationId: conversation.id,
      runId: "choice-run",
      sourceMessageId: sourceMessage.id,
      choiceId: "choice-1",
      selectedOptionId: "yes"
    }),
    250
  );
  await waitFor(() => runStarted);

  assert.equal(chatParts(serviceAny).activeRuns.runQueues.has(conversation.id), false);
  const savedDuringRun = await storage.getConversation(conversation.id);
  assert.equal(savedDuringRun?.metadata.running, true);
  const savedSelectionMessage = savedDuringRun?.messages.find((message) =>
    message.role === "user" &&
    message.metadata?.sourceMessageId === sourceMessage.id
  );
  assert.ok(savedSelectionMessage);
  assert.equal(savedSelectionMessage.metadata?.hiddenFromTimeline, true);
  assert.equal(savedSelectionMessage.metadata?.threadId, sourceMessage.metadata?.threadId);
  assert.equal(savedSelectionMessage.metadata?.parentMessageId, sourceMessage.id);
  // A card on the main timeline: the member answers there, not in a thread under the card.
  assert.equal(savedSelectionMessage.metadata?.chatThreadRootId, undefined);
  assert.match(savedSelectionMessage.content, /^Choice selected for @drew\./);
  assert.match(savedSelectionMessage.content, /Choice: Decision/);
  assert.match(savedSelectionMessage.content, /Question: Proceed\?/);
  assert.match(savedSelectionMessage.content, /Selected option: Yes/);
  assert.ok(choiceTriggerMessage);
  assert.equal(choiceTriggerMessage.id, savedSelectionMessage.id);
  assert.equal(choiceTriggerMessage.content, savedSelectionMessage.content);
  assert.equal(choiceTriggerMessage.metadata?.hiddenFromTimeline, true);

  releaseRun();
  await waitFor(async () => {
    const saved = await storage.getConversation(conversation.id);
    return saved?.metadata.running === false &&
      saved.messages.some((message) => message.content === "Choice handled.");
  });
});

test("respondToChoice can cancel without returning control to requester", async () => {
  const requester = chatParticipant();
  const conversation = chatConversation([requester], "/repo");
  const sourceMessage = participantMessage(requester, "choice-message", "Choose an option.");
  sourceMessage.metadata = {
    ...sourceMessage.metadata,
    pendingChoice: {
      id: "choice-1",
      title: "Decision",
      question: "Proceed?",
      options: [{ id: "yes", label: "Yes" }],
      recommendedOptionId: "yes",
      status: "pending"
    }
  };
  conversation.messages.push(sourceMessage);
  const { service, storage } = testService({ conversations: [conversation] });
  const serviceAny = service as any;
  let requesterRan = false;
  chatParts(serviceAny).turnQueue.runParticipantTurnSerialized = async () => {
    requesterRan = true;
    return [participantMessage(requester, "choice-reply", "Choice handled.")];
  };

  const result = await service.respondToChoice({
    conversationId: conversation.id,
    runId: "choice-cancel",
    sourceMessageId: sourceMessage.id,
    choiceId: "choice-1",
    cancel: true
  });

  assert.equal(requesterRan, false);
  assert.notEqual(result.conversation.metadata.running, true);
  const saved = await storage.getConversation(conversation.id);
  assert.notEqual(saved?.metadata.running, true);
  assert.equal(saved?.metadata.runId, undefined);
  assert.equal(saved?.messages.length, 1);
  assert.equal(saved?.messages[0]?.metadata?.pendingChoice?.status, "cancelled");
  assert.equal(saved?.messages[0]?.metadata?.pendingChoice?.selectedOptionId, undefined);
  assert.ok(saved?.messages[0]?.metadata?.pendingChoice?.cancelledAt);
});

test("respondToChoice waits for persisted ingest and rejects duplicate choice answers", async () => {
  const requester = chatParticipant();
  const conversation = chatConversation([requester], "/repo");
  const sourceMessage = participantMessage(requester, "choice-message", "Choose an option.");
  sourceMessage.metadata = {
    ...sourceMessage.metadata,
    pendingChoice: {
      id: "choice-1",
      title: "Decision",
      question: "Proceed?",
      options: [{ id: "yes", label: "Yes" }],
      status: "pending"
    }
  };
  conversation.messages.push(sourceMessage);
  const { service, storage } = testService({ conversations: [conversation] });
  const serviceAny = service as any;
  let releaseRun!: () => void;
  const runCanFinish = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  chatParts(serviceAny).chatHistory.ensureHistoryFiles = async () => "/tmp/accordagents-test-history";
  chatParts(serviceAny).turnQueue.runParticipantTurnSerialized = async () => {
    await runCanFinish;
    return [participantMessage(requester, "choice-reply", "Choice handled.")];
  };

  const originalSave = storage.saveConversation.bind(storage);
  let releaseFirstSave!: () => void;
  let firstSaveStarted = false;
  let blockFirstSave = true;
  const firstSaveCanFinish = new Promise<void>((resolve) => {
    releaseFirstSave = resolve;
  });
  storage.saveConversation = async (savedConversation: Conversation): Promise<void> => {
    await originalSave(savedConversation);
    if (!blockFirstSave) {
      return;
    }
    blockFirstSave = false;
    firstSaveStarted = true;
    await firstSaveCanFinish;
  };

  const first = service.respondToChoice({
    conversationId: conversation.id,
    runId: "choice-run",
    sourceMessageId: sourceMessage.id,
    choiceId: "choice-1",
    selectedOptionId: "yes"
  });
  await waitFor(() => firstSaveStarted);

  let firstResolved = false;
  void first.then(() => {
    firstResolved = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(firstResolved, false);

  releaseFirstSave();
  await first;

  await assert.rejects(
    () => service.respondToChoice({
      conversationId: conversation.id,
      runId: "choice-run-duplicate",
      sourceMessageId: sourceMessage.id,
      choiceId: "choice-1",
      selectedOptionId: "yes"
    }),
    /Choice request has already been answered/
  );

  releaseRun();
  await waitFor(async () => {
    const saved = await storage.getConversation(conversation.id);
    return saved?.metadata.running === false &&
      saved.messages.some((message) => message.content === "Choice handled.");
  });
});

test("respondToMentions waits for persisted ingest and rejects duplicate approvals", async () => {
  const requester = chatParticipant();
  const target = chatParticipant({}, { id: "participant-2", handle: "taylor" });
  const conversation = chatConversation([requester, target], "/repo");
  const sourceMessage = participantMessage(requester, "source-message", "@taylor please review");
  sourceMessage.metadata = {
    ...sourceMessage.metadata,
    pendingMentions: [{
      targetParticipantId: target.id,
      targetHandle: target.handle,
      status: "pending"
    }]
  };
  conversation.messages.push(sourceMessage);
  const { service, storage } = testService({ conversations: [conversation] });
  const serviceAny = service as any;
  let releaseBatch!: () => void;
  const batchCanFinish = new Promise<void>((resolve) => {
    releaseBatch = resolve;
  });
  chatParts(serviceAny).participantBatch.runParticipantBatch = async () => {
    await batchCanFinish;
  };

  const originalSave = storage.saveConversation.bind(storage);
  let releaseFirstSave!: () => void;
  let firstSaveStarted = false;
  let blockFirstSave = true;
  const firstSaveCanFinish = new Promise<void>((resolve) => {
    releaseFirstSave = resolve;
  });
  storage.saveConversation = async (savedConversation: Conversation): Promise<void> => {
    await originalSave(savedConversation);
    if (!blockFirstSave) {
      return;
    }
    blockFirstSave = false;
    firstSaveStarted = true;
    await firstSaveCanFinish;
  };

  const first = service.respondToMentions({
    conversationId: conversation.id,
    runId: "mention-run",
    sourceMessageId: sourceMessage.id,
    targetParticipantIds: [target.id],
    approve: true
  });
  await waitFor(() => firstSaveStarted);

  let firstResolved = false;
  void first.then(() => {
    firstResolved = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(firstResolved, false);

  releaseFirstSave();
  await first;

  await assert.rejects(
    () => service.respondToMentions({
      conversationId: conversation.id,
      runId: "mention-run-duplicate",
      sourceMessageId: sourceMessage.id,
      targetParticipantIds: [target.id],
      approve: true
    }),
    /Select at least one pending mention/
  );

  releaseBatch();
  await waitFor(async () => {
    const saved = await storage.getConversation(conversation.id);
    const savedSource = saved?.messages.find((message) => message.id === sourceMessage.id);
    return saved?.metadata.running === false &&
      savedSource?.metadata?.pendingMentions?.[0]?.status === "approved";
  });
});

test("respondToMentions keeps parent run cancellable after fast return", async () => {
  const requester = chatParticipant();
  const target = chatParticipant({}, { id: "participant-2", handle: "taylor" });
  const conversation = chatConversation([requester, target], "/repo");
  const sourceMessage = participantMessage(requester, "source-message", "@taylor please review");
  sourceMessage.metadata = {
    ...sourceMessage.metadata,
    pendingMentions: [{
      targetParticipantId: target.id,
      targetHandle: target.handle,
      status: "pending"
    }]
  };
  conversation.messages.push(sourceMessage);
  const { service, storage } = testService({ conversations: [conversation] });
  const serviceAny = service as any;
  let batchStarted = false;
  let batchSignal: AbortSignal | undefined;
  let releaseBatch!: () => void;
  const batchCanFinish = new Promise<void>((resolve) => {
    releaseBatch = resolve;
  });
  chatParts(serviceAny).participantBatch.runParticipantBatch = async (
    _conversation: Conversation,
    _participants: ChatParticipant[],
    _triggerMessage: ChatMessage,
    _runId: string,
    signal: AbortSignal | undefined
  ) => {
    batchSignal = signal;
    batchStarted = true;
    await batchCanFinish;
  };

  await service.respondToMentions({
    conversationId: conversation.id,
    runId: "mention-parent-run",
    sourceMessageId: sourceMessage.id,
    targetParticipantIds: [target.id],
    approve: true
  });

  assert.equal(service.cancelRun("mention-parent-run"), true);
  await waitFor(() => batchStarted);
  assert.equal(batchSignal?.aborted, true);

  releaseBatch();
  await waitFor(async () => {
    const saved = await storage.getConversation(conversation.id);
    return saved?.metadata.running === false &&
      !chatParts(serviceAny).activeRuns.chatRunControllers.has("mention-parent-run");
  });
});

test("superseded participant turn preserves older pending choices while closing other pending interactions", () => {
  const requester = chatParticipant();
  const target = chatParticipant({ repoRead: true }, { id: "participant-2", handle: "taylor" });
  const conversation = chatConversation([requester, target], "/repo");
  const choiceMessage = participantMessage(requester, "choice-message", "Choose.");
  choiceMessage.metadata = {
    ...choiceMessage.metadata,
    pendingChoice: {
      id: "choice-1",
      title: "Decision",
      question: "Proceed?",
      options: [{ id: "yes", label: "Yes" }],
      status: "pending"
    },
    pendingMentions: [{
      targetParticipantId: target.id,
      targetHandle: target.handle,
      status: "pending"
    }]
  };
  const requestMessage = participantRequestMessageWithItems(requester, [
    participantRequestItem(target, "running")
  ]);
  conversation.messages.push(choiceMessage, requestMessage);
  const { service } = testService({ conversations: [conversation] });

  chatParts(service).approvalDecisions.resolveSupersededParticipantInteractions(conversation, requester.id);

  assert.equal(choiceMessage.metadata?.pendingChoice?.status, "pending");
  assert.equal(choiceMessage.metadata?.pendingChoice?.cancelledAt, undefined);
  assert.equal(choiceMessage.metadata?.pendingMentions?.[0]?.status, "rejected");
  assert.equal(requestMessage.metadata?.participantRequest?.status, "interrupted");
  assert.equal(requestMessage.metadata?.participantRequest?.items[0]?.status, "interrupted");
});

test("respondToChoice succeeds after an intervening same-participant turn", async () => {
  const requester = chatParticipant();
  const conversation = chatConversation([requester], "/repo");
  const choiceMessage = participantMessage(requester, "choice-message", "Push approval needed.");
  choiceMessage.metadata = {
    ...choiceMessage.metadata,
    pendingChoice: {
      id: "choice-1",
      title: "Push Approval",
      question: "Push to origin/main?",
      options: [{ id: "approve", label: "Approve push" }, { id: "hold", label: "Hold" }],
      status: "pending"
    }
  };
  const laterMessage = participantMessage(requester, "later-message", "");
  laterMessage.status = "pending";
  laterMessage.metadata = {
    ...laterMessage.metadata,
    runId: "later-run"
  };
  conversation.messages.push(choiceMessage, laterMessage);
  const { service, storage } = testService({ conversations: [conversation] });
  const serviceAny = service as any;
  let routedParticipantId = "";
  let choiceTriggerMessage: ChatMessage | undefined;
  chatParts(serviceAny).chatHistory.ensureHistoryFiles = async () => "/tmp/accordagents-test-history";
  chatParts(serviceAny).turnQueue.runParticipantTurnSerialized = async (
    _conversation: Conversation,
    participant: ChatParticipant,
    triggerMessage: ChatMessage
  ) => {
    routedParticipantId = participant.id;
    choiceTriggerMessage = triggerMessage;
    return [participantMessage(requester, "choice-reply", "Push approval handled.")];
  };

  chatParts(serviceAny).approvalDecisions.resolveSupersededParticipantInteractions(conversation, requester.id, laterMessage.id);
  assert.equal(choiceMessage.metadata?.pendingChoice?.status, "pending");

  await service.respondToChoice({
    conversationId: conversation.id,
    runId: "choice-run",
    sourceMessageId: choiceMessage.id,
    choiceId: "choice-1",
    selectedOptionId: "approve"
  });

  await waitFor(async () => {
    const saved = await storage.getConversation(conversation.id);
    return saved?.messages.some((message) => message.content === "Push approval handled.") === true;
  });

  const saved = await storage.getConversation(conversation.id);
  const savedChoice = saved?.messages.find((message) => message.id === choiceMessage.id)?.metadata?.pendingChoice;
  const savedSelectionMessage = saved?.messages.find((message) =>
    message.role === "user" &&
    message.metadata?.sourceMessageId === choiceMessage.id
  );
  assert.equal(savedChoice?.status, "selected");
  assert.equal(savedChoice?.selectedOptionId, "approve");
  assert.equal(routedParticipantId, requester.id);
  assert.ok(savedSelectionMessage);
  assert.ok(choiceTriggerMessage);
  assert.equal(choiceTriggerMessage.id, savedSelectionMessage.id);
  assert.equal(choiceTriggerMessage.metadata?.hiddenFromTimeline, true);
  assert.match(choiceTriggerMessage.content, /Choice: Push Approval/);
  assert.match(choiceTriggerMessage.content, /Selected option: Approve push/);
});

test("stopping a later same-participant run leaves older pending choice answerable", async () => {
  const requester = chatParticipant();
  const conversation = chatConversation([requester], "/repo");
  const choiceMessage = participantMessage(requester, "choice-message", "Push approval needed.");
  choiceMessage.metadata = {
    ...choiceMessage.metadata,
    pendingChoice: {
      id: "choice-1",
      title: "Push Approval",
      question: "Push to origin/main?",
      options: [{ id: "approve", label: "Approve push" }, { id: "hold", label: "Hold" }],
      status: "pending"
    }
  };
  const laterMessage = participantMessage(requester, "later-message", "");
  laterMessage.status = "pending";
  laterMessage.metadata = {
    ...laterMessage.metadata,
    runId: "later-run"
  };
  conversation.messages.push(choiceMessage, laterMessage);
  const { service, storage } = testService({ conversations: [conversation] });
  const serviceAny = service as any;

  chatParts(serviceAny).approvalDecisions.resolveSupersededParticipantInteractions(conversation, requester.id, laterMessage.id);
  await chatParts(serviceAny).participantBatch.discardStoppedTargetRun(conversation, "later-run", requester, laterMessage.id);

  const saved = await storage.getConversation(conversation.id);
  const savedChoice = saved?.messages.find((message) => message.id === choiceMessage.id)?.metadata?.pendingChoice;
  assert.equal(savedChoice?.status, "pending");
  assert.equal(savedChoice?.cancelledAt, undefined);
  assert.equal(saved?.messages.some((message) => message.id === laterMessage.id), false);
});

test("resolveSupersededParticipantInteractions does not reference pendingChoice", async () => {
  const source = await readFile(path.join(process.cwd(), "src/main/services/chat/approvals/approvalDecisions.ts"), "utf8");
  const method = source.match(/\n  resolveSupersededParticipantInteractions\([\s\S]*?\n  (?:private )?markPendingAppToolApprovalsForRunTerminal/);
  assert.ok(method);
  assert.equal(method?.[0].includes("pendingChoice"), false);
});
