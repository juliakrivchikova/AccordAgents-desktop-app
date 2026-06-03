import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { APP_CHAT_REACT_TOOL, APP_PERMISSIONS_REQUEST_CHANGE_TOOL, AppMcpService } from "./appMcp";
import { ChatService } from "./chat";
import {
  chatAgentPermissionsEqual,
  defaultChatAgentPermissions,
  effectiveChatAgentPermissionsForProvider,
  normalizeChatAgentPermissions
} from "../../shared/agentPermissions";
import { CHAT_BEHAVIOR_RULE_INSTRUCTIONS_MAX_CHARS } from "../../shared/chatBehaviorRules";
import type {
  ChatAppToolApproval,
  ChatBehaviorRuleConfig,
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
    allowedTools: ["Read", "mcp__accord_agents__app_chat_read_messages"]
  });
  service.applyPreparedPermissionChange(conversation, participant.id, nativePrepared);

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

test("auto mode treats in-preset permission requests as already granted", async () => {
  // The Auto-review launch profile already grants repo read / workspace write / web,
  // so an in-preset request must report already_granted instead of producing a
  // spurious auto-applied approval and an unnecessary session relaunch (C6).
  const runs: ParticipantConfig[] = [];
  const participant = chatParticipant("claude-code", { webAccess: false });
  participant.agentMode = "auto";
  const conversation = chatConversation([participant]);
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant) => {
      runs.push(runParticipant);
      return {
        participant: runParticipant,
        ok: true,
        content: "ok",
        durationMs: 1,
        sessionId: "session-1"
      };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  const result = await service.requestPermissionChangeFromTool({
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 0,
    capabilities: ["permissions.request"],
    runId: "auto-run",
    triggerMessageId: "user-message"
  }, {
    kind: "portable",
    permissions: ["webAccess"],
    reason: "Need live lookup."
  });

  assert.equal(result.status, "already_granted");
  const approvals = ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).filter(
    (approval) => approval.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL
  );
  assert.equal(approvals.length, 0);
  assert.equal(runs.length, 0);
  assert.equal(storage.current.messages.some((message: Conversation["messages"][number]) =>
    message.content.includes("Permission approval needed")
  ), false);
});

test("switching an existing session to auto adopts the mode on the next resumed turn", async () => {
  const runs: Array<{ options: any }> = [];
  const participant = chatParticipant("codex-cli");
  assert.equal(participant.agentMode, "default");
  const conversation = chatConversation([participant]);
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant, _prompt, _repoPath, _diffMode, _kind, _signal, options) => {
      runs.push({ options });
      return {
        participant: runParticipant,
        ok: true,
        content: "ok",
        durationMs: 1,
        sessionId: "session-1"
      };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  await service.sendMessage({ conversationId: conversation.id, runId: "run-default", content: "@codex hello" });
  await waitFor(() => runs.length === 1);
  // First turn runs in default mode and seeds a provider session id.
  assert.equal(runs[0].options.agentMode, "default");
  assert.ok(!runs[0].options.sessionId);

  // Flip the persisted participant to Auto-review, then send another message.
  const persisted = storage.current.metadata.participants.find((item: ChatParticipant) => item.id === participant.id);
  persisted.agentMode = "auto";

  await service.sendMessage({ conversationId: conversation.id, runId: "run-auto", content: "@codex again" });
  await waitFor(() => runs.length === 2);
  // The new mode must be adopted (not frozen at the session's original mode)...
  assert.equal(runs[1].options.agentMode, "auto");
  // ...while still resuming the same provider session (no reset / no lost context).
  // The provider re-asserts the new profile on resume.
  assert.equal(runs[1].options.sessionId, "session-1");
  // The launched options resolve to the Auto-review preset through the shared helper.
  const effective = effectiveChatAgentPermissionsForProvider("codex-cli", runs[1].options.agentMode, runs[1].options.permissions);
  assert.equal(effective.workspaceWrite, true);
  assert.equal(effective.webAccess, true);
});

test("auto mode handles shell permission requests via native auto without a user approval", async () => {
  const participant = chatParticipant("claude-code");
  participant.agentMode = "auto";
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });

  const result = await service.requestPermissionChangeFromTool({
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 0,
    capabilities: ["permissions.request"],
    runId: "auto-shell-run",
    triggerMessageId: "user-message"
  }, {
    kind: "shellRules",
    rules: [{ action: "allow", match: "prefix", pattern: "git diff" }],
    reason: "Need shell."
  });

  // Auto-review delegates shell decisions to the native auto classifier, so a shellRules
  // request is reported already-handled and creates no pending User approval.
  assert.equal(result.status, "already_granted");
  const approvals = ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).filter(
    (approval) => approval.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL
  );
  assert.equal(approvals.length, 0);
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

