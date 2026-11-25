import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { APP_PERMISSIONS_REQUEST_CHANGE_TOOL, APP_TOOL_PERMISSION_TOOL } from "./appMcp";
import { chatParts } from "./chat/test/chatParts";
import { applyPreparedPermissionChange, preparePermissionChange } from "./chat/approvals/permissionGrants";
import { participantPermissionPolicy } from "./chat/turns/promptSections";
import { chatAgentPermissionsEqual, defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import type {
  ChatAppToolApproval, ChatAppToolApprovalPolicy, ChatMessage, ChatParticipant, ChatToolPermissionRequest, Conversation
} from "../../shared/types";
import {
  chatConversation, chatParticipant, flushMicrotasks, NOW, pendingToolPermission, testService, toolPermissionActor, waitFor
} from "./chat/test/permissionFixtures";

test("permission normalization is idempotent and dedupes structured grants", () => {
  const raw = {
    repoRead: true,
    workspaceWrite: false,
    webAccess: false,
    shell: {
      enabled: true,
      rules: [
        { action: "allow", match: "prefix", pattern: "git diff" },
        { action: "allow", match: "prefix", pattern: "git diff" },
        { action: "ask", match: "exact", pattern: "npm test" }
      ]
    },
    manageRolesParticipants: "allow",
    providerNative: {
      "claude-code": {
        allowedTools: ["mcp__accord_agents__app_chat_read_messages", "mcp__accord_agents__app_chat_read_messages", "Read"]
      }
    }
  };

  const normalized = normalizeChatAgentPermissions(raw);

  assert.deepEqual(normalizeChatAgentPermissions(normalized), normalized);
  assert.deepEqual(normalized.shell.rules, [
    { action: "allow", match: "prefix", pattern: "git diff" },
    { action: "ask", match: "exact", pattern: "npm test" }
  ]);
  assert.deepEqual(normalized.providerNative?.["claude-code"]?.allowedTools, [
    "mcp__accord_agents__app_chat_read_messages",
    "Read"
  ]);
  assert.equal(normalized.manageRolesParticipants, "allow");
  assert.equal(normalized.requestCompaction, "ask");
  assert.equal(chatAgentPermissionsEqual(normalized, raw as never), true);
});

test("applyPreparedPermissionChange is the merge-additions path for shell rules and Claude native tools", () => {
  const service = testService().service as any;
  const participant = chatParticipant("claude-code", {
    shell: {
      enabled: true,
      rules: [{ action: "allow", match: "prefix", pattern: "git status" }]
    },
    providerNative: {
      "claude-code": {
        allowedTools: ["Read"]
      }
    }
  });
  const conversation = chatConversation([participant]);

  const shellPrepared = preparePermissionChange(participant, {
    kind: "shellRules",
    rules: [
      { action: "allow", match: "prefix", pattern: "git status" },
      { action: "allow", match: "prefix", pattern: "git diff" }
    ]
  });
  applyPreparedPermissionChange(conversation, participant.id, shellPrepared);

  const participantAfterShell = (conversation.metadata.participants as ChatParticipant[])[0];
  const nativePrepared = preparePermissionChange(participantAfterShell, {
    kind: "providerNative",
    provider: "claude-code",
    allowedTools: ["Read", "mcp__accord_agents__app_chat_read_messages"]
  });
  applyPreparedPermissionChange(conversation, participant.id, nativePrepared);

  const permissions = normalizeChatAgentPermissions((conversation.metadata.participants as ChatParticipant[])[0].permissions);
  assert.deepEqual(permissions.shell.rules, [
    { action: "allow", match: "prefix", pattern: "git status" },
    { action: "allow", match: "prefix", pattern: "git diff" }
  ]);
  assert.deepEqual(permissions.providerNative?.["claude-code"]?.allowedTools, [
    "Read",
    "mcp__accord_agents__app_chat_read_messages"
  ]);
});

test("provider-native and wildcard denylist validation rejects unsafe requests", () => {
  const service = testService().service as any;
  const codex = chatParticipant("codex-cli");
  const claude = chatParticipant("claude-code");

  assert.throws(() => preparePermissionChange(codex, {
    kind: "providerNative",
    provider: "claude-code",
    allowedTools: ["Read"]
  }), /only be approved for Claude Code members/);

  for (const token of ["Bash(*)", "*", "mcp__server__*"]) {
    assert.throws(() => preparePermissionChange(claude, {
      kind: "providerNative",
      provider: "claude-code",
      allowedTools: [token]
    }), /too broad/);
  }

  assert.throws(() => preparePermissionChange(claude, {
    kind: "shellRules",
    rules: [{ action: "allow", match: "prefix", pattern: "*" }]
  }), /too broad/);
});

test("repoRead is a portable permission grant", () => {
  const service = testService().service as any;
  const participant = chatParticipant("claude-code", { repoRead: false });
  const conversation = chatConversation([participant]);

  const prepared = preparePermissionChange(participant, {
    kind: "portable",
    permissions: ["repoRead"]
  });
  applyPreparedPermissionChange(conversation, participant.id, prepared);

  const permissions = normalizeChatAgentPermissions((conversation.metadata.participants as ChatParticipant[])[0].permissions);
  assert.equal(permissions.repoRead, true);
  assert.equal(prepared.summary.includes("repository read access"), true);
});

test("structured permission request creates exactly one approval card", async () => {
  const participant = chatParticipant("claude-code", { webAccess: false });
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });

  const result = await service.requestPermissionChangeFromTool({
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 0,
    capabilities: ["permissions.request"],
    runId: "run-42",
    triggerMessageId: "user-message"
  }, {
    kind: "portable",
    permissions: ["webAccess"],
    reason: "Need live web lookup to answer this request."
  });

  assert.equal(result.status, "pending_user_approval");

  const approvals = (storage.current.metadata.pendingAppToolApprovals as ChatAppToolApproval[]).filter(
    (approval) => approval.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL
  );
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].status, "pending");
  assert.deepEqual(approvals[0].request, {
    kind: "portable",
    reason: "Need live web lookup to answer this request.",
    permissions: ["webAccess"]
  });
  assert.equal(approvals[0].resumeContext?.runId, "run-42");
  assert.equal(approvals[0].resumeContext?.triggerMessageId, "user-message");
});

