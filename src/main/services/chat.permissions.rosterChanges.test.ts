import assert from "node:assert/strict";
import test from "node:test";
import { APP_PARTICIPANTS_REQUEST_CHANGE_TOOL, APP_ROLES_REQUEST_CHANGE_TOOL, AppMcpService } from "./appMcp";
import { toolsForActor } from "./appMcp/protocol";
import { chatParts } from "./chat/test/chatParts";
import type { HubCard } from "../../shared/hubOps";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import type {
  ChatAppToolApproval, ChatMessage, ChatParticipant, ChatParticipantConfig, ChatRoleConfig, Conversation
} from "../../shared/types";
import {
  ADMIN_ROLE, answeredCard, chatConversation, chatParticipant, feedCard, homeOnMachine, machineCard, memberIds,
  memberRemovalFixture, NOW, participantManagerActor, queuedRemovalApproval, removalTrio, ROLE, testService
} from "./chat/test/permissionFixtures";

test("a member addition prepared before the User added the same name is refused when applied", async () => {
  const { conversation, worker } = removalTrio();
  const { service, storage } = testService({ conversation });
  const live = await storage.getConversation(conversation.id) as Conversation;
  const duplicate = { ...worker, id: "late-duplicate" };
  assert.throws(
    () => chatParts(service).rosterChanges.applyPreparedRosterChange(live, { request: { operations: [] }, participants: [duplicate], summary: "" }),
    /Duplicate member name: @worker/
  );
  const watcherA = { ...chatParticipant("codex-cli"), id: "watcher-a", handle: "watcher-a", autoWatch: true };
  const watcherB = { ...chatParticipant("codex-cli"), id: "watcher-b", handle: "watcher-b", autoWatch: true };
  live.metadata = { ...live.metadata, participants: [...(live.metadata.participants as ChatParticipant[]), watcherA] };
  // A second watcher joins without watching, as validateParticipants adds one.
  const added = chatParts(service).rosterChanges.applyPreparedRosterChange(live, { request: { operations: [] }, participants: [watcherB], summary: "" }) as ChatParticipant[];
  assert.equal(added[0].autoWatch, false);
  assert.equal((live.metadata.participants as ChatParticipant[]).filter((participant) => participant.autoWatch === true).length, 1);
});

test("the desktop's copy of a machine member's card never carries a waiting marker, however it first hears of it", async () => {
  const { service, storage, target } = memberRemovalFixture({ manage: "allow" });
  homeOnMachine(storage);
  const raisedPayload = { ...queuedRemovalApproval("target-participant", "target"), status: "auto-applied" as const, approvalScope: undefined };
  // Only the answer reaches it (a restart, a feed read from a later place),
  // with the payload the machine raised, marker and all.
  const card = answeredCard({ ...machineCard(raisedPayload), card: { approval: raisedPayload } }, { approve: true, auto: true }, "machine-device");
  await feedCard(service, "card.answer", card);
  let copy = storage.current.metadata.pendingAppToolApprovals[0] as ChatAppToolApproval;
  assert.equal(copy.memberRemovalQueuedAt, undefined);
  assert.equal(copy.machineDecisionPending?.approve, true);
  // Nothing is queued here, so nothing is made here.
  assert.equal(chatParts(service).queuedRosterChanges.queuedMemberRemovalChats.has("conversation-1"), false);
  await chatParts(service).queuedRosterChanges.applyQueuedMemberRemovalsOnce("conversation-1");
  assert.ok(memberIds(storage.current).includes(target.id));
  // Settled by the machine with a copy still marked: the desktop takes the outcome, not the marker.
  await feedCard(service, "card.settle", { ...card, state: "settled", outcome: { result: "applied",
    approval: { ...raisedPayload, updatedAt: new Date(Date.now() + 1000).toISOString() } } });
  copy = storage.current.metadata.pendingAppToolApprovals[0] as ChatAppToolApproval;
  assert.equal(copy.memberRemovalQueuedAt, undefined);
});