test("approved permission resume ignores duplicate concurrent resume attempts", async () => {
  const participant = chatParticipant("claude-code");
  const approval = permissionApproval(participant, {
    kind: "portable",
    permissions: ["webAccess"]
  }, {
    approvalScope: "once",
    status: "approved",
    resumeContext: {
      runId: "auto-resume-run",
      triggerMessageId: "user-message"
    }
  });
  const conversation = chatConversation([participant], { pendingAppToolApprovals: [approval] });
  let runCount = 0;
  let releaseRun!: () => void;
  const runCanFinish = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant) => {
      runCount += 1;
      await runCanFinish;
      return {
        participant: runParticipant,
        ok: true,
        content: "Finished auto-applied resume.",
        durationMs: 1,
        sessionId: "session-1"
      };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  const first = (service as any).autoResumePermissionApproval(conversation.id, approval.id);
  const second = (service as any).autoResumePermissionApproval(conversation.id, approval.id);
  await waitFor(() => runCount === 1);
  releaseRun();
  await Promise.all([first, second]);

  assert.equal(runCount, 1);
  assert.equal(storage.current.metadata.running, false);
  assert.equal(storage.current.metadata.runId, undefined);
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].consumedAt.length > 0, true);
});

test("permission resume waits behind an in-flight same-participant turn", async () => {
  const participant = chatParticipant("claude-code");
  const approval = permissionApproval(participant, {
    kind: "portable",
    permissions: ["webAccess"]
  }, {
    approvalScope: "once",
    status: "approved",
    resumeContext: {
      runId: "auto-resume-run",
      triggerMessageId: "user-message"
    }
  });
  const conversation = chatConversation([participant], { pendingAppToolApprovals: [approval] });
  let runStarted = false;
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant) => {
      runStarted = true;
      return {
        participant: runParticipant,
        ok: true,
        content: "resumed",
        durationMs: 1,
        sessionId: "session-1"
      };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  // Simulate an in-flight turn for the same participant holding the per-participant
  // serialization queue; the resume must serialize behind it via participantTurnQueues.
  const queueKey = `${conversation.id}:${participant.id}`;
  let releaseInFlight!: () => void;
  (service as any).participantTurnQueues.set(queueKey, new Promise<void>((resolve) => {
    releaseInFlight = resolve;
  }));

  const resume = (service as any).autoResumePermissionApproval(conversation.id, approval.id);
  // Allow the resume to reach the queue wait; it must not start the run while blocked.
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(runStarted, false);

  releaseInFlight();
  await resume;

  assert.equal(runStarted, true);
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
  await waitFor(() => runCount === 1);

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
  const prompt = (service as any).participantPermissionPolicy("claude-code", "default", defaultChatAgentPermissions(), true);

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

test("participantPermissionPolicy reflects Auto-review preset capabilities", () => {
  const { service } = testService();
  const prompt = (service as any).participantPermissionPolicy("codex-cli", "auto", defaultChatAgentPermissions(), true);

  assert.match(prompt, /shell commands allowed/);
  assert.match(prompt, /workspace edits allowed/);
  assert.match(prompt, /web access allowed/);
  assert.match(prompt, /Codex Auto-review mode enables native command execution/);
  assert.doesNotMatch(prompt, /Web access is blocked/);
  assert.doesNotMatch(prompt, /Workspace file edits are blocked/);
});

test("participantPermissionPolicy keeps explicit shell deny rules as hard stops", () => {
  const { service } = testService();
  const prompt = (service as any).participantPermissionPolicy("claude-code", "default", normalizeChatAgentPermissions({
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
  const prompt = (service as any).participantPermissionPolicy("claude-code", "default", defaultChatAgentPermissions(), false);

  assert.match(prompt, /explain the specific command and shell rule needed before refusing/);
  assert.match(prompt, /explain that `workspaceWrite` is needed before refusing/);
  assert.match(prompt, /explain that `webAccess` is needed before refusing/);
  assert.doesNotMatch(prompt, /app_permissions_request_change/);
});

test("participantPermissionPolicy guides blocked repoRead to request before refusing", () => {
  const { service } = testService();
  const prompt = (service as any).participantPermissionPolicy("claude-code", "default", normalizeChatAgentPermissions({
    ...defaultChatAgentPermissions(),
    repoRead: false
  }), true);

  assert.match(prompt, /repoRead/);
  assert.match(prompt, /app_permissions_request_change/);
});

test("participantPermissionPolicy does not suggest escalation for agent-mode masked shell and workspace grants", () => {
  const { service } = testService();
  const prompt = (service as any).participantPermissionPolicy("claude-code", "plan", normalizeChatAgentPermissions({
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
  assert.match(instructions, /Reaction MCP tool: `app_chat_react` adds or toggles an emoji reaction on a specific message/);
  assert.match(instructions, /When replying to a participant request addressed to you, answer in the active thread/);
  assert.match(instructions, /if request matching is ambiguous, ask for clarification rather than guessing/);
  assert.doesNotMatch(instructions, /app_chat_reply_to_participant_request/);
});

test("toggleReaction adds and removes a user reaction on a message", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });

  const added = await service.toggleReaction({
    conversationId: conversation.id,
    messageId: "user-message",
    emoji: "✅"
  });

  assert.equal(added?.messages[0].metadata?.reactions?.["✅"]?.length, 1);
  assert.deepEqual(added?.messages[0].metadata?.reactions?.["✅"]?.[0], {
    actorId: "user",
    actorLabel: "User",
    actorKind: "user",
    at: added?.messages[0].metadata?.reactions?.["✅"]?.[0].at
  });
  assert.equal(storage.current.messages[0].metadata.reactions["✅"][0].actorLabel, "User");

  const removed = await service.toggleReaction({
    conversationId: conversation.id,
    messageId: "user-message",
    emoji: "✅"
  });

  assert.equal(removed?.messages[0].metadata?.reactions, undefined);
  assert.equal(storage.current.messages[0].metadata.reactions, undefined);
});

test("app_chat_react toggles a participant reaction and rejects unknown message ids", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 1,
    capabilities: []
  };

  const added = await service.reactToMessageFromTool(actor, {
    messageId: "user-message",
    emoji: "✅"
  });

  assert.equal(added.status, "added");
  assert.equal(added.messageId, "user-message");
  assert.equal(storage.current.messages[0].metadata.reactions["✅"][0].actorLabel, "@codex");

  const removed = await service.reactToMessageFromTool(actor, {
    messageId: "user-message",
    emoji: "✅"
  });

  assert.equal(removed.status, "removed");
  assert.equal(storage.current.messages[0].metadata.reactions, undefined);

  await assert.rejects(
    () => service.reactToMessageFromTool(actor, {
      messageId: "missing-message",
      emoji: "✅"
    }),
    /MessageReactionDenied/
  );
});

test("app_chat_react reaction survives stale chat state refresh", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const staleConversation = clone(conversation);
  const { service, storage } = testService({ conversation });
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 1,
    capabilities: []
  };

  await service.reactToMessageFromTool(actor, {
    messageId: "user-message",
    emoji: "✅"
  });

  assert.equal(storage.current.messages[0].metadata.reactions["✅"][0].actorLabel, "@codex");

  await (service as any).refreshStoredChatState(staleConversation);

  assert.equal(staleConversation.messages[0].metadata?.reactions?.["✅"]?.[0]?.actorLabel, "@codex");

  const staleConversationWithReaction = clone(staleConversation);

  await service.reactToMessageFromTool(actor, {
    messageId: "user-message",
    emoji: "✅"
  });

  assert.equal(storage.current.messages[0].metadata.reactions, undefined);

  await (service as any).refreshStoredChatState(staleConversationWithReaction);

  assert.equal(staleConversationWithReaction.messages[0].metadata?.reactions, undefined);
});

function pendingParticipantMessage(
  participant: ChatParticipant,
  id: string,
  runId: string,
  patch: Partial<{ status: "pending" | "done" | "error"; content: string; metadata: any }> = {}
): any {
  return {
    id,
    role: "participant",
    participantId: participant.id,
    participantLabel: `@${participant.handle}`,
    content: patch.content ?? "",
    createdAt: NOW,
    status: patch.status ?? "pending",
    metadata: patch.metadata ?? { runId }
  };
}

test("recoverStaleChatRun leaves a pending message whose run is still live", () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const runId = "live-run";
  conversation.messages.push(pendingParticipantMessage(participant, "pending-live", runId));
  const { service } = testService({ conversation });
  (service as any).chatRunMeta.set(runId, {
    conversationId: conversation.id,
    participantId: participant.id,
    participantHandle: participant.handle
  });

  const changed = (service as any).recoverStaleChatRun(conversation);

  assert.equal(changed, false);
  const pending = conversation.messages.find((message: any) => message.id === "pending-live")!;
  assert.equal(pending.status, "pending");
  assert.equal(pending.metadata?.staleRunRecovery, undefined);
});

