import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { HubOps } from "../../hub/hubOps";
import { StorageService } from "./storage";
import type { HubOp, HubOpResult } from "../../shared/hubOps";
import type { HubDevice } from "../../shared/hubProtocol";
import type { ArtifactReadResult, ArtifactResult } from "../../shared/types";

/** An operation as a test writes it (its id chosen when absent). */
type OpDraft = Record<string, unknown> & { kind: string; conversationId: string; opId?: string };

/**
 * The User's server decides every document change (agreement Д9): the change
 * and its place in the server's order (the feed every device reads) are one
 * commit. A device never learns of a change that did not happen, and never
 * misses one that did.
 */
async function harness(t: test.TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-artifact-atomic-"));
  const storage = new StorageService({ dbPath: path.join(dir, "hub.sqlite3") });
  await storage.init();
  await storage.hub().setOwner({ deviceId: "desktop-device", publicKeyDerBase64: "key", name: "Desktop", addedAt: new Date().toISOString() });
  const ops = new HubOps(storage);
  const owner = (await storage.hub().devices()).find((device) => device.role === "owner") as HubDevice;
  t.after(() => rm(dir, { recursive: true, force: true }));
  let counter = 0;
  const write = async (op: OpDraft): Promise<HubOpResult> =>
    (await ops.apply(owner, { ops: [{ opId: op.opId ?? `op-${++counter}`, ...op }] })).results[0];
  const created = await write({ kind: "conversation.create", conversationId: "chat",
    conversation: { title: "Plans", kind: "chat", createdAt: new Date().toISOString(),
      metadata: { participants: [{ id: "p-drew", handle: "drew", label: "Drew" }] } } });
  assert.equal(created.status, "accepted");
  const entries = async (after = 0) => (await storage.hubOps().after(after, 500, 4 * 1024 * 1024)).entries;
  const outbox = async () => storage.sqlExecutor().queryJson<{ id: string }>("select id from artifact_event_outbox;");
  return { storage, ops, owner, write, entries, outbox };
}

function value<T>(result: HubOpResult): T {
  const answer = result.artifact?.result as ArtifactResult<T> | undefined;
  assert.ok(answer?.ok, `expected an answer that succeeded: ${JSON.stringify(result)}`);
  return answer.value;
}

test("a revision and its place in the server's order are one commit, and its note moves from the outbox into the feed", async (t) => {
  const h = await harness(t);
  const created = value<ArtifactReadResult>(await h.write({ kind: "artifact.create", conversationId: "chat", actor: "user",
    request: { conversationId: "chat", name: "plan", content: "v1", requiredSigners: ["drew"] } }));
  const before = await h.ops.head();
  const revised = await h.write({ opId: "op-revise", kind: "artifact.revise", conversationId: "chat", actor: "user",
    request: { conversationId: "chat", artifactId: created.summary.id, baseVersion: 1, content: "v2" } });
  assert.equal(revised.status, "accepted");
  const read = value<ArtifactReadResult>(revised);
  assert.equal(read.lifecycle === "published" && read.version.content, "v2");

  const placed = (await h.entries(before)).filter((entry) => entry.opId === "op-revise");
  assert.equal(placed.length, 1, "the revision's place in the order was written with it");
  const effect = placed[0].effect as { kind: string; artifactId: string; note?: { content: string } };
  assert.equal(effect.kind, "artifact.revise");
  assert.equal(effect.artifactId, created.summary.id);
  assert.match(effect.note?.content ?? "", /revised .*v2/);
  const stored = await h.ops.artifacts.store.getVersion(created.summary.id, 2);
  assert.equal(stored?.content, "v2");
  assert.deepEqual(await h.outbox(), [], "the note left the server's outbox with its feed entry");
});

