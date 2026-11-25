import assert from "node:assert/strict";
import test from "node:test";
import { chatParts } from "./chat/test/chatParts";
import type { CodexServerRequestDelivery } from "./codexApprovals";
import type { ChatAppToolApproval, ChatMessage, ChatParticipantSession } from "../../shared/types";
import { CHAT_CODEX_APPROVAL_CANCEL_DECISION_ID } from "../../shared/codexApproval";
import { chatConversation, chatParticipant, NOW, ROLE, testService, waitFor } from "./chat/test/permissionFixtures";

test("Codex session approval resolves the blocked callback without creating a chat policy", async () => {
  const participant = chatParticipant("codex-cli");
  participant.agentMode = "auto";
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  const session: ChatParticipantSession = {
    participantId: participant.id,
    sessionId: "codex-thread-1",
    roleConfigId: ROLE.id,
    roleConfigVersion: ROLE.version,
    roleLabel: ROLE.label,
    roleInstructions: ROLE.instructions,
    roleAppToolCapabilities: ROLE.appToolCapabilities,
    participantKind: "codex-cli",
    participantAgentMode: "auto",
    participantPermissions: participant.permissions,
    updatedAt: NOW
  };
  const controller = new AbortController();
  const decision = chatParts(service).codexApprovals.requestCodexApprovalFromCli(
    conversation,
    participant,
    session,
    "run-codex-approval",
    "user-message",
    {
      id: 77,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "codex-thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        startedAtMs: 1,
        environmentId: null,
        command: "git push origin main",
        cwd: "/tmp/scratch",
        availableDecisions: ["accept", "acceptForSession", "decline", "cancel"]
      },
      signal: controller.signal,
      responseDelivered: Promise.resolve({ turnActive: false })
    }
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  const pending = (storage.current.metadata.pendingAppToolApprovals as ChatAppToolApproval[])[0];

  assert.equal(pending.status, "pending");
  assert.equal((pending.request as { kind?: string }).kind, "codexApproval");
  assert.equal(JSON.stringify(pending.request).includes("allow for this chat"), false);

  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: pending.id,
    approve: true,
    codexDecisionId: "acceptForSession"
  });

  assert.deepEqual(await decision, { decision: "acceptForSession" });
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "approved");
  assert.deepEqual(storage.current.metadata.appToolApprovalPolicies ?? [], []);
  assert.equal(storage.current.messages.length, 1);
});

test("Codex approval compacts immediately while the provider receives the selected response", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  const session: ChatParticipantSession = {
    participantId: participant.id,
    sessionId: "codex-thread-ack",
    roleConfigId: ROLE.id,
    roleConfigVersion: ROLE.version,
    roleLabel: ROLE.label,
    roleInstructions: ROLE.instructions,
    roleAppToolCapabilities: ROLE.appToolCapabilities,
    participantKind: "codex-cli",
    participantAgentMode: "auto",
    participantPermissions: participant.permissions,
    updatedAt: NOW
  };
  let acknowledge!: (delivery: CodexServerRequestDelivery) => void;
  const responseDelivered = new Promise<CodexServerRequestDelivery>((resolve) => { acknowledge = resolve; });
  const decision = chatParts(service).codexApprovals.requestCodexApprovalFromCli(
    conversation,
    participant,
    session,
    "run-codex-ack",
    "user-message",
    {
      id: 78,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "codex-thread-ack",
        turnId: "turn-ack",
        itemId: "item-ack",
        startedAtMs: 1,
        environmentId: null,
        command: "git push origin scratch",
        availableDecisions: ["accept", "decline"]
      },
      signal: new AbortController().signal,
      responseDelivered
    }
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  const pending = (storage.current.metadata.pendingAppToolApprovals as ChatAppToolApproval[])[0];
  const response = service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: pending.id,
    approve: true,
    codexDecisionId: "accept"
  });
  assert.deepEqual(await decision, { decision: "accept" });
  await response;
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "approved");
  acknowledge({ turnActive: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "approved");
});

