import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_CHAT_REQUEST_PARTICIPANTS_TOOL, APP_PARTICIPANTS_REQUEST_CHANGE_TOOL, APP_ROSTER_REQUEST_CHANGE_TOOL, AppMcpService
} from "./appMcp";
import { toolsForActor } from "./appMcp/protocol";
import { ChatService } from "./chat";
import { chatDependencies, chatParts } from "./chat/test/chatParts";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import type {
  ChatAppToolApproval, ChatAppToolApprovalPolicy, ChatMessage, ChatParticipant, ChatParticipantSession, Conversation
} from "../../shared/types";
import {
  ADMIN_ROLE, chatConversation, chatParticipant, memberIds, memberRemovalFixture, NOW, participantRequestApproval,
  permissionApproval, queuedRemovalApproval, removalTrio, ROLE, startMemberTurn, testService, waitFor
} from "./chat/test/permissionFixtures";

test("removeParticipant clears stale participant state in the same mutation", async () => {
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const requester = {
    ...chatParticipant("claude-code"),
    id: "requester-participant",
    handle: "requester"
  };
  const removed = {
    ...chatParticipant("codex-cli"),
    id: "removed-participant",
    handle: "removed"
  };
  const other = {
    ...chatParticipant("claude-code"),
    id: "other-participant",
    handle: "other"
  };
  const removedPermissionApproval = permissionApproval(removed, {
    kind: "portable",
    permissions: ["webAccess"]
  }, {
    id: "removed-permission-approval"
  });
  const removedTargetApproval = participantRequestApproval(requester, [{
    target: removed.handle,
    prompt: "Please review this."
  }], {
    id: "removed-target-approval",
    requestMessageId: "request-message",
    batchId: "batch-1"
  });
  const unrelatedApproval = permissionApproval(other, {
    kind: "portable",
    permissions: ["repoRead"]
  }, {
    id: "unrelated-approval"
  });
  const policies: ChatAppToolApprovalPolicy[] = [
    {
      id: "removed-requester-policy",
      participantId: removed.id,
      roleConfigId: removed.roleConfigId,
      toolName: APP_CHAT_REQUEST_PARTICIPANTS_TOOL,
      capability: "participants.request",
      targetParticipantId: other.id,
      scope: "chat",
      createdAt: NOW,
      updatedAt: NOW
    },
    {
      id: "removed-target-policy",
      participantId: requester.id,
      roleConfigId: requester.roleConfigId,
      toolName: APP_CHAT_REQUEST_PARTICIPANTS_TOOL,
      capability: "participants.request",
      targetParticipantId: removed.id,
      scope: "chat",
      createdAt: NOW,
      updatedAt: NOW
    },
    {
      id: "unrelated-policy",
      participantId: requester.id,
      roleConfigId: requester.roleConfigId,
      toolName: APP_CHAT_REQUEST_PARTICIPANTS_TOOL,
      capability: "participants.request",
      targetParticipantId: other.id,
      scope: "chat",
      createdAt: NOW,
      updatedAt: NOW
    }
  ];
  const sessions: ChatParticipantSession[] = [{
    participantId: removed.id,
    sessionId: "removed-session",
    roleConfigId: removed.roleConfigId,
    roleConfigVersion: 1,
    roleLabel: ROLE.label,
    roleInstructions: ROLE.instructions,
    updatedAt: NOW
  }];
  const conversation = chatConversation([assistant, requester, removed, other], {
    pendingAppToolApprovals: [removedPermissionApproval, removedTargetApproval, unrelatedApproval],
    appToolApprovalPolicies: policies,
    participantSessions: sessions
  });
  conversation.messages.push({
    id: "mention-message",
    role: "participant",
    participantId: requester.id,
    content: "Participant requests:\n- @removed\n- @other",
    createdAt: NOW,
    status: "done",
    metadata: {
      pendingMentions: [
        { targetParticipantId: removed.id, targetHandle: removed.handle, status: "pending" },
        { targetParticipantId: other.id, targetHandle: other.handle, status: "pending" }
      ]
    }
  }, {
    id: "request-message",
    role: "participant",
    participantId: requester.id,
    content: "@removed Please review this.\n@other Please also review.",
    createdAt: NOW,
    status: "done",
    metadata: {
      participantRequest: {
        id: "batch-1",
        requesterParticipantId: requester.id,
        requesterHandle: requester.handle,
        source: "mcp",
        resumeRequester: true,
        status: "pending_approval",
        depth: 1,
        createdAt: NOW,
        updatedAt: NOW,
        items: [
          {
            targetParticipantId: removed.id,
            targetHandle: removed.handle,
            prompt: "Please review this.",
            status: "pending_approval",
            createdAt: NOW,
            updatedAt: NOW
          },
          {
            targetParticipantId: other.id,
            targetHandle: other.handle,
            prompt: "Please also review.",
            status: "pending_approval",
            createdAt: NOW,
            updatedAt: NOW
          }
        ]
      }
    }
  });
  const { service, storage } = testService({ conversation });

  await service.removeParticipant({ conversationId: conversation.id, participantId: removed.id });

  const saved = storage.current as Conversation;
  assert.deepEqual((saved.metadata.participants as ChatParticipant[]).map((participant) => participant.id), [
    assistant.id,
    requester.id,
    other.id
  ]);
  assert.deepEqual(saved.metadata.participantSessions, []);
  const approvals = saved.metadata.pendingAppToolApprovals as ChatAppToolApproval[];
  assert.equal(approvals.find((approval) => approval.id === removedPermissionApproval.id)?.status, "denied");
  assert.equal(approvals.find((approval) => approval.id === removedTargetApproval.id)?.status, "denied");
  assert.equal(approvals.find((approval) => approval.id === unrelatedApproval.id)?.status, "pending");
  assert.equal(approvals.find((approval) => approval.id === removedPermissionApproval.id)?.error, "Member was removed from this chat.");
  assert.deepEqual((saved.metadata.appToolApprovalPolicies as ChatAppToolApprovalPolicy[]).map((policy) => policy.id), []);

  const mentionMessage = saved.messages.find((message) => message.id === "mention-message") as ChatMessage;
  assert.deepEqual(mentionMessage.metadata?.pendingMentions?.map((mention) => mention.targetParticipantId), [other.id]);

  const requestBatch = saved.messages.find((message) => message.id === "request-message")?.metadata?.participantRequest;
  assert.equal(requestBatch?.status, "pending_approval");
  assert.equal(requestBatch?.items.find((item) => item.targetParticipantId === removed.id)?.status, "failed");
  assert.equal(requestBatch?.items.find((item) => item.targetParticipantId === removed.id)?.error, "Member was removed from this chat.");
  assert.equal(requestBatch?.items.find((item) => item.targetParticipantId === other.id)?.status, "pending_approval");
});