test("a refused revision places nothing: nothing announces a change that did not happen", async (t) => {
  const h = await harness(t);
  const created = value<ArtifactReadResult>(await h.write({ kind: "artifact.create", conversationId: "chat", actor: "user",
    request: { conversationId: "chat", name: "plan", content: "v1", contributors: ["drew"] } }));
  await h.write({ kind: "artifact.revise", conversationId: "chat", actor: "user",
    request: { conversationId: "chat", artifactId: created.summary.id, baseVersion: 1, content: "v2" } });
  const head = await h.ops.head();
  // A second author still holding v1 as its base: refused by the rules.
  const stale = await h.write({ opId: "op-stale", kind: "artifact.revise", conversationId: "chat", actor: "drew",
    request: { conversationId: "chat", artifactId: created.summary.id, baseVersion: 1, content: "v2-stale" } });
  assert.equal(stale.status, "rejected");
  const answer = stale.artifact?.result as ArtifactResult<unknown>;
  assert.equal(answer.ok, false);
  assert.equal(!answer.ok && answer.error.code, "stale_version");
  assert.equal(!answer.ok && answer.error.current?.content, "v2", "the refusal carries the current version to redo the change on");
  assert.equal(await h.ops.head(), head, "a refused change has no place in the order");
  assert.equal((await h.storage.hubOps().accepted(["op-stale"])).size, 0);
  assert.equal(await h.ops.artifacts.store.getVersion(created.summary.id, 3), undefined);
});

test("a commit that fails leaves neither the change nor its place, and the same operation succeeds when sent again", async (t) => {
  const h = await harness(t);
  const created = value<ArtifactReadResult>(await h.write({ kind: "artifact.create", conversationId: "chat", actor: "user",
    request: { conversationId: "chat", name: "plan", content: "v1" } }));
  const head = await h.ops.head();
  // The order cannot be written: the whole commit rolls back, revision included.
  await h.storage.sqlExecutor().runSql(`create trigger reject_hub_op before insert on hub_ops
    begin select raise(abort, 'SQLITE_FULL injected'); end;`);
  const revise = { opId: "op-retried", kind: "artifact.revise", conversationId: "chat", actor: "user",
    request: { conversationId: "chat", artifactId: created.summary.id, baseVersion: 1, content: "v2" } } as unknown as HubOp;
  await assert.rejects(h.ops.apply(h.owner, { ops: [revise] }));
  assert.equal(await h.ops.artifacts.store.getVersion(created.summary.id, 2), undefined, "the revision must not survive its place failing");
  assert.equal(await h.ops.head(), head);

  await h.storage.sqlExecutor().runSql("drop trigger reject_hub_op;");
  const again = (await h.ops.apply(h.owner, { ops: [revise] })).results[0];
  assert.equal(again.status, "accepted", "the device simply sends it again");
  assert.equal((await h.ops.artifacts.store.getVersion(created.summary.id, 2))?.content, "v2");
  const duplicate = (await h.ops.apply(h.owner, { ops: [revise] })).results[0];
  assert.equal(duplicate.status, "duplicate", "and once more it is the same operation, not a third version");
  assert.equal(duplicate.status === "duplicate" && duplicate.seq, again.status === "accepted" && again.seq);
  assert.equal(value<ArtifactReadResult>(duplicate).summary.headVersion, 2, "with the answer it had");
});

test("a signature and its place commit together; signing again places nothing and writes no second note", async (t) => {
  const h = await harness(t);
  const created = value<ArtifactReadResult>(await h.write({ kind: "artifact.create", conversationId: "chat", actor: "user",
    request: { conversationId: "chat", name: "plan", content: "v1", requiredSigners: ["drew"] } }));
  const before = await h.ops.head();
  const signed = await h.write({ opId: "op-sign", kind: "artifact.sign", conversationId: "chat", actor: "drew",
    request: { conversationId: "chat", artifactId: created.summary.id } });
  assert.equal(signed.status, "accepted");
  const placed = await h.entries(before);
  assert.deepEqual(placed.map((entry) => entry.opId), ["op-sign"]);
  assert.match((placed[0].effect as { note?: { content: string } }).note?.content ?? "", /signed .*v1 \(fully approved\)/);

  const again = await h.write({ opId: "op-sign-again", kind: "artifact.sign", conversationId: "chat", actor: "drew",
    request: { conversationId: "chat", artifactId: created.summary.id } });
  assert.equal(again.status, "accepted", "the signature is already there: the answer is the same summary");
  assert.deepEqual((await h.entries(before)).map((entry) => entry.opId), ["op-sign"], "nothing new is placed, so no second note");
  assert.deepEqual(await h.outbox(), []);
});