test("a guarded Codex decision cannot report delivery before the native adapter acknowledges it", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  const session = { participantId: participant.id, sessionId: "guarded-thread", roleConfigId: ROLE.id,
    roleConfigVersion: ROLE.version, roleLabel: ROLE.label, roleInstructions: ROLE.instructions,
    roleAppToolCapabilities: ROLE.appToolCapabilities, participantKind: "codex-cli", participantAgentMode: "auto",
    participantPermissions: participant.permissions, updatedAt: NOW } as ChatParticipantSession;
  let acknowledge!: () => void;
  const responseDelivered = new Promise<void>(resolve => { acknowledge = resolve; });
  const decision = chatParts(service).codexApprovals.requestCodexApprovalFromCli(conversation, participant, session, "guarded-run", "user-message", {
    id: 789, method: "item/commandExecution/requestApproval", signal: new AbortController().signal, responseDelivered,
    params: { threadId: "guarded-thread", turnId: "turn", itemId: "item", startedAtMs: 1, environmentId: null, command: "git status", availableDecisions: ["accept", "decline"] }
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  const pending = storage.current.metadata.pendingAppToolApprovals[0];
  let claims = 0, finished = false;
  const response = service.respondToAppToolApproval({ conversationId: conversation.id, approvalId: pending.id, approve: true, codexDecisionId: "accept" }, undefined,
    { beforeApply: async () => { claims++; }, awaitNativeDelivery: true }).then(() => { finished = true; });
  assert.deepEqual(await decision, { decision: "accept" });
  assert.equal(claims, 1);
  assert.equal(finished, false);
  acknowledge();
  await response;
  assert.equal(finished, true);
});

test("Codex approval keeps the compact decision and reports provider delivery failure through run progress", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  const session: ChatParticipantSession = {
    participantId: participant.id,
    sessionId: "codex-thread-delivery-failure",
    roleConfigId: ROLE.id,
    roleConfigVersion: ROLE.version,
    roleLabel: ROLE.label,
    roleInstructions: ROLE.instructions,
    roleAppToolCapabilities: ROLE.appToolCapabilities,
    participantKind: "codex-cli",
    participantAgentMode: "auto",
    participantPermissions: participant.permissions,
    updatedAt: NOW
  };
  let rejectDelivery!: (error: Error) => void;
  const responseDelivered = new Promise<CodexServerRequestDelivery>((_resolve, reject) => { rejectDelivery = reject; });
  void responseDelivered.catch(() => undefined);
  const decision = chatParts(service).codexApprovals.requestCodexApprovalFromCli(
    conversation,
    participant,
    session,
    "run-codex-delivery-failure",
    "user-message",
    {
      id: 79,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "codex-thread-delivery-failure",
        turnId: "turn-delivery-failure",
        itemId: "item-delivery-failure",
        startedAtMs: 1,
        environmentId: null,
        command: "git push origin scratch",
        availableDecisions: ["accept", "decline"]
      },
      signal: new AbortController().signal,
      responseDelivered
    }
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  const pending = (storage.current.metadata.pendingAppToolApprovals as ChatAppToolApproval[])[0];
  const progressEvents: Array<{ phase: string; message: string }> = [];
  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: pending.id,
    approve: true,
    codexDecisionId: "accept"
  }, (progress) => {
    progressEvents.push(progress);
  });
  assert.deepEqual(await decision, { decision: "accept" });
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "approved");
  rejectDelivery(new Error("stdin closed"));
  await waitFor(() => progressEvents.some((event) => event.phase === "error" && /could not receive this decision.*stdin closed/i.test(event.message)));
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "approved");
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].error, undefined);
});