test("a swept placeholder is marked, and a late result repairs it preserving reactions", () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const runId = "dead-run";
  conversation.messages.push(pendingParticipantMessage(participant, "pending-dead", runId));
  const { service } = testService({ conversation });

  const swept = (service as any).recoverStaleChatRun(conversation);
  assert.equal(swept, true);
  const placeholder = conversation.messages.find((message: any) => message.id === "pending-dead")!;
  assert.equal(placeholder.status, "error");
  assert.equal(placeholder.content, "Interrupted before completion.");
  assert.equal(placeholder.metadata?.staleRunRecovery?.runId, runId);

  // A ✅ lands on the placeholder while it still shows "Interrupted".
  placeholder.metadata.reactions = {
    "✅": [{ actorId: "user", actorLabel: "User", actorKind: "user", at: NOW }]
  };

  // The real answer finishes late and is appended under the same id.
  const completed = pendingParticipantMessage(participant, "pending-dead", runId, {
    status: "done",
    content: "Here is the real answer.",
    metadata: { runId }
  });
  (service as any).appendParticipantTurnMessages(conversation, participant, [completed]);

  const repaired = conversation.messages.find((message: any) => message.id === "pending-dead")!;
  assert.equal(repaired.status, "done");
  assert.equal(repaired.content, "Here is the real answer.");
  assert.equal(repaired.metadata?.staleRunRecovery, undefined);
  assert.equal(repaired.metadata?.reactions?.["✅"]?.[0]?.actorLabel, "User");
});