test("permission request has stable requestId and idempotent replay after approval", async () => {
  const participant = chatParticipant("claude-code", { webAccess: false });
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 0,
    capabilities: ["permissions.request" as const],
    runId: "remote-run-1",
    triggerMessageId: "user-message",
    runPermissions: defaultChatAgentPermissions()
  };
  const request = {
    kind: "portable",
    permissions: ["webAccess"],
    reason: "Need live web lookup from the remote worker."
  };

  const first = await service.requestPermissionChangeFromTool(actor, request);
  assert.equal(first.status, "pending_user_approval");
  assert.equal(typeof first.requestId, "string");
  assert.equal(first.requestId, first.approvalId);

  const duplicate = await service.requestPermissionChangeFromTool(actor, request);
  assert.equal(duplicate.status, "pending_user_approval");
  assert.equal(duplicate.requestId, first.requestId);
  assert.equal(
    ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[])
      .filter((approval) => approval.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL).length,
    1
  );
  assert.equal(
    storage.current.messages.filter((message: ChatMessage) => message.content.startsWith("Permission approval needed")).length,
    1
  );

  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: first.requestId ?? "",
    approve: true,
    scope: "once"
  });

  const lookup = await service.requestPermissionChangeFromTool(actor, { requestId: first.requestId });
  assert.equal(lookup.status, "approved");
  assert.equal(lookup.requestId, first.requestId);
  assert.equal(lookup.approvalScope, "once");

  const replayAfterDecision = await service.requestPermissionChangeFromTool(actor, request);
  assert.equal(replayAfterDecision.status, "approved");
  assert.equal(replayAfterDecision.requestId, first.requestId);
  assert.equal(
    ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[])
      .filter((approval) => approval.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL).length,
    1
  );
});

test("permission request status lookup returns denied decisions idempotently", async () => {
  const participant = chatParticipant("claude-code", { webAccess: false });
  const conversation = chatConversation([participant]);
  const { service } = testService({ conversation });
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 0,
    capabilities: ["permissions.request" as const],
    runId: "remote-run-2",
    triggerMessageId: "user-message",
    runPermissions: defaultChatAgentPermissions()
  };

  const pending = await service.requestPermissionChangeFromTool(actor, {
    kind: "portable",
    permissions: ["webAccess"]
  });
  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: pending.requestId ?? "",
    approve: false
  });

  const lookup = await service.requestPermissionChangeFromTool(actor, { requestId: pending.requestId });
  assert.equal(lookup.status, "denied");
  assert.equal(lookup.requestId, pending.requestId);
});

