import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { APP_PERMISSIONS_REQUEST_CHANGE_TOOL } from "./appMcp";
import { ChatService } from "./chat";
import {
  chatAgentPermissionsEqual,
  defaultChatAgentPermissions,
  normalizeChatAgentPermissions
} from "../../shared/agentPermissions";
import type {
  ChatAppToolApproval,
  ChatParticipant,
  ChatRoleConfig,
  Conversation,
  ParticipantConfig
} from "../../shared/types";

const NOW = "2026-05-17T12:00:00.000Z";

const ROLE: ChatRoleConfig = {
  id: "engineer",
  label: "Engineer",
  instructions: "Answer directly.",
  version: 1,
  appToolCapabilities: [],
  updatedAt: NOW
};

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
    providerNative: {
      "claude-code": {
        allowedTools: ["mcp__ai_consensus__app_chat_read_messages", "mcp__ai_consensus__app_chat_read_messages", "Read"]
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
    "mcp__ai_consensus__app_chat_read_messages",
    "Read"
  ]);
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

  const shellPrepared = service.preparePermissionChange(participant, {
    kind: "shellRules",
    rules: [
      { action: "allow", match: "prefix", pattern: "git status" },
      { action: "allow", match: "prefix", pattern: "git diff" }
    ]
  });
  service.applyPreparedPermissionChange(conversation, participant.id, shellPrepared);

  const participantAfterShell = (conversation.metadata.participants as ChatParticipant[])[0];
  const nativePrepared = service.preparePermissionChange(participantAfterShell, {
    kind: "providerNative",
    provider: "claude-code",
    allowedTools: ["Read", "mcp__ai_consensus__app_chat_read_messages"]
  });
  service.applyPreparedPermissionChange(conversation, participant.id, nativePrepared);

  const permissions = normalizeChatAgentPermissions((conversation.metadata.participants as ChatParticipant[])[0].permissions);
  assert.deepEqual(permissions.shell.rules, [
    { action: "allow", match: "prefix", pattern: "git status" },
    { action: "allow", match: "prefix", pattern: "git diff" }
  ]);
  assert.deepEqual(permissions.providerNative?.["claude-code"]?.allowedTools, [
    "Read",
    "mcp__ai_consensus__app_chat_read_messages"
  ]);
});

test("provider-native and wildcard denylist validation rejects unsafe requests", () => {
  const service = testService().service as any;
  const codex = chatParticipant("codex-cli");
  const claude = chatParticipant("claude-code");

  assert.throws(() => service.preparePermissionChange(codex, {
    kind: "providerNative",
    provider: "claude-code",
    allowedTools: ["Read"]
  }), /only be approved for Claude Code participants/);

  for (const token of ["Bash(*)", "*", "mcp__server__*"]) {
    assert.throws(() => service.preparePermissionChange(claude, {
      kind: "providerNative",
      provider: "claude-code",
      allowedTools: [token]
    }), /too broad/);
  }

  assert.throws(() => service.preparePermissionChange(claude, {
    kind: "shellRules",
    rules: [{ action: "allow", match: "prefix", pattern: "*" }]
  }), /too broad/);
});

test("one-time permission overlay is consumed after one run projection", () => {
  const service = testService().service as any;
  const participant = chatParticipant("claude-code");
  const approval = permissionApproval(participant, {
    kind: "shellRules",
    rules: [{ action: "allow", match: "prefix", pattern: "git diff" }]
  }, {
    approvalScope: "once",
    status: "approved"
  });
  const conversation = chatConversation([participant], { pendingAppToolApprovals: [approval] });
  const appliedIds: string[] = [];

  const projected = service.participantPermissionsForRun(conversation, participant, undefined, appliedIds);
  assert.equal(projected.shell.enabled, true);
  assert.deepEqual(projected.shell.rules, [{ action: "allow", match: "prefix", pattern: "git diff" }]);
  assert.deepEqual(appliedIds, [approval.id]);

  service.consumeOneTimePermissionApprovals(conversation, participant, appliedIds);
  const consumedApproval = (conversation.metadata.pendingAppToolApprovals as ChatAppToolApproval[])[0];
  assert.equal(Boolean(consumedApproval?.consumedAt), true);

  const after = service.participantPermissionsForRun(conversation, participant);
  assert.equal(after.shell.enabled, false);
  assert.deepEqual(after.shell.rules, []);
});

