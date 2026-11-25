import assert from "node:assert/strict";
import test from "node:test";
import { chatParts } from "./chat/test/chatParts";
import { applyPermissionResumeToParticipantRequest } from "./chat/requests/requestRecords";
import type {
  ChatMessage, ChatParticipant, ChatParticipantRequestBatch, ChatParticipantRequestStatus, ParticipantConfig
} from "../../shared/types";
import {
  chatConversation, chatParticipant, clone, installedChatAgents, NOW, participantReplyMessage, testService, waitFor
} from "./chat/test/permissionFixtures";

test("auto-watch does not reprocess consumed participant request replies", async () => {
  const manager = { ...chatParticipant("codex-cli"), autoWatch: true };
  const target = chatParticipant("claude-code");
  const conversation = chatConversation([manager, target], {
    participantWatchers: {
      [manager.id]: {
        lastSeenMessageId: "user-message",
        wakeChainDepth: 0,
        updatedAt: NOW
      }
    }
  });
  conversation.messages.push(participantReplyMessage(target, "target-reply", "Review complete."));
  conversation.messages.push(participantRequestCarrierMessage(manager, target, {
    replyMessageId: "target-reply"
  }));
  const runs: ParticipantConfig[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    agents: installedChatAgents(),
    run: async (participant) => {
      runs.push(participant);
      return { participant, ok: true, content: "Should not run.", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  await chatParts(service).autoWatch.runAutoWatchEvaluation(conversation.id, "run-idle");
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(runs.length, 0);
  assert.equal(storage.current.messages.some((message: ChatMessage) => message.metadata?.autoWatchTrigger), false);
});

test("auto-watch preserves unrelated messages while filtering consumed participant request replies", async () => {
  const manager = { ...chatParticipant("codex-cli"), autoWatch: true };
  const target = chatParticipant("claude-code");
  const reviewer = { ...chatParticipant("claude-code"), id: "reviewer-participant", handle: "reviewer" };
  const conversation = chatConversation([manager, target, reviewer], {
    participantWatchers: {
      [manager.id]: {
        lastSeenMessageId: "user-message",
        wakeChainDepth: 0,
        updatedAt: NOW
      }
    }
  });
  conversation.messages.push(participantReplyMessage(reviewer, "reviewer-note", "Separate update."));
  conversation.messages.push(participantReplyMessage(target, "target-reply", "Review complete."));
  conversation.messages.push(participantRequestCarrierMessage(manager, target, {
    replyMessageId: "target-reply"
  }));
  const runs: ParticipantConfig[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    agents: installedChatAgents(),
    run: async (participant) => {
      runs.push(participant);
      return { participant, ok: true, content: "Manager evaluated.", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  await chatParts(service).autoWatch.runAutoWatchEvaluation(conversation.id, "run-idle");
  await waitFor(() => runs.length === 1);

  const trigger = storage.current.messages.find((message: ChatMessage) => message.metadata?.autoWatchTrigger);
  assert.ok(trigger);
  assert.deepEqual(trigger.metadata?.autoWatchTrigger?.messageIds, ["reviewer-note"]);
});

test("auto-watch still wakes for later messages after consumed participant request replies", async () => {
  const manager = { ...chatParticipant("codex-cli"), autoWatch: true };
  const target = chatParticipant("claude-code");
  const conversation = chatConversation([manager, target], {
    participantWatchers: {
      [manager.id]: {
        lastSeenMessageId: "user-message",
        wakeChainDepth: 0,
        updatedAt: NOW
      }
    }
  });
  conversation.messages.push(participantReplyMessage(target, "target-reply", "Review complete."));
  conversation.messages.push(participantRequestCarrierMessage(manager, target, {
    replyMessageId: "target-reply"
  }));
  conversation.messages.push(participantReplyMessage(target, "later-reply", "New follow-up."));
  const runs: ParticipantConfig[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    agents: installedChatAgents(),
    run: async (participant) => {
      runs.push(participant);
      return { participant, ok: true, content: "Manager evaluated.", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  await chatParts(service).autoWatch.runAutoWatchEvaluation(conversation.id, "run-idle");
  await waitFor(() => runs.length === 1);

  const trigger = storage.current.messages.find((message: ChatMessage) => message.metadata?.autoWatchTrigger);
  assert.ok(trigger);
  assert.deepEqual(trigger.metadata?.autoWatchTrigger?.messageIds, ["later-reply"]);
});

test("auto-watch does not filter participant request replies consumed by a different requester", async () => {
  const manager = { ...chatParticipant("codex-cli"), autoWatch: true };
  const otherRequester = { ...chatParticipant("codex-cli"), id: "other-requester", handle: "other" };
  const target = chatParticipant("claude-code");
  const conversation = chatConversation([manager, otherRequester, target], {
    participantWatchers: {
      [manager.id]: {
        lastSeenMessageId: "user-message",
        wakeChainDepth: 0,
        updatedAt: NOW
      }
    }
  });
  conversation.messages.push(participantReplyMessage(target, "target-reply", "Reply for another requester."));
  conversation.messages.push(participantRequestCarrierMessage(otherRequester, target, {
    replyMessageId: "target-reply"
  }));
  const runs: ParticipantConfig[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    agents: installedChatAgents(),
    run: async (participant) => {
      runs.push(participant);
      return { participant, ok: true, content: "Manager evaluated.", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  await chatParts(service).autoWatch.runAutoWatchEvaluation(conversation.id, "run-idle");
  await waitFor(() => runs.length === 1);

  const trigger = storage.current.messages.find((message: ChatMessage) => message.metadata?.autoWatchTrigger);
  assert.ok(trigger);
  assert.deepEqual(trigger.metadata?.autoWatchTrigger?.messageIds, ["target-reply"]);
});

test("auto-watch does not filter participant request replies before requester auto-resume consumes them", async () => {
  const manager = { ...chatParticipant("codex-cli"), autoWatch: true };
  const target = chatParticipant("claude-code");
  const conversation = chatConversation([manager, target], {
    participantWatchers: {
      [manager.id]: {
        lastSeenMessageId: "user-message",
        wakeChainDepth: 0,
        updatedAt: NOW
      }
    }
  });
  conversation.messages.push(participantReplyMessage(target, "target-reply", "Review complete."));
  conversation.messages.push(participantRequestCarrierMessage(manager, target, {
    replyMessageId: "target-reply",
    autoResumeMessageId: null,
    batchStatus: "answered"
  }));
  const runs: ParticipantConfig[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    agents: installedChatAgents(),
    run: async (participant) => {
      runs.push(participant);
      return { participant, ok: true, content: "Manager evaluated.", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  await chatParts(service).autoWatch.runAutoWatchEvaluation(conversation.id, "run-idle");
  await waitFor(() => runs.length === 1);

  const trigger = storage.current.messages.find((message: ChatMessage) => message.metadata?.autoWatchTrigger);
  assert.ok(trigger);
  assert.deepEqual(trigger.metadata?.autoWatchTrigger?.messageIds, ["target-reply"]);
});

test("auto-watch does not suppress inline completed participant request replies", async () => {
  const manager = { ...chatParticipant("codex-cli"), autoWatch: true };
  const target = chatParticipant("claude-code");
  const conversation = chatConversation([manager, target], {
    participantWatchers: {
      [manager.id]: {
        lastSeenMessageId: "user-message",
        wakeChainDepth: 0,
        updatedAt: NOW
      }
    }
  });
  conversation.messages.push(participantReplyMessage(target, "target-reply", "Inline reply."));
  conversation.messages.push(participantRequestCarrierMessage(manager, target, {
    replyMessageId: "target-reply",
    autoResumeMessageId: null,
    resumeRequester: false,
    completedInToolCall: true
  }));
  const runs: ParticipantConfig[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    agents: installedChatAgents(),
    run: async (participant) => {
      runs.push(participant);
      return { participant, ok: true, content: "Manager evaluated.", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  await chatParts(service).autoWatch.runAutoWatchEvaluation(conversation.id, "run-idle");
  await waitFor(() => runs.length === 1);

  const trigger = storage.current.messages.find((message: ChatMessage) => message.metadata?.autoWatchTrigger);
  assert.ok(trigger);
  assert.deepEqual(trigger.metadata?.autoWatchTrigger?.messageIds, ["target-reply"]);
});

test("auto-watch filters replies completed through permission approval participant request resume", async () => {
  const manager = { ...chatParticipant("codex-cli"), autoWatch: true };
  const target = chatParticipant("claude-code");
  const requestMessage = participantRequestCarrierMessage(manager, target, {
    id: "permission-request",
    batchId: "permission-batch",
    autoResumeMessageId: null,
    batchStatus: "running",
    itemStatus: "running"
  });
  const reply = participantReplyMessage(target, "target-reply", "Permission-unblocked reply.");
  const conversation = chatConversation([manager, target], {
    participantWatchers: {
      [manager.id]: {
        lastSeenMessageId: "user-message",
        wakeChainDepth: 0,
        updatedAt: NOW
      }
    }
  });
  conversation.messages.push(requestMessage, reply);
  const runs: ParticipantConfig[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    agents: installedChatAgents(),
    run: async (participant) => {
      runs.push(participant);
      return { participant, ok: true, content: "Should not run.", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  const resumeMessageId = applyPermissionResumeToParticipantRequest(
    conversation,
    requestMessage.id,
    "permission-batch",
    target,
    [reply]
  );
  const updatedRequestMessage = conversation.messages.find((message) => message.id === requestMessage.id);
  const batch = updatedRequestMessage?.metadata?.participantRequest;
  assert.equal(resumeMessageId, requestMessage.id);
  assert.equal(batch?.completedInToolCall, false);
  assert.equal(batch?.items[0]?.replyMessageId, "target-reply");
  if (batch) {
    batch.status = "completed";
    batch.autoResumeMessageId = "manager-resume";
  }
  storage.current = clone(conversation);

  await chatParts(service).autoWatch.runAutoWatchEvaluation(conversation.id, "run-idle");
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(runs.length, 0);
  assert.equal(storage.current.messages.some((message: ChatMessage) => message.metadata?.autoWatchTrigger), false);
});

function participantRequestCarrierMessage(
  requester: ChatParticipant,
  target: ChatParticipant,
  options: {
    id?: string;
    batchId?: string;
    replyMessageId?: string;
    autoResumeMessageId?: string | null;
    resumeRequester?: boolean;
    completedInToolCall?: boolean;
    batchStatus?: ChatParticipantRequestStatus;
    itemStatus?: ChatParticipantRequestStatus;
  } = {}
): ChatMessage {
  const autoResumeMessageId = options.autoResumeMessageId === undefined ? "requester-resume" : options.autoResumeMessageId;
  const batch: ChatParticipantRequestBatch = {
    id: options.batchId ?? `${options.id ?? "request-message"}-batch`,
    requesterParticipantId: requester.id,
    requesterHandle: requester.handle,
    source: "mcp",
    resumeRequester: options.resumeRequester ?? true,
    status: options.batchStatus ?? "completed",
    depth: 1,
    requesterDepth: 0,
    chainRootId: "chain-root",
    createdAt: NOW,
    updatedAt: NOW,
    triggerMessageId: "user-message",
    items: [{
      targetParticipantId: target.id,
      targetHandle: target.handle,
      prompt: "Please review.",
      status: options.itemStatus ?? "answered",
      replyMessageId: options.replyMessageId,
      createdAt: NOW,
      updatedAt: NOW
    }]
  };
  if (autoResumeMessageId) {
    batch.autoResumeMessageId = autoResumeMessageId;
  }
  if (options.completedInToolCall !== undefined) {
    batch.completedInToolCall = options.completedInToolCall;
  }
  return {
    id: options.id ?? "request-message",
    role: "participant",
    participantId: requester.id,
    participantLabel: `@${requester.handle}`,
    content: `@${target.handle} Please review.`,
    createdAt: NOW,
    status: "done",
    metadata: {
      threadId: "user-message",
      hiddenFromTimeline: true,
      participantRequest: batch
    }
  };
}