test("permission request status lookup is scoped to the actor run", async () => {
  const participant = chatParticipant("claude-code", { webAccess: false });
  const conversation = chatConversation([participant]);
  const { service } = testService({ conversation });
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 0,
    capabilities: ["permissions.request" as const],
    runId: "remote-run-a",
    triggerMessageId: "user-message",
    runPermissions: defaultChatAgentPermissions()
  };

  const pending = await service.requestPermissionChangeFromTool(actor, {
    kind: "portable",
    permissions: ["webAccess"]
  });
  const otherRunLookup = await service.requestPermissionChangeFromTool({
    ...actor,
    runId: "remote-run-b"
  }, {
    requestId: pending.requestId
  });

  assert.equal(otherRunLookup.ok, false);
  assert.equal(otherRunLookup.status, "not_found");
  assert.equal(otherRunLookup.requestId, pending.requestId);
});

test("permission request already_granted uses run-scoped permissions when present", async () => {
  const participant = {
    ...chatParticipant("codex-cli", { webAccess: true }),
    agentMode: "auto" as const
  };
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });

  const result = await service.requestPermissionChangeFromTool({
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 0,
    capabilities: ["permissions.request"],
    runId: "remote-run-3",
    triggerMessageId: "user-message",
    runPermissions: defaultChatAgentPermissions()
  }, {
    kind: "portable",
    permissions: ["webAccess"]
  });

  assert.equal(result.status, "pending_user_approval");
  assert.equal(
    ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[])
      .filter((approval) => approval.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL).length,
    1
  );
});

test("permission request returns already_granted when run-scoped permissions cover it", async () => {
  const participant = chatParticipant("claude-code", { webAccess: false });
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });

  const result = await service.requestPermissionChangeFromTool({
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 0,
    capabilities: ["permissions.request"],
    runId: "remote-run-4",
    triggerMessageId: "user-message",
    runPermissions: { ...defaultChatAgentPermissions(), webAccess: true }
  }, {
    kind: "portable",
    permissions: ["webAccess"]
  });

  assert.equal(result.status, "already_granted");
  assert.equal(
    ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[])
      .filter((approval) => approval.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL).length,
    0
  );
});

test("tool permission request waits for user approval and returns allow once", async () => {
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });

  const pending = service.requestToolPermissionFromTool({
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 0,
    capabilities: ["permissions.request"],
    runId: "run-42",
    triggerMessageId: "user-message"
  }, {
    tool_name: "mcp__slack__slack_send_message",
    input: { channel_id: "C1", text: "Ship it" },
    reason: "Send the approved update."
  });

  await waitFor(() =>
    ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).some(
      (approval) => approval.toolName === APP_TOOL_PERMISSION_TOOL && approval.status === "pending"
    )
  );
  const approval = ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).find(
    (item) => item.toolName === APP_TOOL_PERMISSION_TOOL
  )!;
  assert.deepEqual(approval.request, {
    kind: "toolPermission",
    agentMode: "default",
    reason: "Send the approved update.",
    toolName: "mcp__slack__slack_send_message",
    toolInput: { channel_id: "C1", text: "Ship it" }
  });

  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: approval.id,
    approve: true,
    scope: "once"
  });

  assert.deepEqual(await pending, {
    behavior: "allow",
    updatedInput: { channel_id: "C1", text: "Ship it" }
  });
  const updatedApproval = ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).find(
    (item) => item.id === approval.id
  )!;
  assert.equal(updatedApproval.status, "approved");
  assert.equal(updatedApproval.approvalScope, "once");
});

