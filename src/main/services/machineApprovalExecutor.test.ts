import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { StorageService } from "./storage";
import { MachineApprovalExecutor, SCRIPT_CODE_APPROVED_ON_DESKTOP, cardAnswerKey } from "./machineApprovalExecutor";
import type { ChatApprovalExecutionGuard } from "./chat";
import type { HubCard } from "../../shared/hubOps";
import { APP_SCRIPTS_REQUEST_CHANGE_TOOL } from "../../shared/appMcpToolContracts";
import type { ChatAppToolApproval, Conversation } from "../../shared/types";

/**
 * The User's answer to a permission card, from the User's server, applied by
 * the device the card's member runs on: once per answer, never repeated
 * across a restart, and never manufactured when it could not be admitted.
 * (The whole path, with a real server, is chat.cards.test.)
 */

const desktop = "device-desktop";

function answered(answer: Record<string, unknown>, patch: Partial<HubCard> = {}): HubCard {
  return {
    cardId: "approval", conversationId: "chat", cardKind: "permission", participantId: "member", raisedBy: desktop, raisedAt: "2026-10-28T08:00:00.000Z",
    card: {}, state: "answered", answer, answeredBy: "device-phone", answeredAt: "2026-10-28T08:01:00.000Z", ...patch
  };
}

test("an answer applies once across duplicate deliveries and a restart; another answer to the same approval is refused", async () => {
  const f = await fixture();
  try {
    const card = answered({ approve: true });
    const results = await Promise.all([f.executor.apply(card), f.executor.apply(card)]);
    assert.deepEqual(results, [{ kind: "applied" }, { kind: "applied" }]);
    assert.equal(f.applied(), 1);
    assert.equal((await f.storage.nativeCommands().approvalEffect("chat", "approval"))?.eventId, cardAnswerKey(card));
    // Read again after a restart (its settle not sent yet): the claim it
    // took is all that is known of it, and nothing is repeated.
    f.restart();
    const again = await f.executor.apply(card);
    assert.equal(again.kind, "uncertain");
    assert.equal(f.applied(), 1);
    // An answer of a later life of the card (asked again) cannot override it.
    const later = await f.executor.apply(answered({ approve: false }, { answeredAt: "2026-10-28T08:05:00.000Z" }));
    assert.equal(later.kind, "refused");
    assert.equal(f.applied(), 1);
  } finally { await f.close(); }
});

test("an answer refused before its claim consumes nothing: the card is asked again and a later answer applies", async () => {
  const f = await fixture();
  try {
    const invalid = await f.executor.apply(answered({ approve: true, codexDecisionId: "invalid" }));
    assert.deepEqual(invalid, { kind: "refused", reason: "Select a valid native option." });
    assert.equal(await f.storage.nativeCommands().approvalEffect("chat", "approval"), undefined);
    const malformed = await f.executor.apply(answered({ allow: "yes" }));
    assert.equal(malformed.kind, "refused");
    const valid = await f.executor.apply(answered({ approve: true }, { answeredAt: "2026-10-28T08:09:00.000Z" }));
    assert.deepEqual(valid, { kind: "applied" });
    assert.equal(f.applied(), 1);
  } finally { await f.close(); }
});

test("a full disk before the claim, or a machine shutting down, admits nothing and keeps the answer for later", async () => {
  const f = await fixture();
  try {
    const card = answered({ approve: true });
    await f.sql("create trigger reject_claim before insert on native_approval_effects begin select raise(abort, 'SQLITE_FULL'); end;");
    assert.equal((await f.executor.apply(card)).kind, "retry");
    assert.equal(f.applied(), 0);
    await f.sql("drop trigger reject_claim;");
    f.setCanApply(false);
    const held = await f.executor.apply(card);
    assert.equal(held.kind, "retry");
    assert.match((held as { reason: string }).reason, /shutting down/);
    assert.equal(f.applied(), 0);
    assert.equal(await f.storage.nativeCommands().approvalEffect("chat", "approval"), undefined);
    f.setCanApply(true);
    assert.deepEqual(await f.executor.apply(card), { kind: "applied" });
    assert.equal(f.applied(), 1);
  } finally { await f.close(); }
});

test("process loss after the claim reports uncertainty and never repeats its input", async () => {
  const f = await fixture();
  try {
    const card = answered({ approve: true });
    f.failAfterClaim(true);
    const lost = await f.executor.apply(card);
    assert.equal(lost.kind, "uncertain");
    f.failAfterClaim(false);
    f.restart();
    assert.equal((await f.executor.apply(card)).kind, "uncertain");
    assert.equal(f.applied(), 0, "the provider was never told twice (here: never confirmed)");
  } finally { await f.close(); }
});

test("only the desktop that shows a script's code approves one that installs code; any device may decline it", async () => {
  const f = await fixture({ script: true });
  try {
    const byPhone = await f.executor.apply(answered({ approve: true }));
    assert.deepEqual(byPhone, { kind: "refused", reason: SCRIPT_CODE_APPROVED_ON_DESKTOP });
    assert.equal(await f.storage.nativeCommands().approvalEffect("chat", "approval"), undefined, "nothing claimed");
    assert.deepEqual(await f.executor.apply(answered({ approve: true }, { answeredBy: desktop, answeredAt: "2026-10-28T08:03:00.000Z" })), { kind: "applied" });
    assert.equal(f.applied(), 1);
  } finally { await f.close(); }
  const declined = await fixture({ script: true });
  try {
    assert.deepEqual(await declined.executor.apply(answered({ approve: false })), { kind: "applied" }, "a phone may decline it");
  } finally { await declined.close(); }
});

async function fixture(options: { script?: boolean } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-approval-executor-"));
  const storage = new StorageService({ dbPath: path.join(dir, "chat.sqlite3") });
  await storage.init();
  let applied = 0, instance = 1, canApply = true, failAfterClaim = false;
  const approval = {
    id: "approval", conversationId: "chat", requesterParticipantId: "member", status: "pending",
    ...(options.script ? { toolName: APP_SCRIPTS_REQUEST_CHANGE_TOOL, request: { kind: "script-change", op: "create" } } : { toolName: "app_tool_permission" })
  } as ChatAppToolApproval;
  const conversation = { id: "chat", metadata: { pendingAppToolApprovals: [approval] } } as unknown as Conversation;
  const create = () => new MachineApprovalExecutor({
    storage, canApply: () => canApply, nativeProcessDbPath: path.join(dir, "native.sqlite3"), codeApprover: () => desktop,
    runtimeIdentity: async () => ({ runtimeId: `runtime-${instance}`, pid: 2_000_000_000, startedAt: "absent-process" }),
    chat: { respondToAppToolApproval: async (request, _progress, execution?: ChatApprovalExecutionGuard) => {
      if (request.codexDecisionId === "invalid") throw new Error("Select a valid native option.");
      await execution!.beforeApply(approval);
      assert.equal(execution?.awaitNativeDelivery, true);
      if (failAfterClaim) throw new Error("The provider went away before confirming.");
      applied++;
      approval.status = request.approve ? "approved" : "denied";
      return conversation;
    } }
  });
  let executor = create();
  return { storage, get executor() { return executor; }, applied: () => applied,
    setCanApply: (value: boolean) => { canApply = value; },
    failAfterClaim: (value: boolean) => { failAfterClaim = value; },
    restart: () => { instance++; executor = create(); },
    sql: (sql: string) => (storage as any).runSql(sql),
    close: () => rm(dir, { recursive: true, force: true })
  };
}
