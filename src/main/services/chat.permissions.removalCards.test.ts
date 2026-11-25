import assert from "node:assert/strict";
import test from "node:test";
import { APP_PARTICIPANTS_REQUEST_CHANGE_TOOL } from "./appMcp";
import { chatParts } from "./chat/test/chatParts";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import type {
  ChatAppToolApproval, ChatMessage, ChatParticipant, ChatParticipantRemovalRequest, ChatParticipantSession, Conversation
} from "../../shared/types";
import {
  chatParticipant, feedCard, homeOnMachine, machineCard, memberIds, memberRemovalFixture, NOW, participantManagerActor,
  queuedRemovalApproval, ROLE, waitFor
} from "./chat/test/permissionFixtures";

test("member removal asks the User on a card when the member's Manage members setting is ask", async () => {
  const { service, storage, actor, target } = memberRemovalFixture({ manage: "ask" });

  const result = await service.requestParticipantChangeFromTool(actor, {
    reason: "No longer needed.",
    operations: [{ type: "remove_participant_from_chat", handle: "@target" }]
  }) as { status: string; approvalId: string; summary: string };

  assert.equal(result.status, "pending_user_approval");
  assert.equal(result.summary, "Remove @target from this chat");
  const approval = (storage.current.metadata.pendingAppToolApprovals as ChatAppToolApproval[])[0];
  assert.equal(approval.status, "pending");
  assert.equal(approval.toolName, APP_PARTICIPANTS_REQUEST_CHANGE_TOOL);
  assert.deepEqual(approval.request, {
    kind: "participant_removal",
    reason: "No longer needed.",
    operations: [{ type: "remove_participant_from_chat", participantId: target.id, handle: "target" }]
  });
  assert.ok(memberIds(storage.current).includes(target.id));
  assert.ok(storage.current.messages.some((message: ChatMessage) =>
    message.content === "Member removal approval needed from @manager: Remove @target from this chat."
  ));
});

test("a member denied member management, or without the capability, cannot request a removal", async () => {
  const { service, storage, target } = memberRemovalFixture();
  const denied = {
    ...chatParticipant("claude-code"),
    id: "denied-participant",
    handle: "denied",
    permissions: normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), manageRolesParticipants: "deny" })
  };
  storage.current.metadata.participants = [...storage.current.metadata.participants, denied];

  await assert.rejects(
    () => service.requestParticipantChangeFromTool(participantManagerActor("conversation-1", denied), {
      operations: [{ type: "remove_participant_from_chat", handle: "target" }]
    }),
    /not allowed to manage roles or participants/
  );
  await assert.rejects(
    () => service.requestParticipantChangeFromTool({ ...participantManagerActor("conversation-1", denied), capabilities: [] } as any, {
      operations: [{ type: "remove_participant_from_chat", handle: "target" }]
    }),
    /does not grant member management/
  );
  assert.deepEqual(storage.current.metadata.pendingAppToolApprovals ?? [], []);
  assert.ok(memberIds(storage.current).includes(target.id));
});

test("one request can remove several members; duplicates collapse and the wording is plural", async () => {
  const { service, storage, actor, target } = memberRemovalFixture();
  const other = { ...chatParticipant("codex-cli"), id: "other-participant", handle: "other" };
  storage.current.metadata.participants = [...storage.current.metadata.participants, other];

  await assert.rejects(
    () => service.requestParticipantChangeFromTool(actor, {
      operations: Array.from({ length: 13 }, () => ({ type: "remove_participant_from_chat", handle: "target" }))
    }),
    /too large/
  );
  const requested = await service.requestParticipantChangeFromTool(actor, {
    operations: [
      { type: "remove_participant_from_chat", participantId: target.id },
      { type: "remove_participant_from_chat", handle: "@other" },
      { type: "remove_participant_from_chat", handle: "target" }
    ]
  }) as { approvalId: string; summary: string };
  assert.equal(requested.summary, "Remove @target and @other from this chat");
  assert.deepEqual(
    (storage.current.metadata.pendingAppToolApprovals[0].request as ChatParticipantRemovalRequest).operations.map((operation) => operation.participantId),
    [target.id, other.id]
  );

  await service.respondToAppToolApproval({ conversationId: "conversation-1", approvalId: requested.approvalId, approve: false });
  assert.ok(storage.current.messages.some((message: ChatMessage) =>
    message.content === "User declined @manager's request to remove @target and @other. @target and @other stay in this chat."
  ));
});

