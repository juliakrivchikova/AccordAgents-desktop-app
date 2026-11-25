import assert from "node:assert/strict";
import test from "node:test";
import { APP_PARTICIPANTS_REQUEST_CHANGE_TOOL, APP_ROSTER_REQUEST_CHANGE_TOOL, AppMcpService } from "./appMcp";
import { toolsForActor } from "./appMcp/protocol";
import { chatParts } from "./chat/test/chatParts";
import { participantPermissionPolicy } from "./chat/turns/promptSections";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import type { ChatAppToolApproval, ChatMessage, ChatParticipant, ChatParticipantConfig, ChatRoleConfig } from "../../shared/types";
import {
  ADMIN_ROLE, chatConversation, chatParticipant, NOW, participantManagerActor, ROLE, testService
} from "./chat/test/permissionFixtures";

test("custom role participant defaults apply to new chat participants", async () => {
  const managerRole: ChatRoleConfig = {
    ...ROLE,
    id: "custom-manager",
    label: "Custom Manager",
    participantDefaults: {
      autoWatch: true,
      requestParticipants: "deny",
      requestCompaction: "allow"
    }
  };
  const { service, storage, tempRoot } = testService({
    agents: [{ kind: "codex-cli", label: "Codex CLI", installed: true }],
    settings: { chatRoleConfigs: [ROLE, managerRole] }
  });

  const created = await service.createConversation({
    title: "Role defaults",
    participants: [
      { handle: "manager", roleConfigId: managerRole.id, kind: "codex-cli" }
    ]
  });

  let participant = (created.conversation.metadata.participants as ChatParticipant[]).find((item) => item.handle === "manager");
  assert.equal(participant?.autoWatch, true);
  assert.equal(participant?.permissions?.requestParticipants, "deny");
  assert.equal(participant?.permissions?.requestCompaction, "allow");

  const conversation = chatConversation([]);
  storage.current = conversation;
  await service.addParticipant({
    conversationId: conversation.id,
    participant: {
      handle: "manager2",
      roleConfigId: managerRole.id,
      kind: "codex-cli",
      autoWatch: false,
      permissions: {
        ...defaultChatAgentPermissions(),
        requestParticipants: "allow",
        requestCompaction: "deny"
      }
    }
  });

  participant = (storage.current.metadata.participants as ChatParticipant[]).find((item) => item.handle === "manager2");
  assert.equal(participant?.autoWatch, false);
  assert.equal(participant?.permissions?.requestParticipants, "allow");
  assert.equal(participant?.permissions?.requestCompaction, "deny");
});

test("participantPermissionPolicy does not suggest escalation for agent-mode masked shell and workspace grants", () => {
  const { service } = testService();
  const prompt = participantPermissionPolicy("claude-code", "plan", normalizeChatAgentPermissions({
    ...defaultChatAgentPermissions(),
    workspaceWrite: true,
    webAccess: false,
    shell: {
      enabled: true,
      rules: [{ action: "allow", match: "prefix", pattern: "npm run" }]
    }
  }), true);

  assert.match(prompt, /Shell commands are blocked by the current agent mode/);
  assert.match(prompt, /Workspace file edits are blocked by the current agent mode/);
  assert.match(prompt, /app_permissions_request_change.*webAccess/);
  assert.doesNotMatch(prompt, /shellRules/);
  assert.doesNotMatch(prompt, /workspaceWrite/);
});