test("Codex approval rejects a tampered approve flag", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  const session = {
    participantId: participant.id,
    sessionId: "codex-thread-tampered",
    roleConfigId: ROLE.id,
    roleConfigVersion: ROLE.version,
    roleLabel: ROLE.label,
    roleInstructions: ROLE.instructions,
    roleAppToolCapabilities: ROLE.appToolCapabilities,
    participantKind: "codex-cli",
    participantAgentMode: "auto",
    participantPermissions: participant.permissions,
    updatedAt: NOW
  } satisfies ChatParticipantSession;
  const controller = new AbortController();
  const decision = chatParts(service).codexApprovals.requestCodexApprovalFromCli(conversation, participant, session, "run-tampered", "user-message", {
    id: 80,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "codex-thread-tampered",
      turnId: "turn-tampered",
      itemId: "item-tampered",
      startedAtMs: 1,
      environmentId: null,
      availableDecisions: ["decline"]
    },
    signal: controller.signal,
    responseDelivered: Promise.resolve({ turnActive: false })
  });
  void decision.catch(() => undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const pending = (storage.current.metadata.pendingAppToolApprovals as ChatAppToolApproval[])[0];
  await assert.rejects(() => service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: pending.id,
    approve: true,
    codexDecisionId: "decline"
  }), /does not match the approval outcome/);
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "pending");
  controller.abort(new Error("Stopped by user."));
  await assert.rejects(decision, /Stopped by user/);
});

test("Codex approval requires an explicit decision id and keeps deny distinct from cancel", async () => {
  const participant = chatParticipant("codex-cli");
  participant.agentMode = "auto";
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  const session = {
    participantId: participant.id,
    sessionId: "codex-thread-explicit-decisions",
    roleConfigId: ROLE.id,
    roleConfigVersion: ROLE.version,
    roleLabel: ROLE.label,
    roleInstructions: ROLE.instructions,
    roleAppToolCapabilities: ROLE.appToolCapabilities,
    participantKind: "codex-cli",
    participantAgentMode: "auto",
    participantPermissions: participant.permissions,
    updatedAt: NOW
  } satisfies ChatParticipantSession;
  const requestApproval = (id: number, itemId: string) => chatParts(service).codexApprovals.requestCodexApprovalFromCli(
    conversation,
    participant,
    session,
    `run-${itemId}`,
    "user-message",
    {
      id,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: session.sessionId,
        turnId: `turn-${itemId}`,
        itemId,
        startedAtMs: 1,
        environmentId: null,
        command: "git push scratch main",
        availableDecisions: ["decline", "cancel"]
      },
      signal: new AbortController().signal,
      responseDelivered: Promise.resolve({ turnActive: false })
    }
  );

  const denyDecision = requestApproval(82, "deny-item");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const denyApproval = (storage.current.metadata.pendingAppToolApprovals as ChatAppToolApproval[])
    .find((item) => item.status === "pending");
  assert.ok(denyApproval);
  let denySettled = false;
  void denyDecision.finally(() => { denySettled = true; });

  await assert.rejects(() => service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: denyApproval.id,
    approve: false
  }), /Select one of the decisions offered/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(denySettled, false);
  assert.equal(storage.current.metadata.pendingAppToolApprovals.find((item: ChatAppToolApproval) => item.id === denyApproval.id)?.status, "pending");
  assert.equal(chatParts(service).codexApprovals.codexApprovalResolvers.get(denyApproval.id)?.submitted, false);

  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: denyApproval.id,
    approve: false,
    codexDecisionId: "decline"
  });
  assert.deepEqual(await denyDecision, { decision: "decline" });
  assert.equal(storage.current.metadata.pendingAppToolApprovals.find((item: ChatAppToolApproval) => item.id === denyApproval.id)?.status, "denied");

  const cancelDecision = requestApproval(83, "cancel-item");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const cancelApproval = (storage.current.metadata.pendingAppToolApprovals as ChatAppToolApproval[])
    .find((item) => item.status === "pending");
  assert.ok(cancelApproval);
  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: cancelApproval.id,
    approve: false,
    codexDecisionId: "cancel"
  });
  assert.deepEqual(await cancelDecision, { decision: "cancel" });
  assert.equal(storage.current.metadata.pendingAppToolApprovals.find((item: ChatAppToolApproval) => item.id === cancelApproval.id)?.status, "cancelled");
});