test("a removal approved 'for this chat' is still a one-time decision and the next removal asks again", async () => {
  const { service, storage, actor, target } = memberRemovalFixture();
  const other = { ...chatParticipant("codex-cli"), id: "other-participant", handle: "other" };
  storage.current.metadata.participants = [...storage.current.metadata.participants, other];
  const first = await service.requestParticipantChangeFromTool(actor, {
    operations: [{ type: "remove_participant_from_chat", handle: "target" }]
  }) as { approvalId: string };

  await service.respondToAppToolApproval({ conversationId: "conversation-1", approvalId: first.approvalId, approve: true, scope: "chat" });

  assert.equal(memberIds(storage.current).includes(target.id), false);
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].approvalScope, "once");
  assert.deepEqual(storage.current.metadata.appToolApprovalPolicies ?? [], []);
  const second = await service.requestParticipantChangeFromTool(actor, {
    operations: [{ type: "remove_participant_from_chat", handle: "other" }]
  }) as { status: string };
  assert.equal(second.status, "pending_user_approval");
  assert.ok(memberIds(storage.current).includes(other.id));
});

test("recording an approved removal never overwrites what the asking member's turn wrote meanwhile", async () => {
  const { service, storage, actor, target } = memberRemovalFixture();
  const requested = await service.requestParticipantChangeFromTool(actor, {
    operations: [{ type: "remove_participant_from_chat", handle: "target" }]
  }) as { approvalId: string };
  const reply: ChatMessage = {
    id: "manager-reply",
    role: "participant",
    participantId: "manager-participant",
    content: "Asked the User to approve the removal.",
    createdAt: NOW,
    status: "done"
  };

  let claims = 0;
  await service.respondToAppToolApproval(
    { conversationId: "conversation-1", approvalId: requested.approvalId, approve: true },
    undefined,
    {
      beforeApply: async () => {
        claims += 1;
        // The turn finishes its reply after the decision path read the chat.
        const turnCopy = await storage.getConversation("conversation-1") as Conversation;
        await chatParts(service).store.withChatMutation(turnCopy, async () => {
          turnCopy.messages.push(reply);
          await chatParts(service).store.saveConversation(turnCopy);
        });
      }
    }
  );

  assert.equal(claims, 1);
  assert.ok(storage.current.messages.some((message: ChatMessage) => message.id === "manager-reply"), "the reply survives");
  assert.equal(memberIds(storage.current).includes(target.id), false);
});

test("a failed approval claim leaves the removal card pending and nothing queued", async () => {
  const { service, storage, actor, target } = memberRemovalFixture();
  const requested = await service.requestParticipantChangeFromTool(actor, {
    operations: [{ type: "remove_participant_from_chat", handle: "target" }]
  }) as { approvalId: string };
  const request = { conversationId: "conversation-1", approvalId: requested.approvalId, approve: true };

  await assert.rejects(
    service.respondToAppToolApproval(request, undefined, { beforeApply: async () => { throw new Error("SQLITE_FULL before claim"); } }),
    /SQLITE_FULL/
  );
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "pending");
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].memberRemovalQueuedAt, undefined);
  assert.ok(memberIds(storage.current).includes(target.id));

  await service.respondToAppToolApproval(request, undefined, { beforeApply: async () => undefined });
  assert.equal(memberIds(storage.current).includes(target.id), false);
});

