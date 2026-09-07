import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ArtifactService } from "./artifacts";
import { ArtifactStore } from "./artifactStore";
import { ChatEventLogService } from "./chatEventLog";
import { StorageService } from "./storage";
import { CHAT_ACTION_LOG_SCOPE } from "../../shared/chatActionEvents";

const members = ["user", "drew"];

/** The real wiring: one SQLite file, the real store, the real event log, and
 *  the same atomic path main.ts uses. */
async function harness() {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-artifact-atomic-"));
  const dbPath = path.join(dir, "accordagents.sqlite3");
  const storage = new StorageService({ dbPath });
  await storage.init();
  const store = new ArtifactStore(dbPath, "sqlite3");
  const log = new ChatEventLogService(storage);
  const service = new ArtifactService({
    store,
    getMembers: async () => members,
    hasEmittedAction: async (eventId) => Boolean(await storage.getChatEvent(eventId)),
    emitAction: async () => { throw new Error("the atomic path must be used, not the after-the-fact emission"); },
    commitActionWithChange: (action, write) => log.withPreparedLocalEvent({
      conversationId: action.conversationId,
      logScopeId: CHAT_ACTION_LOG_SCOPE,
      kind: action.kind,
      payload: action.payload,
      eventId: `chat-action:${action.payload.operationId}`
    }, (prepared) => write({
      sql: prepared.sql,
      onlyIfSql: (condition) => prepared.sql ? storage.chatEventAppendSql(prepared.event, {}, condition) : ""
    })).then((outcome) => outcome.result)
  });
  const actionEvents = async () => (await storage.listChatEvents("chat", CHAT_ACTION_LOG_SCOPE)).map((event) => event.kind);
  return { dir, storage, store, service, actionEvents, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("a revision and the event peers learn from are one commit", async () => {
  const h = await harness();
  try {
    const created = await h.service.create("user", { conversationId: "chat", name: "plan", content: "v1", requiredSigners: ["drew"] });
    const artifactId = created.ok ? created.value.summary.id : "";
    const revised = await h.service.revise("user", { conversationId: "chat", artifactId, baseVersion: 1, content: "v2" });
    assert.equal(revised.ok, true, revised.ok ? "" : revised.error.message);

    const events = await h.storage.listChatEvents("chat", CHAT_ACTION_LOG_SCOPE);
    const revision = events.find((event) => event.kind === "artifact.revision.created"
      && (event.payload as { stateId?: string }).stateId !== undefined
      && (event.payload as { precondition?: unknown }).precondition !== undefined);
    assert.ok(revision, "the revision's event was not written with it");
    const written = await h.store.getVersion(artifactId, 2);
    assert.equal((revision.payload as { stateId: string }).stateId, written?.versionEventId,
      "the event names the revision that was actually stored");
    assert.equal((revision.payload as { contentHash: string }).contentHash, written?.contentHash);
  } finally { await h.cleanup(); }
});

test("a refused revision writes no event: nothing announces a change that did not happen", async () => {
  const h = await harness();
  try {
    const created = await h.service.create("user", { conversationId: "chat", name: "plan", content: "v1" });
    const artifactId = created.ok ? created.value.summary.id : "";
    await h.service.revise("user", { conversationId: "chat", artifactId, baseVersion: 1, content: "v2" });
    const before = (await h.actionEvents()).length;

    // A second author still holding v1 as its base: refused by the guard.
    const stale = await h.service.revise("drew", { conversationId: "chat", artifactId, baseVersion: 1, content: "v2-stale" });
    assert.equal(stale.ok, false, "a stale base must be refused");
    assert.equal((await h.actionEvents()).length, before,
      "a refused change must not leave an event claiming it happened");
  } finally { await h.cleanup(); }
});

test("a commit that fails leaves neither the change nor its event", async () => {
  const h = await harness();
  try {
    const created = await h.service.create("user", { conversationId: "chat", name: "plan", content: "v1" });
    const artifactId = created.ok ? created.value.summary.id : "";
    const before = (await h.actionEvents()).length;

    // The event write fails inside the transaction; -bail leaves it open and
    // SQLite rolls the whole thing back, revision included.
    await (h.storage as unknown as { runSql(sql: string): Promise<void> }).runSql(
      `create trigger reject_chat_event before insert on chat_events
       begin select raise(abort, 'SQLITE_FULL injected'); end;`
    );
    await assert.rejects(h.service.revise("user", { conversationId: "chat", artifactId, baseVersion: 1, content: "v2" }));
    assert.equal(await h.store.getVersion(artifactId, 2), undefined,
      "the revision must not survive its event failing");
    assert.equal((await h.actionEvents()).length, before);

    await (h.storage as unknown as { runSql(sql: string): Promise<void> }).runSql("drop trigger reject_chat_event;");
    const retried = await h.service.revise("user", { conversationId: "chat", artifactId, baseVersion: 1, content: "v2" });
    assert.equal(retried.ok, true, "and the User can simply do it again");
    assert.equal((await h.actionEvents()).length, before + 1);
  } finally { await h.cleanup(); }
});

test("a signature and its event commit together", async () => {
  const h = await harness();
  try {
    const created = await h.service.create("user", { conversationId: "chat", name: "plan", content: "v1", requiredSigners: ["drew"] });
    const artifactId = created.ok ? created.value.summary.id : "";
    const before = (await h.actionEvents()).length;
    const signed = await h.service.sign("drew", { conversationId: "chat", artifactId });
    assert.equal(signed.ok, true, signed.ok ? "" : signed.error.message);
    const events = await h.storage.listChatEvents("chat", CHAT_ACTION_LOG_SCOPE);
    const signature = events.find((event) => event.kind === "artifact.signature.added");
    assert.ok(signature, "the signature's event was not written with it");
    assert.equal((await h.actionEvents()).length, before + 1);

    // Signing again is the same operation: no second event.
    await h.service.sign("drew", { conversationId: "chat", artifactId });
    assert.equal((await h.actionEvents()).length, before + 1);
  } finally { await h.cleanup(); }
});