test("Codex human-decision timeout sends the method refusal and expires the card", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  service.setCodexApprovalWaitMsForTests(5);
  const session = {
    participantId: participant.id,
    sessionId: "codex-thread-timeout",
    roleConfigId: ROLE.id,
    roleConfigVersion: ROLE.version,
    roleLabel: ROLE.label,
    roleInstructions: ROLE.instructions,
    roleAppToolCapabilities: ROLE.appToolCapabilities,
    participantKind: "codex-cli",
    participantAgentMode: "auto",
    participantPermissions: participant.permissions,
    updatedAt: NOW
  } satisfies ChatParticipantSession;
  let acknowledge!: (delivery: CodexServerRequestDelivery) => void;
  const responseDelivered = new Promise<CodexServerRequestDelivery>((resolve) => { acknowledge = resolve; });
  const decision = chatParts(service).codexApprovals.requestCodexApprovalFromCli(conversation, participant, session, "run-timeout", "user-message", {
    id: 81,
    method: "item/permissions/requestApproval",
    params: {
      threadId: "codex-thread-timeout",
      turnId: "turn-timeout",
      itemId: "item-timeout",
      environmentId: null,
      startedAtMs: 1,
      cwd: "/tmp",
      reason: null,
      permissions: { network: { enabled: true }, fileSystem: null }
    },
    signal: new AbortController().signal,
    responseDelivered
  });
  const [refusal] = await Promise.all([
    decision,
    new Promise<void>((resolve) => setTimeout(resolve, 10))
  ]);
  assert.deepEqual(refusal, { permissions: {}, scope: "turn" });
  acknowledge({ turnActive: true });
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "expired");
  assert.match(storage.current.metadata.pendingAppToolApprovals[0].error ?? "", /method-supported refusal/);
});

test("Guardian timeout creates a durable terminal card without a resolver", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  const session = {
    participantId: participant.id,
    sessionId: "codex-thread-guardian-timeout",
    roleConfigId: ROLE.id,
    roleConfigVersion: ROLE.version,
    roleLabel: ROLE.label,
    roleInstructions: ROLE.instructions,
    roleAppToolCapabilities: ROLE.appToolCapabilities,
    participantKind: "codex-cli",
    participantAgentMode: "auto",
    participantPermissions: participant.permissions,
    updatedAt: NOW
  } satisfies ChatParticipantSession;
  const result = await chatParts(service).codexApprovals.requestCodexApprovalFromCli(conversation, participant, session, "run-guardian-timeout", "user-message", {
    id: "guardian-timeout:review-1",
    method: "item/autoApprovalReview/timedOut",
    params: {
      threadId: "codex-thread-guardian-timeout",
      turnId: "turn-timeout",
      startedAtMs: 1,
      completedAtMs: 2,
      reviewId: "review-timeout",
      targetItemId: null,
      decisionSource: "agent",
      review: { status: "timedOut", riskLevel: "high", userAuthorization: "low", rationale: "Review timed out" },
      action: { type: "command", source: "unifiedExec", command: "git push origin scratch", cwd: "/tmp" }
    },
    signal: new AbortController().signal,
    responseDelivered: Promise.resolve({ turnActive: false })
  });
  assert.deepEqual(result, { decision: "keepDenied" });
  const approval = (storage.current.metadata.pendingAppToolApprovals as ChatAppToolApproval[])[0];
  assert.equal(approval.status, "expired");
  assert.deepEqual((approval.request as { options: unknown[] }).options, []);
  assert.match(approval.error ?? "", /remains denied/);
});

