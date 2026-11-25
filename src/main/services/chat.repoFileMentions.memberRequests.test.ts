import assert from "node:assert/strict";
import test from "node:test";
import { chatParts } from "./chat/test/chatParts";
import type { ChatMessage, ChatParticipant, Conversation } from "../../shared/types";
import {
  chatConversation, chatParticipant, NOW, participantMessage, participantRequestApproval, participantRequestItem,
  participantRequestMessageWithItems, ROLE, testService, userMessage, waitFor, withTimeout
} from "./chat/test/mentionFixtures";

test("autoResumeParticipantRequest completes and clears running state", async () => {
  const requester = chatParticipant();
  const conversation = chatConversation([requester], "/repo");
  const requestMessage = participantRequestMessage(requester);
  conversation.messages.push(requestMessage);
  const { service, storage } = testService({ conversations: [conversation] });
  const serviceAny = service as any;
  chatParts(serviceAny).chatHistory.ensureHistoryFiles = async () => "/tmp/accordagents-test-history";
  chatParts(serviceAny).turnQueue.runParticipantTurnSerialized = async () => [
    participantMessage(requester, "resume-reply", "Final required fixes are listed.")
  ];

  await chatParts(serviceAny).requesterResumes.autoResumeParticipantRequest(conversation.id, requestMessage.id);
  await waitFor(async () => {
    const saved = await storage.getConversation(conversation.id);
    const savedRequest = saved?.messages.find((message) => message.id === requestMessage.id);
    return saved?.metadata.running === false &&
      savedRequest?.metadata?.participantRequest?.status === "completed";
  });
  const saved = await storage.getConversation(conversation.id);
  const savedRequest = saved?.messages.find((message) => message.id === requestMessage.id);

  assert.equal(saved?.metadata.running, false);
  assert.equal(saved?.metadata.runId, undefined);
  assert.equal(savedRequest?.metadata?.participantRequest?.status, "completed");
  assert.equal(savedRequest?.metadata?.participantRequest?.autoResumeMessageId, "resume-reply");
});

test("requestParticipantsFromTool does not wait on top-level run queue", async () => {
  const requester = chatParticipant();
  const target = chatParticipant({ repoRead: true }, { id: "participant-2", handle: "taylor" });
  const conversation = chatConversation([requester, target], "/repo");
  conversation.messages.push(userMessage("trigger-message", "@drew ask Taylor"));
  const { service } = testService({ conversations: [conversation] });
  const serviceAny = service as any;
  let releaseRunQueue!: () => void;
  chatParts(serviceAny).activeRuns.runQueues.set(conversation.id, new Promise<void>((resolve) => {
    releaseRunQueue = resolve;
  }));

  try {
    const result = await withTimeout(
      service.requestParticipantsFromTool({
        conversationId: conversation.id,
        participantId: requester.id,
        roleConfigId: requester.roleConfigId,
        roleConfigVersion: ROLE.version,
        capabilities: ["participants.request"],
        triggerMessageId: "trigger-message",
        runId: "active-run"
      } as never, {
        requests: [{ target: "taylor", prompt: "Review this.", reason: "Need another opinion." }],
        timeoutMs: 50,
        resumeRequester: true
      }),
      250
    );
    assert.equal(result.status, "pending_approval");
  } finally {
    releaseRunQueue();
    chatParts(serviceAny).activeRuns.runQueues.delete(conversation.id);
  }
});