test("Chat Assistant prompt suppresses repo edit shell escalation while preserving web guidance", async () => {
  const appMcp = new AppMcpService();
  const { service } = testService({
    appMcp,
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] }
  });
  const assistant = {
    ...chatParticipant("codex-cli", { repoRead: false, webAccess: false }),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const conversation = {
    ...chatConversation([assistant]),
    repoPath: "/repo"
  };
  const triggerMessage: ChatMessage = {
    ...conversation.messages[0],
    content: "Please inspect #src/main.ts",
    metadata: {
      repoFileMentions: [{ path: "src/main.ts" }]
    }
  };
  const session = await chatParts(service).memberSessions.newSessionForParticipant(assistant);
  const { prompt } = chatParts(service).turnPrompt.buildPromptParts(
    conversation,
    assistant,
    session,
    triggerMessage,
    "/tmp/workspace",
    false,
    { includeRoleInstructions: false, agentMode: "default", permissions: assistant.permissions }
  );

  // Its access is in its session's instructions, said once; the message
  // carries only the file it names.
  const instructions = chatParts(service).memberSessions.sessionInstructions(conversation, assistant, session, { agentMode: "default", permissions: assistant.permissions }, "/tmp/workspace") as string;
  assert.match(instructions, /Repository access, file edits, and shell commands are not Chat Assistant's default behavior/);
  assert.match(instructions, /generic participant/);
  assert.match(instructions, /Web access is blocked/);
  assert.match(instructions, /app_permissions_request_change.*webAccess/);
  assert.match(prompt, /Referenced repository files/);
  assert.match(prompt, /Chat Assistant does not read repository files by default/);
  const accessPart = instructions.slice(instructions.indexOf("Your access now"));
  for (const text of [prompt, accessPart]) {
    assert.doesNotMatch(text, /Repository: \/repo/);
    assert.doesNotMatch(text, /repoRead/);
    assert.doesNotMatch(text, /workspaceWrite/);
    assert.doesNotMatch(text, /shellRules/);
  }
});

test("role option discovery advertises archive_role and archived metadata", async () => {
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

  const options = await service.describeRoleOptionsForTool(participantManagerActor(conversation.id, assistant)) as any;
  assert.deepEqual(options.roleChange.supportedOperations, ["create_role", "edit_role", "archive_role"]);
  assert.match(options.roleChange.editPolicy, /archive_role/);
  const archived = options.roles.find((role: { id: string }) => role.id === archivedRole.id);
  assert.equal(archived.archived, true);
  assert.equal(archived.archivedAt, NOW);
});

test("existing Chat Assistant without persisted management permission still requests approval", async () => {
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id,
    permissions: normalizeChatAgentPermissions({
      repoRead: false,
      workspaceWrite: false,
      webAccess: false,
      requestParticipants: "ask",
      shell: {
        enabled: false,
        rules: []
      }
    })
  };
  assert.equal((assistant.permissions as unknown as Record<string, unknown>).manageRolesParticipants, undefined);
  const conversation = chatConversation([assistant]);
  const { service, storage } = testService({
    conversation,
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] }
  });

  const result = await service.requestRoleChangeFromTool(participantManagerActor(conversation.id, assistant), {
    operations: [{
      type: "create_role",
      role: {
        label: "Planning Reviewer",
        instructions: "Review plans."
      }
    }]
  }) as { status: string };

  assert.equal(result.status, "pending_user_approval");
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "pending");
});

test("role management deny rejects stale participant management tokens", async () => {
  const deniedRole: ChatRoleConfig = {
    ...ROLE,
    id: "denied-manager",
    label: "Denied Manager",
    participantDefaults: {
      autoWatch: false,
      requestParticipants: "ask",
      manageRolesParticipants: "deny"
    }
  };
  const manager = {
    ...chatParticipant("codex-cli"),
    id: "denied-participant",
    handle: "denied",
    roleConfigId: deniedRole.id
  };
  const conversation = chatConversation([manager]);
  const { service } = testService({
    conversation,
    settings: { chatRoleConfigs: [deniedRole, ROLE] }
  });

  await assert.rejects(
    () => service.requestRoleChangeFromTool(participantManagerActor(conversation.id, manager), {
      operations: [{
        type: "create_role",
        role: {
          label: "Should Not Apply",
          instructions: "No access."
        }
      }]
    }),
    /not allowed to manage roles or participants/
  );
});