test("Guardian approval compacts immediately and starts one hidden same-session continuation after delivery", async () => {
  const participant = chatParticipant("codex-cli");
  participant.agentMode = "auto";
  const session: ChatParticipantSession = {
    participantId: participant.id,
    sessionId: "codex-thread-1",
    roleConfigId: ROLE.id,
    roleConfigVersion: ROLE.version,
    roleLabel: ROLE.label,
    roleInstructions: ROLE.instructions,
    roleAppToolCapabilities: ROLE.appToolCapabilities,
    participantKind: "codex-cli",
    participantAgentMode: "auto",
    participantPermissions: participant.permissions,
    updatedAt: NOW
  };
  const runs: Array<{ prompt: string; sessionId?: string }> = [];
  const conversation = chatConversation([participant], { participantSessions: [session] });
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant, prompt, _repoPath, _diffMode, _kind, _signal, options) => {
      runs.push({ prompt, sessionId: options?.sessionId });
      return { participant: runParticipant, ok: true, content: "Continuation complete.", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  const controller = new AbortController();
  let acknowledge!: (delivery: CodexServerRequestDelivery) => void;
  const responseDelivered = new Promise<CodexServerRequestDelivery>((resolve) => { acknowledge = resolve; });
  const decision = chatParts(service).codexApprovals.requestCodexApprovalFromCli(
    conversation,
    participant,
    session,
    "run-guardian-approval",
    "user-message",
    {
      id: "guardian:review-1",
      method: "item/autoApprovalReview/denied",
      params: {
        threadId: "codex-thread-1",
        turnId: "turn-1",
        startedAtMs: 100,
        completedAtMs: 200,
        reviewId: "review-1",
        targetItemId: "item-1",
        decisionSource: "agent",
        review: { status: "denied", riskLevel: "high", userAuthorization: "low", rationale: "Not authorized" },
        action: { type: "command", source: "unifiedExec", command: "git push origin main", cwd: "/tmp/scratch" }
      },
      signal: controller.signal,
      responseDelivered
    }
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  const pending = (storage.current.metadata.pendingAppToolApprovals as ChatAppToolApproval[])[0];

  assert.equal(pending.status, "pending");
  assert.deepEqual((pending.request as { options: Array<{ label: string }> }).options.map((option) => option.label), [
    "Approve one retry",
    "Keep denied"
  ]);
  assert.equal(JSON.stringify(pending.request).includes("guardian_assessment"), false);
  assert.equal(JSON.stringify(pending.request).includes("startedAtMs"), false);

  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: pending.id,
    approve: true,
    codexDecisionId: "approveRetry"
  });

  assert.deepEqual(await decision, { decision: "approveRetry" });
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "approved");
  await assert.rejects(() => service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: pending.id,
    approve: true,
    codexDecisionId: "approveRetry"
  }), /already been answered/);
  acknowledge({ turnActive: false });
  await waitFor(() => runs.length === 1);
  await waitFor(() => storage.current.messages.some((message: ChatMessage) =>
    message.role === "participant" && message.content === "Continuation complete." && message.status === "done"
  ));
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "approved");
  assert.deepEqual(storage.current.metadata.appToolApprovalPolicies ?? [], []);
  assert.equal(runs[0].sessionId, "codex-thread-1");
  assert.match(runs[0].prompt, /Retry exactly the action I just approved, once/);
  const hiddenControl = storage.current.messages.find((message: ChatMessage) =>
    message.role === "user" && message.content.includes("Retry exactly the action I just approved, once")
  );
  assert.equal(hiddenControl?.metadata?.hiddenFromTimeline, true);
  assert.equal(storage.current.messages.filter((message: ChatMessage) => message.metadata?.approvedContinuation).length, 1);
});

test("Guardian Keep denied compacts and starts the decision-specific continuation", async () => {
  const participant = chatParticipant("codex-cli");
  participant.agentMode = "auto";
  const session: ChatParticipantSession = {
    participantId: participant.id,
    sessionId: "codex-thread-deny",
    roleConfigId: ROLE.id,
    roleConfigVersion: ROLE.version,
    roleLabel: ROLE.label,
    roleInstructions: ROLE.instructions,
    roleAppToolCapabilities: ROLE.appToolCapabilities,
    participantKind: "codex-cli",
    participantAgentMode: "auto",
    participantPermissions: participant.permissions,
    updatedAt: NOW
  };
  const prompts: string[] = [];
  const conversation = chatConversation([participant], { participantSessions: [session] });
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant, prompt) => {
      prompts.push(prompt);
      return { participant: runParticipant, ok: true, content: "Continued without the action.", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  const decision = chatParts(service).codexApprovals.requestCodexApprovalFromCli(
    conversation,
    participant,
    session,
    "run-guardian-deny",
    "user-message",
    guardianDeniedRequest("codex-thread-deny", Promise.resolve({ turnActive: false }))
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  const pending = (storage.current.metadata.pendingAppToolApprovals as ChatAppToolApproval[])[0];

  await assert.rejects(() => service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: pending.id,
    approve: false
  }), /Select one of the decisions offered/);
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "pending");

  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: pending.id,
    approve: false,
    codexDecisionId: "keepDenied"
  });

  assert.deepEqual(await decision, { decision: "keepDenied" });
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "denied");
  await waitFor(() => prompts.length === 1);
  assert.match(prompts[0], /Do not retry the action I just denied/);
  assert.equal(storage.current.messages.filter((message: ChatMessage) => message.metadata?.approvedContinuation).length, 1);
});