test("tool permission chat approval reuses policy for the same participant and tool", async () => {
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant], {
    participantSessions: [{ participantId: participant.id, participantAgentMode: "auto" }]
  });
  const { service, storage } = testService({ conversation });
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 0,
    capabilities: ["permissions.request" as const],
    agentMode: "default" as const,
    runId: "run-42",
    triggerMessageId: "user-message"
  };

  const pending = service.requestToolPermissionFromTool(actor, {
    tool_name: "mcp__atlassian__search",
    input: { query: "roadmap" }
  });
  await waitFor(() =>
    ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).some(
      (approval) => approval.toolName === APP_TOOL_PERMISSION_TOOL && approval.status === "pending"
    )
  );
  const approval = ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).find(
    (item) => item.toolName === APP_TOOL_PERMISSION_TOOL
  )!;
  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: approval.id,
    approve: true,
    scope: "chat"
  });
  assert.deepEqual(await pending, {
    behavior: "allow",
    updatedInput: { query: "roadmap" }
  });

  const second = await service.requestToolPermissionFromTool({
    ...actor,
    runId: "run-43"
  }, {
    tool_name: "mcp__atlassian__search",
    input: { query: "incidents" }
  });

  assert.deepEqual(second, {
    behavior: "allow",
    updatedInput: { query: "incidents" }
  });
  const toolApprovals = ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).filter(
    (item) => item.toolName === APP_TOOL_PERMISSION_TOOL
  );
  assert.equal(toolApprovals.length, 1);
  assert.equal(((storage.current.metadata.appToolApprovalPolicies ?? []) as ChatAppToolApprovalPolicy[])[0].targetToolName, "mcp__atlassian__search");
});

test("a permission card whose Claude Code call ended (it stopped waiting) is expired, and an answer to it does nothing", async () => {
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  const abandoned = new AbortController();
  const pending = service.requestToolPermissionFromTool(toolPermissionActor(participant, conversation), {
    tool_name: "Bash", input: { command: "date > /tmp/stamp.txt" }, tool_use_id: "toolu_1"
  }, abandoned.signal);
  const card = await pendingToolPermission(storage, "Bash");
  abandoned.abort();
  const result = await pending;
  assert.equal(result.behavior, "deny");
  const expired = ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).find((item) => item.id === card.id)!;
  assert.equal(expired.status, "expired", "not shown as waiting, and not as the User's denial");
  assert.match(expired.error ?? "", /stopped waiting/);
  await assert.rejects(
    service.respondToAppToolApproval({ conversationId: conversation.id, approvalId: card.id, approve: true, scope: "once" }),
    /already been answered/
  );
});

test("while the same tool call asked again still waits on its card, the first call ending leaves the card open for it", async () => {
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  const actor = toolPermissionActor(participant, conversation);
  const request = { tool_name: "Bash", input: { command: "ls /tmp" }, tool_use_id: "toolu_same" };
  const firstGone = new AbortController();
  const first = service.requestToolPermissionFromTool(actor, request, firstGone.signal);
  const card = await pendingToolPermission(storage, "Bash");
  const second = service.requestToolPermissionFromTool(actor, request);
  await waitFor(() => (chatParts(service).toolPermissions.toolPermissionWaiters.get(card.id) ?? 0) === 2);
  firstGone.abort();
  assert.equal((await first).behavior, "deny");
  const open = ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).find((item) => item.id === card.id)!;
  assert.equal(open.status, "pending", "still waited on");
  await service.respondToAppToolApproval({ conversationId: conversation.id, approvalId: card.id, approve: true, scope: "once" });
  assert.equal((await second).behavior, "allow", "the call still waiting gets the answer");
});

test("an answer to a permission card no call waits on any more (the app restarted) expires it instead of doing nothing", async () => {
  const participant = chatParticipant("claude-code");
  const orphan: ChatAppToolApproval = {
    id: "orphan-1", conversationId: "conversation-1", requesterParticipantId: participant.id, requesterHandle: participant.handle,
    requesterRoleConfigId: participant.roleConfigId, toolName: APP_TOOL_PERMISSION_TOOL, capability: "permissions.request",
    request: { kind: "toolPermission", agentMode: "default", toolName: "Bash", toolInput: { command: "ls" } },
    summary: "Use Bash", status: "pending", createdAt: NOW, updatedAt: NOW,
    resumeContext: { runId: "old-run", triggerMessageId: "user-message" }
  } as ChatAppToolApproval;
  const conversation = chatConversation([participant], { pendingAppToolApprovals: [orphan] });
  const { service, storage } = testService({ conversation });
  await assert.rejects(
    service.respondToAppToolApproval({ conversationId: conversation.id, approvalId: orphan.id, approve: true, scope: "once" }),
    /Nothing is waiting for this answer/,
    "refused, never reported as applied"
  );
  const after = ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).find((item) => item.id === orphan.id)!;
  assert.equal(after.status, "expired");
  assert.match(after.error ?? "", /Nothing is waiting for this answer/);
});

