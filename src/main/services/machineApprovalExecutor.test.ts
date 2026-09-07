import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { StorageService } from "./storage";
import { ChatEventLogService } from "./chatEventLog";
import { MachineApprovalExecutor, machineApprovalResultId } from "./machineApprovalExecutor";
import type { MachineApprovalDecisionBody, MachineApprovalResultBody } from "../../shared/machineLink";
import type { ChatApprovalExecutionGuard } from "./chat";
import type { ChatAppToolApproval, Conversation } from "../../shared/types";
import { permissionDecisionAction, chatActionEventId } from "./chatActionEmitter";

test("a canonical permission and a legacy delivery share one durable effect boundary", async () => {
  const f = await fixture();
  try {
    const action = await f.action();
    const first = await f.executor.applyAction(action, action.payload);
    assert.equal(first.ok, true);
    const legacy = await f.decision("legacy-second", false);
    await f.executor.apply(legacy, legacy.payload);
    assert.equal(f.applied(), 1);
    f.restart();
    assert.deepEqual(await f.executor.applyAction(action, action.payload), first);
    assert.equal(f.applied(), 1);
    assert.equal((await f.result("legacy-second"))?.ok, false);
  } finally { await f.close(); }
});

test("restart recovers a recorded local answer whose native execution never began", async () => {
  const f = await fixture();
  try {
    const event = await f.action();
    f.restart();
    const rows = await f.storage.nativeCommands().pendingApprovalActions(event.originId);
    assert.deepEqual(rows, [{ eventId: event.eventId, originSeq: event.originSeq }]);
    for (const row of rows) {
      const stored = await f.storage.getChatEvent(row.eventId);
      await f.executor.applyAction(stored!, stored!.payload as import("../../shared/chatActionEvents").ChatActionPayload);
    }
    assert.equal(f.applied(), 1);
    assert.equal((await f.storage.nativeCommands().pendingApprovalActions(event.originId)).length, 1,
      "the execution receipt is also repaired after its write was lost");
    await new ChatEventLogService(f.storage).appendLocalEvent({ conversationId: event.conversationId,
      logScopeId: "chat:actions", eventId: "chat-action:receipt:approval:approval", kind: "execution.receipt", payload: {} });
    assert.deepEqual(await f.storage.nativeCommands().pendingApprovalActions(event.originId), []);
  } finally { await f.close(); }
});

test("canonical decision retries a failed receipt without reapplying, and survives result delivery loss", async () => {
  const f = await fixture();
  try {
    const event = await f.action();
    await f.sql("create trigger reject_result before insert on chat_events when new.kind = 'machine.approval.result' begin select raise(abort, 'SQLITE_FULL'); end;");
    await assert.rejects(f.executor.applyAction(event, event.payload), /SQLITE_FULL/);
    await assert.rejects(f.executor.applyAction(event, event.payload), /SQLITE_FULL/);
    assert.equal(f.applied(), 1);
    await f.sql("drop trigger reject_result;");
    const result = await f.executor.applyAction(event, event.payload);
    assert.equal(result.ok, true);
    f.restart();
    assert.deepEqual(await f.executor.applyAction(event, event.payload), result);
    assert.equal(f.applied(), 1);
  } finally { await f.close(); }
});

test("canonical claim failure never reaches the provider and remains retryable", async () => {
  const f = await fixture();
  try {
    const event = await f.action();
    await f.sql("create trigger reject_claim before insert on native_approval_effects begin select raise(abort, 'SQLITE_FULL'); end;");
    await assert.rejects(f.executor.applyAction(event, event.payload), /SQLITE_FULL/);
    assert.equal(f.applied(), 0);
    assert.equal(await f.result(event.eventId), undefined);
    await f.sql("drop trigger reject_claim;");
    assert.equal((await f.executor.applyAction(event, event.payload)).ok, true);
    assert.equal(f.applied(), 1);
  } finally { await f.close(); }
});

test("an approval effect executes once across duplicate decisions and executor restart", async () => {
  const f = await fixture();
  try {
    const event = await f.decision("first");
    await Promise.all([f.executor.apply(event, event.payload), f.executor.apply(event, event.payload)]);
    f.restart();
    await f.executor.apply(event, event.payload);
    assert.equal(f.applied(), 1);
    assert.equal((await f.result("first"))?.ok, true);
    const later = await f.decision("later", false);
    await f.executor.apply(later, later.payload);
    assert.equal(f.applied(), 1);
    assert.match((await f.result("later"))?.error ?? "", /already been answered/);
    assert.equal((await f.result("later"))?.uncertain, undefined);
  } finally { await f.close(); }
});

test("a full disk before the approval claim admits nothing; an invalid answer does not consume the approval", async () => {
  const f = await fixture();
  try {
    const invalid = await f.decision("invalid", true, "invalid");
    await f.executor.apply(invalid, invalid.payload);
    assert.equal((await f.result("invalid"))?.ok, false);
    assert.equal(await f.storage.nativeCommands().approvalEffect("chat", "approval"), undefined);
    const valid = await f.decision("valid");
    await f.sql("create trigger reject_claim before insert on native_approval_effects begin select raise(abort, 'SQLITE_FULL'); end;");
    await assert.rejects(f.executor.apply(valid, valid.payload));
    assert.equal(f.applied(), 0);
    await f.sql("drop trigger reject_claim;");
    await f.executor.apply(valid, valid.payload);
    assert.equal(f.applied(), 1);
  } finally { await f.close(); }
});