test("Guardian Cancel compacts the card without starting a continuation", async () => {
  const participant = chatParticipant("codex-cli");
  participant.agentMode = "auto";
  const session: ChatParticipantSession = {
    participantId: participant.id,
    sessionId: "codex-thread-cancel",
    roleConfigId: ROLE.id,
    roleConfigVersion: ROLE.version,
    roleLabel: ROLE.label,
    roleInstructions: ROLE.instructions,
    roleAppToolCapabilities: ROLE.appToolCapabilities,
    participantKind: "codex-cli",
    participantAgentMode: "auto",
    participantPermissions: participant.permissions,
    updatedAt: NOW
  };
  const prompts: string[] = [];
  const conversation = chatConversation([participant], { participantSessions: [session] });
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant, prompt) => {
      prompts.push(prompt);
      return { participant: runParticipant, ok: true, content: "Unexpected continuation.", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  const decision = chatParts(service).codexApprovals.requestCodexApprovalFromCli(
    conversation,
    participant,
    session,
    "run-guardian-cancel",
    "user-message",
    guardianDeniedRequest("codex-thread-cancel", Promise.resolve({ turnActive: false }))
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  const pending = (storage.current.metadata.pendingAppToolApprovals as ChatAppToolApproval[])[0];

  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: pending.id,
    approve: false,
    codexDecisionId: CHAT_CODEX_APPROVAL_CANCEL_DECISION_ID
  });

  assert.deepEqual(await decision, { decision: "keepDenied" });
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "cancelled");
  await waitFor(() => !chatParts(service).codexApprovals.codexApprovalResolvers.has(pending.id));
  assert.deepEqual(prompts, []);
  assert.equal(storage.current.messages.filter((message: ChatMessage) => message.metadata?.approvedContinuation).length, 0);
});

test("Guardian decision delivered into the running response starts no continuation", async () => {
  for (const decisionId of ["approveRetry", "keepDenied"] as const) {
    const participant = chatParticipant("codex-cli");
    participant.agentMode = "auto";
    const session: ChatParticipantSession = {
      participantId: participant.id,
      sessionId: `codex-thread-live-${decisionId}`,
      roleConfigId: ROLE.id,
      roleConfigVersion: ROLE.version,
      roleLabel: ROLE.label,
      roleInstructions: ROLE.instructions,
      roleAppToolCapabilities: ROLE.appToolCapabilities,
      participantKind: "codex-cli",
      participantAgentMode: "auto",
      participantPermissions: participant.permissions,
      updatedAt: NOW
    };
    const conversation = chatConversation([participant], { participantSessions: [session] });
    let runCount = 0;
    const { service, storage, tempRoot } = testService({
      conversation,
      run: async (runParticipant) => {
        runCount += 1;
        return { participant: runParticipant, ok: true, content: "Unexpected continuation.", durationMs: 1 };
      }
    });
    chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
    chatParts(service).activeRuns.rememberActiveChatRun(conversation.id, "run-guardian-live");
    // Codex applies a decision inside the turn that raised the denial while
    // that turn is still running, so the receipt reports the turn as active.
    const decision = chatParts(service).codexApprovals.requestCodexApprovalFromCli(
      conversation,
      participant,
      session,
      "run-guardian-live",
      "user-message",
      guardianDeniedRequest(session.sessionId, Promise.resolve({ turnActive: true }))
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const pending = (storage.current.metadata.pendingAppToolApprovals as ChatAppToolApproval[])[0];

    await service.respondToAppToolApproval({
      conversationId: conversation.id,
      approvalId: pending.id,
      approve: decisionId === "approveRetry",
      codexDecisionId: decisionId
    });
    assert.deepEqual(await decision, { decision: decisionId });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(runCount, 0, `${decisionId} must not start a continuation while the response is running`);
    assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, decisionId === "approveRetry" ? "approved" : "denied");
    assert.equal(storage.current.messages.filter((message: ChatMessage) => message.metadata?.approvedContinuation).length, 0);
    assert.equal(storage.current.messages.filter((message: ChatMessage) => message.metadata?.hiddenFromTimeline).length, 0);
    chatParts(service).activeRuns.forgetActiveChatRun(conversation.id, "run-guardian-live");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(runCount, 0, `${decisionId} must not start a continuation once the run bookkeeping ends either`);
  }
});