test("a removal that is no longer valid when approved, or when applied, is closed with the reason", async () => {
  {
    // Another approved removal of the same member already waits.
    const { service, storage, actor, target } = memberRemovalFixture();
    const requested = await service.requestParticipantChangeFromTool(actor, {
      operations: [{ type: "remove_participant_from_chat", handle: "target" }]
    }) as { approvalId: string };
    storage.current.metadata.pendingAppToolApprovals = [
      ...storage.current.metadata.pendingAppToolApprovals,
      queuedRemovalApproval(target.id, "target")
    ];

    await service.respondToAppToolApproval({ conversationId: "conversation-1", approvalId: requested.approvalId, approve: true });

    const refused = (storage.current.metadata.pendingAppToolApprovals as ChatAppToolApproval[]).find((item) => item.id === requested.approvalId);
    assert.equal(refused?.status, "denied");
    assert.match(refused?.error ?? "", /A removal of @target is already waiting to be made/);
    assert.ok(storage.current.messages.some((message: ChatMessage) => message.content.startsWith("Could not remove @target at @manager's request:")));
  }
  {
    const { service, storage, actor, target } = memberRemovalFixture();
    const requested = await service.requestParticipantChangeFromTool(actor, {
      operations: [{ type: "remove_participant_from_chat", handle: "target" }]
    }) as { approvalId: string };
    chatParts(service).members.removeParticipantsInMutation = () => {
      throw new Error("Chat Assistant cannot be removed from the chat.");
    };

    await service.respondToAppToolApproval({ conversationId: "conversation-1", approvalId: requested.approvalId, approve: true });

    const closed = storage.current.metadata.pendingAppToolApprovals[0] as ChatAppToolApproval;
    assert.equal(closed.status, "cancelled");
    assert.equal(closed.memberRemovalQueuedAt, undefined);
    assert.ok(memberIds(storage.current).includes(target.id));
    assert.ok(storage.current.messages.some((message: ChatMessage) =>
      message.content === "Could not remove @target at @manager's request: Chat Assistant cannot be removed from the chat."
    ));
  }
});

test("an older machine card's removal its member's policy allowed is made by the desktop only under the desktop's own rules", async () => {
  for (const manage of ["ask", "allow"] as const) {
    const { service, storage, target } = memberRemovalFixture({ manage });
    homeOnMachine(storage);
    storage.current.metadata.pendingAppToolApprovals = [queuedRemovalApproval("target-participant", "target", {
      homeMachineId: "machine", status: "auto-applied", approvalScope: undefined, machineAppliedDecisionId: `server:queued-target@${NOW}`
    })];
    storage.conversationIdsWithQueuedRosterChanges = async () => [storage.current.id];

    await service.resumeQueuedRosterChanges();

    const approval = storage.current.metadata.pendingAppToolApprovals[0] as ChatAppToolApproval;
    assert.equal(approval.memberRemovalQueuedAt, undefined, manage);
    if (manage === "allow") {
      assert.equal(memberIds(storage.current).includes(target.id), false);
    } else {
      assert.ok(memberIds(storage.current).includes(target.id), "ask: refused here");
      assert.equal(approval.status, "cancelled");
      assert.match(approval.error ?? "", /may not make this change without your approval/);
    }
  }
});

test("on a machine, an approved removal or addition is applied there exactly as on the desktop (Д2)", async () => {
  {
    const { service, storage, actor, target } = memberRemovalFixture();
    service.setHostMachineId("machine");
    homeOnMachine(storage);
    const requested = await service.requestParticipantChangeFromTool(actor, {
      operations: [{ type: "remove_participant_from_chat", handle: "target" }]
    }) as { approvalId: string };

    await service.respondToAppToolApproval({ conversationId: "conversation-1", approvalId: requested.approvalId, approve: true });
    await waitFor(() => !memberIds(storage.current).includes(target.id));

    const approval = storage.current.metadata.pendingAppToolApprovals[0] as ChatAppToolApproval;
    assert.equal(approval.status, "approved");
    assert.equal(storage.current.messages.filter((message: ChatMessage) => message.content.startsWith("Removed @target")).length, 1);
  }
  {
    // An addition the member's policy allows: added at once, and said so.
    const { service, storage, actor } = memberRemovalFixture({ manage: "allow" });
    service.setHostMachineId("machine");
    homeOnMachine(storage);
    const result = await service.requestParticipantChangeFromTool(actor, {
      operations: [{ type: "add_new_participant_to_chat", saveAsPreset: false, participant: { handle: "helper", roleConfigId: ROLE.id, kind: "codex-cli" } }]
    }) as { status: string };

    assert.equal(result.status, "auto_applied");
    assert.equal((storage.current.metadata.participants as ChatParticipant[]).some((participant) => participant.handle === "helper"), true);
    assert.equal(storage.current.messages.filter((message: ChatMessage) => message.content.startsWith("Auto-applied")).length, 1);
  }
  {
    // An addition the User approves on its card (the Chat Assistant asks).
    const { service, storage, assistant } = memberRemovalFixture();
    service.setHostMachineId("machine");
    homeOnMachine(storage, assistant.id);
    const requested = await service.requestParticipantChangeFromTool(participantManagerActor("conversation-1", assistant), {
      operations: [{ type: "add_new_participant_to_chat", saveAsPreset: false, participant: { handle: "helper", roleConfigId: ROLE.id, kind: "codex-cli" } }]
    }) as { status: string; approvalId: string };
    assert.equal(requested.status, "pending_user_approval");

    await service.respondToAppToolApproval({ conversationId: "conversation-1", approvalId: requested.approvalId, approve: true });
    await waitFor(() => (storage.current.metadata.participants as ChatParticipant[]).some((participant) => participant.handle === "helper"));

    const approval = storage.current.metadata.pendingAppToolApprovals[0] as ChatAppToolApproval;
    assert.equal(approval.status, "approved");
    assert.equal(approval.memberAdditionQueuedAt, undefined);
  }
  {
    // A removal the member's policy allows: no card, made there once idle.
    const { service, storage, actor, target } = memberRemovalFixture({ manage: "allow" });
    service.setHostMachineId("machine");
    homeOnMachine(storage);
    const result = await service.requestParticipantChangeFromTool(actor, {
      operations: [{ type: "remove_participant_from_chat", handle: "target" }]
    }) as { status: string };
    assert.equal(result.status, "auto_approved");
    await waitFor(() => !memberIds(storage.current).includes(target.id));

    const approval = storage.current.metadata.pendingAppToolApprovals[0] as ChatAppToolApproval;
    assert.equal(approval.status, "auto-applied");
    assert.equal(approval.memberRemovalQueuedAt, undefined);
    assert.equal(storage.current.messages.filter((message: ChatMessage) => message.content.startsWith("Removed @target")).length, 1);
  }
});