test("requestParticipantsFromTool reports running without approvalRequired while target is active", async () => {
  const requester = chatParticipant({ requestParticipants: "allow" });
  const target = chatParticipant({ repoRead: true }, { id: "participant-2", handle: "taylor" });
  const conversation = chatConversation([requester, target], "/repo");
  conversation.messages.push(userMessage("trigger-message", "@drew ask Taylor"));
  const { service, storage } = testService({ conversations: [conversation] });
  const serviceAny = service as any;
  let releaseTarget!: () => void;
  const targetCanFinish = new Promise<void>((resolve) => {
    releaseTarget = resolve;
  });
  chatParts(serviceAny).chatHistory.ensureHistoryFiles = async () => "/tmp/accordagents-test-history";
  chatParts(serviceAny).store.refreshStoredChatState = async () => undefined;
  chatParts(serviceAny).turnQueue.runParticipantTurnSerialized = async () => {
    await targetCanFinish;
    return [participantMessage(target, "target-reply", "Reviewed.")];
  };

  const result = await withTimeout(
    service.requestParticipantsFromTool({
      conversationId: conversation.id,
      participantId: requester.id,
      roleConfigId: requester.roleConfigId,
      roleConfigVersion: ROLE.version,
      capabilities: ["participants.request"],
      triggerMessageId: "trigger-message",
      runId: "active-run"
    } as never, {
      requests: [{ target: "taylor", prompt: "Review this.", reason: "Need another opinion." }],
      timeoutMs: 10,
      resumeRequester: false
    }),
    250
  );

  assert.equal(result.status, "running");
  assert.equal(result.approvalRequired, false);

  releaseTarget();
  await waitFor(async () => {
    const saved = await storage.getConversation(conversation.id);
    return saved?.messages.some((message) => message.id === "target-reply") === true;
  });
});

test("requestParticipantsFromTool forwards requester progress to target runs", async () => {
  const requester = chatParticipant({ requestParticipants: "allow" });
  const target = chatParticipant({ repoRead: true }, { id: "participant-2", handle: "taylor" });
  const conversation = chatConversation([requester, target], "/repo");
  conversation.messages.push(userMessage("trigger-message", "@drew ask Taylor"));
  const progressEvents: Array<{ agentProgress?: { partialContent?: string } }> = [];
  const { service } = testService({ conversations: [conversation] });
  const serviceAny = service as any;
  const requesterProgress = (progress: { agentProgress?: { partialContent?: string } }): void => {
    progressEvents.push(progress);
  };
  chatParts(serviceAny).chatHistory.ensureHistoryFiles = async () => "/tmp/accordagents-test-history";
  chatParts(serviceAny).store.refreshStoredChatState = async () => undefined;
  chatParts(serviceAny).activeRuns.runProgressCallbacks.set("active-run", requesterProgress);
  chatParts(serviceAny).turnQueue.runParticipantTurnSerialized = async (
    _conversation: Conversation,
    participant: ChatParticipant,
    _trigger: ChatMessage,
    _runId: string,
    _signal: AbortSignal | undefined,
    progress: ((event: { agentProgress?: { partialContent?: string } }) => void) | undefined
  ) => {
    progress?.({ agentProgress: { partialContent: "streamed plan" } });
    return [participantMessage(participant, "target-reply", "Reviewed.")];
  };

  await service.requestParticipantsFromTool({
    conversationId: conversation.id,
    participantId: requester.id,
    roleConfigId: requester.roleConfigId,
    roleConfigVersion: ROLE.version,
    capabilities: ["participants.request"],
    triggerMessageId: "trigger-message",
    runId: "active-run"
  } as never, {
    requests: [{ target: "taylor", prompt: "Review this.", reason: "Need another opinion." }],
    timeoutMs: 50,
    resumeRequester: false
  });

  assert.equal(progressEvents.at(-1)?.agentProgress?.partialContent, "streamed plan");
});

test("requestParticipantsFromTool uses service progress for background target runs", async () => {
  const requester = chatParticipant({ requestParticipants: "allow" });
  const target = chatParticipant({ repoRead: true }, { id: "participant-2", handle: "taylor" });
  const conversation = chatConversation([requester, target], "/repo");
  conversation.messages.push(userMessage("trigger-message", "@drew ask Taylor"));
  const progressEvents: Array<{ agentProgress?: { partialContent?: string } }> = [];
  const { service } = testService({
    conversations: [conversation],
    onProgress: (progress: { agentProgress?: { partialContent?: string } }) => progressEvents.push(progress)
  });
  const serviceAny = service as any;
  chatParts(serviceAny).chatHistory.ensureHistoryFiles = async () => "/tmp/accordagents-test-history";
  chatParts(serviceAny).store.refreshStoredChatState = async () => undefined;
  chatParts(serviceAny).turnQueue.runParticipantTurnSerialized = async (
    _conversation: Conversation,
    participant: ChatParticipant,
    _trigger: ChatMessage,
    _runId: string,
    _signal: AbortSignal | undefined,
    progress: ((event: { agentProgress?: { partialContent?: string } }) => void) | undefined
  ) => {
    progress?.({ agentProgress: { partialContent: "background stream" } });
    return [participantMessage(participant, "target-reply", "Reviewed.")];
  };

  await service.requestParticipantsFromTool({
    conversationId: conversation.id,
    participantId: requester.id,
    roleConfigId: requester.roleConfigId,
    roleConfigVersion: ROLE.version,
    capabilities: ["participants.request"],
    triggerMessageId: "trigger-message",
    runId: "active-run"
  } as never, {
    requests: [{ target: "taylor", prompt: "Review this.", reason: "Need another opinion." }],
    timeoutMs: 50,
    resumeRequester: false
  });

  assert.equal(progressEvents.at(-1)?.agentProgress?.partialContent, "background stream");
});