test("removeParticipant cannot be undone by a later stale chat mutation", async () => {
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const removed = {
    ...chatParticipant("claude-code"),
    id: "removed-participant",
    handle: "removed"
  };
  const other = {
    ...chatParticipant("codex-cli"),
    id: "other-participant",
    handle: "other"
  };
  const removedApproval = participantRequestApproval(assistant, [{
    target: removed.handle,
    prompt: "Please review this."
  }], {
    id: "removed-target-approval",
    requestMessageId: "request-message",
    batchId: "batch-1"
  });
  const removedSession: ChatParticipantSession = {
    participantId: removed.id,
    sessionId: "removed-session",
    roleConfigId: removed.roleConfigId,
    roleConfigVersion: 1,
    roleLabel: ROLE.label,
    roleInstructions: ROLE.instructions,
    updatedAt: NOW
  };
  const removedPolicy: ChatAppToolApprovalPolicy = {
    id: "removed-target-policy",
    participantId: assistant.id,
    roleConfigId: assistant.roleConfigId,
    toolName: APP_CHAT_REQUEST_PARTICIPANTS_TOOL,
    capability: "participants.request",
    targetParticipantId: removed.id,
    scope: "chat",
    createdAt: NOW,
    updatedAt: NOW
  };
  const conversation = chatConversation([assistant, removed, other], {
    pendingAppToolApprovals: [removedApproval],
    appToolApprovalPolicies: [removedPolicy],
    participantSessions: [removedSession]
  });
  conversation.messages.push({
    id: "mention-message",
    role: "participant",
    participantId: assistant.id,
    content: "Participant requests:\n- @removed",
    createdAt: NOW,
    status: "done",
    metadata: {
      pendingMentions: [
        { targetParticipantId: removed.id, targetHandle: removed.handle, status: "pending" },
        { targetParticipantId: other.id, targetHandle: other.handle, status: "pending" }
      ]
    }
  }, {
    id: "request-message",
    role: "participant",
    participantId: assistant.id,
    content: "@removed Please review this.\n@other Please also review.",
    createdAt: NOW,
    status: "done",
    metadata: {
      participantRequest: {
        id: "batch-1",
        requesterParticipantId: assistant.id,
        requesterHandle: assistant.handle,
        source: "mcp",
        resumeRequester: true,
        status: "pending_approval",
        depth: 1,
        createdAt: NOW,
        updatedAt: NOW,
        items: [
          {
            targetParticipantId: removed.id,
            targetHandle: removed.handle,
            prompt: "Please review this.",
            status: "pending_approval",
            createdAt: NOW,
            updatedAt: NOW
          },
          {
            targetParticipantId: other.id,
            targetHandle: other.handle,
            prompt: "Please also review.",
            status: "pending_approval",
            createdAt: NOW,
            updatedAt: NOW
          }
        ]
      }
    }
  });
  const { service, storage } = testService({ conversation });
  const staleConversation = await storage.getConversation(conversation.id) as Conversation;

  await service.removeParticipant({ conversationId: conversation.id, participantId: removed.id });
  await chatParts(service).store.withChatMutation(staleConversation, async () => {
    staleConversation.updatedAt = "2026-05-17T12:00:01.000Z";
    await chatParts(service).store.saveConversation(staleConversation);
  });

  const saved = storage.current as Conversation;
  assert.deepEqual((saved.metadata.participants as ChatParticipant[]).map((participant) => participant.id), [
    assistant.id,
    other.id
  ]);
  assert.deepEqual(saved.metadata.participantSessions, []);
  assert.deepEqual(saved.metadata.appToolApprovalPolicies, []);
  assert.equal((saved.metadata.pendingAppToolApprovals as ChatAppToolApproval[])[0].status, "denied");
  assert.deepEqual(
    saved.messages.find((message) => message.id === "mention-message")?.metadata?.pendingMentions?.map((mention) => mention.targetParticipantId),
    [other.id]
  );
  const requestBatch = saved.messages.find((message) => message.id === "request-message")?.metadata?.participantRequest;
  assert.equal(requestBatch?.status, "pending_approval");
  assert.equal(requestBatch?.items.find((item) => item.targetParticipantId === removed.id)?.status, "failed");
  assert.equal(requestBatch?.items.find((item) => item.targetParticipantId === other.id)?.status, "pending_approval");
});