test("Allow for this chat on a Bash card covers the command prefixes, as Claude Code's \"don't ask again\" does: another command still asks", async () => {
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  const actor = toolPermissionActor(participant, conversation);
  const first = service.requestToolPermissionFromTool(actor, {
    tool_name: "Bash", input: { command: "mkdir -p /tmp/aa && git status" }, tool_use_id: "toolu_a"
  });
  const card = await pendingToolPermission(storage, "Bash");
  assert.deepEqual((card.request as ChatToolPermissionRequest).chatScope, { kind: "commands", prefixes: ["mkdir", "git status"] });
  await service.respondToAppToolApproval({ conversationId: conversation.id, approvalId: card.id, approve: true, scope: "chat" });
  assert.equal((await first).behavior, "allow");
  const rules = (storage.current.metadata.appToolApprovalPolicies ?? []) as ChatAppToolApprovalPolicy[];
  assert.deepEqual(rules.map((rule) => [rule.targetToolName, rule.targetToolScope]), [["Bash", { kind: "commands", prefixes: ["mkdir", "git status"] }]]);
  assert.ok(storage.current.messages.some((message: ChatMessage) => message.content === `Allowed @${participant.handle} to run mkdir and git status commands for this chat.`));

  // The same prefixes: unasked.
  const again = await service.requestToolPermissionFromTool({ ...actor, runId: "run-43" }, {
    tool_name: "Bash", input: { command: "mkdir /tmp/bb" }, tool_use_id: "toolu_b"
  });
  assert.equal(again.behavior, "allow");
  // Another command: a card, not a free pass for every command.
  const abandoned = new AbortController();
  const other = service.requestToolPermissionFromTool({ ...actor, runId: "run-44" }, {
    tool_name: "Bash", input: { command: "rm -rf /tmp/aa" }, tool_use_id: "toolu_c"
  }, abandoned.signal);
  const asked = await pendingToolPermission(storage, "Bash");
  assert.notEqual(asked.id, card.id);
  abandoned.abort();
  await other;

  // WebFetch: the domain.
  const fetch = service.requestToolPermissionFromTool({ ...actor, runId: "run-45" }, {
    tool_name: "WebFetch", input: { url: "https://docs.example.com/a" }, tool_use_id: "toolu_d"
  });
  const fetchCard = await pendingToolPermission(storage, "WebFetch");
  await service.respondToAppToolApproval({ conversationId: conversation.id, approvalId: fetchCard.id, approve: true, scope: "chat" });
  await fetch;
  assert.equal((await service.requestToolPermissionFromTool({ ...actor, runId: "run-46" }, {
    tool_name: "WebFetch", input: { url: "https://docs.example.com/b" }, tool_use_id: "toolu_e"
  })).behavior, "allow");
  const otherSite = new AbortController();
  const elsewhere = service.requestToolPermissionFromTool({ ...actor, runId: "run-47" }, {
    tool_name: "WebFetch", input: { url: "https://example.org/" }, tool_use_id: "toolu_f"
  }, otherSite.signal);
  assert.notEqual((await pendingToolPermission(storage, "WebFetch")).id, fetchCard.id, "another domain asks");
  otherSite.abort();
  await elsewhere;
});

test("a rule for edits in a folder does not cover a link in it that leads out of it", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "aa-edit-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inside = path.join(root, "work");
  const outside = path.join(root, "elsewhere");
  await mkdir(inside, { recursive: true });
  await mkdir(outside, { recursive: true });
  await symlink(outside, path.join(inside, "out"));
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  const actor = toolPermissionActor(participant, conversation);
  const first = service.requestToolPermissionFromTool(actor, { tool_name: "Write", input: { file_path: path.join(inside, "a.txt"), content: "x" }, tool_use_id: "toolu_w1" });
  const card = await pendingToolPermission(storage, "Write");
  assert.deepEqual((card.request as ChatToolPermissionRequest).chatScope, { kind: "folder", path: inside });
  await service.respondToAppToolApproval({ conversationId: conversation.id, approvalId: card.id, approve: true, scope: "chat" });
  await first;
  assert.equal((await service.requestToolPermissionFromTool({ ...actor, runId: "run-e2" }, {
    tool_name: "Edit", input: { file_path: path.join(inside, "b.txt"), old_string: "a", new_string: "b" }, tool_use_id: "toolu_w2"
  })).behavior, "allow", "another edit in the folder");
  const abandoned = new AbortController();
  const viaLink = service.requestToolPermissionFromTool({ ...actor, runId: "run-e3" }, {
    tool_name: "Write", input: { file_path: path.join(inside, "out", "c.txt"), content: "x" }, tool_use_id: "toolu_w3"
  }, abandoned.signal);
  assert.notEqual((await pendingToolPermission(storage, "Write")).id, card.id, "asked: it lands outside the folder");
  abandoned.abort();
  await viaLink;
});