test("the desktop changes no member for a machine member's card: it waits for the machine's word, whoever answered (Д2)", async () => {
  {
    // The User refused it: the machine applies the refusal; nothing is
    // queued here, the desktop's card waits for the machine's word.
    const { service, storage, target } = memberRemovalFixture();
    homeOnMachine(storage);
    const card = machineCard(queuedRemovalApproval("target-participant", "target", { homeMachineId: "machine" }));
    await feedCard(service, "card.raise", card);
    const refused = answeredCard(card, { approve: false });
    await feedCard(service, "card.answer", refused, "op-refused");
    const waiting = storage.current.metadata.pendingAppToolApprovals[0] as ChatAppToolApproval;
    assert.equal(waiting.memberRemovalQueuedAt, undefined);
    assert.equal(waiting.machineDecisionPending?.approve, false);
    assert.equal(waiting.machineDecisionPending?.decisionId, "op-refused");
    await chatParts(service).queuedRosterChanges.applyQueuedMemberRemovalsOnce("conversation-1");
    assert.ok(memberIds(storage.current).includes(target.id));
    await feedCard(service, "card.settle", { ...refused, state: "settled", outcome: { result: "applied",
      approval: { ...(card.card as { approval: ChatAppToolApproval }).approval, status: "denied", updatedAt: new Date(Date.now() + 1000).toISOString() } } });
    const closed = storage.current.metadata.pendingAppToolApprovals[0] as ChatAppToolApproval;
    assert.equal(closed.status, "denied");
    assert.equal(closed.machineDecisionPending, undefined);
    assert.ok(memberIds(storage.current).includes(target.id));
  }
  const approvedCases: Array<{ name: string; card: () => HubCard; answeredBy: (card: HubCard) => string; auto?: boolean; home?: string }> = [
    { name: "approved on the phone", card: () => machineCard(queuedRemovalApproval("target-participant", "target", { homeMachineId: "machine" })), answeredBy: () => "phone-device" },
    { name: "approved by the member's own machine", card: () => machineCard(queuedRemovalApproval("target-participant", "target", { homeMachineId: "machine" })), answeredBy: (card) => card.raisedBy },
    { name: "naming the member by another handle", card: () => machineCard(queuedRemovalApproval("target-participant", "someone-else", { homeMachineId: "machine" })), answeredBy: () => "phone-device" },
    {
      name: "a removal its machine's policy allowed", auto: true, answeredBy: (card) => card.raisedBy,
      card: () => machineCard(queuedRemovalApproval("target-participant", "target", { homeMachineId: "machine", status: "auto-applied", approvalScope: undefined }))
    },
    {
      name: "an addition its machine's policy allowed", auto: true, home: "target-participant", answeredBy: (card) => card.raisedBy,
      card: () => machineCard({
        id: "machine-addition", conversationId: "conversation-1", requesterParticipantId: "target-participant", requesterHandle: "target", requesterRoleConfigId: ROLE.id,
        toolName: APP_PARTICIPANTS_REQUEST_CHANGE_TOOL, capability: "participants.manage", status: "auto-applied", approvalScope: "chat",
        request: { operations: [{ type: "add_new_participant_to_chat", saveAsPreset: false, participant: { handle: "helper", roleConfigId: ROLE.id, kind: "codex-cli" } }] },
        summary: "Add @helper", homeMachineId: "machine", memberAdditionQueuedAt: NOW, createdAt: NOW, updatedAt: NOW
      })
    }
  ];
  for (const item of approvedCases) {
    const { service, storage } = memberRemovalFixture();
    homeOnMachine(storage, item.home);
    const members = memberIds(storage.current);
    const card = item.card();
    await feedCard(service, "card.raise", card);
    await feedCard(service, "card.answer", answeredCard(card, { approve: true, ...(item.auto ? { auto: true } : {}) }, item.answeredBy(card)));
    await chatParts(service).queuedRosterChanges.applyQueuedMemberRemovalsOnce("conversation-1");
    await chatParts(service).queuedRosterChanges.applyQueuedMemberAdditionsOnce("conversation-1");
    const approval = storage.current.metadata.pendingAppToolApprovals[0] as ChatAppToolApproval;
    assert.equal(approval.machineDecisionPending?.approve, true, `${item.name}: waits for its machine`);
    assert.equal(approval.memberRemovalQueuedAt, undefined, item.name);
    assert.equal(approval.memberAdditionQueuedAt, undefined, item.name);
    assert.deepEqual(memberIds(storage.current), members, `${item.name}: no member changed here`);
    assert.equal(storage.current.messages.some((message: ChatMessage) => /^(Removed|Auto-applied|Applied|Could not)/.test(message.content)), false, item.name);
  }
  {
    // A card that names another member than the one asking is not shown, and
    // nothing is made for it.
    const { service, storage, target } = memberRemovalFixture();
    homeOnMachine(storage);
    const card = machineCard(queuedRemovalApproval("target-participant", "target", { homeMachineId: "machine" }), { participantId: "target-participant" });
    await feedCard(service, "card.raise", card);
    await feedCard(service, "card.answer", answeredCard(card, { approve: true }));
    assert.equal(((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).some((item) => item.id === card.cardId), false);
    await chatParts(service).queuedRosterChanges.applyQueuedMemberRemovalsOnce("conversation-1");
    assert.ok(memberIds(storage.current).includes(target.id));
  }
});

test("participant request with saveAsPreset false adds a chat-only participant", async () => {
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const conversation = chatConversation([assistant]);
  const { service, storage, settingsState } = testService({
    conversation,
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE], chatParticipantConfigs: [] }
  });
  const actor = participantManagerActor(conversation.id, assistant);

  const requested = await service.requestParticipantChangeFromTool(actor, {
    reason: "One-off participant for this chat.",
    operations: [{
      type: "add_new_participant_to_chat",
      saveAsPreset: false,
      participant: {
        handle: "skeptic",
        roleConfigId: ROLE.id,
        kind: "codex-cli"
      }
    }]
  });

  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: requested.approvalId as string,
    approve: true
  });

  assert.equal(settingsState.chatParticipantConfigs.length, 0);
  assert.ok((storage.current.metadata.participants as ChatParticipant[]).some((participant) => participant.handle === "skeptic"));
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "approved");
});