test("stale permission approval for a removed requester fails closed", async () => {
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const removed = {
    ...chatParticipant("claude-code"),
    id: "removed-participant",
    handle: "removed",
    permissions: normalizeChatAgentPermissions({
      ...defaultChatAgentPermissions(),
      webAccess: false
    })
  };
  const approval = permissionApproval(removed, {
    kind: "portable",
    permissions: ["webAccess"]
  });
  const conversation = chatConversation([assistant], { pendingAppToolApprovals: [approval] });
  const { service, storage } = testService({ conversation });

  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: approval.id,
    approve: true,
    scope: "chat"
  });

  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "denied");
  assert.equal(normalizeChatAgentPermissions((storage.current.metadata.participants as ChatParticipant[])[0]?.permissions).webAccess, false);
  assert.equal(storage.current.messages.some((message: ChatMessage) =>
    message.content.includes("The requesting member is no longer in this chat.")
  ), true);
});

test("stale participant-request approval for a removed target fails closed without running", async () => {
  const requester = {
    ...chatParticipant("claude-code"),
    id: "requester-participant",
    handle: "requester"
  };
  const removed = {
    ...chatParticipant("codex-cli"),
    id: "removed-participant",
    handle: "removed"
  };
  const approval = participantRequestApproval(requester, [{
    target: removed.handle,
    prompt: "Please review this."
  }], {
    requestMessageId: "request-message",
    batchId: "batch-1"
  });
  const conversation = chatConversation([requester], { pendingAppToolApprovals: [approval] });
  conversation.messages.push({
    id: "request-message",
    role: "participant",
    participantId: requester.id,
    content: "@removed Please review this.",
    createdAt: NOW,
    status: "done",
    metadata: {
      participantRequest: {
        id: "batch-1",
        requesterParticipantId: requester.id,
        requesterHandle: requester.handle,
        source: "mcp",
        resumeRequester: true,
        status: "pending_approval",
        depth: 1,
        createdAt: NOW,
        updatedAt: NOW,
        items: [{
          targetParticipantId: removed.id,
          targetHandle: removed.handle,
          prompt: "Please review this.",
          status: "pending_approval",
          createdAt: NOW,
          updatedAt: NOW
        }]
      }
    }
  });
  let runCount = 0;
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async () => {
      runCount += 1;
      return {
        participant: { id: "removed", kind: "codex-cli", label: "removed" },
        ok: true,
        content: "should not run",
        durationMs: 1
      };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: approval.id,
    approve: true,
    scope: "chat"
  });
  await waitFor(() => storage.current.messages.find((message: ChatMessage) => message.id === "request-message")
    ?.metadata?.participantRequest?.items[0]?.status === "failed");

  const savedApproval = storage.current.metadata.pendingAppToolApprovals[0] as ChatAppToolApproval;
  const batch = storage.current.messages.find((message: ChatMessage) => message.id === "request-message")
    ?.metadata?.participantRequest;
  assert.equal(savedApproval.status, "approved");
  assert.deepEqual(savedApproval.appliedParticipantIds, []);
  assert.equal(batch?.status, "failed");
  assert.equal(batch?.items[0].status, "failed");
  assert.equal(batch?.items[0].error, "Target member is no longer in this chat.");
  assert.deepEqual(storage.current.metadata.appToolApprovalPolicies ?? [], []);
  assert.equal(runCount, 0);
});

