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

test("repoRead is a portable permission grant", () => {
  const service = testService().service as any;
  const participant = chatParticipant("claude-code", { repoRead: false });
  const conversation = chatConversation([participant]);

  const prepared = service.preparePermissionChange(participant, {
    kind: "portable",
    permissions: ["repoRead"]
  });
  service.applyPreparedPermissionChange(conversation, participant.id, prepared);

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
  assert.equal(saved.metadata.running, false);
  assert.equal(saved.metadata.runId, undefined);
  assert.equal(batch?.status, "answered");
  assert.equal(batch?.items[0].status, "answered");
  assert.equal(batch?.items[0].replyMessageId, reply?.id);
  assert.equal(saved.metadata.pendingAppToolApprovals[0].consumedAt.length > 0, true);
  assert.equal(progressEvents[0]?.runId, "blocked-run");
  assert.equal(progressEvents[0]?.phase, "initial");
  assert.equal(progressEvents.some((event) => event.agentProgress?.state === "running"), true);
  assert.equal(progressEvents.at(-1)?.phase, "done");
});

test("permission resume clears running and emits terminal error when resumed participant fails", async () => {
  const participant = chatParticipant("claude-code");
  const approval = permissionApproval(participant, {
    kind: "shellRules",
    rules: [{ action: "allow", match: "prefix", pattern: "git diff" }]
  }, {
    approvalScope: "once",
    status: "approved",
    resumeContext: {
      runId: "blocked-run",
      triggerMessageId: "user-message"
    }
  });
  const conversation = chatConversation([participant], { pendingAppToolApprovals: [approval] });
  const progressEvents: Array<{ runId: string; phase: string; message: string }> = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async () => {
      throw new Error("resume exploded");
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  await assert.rejects(
    () => (service as any).autoResumePermissionApproval(
      conversation.id,
      approval.id,
      (progress: typeof progressEvents[number]) => {
        progressEvents.push(progress);
      }
    ),
    /resume exploded/
  );

  assert.equal(storage.current.metadata.running, false);
  assert.equal(storage.current.metadata.runId, undefined);
  assert.equal(progressEvents.some((item) => item.phase === "error" && item.message === "resume exploded"), true);
});

test("permission resume registers a cancellable chat run controller", async () => {
  const participant = chatParticipant("claude-code");
  const approval = permissionApproval(participant, {
    kind: "shellRules",
    rules: [{ action: "allow", match: "prefix", pattern: "git diff" }]
  }, {
    approvalScope: "once",
    status: "approved",
    resumeContext: {
      runId: "blocked-run",
      triggerMessageId: "user-message"
    }
  });
  const conversation = chatConversation([participant], { pendingAppToolApprovals: [approval] });
  let capturedSignal: AbortSignal | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant, _prompt, _repoPath, _diffMode, _kind, signal: AbortSignal | undefined) => {
      capturedSignal = signal;
      markStarted();
      await new Promise<void>((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        participant: runParticipant,
        ok: false,
        content: "",
        error: "cancelled",
        durationMs: 1,
        sessionId: "session-1"
      };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  const resume = (service as any).autoResumePermissionApproval(conversation.id, approval.id);
  await started;

  assert.equal(service.cancelRun("blocked-run"), true);
  await resume;

  assert.equal(capturedSignal?.aborted, true);
  assert.equal(storage.current.metadata.running, false);
  assert.equal(storage.current.metadata.runId, undefined);
});

test("duplicate chat run ids stay active until every owner ends", async () => {
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });

  await (service as any).beginChatRun(conversation, "shared-run");
  await (service as any).beginChatRun(conversation, "shared-run");
  await (service as any).endChatRun(conversation, "shared-run");

  assert.deepEqual(storage.current.metadata.activeRunIds, ["shared-run"]);
  assert.equal(storage.current.metadata.running, true);

  await (service as any).endChatRun(conversation, "shared-run");

  assert.equal(storage.current.metadata.activeRunIds, undefined);
  assert.equal(storage.current.metadata.running, false);
});

