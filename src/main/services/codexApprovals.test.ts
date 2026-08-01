import assert from "node:assert/strict";
import test from "node:test";
import { codexAppServerMessageKind } from "./cliAgents";
import {
  codexApprovalCancellationResult,
  prepareCodexApproval
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
      approvalId: "callback-1",
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

test("file approval uses the installed v2 file decision union", () => {
  const prepared = prepareCodexApproval({
    id: "request-file",
    method: "item/fileChange/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-file",
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
      fileChanges: {
        "/tmp/secret.txt": { type: "update", unified_diff: "SECRET_VALUE", move_path: null }
      }
    }
  });

  assert.deepEqual(prepared.request.fileChanges, [{ path: "/tmp/secret.txt", change: "update" }]);
  assert.equal(JSON.stringify(prepared.request).includes("SECRET_VALUE"), false);
});