test("a Bash card the app cannot scope is allowed once even when answered for the chat; a rule kept from before still covers its tool", async () => {
  const participant = chatParticipant("claude-code");
  const legacy: ChatAppToolApprovalPolicy = {
    id: "legacy", participantId: participant.id, roleConfigId: participant.roleConfigId, toolName: APP_TOOL_PERMISSION_TOOL,
    capability: "permissions.request", targetToolName: "WebSearch", scope: "chat", createdAt: NOW, updatedAt: NOW
  };
  const conversation = chatConversation([participant], { appToolApprovalPolicies: [legacy] });
  const { service, storage } = testService({ conversation });
  const actor = toolPermissionActor(participant, conversation);
  const opaque = service.requestToolPermissionFromTool(actor, { tool_name: "Bash", input: { command: "echo $(whoami)" }, tool_use_id: "toolu_x" });
  const card = await pendingToolPermission(storage, "Bash");
  assert.equal((card.request as ChatToolPermissionRequest).chatScope, undefined);
  await service.respondToAppToolApproval({ conversationId: conversation.id, approvalId: card.id, approve: true, scope: "chat" });
  assert.equal((await opaque).behavior, "allow");
  assert.equal(((storage.current.metadata.appToolApprovalPolicies ?? []) as ChatAppToolApprovalPolicy[]).length, 1, "no rule for the whole of Bash");
  assert.equal((await service.requestToolPermissionFromTool({ ...actor, runId: "run-9" }, { tool_name: "WebSearch", input: { query: "x" } })).behavior, "allow");
});

test("tool permission retries deduplicate one native occurrence and replay its durable decision", async () => {
  const participant = { ...chatParticipant("claude-code"), agentMode: "auto" as const };
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 0,
    capabilities: ["permissions.request" as const],
    agentMode: "auto" as const,
    runId: "run-retry",
    triggerMessageId: "user-message"
  };
  const request = {
    tool_name: "Write",
    tool_use_id: "toolu_same_occurrence",
    input: { file_path: "/repo/retry.txt", content: "safe" }
  };

  const first = service.requestToolPermissionFromTool(actor, request);
  const retry = service.requestToolPermissionFromTool(actor, request);
  await waitFor(() =>
    ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[])
      .filter((approval) => approval.toolName === APP_TOOL_PERMISSION_TOOL).length === 1
  );
  const approval = ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[])
    .find((item) => item.toolName === APP_TOOL_PERMISSION_TOOL)!;
  assert.equal((approval.request as { nativeOccurrenceId?: string }).nativeOccurrenceId, "toolu_same_occurrence");
  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: approval.id,
    approve: true,
    scope: "once"
  });
  const expected = {
    behavior: "allow",
    updatedInput: { file_path: "/repo/retry.txt", content: "safe" }
  };
  assert.deepEqual(await first, expected);
  assert.deepEqual(await retry, expected);

  assert.deepEqual(await service.requestToolPermissionFromTool(actor, request), expected);
  assert.equal(
    ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[])
      .filter((item) => item.toolName === APP_TOOL_PERMISSION_TOOL).length,
    1
  );
});

test("synthetic 20-total native prompt approval does not poison the next Auto run", async () => {
  const participant = { ...chatParticipant("claude-code"), agentMode: "auto" as const };
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 0,
    capabilities: ["permissions.request" as const],
    agentMode: "auto" as const,
    runId: "run-total-threshold",
    triggerMessageId: "user-total-threshold"
  };
  const atThreshold = service.requestToolPermissionFromTool(actor, {
    tool_name: "mcp__auto-mode-fixture__publish_private_repo",
    tool_use_id: "toolu_total_denial_20",
    input: {}
  });
  await waitFor(() =>
    ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[])
      .some((approval) => approval.status === "pending")
  );
  const thresholdApproval = ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[])
    .find((approval) => approval.status === "pending")!;
  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: thresholdApproval.id,
    approve: true,
    scope: "once"
  });
  assert.equal((await atThreshold).behavior, "allow");
  assert.deepEqual(storage.current.metadata.appToolApprovalPolicies ?? [], []);

  const nextRun = service.requestToolPermissionFromTool({
    ...actor,
    runId: "run-after-total-threshold",
    triggerMessageId: "user-after-total-threshold"
  }, {
    tool_name: "Write",
    tool_use_id: "toolu_after_total_threshold",
    input: { file_path: "/repo/after-total-threshold.txt", content: "safe" }
  });
  await waitFor(() =>
    ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[])
      .some((approval) => approval.status === "pending")
  );
  const nextApproval = ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[])
    .find((approval) => approval.status === "pending")!;
  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: nextApproval.id,
    approve: true,
    scope: "once"
  });
  assert.equal((await nextRun).behavior, "allow");
  assert.deepEqual(storage.current.metadata.appToolApprovalPolicies ?? [], []);
});