test("participant explicit management deny downscopes an allow role", async () => {
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
    id: "downscoped-participant",
    handle: "downscoped",
    roleConfigId: allowingRole.id,
    permissions: normalizeChatAgentPermissions({
      ...defaultChatAgentPermissions(),
      manageRolesParticipants: "deny"
    })
  };
  const conversation = chatConversation([manager]);
  const { service } = testService({
    conversation,
    settings: { chatRoleConfigs: [allowingRole, ROLE] }
  });

  await assert.rejects(
    () => service.requestParticipantChangeFromTool(participantManagerActor(conversation.id, manager), {
      operations: [{
        type: "add_new_participant_to_chat",
        participant: {
          handle: "helper",
          roleConfigId: ROLE.id,
          kind: "codex-cli"
        }
      }]
    }),
    /not allowed to manage roles or participants/
  );
});

test("custom role management ask creates approval cards", async () => {
  const askingRole: ChatRoleConfig = {
    ...ROLE,
    id: "asking-manager",
    label: "Asking Manager",
    participantDefaults: {
      autoWatch: false,
      requestParticipants: "ask",
      manageRolesParticipants: "ask"
    }
  };
  const manager = {
    ...chatParticipant("codex-cli"),
    id: "asking-participant",
    handle: "asking",
    roleConfigId: askingRole.id
  };
  const conversation = chatConversation([manager]);
  const { service, storage } = testService({
    conversation,
    settings: { chatRoleConfigs: [askingRole, ROLE], chatParticipantConfigs: [] }
  });

  const result = await service.requestParticipantChangeFromTool(participantManagerActor(conversation.id, manager), {
    operations: [{
      type: "add_new_participant_to_chat",
      saveAsPreset: false,
      participant: {
        handle: "helper",
        roleConfigId: ROLE.id,
        kind: "codex-cli"
      }
    }]
  }) as { status: string };

  assert.equal(result.status, "pending_user_approval");
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "pending");
});

test("custom role management allow auto-applies participant and role changes", async () => {
  const allowingRole: ChatRoleConfig = {
    ...ROLE,
    id: "allowing-manager",
    label: "Allowing Manager",
    participantDefaults: {
      autoWatch: false,
      requestParticipants: "ask",
      manageRolesParticipants: "allow"
    }
  };
  const editableRole: ChatRoleConfig = {
    ...ROLE,
    id: "editable-role",
    label: "Editable Role",
    instructions: "Original instructions.",
    participantDefaults: {
      autoWatch: false,
      requestParticipants: "ask",
      manageRolesParticipants: "deny"
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
    settings: { chatRoleConfigs: [allowingRole, editableRole, ROLE], chatParticipantConfigs: [] }
  });
  const actor = participantManagerActor(conversation.id, manager);

  const roleResult = await service.requestRoleChangeFromTool(actor, {
    operations: [{
      type: "edit_role",
      role: {
        roleConfigId: editableRole.id,
        label: "Edited Role",
        instructions: "Edited instructions."
      }
    }]
  }) as { status: string };

  assert.equal(roleResult.status, "auto_applied");
  assert.equal(settingsState.chatRoleConfigs.find((role) => role.id === editableRole.id)?.label, "Edited Role");
  assert.equal(settingsState.chatRoleConfigs.find((role) => role.id === editableRole.id)?.participantDefaults?.manageRolesParticipants, "deny");
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "auto-applied");

  const participantResult = await service.requestParticipantChangeFromTool(actor, {
    operations: [{
      type: "add_new_participant_to_chat",
      saveAsPreset: false,
      participant: {
        handle: "automanaged",
        roleConfigId: ROLE.id,
        kind: "codex-cli"
      }
    }]
  }) as { status: string };

  assert.equal(participantResult.status, "auto_applied");
  assert.ok((storage.current.metadata.participants as ChatParticipant[]).some((participant) => participant.handle === "automanaged"));
  assert.equal(storage.current.metadata.pendingAppToolApprovals.at(-1).status, "auto-applied");
});