test("removeParticipant rejects unsafe removal requests", async () => {
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const target = {
    ...chatParticipant("claude-code"),
    id: "target-participant",
    handle: "target"
  };

  {
    const conversation = chatConversation([assistant, target], { running: true, runId: "target-run", activeRunIds: ["target-run"] });
    conversation.messages.push(pendingReply(target, "target-run"));
    const { service } = testService({ conversation });

    await assert.rejects(
      () => service.removeParticipant({ conversationId: conversation.id, participantId: target.id }),
      /@target is busy/
    );
  }

  {
    const conversation = chatConversation([assistant, target]);
    const { service } = testService({ conversation });

    await assert.rejects(
      () => service.removeParticipant({ conversationId: conversation.id, participantId: assistant.id }),
      /Chat Assistant cannot be removed/
    );
    await assert.rejects(
      () => service.removeParticipant({ conversationId: conversation.id, participantId: "missing-participant" }),
      /not found/
    );
  }

  {
    const conversation = chatConversation([target]);
    const { service } = testService({ conversation });

    await assert.rejects(
      () => service.removeParticipant({ conversationId: conversation.id, participantId: target.id }),
      /last chat member/
    );
  }
});

function pendingReply(member: ChatParticipant, runId: string): ChatMessage {
  return {
    id: `${member.id}-reply`,
    role: "participant",
    participantId: member.id,
    participantLabel: `@${member.handle}`,
    content: "",
    createdAt: NOW,
    status: "pending",
    metadata: { runId }
  };
}