test("identical tool inputs with different native occurrence ids remain distinct", async () => {
  const participant = { ...chatParticipant("claude-code"), agentMode: "auto" as const };
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 0,
    capabilities: ["permissions.request" as const],
    agentMode: "auto" as const,
    runId: "run-distinct",
    triggerMessageId: "user-message"
  };
  const input = { file_path: "/repo/same.txt", content: "same" };
  const first = service.requestToolPermissionFromTool(actor, {
    tool_name: "Write",
    tool_use_id: "toolu_first",
    input
  });
  const second = service.requestToolPermissionFromTool(actor, {
    tool_name: "Write",
    tool_use_id: "toolu_second",
    input
  });
  await waitFor(() =>
    ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[])
      .filter((approval) => approval.toolName === APP_TOOL_PERMISSION_TOOL).length === 2
  );
  const approvals = ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[])
    .filter((item) => item.toolName === APP_TOOL_PERMISSION_TOOL);
  assert.deepEqual(
    approvals.map((approval) => (approval.request as { nativeOccurrenceId?: string }).nativeOccurrenceId).sort(),
    ["toolu_first", "toolu_second"]
  );
  for (const approval of approvals) {
    await service.respondToAppToolApproval({
      conversationId: conversation.id,
      approvalId: approval.id,
      approve: false
    });
  }
  assert.equal((await first).behavior, "deny");
  assert.equal((await second).behavior, "deny");
});

test("tool permission creation preserves an overlapping queued chat mutation", async () => {
  const participant = { ...chatParticipant("claude-code"), agentMode: "auto" as const };
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  const concurrentConversation = await storage.getConversation(conversation.id) as Conversation;
  let releaseMutation!: () => void;
  let markMutationStarted!: () => void;
  const mutationStarted = new Promise<void>((resolve) => { markMutationStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseMutation = resolve; });
  const concurrentMutation = chatParts(service).store.withChatMutation(concurrentConversation, async () => {
    markMutationStarted();
    await release;
    concurrentConversation.messages.push({
      id: "concurrent-message",
      role: "system",
      content: "Concurrent state survives.",
      createdAt: NOW,
      status: "done"
    });
    await chatParts(service).store.saveConversation(concurrentConversation);
  });
  await mutationStarted;

  const pending = service.requestToolPermissionFromTool({
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 0,
    capabilities: ["permissions.request"],
    agentMode: "auto",
    runId: "run-concurrent",
    triggerMessageId: "user-message"
  }, {
    tool_name: "Write",
    tool_use_id: "toolu_concurrent",
    input: { file_path: "/repo/concurrent.txt", content: "safe" }
  });
  releaseMutation();
  await concurrentMutation;
  await waitFor(() =>
    ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[])
      .some((approval) => approval.status === "pending")
  );
  assert.ok(storage.current.messages.some((message: ChatMessage) => message.id === "concurrent-message"));
  const approval = ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[])
    .find((item) => item.status === "pending")!;
  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: approval.id,
    approve: false
  });
  assert.equal((await pending).behavior, "deny");
  assert.ok(storage.current.messages.some((message: ChatMessage) => message.id === "concurrent-message"));
});