test("permission resume attaches resumed participant-request reply to the original batch", async () => {
  const runs: Array<{ participant: ParticipantConfig; options: any; prompt: string }> = [];
  const participant = chatParticipant("claude-code");
  const trigger = {
    id: "request-message",
    role: "system" as const,
    content: "@drew Run git diff.",
    createdAt: NOW,
    status: "done" as const,
    metadata: {
      threadId: "thread-1",
      participantRequest: {
        id: "batch-1",
        requesterParticipantId: "requester",
        requesterHandle: "codex",
        source: "mcp" as const,
        resumeRequester: false,
        status: "running" as const,
        depth: 1,
        createdAt: NOW,
        updatedAt: NOW,
        triggerMessageId: "user-message",
        items: [{
          targetParticipantId: participant.id,
          targetHandle: participant.handle,
          prompt: "Run git diff.",
          status: "running" as const,
          replyMessageId: "pending-reply",
          createdAt: NOW,
          updatedAt: NOW
        }]
      }
    }
  };
  const approval = permissionApproval(participant, {
    kind: "shellRules",
    rules: [{ action: "allow", match: "prefix", pattern: "git diff" }]
  }, {
    approvalScope: "once",
    status: "approved",
    resumeContext: {
      runId: "blocked-run",
      triggerMessageId: trigger.id,
      participantRequestBatchId: "batch-1"
    }
  });
  const conversation = chatConversation([participant], { pendingAppToolApprovals: [approval] });
  conversation.messages.push(trigger);
  const progressEvents: Array<{ runId: string; phase: string; message: string; agentProgress?: { state: string } }> = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant, prompt, _repoPath, _diffMode, _kind, _signal, options) => {
      runs.push({ participant: runParticipant, prompt, options });
      return {
        participant: runParticipant,
        ok: true,
        content: "Finished after approval.",
        durationMs: 1,
        sessionId: "session-1"
      };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  await (service as any).autoResumePermissionApproval(conversation.id, approval.id, (progress: typeof progressEvents[number]) => {
    progressEvents.push(progress);
  });

  assert.equal(runs.length, 1);
  assert.equal(runs[0].prompt.includes("Message ID: request-message"), true);
  assert.equal(runs[0].options.permissions.shell.enabled, true);
  assert.deepEqual(runs[0].options.permissions.shell.rules, [{ action: "allow", match: "prefix", pattern: "git diff" }]);
  const saved = storage.current;
  const batch = saved.messages.find((message: Conversation["messages"][number]) => message.id === trigger.id)?.metadata?.participantRequest;
  const reply = saved.messages.find((message: Conversation["messages"][number]) => message.content === "Finished after approval.");
  assert.equal(saved.metadata.runId, "blocked-run");
  assert.equal(batch?.status, "answered");
  assert.equal(batch?.items[0].status, "answered");
  assert.equal(batch?.items[0].replyMessageId, reply?.id);
  assert.equal(saved.metadata.pendingAppToolApprovals[0].consumedAt.length > 0, true);
  assert.equal(progressEvents[0]?.runId, "blocked-run");
  assert.equal(progressEvents[0]?.phase, "initial");
  assert.equal(progressEvents[0]?.agentProgress?.state, "running");
  assert.equal(progressEvents.at(-1)?.phase, "done");
});

test("approved permission without resumeContext does not auto-run", async () => {
  const runs: ParticipantConfig[] = [];
  const participant = chatParticipant("claude-code");
  const approval = permissionApproval(participant, {
    kind: "portable",
    permissions: ["webAccess"]
  }, {
    approvalScope: "once",
    status: "approved"
  });
  const conversation = chatConversation([participant], { pendingAppToolApprovals: [approval] });
  const { service } = testService({
    conversation,
    run: async (runParticipant) => {
      runs.push(runParticipant);
      return {
        participant: runParticipant,
        ok: true,
        content: "Unexpected run.",
        durationMs: 1
      };
    }
  });

  await (service as any).autoResumePermissionApproval(conversation.id, approval.id);

  assert.equal(runs.length, 0);
});

function testService(options: {
  conversation?: Conversation;
  run?: (...args: any[]) => Promise<any>;
} = {}): { service: ChatService; storage: any; tempRoot: string } {
  const tempRoot = path.join(tmpdir(), "ai-consensus-chat-permissions-test");
  const storage = {
    current: options.conversation ? clone(options.conversation) : undefined,
    async getConversation(id: string): Promise<Conversation | undefined> {
      return this.current?.id === id ? clone(this.current) : undefined;
    },
    async saveConversation(conversation: Conversation): Promise<void> {
      this.current = clone(conversation);
    }
  };
  const settings = {
    async getPublicSettings(): Promise<{ chatRoleConfigs: ChatRoleConfig[] }> {
      return { chatRoleConfigs: [ROLE] };
    }
  };
  const cliRunner = {
    async detectAgents(): Promise<[]> {
      return [];
    },
    run: options.run ?? (async (participant: ParticipantConfig) => ({
      participant,
      ok: true,
      content: "ok",
      durationMs: 1
    }))
  };
  const debugLogs = {
    async write(): Promise<void> {
      return undefined;
    }
  };
  return {
    service: new ChatService(storage as never, settings as never, cliRunner as never, debugLogs as never),
    storage,
    tempRoot
  };
}

function chatParticipant(
  kind: ChatParticipant["kind"],
  permissionPatch: Partial<ReturnType<typeof defaultChatAgentPermissions>> = {}
): ChatParticipant {
  const permissions = normalizeChatAgentPermissions({
    ...defaultChatAgentPermissions(),
    ...permissionPatch,
    shell: {
      ...defaultChatAgentPermissions().shell,
      ...permissionPatch.shell
    }
  });
  return {
    id: kind === "claude-code" ? "claude-participant" : "codex-participant",
    handle: kind === "claude-code" ? "drew" : "codex",
    roleConfigId: ROLE.id,
    kind,
    agentMode: "default",
    permissions
  };
}

function chatConversation(participants: ChatParticipant[], metadata: Record<string, any> = {}): Conversation {
  return {
    id: "conversation-1",
    title: "Test chat",
    kind: "chat",
    createdAt: NOW,
    updatedAt: NOW,
    messages: [{
      id: "user-message",
      role: "user",
      content: "Please help.",
      createdAt: NOW,
      status: "done"
    }],
    findings: [],
    metadata: {
      participants,
      ...metadata
    }
  };
}

function permissionApproval(
  participant: ChatParticipant,
  request: ChatAppToolApproval["request"],
  patch: Partial<ChatAppToolApproval> = {}
): ChatAppToolApproval {
  return {
    id: patch.id ?? "approval-1",
    conversationId: "conversation-1",
    requesterParticipantId: participant.id,
    requesterHandle: participant.handle,
    requesterRoleConfigId: participant.roleConfigId,
    toolName: APP_PERMISSIONS_REQUEST_CHANGE_TOOL,
    capability: "permissions.request",
    status: "pending",
    request,
    summary: "Grant permission",
    createdAt: NOW,
    updatedAt: NOW,
    ...patch
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