test("denying one participant request approval terminalizes only matching items", async () => {
  const requester = chatParticipant();
  const taylor = chatParticipant({ repoRead: true }, { id: "participant-2", handle: "taylor" });
  const casey = chatParticipant({ repoRead: true }, { id: "participant-3", handle: "casey" });
  const conversation = chatConversation([requester, taylor, casey], "/repo");
  const requestMessage = participantRequestMessageWithItems(requester, [
    participantRequestItem(taylor, "pending_approval"),
    participantRequestItem(casey, "pending_approval")
  ]);
  conversation.messages.push(requestMessage);
  conversation.metadata = {
    ...conversation.metadata,
    pendingAppToolApprovals: [participantRequestApproval(requester, taylor, requestMessage, "approval-run")]
  };
  const { service, storage } = testService({ conversations: [conversation] });

  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: "approval-taylor",
    approve: false
  });

  const saved = await storage.getConversation(conversation.id);
  const batch = saved?.messages.find((message) => message.id === requestMessage.id)?.metadata?.participantRequest;
  const taylorItem = batch?.items.find((item) => item.targetParticipantId === taylor.id);
  const caseyItem = batch?.items.find((item) => item.targetParticipantId === casey.id);

  assert.equal(taylorItem?.status, "denied");
  assert.equal(caseyItem?.status, "pending_approval");
  assert.equal(batch?.status, "pending_approval");
});

test("participantRequestStatusForTool interrupts orphaned pending approvals", async () => {
  const requester = chatParticipant();
  const target = chatParticipant({ repoRead: true }, { id: "participant-2", handle: "taylor" });
  const conversation = chatConversation([requester, target], "/repo");
  const requestMessage = participantRequestMessageWithItems(requester, [
    participantRequestItem(target, "pending_approval")
  ]);
  conversation.messages.push(requestMessage);
  const { service, storage } = testService({ conversations: [conversation] });

  const result = await service.participantRequestStatusForTool({
    conversationId: conversation.id,
    participantId: requester.id,
    roleConfigId: requester.roleConfigId,
    roleConfigVersion: ROLE.version,
    capabilities: []
  } as never, { requestId: "batch-1" });

  const saved = await storage.getConversation(conversation.id);
  const batch = saved?.messages.find((message) => message.id === requestMessage.id)?.metadata?.participantRequest;
  assert.equal((result.requests as Array<{ status: string }>)[0]?.status, "interrupted");
  assert.equal(batch?.status, "interrupted");
  assert.equal(batch?.items[0]?.status, "interrupted");
});

