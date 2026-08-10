import assert from "node:assert/strict";
import test from "node:test";
import { codexAppServerMessageKind } from "./cliAgents";
import {
  CODEX_GUARDIAN_DENIED_APPROVAL_METHOD,
  CODEX_GUARDIAN_TIMED_OUT_APPROVAL_METHOD,
  codexGuardianAssessmentEvent,
  codexApprovalCancellationResult,
  prepareCodexApproval,
  redactCodexApprovalText,
  validateCodexApprovalCorrelation
} from "./codexApprovals";

test("classifies app-server method plus id as a server request, not a response", () => {
  assert.equal(codexAppServerMessageKind({ id: 7, method: "item/commandExecution/requestApproval", params: {} }), "server-request");
  assert.equal(codexAppServerMessageKind({ id: 7, result: {} }), "response");
  assert.equal(codexAppServerMessageKind({ method: "turn/started", params: {} }), "notification");
});

test("command approval exposes only the v2 decisions advertised by Codex", () => {
  const amendment = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "push"] } };
  const prepared = prepareCodexApproval({
    id: 41,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      startedAtMs: 1,
      approvalId: "callback-1",
      environmentId: null,
      command: "git push origin main",
      cwd: "/tmp/scratch",
      availableDecisions: ["accept", amendment, "decline"]
    }
  });

  assert.deepEqual(prepared.request.options.map((option) => option.label), [
    "Allow once",
    "Allow and update command policy",
    "Deny"
  ]);
  assert.equal(prepared.request.options.some((option) => option.label.includes("chat")), false);
  assert.deepEqual(prepared.responseByOptionId.get("accept"), { decision: "accept" });
  assert.deepEqual(prepared.responseByOptionId.get("acceptWithExecpolicyAmendment-1"), { decision: amendment });
});

test("command approval uses the installed string union when availableDecisions is absent", () => {
  const prepared = prepareCodexApproval({
    id: 42,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      startedAtMs: 1,
      environmentId: null,
      command: "git push origin main"
    }
  });

  assert.deepEqual([...prepared.responseByOptionId.values()], [
    { decision: "accept" },
    { decision: "acceptForSession" },
    { decision: "decline" },
    { decision: "cancel" }
  ]);
});

test("present malformed or unusable availableDecisions fail closed", () => {
  const base = {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    startedAtMs: 1,
    environmentId: null,
    command: "git push origin main"
  };
  const duplicateAmendment = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "push"] } };
  for (const availableDecisions of [
    [],
    ["futureDecision"],
    ["accept", "accept"],
    [duplicateAmendment, duplicateAmendment],
    [{ acceptWithExecpolicyAmendment: {} }]
  ]) {
    assert.throws(() => prepareCodexApproval({
      id: 43,
      method: "item/commandExecution/requestApproval",
      params: { ...base, availableDecisions }
    }), /availableDecisions|execpolicy_amendment/);
  }
});

test("approval correlation requires the active thread and turn", () => {
  const params = {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    startedAtMs: 1,
    environmentId: null
  };
  assert.deepEqual(validateCodexApprovalCorrelation(
    "item/commandExecution/requestApproval",
    params,
    "thread-1",
    "turn-1"
  ), { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", approvalId: undefined });
  assert.throws(() => validateCodexApprovalCorrelation(
    "item/commandExecution/requestApproval",
    params,
    "wrong-thread",
    "turn-1"
  ), /belongs to thread/);
  assert.throws(() => validateCodexApprovalCorrelation(
    "item/commandExecution/requestApproval",
    params,
    "thread-1",
    "wrong-turn"
  ), /belongs to turn/);
  assert.throws(() => validateCodexApprovalCorrelation(
    "item/commandExecution/requestApproval",
    { ...params, unexpected: true },
    "thread-1",
    "turn-1"
  ), /unsupported fields/);
});

test("approval display projections redact credentials and expose safe structured context", () => {
  const canary = "sk-proj-SUPERSECRET123456";
  const networkDecision = { applyNetworkPolicyAmendment: { network_policy_amendment: { host: `api.example?token=${canary}`, action: "allow" } } };
  const prepared = prepareCodexApproval({
    id: 44,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      startedAtMs: 1,
      environmentId: null,
      command: `curl -H 'Authorization: Bearer ${canary}' https://example.com`,
      cwd: `/tmp/${canary}`,
      reason: `token=${canary}`,
      networkApprovalContext: { host: `api.example?token=${canary}`, protocol: "https" },
      commandActions: [{ type: "read", command: `cat /tmp/${canary}`, name: "cat", path: `/tmp/${canary}` }],
      proposedNetworkPolicyAmendments: [{ host: `api.example?token=${canary}`, action: "allow" }],
      availableDecisions: [networkDecision, "decline"]
    }
  });
  const serialized = JSON.stringify(prepared.request);
  assert.equal(serialized.includes(canary), false);
  assert.match(serialized, /••••/);
  assert.equal(prepared.request.commandActions?.[0].type, "read");
  assert.equal(prepared.request.networkProtocol, "https");
  assert.match(prepared.request.options[0].detail ?? "", /Network policy/);
  assert.equal(redactCodexApprovalText(`--api-key ${canary}`).includes(canary), false);
});

test("file approval uses the installed v2 file decision union", () => {
  const prepared = prepareCodexApproval({
    id: "request-file",
    method: "item/fileChange/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-file",
      startedAtMs: 1,
      reason: "Write outside the current root",
      grantRoot: "/tmp/scratch"
    }
  });

  assert.deepEqual([...prepared.responseByOptionId.values()], [
    { decision: "accept" },
    { decision: "acceptForSession" },
    { decision: "decline" },
    { decision: "cancel" }
  ]);
});