test("participant app tool honors autoWatch for new participants and saved presets", async () => {
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const conversation = chatConversation([assistant]);
  const { service, storage, settingsState } = testService({
    conversation,
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE], chatParticipantConfigs: [] }
  });
  const actor = participantManagerActor(conversation.id, assistant);

  const requested = await service.requestParticipantChangeFromTool(actor, {
    reason: "Add a watcher and save the preset.",
    operations: [{
      type: "add_new_participant_to_chat",
      saveAsPreset: true,
      participant: {
        handle: "watcher",
        roleConfigId: ROLE.id,
        kind: "codex-cli",
        autoWatch: true
      }
    }]
  });

  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: requested.approvalId as string,
    approve: true
  });

  const added = (storage.current.metadata.participants as ChatParticipant[]).find((participant) => participant.handle === "watcher");
  assert.equal(added?.autoWatch, true);
  assert.equal(settingsState.chatParticipantConfigs[0]?.autoWatchEnabled, true);
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "approved");
});

test("existing participant overrides preserve preset auto-watch and execution defaults", async () => {
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const savedPermissions = normalizeChatAgentPermissions({
    ...defaultChatAgentPermissions(),
    requestParticipants: "allow"
  });
  const savedParticipant: ChatParticipantConfig = {
    id: "saved-manager",
    handle: "saved-manager",
    roleConfigId: ROLE.id,
    behaviorRuleIds: [],
    kind: "codex-cli",
    model: "gpt-old",
    permissions: savedPermissions,
    remoteExecution: "remote",
    autoWatchEnabled: true,
    updatedAt: NOW
  };
  const conversation = chatConversation([assistant]);
  const { service, storage } = testService({
    conversation,
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE], chatParticipantConfigs: [savedParticipant] }
  });
  const actor = participantManagerActor(conversation.id, assistant);

  const requested = await service.requestParticipantChangeFromTool(actor, {
    reason: "Add saved participant with model override only.",
    operations: [{
      type: "add_existing_participant_to_chat",
      participantConfigId: savedParticipant.id,
      overrides: {
        model: "gpt-new"
      }
    }]
  });

  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: requested.approvalId as string,
    approve: true
  });

  const added = (storage.current.metadata.participants as ChatParticipant[]).find((participant) => participant.handle === "saved-manager");
  assert.equal(added?.model, "gpt-new");
  assert.equal(added?.autoWatch, true);
  assert.equal(added?.remoteExecution, "remote");
  assert.equal(added?.permissions?.requestParticipants, "allow");
});