test("a late result does not resurrect a non-recovery error (user-stopped) message", () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  conversation.messages.push(pendingParticipantMessage(participant, "stopped", "stopped-run", {
    status: "error",
    content: "Stopped by user.",
    metadata: { runId: "stopped-run" }
  }));
  const { service } = testService({ conversation });

  (service as any).appendParticipantTurnMessages(conversation, participant, [
    pendingParticipantMessage(participant, "stopped", "stopped-run", {
      status: "done",
      content: "Late answer that should be ignored.",
      metadata: { runId: "stopped-run" }
    })
  ]);

  const after = conversation.messages.find((message: any) => message.id === "stopped")!;
  assert.equal(after.status, "error");
  assert.equal(after.content, "Stopped by user.");
});

test("recoverStaleChatRun keeps run metadata when a pending bubble is live only via the registry", () => {
  const participant = chatParticipant("codex-cli");
  const runId = "registry-only-run";
  const conversation = chatConversation([participant], { activeRunIds: [runId], running: true });
  conversation.messages.push(pendingParticipantMessage(participant, "pending-registry", runId));
  const { service } = testService({ conversation });
  // Stale metadata lists the run, the in-memory activeRunIds Set has lost it, but
  // the controller/meta registry still tracks it as live.
  (service as any).chatRunMeta.set(runId, {
    conversationId: conversation.id,
    participantId: participant.id,
    participantHandle: participant.handle
  });

  const changed = (service as any).recoverStaleChatRun(conversation);

  assert.equal(changed, false);
  assert.deepEqual(conversation.metadata.activeRunIds, [runId]);
  assert.equal(conversation.metadata.running, true);
  const warnings = (conversation.metadata.warnings as string[] | undefined) ?? [];
  assert.equal(warnings.some((warning) => /interrupt/i.test(warning)), false);
  assert.equal(conversation.messages.find((message: any) => message.id === "pending-registry")!.status, "pending");
});