test("Guardian decision delivered after the response ended queues one continuation behind the finishing run", async () => {
  const participant = chatParticipant("codex-cli");
  participant.agentMode = "auto";
  const session: ChatParticipantSession = {
    participantId: participant.id,
    sessionId: "codex-thread-active",
    roleConfigId: ROLE.id,
    roleConfigVersion: ROLE.version,
    roleLabel: ROLE.label,
    roleInstructions: ROLE.instructions,
    roleAppToolCapabilities: ROLE.appToolCapabilities,
    participantKind: "codex-cli",
    participantAgentMode: "auto",
    participantPermissions: participant.permissions,
    updatedAt: NOW
  };
  const conversation = chatConversation([participant], { participantSessions: [session] });
  let runCount = 0;
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant) => {
      runCount += 1;
      return { participant: runParticipant, ok: true, content: "Continued once.", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  // The provider turn has ended (the receipt says so) while the chat is still
  // closing the run's bookkeeping: the continuation is queued, exactly once.
  chatParts(service).activeRuns.rememberActiveChatRun(conversation.id, "run-guardian-active");
  const decision = chatParts(service).codexApprovals.requestCodexApprovalFromCli(
    conversation,
    participant,
    session,
    "run-guardian-active",
    "user-message",
    guardianDeniedRequest("codex-thread-active", Promise.resolve({ turnActive: false }))
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  const pending = (storage.current.metadata.pendingAppToolApprovals as ChatAppToolApproval[])[0];

  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: pending.id,
    approve: true,
    codexDecisionId: "approveRetry"
  });
  assert.deepEqual(await decision, { decision: "approveRetry" });
  await waitFor(() => runCount === 1);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(runCount, 1);
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "approved");
  chatParts(service).activeRuns.forgetActiveChatRun(conversation.id, "run-guardian-active");
});

test("Guardian delivery failure keeps the compact decision and creates an explicit participant error", async () => {
  const participant = chatParticipant("codex-cli");
  participant.agentMode = "auto";
  const conversation = chatConversation([participant]);
  let runCount = 0;
  const { service, storage } = testService({
    conversation,
    run: async (runParticipant) => {
      runCount += 1;
      return { participant: runParticipant, ok: true, content: "Unexpected.", durationMs: 1 };
    }
  });
  const session: ChatParticipantSession = {
    participantId: participant.id,
    sessionId: "codex-thread-failed-delivery",
    roleConfigId: ROLE.id,
    roleConfigVersion: ROLE.version,
    roleLabel: ROLE.label,
    roleInstructions: ROLE.instructions,
    roleAppToolCapabilities: ROLE.appToolCapabilities,
    participantKind: "codex-cli",
    participantAgentMode: "auto",
    participantPermissions: participant.permissions,
    updatedAt: NOW
  };
  let rejectDelivery!: (error: Error) => void;
  const delivery = new Promise<CodexServerRequestDelivery>((_resolve, reject) => { rejectDelivery = reject; });
  void delivery.catch(() => undefined);
  const decision = chatParts(service).codexApprovals.requestCodexApprovalFromCli(
    conversation,
    participant,
    session,
    "run-guardian-failed-delivery",
    "user-message",
    guardianDeniedRequest("codex-thread-failed-delivery", delivery)
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  const pending = (storage.current.metadata.pendingAppToolApprovals as ChatAppToolApproval[])[0];

  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: pending.id,
    approve: true,
    codexDecisionId: "approveRetry"
  });
  assert.deepEqual(await decision, { decision: "approveRetry" });
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "approved");
  rejectDelivery(new Error("app-server pipe closed"));
  await waitFor(() => storage.current.messages.some((message: ChatMessage) =>
    message.role === "participant" && message.status === "error" && /could not continue/i.test(message.content)
  ));
  assert.equal(runCount, 0);
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "approved");
});