test("participant creation rejects archived roles for new participants", async () => {
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const archivedRole: ChatRoleConfig = {
    ...ROLE,
    id: "archived-reviewer",
    label: "Archived Reviewer",
    archivedAt: NOW
  };
  const conversation = chatConversation([assistant]);
  const { service } = testService({
    conversation,
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE, archivedRole], chatParticipantConfigs: [] }
  });
  const actor = participantManagerActor(conversation.id, assistant);

  await assert.rejects(
    () => service.requestParticipantChangeFromTool(actor, {
      reason: "Do not allow new references to archived roles.",
      operations: [{
        type: "add_new_participant_to_chat",
        saveAsPreset: false,
        participant: {
          handle: "archived",
          roleConfigId: archivedRole.id,
          kind: "codex-cli"
        }
      }]
    }),
    /Deleted role "Archived Reviewer" cannot be used/
  );

  await assert.rejects(
    () => service.addParticipant({
      conversationId: conversation.id,
      participant: {
        handle: "archived-direct",
        roleConfigId: archivedRole.id,
        kind: "codex-cli"
      }
    }),
    /Deleted role "Archived Reviewer" cannot be used/
  );
});

test("role app tool approval preserves participant defaults for review and persistence", async () => {
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const conversation = chatConversation([assistant]);
  const { service, storage, settingsState } = testService({
    conversation,
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] }
  });

  const requested = await service.requestRoleChangeFromTool(participantManagerActor(conversation.id, assistant), {
    operations: [{
      type: "create_role",
      role: {
        label: "Workflow-like Manager",
        instructions: "Coordinate work.",
        participantDefaults: {
          autoWatch: true,
          requestParticipants: "allow",
          manageRolesParticipants: "allow"
        }
      }
    }]
  }) as { approvalId: string };

  const pending = storage.current.metadata.pendingAppToolApprovals[0] as ChatAppToolApproval;
  assert.equal((pending.request as any).operations[0].role.participantDefaults.autoWatch, true);
  assert.equal((pending.request as any).operations[0].role.participantDefaults.requestParticipants, "allow");
  assert.equal((pending.request as any).operations[0].role.participantDefaults.manageRolesParticipants, "allow");

  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: requested.approvalId,
    approve: true
  });

  const role = settingsState.chatRoleConfigs.find((item) => item.label === "Workflow-like Manager");
  assert.equal(role?.participantDefaults?.autoWatch, true);
  assert.equal(role?.participantDefaults?.requestParticipants, "allow");
  assert.equal(role?.participantDefaults?.manageRolesParticipants, "allow");
});

test("dependent role and participant requests collapse into one atomic grouped approval", async () => {
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const conversation = chatConversation([assistant]);
  const { service, storage, settingsState } = testService({
    conversation,
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE], chatParticipantConfigs: [] }
  });
  const actor = participantManagerActor(conversation.id, assistant);

  const roleResult = await service.requestRoleChangeFromTool(actor, {
    reason: "Need a specialized privacy role.",
    operations: [{
      type: "create_role",
      role: {
        label: "Privacy Threat Modeler",
        instructions: "Identify privacy threats and mitigation gaps."
      }
    }]
  }) as { approvalId: string; createdRoleRefs: Array<{ draftRoleRef: string }> };
  const draftRoleRef = roleResult.createdRoleRefs[0].draftRoleRef;
  assert.match(draftRoleRef, /^draft-role-/);
  assert.equal(storage.current.metadata.pendingAppToolApprovals.length, 1);
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].toolName, APP_ROLES_REQUEST_CHANGE_TOOL);

  const participantResult = await service.requestParticipantChangeFromTool(actor, {
    reason: "Add privacy reviewer and save it.",
    operations: [{
      type: "add_new_participant_to_chat",
      saveAsPreset: true,
      participant: {
        handle: "privacy",
        roleConfigId: draftRoleRef,
        kind: "claude-code"
      }
    }]
  }) as { approvalId: string };

  assert.equal(participantResult.approvalId, roleResult.approvalId);
  const pending = storage.current.metadata.pendingAppToolApprovals[0] as ChatAppToolApproval;
  assert.equal(pending.toolName, APP_PARTICIPANTS_REQUEST_CHANGE_TOOL);
  assert.equal((pending.request as any).kind, "role_participant_change");

  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: participantResult.approvalId,
    approve: true
  });

  const createdRole = settingsState.chatRoleConfigs.find((role) => role.label === "Privacy Threat Modeler");
  assert.ok(createdRole);
  assert.equal(settingsState.batchWriteCount, 1);
  assert.equal(settingsState.chatParticipantConfigs.length, 1);
  assert.equal(settingsState.chatParticipantConfigs[0].roleConfigId, createdRole.id);
  const addedParticipant = (storage.current.metadata.participants as ChatParticipant[]).find((participant) => participant.handle === "privacy");
  assert.equal(addedParticipant?.roleConfigId, createdRole.id);
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "approved");
});