test("role default management escalation is never auto-applied by allow managers", async () => {
  const allowingRole: ChatRoleConfig = {
    ...ROLE,
    id: "allowing-manager",
    label: "Allowing Manager",
    participantDefaults: {
      requestParticipants: "ask",
      manageRolesParticipants: "allow"
    }
  };
  const editableRole: ChatRoleConfig = {
    ...ROLE,
    id: "editable-role",
    label: "Editable Role",
    instructions: "Original instructions.",
    participantDefaults: {
      requestParticipants: "ask",
      manageRolesParticipants: "deny"
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
    settings: { chatRoleConfigs: [allowingRole, editableRole], chatParticipantConfigs: [] }
  });
  const actor = participantManagerActor(conversation.id, manager);

  const editResult = await service.requestRoleChangeFromTool(actor, {
    operations: [{
      type: "edit_role",
      role: {
        roleConfigId: editableRole.id,
        label: "Escalating Role",
        instructions: "Raises management.",
        participantDefaults: {
          requestParticipants: "ask",
          manageRolesParticipants: "ask"
        }
      }
    }]
  }) as { status: string; approvalId: string };

  assert.equal(editResult.status, "pending_user_approval");
  assert.equal(storage.current.metadata.pendingAppToolApprovals.at(-1).status, "pending");
  assert.equal(settingsState.chatRoleConfigs.find((role) => role.id === editableRole.id)?.participantDefaults?.manageRolesParticipants, "deny");

  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: editResult.approvalId,
    approve: true
  });

  assert.equal(settingsState.chatRoleConfigs.find((role) => role.id === editableRole.id)?.participantDefaults?.manageRolesParticipants, "ask");

  const createResult = await service.requestRoleChangeFromTool(actor, {
    operations: [{
      type: "create_role",
      role: {
        label: "New Default Manager",
        instructions: "Starts with management.",
        participantDefaults: {
          manageRolesParticipants: "allow"
        }
      }
    }]
  }) as { status: string };

  assert.equal(createResult.status, "pending_user_approval");
  assert.equal(settingsState.chatRoleConfigs.some((role) => role.label === "New Default Manager"), false);
});

test("participant management override above role default requires approval and then authorizes", async () => {
  const allowingRole: ChatRoleConfig = {
    ...ROLE,
    id: "allowing-manager",
    label: "Allowing Manager",
    participantDefaults: {
      requestParticipants: "ask",
      manageRolesParticipants: "allow"
    }
  };
  const deniedRole: ChatRoleConfig = {
    ...ROLE,
    id: "denied-role",
    label: "Denied Role",
    participantDefaults: {
      requestParticipants: "ask",
      manageRolesParticipants: "deny"
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
    settings: { chatRoleConfigs: [allowingRole, deniedRole], chatParticipantConfigs: [] }
  });
  const actor = participantManagerActor(conversation.id, manager);

  const result = await service.requestParticipantChangeFromTool(actor, {
    operations: [{
      type: "add_new_participant_to_chat",
      saveAsPreset: true,
      participant: {
        handle: "deniedmanager",
        roleConfigId: deniedRole.id,
        kind: "codex-cli",
        permissions: {
          ...defaultChatAgentPermissions(),
          manageRolesParticipants: "allow"
        }
      }
    }]
  }) as { status: string; approvalId: string };

  assert.equal(result.status, "pending_user_approval");
  const pending = storage.current.metadata.pendingAppToolApprovals.at(-1);
  assert.equal(pending?.status, "pending");
  assert.equal((pending?.request as any).operations[0].participant.permissions.manageRolesParticipants, "allow");
  assert.ok(!(storage.current.metadata.participants as ChatParticipant[]).some((participant) => participant.handle === "deniedmanager"));

  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: result.approvalId,
    approve: true
  });

  const added = (storage.current.metadata.participants as ChatParticipant[]).find((participant) => participant.handle === "deniedmanager");
  assert.ok(added);
  assert.equal(added.permissions?.manageRolesParticipants, "allow");
  const saved = settingsState.chatParticipantConfigs.find((participant) => participant.handle === "deniedmanager");
  assert.ok(saved);
  assert.equal(saved.permissions?.manageRolesParticipants, "allow");

  const managerResult = await service.requestRoleChangeFromTool(participantManagerActor(conversation.id, added), {
    operations: [{
      type: "create_role",
      role: {
        label: "Approved Override Manager",
        instructions: "Can manage after explicit approval."
      }
    }]
  }) as { status: string };
  assert.equal(managerResult.status, "auto_applied");
});