test("a declined late result does not spawn an implicit participant request", () => {
  const participant = chatParticipant("codex-cli");
  const other = chatParticipant("claude-code"); // handle "drew"
  const conversation = chatConversation([participant, other]);
  conversation.messages.push(pendingParticipantMessage(participant, "stopped", "stopped-run", {
    status: "error",
    content: "Stopped by user.",
    metadata: { runId: "stopped-run" }
  }));
  const { service } = testService({ conversation });

  // The stopped run finishes late with content that @-mentions another participant.
  (service as any).appendParticipantTurnMessages(conversation, participant, [
    pendingParticipantMessage(participant, "stopped", "stopped-run", {
      status: "done",
      content: "@drew please take over.",
      metadata: { runId: "stopped-run" }
    })
  ]);

  const after = conversation.messages.find((message: any) => message.id === "stopped")!;
  assert.equal(after.content, "Stopped by user.");
  // No inferred participant-request message should have been appended.
  assert.equal(conversation.messages.length, 2);
  assert.equal(conversation.messages.some((message: any) => message.metadata?.participantRequest), false);
});

test("app MCP advertises app_chat_react to chat participants", () => {
  const appMcp = new AppMcpService();
  const tools = (appMcp as any).toolsForActor({
    conversationId: "conversation-1",
    participantId: "participant-1",
    roleConfigId: ROLE.id,
    roleConfigVersion: ROLE.version,
    capabilities: []
  }) as Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }>;
  const reactionTool = tools.find((tool) => tool.name === APP_CHAT_REACT_TOOL);

  assert.ok(reactionTool);
  assert.ok(reactionTool.inputSchema?.properties?.messageId);
  assert.ok(reactionTool.inputSchema?.properties?.emoji);
});