test("removeParticipant removes an idle member while another member's turn runs", async () => {
  const { assistant, worker, target, conversation } = removalTrio();
  const { service, storage } = testService({ conversation });
  const live = await startMemberTurn(service, storage, worker, "worker-run");

  await service.removeParticipant({ conversationId: conversation.id, participantId: target.id });

  assert.deepEqual(memberIds(storage.current), [assistant.id, worker.id]);
  assert.equal(storage.current.metadata.running, true, "the other member's turn keeps running");
  await assert.rejects(
    () => service.removeParticipant({ conversationId: conversation.id, participantId: worker.id }),
    /@worker is busy and cannot be removed until its work ends/
  );

  chatParts(service).activeRuns.unregisterTargetRun("worker-run");
  await chatParts(service).activeRuns.endChatRun(live, "worker-run");
  await service.removeParticipant({ conversationId: conversation.id, participantId: worker.id });
  assert.deepEqual(memberIds(storage.current), [assistant.id]);
});

test("removeParticipant refuses a member whose own work is live and only that member", async () => {
  const freshOwner = () => ({ processId: process.ppid, instanceId: "other-instance", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const cases: Array<{ name: string; setup: (fixture: ReturnType<typeof removalTrio>) => void; start?: (service: ChatService, storage: any, fixture: ReturnType<typeof removalTrio>) => Promise<void> }> = [
    {
      name: "a reply another device writes",
      setup: ({ conversation, target }) => {
        conversation.metadata = { ...conversation.metadata, running: true, runId: "elsewhere-run", activeRunIds: ["elsewhere-run"], activeRunOwnersByRunId: { "elsewhere-run": freshOwner() } };
        conversation.messages.push(pendingReply(target, "elsewhere-run"));
      }
    },
    {
      name: "its turn registered here",
      setup: () => undefined,
      start: async (service, storage, { target }) => { await startMemberTurn(service, storage, target, "target-run"); }
    },
    {
      name: "a flow here that resumes it later",
      setup: () => undefined,
      start: async (service, storage) => {
        const live = await storage.getConversation("conversation-1") as Conversation;
        await chatParts(service).activeRuns.beginChatRun(live, "mention-run", ["target-participant"]);
      }
    },
    {
      name: "its compaction",
      setup: () => undefined,
      start: async (service, storage, { target }) => {
        const live = await storage.getConversation("conversation-1") as Conversation;
        await chatParts(service).activeRuns.beginChatParticipantCompactionRun(live, "compact-run", target.id);
        await chatParts(service).store.waitForQueuedSave(live.id);
      }
    },
    {
      name: "a member request it asked that still runs",
      setup: ({ conversation, target, worker }) => {
        conversation.messages.push({
          id: "request-message",
          role: "participant",
          participantId: target.id,
          participantLabel: "@target",
          content: "Asking @worker.",
          createdAt: NOW,
          status: "done",
          metadata: {
            participantRequest: {
              id: "request-batch",
              requesterParticipantId: target.id,
              requesterHandle: target.handle,
              source: "tool",
              resumeRequester: true,
              status: "running",
              depth: 1,
              createdAt: NOW,
              updatedAt: NOW,
              items: [{ targetParticipantId: worker.id, targetHandle: worker.handle, prompt: "Check it.", status: "running", createdAt: NOW, updatedAt: NOW }]
            }
          } as any
        });
      }
    }
  ];
  for (const item of cases) {
    const fixture = removalTrio();
    item.setup(fixture);
    const { service, storage } = testService({ conversation: fixture.conversation });
    await item.start?.(service, storage, fixture);

    await assert.rejects(
      () => service.removeParticipant({ conversationId: "conversation-1", participantId: fixture.target.id }),
      /@target is busy/,
      item.name
    );
    assert.ok(memberIds(storage.current).includes(fixture.target.id), item.name);
    if (item.name !== "a member request it asked that still runs") {
      // Nobody else is busy: another member goes at once.
      await service.removeParticipant({ conversationId: "conversation-1", participantId: fixture.worker.id });
      assert.deepEqual(memberIds(storage.current), [fixture.assistant.id, fixture.target.id], item.name);
    }
  }
});

test("a member's tool call that read the chat before the User removed someone does not bring them back", async () => {
  const { assistant, worker, target, conversation } = removalTrio();
  const requester = { ...worker, permissions: { ...normalizeChatAgentPermissions(worker.permissions), requestParticipants: "allow" as const } };
  conversation.metadata = {
    ...conversation.metadata,
    participants: [assistant, requester, target],
    participantSessions: [{ participantId: target.id, sessionId: "target-session", roleConfigId: target.roleConfigId, roleConfigVersion: 1, roleLabel: ROLE.label, roleInstructions: ROLE.instructions, updatedAt: NOW }]
  };
  const { service, storage } = testService({ conversation });
  const requireChat = chatParts(service).store.requireChat.bind(chatParts(service).store);
  let removedDuringCall = false;
  chatParts(service).store.requireChat = async (id: string) => {
    const copy = await requireChat(id);
    if (!removedDuringCall) {
      removedDuringCall = true;
      await service.removeParticipant({ conversationId: id, participantId: target.id });
    }
    return copy;
  };

  const result = await service.requestParticipantsFromTool(
    { conversationId: conversation.id, participantId: requester.id, roleConfigId: requester.roleConfigId, roleConfigVersion: 1, capabilities: ["participants.request"] } as any,
    { requests: [{ target: "assistant", prompt: "Check it." }], resumeRequester: true }
  );

  assert.equal(removedDuringCall, true);
  assert.notEqual(result.ok, false, JSON.stringify(result));
  assert.deepEqual(memberIds(storage.current), [assistant.id, requester.id], "the removed member stays removed");
  assert.equal((storage.current.metadata.participantSessions as ChatParticipantSession[]).some((session) => session.participantId === target.id), false);
  assert.ok(storage.current.messages.some((message: ChatMessage) => message.metadata?.participantRequest?.requesterParticipantId === requester.id), "the request is recorded");
});

test("answering a card that read the chat before the User removed someone does not bring them back", async () => {
  const { assistant, worker, target, conversation } = removalTrio();
  const { service, storage } = testService({ conversation });
  const requested = await service.requestParticipantsFromTool(
    { conversationId: conversation.id, participantId: worker.id, roleConfigId: worker.roleConfigId, roleConfigVersion: 1, capabilities: ["participants.request"] } as any,
    { requests: [{ target: "assistant", prompt: "Check it." }], resumeRequester: true }
  );
  const approvalId = (storage.current.metadata.pendingAppToolApprovals as ChatAppToolApproval[]).find((approval) => approval.status === "pending")?.id;
  assert.ok(approvalId, JSON.stringify(requested));
  const getConversation = storage.getConversation.bind(storage);
  let removedDuringAnswer = false;
  storage.getConversation = async (id: string) => {
    const copy = await getConversation(id);
    if (!removedDuringAnswer && copy) {
      removedDuringAnswer = true;
      await service.removeParticipant({ conversationId: id, participantId: target.id });
    }
    return copy;
  };

  await service.respondToAppToolApproval({ conversationId: conversation.id, approvalId, approve: false });

  assert.equal(removedDuringAnswer, true);
  assert.deepEqual(memberIds(storage.current), [assistant.id, worker.id], "the removed member stays removed");
  assert.equal((storage.current.metadata.pendingAppToolApprovals as ChatAppToolApproval[]).find((approval) => approval.id === approvalId)?.status, "denied");
});

test("opening a chat whose stale run blocked a queued removal applies the removal", async () => {
  const { service, storage, target } = memberRemovalFixture({
    metadata: {
      pendingAppToolApprovals: [queuedRemovalApproval("target-participant", "target")],
      running: true,
      runId: "dead-run",
      activeRunIds: ["dead-run"]
    }
  });
  chatParts(service).queuedRosterChanges.noteQueuedMemberRemoval("conversation-1");

  await service.hydrateContextUsage(await storage.getConversation("conversation-1") as Conversation);

  await waitFor(() => !memberIds(storage.current).includes(target.id));
});

test("a removal recorded while an older pass is finishing keeps its index", () => {
  const { service } = memberRemovalFixture();
  const index = chatParts(service).queuedRosterChanges.queuedMemberRemovalChats as Map<string, number>;
  chatParts(service).queuedRosterChanges.noteQueuedMemberRemoval("conversation-1");
  const olderPass = index.get("conversation-1");
  chatParts(service).queuedRosterChanges.noteQueuedMemberRemoval("conversation-1");

  chatParts(service).queuedRosterChanges.forgetQueuedMemberRemovals("conversation-1", olderPass);

  assert.equal(index.has("conversation-1"), true);
});

test("a removed member's warm CLI process is closed, and only that member's, only where it runs", async () => {
  const closed: Array<[string, string, string]> = [];
  const spyOnClose = (service: ChatService): void => {
    chatDependencies(service).cliRunner.closeWarmAgents = async (conversationId: string, participantId: string, reason: string) => {
      closed.push([conversationId, participantId, reason]);
    };
  };
  {
    // Approved through the tool, while another member keeps its own process.
    const { service, storage, actor, target } = memberRemovalFixture();
    spyOnClose(service);
    const requested = await service.requestParticipantChangeFromTool(actor, {
      operations: [{ type: "remove_participant_from_chat", handle: "target" }]
    }) as { approvalId: string };
    await service.respondToAppToolApproval({ conversationId: storage.current.id, approvalId: requested.approvalId, approve: true });
    await waitFor(() => closed.length === 1);
    assert.deepEqual(closed, [["conversation-1", target.id, "member-removed"]]);
  }
  closed.length = 0;
  {
    // From the member list.
    const { service, storage, target } = memberRemovalFixture();
    spyOnClose(service);
    await service.removeParticipant({ conversationId: storage.current.id, participantId: target.id });
    await waitFor(() => closed.length === 1);
    assert.deepEqual(closed, [["conversation-1", target.id, "member-removed"]]);
  }
  closed.length = 0;
  {
    // A member whose home is a machine has no process on this desktop; a
    // local member removed alongside it is closed, so the check is not vacuous.
    const { service, storage, target } = memberRemovalFixture();
    const onMachine = { ...chatParticipant("claude-code"), id: "machine-member", handle: "remote", homeMachineId: "machine" };
    storage.current.metadata.participants = [...storage.current.metadata.participants, onMachine];
    spyOnClose(service);
    await service.removeParticipant({ conversationId: storage.current.id, participantId: onMachine.id });
    await service.removeParticipant({ conversationId: storage.current.id, participantId: target.id });
    await waitFor(() => closed.length === 1);
    assert.equal(memberIds(storage.current).includes(onMachine.id), false);
    assert.deepEqual(closed, [["conversation-1", target.id, "member-removed"]]);
  }
  closed.length = 0;
  {
    // A refused or unsaved removal leaves the member's process alone.
    const { service, storage, assistant, target } = memberRemovalFixture();
    spyOnClose(service);
    await assert.rejects(() => service.removeParticipant({ conversationId: storage.current.id, participantId: assistant.id }), /Chat Assistant/);
    const save = storage.saveConversation.bind(storage);
    storage.saveConversation = async () => { throw new Error("SQLITE_FULL"); };
    await assert.rejects(() => service.removeParticipant({ conversationId: storage.current.id, participantId: target.id }), /SQLITE_FULL/);
    storage.saveConversation = save;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(closed, []);
  }
});

test("a combined request whose addition is invalid changes nothing, and one whose removal fails after the addition says so", async () => {
  {
    const { service, storage, actor, target } = memberRemovalFixture({ manage: "allow" });
    await assert.rejects(
      () => service.requestParticipantChangeFromTool(actor, {
        operations: [
          { type: "remove_participant_from_chat", handle: "target" },
          // The handle of a member already here.
          { type: "add_new_participant_to_chat", saveAsPreset: false, participant: { handle: "target", roleConfigId: ROLE.id, kind: "codex-cli" } }
        ]
      })
    );
    assert.deepEqual(storage.current.metadata.pendingAppToolApprovals ?? [], []);
    assert.ok(memberIds(storage.current).includes(target.id));
  }
  {
    const { service, storage, actor, target } = memberRemovalFixture({ manage: "allow" });
    // Another removal of the same member is recorded while the addition is made.
    const original = chatParts(service).rosterTools.requestParticipantAdditionFromTool.bind(chatParts(service).rosterTools);
    chatParts(service).rosterTools.requestParticipantAdditionFromTool = async (...args: unknown[]) => {
      const added = await original(...args);
      storage.current.metadata.pendingAppToolApprovals = [...storage.current.metadata.pendingAppToolApprovals, queuedRemovalApproval(target.id, "target")];
      return added;
    };
    const result = await service.requestParticipantChangeFromTool(actor, {
      operations: [
        { type: "add_new_participant_to_chat", saveAsPreset: false, participant: { handle: "helper", roleConfigId: ROLE.id, kind: "codex-cli" } },
        { type: "remove_participant_from_chat", handle: "target" }
      ]
    }) as { ok: boolean; status: string; additions: { status: string }; removals: { ok: boolean; error: string } };
    assert.equal(result.ok, false);
    assert.equal(result.status, "removal_failed");
    assert.equal(result.additions.status, "auto_applied");
    assert.equal(result.removals.ok, false);
    assert.match(result.removals.error, /already waiting to be made/);
    assert.ok((storage.current.metadata.participants as ChatParticipant[]).some((participant) => participant.handle === "helper"), "the addition stays");
  }
});

test("member tools describe the removal operation", async () => {
  const { service, actor } = memberRemovalFixture();
  const options = await service.describeParticipantOptionsForTool(actor) as { participantChange: { supportedOperations: string[]; removalPolicy: string } };
  assert.ok(options.participantChange.supportedOperations.includes("remove_participant_from_chat"));
  assert.match(options.participantChange.removalPolicy, /follows your Manage members setting/);
  assert.doesNotMatch(options.participantChange.removalPolicy, /on their own|always approves/);

  const appMcp = new AppMcpService();
  const tools = toolsForActor({ ...actor, roleConfigVersion: 1 }) as Array<{ name: string; description: string; inputSchema: any }>;
  const tool = tools.find((item) => item.name === APP_PARTICIPANTS_REQUEST_CHANGE_TOOL);
  assert.ok(tool);
  assert.ok(tool.inputSchema.properties.operations.items.properties.type.enum.includes("remove_participant_from_chat"));
  assert.match(tool.description, /removing a member from the chat/);
  assert.match(tool.description, /same Manage members policy/);
  assert.match(tool.description, /auto_approved/);
  const roster = tools.find((item) => item.name === APP_ROSTER_REQUEST_CHANGE_TOOL);
  assert.deepEqual(roster?.inputSchema.properties.operations.items.properties.type.enum, ["add"]);
});