test("permission approval returns a grant profile while refusal returns an empty turn grant", () => {
  const permissions = {
    network: { enabled: true },
    fileSystem: { read: ["/tmp/read"], write: ["/tmp/write"] }
  };
  const prepared = prepareCodexApproval({
    id: 11,
    method: "item/permissions/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-permission",
      environmentId: null,
      startedAtMs: 1,
      cwd: "/tmp/scratch",
      reason: "Need network and file access",
      permissions
    }
  });

  assert.deepEqual(prepared.responseByOptionId.get("turn"), { permissions, scope: "turn" });
  assert.deepEqual(prepared.responseByOptionId.get("session"), { permissions, scope: "session" });
  assert.deepEqual(prepared.responseByOptionId.get("deny"), { permissions: {}, scope: "turn" });
});

test("Stop uses each method's supported cancellation encoding", () => {
  assert.deepEqual(codexApprovalCancellationResult("item/commandExecution/requestApproval"), { decision: "cancel" });
  assert.deepEqual(codexApprovalCancellationResult("item/fileChange/requestApproval"), { decision: "cancel" });
  assert.deepEqual(codexApprovalCancellationResult("item/permissions/requestApproval"), { permissions: {}, scope: "turn" });
  assert.deepEqual(codexApprovalCancellationResult("execCommandApproval"), { decision: "abort" });
});

test("legacy file approval keeps paths and change kinds but drops patch contents", () => {
  const prepared = prepareCodexApproval({
    id: 19,
    method: "applyPatchApproval",
    params: {
      conversationId: "thread-legacy",
      callId: "call-1",
      reason: "Apply changes",
      grantRoot: null,
      fileChanges: {
        "/tmp/secret.txt": { type: "update", unified_diff: "SECRET_VALUE", move_path: null }
      }
    }
  });

  assert.deepEqual(prepared.request.fileChanges, [{ path: "/tmp/secret.txt", change: "update" }]);
  assert.equal(JSON.stringify(prepared.request).includes("SECRET_VALUE"), false);
});

test("legacy command display preserves argv boundaries instead of ambiguous joining", () => {
  const prepared = prepareCodexApproval({
    id: 20,
    method: "execCommandApproval",
    params: {
      conversationId: "thread-legacy",
      callId: "call-command",
      approvalId: null,
      command: ["printf", "two words", "quote\"inside"],
      cwd: "/tmp",
      reason: null,
      parsedCmd: []
    }
  });
  assert.equal(prepared.request.command, '"printf" "two words" "quote\\"inside"');
});

