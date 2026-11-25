import assert from "node:assert/strict";
import test from "node:test";
import type { HubFeedResponse, HubOp } from "../shared/hubOps";
import { answerOf, artifactOp, createChat, hub, id, type Identity } from "./hubOps/test/hubOpsFixtures";

test("documents: a stale revision is refused with the current version, and a signature stays bound to the version it was made on", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  await h.write(h.owner, createChat(chat));
  const created = answerOf(await h.write(h.owner, artifactOp("artifact.create", chat, "user", { name: "Spec", content: "One", requiredSigners: ["box"], contributors: ["box"] })));
  assert.equal(created.ok, true, JSON.stringify(created));
  const artifactId = created.value!.summary!.id;
  const v1 = created.value!.version!;
  // The machine's member signs v1, bound to its identity and body.
  const signed = await h.write(h.machine, artifactOp("artifact.sign", chat, "box", { artifactId, version: 1, versionEventId: v1.versionEventId, contentHash: v1.contentHash }));
  assert.equal(signed.body.results[0].status, "accepted");
  assert.equal(answerOf(signed).value!.summary === undefined, true, "a signature answers with the summary itself");
  assert.equal((answerOf(signed).value as unknown as { approval: { state: string } }).approval.state, "approved");
  const v2 = answerOf(await h.write(h.owner, artifactOp("artifact.revise", chat, "user", { artifactId, baseVersion: 1, content: "Two" }))).value!;
  assert.equal(v2.summary!.headVersion, 2);
  assert.equal(v2.summary!.approval.state, "unsigned", "a new version starts unsigned");
  // A revision on a base that moved is refused, carrying the current version.
  const stale = await h.write(h.machine, artifactOp("artifact.revise", chat, "box", { artifactId, baseVersion: 1, content: "Late" }));
  assert.equal(stale.body.results[0].status, "rejected");
  assert.equal(answerOf(stale).error?.code, "stale_version");
  assert.equal(answerOf(stale).error?.currentVersion, 2);
  assert.equal(answerOf(stale).error?.current?.content, "Two");
  // A signature naming v1's identity for "the current version" is refused.
  const mismatched = await h.write(h.machine, artifactOp("artifact.sign", chat, "box", { artifactId, versionEventId: v1.versionEventId, contentHash: v1.contentHash }));
  assert.equal(answerOf(mismatched).error?.code, "stale_version");
  // What the server holds: v1 keeps its signature, v2 has none.
  const state = await h.call<{ artifact: { signatures: Array<{ versionEventId: string; signer: string }>; projection: Array<{ version: number; versionEventId: string }> } }>(
    h.machine, "GET", `/v3/artifact?artifactId=${artifactId}`);
  assert.equal(state.status, 200);
  assert.deepEqual(state.body.artifact.signatures.map((row) => [row.signer, row.versionEventId]), [["box", v1.versionEventId]]);
  assert.deepEqual(state.body.artifact.projection.map((row) => row.version), [1, 2]);
  const body = await h.call<{ revision: { content: string; contentHash: string } }>(h.machine, "GET", `/v3/artifact?artifactId=${artifactId}&revision=${v1.versionEventId}`);
  assert.equal(body.body.revision.content, "One");
  assert.equal(body.body.revision.contentHash, v1.contentHash);
  // A document the server does not have is said so in an answer (a device
  // never takes a failed request to mean a document is gone).
  const missing = await h.call<{ artifact?: unknown; head: number }>(h.machine, "GET", `/v3/artifact?artifactId=missing-document`);
  assert.equal(missing.status, 200);
  assert.equal(missing.body.artifact, undefined);
  const listed = await h.call<{ artifacts: Array<{ record: { id: string } }> }>(h.phone, "GET", `/v3/artifacts?conversationId=${chat}`);
  assert.deepEqual(listed.body.artifacts.map((item) => item.record.id), [artifactId]);
});

test("documents: who may act is the server's to decide — the User from her devices, a member only from the device it runs on", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  await h.write(h.owner, createChat(chat));
  const cases: Array<[string, Identity, string, string]> = [
    ["the machine as the User", h.machine, "user", "rejected"],
    ["the machine for a member of the computer", h.machine, "desk", "rejected"],
    ["the computer for a member of the machine", h.owner, "box", "rejected"],
    ["the machine for its own member", h.machine, "box", "accepted"],
    ["the computer for its own member", h.owner, "desk", "accepted"],
    ["the phone as the User", h.phone, "user", "accepted"]
  ];
  for (const [label, device, actor, expected] of cases) {
    const result = await h.write(device, artifactOp("artifact.create", chat, actor, { name: `Doc ${label}`, content: "x" }));
    assert.equal(result.body.results[0].status, expected, label);
    if (expected === "rejected") assert.equal(answerOf(result).error?.code, "access_denied", label);
  }
  // A request naming another chat, or holding a NUL, is not read at all.
  const crossed = await h.write(h.owner, { opId: id("op"), kind: "artifact.create", conversationId: chat, actor: "user",
    request: { conversationId: "another-chat", name: "x", content: "x" } } as unknown as HubOp);
  assert.match((crossed.body.results[0] as { reason: string }).reason, /another chat/);
  const nul = await h.write(h.owner, artifactOp("artifact.create", chat, "user", { name: "x", content: "a\u0000b" }));
  assert.match((nul.body.results[0] as { reason: string }).reason, /NUL/);
});