test("auto-applied role creation returns a persisted role id for participant follow-up", async () => {
  const allowingRole: ChatRoleConfig = {
    ...ROLE,
    id: "allowing-manager",
    label: "Allowing Manager",
    participantDefaults: {
      requestParticipants: "ask",
      manageRolesParticipants: "allow"
    }
  };
  const manager = {
    ...chatParticipant("codex-cli"),
    id: "allowing-participant",
    handle: "allowing",
    roleConfigId: allowingRole.id
  };
  const conversation = chatConversation([manager]);
  const { service, storage, settingsState } = testService({
    conversation,
    settings: { chatRoleConfigs: [allowingRole, ROLE], chatParticipantConfigs: [] }
  });
  const actor = participantManagerActor(conversation.id, manager);

  const roleResult = await service.requestRoleChangeFromTool(actor, {
    reason: "Need a specialized privacy role.",
    operations: [{
      type: "create_role",
      role: {
        label: "Privacy Threat Modeler",
        instructions: "Identify privacy threats and mitigation gaps."
      }
    }]
  }) as { status: string; createdRoleRefs: Array<{ roleConfigId?: string; draftRoleRef?: string }> };
  assert.equal(roleResult.status, "auto_applied");
  assert.equal(roleResult.createdRoleRefs[0].draftRoleRef, undefined);
  const roleConfigId = roleResult.createdRoleRefs[0].roleConfigId;
  assert.equal(roleConfigId, settingsState.chatRoleConfigs.find((role) => role.label === "Privacy Threat Modeler")?.id);

  const participantResult = await service.requestParticipantChangeFromTool(actor, {
    reason: "Add privacy reviewer and save it.",
    operations: [{
      type: "add_new_participant_to_chat",
      saveAsPreset: true,
      participant: {
        handle: "privacy",
        roleConfigId,
        kind: "claude-code"
      }
    }]
  }) as { status: string };

  assert.equal(participantResult.status, "auto_applied");
  assert.equal(settingsState.chatParticipantConfigs[0]?.roleConfigId, roleConfigId);
  const addedParticipant = (storage.current.metadata.participants as ChatParticipant[]).find((participant) => participant.handle === "privacy");
  assert.equal(addedParticipant?.roleConfigId, roleConfigId);
});

test("app MCP role request tool is not provider-destructive because app approval gates deletion", () => {
  const appMcp = new AppMcpService();
  const tools = toolsForActor({
    conversationId: "conversation-1",
    participantId: "participant-1",
    roleConfigId: ADMIN_ROLE.id,
    roleConfigVersion: ADMIN_ROLE.version,
    capabilities: ["participants.manage"]
  }) as Array<{
    name: string;
    annotations?: { destructiveHint?: boolean };
    inputSchema?: any;
  }>;
  const roleRequestTool = tools.find((tool) => tool.name === APP_ROLES_REQUEST_CHANGE_TOOL);

  assert.ok(roleRequestTool);
  assert.equal(roleRequestTool.annotations?.destructiveHint, false);
  const roleProperties = roleRequestTool.inputSchema.properties.operations.items.properties.role.properties;
  assert.deepEqual(roleProperties.participantDefaults.properties.manageRolesParticipants.enum, ["ask", "allow", "deny"]);
});