test("participant behavior rules are merged into session role instructions", async () => {
  const behaviorRule: ChatBehaviorRuleConfig = {
    id: "concise",
    label: "Be concise",
    instructions: "Keep replies short unless User asks for detail.",
    version: 1,
    updatedAt: NOW
  };
  const { service } = testService({
    settings: {
      chatRoleConfigs: [ROLE],
      chatBehaviorRules: [behaviorRule]
    }
  });
  const participant = {
    ...chatParticipant("codex-cli"),
    behaviorRuleIds: [behaviorRule.id]
  };

  const session = await (service as any).newSessionForParticipant(participant);

  assert.match(session.roleInstructions, /## Participant Behavior Rules/);
  assert.match(session.roleInstructions, /### Be concise/);
  assert.match(session.roleInstructions, /Keep replies short unless User asks for detail/);
  assert.deepEqual(session.participantBehaviorRules, [{
    id: behaviorRule.id,
    label: behaviorRule.label,
    instructions: behaviorRule.instructions,
    version: behaviorRule.version
  }]);
});

test("behavior rules are reinforced in every turn prompt even when role instructions are omitted", async () => {
  const behaviorRule: ChatBehaviorRuleConfig = {
    id: "greeting",
    label: "Test Rule",
    instructions: "Always start message with \"hi\".",
    version: 1,
    updatedAt: NOW
  };
  const { service } = testService({
    settings: {
      chatRoleConfigs: [ROLE],
      chatBehaviorRules: [behaviorRule]
    }
  });
  const participant = {
    ...chatParticipant("codex-cli"),
    behaviorRuleIds: [behaviorRule.id]
  };
  const session = await (service as any).newSessionForParticipant(participant);
  const conversation = chatConversation([participant]);
  const triggerMessage = conversation.messages[0];

  // Simulate a resume turn: native role runtime, so role instructions are not re-sent.
  const { prompt, sections } = (service as any).buildPromptParts(
    conversation,
    participant,
    session,
    triggerMessage,
    "/tmp/workspace",
    false,
    { includeRoleInstructions: false, agentMode: "default", permissions: participant.permissions }
  );

  assert.match(prompt, /Active behavior rules/);
  assert.match(prompt, /- Test Rule: Always start message with "hi"\./);
  assert.ok(sections.behaviorRules > 0);
  // Role instructions are excluded on this turn, so the full role-embedded section must be absent;
  // only the per-turn reinforcement carries the rule.
  assert.doesNotMatch(prompt, /## Participant Behavior Rules/);
});

test("behavior rule prompt reinforcement truncates oversized legacy rule instructions", async () => {
  const longInstructions = `${"x".repeat(CHAT_BEHAVIOR_RULE_INSTRUCTIONS_MAX_CHARS + 20)} sentinel`;
  const behaviorRule: ChatBehaviorRuleConfig = {
    id: "large-rule",
    label: "Large Rule",
    instructions: longInstructions,
    version: 1,
    updatedAt: NOW
  };
  const { service } = testService({
    settings: {
      chatRoleConfigs: [ROLE],
      chatBehaviorRules: [behaviorRule]
    }
  });
  const participant = {
    ...chatParticipant("codex-cli"),
    behaviorRuleIds: [behaviorRule.id]
  };
  const session = await (service as any).newSessionForParticipant(participant);
  const conversation = chatConversation([participant]);
  const triggerMessage = conversation.messages[0];

  const { prompt } = (service as any).buildPromptParts(
    conversation,
    participant,
    session,
    triggerMessage,
    "/tmp/workspace",
    false,
    { includeRoleInstructions: false, agentMode: "default", permissions: participant.permissions }
  );

  const promptText = prompt as string;
  const ruleLine = promptText.split("\n").find((line: string) => line.startsWith("- Large Rule: "));
  assert.ok(ruleLine);
  const reinforcedInstructions = ruleLine.replace("- Large Rule: ", "");
  assert.equal(reinforcedInstructions.length <= CHAT_BEHAVIOR_RULE_INSTRUCTIONS_MAX_CHARS, true);
  assert.match(reinforcedInstructions, /\.\.\.$/);
  assert.doesNotMatch(reinforcedInstructions, /sentinel/);
});

test("behavior rule reinforcement preserves multi-line rule structure instead of flattening it", async () => {
  const behaviorRule: ChatBehaviorRuleConfig = {
    id: "multi-step",
    label: "Multi Step",
    instructions: "Follow these steps:\n1. Greet\n2. Answer\n3. Summarize",
    version: 1,
    updatedAt: NOW
  };
  const { service } = testService({
    settings: {
      chatRoleConfigs: [ROLE],
      chatBehaviorRules: [behaviorRule]
    }
  });
  const participant = {
    ...chatParticipant("codex-cli"),
    behaviorRuleIds: [behaviorRule.id]
  };
  const session = await (service as any).newSessionForParticipant(participant);
  const conversation = chatConversation([participant]);
  const triggerMessage = conversation.messages[0];

  const { prompt } = (service as any).buildPromptParts(
    conversation,
    participant,
    session,
    triggerMessage,
    "/tmp/workspace",
    false,
    { includeRoleInstructions: false, agentMode: "default", permissions: participant.permissions }
  );

  const promptText = prompt as string;
  // Continuation lines stay on their own indented lines under the bullet.
  assert.ok(promptText.includes("- Multi Step: Follow these steps:\n  1. Greet\n  2. Answer\n  3. Summarize"));
  // The structure must not be collapsed into a single line.
  assert.doesNotMatch(promptText, /Follow these steps: 1\. Greet/);
});

test("behavior rule reinforcement is skipped when role instructions already carry the rules", async () => {
  const behaviorRule: ChatBehaviorRuleConfig = {
    id: "concise",
    label: "Be concise",
    instructions: "Keep replies short unless User asks for detail.",
    version: 1,
    updatedAt: NOW
  };
  const { service } = testService({
    settings: {
      chatRoleConfigs: [ROLE],
      chatBehaviorRules: [behaviorRule]
    }
  });
  const participant = {
    ...chatParticipant("codex-cli"),
    behaviorRuleIds: [behaviorRule.id]
  };
  const session = await (service as any).newSessionForParticipant(participant);
  const conversation = chatConversation([participant]);
  const triggerMessage = conversation.messages[0];

  // First / refreshed turn: role instructions are included and embed the rules verbatim.
  const { prompt, sections } = (service as any).buildPromptParts(
    conversation,
    participant,
    session,
    triggerMessage,
    "/tmp/workspace",
    false,
    { includeRoleInstructions: true, agentMode: "default", permissions: participant.permissions }
  );

  assert.match(prompt, /## Participant Behavior Rules/);
  // No duplicated, divergent reinforcement copy in the same prompt.
  assert.doesNotMatch(prompt, /Active behavior rules/);
  assert.equal(sections.behaviorRules, 0);
});

function testService(options: {
  conversation?: Conversation;
  run?: (...args: any[]) => Promise<any>;
  settings?: {
    chatRoleConfigs: ChatRoleConfig[];
    chatBehaviorRules?: ChatBehaviorRuleConfig[];
  };
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
    async getPublicSettings(): Promise<{ chatRoleConfigs: ChatRoleConfig[]; chatBehaviorRules: ChatBehaviorRuleConfig[] }> {
      return {
        chatRoleConfigs: options.settings?.chatRoleConfigs ?? [ROLE],
        chatBehaviorRules: options.settings?.chatBehaviorRules ?? []
      };
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