test("documents: the computer's one-time move keeps every row as it was; a body that does not match its hash is refused, and a second move changes nothing", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  await h.write(h.owner, createChat(chat));
  const at = new Date().toISOString();
  const record = { id: "moved-plan", conversationId: chat, name: "Moved", owner: "user", contributors: [], requiredSigners: ["desk"], labels: [],
    lifecycle: "published", allowedDraftAuthors: [], requiredDraftAuthors: [], audiencePolicyByAuthor: {}, draftRosterRevision: 0, headVersion: 1,
    createdAt: at, updatedAt: at };
  const { createHash } = await import("node:crypto");
  const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
  const rows = {
    artifacts: [record],
    revisions: [
      { artifactId: "moved-plan", versionEventId: "rev-1", originalVersion: 1, contentHash: hash("Body"), content: "Body", author: "user", createdAt: at },
      { artifactId: "moved-plan", versionEventId: "rev-bad", originalVersion: 2, baseVersionEventId: "rev-1", contentHash: hash("Promised"), content: "Different", author: "user", createdAt: at }
    ],
    projection: [{ artifactId: "moved-plan", version: 1, versionEventId: "rev-1" }],
    signatures: [{ artifactId: "moved-plan", versionEventId: "rev-1", contentHash: hash("Body"), signer: "desk", signedAt: at }]
  };
  const byMachine = await h.write(h.machine, { opId: id("op"), kind: "artifact.import", conversationId: chat, rows } as unknown as HubOp);
  assert.equal(byMachine.body.results[0].status, "rejected", "only the computer that held the documents moves them");
  const moved = await h.write(h.owner, { opId: id("op"), kind: "artifact.import", conversationId: chat, rows } as unknown as HubOp);
  assert.equal(moved.body.results[0].status, "accepted");
  assert.deepEqual((answerOf(moved).value as { refused: string[] }).refused.length, 1, "the revision whose body does not match is refused");
  const state = (await h.call<{ artifact: { record: { name: string }; revisions: Array<{ versionEventId: string }>; signatures: Array<{ signer: string }> } }>(
    h.owner, "GET", "/v3/artifact?artifactId=moved-plan")).body.artifact;
  assert.equal(state.record.name, "Moved");
  assert.deepEqual(state.revisions.map((revision) => revision.versionEventId), ["rev-1"]);
  assert.deepEqual(state.signatures.map((signature) => signature.signer), ["desk"]);
  const head = (await h.call<HubFeedResponse>(h.owner, "GET", "/v3/feed?after=0")).body.head;
  const feed = (await h.call<HubFeedResponse>(h.owner, "GET", "/v3/feed?after=0")).body.entries.filter((entry) => entry.effect.kind === "artifact.import");
  assert.deepEqual(feed.map((entry) => (entry.effect as { artifactIds: string[] }).artifactIds), [["moved-plan"]]);
  // A second move of the same rows keeps what the server holds.
  const again = await h.write(h.owner, { opId: id("op"), kind: "artifact.import", conversationId: chat, rows: { ...rows, artifacts: [{ ...record, name: "Renamed meanwhile" }] } } as unknown as HubOp);
  assert.equal(again.body.results[0].status, "accepted");
  assert.equal((await h.call<{ artifact: { record: { name: string } } }>(h.owner, "GET", "/v3/artifact?artifactId=moved-plan")).body.artifact.record.name, "Moved");
  assert.ok((await h.call<HubFeedResponse>(h.owner, "GET", "/v3/feed?after=0")).body.head >= head);
});

test("documents: a chat deleted on the server takes its documents with it, and no late write brings them back", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  await h.write(h.owner, createChat(chat));
  const created = answerOf(await h.write(h.owner, artifactOp("artifact.create", chat, "user", { name: "Doomed", content: "x" })));
  const artifactId = created.value!.summary!.id;
  assert.equal((await h.write(h.owner, { opId: id("op"), kind: "conversation.delete", conversationId: chat })).body.results[0].status, "accepted");
  assert.equal((await h.call<{ artifact?: unknown }>(h.owner, "GET", `/v3/artifact?artifactId=${artifactId}`)).body.artifact, undefined);
  const late = await h.write(h.machine, artifactOp("artifact.create", chat, "box", { name: "Late", content: "x" }));
  assert.equal(late.body.results[0].status, "rejected");
  assert.deepEqual((await h.call<{ artifacts: unknown[] }>(h.owner, "GET", `/v3/artifacts?conversationId=${chat}`)).body.artifacts, []);
});