test("participantRequestStatusForTool preserves running request owned by another live app instance", async () => {
  const requester = chatParticipant();
  const target = chatParticipant({ repoRead: true }, { id: "participant-2", handle: "taylor" });
  const runId = "external-target-run";
  const ownerPid = process.ppid > 0 ? process.ppid : 1;
  const fresh = new Date().toISOString();
  const conversation = chatConversation([requester, target], "/repo");
  conversation.metadata = {
    ...conversation.metadata,
    running: true,
    activeRunIds: [runId],
    activeRunOwnersByRunId: {
      [runId]: {
        processId: ownerPid,
        instanceId: "external-instance",
        startedAt: NOW,
        updatedAt: fresh
      }
    }
  };
  const requestMessage = participantRequestMessageWithItems(requester, [
    participantRequestItem(target, "running")
  ]);
  const targetPending = participantMessage(target, "target-pending", "");
  targetPending.status = "pending";
  targetPending.metadata = {
    ...targetPending.metadata,
    runId,
    parentMessageId: requestMessage.id,
    sourceMessageId: requestMessage.id
  };
  conversation.messages.push(requestMessage, targetPending);
  const { service, storage } = testService({ conversations: [conversation] });

  const result = await service.participantRequestStatusForTool({
    conversationId: conversation.id,
    participantId: requester.id,
    roleConfigId: requester.roleConfigId,
    roleConfigVersion: ROLE.version,
    capabilities: []
  } as never, { requestId: "batch-1" });

  const saved = await storage.getConversation(conversation.id);
  const batch = saved?.messages.find((message) => message.id === requestMessage.id)?.metadata?.participantRequest;
  assert.equal((result.requests as Array<{ status: string }>)[0]?.status, "running");
  assert.equal(batch?.status, "running");
  assert.equal(batch?.items[0]?.status, "running");
});

test("requestParticipantsFromTool keeps nested participant request as its own visual thread root", async () => {
  const requester = chatParticipant();
  const target = chatParticipant({ repoRead: true }, { id: "participant-2", handle: "taylor" });
  const conversation = chatConversation([requester, target], "/repo");
  conversation.messages.push({
    ...userMessage("thread-reply", "@drew ask Taylor"),
    metadata: {
      threadId: "outer-thread",
      parentMessageId: "outer-root",
      chatThreadRootId: "outer-root"
    }
  });
  const snapshots: Conversation[] = [];
  const { service, storage } = testService({
    conversations: [conversation],
    onSnapshot: (snapshot) => snapshots.push(snapshot)
  });

  const result = await service.requestParticipantsFromTool({
    conversationId: conversation.id,
    participantId: requester.id,
    roleConfigId: requester.roleConfigId,
    roleConfigVersion: ROLE.version,
    capabilities: ["participants.request"],
    triggerMessageId: "thread-reply",
    triggerThreadId: "outer-thread",
    triggerParentMessageId: "outer-root",
    triggerChatThreadRootId: "outer-root",
    runId: "active-run"
  } as never, {
    requests: [{ target: "taylor", prompt: "Review this.", reason: "Need another opinion." }],
    timeoutMs: 50,
    resumeRequester: true
  });

  const saved = await storage.getConversation(conversation.id);
  const requestMessage = saved?.messages.find((message) => message.metadata?.participantRequest);

  assert.equal(result.status, "pending_approval");
  assert.ok(requestMessage);
  assert.equal(requestMessage.metadata?.threadId, "outer-thread");
  assert.equal(requestMessage.metadata?.parentMessageId, "thread-reply");
  assert.equal(requestMessage.metadata?.sourceMessageId, "thread-reply");
  assert.equal(requestMessage.metadata?.chatThreadRootId, undefined);
  assert.equal(
    snapshots.some((snapshot) => snapshot.messages.some((message) => message.metadata?.participantRequest?.id === requestMessage.metadata?.participantRequest?.id)),
    true
  );
});