test("Codex approval becomes non-actionable when its app-server request is cancelled", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  const session: ChatParticipantSession = {
    participantId: participant.id,
    sessionId: "codex-thread-1",
    roleConfigId: ROLE.id,
    roleConfigVersion: ROLE.version,
    roleLabel: ROLE.label,
    roleInstructions: ROLE.instructions,
    roleAppToolCapabilities: ROLE.appToolCapabilities,
    participantKind: "codex-cli",
    participantAgentMode: "auto",
    participantPermissions: participant.permissions,
    updatedAt: NOW
  };
  const controller = new AbortController();
  const decision = chatParts(service).codexApprovals.requestCodexApprovalFromCli(
    conversation,
    participant,
    session,
    "run-codex-stop",
    "user-message",
    {
      id: "request-stop",
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "codex-thread-1",
        turnId: "turn-1",
        itemId: "item-file",
        startedAtMs: 1,
        grantRoot: "/tmp/scratch"
      },
      signal: controller.signal,
      responseDelivered: Promise.resolve({ turnActive: false })
    }
  );
  controller.abort(new Error("Stopped by user."));
  await assert.rejects(decision, /Stopped by user/);
  await new Promise<void>((resolve) => setImmediate(resolve));

  const approval = (storage.current.metadata.pendingAppToolApprovals as ChatAppToolApproval[])[0];
  assert.equal(approval.status, "cancelled");
  assert.match(approval.error ?? "", /Stopped by user/);
  await assert.rejects(
    () => service.respondToAppToolApproval({
      conversationId: conversation.id,
      approvalId: approval.id,
      approve: true,
      codexDecisionId: "accept"
    }),
    /already been answered/
  );
});

test("stale Codex approval is expired when a conversation is hydrated after restart", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant], {
    pendingAppToolApprovals: [{
      id: "stale-codex-approval",
      conversationId: "conversation",
      requesterParticipantId: participant.id,
      requesterHandle: participant.handle,
      requesterRoleConfigId: participant.roleConfigId,
      toolName: "codex_auto_review_approval",
      capability: "permissions.request",
      status: "pending",
      request: {
        kind: "codexApproval",
        method: "item/commandExecution/requestApproval",
        requestId: 9,
        threadId: "codex-thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        action: "command",
        command: "git push origin main",
        options: [
          { id: "accept", label: "Allow once", outcome: "approve" },
          { id: "decline", label: "Deny", outcome: "deny" }
        ]
      },
      summary: "Codex wants to run a protected command.",
      createdAt: NOW,
      updatedAt: NOW
    } satisfies ChatAppToolApproval]
  });
  const { service, storage } = testService({ conversation });

  await service.hydrateContextUsage(conversation);

  const approval = (storage.current.metadata.pendingAppToolApprovals as ChatAppToolApproval[])[0];
  assert.equal(approval.status, "expired");
  assert.match(approval.error ?? "", /connection.*no longer active/i);
});

function guardianDeniedRequest(threadId: string, responseDelivered: Promise<CodexServerRequestDelivery>): {
  id: string;
  method: "item/autoApprovalReview/denied";
  params: Record<string, unknown>;
  signal: AbortSignal;
  responseDelivered: Promise<CodexServerRequestDelivery>;
} {
  return {
    id: `guardian:${threadId}`,
    method: "item/autoApprovalReview/denied",
    params: {
      threadId,
      turnId: `turn:${threadId}`,
      startedAtMs: 100,
      completedAtMs: 200,
      reviewId: `review:${threadId}`,
      targetItemId: `item:${threadId}`,
      decisionSource: "agent",
      review: { status: "denied", riskLevel: "high", userAuthorization: "low", rationale: "Not authorized" },
      action: { type: "command", source: "unifiedExec", command: "git push origin main", cwd: "/tmp/scratch" }
    },
    signal: new AbortController().signal,
    responseDelivered
  };
}