test("a denied member removal changes nothing and tells the asking member", async () => {
  const { service, storage, actor, target } = memberRemovalFixture();
  const requested = await service.requestParticipantChangeFromTool(actor, {
    operations: [{ type: "remove_participant_from_chat", handle: "target" }]
  }) as { approvalId: string };

  await service.respondToAppToolApproval({ conversationId: storage.current.id, approvalId: requested.approvalId, approve: false });

  assert.ok(memberIds(storage.current).includes(target.id));
  assert.equal((storage.current.metadata.participantSessions as ChatParticipantSession[]).length, 1);
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "denied");
  assert.ok(storage.current.messages.some((message: ChatMessage) =>
    message.content === "User declined @manager's request to remove @target. @target stays in this chat."
  ));
});

test("a member cannot remove the chat's own session, and is told so in words that name no main session", async () => {
  const { service, actor, target } = memberRemovalFixture({ metadata: { mainSessionParticipantId: "target-participant" } });
  await assert.rejects(
    () => service.requestParticipantChangeFromTool(actor, { operations: [{ type: "remove_participant_from_chat", handle: target.handle }] }),
    (error: Error) => error.message.endsWith("This chat's own session cannot be removed.") && !/main session/i.test(error.message)
  );
});

test("a member cannot remove the Chat Assistant, the last member, or someone not in the chat", async () => {
  const { service, storage, actor, assistant } = memberRemovalFixture();

  await assert.rejects(
    () => service.requestParticipantChangeFromTool(actor, { operations: [{ type: "remove_participant_from_chat", handle: assistant.handle }] }),
    /Chat Assistant cannot be removed from the chat/
  );
  await assert.rejects(
    () => service.requestParticipantChangeFromTool(actor, { operations: [{ type: "remove_participant_from_chat", handle: "nobody" }] }),
    /@nobody is not a member of this chat/
  );
  await assert.rejects(
    () => service.requestParticipantChangeFromTool(actor, { operations: [{ type: "remove_participant_from_chat" }] }),
    /needs the participantId or handle/
  );
  // Operation numbers count from the whole request, additions included.
  await assert.rejects(
    () => service.requestParticipantChangeFromTool(actor, {
      operations: [
        { type: "add_new_participant_to_chat", participant: { handle: "helper", roleConfigId: ROLE.id, kind: "codex-cli" } },
        { type: "remove_participant_from_chat", handle: "nobody" }
      ]
    }),
    /Member operation 2: @nobody is not a member of this chat/
  );
  await assert.rejects(
    () => service.requestParticipantChangeFromTool(actor, {
      operations: ["assistant-participant", "manager-participant", "target-participant"].map((participantId) => ({ type: "remove_participant_from_chat", participantId }))
    }),
    /Chat Assistant cannot be removed/
  );
  // An invalid removal in a combined request adds nobody either.
  assert.deepEqual(storage.current.metadata.pendingAppToolApprovals ?? [], []);
  assert.equal(memberIds(storage.current).length, 3);
  storage.current.metadata.participants = storage.current.metadata.participants.filter((participant: ChatParticipant) => participant.id === "manager-participant");
  await assert.rejects(
    () => service.requestParticipantChangeFromTool(actor, { operations: [{ type: "remove_participant_from_chat", handle: "manager" }] }),
    /The last chat member cannot be removed/
  );
});