test("participant prose mentioning blocked permissions does not create approval cards", () => {
  const participant = chatParticipant("claude-code", {
    repoRead: false,
    workspaceWrite: false,
    webAccess: false
  });
  const conversation = chatConversation([participant]);
  const { service } = testService({ conversation });

  const replies: any[] = [
    {
      id: "reply-1",
      role: "participant",
      participantId: participant.id,
      content: "I can't do that here - I need workspace edit access to save the file.",
      createdAt: NOW,
      status: "done",
      metadata: {
        threadId: "thread-1",
        sourceMessageId: "user-message"
      }
    },
    {
      id: "reply-2",
      role: "participant",
      participantId: participant.id,
      content: "I cannot edit files until write access is approved. A grant file editing card would be needed in older builds.",
      createdAt: NOW,
      status: "done",
      metadata: {
        threadId: "thread-1",
        sourceMessageId: "user-message"
      }
    },
    {
      id: "reply-3",
      role: "participant",
      participantId: participant.id,
      content: "Need web access and repository read permission to continue.",
      createdAt: NOW,
      status: "done",
      metadata: {
        threadId: "thread-1",
        sourceMessageId: "user-message"
      }
    }
  ];

  (service as any).appendParticipantTurnMessages(conversation, participant, replies);

  const approvals = ((conversation.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).filter(
    (item) => item.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL
  );
  assert.equal(approvals.length, 0);
  assert.equal(conversation.messages.some((message) => message.content.includes("Permission approval needed")), false);
});

test("internal-mechanics phrasing in a draft is delivered as-is without retry", async () => {
  const participant = chatParticipant("claude-code", { workspaceWrite: false });
  const conversation = chatConversation([participant]);
  let runCount = 0;
  const draft = "The write tool is not enabled, so I cannot edit the file here.";
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant) => {
      runCount += 1;
      return {
        participant: runParticipant,
        ok: true,
        content: draft,
        durationMs: 1
      };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  const result = await service.sendMessage({
    conversationId: conversation.id,
    runId: "no-retry-run",
    content: "@drew please update the file"
  });

  assert.equal(
    result.warnings.some((warning) =>
      warning.includes("rejected response that mentioned") ||
      warning.includes("blocked") ||
      warning.includes("Blocked")
    ),
    false
  );
  await waitFor(() => runCount === 1 && storage.current.messages.some(
    (message: Conversation["messages"][number]) => message.role === "participant" && message.content === draft
  ));
  const participantMessage = storage.current.messages.find(
    (message: Conversation["messages"][number]) => message.role === "participant"
  );
  assert.equal(participantMessage?.content, draft);
  assert.equal(participantMessage?.status, "done");
  const approvals = ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).filter(
    (item) => item.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL
  );
  assert.equal(approvals.length, 0);
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

test("participantPermissionPolicy guides blocked capabilities to request before refusing", () => {
  const { service } = testService();
  const prompt = (service as any).participantPermissionPolicy("default", defaultChatAgentPermissions(), true);

  assert.match(prompt, /Shell commands are blocked for this turn/);
  assert.match(prompt, /app_permissions_request_change.*shellRules/);
  assert.match(prompt, /Workspace file edits are blocked for this turn/);
  assert.match(prompt, /app_permissions_request_change.*workspaceWrite/);
  assert.match(prompt, /Web access is blocked for this turn/);
  assert.match(prompt, /app_permissions_request_change.*webAccess/);
  assert.doesNotMatch(prompt, /General shell commands are blocked/);
  assert.doesNotMatch(prompt, /Do not edit files/);
  assert.doesNotMatch(prompt, /Do not use web search/);
});

test("participantPermissionPolicy keeps explicit shell deny rules as hard stops", () => {
  const { service } = testService();
  const prompt = (service as any).participantPermissionPolicy("default", normalizeChatAgentPermissions({
    ...defaultChatAgentPermissions(),
    shell: {
      enabled: true,
      rules: [{ action: "deny", match: "exact", pattern: "rm -rf" }]
    }
  }), true);

  assert.match(prompt, /deny exact "rm -rf"/);
  assert.match(prompt, /Deny rules are strict hard stops for matching commands/);
  assert.match(prompt, /do not request escalation for commands that match a deny rule/);
  assert.match(prompt, /outside these rules/);
});

test("participantPermissionPolicy uses explanation fallback when permission requests are unavailable", () => {
  const { service } = testService();
  const prompt = (service as any).participantPermissionPolicy("default", defaultChatAgentPermissions(), false);

  assert.match(prompt, /explain the specific command and shell rule needed before refusing/);
  assert.match(prompt, /explain that `workspaceWrite` is needed before refusing/);
  assert.match(prompt, /explain that `webAccess` is needed before refusing/);
  assert.doesNotMatch(prompt, /app_permissions_request_change/);
});

test("participantPermissionPolicy guides blocked repoRead to request before refusing", () => {
  const { service } = testService();
  const prompt = (service as any).participantPermissionPolicy("default", normalizeChatAgentPermissions({
    ...defaultChatAgentPermissions(),
    repoRead: false
  }), true);

  assert.match(prompt, /repoRead/);
  assert.match(prompt, /app_permissions_request_change/);
});

test("participantPermissionPolicy does not suggest escalation for agent-mode masked shell and workspace grants", () => {
  const { service } = testService();
  const prompt = (service as any).participantPermissionPolicy("plan", normalizeChatAgentPermissions({
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

test("static chat instructions include structured participant request and reply guidance", () => {
  const { service } = testService();
  const instructions = (service as any).staticChatInstructions({
    roleAppToolCapabilities: ["participants.request", "permissions.request"]
  });

  assert.match(instructions, /use `app_chat_request_participants` rather than plain `@mentions`/);
  assert.match(instructions, /When replying to a participant request addressed to you, answer in the active thread/);
  assert.match(instructions, /if request matching is ambiguous, ask for clarification rather than guessing/);
  assert.doesNotMatch(instructions, /app_chat_reply_to_participant_request/);
});

function testService(options: {
  conversation?: Conversation;
  run?: (...args: any[]) => Promise<any>;
} = {}): { service: ChatService; storage: any; tempRoot: string } {
  const tempRoot = path.join(tmpdir(), "accordagents-chat-permissions-test");
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

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition.");
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