test("participant management override from ask to allow requires approval", async () => {
  const allowingRole: ChatRoleConfig = {
    ...ROLE,
    id: "allowing-manager",
    label: "Allowing Manager",
    participantDefaults: {
      requestParticipants: "ask",
      manageRolesParticipants: "allow"
    }
  };
  const askingRole: ChatRoleConfig = {
    ...ROLE,
    id: "asking-target",
    label: "Asking Target",
    participantDefaults: {
      requestParticipants: "ask",
      manageRolesParticipants: "ask"
    }
  };
  const manager = {
    ...chatParticipant("codex-cli"),
    id: "allowing-participant",
    handle: "allowing",
    roleConfigId: allowingRole.id
  };
  const conversation = chatConversation([manager]);
  const { service, storage } = testService({
    conversation,
    settings: { chatRoleConfigs: [allowingRole, askingRole], chatParticipantConfigs: [] }
  });

  const result = await service.requestParticipantChangeFromTool(participantManagerActor(conversation.id, manager), {
    operations: [{
      type: "add_new_participant_to_chat",
      saveAsPreset: false,
      participant: {
        handle: "asktoallow",
        roleConfigId: askingRole.id,
        kind: "codex-cli",
        permissions: {
          ...defaultChatAgentPermissions(),
          manageRolesParticipants: "allow"
        }
      }
    }]
  }) as { status: string };

  assert.equal(result.status, "pending_user_approval");
  assert.equal(storage.current.metadata.pendingAppToolApprovals.at(-1).status, "pending");
  assert.equal((storage.current.metadata.pendingAppToolApprovals.at(-1).request as any).operations[0].participant.permissions.manageRolesParticipants, "allow");
});

test("participant permission management escalation is visible in approval payload", async () => {
  const askingRole: ChatRoleConfig = {
    ...ROLE,
    id: "asking-manager",
    label: "Asking Manager",
    participantDefaults: {
      requestParticipants: "ask",
      manageRolesParticipants: "ask"
    }
  };
  const deniedRole: ChatRoleConfig = {
    ...ROLE,
    id: "denied-role",
    label: "Denied Role",
    participantDefaults: {
      requestParticipants: "ask",
      manageRolesParticipants: "deny"
    }
  };
  const manager = {
    ...chatParticipant("codex-cli"),
    id: "asking-participant",
    handle: "asking",
    roleConfigId: askingRole.id
  };
  const conversation = chatConversation([manager]);
  const { service, storage } = testService({
    conversation,
    settings: { chatRoleConfigs: [askingRole, deniedRole], chatParticipantConfigs: [] }
  });

  const result = await service.requestParticipantChangeFromTool(participantManagerActor(conversation.id, manager), {
    operations: [{
      type: "add_new_participant_to_chat",
      saveAsPreset: false,
      participant: {
        handle: "sneaky",
        roleConfigId: deniedRole.id,
        kind: "codex-cli",
        permissions: {
          ...defaultChatAgentPermissions(),
          manageRolesParticipants: "allow"
        }
      }
    }]
  }) as { status: string };

  assert.equal(result.status, "pending_user_approval");
  const pending = storage.current.metadata.pendingAppToolApprovals[0] as ChatAppToolApproval;
  const participant = (pending.request as any).operations[0].participant;
  assert.equal(participant.handle, "sneaky");
  assert.equal(participant.permissions.manageRolesParticipants, "allow");
});

