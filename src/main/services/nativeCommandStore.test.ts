import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { StorageService } from "./storage";
import { ChatEventLogService } from "./chatEventLog";

const owner = { runtimeId: "runtime-a", pid: 101, startedAt: "stable-process-start" };

test("a native request is durable before admission and two runtime instances cannot execute it twice", async () => {
  const db = await fixture();
  try {
    const command = await db.request("one");
    await db.store.accept(command);
    const other = db.reopen().nativeCommands();
    const claims = await Promise.all([db.store.claim(command.commandId, owner), other.claim(command.commandId, { ...owner, runtimeId: "runtime-b", pid: 202 })]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal((await other.get(command.commandId))?.phase, "claimed");
    assert.equal(await other.claim(command.commandId, owner), undefined, "a restart or duplicate cannot replay claimed input");
    assert.equal((await other.accept(command)).phase, "claimed");
    const next = await db.request("two");
    await other.accept(next);
    const winner = claims.find(Boolean)!;
    const loser = winner.runtimeId === owner.runtimeId ? { ...owner, runtimeId: "runtime-b", pid: 202 } : owner;
    assert.equal(await other.claim(next.commandId, loser), undefined, "one executor owns the whole participant session");
  } finally { await db.close(); }
});

test("Stop retained before its delayed request prevents provider admission across restart", async () => {
  const db = await fixture();
  try {
    const request = await db.request("late");
    const cancel = await db.log.appendLocalEvent({ conversationId: "chat", logScopeId: "stop", kind: "turn.cancel.requested", payload: { runId: request.runId } });
    await db.store.cancel(request.runId, "chat", cancel.event.eventId);
    const restarted = db.reopen().nativeCommands();
    const accepted = await restarted.accept(request);
    assert.equal(accepted.cancelled, true);
    assert.equal(await restarted.claim(request.commandId, owner), undefined);
    assert.equal(await restarted.executor("chat", "member"), undefined, "cancelled queued work does not claim a provider");
  } finally { await db.close(); }
});

test("failed ledger writes do not admit work and a conflicting retry cannot replace a command", async () => {
  const db = await fixture();
  try {
    const request = await db.request("one");
    await db.sql(`create trigger full_ledger before insert on native_commands begin select raise(abort, 'SQLITE_FULL'); end;`);
    await assert.rejects(db.store.accept(request));
    assert.equal(await db.store.get(request.commandId), undefined);
    await db.sql("drop trigger full_ledger;");
    await db.store.accept(request);
    await assert.rejects(db.store.accept({ ...request, participantId: "different" }));
    await db.sql(`create trigger full_claim before update on native_commands begin select raise(abort, 'SQLITE_FULL'); end;`);
    await assert.rejects(db.store.claim(request.commandId, owner));
    assert.equal(await db.store.executor("chat", "member"), undefined, "the executor claim rolls back with the command");
    assert.equal((await db.store.get(request.commandId))?.phase, "queued");
  } finally { await db.close(); }
});

test("only a retained terminal settles a command, and stale recovery cannot release a newer executor", async () => {
  const db = await fixture();
  try {
    const request = await db.request("one");
    await db.store.accept(request);
    await db.store.claim(request.commandId, owner);
    await assert.rejects(db.store.finish(request.commandId), /terminal event is not stored/);
    const executor = (await db.store.executor("chat", "member"))!;
    await db.log.appendLocalEvent({ conversationId: "chat", logScopeId: "terminal", kind: "turn.finished", eventId: request.terminalEventId, payload: { status: "completed" } });
    await db.store.finish(request.commandId);
    assert.equal((await db.reopen().nativeCommands().get(request.commandId))?.phase, "finished");
    assert.equal((await db.store.executor("chat", "member"))?.released, false, "a finished turn does not imply a dead resident process");
    assert.equal(await db.store.releaseVerifiedExecutor(executor), true);
    const next = await db.request("two");
    await db.store.accept(next);
    const claim = await db.store.claim(next.commandId, { ...owner, runtimeId: "runtime-b", pid: 202 });
    assert.equal(claim?.executorGeneration, executor.generation + 1);
    assert.equal(await db.store.releaseVerifiedExecutor(executor), false);
  } finally { await db.close(); }
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "accord-native-commands-"));
  const dbPath = path.join(directory, "state.sqlite3");
  const storage = new StorageService({ dbPath });
  const log = new ChatEventLogService(storage);
  await storage.init();
  return {
    log, store: storage.nativeCommands(), reopen: () => new StorageService({ dbPath }),
    sql: (sql: string): Promise<void> => (storage as any).runSql(sql),
    request: async (suffix: string) => {
      const event = (await log.appendLocalEvent({ conversationId: "chat", logScopeId: "requests", kind: "turn.requested", payload: { text: suffix } })).event;
      return { commandId: `command-${suffix}`, eventId: event.eventId, conversationId: "chat", participantId: "member", runId: `run-${suffix}`, terminalEventId: `terminal-${suffix}` };
    },
    close: () => rm(directory, { recursive: true, force: true })
  };
}