test("requestParticipantsFromTool roots running recipient replies under the request message", async () => {
  const requester = chatParticipant({ requestParticipants: "allow" });
  const target = chatParticipant({ repoRead: true }, { id: "participant-2", handle: "taylor" });
  const conversation = chatConversation([requester, target], "/repo");
  conversation.messages.push({
    ...userMessage("thread-reply", "@drew ask Taylor"),
    metadata: {
      threadId: "outer-thread",
      parentMessageId: "outer-root",
      chatThreadRootId: "outer-root"
    }
  });
  const { service, storage } = testService({ conversations: [conversation] });
  const serviceAny = service as any;
  let capturedTrigger: ChatMessage | undefined;
  chatParts(serviceAny).chatHistory.ensureHistoryFiles = async () => "/tmp/accordagents-test-history";
  chatParts(serviceAny).store.refreshStoredChatState = async () => undefined;
  chatParts(serviceAny).turnQueue.runParticipantTurnSerialized = async (
    _conversation: Conversation,
    participant: ChatParticipant,
    trigger: ChatMessage
  ) => {
    capturedTrigger = trigger;
    return [{
      ...participantMessage(participant, "target-reply", "Reviewed."),
      metadata: {
        threadId: trigger.metadata?.threadId ?? trigger.id,
        parentMessageId: trigger.id,
        chatThreadRootId: trigger.metadata?.chatThreadRootId,
        sourceMessageId: trigger.id
      }
    }];
  };

  const result = await service.requestParticipantsFromTool({
    conversationId: conversation.id,
    participantId: requester.id,
    roleConfigId: requester.roleConfigId,
    roleConfigVersion: ROLE.version,
    capabilities: ["participants.request"],
    triggerMessageId: "thread-reply",
    triggerThreadId: "outer-thread",
    triggerParentMessageId: "outer-root",
    triggerChatThreadRootId: "outer-root",
    runId: "active-run"
  } as never, {
    requests: [{ target: "taylor", prompt: "Review this.", reason: "Need another opinion." }],
    timeoutMs: 50,
    resumeRequester: false
  });

  const saved = await storage.getConversation(conversation.id);
  const requestMessage = saved?.messages.find((message) => message.metadata?.participantRequest);
  const targetReply = saved?.messages.find((message) => message.id === "target-reply");

  assert.equal(result.status, "completed");
  assert.ok(requestMessage);
  assert.equal(requestMessage.metadata?.chatThreadRootId, undefined);
  assert.equal(capturedTrigger?.id, requestMessage.id);
  assert.equal(capturedTrigger?.metadata?.chatThreadRootId, requestMessage.id);
  assert.equal(targetReply?.metadata?.threadId, "outer-thread");
  assert.equal(targetReply?.metadata?.parentMessageId, requestMessage.id);
  assert.equal(targetReply?.metadata?.chatThreadRootId, requestMessage.id);
});

test("normal participant finalization infers participant requests from assigned handles", async () => {
  const manager = chatParticipant({ requestParticipants: "allow" }, { id: "manager", handle: "nikita" });
  const drew = chatParticipant({ repoRead: true }, { id: "drew", handle: "drew-codex-engineer" });
  const taylor = chatParticipant({ repoRead: true }, { id: "taylor", handle: "taylor-claude-engineer", kind: "claude-code" });
  const conversation = chatConversation([manager, drew, taylor], "/repo");
  const { service, storage } = testService({ conversations: [conversation] });

  await chatParts(service).pendingReplies.finalizePendingParticipantMessage(
    conversation,
    manager,
    participantMessage(
      manager,
      "source-message",
      "@drew-codex-engineer @taylor-claude-engineer we need to implement new feature:\n\nprepare exact implementation plan independently."
    )
  );

  const saved = await storage.getConversation(conversation.id);
  const requestMessage = saved?.messages.find((message) => message.metadata?.participantRequest);
  const batch = requestMessage?.metadata?.participantRequest;
  assert.ok(requestMessage);
  assert.equal(batch?.source, "inferred");
  assert.equal(batch?.triggerMessageId, "source-message");
  assert.deepEqual(batch?.items.map((item) => item.targetHandle), ["drew-codex-engineer", "taylor-claude-engineer"]);
});

function participantRequestMessage(requester: ChatParticipant): ChatMessage {
  return {
    id: "request-message",
    role: "participant",
    participantId: requester.id,
    participantLabel: `@${requester.handle}`,
    content: "@taylor Review this.",
    createdAt: NOW,
    status: "done",
    metadata: {
      threadId: "request-message",
      participantRequest: {
        id: "batch-1",
        requesterParticipantId: requester.id,
        requesterHandle: requester.handle,
        source: "mcp",
        resumeRequester: true,
        status: "answered",
        depth: 1,
        createdAt: NOW,
        updatedAt: NOW,
        triggerMessageId: "trigger-message",
        items: [{
          targetParticipantId: "participant-2",
          targetHandle: "taylor",
          prompt: "Review this.",
          status: "answered",
          replyMessageId: "target-reply",
          createdAt: NOW,
          updatedAt: NOW
        }]
      }
    }
  };
}
