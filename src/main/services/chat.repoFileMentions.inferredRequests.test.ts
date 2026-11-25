import assert from "node:assert/strict";
import test from "node:test";
import { chatParts } from "./chat/test/chatParts";
import { normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { normalizeInferredParticipantRequestThreads } from "../../shared/chatParticipantRequestThreads";
import type { ChatMessage, ChatParticipant, Conversation } from "../../shared/types";
import { chatConversation, chatParticipant, cloneConversation, NOW, participantMessage, testService } from "./chat/test/mentionFixtures";

test("an inferred task is titled by the reply's sentence that asks the member, inline code kept and no @-names", async () => {
  const requester = chatParticipant();
  const target = chatParticipant({ repoRead: true }, { id: "participant-2", handle: "taylor" });
  const other = chatParticipant({ repoRead: true }, { id: "participant-3", handle: "drew" });
  const conversation = chatConversation([requester, target, other], "/repo");
  const source = participantMessage(requester, "source-message",
    "I fixed `chat.ts`. Thanks...@taylor can you run `npm test` on `src/app.ts`?\n```\n@taylor ignored in code\n```");
  const { service } = testService({ conversations: [conversation] });

  await chatParts(service).pendingReplies.appendParticipantTurnMessages(conversation, requester, [source]);

  const batch = conversation.messages.find((message) => message.metadata?.participantRequest)?.metadata?.participantRequest;
  const titles = Object.fromEntries((batch?.items ?? []).map((item) => [item.targetHandle, item.title]));
  assert.equal(titles.taylor, "Thanks... can you run npm test on…");
});

test("inferred participant request carrier is hidden and rooted to the source visual root", async () => {
  const requester = chatParticipant();
  const target = chatParticipant({ repoRead: true }, { id: "participant-2", handle: "taylor" });
  const conversation = chatConversation([requester, target], "/repo");
  const source = {
    ...participantMessage(requester, "source-message", "Taylor should check this. @taylor please verify."),
    metadata: {
      threadId: "outer-thread",
      parentMessageId: "outer-root",
      chatThreadRootId: "outer-root"
    }
  };
  const { service } = testService({ conversations: [conversation] });

  await chatParts(service).pendingReplies.appendParticipantTurnMessages(conversation, requester, [source]);

  const requestMessage = conversation.messages.find((message) => message.metadata?.participantRequest);
  const batch = requestMessage?.metadata?.participantRequest;
  assert.ok(requestMessage);
  assert.equal(batch?.source, "inferred");
  assert.equal(batch?.triggerMessageId, "source-message");
  // Named in the sessions view by the reply's sentence that asks it, without
  // @-names (the User, 2026-11-22).
  assert.equal(batch?.items[0]?.title, "please verify");
  assert.equal(requestMessage.metadata?.hiddenFromTimeline, true);
  assert.equal(requestMessage.metadata?.threadId, "outer-thread");
  assert.equal(requestMessage.metadata?.parentMessageId, "source-message");
  assert.equal(requestMessage.metadata?.sourceMessageId, "source-message");
  assert.equal(requestMessage.metadata?.chatThreadRootId, "outer-root");
});

test("inferred member requests follow the requester's permission as saved, not the turn's older copy", async () => {
  const savedRequester = chatParticipant({ requestParticipants: "ask" }, { id: "manager", handle: "nikita" });
  const target = chatParticipant({ repoRead: true }, { id: "codex", handle: "codex" });
  const conversation = chatConversation([savedRequester, target], "/repo");
  const { service } = testService({ conversations: [conversation] });
  // The turn started while it was still allowed; the User switched it to Ask meanwhile.
  const turnCopy = { ...savedRequester, permissions: { ...normalizeChatAgentPermissions(savedRequester.permissions), requestParticipants: "allow" as const } };

  await chatParts(service).pendingReplies.appendParticipantTurnMessages(conversation, turnCopy, [
    participantMessage(savedRequester, "source-message", "@codex please verify this.")
  ]);

  const batch = conversation.messages.find((message) => message.metadata?.participantRequest)?.metadata?.participantRequest;
  assert.ok(batch);
  assert.deepEqual(batch.items.map((item) => item.status), ["pending_approval"]);
});

test("inferred participant requests trigger mentioned participants and rely on addressee guidance", async () => {
  const manager = chatParticipant({}, { id: "manager", handle: "nikita" });
  const codex = chatParticipant({ repoRead: true }, { id: "codex", handle: "codex" });
  const claude = chatParticipant({ repoRead: true }, { id: "claude", handle: "claude" });
  const conversation = chatConversation([manager, codex, claude], "/repo");
  const { service, storage } = testService({ conversations: [conversation] });

  await chatParts(service).pendingReplies.appendParticipantTurnMessages(conversation, manager, [
    participantMessage(
      manager,
      "source-message",
      "@codex Please reply with the current EUR/RUB rate, including source and timestamp. After that I'll ask @claude for USD/RUB."
    )
  ]);

  const requestMessage = conversation.messages.find((message) => message.metadata?.participantRequest);
  const batch = requestMessage?.metadata?.participantRequest;
  assert.ok(requestMessage);
  assert.equal(batch?.source, "inferred");
  assert.deepEqual(batch?.items.map((item) => item.targetHandle), ["codex", "claude"]);
  assert.match(batch?.items[0]?.prompt ?? "", /First determine whether you are the primary\/direct addressee/);
  assert.match(batch?.items[1]?.prompt ?? "", /Reply only "Noted"/);
});

test("inferred participant request triggers when action appears later in the message", async () => {
  const manager = chatParticipant({ requestParticipants: "allow" }, { id: "manager", handle: "nikita" });
  const drew = chatParticipant({ repoRead: true }, { id: "drew", handle: "drew-codex-engineer" });
  const conversation = chatConversation([manager, drew], "/repo");
  const { service, storage } = testService({ conversations: [conversation] });

  await chatParts(service).pendingReplies.finalizePendingParticipantMessage(
    conversation,
    manager,
    participantMessage(
      manager,
      "source-message",
      "@drew-codex-engineer user found a visual issue in the Accord participant list. In `/private/tmp/accordagents-accord-modal-drew`, update the modal so participant rows match the attached reference, rerun focused verification plus Electron QA, and report the updated instance details for manual check."
    )
  );

  const saved = await storage.getConversation(conversation.id);
  const requestMessage = saved?.messages.find((message) => message.metadata?.participantRequest);
  const batch = requestMessage?.metadata?.participantRequest;
  assert.ok(requestMessage);
  assert.equal(batch?.source, "inferred");
  assert.deepEqual(batch?.items.map((item) => item.targetHandle), ["drew-codex-engineer"]);
  assert.match(batch?.items[0]?.prompt ?? "", /update the modal/);
  assert.match(batch?.items[0]?.prompt ?? "", /Reply only "Noted"/);
});

test("inferred accord assignment grants request participants to the facilitator", async () => {
  const manager = chatParticipant({ requestParticipants: "allow" }, { id: "manager", handle: "nikita" });
  const drew = chatParticipant({ repoRead: true, requestParticipants: "ask" }, { id: "drew", handle: "drew-codex-engineer" });
  const taylor = chatParticipant({ repoRead: true }, { id: "taylor", handle: "taylor-claude-engineer", kind: "claude-code" });
  const conversation = chatConversation([manager, drew, taylor], "/repo");
  const { service, storage } = testService({ conversations: [conversation] });

  await chatParts(service).pendingReplies.finalizePendingParticipantMessage(
    conversation,
    manager,
    participantMessage(
      manager,
      "source-message",
      "@drew-codex-engineer have an /accord on exact implementation plan with Taylor."
    )
  );

  const saved = await storage.getConversation(conversation.id);
  const savedParticipants = saved?.metadata.participants as ChatParticipant[] | undefined;
  const savedDrew = savedParticipants?.find((participant) => participant.id === drew.id);
  const requestMessage = saved?.messages.find((message) => message.metadata?.participantRequest);
  assert.ok(savedDrew);
  assert.equal(normalizeChatAgentPermissions(savedDrew.permissions).requestParticipants, "allow");
  assert.equal(requestMessage?.metadata?.participantRequest?.source, "inferred");
  assert.equal(requestMessage?.metadata?.participantRequest?.status, "running");
  assert.equal(requestMessage?.metadata?.participantRequest?.items[0]?.status, "running");
  assert.equal(requestMessage?.metadata?.participantRequest?.items[0]?.targetHandle, "drew-codex-engineer");
  assert.equal(saved?.metadata.pendingAppToolApprovals, undefined);
});

test("stored refresh preserves inferred accord participant-request auto-allow", async () => {
  const manager = chatParticipant({ requestParticipants: "allow" }, { id: "manager", handle: "nikita" });
  const drew = chatParticipant({ repoRead: true, requestParticipants: "ask" }, { id: "drew", handle: "drew-codex-engineer" });
  const taylor = chatParticipant({ repoRead: true }, { id: "taylor", handle: "taylor-claude-engineer", kind: "claude-code" });
  const stored = chatConversation([manager, drew, taylor], "/repo");
  const current = cloneConversation(stored);
  const { service } = testService({ conversations: [stored] });
  // The inferred accord grants it on the flow's copy (allowParticipantRequestsForInferredAccordIfSelected).
  chatParts(service).requestGrants.setParticipantRequestPermission(current, drew.id, "allow");

  await chatParts(service).store.refreshStoredChatState(current);

  const refreshedDrew = (current.metadata.participants as ChatParticipant[]).find((participant) => participant.id === drew.id);
  assert.equal(normalizeChatAgentPermissions(refreshedDrew?.permissions).requestParticipants, "allow");
});

test("stored refresh keeps a request-members permission the User revoked over an older copy's allow", async () => {
  const manager = chatParticipant({ requestParticipants: "allow" }, { id: "manager", handle: "nikita" });
  const drew = chatParticipant({ repoRead: true, requestParticipants: "ask" }, { id: "drew", handle: "drew-codex-engineer" });
  const stored = chatConversation([manager, drew], "/repo");
  // A flow's copy from before the User changed Drew from Allow to Ask.
  const current = cloneConversation(stored);
  current.metadata.participants = (current.metadata.participants as ChatParticipant[]).map((participant) =>
    participant.id === drew.id
      ? { ...participant, permissions: { ...normalizeChatAgentPermissions(participant.permissions), requestParticipants: "allow" } }
      : participant
  );
  const { service } = testService({ conversations: [stored] });

  await chatParts(service).store.refreshStoredChatState(current);

  const refreshedDrew = (current.metadata.participants as ChatParticipant[]).find((participant) => participant.id === drew.id);
  assert.equal(normalizeChatAgentPermissions(refreshedDrew?.permissions).requestParticipants, "ask");
});

test("legacy accord launch metadata does not suppress inferred participant requests", async () => {
  const facilitator = chatParticipant({}, { id: "facilitator", handle: "facilitator" });
  const requester = chatParticipant({}, { id: "requester", handle: "drew" });
  const target = chatParticipant({ repoRead: true }, { id: "target", handle: "taylor" });
  const conversation = chatConversation([facilitator, requester, target], "/repo");
  conversation.metadata = {
    ...conversation.metadata,
    accordLaunch: {
      id: "accord-launch",
      facilitatorId: facilitator.id,
      targetIds: [requester.id, target.id],
      requiredApproverIds: [facilitator.id, requester.id, target.id],
      runId: "accord-run",
      expiresAt: "2099-01-01T00:00:00.000Z"
    }
  };
  const { service } = testService({ conversations: [conversation] });

  await chatParts(service).pendingReplies.appendParticipantTurnMessages(conversation, requester, [
    participantMessage(requester, "source-message", "@taylor please verify this accord concern.")
  ]);

  const requestMessage = conversation.messages.find((message) => message.metadata?.participantRequest);
  assert.ok(requestMessage);
  assert.equal(requestMessage.metadata?.participantRequest?.source, "inferred");
  assert.equal(requestMessage.metadata?.participantRequest?.requesterParticipantId, requester.id);
});

test("legacy manual accord metadata does not suppress inferred participant requests", async () => {
  const facilitator = chatParticipant({}, { id: "facilitator", handle: "facilitator" });
  const requester = chatParticipant({}, { id: "requester", handle: "drew" });
  const target = chatParticipant({ repoRead: true }, { id: "target", handle: "taylor" });
  const conversation = chatConversation([facilitator, requester, target], "/repo");
  conversation.metadata = {
    ...conversation.metadata,
    accordRun: { facilitatorId: facilitator.id, expiresAt: "2099-01-01T00:00:00.000Z" }
  };
  const { service } = testService({ conversations: [conversation] });

  await chatParts(service).pendingReplies.appendParticipantTurnMessages(conversation, requester, [
    participantMessage(requester, "source-message", "@taylor please verify this accord concern.")
  ]);

  const requestMessage = conversation.messages.find((message) => message.metadata?.participantRequest);
  assert.ok(requestMessage);
  assert.equal(requestMessage.metadata?.participantRequest?.source, "inferred");
  assert.equal(requestMessage.metadata?.participantRequest?.requesterParticipantId, requester.id);
});

test("runParticipantRequest roots inferred recipient replies under the source visual root", async () => {
  const requester = chatParticipant();
  const target = chatParticipant({ repoRead: true }, { id: "participant-2", handle: "taylor" });
  const conversation = chatConversation([requester, target], "/repo");
  conversation.messages.push({
    ...participantMessage(requester, "source-message", "Taylor should check this. @taylor please verify."),
    metadata: {
      threadId: "outer-thread",
      parentMessageId: "outer-root",
      chatThreadRootId: "outer-root"
    }
  }, {
    id: "request-message",
    role: "participant",
    participantId: requester.id,
    participantLabel: `@${requester.handle}`,
    content: "@taylor Review this.",
    createdAt: NOW,
    status: "done",
    metadata: {
      threadId: "outer-thread",
      parentMessageId: "source-message",
      sourceMessageId: "source-message",
      chatThreadRootId: "outer-root",
      hiddenFromTimeline: true,
      participantRequest: {
        id: "batch-1",
        requesterParticipantId: requester.id,
        requesterHandle: requester.handle,
        source: "inferred",
        resumeRequester: false,
        status: "running",
        depth: 1,
        createdAt: NOW,
        updatedAt: NOW,
        triggerMessageId: "source-message",
        items: [{
          targetParticipantId: target.id,
          targetHandle: target.handle,
          prompt: "Review this.",
          status: "running",
          createdAt: NOW,
          updatedAt: NOW
        }]
      }
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

  await chatParts(serviceAny).participantRequests.startParticipantRequestRunner(conversation.id, "request-message", 1);

  const saved = await storage.getConversation(conversation.id);
  const targetReply = saved?.messages.find((message) => message.id === "target-reply");
  const requestBatch = saved?.messages.find((message) => message.id === "request-message")?.metadata?.participantRequest;
  assert.equal(capturedTrigger?.id, "request-message");
  assert.equal(capturedTrigger?.metadata?.chatThreadRootId, "outer-root");
  assert.equal(targetReply?.metadata?.threadId, "outer-thread");
  assert.equal(targetReply?.metadata?.parentMessageId, "request-message");
  assert.equal(targetReply?.metadata?.chatThreadRootId, "outer-root");
  assert.equal(targetReply?.metadata?.sourceMessageId, "request-message");
  assert.equal(requestBatch?.status, "answered");
  assert.equal(requestBatch?.items[0].replyMessageId, "target-reply");
});

test("normalizeInferredParticipantRequestThreads hides legacy carriers and reroots descendants", () => {
  const requester = chatParticipant();
  const target = chatParticipant({ repoRead: true }, { id: "participant-2", handle: "taylor" });
  const conversation = chatConversation([requester, target], "/repo");
  conversation.messages.push({
    ...participantMessage(requester, "source-message", "Taylor should check this. @taylor please verify."),
    metadata: {
      threadId: "outer-thread",
      parentMessageId: "outer-root",
      chatThreadRootId: "outer-root"
    }
  }, {
    id: "request-message",
    role: "participant",
    participantId: requester.id,
    participantLabel: `@${requester.handle}`,
    content: "@taylor Review this.",
    createdAt: NOW,
    status: "done",
    metadata: {
      threadId: "outer-thread",
      parentMessageId: "source-message",
      sourceMessageId: "source-message",
      participantRequest: {
        id: "batch-1",
        requesterParticipantId: requester.id,
        requesterHandle: requester.handle,
        source: "inferred",
        resumeRequester: true,
        status: "answered",
        depth: 1,
        createdAt: NOW,
        updatedAt: NOW,
        triggerMessageId: "source-message",
        items: [{
          targetParticipantId: target.id,
          targetHandle: target.handle,
          prompt: "Review this.",
          status: "answered",
          replyMessageId: "target-reply",
          createdAt: NOW,
          updatedAt: NOW
        }]
      }
    }
  }, {
    ...participantMessage(target, "target-reply", "Reviewed."),
    metadata: {
      threadId: "outer-thread",
      parentMessageId: "request-message",
      chatThreadRootId: "request-message",
      sourceMessageId: "request-message"
    }
  }, {
    id: "resume-message",
    role: "system",
    content: "Auto-resumed Drew after participant request.",
    createdAt: NOW,
    status: "done",
    metadata: {
      threadId: "outer-thread",
      parentMessageId: "request-message",
      chatThreadRootId: "request-message",
      sourceMessageId: "request-message"
    }
  });

  const changed = normalizeInferredParticipantRequestThreads(conversation);

  const requestMessage = conversation.messages.find((message) => message.id === "request-message");
  const targetReply = conversation.messages.find((message) => message.id === "target-reply");
  const resumeMessage = conversation.messages.find((message) => message.id === "resume-message");
  assert.equal(changed, true);
  assert.equal(requestMessage?.metadata?.hiddenFromTimeline, true);
  assert.equal(requestMessage?.metadata?.chatThreadRootId, "outer-root");
  assert.equal(targetReply?.metadata?.chatThreadRootId, "outer-root");
  assert.equal(resumeMessage?.metadata?.chatThreadRootId, "outer-root");
});