test("a member may ask to remove itself, as the member list allows", async () => {
  const { service, storage, actor, manager } = memberRemovalFixture();
  const requested = await service.requestParticipantChangeFromTool(actor, {
    operations: [{ type: "remove_participant_from_chat", participantId: manager.id }]
  }) as { status: string; approvalId: string; summary: string };
  assert.equal(requested.status, "pending_user_approval");
  assert.equal(requested.summary, "Remove @manager from this chat");

  await service.respondToAppToolApproval({ conversationId: storage.current.id, approvalId: requested.approvalId, approve: true });

  assert.equal(memberIds(storage.current).includes(manager.id), false);
  assert.ok(storage.current.messages.some((message: ChatMessage) => message.content === "Removed @manager from this chat at @manager's request."));
});

test("with Manage members allow, a removal needs no card and is made once the asking member's turn ends", async () => {
  const { service, storage, actor, target } = memberRemovalFixture({ manage: "allow" });
  const live = await storage.getConversation("conversation-1") as Conversation;
  await chatParts(service).activeRuns.beginChatRun(live, "manager-run");
  await chatParts(service).store.waitForQueuedSave(live.id);

  const result = await service.requestParticipantChangeFromTool(actor, {
    operations: [{ type: "remove_participant_from_chat", handle: "target" }]
  }) as { status: string; approvalId: string; summary: string };

  assert.equal(result.status, "auto_approved");
  assert.equal(result.summary, "Remove @target from this chat");
  let approval = (storage.current.metadata.pendingAppToolApprovals as ChatAppToolApproval[])[0];
  assert.equal(approval.status, "auto-applied");
  assert.equal(typeof approval.memberRemovalQueuedAt, "string");
  // Nothing asks the User: no pending card, no "approval needed" message;
  // the chat says who decided it, as for an allowed addition.
  assert.equal((storage.current.metadata.pendingAppToolApprovals as ChatAppToolApproval[]).some((item) => item.status === "pending"), false);
  assert.equal(storage.current.messages.some((message: ChatMessage) => message.content.includes("approval needed")), false);
  assert.ok(storage.current.messages.some((message: ChatMessage) => message.content === "Auto-approved member removal from @manager: Remove @target from this chat."));
  // The turn that asked is still running: the member is still here.
  assert.ok(memberIds(storage.current).includes(target.id));
  // A second removal of the same member is refused while the first waits.
  await assert.rejects(
    () => service.requestParticipantChangeFromTool(actor, { operations: [{ type: "remove_participant_from_chat", handle: "target" }] }),
    /A removal of @target is already waiting to be made/
  );

  await chatParts(service).activeRuns.endChatRun(live, "manager-run");
  await waitFor(() => !memberIds(storage.current).includes(target.id));

  approval = (storage.current.metadata.pendingAppToolApprovals as ChatAppToolApproval[]).find((item) => item.id === result.approvalId)!;
  assert.equal(approval.status, "auto-applied");
  assert.equal(approval.memberRemovalQueuedAt, undefined);
  assert.deepEqual(approval.appliedParticipantIds, [target.id]);
  assert.ok(storage.current.messages.some((message: ChatMessage) => message.content === "Removed @target from this chat at @manager's request."));
});