test("tool permission diagnostics omit native input, reason, and occurrence id", async () => {
  const participant = { ...chatParticipant("claude-code"), agentMode: "auto" as const };
  const conversation = chatConversation([participant]);
  const { service, storage, debugEvents } = testService({ conversation });
  const secret = "CANARY_PRIVATE_INPUT";
  const pending = service.requestToolPermissionFromTool({
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 0,
    capabilities: ["permissions.request"],
    agentMode: "auto",
    runId: "run-diagnostics",
    triggerMessageId: "user-message"
  }, {
    tool_name: "Write",
    tool_use_id: `toolu_${secret}`,
    input: { file_path: `/repo/${secret}.txt`, content: secret },
    reason: secret
  });
  await waitFor(() =>
    ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[])
      .some((approval) => approval.status === "pending")
  );
  const approval = ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[])
    .find((item) => item.status === "pending")!;
  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: approval.id,
    approve: false
  });
  await pending;

  const bridgeEvents = debugEvents.filter((event) => event.event.startsWith("chat.claude.permission-prompt."));
  assert.deepEqual(bridgeEvents.map((event) => event.event), [
    "chat.claude.permission-prompt.invoked",
    "chat.claude.permission-prompt.resolved"
  ]);
  assert.equal(JSON.stringify(bridgeEvents).includes(secret), false);
  assert.equal(bridgeEvents.every((event) => event.payload.nativeOccurrenceIdPresent === true), true);
});

test("tool permission request denies and marks approval when run is cancelled", async () => {
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  const runController = new AbortController();
  chatParts(service).activeRuns.registerTargetRun("run-42", runController, {
    conversationId: conversation.id,
    participantId: participant.id,
    participantHandle: participant.handle
  });

  const pending = service.requestToolPermissionFromTool({
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 0,
    capabilities: ["permissions.request"],
    runId: "run-42",
    triggerMessageId: "user-message"
  }, {
    tool_name: "mcp__slack__slack_send_message",
    input: { channel_id: "C1", text: "Ship it" }
  });

  await waitFor(() =>
    ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).some(
      (approval) => approval.toolName === APP_TOOL_PERMISSION_TOOL && approval.status === "pending"
    )
  );

  assert.equal(service.cancelRun("run-42"), true);
  assert.deepEqual(await pending, {
    behavior: "deny",
    message: "Tool permission request was cancelled because the chat run stopped."
  });
  const approval = ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).find(
    (item) => item.toolName === APP_TOOL_PERMISSION_TOOL
  )!;
  assert.equal(approval.status, "denied");
  assert.equal(approval.error, "Tool permission request was cancelled because the chat run stopped.");
});

test("tool permission request denies and marks approval on timeout", async (t) => {
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  (t.mock.timers as any).enable(["setTimeout"]);
  try {
    const pending = service.requestToolPermissionFromTool({
      conversationId: conversation.id,
      participantId: participant.id,
      roleConfigId: participant.roleConfigId,
      roleConfigVersion: 0,
      capabilities: ["permissions.request"],
      runId: "run-42",
      triggerMessageId: "user-message"
    }, {
      tool_name: "mcp__atlassian__search",
      input: { query: "incidents" }
    });

    // Timers are mocked for the 30-minute timeout; the request's own short
    // waits (its save) need the clock to move a little before it is stored.
    const findApproval = () => ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).find(
      (item) => item.toolName === APP_TOOL_PERMISSION_TOOL
    );
    for (let index = 0; index < 50 && !findApproval(); index += 1) {
      (t.mock.timers as any).tick(1);
      await flushMicrotasks();
    }
    const approval = findApproval();
    assert.equal(approval?.status, "pending");
    for (let index = 0; index < 20 && !chatParts(service).toolPermissions.toolPermissionResolvers.has(approval?.id); index += 1) {
      await Promise.resolve();
    }
    assert.equal(chatParts(service).toolPermissions.toolPermissionResolvers.has(approval?.id), true);

    (t.mock.timers as any).tick(30 * 60_000);
    assert.deepEqual(await pending, {
      behavior: "deny",
      message: "Timed out waiting for User approval."
    });
    const updatedApproval = ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).find(
      (item) => item.toolName === APP_TOOL_PERMISSION_TOOL
    )!;
    assert.equal(updatedApproval.status, "denied");
    assert.equal(updatedApproval.error, "Timed out waiting for User approval.");
  } finally {
    (t.mock.timers as any).reset();
  }
});

test("participantPermissionPolicy uses explanation fallback when permission requests are unavailable", () => {
  const { service } = testService();
  const prompt = participantPermissionPolicy("claude-code", "default", defaultChatAgentPermissions(), false);

  assert.match(prompt, /explain the specific command and shell rule needed before refusing/);
  assert.match(prompt, /explain that `workspaceWrite` is needed before refusing/);
  assert.match(prompt, /explain that `webAccess` is needed before refusing/);
  assert.doesNotMatch(prompt, /app_permissions_request_change/);
});