test("Guardian notifications serialize the exact core envelope and every action variant", () => {
  const notification = (action: Record<string, unknown>) => ({
    threadId: "thread-guardian",
    turnId: "turn-guardian",
    startedAtMs: 100,
    completedAtMs: 200,
    reviewId: "review-guardian",
    targetItemId: "item-guardian",
    decisionSource: "agent",
    review: {
      status: "denied",
      riskLevel: "high",
      userAuthorization: "medium",
      rationale: "The action was not authorized."
    },
    action
  });
  const variants: Array<[Record<string, unknown>, Record<string, unknown>]> = [
    [
      { type: "command", source: "unifiedExec", command: "git push origin main", cwd: "/tmp/repo" },
      { type: "command", source: "unified_exec", command: "git push origin main", cwd: "/tmp/repo" }
    ],
    [
      { type: "execve", source: "shell", program: "git", argv: ["git", "push"], cwd: "/tmp/repo" },
      { type: "execve", source: "shell", program: "git", argv: ["git", "push"], cwd: "/tmp/repo" }
    ],
    [
      { type: "applyPatch", cwd: "/tmp/repo", files: ["/tmp/repo/a.ts"] },
      { type: "apply_patch", cwd: "/tmp/repo", files: ["/tmp/repo/a.ts"] }
    ],
    [
      { type: "networkAccess", target: "proxy.example:1080", host: "proxy.example", protocol: "socks5Tcp", port: 1080 },
      { type: "network_access", target: "proxy.example:1080", host: "proxy.example", protocol: "socks5_tcp", port: 1080 }
    ],
    [
      { type: "mcpToolCall", server: "github", toolName: "push", connectorId: "connector-1", connectorName: "GitHub", toolTitle: "Push" },
      { type: "mcp_tool_call", server: "github", tool_name: "push", connector_id: "connector-1", connector_name: "GitHub", tool_title: "Push" }
    ],
    [
      {
        type: "requestPermissions",
        reason: "Need a generated directory",
        permissions: {
          network: { enabled: true },
          fileSystem: {
            read: null,
            write: ["/tmp/generated"],
            globScanMaxDepth: 4,
            entries: [{ path: { type: "glob_pattern", pattern: "/tmp/generated/**" }, access: "write" }]
          }
        }
      },
      {
        type: "request_permissions",
        reason: "Need a generated directory",
        permissions: {
          network: { enabled: true },
          file_system: {
            read: null,
            write: ["/tmp/generated"],
            glob_scan_max_depth: 4,
            entries: [{ path: { type: "glob_pattern", pattern: "/tmp/generated/**" }, access: "write" }]
          }
        }
      }
    ]
  ];

  for (const [wireAction, serializedAction] of variants) {
    const event = codexGuardianAssessmentEvent(notification(wireAction));
    assert.deepEqual(event, {
      type: "guardian_assessment",
      id: "review-guardian",
      target_item_id: "item-guardian",
      turn_id: "turn-guardian",
      started_at_ms: 100,
      completed_at_ms: 200,
      status: "denied",
      risk_level: "high",
      user_authorization: "medium",
      rationale: "The action was not authorized.",
      decision_source: "agent",
      action: serializedAction
    });
  }
});

test("Guardian approval persists only a bounded projection and offers one retry or keep denied", () => {
  const prepared = prepareCodexApproval({
    id: "guardian:review-1",
    method: CODEX_GUARDIAN_DENIED_APPROVAL_METHOD,
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      startedAtMs: 10,
      completedAtMs: 20,
      reviewId: "review-1",
      targetItemId: "item-1",
      decisionSource: "agent",
      review: { status: "denied", riskLevel: "high", userAuthorization: "low", rationale: "Not authorized" },
      action: { type: "networkAccess", target: "proxy.example:1080", host: "proxy.example", protocol: "socks5Udp", port: 1080 }
    }
  });

  assert.deepEqual(prepared.request.options.map((option) => option.label), ["Approve one retry", "Keep denied"]);
  assert.deepEqual(prepared.responseByOptionId.get("approveRetry"), { decision: "approveRetry" });
  assert.equal(prepared.request.networkTarget, "proxy.example:1080");
  assert.equal(prepared.request.guardianRiskLevel, "high");
  assert.equal(JSON.stringify(prepared.request).includes("guardian_assessment"), false);
  assert.equal(JSON.stringify(prepared.request).includes("startedAtMs"), false);
});

test("Guardian exact event is unbounded, keeps null target ids, and timeout is terminal", () => {
  const rationale = `exact-${"x".repeat(3_000)}`;
  const params = {
    threadId: "thread-1",
    turnId: "turn-1",
    startedAtMs: 10,
    completedAtMs: 20,
    reviewId: "review-timeout",
    targetItemId: null,
    decisionSource: "agent",
    review: { status: "denied", riskLevel: null, userAuthorization: null, rationale },
    action: { type: "command", source: "shell", command: "echo safe", cwd: "/tmp" }
  };
  const event = codexGuardianAssessmentEvent(params);
  assert.equal(event.target_item_id, null);
  assert.equal(event.rationale, rationale);
  const timedOut = prepareCodexApproval({
    id: "guardian-timeout:review-timeout",
    method: CODEX_GUARDIAN_TIMED_OUT_APPROVAL_METHOD,
    params: { ...params, review: { ...params.review, status: "timedOut" } }
  });
  assert.deepEqual(timedOut.request.options, []);
  assert.deepEqual(codexApprovalCancellationResult(CODEX_GUARDIAN_TIMED_OUT_APPROVAL_METHOD), { decision: "keepDenied" });
});