test("a failed result write retains the exact response without repeating the native effect", async () => {
  const f = await fixture();
  try {
    const event = await f.decision("write-full");
    await f.sql("create trigger reject_result before insert on chat_events when new.kind = 'machine.approval.result' begin select raise(abort, 'SQLITE_FULL'); end;");
    await assert.rejects(f.executor.apply(event, event.payload));
    await assert.rejects(f.executor.apply(event, event.payload));
    assert.equal(f.applied(), 1);
    await f.sql("drop trigger reject_result;");
    await f.executor.apply(event, event.payload);
    assert.equal((await f.result("write-full"))?.ok, true);
    assert.equal(f.applied(), 1);
  } finally { await f.close(); }
});

test("shutdown before admission leaves the approval queued without an effect", async () => {
  const f = await fixture();
  try {
    const event = await f.decision("shutdown");
    f.setCanApply(false);
    await assert.rejects(f.executor.apply(event, event.payload), /shutting down/);
    assert.equal(f.applied(), 0);
    assert.equal(await f.storage.nativeCommands().approvalEffect("chat", "approval"), undefined);
    assert.equal(await f.result("shutdown"), undefined);
    f.setCanApply(true);
    await f.executor.apply(event, event.payload);
    assert.equal(f.applied(), 1);
  } finally { await f.close(); }
});

test("a receipt id occupied by another event is never taken as proof of execution", async () => {
  const f = await fixture();
  try {
    const event = await f.decision("collision");
    await new ChatEventLogService(f.storage).appendLocalEvent({ conversationId: "chat", logScopeId: "results",
      eventId: machineApprovalResultId(event.eventId), kind: "unrelated", payload: {} });
    await assert.rejects(f.executor.apply(event, event.payload), /inconsistent ownership/);
    assert.equal(f.applied(), 0);
  } finally { await f.close(); }
});

test("process loss after an approval claim reports uncertainty and never repeats its input", async () => {
  const f = await fixture();
  try {
    const event = await f.decision("lost");
    await f.sql("create trigger reject_result before insert on chat_events when new.kind = 'machine.approval.result' begin select raise(abort, 'SQLITE_FULL'); end;");
    await assert.rejects(f.executor.apply(event, event.payload));
    f.restart();
    await f.sql("drop trigger reject_result;");
    await f.executor.apply(event, event.payload);
    assert.equal(f.applied(), 1);
    assert.equal((await f.result("lost"))?.ok, false);
    assert.equal((await f.result("lost"))?.uncertain, true);
  } finally { await f.close(); }
});

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-approval-executor-"));
  const storage = new StorageService({ dbPath: path.join(dir, "chat.sqlite3") });
  const log = new ChatEventLogService(storage);
  const deviceId = (await log.getOrCreateDeviceIdentity()).originId;
  let applied = 0, instance = 1, canApply = true;
  const approval = { id: "approval", conversationId: "chat", requesterParticipantId: "member", status: "pending" } as ChatAppToolApproval;
  const conversation = { id: "chat", metadata: { pendingAppToolApprovals: [approval] } } as unknown as Conversation;
  const create = () => new MachineApprovalExecutor({
    storage, deviceId, canApply: () => canApply, getConversation: async () => conversation, nativeProcessDbPath: path.join(dir, "native.sqlite3"),
    runtimeIdentity: async () => ({ runtimeId: `runtime-${instance}`, pid: 2_000_000_000, startedAt: "absent-process" }),
    chat: { respondToAppToolApproval: async (request, _progress, execution?: ChatApprovalExecutionGuard) => {
      if (request.codexDecisionId === "invalid") throw new Error("Select a valid native option.");
      await execution!.beforeApply(approval);
      assert.equal(execution?.awaitNativeDelivery, true);
      applied++;
      approval.status = request.approve ? "approved" : "denied";
      return conversation;
    } },
    publish: async body => { await log.appendLocalEvent({ conversationId: "chat", logScopeId: "results", kind: body.type,
      eventId: machineApprovalResultId(body.decisionId!), payload: body }); }
  });
  let executor = create();
  return { storage, get executor() { return executor; }, applied: () => applied,
    setCanApply: (value: boolean) => { canApply = value; },
    restart: () => { instance++; executor = create(); },
    action: async () => {
      const action = permissionDecisionAction({ conversationId: "chat", approvalId: "approval", approve: true,
        decisionId: "native-allow", scope: "once" });
      return (await log.appendLocalEvent({ ...action, logScopeId: "chat:actions", eventId: chatActionEventId(action.payload.operationId) })).event;
    },
    decision: async (id: string, approve = true, codexDecisionId?: string) => (await log.appendLocalEvent<MachineApprovalDecisionBody>({
      conversationId: "chat", logScopeId: "decisions", kind: "machine.approval.decision", eventId: id,
      payload: { type: "machine.approval.decision", conversationId: "chat", approvalId: "approval", decisionId: id,
        approve, decidedAt: new Date().toISOString(), ...(codexDecisionId ? { codexDecisionId } : {}) }
    })).event,
    result: async (id: string) => (await storage.getChatEvent(machineApprovalResultId(id)))?.payload as MachineApprovalResultBody | undefined,
    sql: (sql: string) => (storage as any).runSql(sql),
    close: () => rm(dir, { recursive: true, force: true })
  };
}