test("one request can add and remove members; each part follows the Manage members setting", async () => {
  {
    const { service, storage, actor, target } = memberRemovalFixture({ manage: "allow" });
    const result = await service.requestParticipantChangeFromTool(actor, {
      reason: "Swap reviewers.",
      operations: [
        { type: "add_new_participant_to_chat", saveAsPreset: false, participant: { handle: "helper", roleConfigId: ROLE.id, kind: "codex-cli" } },
        { type: "remove_participant_from_chat", handle: "target" }
      ]
    }) as { ok: boolean; status: string; additions: { status: string }; removals: { status: string } };
    assert.equal(result.ok, true);
    assert.equal(result.status, "combined");
    assert.equal(result.additions.status, "auto_applied");
    assert.equal(result.removals.status, "auto_approved");
    const members = storage.current.metadata.participants as ChatParticipant[];
    assert.ok(members.some((participant) => participant.handle === "helper"));
    // The chat is idle here, so the removal is made at once.
    await waitFor(() => !memberIds(storage.current).includes(target.id));
  }
  {
    const { service, storage, actor, target } = memberRemovalFixture({ manage: "ask" });
    const result = await service.requestParticipantChangeFromTool(actor, {
      operations: [
        { type: "remove_participant_from_chat", handle: "target" },
        { type: "add_new_participant_to_chat", saveAsPreset: false, participant: { handle: "helper", roleConfigId: ROLE.id, kind: "codex-cli" } }
      ]
    }) as { ok: boolean; additions: { status: string }; removals: { status: string } };
    assert.equal(result.additions.status, "pending_user_approval");
    assert.equal(result.removals.status, "pending_user_approval");
    const pending = (storage.current.metadata.pendingAppToolApprovals as ChatAppToolApproval[]).filter((item) => item.status === "pending");
    assert.equal(pending.length, 2);
    assert.ok(memberIds(storage.current).includes(target.id));
    assert.equal((storage.current.metadata.participants as ChatParticipant[]).some((participant) => participant.handle === "helper"), false);
  }
});

test("a member removal is approved as shown; an edited draft cannot change it into another change", async () => {
  const { service, storage, actor, target } = memberRemovalFixture();
  const requested = await service.requestParticipantChangeFromTool(actor, {
    operations: [{ type: "remove_participant_from_chat", handle: "target" }]
  }) as { approvalId: string };

  await service.respondToAppToolApproval({
    conversationId: storage.current.id,
    approvalId: requested.approvalId,
    approve: true,
    draftOverride: {
      operations: [{ type: "add_new_participant_to_chat", saveAsPreset: false, participant: { handle: "intruder", roleConfigId: ROLE.id, kind: "codex-cli" } }]
    } as any
  });

  assert.equal(memberIds(storage.current).includes(target.id), false);
  assert.equal((storage.current.metadata.participants as ChatParticipant[]).some((participant) => participant.handle === "intruder"), false);
});

test("a pending removal card closes when the member is removed from the member list first", async () => {
  const { service, storage, actor, target } = memberRemovalFixture();
  const requested = await service.requestParticipantChangeFromTool(actor, {
    operations: [{ type: "remove_participant_from_chat", handle: "target" }]
  }) as { approvalId: string };

  await service.removeParticipant({ conversationId: storage.current.id, participantId: target.id });

  const approval = (storage.current.metadata.pendingAppToolApprovals as ChatAppToolApproval[]).find((item) => item.id === requested.approvalId);
  assert.equal(approval?.status, "denied");
  assert.equal(approval?.error, "Member was removed from this chat.");
});

test("a removal raised by a member on a machine is answered on the User's server and applied there, never on the desktop", async () => {
  const { service, storage, manager, target } = memberRemovalFixture();
  homeOnMachine(storage);
  const approval: ChatAppToolApproval = {
    id: "machine-removal",
    conversationId: "conversation-1",
    requesterParticipantId: manager.id,
    requesterHandle: manager.handle,
    requesterRoleConfigId: manager.roleConfigId,
    toolName: APP_PARTICIPANTS_REQUEST_CHANGE_TOOL,
    capability: "participants.manage",
    status: "pending",
    request: { kind: "participant_removal", operations: [{ type: "remove_participant_from_chat", participantId: target.id, handle: target.handle }] },
    summary: "Remove @target from this chat",
    createdAt: NOW,
    updatedAt: NOW
  };
  await feedCard(service, "card.raise", machineCard(approval));
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].homeMachineId, "machine");

  // Not applied on the desktop directly...
  await assert.rejects(service.respondToAppToolApproval({ conversationId: "conversation-1", approvalId: approval.id, approve: true, draftOverride: approval.request }),
    /answered on the device its member runs on/);
  // ...its answer goes to the User's server, and without one it waits.
  await assert.rejects(service.answerAppToolApprovalCard({ conversationId: "conversation-1", approvalId: approval.id, approve: true }), /not linked to your server/);
  assert.ok(memberIds(storage.current).includes(target.id));
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "pending");
});