test("participant describe options expose role default explicit and effective management policy", async () => {
  const deniedRole: ChatRoleConfig = {
    ...ROLE,
    id: "denied-role",
    label: "Denied Role",
    participantDefaults: {
      requestParticipants: "ask",
      manageRolesParticipants: "deny"
    }
  };
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const currentOverride = {
    ...chatParticipant("codex-cli"),
    id: "override-participant",
    handle: "override",
    roleConfigId: deniedRole.id,
    permissions: normalizeChatAgentPermissions({
      ...defaultChatAgentPermissions(),
      manageRolesParticipants: "allow"
    })
  };
  const conversation = chatConversation([assistant, currentOverride]);
  const savedOverride: ChatParticipantConfig = {
    id: "saved-override",
    handle: "savedoverride",
    roleConfigId: deniedRole.id,
    kind: "codex-cli",
    permissions: normalizeChatAgentPermissions({
      ...defaultChatAgentPermissions(),
      manageRolesParticipants: "ask"
    }),
    updatedAt: NOW
  };
  const { service } = testService({
    conversation,
    settings: { chatRoleConfigs: [ADMIN_ROLE, deniedRole], chatParticipantConfigs: [savedOverride] }
  });

  const options = await service.describeParticipantOptionsForTool(participantManagerActor(conversation.id, assistant)) as any;
  const current = options.currentParticipants.find((participant: { handle: string }) => participant.handle === "override");
  assert.equal(current.manageRolesParticipants.roleDefault, "deny");
  assert.equal(current.manageRolesParticipants.participantExplicit, "allow");
  assert.equal(current.manageRolesParticipants.effective, "allow");
  assert.equal(current.manageRolesParticipants.exceedsRoleDefault, true);
  const saved = options.savedParticipants.find((participant: { handle: string }) => participant.handle === "savedoverride");
  assert.equal(saved.manageRolesParticipants.roleDefault, "deny");
  assert.equal(saved.manageRolesParticipants.participantExplicit, "ask");
  assert.equal(saved.manageRolesParticipants.effective, "ask");
  assert.equal(saved.manageRolesParticipants.exceedsRoleDefault, true);
});

test("Chat Assistant cannot edit built-in roles through role app tool", async () => {
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const conversation = chatConversation([assistant]);
  const { service } = testService({
    conversation,
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] }
  });

  await assert.rejects(
    () => service.requestRoleChangeFromTool(participantManagerActor(conversation.id, assistant), {
      operations: [{
        type: "edit_role",
        role: {
          roleConfigId: ADMIN_ROLE.id,
          label: "Changed Assistant",
          instructions: "Changed instructions."
        }
      }]
    }),
    /Built-in role/
  );
});

test("Chat Assistant cannot edit deleted roles through role app tool", async () => {
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
    settings: { chatRoleConfigs: [ADMIN_ROLE, archivedRole] }
  });

  await assert.rejects(
    () => service.requestRoleChangeFromTool(participantManagerActor(conversation.id, assistant), {
      operations: [{
        type: "edit_role",
        role: {
          roleConfigId: archivedRole.id,
          label: "Edited Archived Reviewer",
          instructions: "This should not be accepted."
        }
      }]
    }),
    /Deleted role "Archived Reviewer" cannot be edited/
  );
});

test("app MCP participant permissions schema exposes visible role management overrides", () => {
  const appMcp = new AppMcpService();
  const tools = toolsForActor({
    conversationId: "conversation-1",
    participantId: "participant-1",
    roleConfigId: ADMIN_ROLE.id,
    roleConfigVersion: ADMIN_ROLE.version,
    capabilities: ["participants.manage"]
  }) as Array<{
    name: string;
    inputSchema?: any;
  }>;
  const participantRequestTool = tools.find((tool) => tool.name === APP_PARTICIPANTS_REQUEST_CHANGE_TOOL);

  assert.ok(participantRequestTool);
  const permissions = participantRequestTool.inputSchema.properties.operations.items.properties.participant.properties.permissions;
  assert.equal(permissions.additionalProperties, false);
  assert.deepEqual(permissions.properties.manageRolesParticipants.enum, ["ask", "allow", "deny"]);
  assert.deepEqual(permissions.properties.requestParticipants.enum, ["ask", "allow", "deny"]);
  const rosterRequestTool = tools.find((tool) => tool.name === APP_ROSTER_REQUEST_CHANGE_TOOL);
  const rosterPermissions = rosterRequestTool?.inputSchema.properties.operations.items.properties.participant.properties.permissions;
  assert.ok(rosterPermissions);
  assert.deepEqual(rosterPermissions.properties.manageRolesParticipants.enum, ["ask", "allow", "deny"]);
});
