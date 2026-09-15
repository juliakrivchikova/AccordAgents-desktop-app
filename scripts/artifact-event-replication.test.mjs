import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { StorageService } from "../dist/main/main/services/storage.js";
import { ArtifactStore } from "../dist/main/main/services/artifactStore.js";
import { ArtifactService } from "../dist/main/main/services/artifacts.js";
import { ChatEventLogService } from "../dist/main/main/services/chatEventLog.js";
import { ChatActionApplier } from "../dist/main/main/services/chatActionApplier.js";
import { DeviceEventChannel } from "../dist/main/main/services/deviceEventChannel.js";
import { artifactEventWriter, artifactProjectionPort } from "../dist/main/main/services/artifactReplication.js";

const chat = "artifact-event-chat";
const members = ["user", "drew", "taylor", "other"];
const ok = result => { assert.equal(result.ok, true, result.error?.message); return result.value; };

async function world() {
  const directory = await mkdtemp(path.join(tmpdir(), "accord-artifact-events-"));
  async function peer(name) {
    const dbPath = path.join(directory, name + ".sqlite3");
    const storage = new StorageService({ dbPath });
    await storage.init();
    const store = new ArtifactStore(dbPath);
    await store.init();
    const log = new ChatEventLogService(storage);
    const identity = await log.getOrCreateDeviceIdentity();
    return { storage, store, log, identity, changed: [] };
  }
  const peers = [await peer("cloud"), await peer("desktop")];
  const wire = [];
  const errors = [];
  function connect(index) {
    const p = peers[index];
    const other = peers[1 - index];
    p.service = new ArtifactService({ store: p.store, getMembers: async id => id === chat ? members : undefined,
      ...artifactEventWriter(p.storage, p.log, () => [{ deviceId: other.identity.originId, channelId: "artifacts" }], p.store) });
    p.applier = new ChatActionApplier({ artifacts: artifactProjectionPort(p.store, id => p.changed.push(id)) });
    p.channel = new DeviceEventChannel({ storage: p.storage, eventLog: p.log, channelId: "artifacts",
      localDeviceId: p.identity.originId, peerDeviceId: other.identity.originId, peerPublicKeyDerBase64: other.identity.publicKeyDerBase64,
      send: async packet => { wire.push(() => other.channel.receive(packet)); },
      apply: async (event, payload) => {
        const result = await p.applier.apply(event, payload);
        return result.status === "deferred" ? "deferred" : "applied";
      }, onError: error => errors.push(error)
    });
  }
  peers.forEach((_, index) => connect(index));
  return { cloud: peers[0], desktop: peers[1],
    async restart(index) {
      peers[index].channel.close();
      Object.assign(peers[index], await peer(index === 0 ? "cloud" : "desktop"));
      connect(index);
    },
    async settle() {
      for (const p of peers) await p.channel.flush();
      for (let round = 0; wire.length && round < 200; round++) await wire.shift()();
      assert.deepEqual(errors, []);
      assert.equal(wire.length, 0);
    },
    async events(p = peers[0]) {
      const events = await p.storage.listChatEvents(chat, "chat:actions");
      return Promise.all(events.map(async event => ({ ...event, payload: await p.storage.deviceEventBlobs().hydrate(event.payload) })));
    },
    async close() { for (const p of peers) p.channel.close(); await rm(directory, { recursive: true, force: true }); }
  };
}

test("cloud creation, every version and signatures reach a desktop with an already open panel", async () => {
  const w = await world();
  try {
    const first = ok(await w.cloud.service.create("drew", { conversationId: chat, name: "Resolution", content: "v1", contributors: ["taylor"], requiredSigners: ["drew", "taylor"] }));
    const request = { conversationId: chat, artifactId: first.summary.id };
    await w.settle();
    assert.equal(ok(await w.desktop.service.read("user", request)).version.content, "v1");
    assert.ok(w.desktop.changed.includes(chat));
    const text = "large full version — ".repeat(6000);
    ok(await w.cloud.service.revise("drew", { ...request, baseVersion: 1, content: text }));
    ok(await w.cloud.service.sign("drew", request));
    ok(await w.cloud.service.sign("taylor", request));
    await w.settle();
    const read = ok(await w.desktop.service.read("user", { ...request, includeHistory: true }));
    assert.equal(read.version.content, text);
    assert.equal(read.history.length, 2);
    assert.equal(read.summary.approval.state, "approved");
    assert.deepEqual(read.version.signatures, ok(await w.cloud.service.read("user", request)).version.signatures);
    for (const event of await w.events()) if (event.kind === "artifact.signature.added") {
      assert.equal(event.payload.revision, undefined);
      assert.equal(event.payload.artifactChange, undefined);
      assert.ok(event.payload.signedStateId && event.payload.signedContentHash && event.payload.signedAt);
    }
    const before = (await w.events()).map(e => e.eventId);
    assert.equal(await w.cloud.service.recoverActionEvents(chat), 0);
    assert.deepEqual((await w.events()).map(e => e.eventId), before);
  } finally { await w.close(); }
});

async function collection(w) {
  const created = ok(await w.cloud.service.create("drew", { conversationId: chat, name: "Draft collection", initialState: "collecting_drafts",
    operationId: "collection", allowedDraftAuthors: ["drew", "taylor"], requiredDraftAuthors: ["drew", "taylor"],
    audiencePolicyByAuthor: { drew: { allowedReaders: ["taylor"], requiredReaders: [] }, taylor: { allowedReaders: ["drew"], requiredReaders: [] } } }));
  return { conversationId: chat, artifactId: created.summary.id };
}

test("submitted drafts contain their complete body, keep reader ACLs, and publication reaches the existing collection", async () => {
  const w = await world();
  try {
    const request = await collection(w);
    await w.settle();
    assert.equal(ok(await w.desktop.service.read("user", request)).lifecycle, "collecting_drafts");
    const sources = [];
    for (const author of ["drew", "taylor"]) {
      const content = author + " draft " + "body ".repeat(9000);
      const draft = ok(await w.cloud.service.saveDraft(author, { ...request, content, readers: [], expectedEditRevision: 0, operationId: "save-" + author }));
      const submitted = ok(await w.cloud.service.submitDraft(author, { ...request, draftId: draft.id, expectedEditRevision: 1, operationId: "submit-" + author }));
      sources.push({ draftId: submitted.id, disposition: "considered" });
      const event = (await w.events()).find(event => event.kind === "artifact.draft.submitted" && event.payload.artifactChange.draft.id === draft.id);
      assert.equal(event.payload.artifactChange.draft.content, content);
      await w.settle();
      assert.equal(ok(await w.desktop.service.readDraft("user", { ...request, draftId: draft.id })).content, content);
      assert.equal((await w.desktop.service.readDraft("other", { ...request, draftId: draft.id })).ok, false);
    }
    ok(await w.cloud.service.publish("drew", { ...request, operationId: "publish", content: "Combined resolution", requiredSigners: ["taylor"], sources }));
    await w.settle();
    const published = ok(await w.desktop.service.read("user", request));
    assert.equal(published.lifecycle, "published");
    assert.equal(published.version.content, "Combined resolution");
    assert.equal(published.sources.length, 2);
    ok(await w.desktop.service.sign("taylor", request));
    await w.settle();
    assert.equal(ok(await w.cloud.service.read("user", request)).summary.approval.state, "approved");
  } finally { await w.close(); }
});

test("a failed event commit also rolls back Submit, and a retry does not lose its body", async () => {
  const w = await world();
  try {
    const request = await collection(w);
    const draft = ok(await w.cloud.service.saveDraft("drew", { ...request, content: "Must survive", readers: [], expectedEditRevision: 0, operationId: "save" }));
    const submit = { ...request, draftId: draft.id, expectedEditRevision: 1, operationId: "submit" };
    await w.cloud.storage.runSql("create trigger fail_artifact_event before insert on chat_events begin select raise(abort, 'disk failure'); end;");
    await assert.rejects(w.cloud.service.submitDraft("drew", submit), error => /disk failure/.test(error.result?.stderr));
    assert.equal((await w.cloud.store.getDraft(draft.id)).state, "editing");
    await w.cloud.storage.runSql("drop trigger fail_artifact_event;");
    ok(await w.cloud.service.submitDraft("drew", submit));
    ok(await w.cloud.service.submitDraft("drew", submit));
    await w.settle();
    assert.equal((await w.events()).filter(e => e.kind === "artifact.draft.submitted").length, 1);
    assert.equal(ok(await w.desktop.service.readDraft("user", { ...request, draftId: draft.id })).content, "Must survive");
  } finally { await w.close(); }
});

test("offline drafts survive restart and repeated delivery, including competing creations", async () => {
  const w = await world();
  try {
    const request = await collection(w);
    await w.settle();
    const first = ok(await w.cloud.service.saveDraft("drew", { ...request, content: "earlier cloud edit", readers: [], expectedEditRevision: 0, operationId: "cloud-edit" }));
    const second = ok(await w.desktop.service.saveDraft("drew", { ...request, content: "later desktop edit", readers: [], expectedEditRevision: 0, operationId: "desktop-edit" }));
    await w.restart(0);
    await w.restart(1);
    await w.settle();
    for (const p of [w.cloud, w.desktop]) {
      assert.equal((await p.store.getDraft(first.id)).state, "editing");
      assert.equal((await p.store.getDraft(second.id)).state, "superseded");
      const rows = await p.store.listDrafts(request.artifactId);
      assert.equal(rows.filter(row => row.state === "editing").length, 1);
      assert.equal(rows.find(row => row.id === second.id).content, "later desktop edit");
    }
    for (const event of await w.events()) await w.desktop.applier.apply(event, event.payload);
    assert.equal((await w.desktop.store.getDraft(first.id)).content, "earlier cloud edit");
  } finally { await w.close(); }
});

test("metadata follows publication and a late signature survives archive without moving versions", async () => {
  const w = await world();
  try {
    const request = await collection(w);
    ok(await w.cloud.service.updateAccess("drew", { ...request, labels: ["before publication"] }));
    const sources = [];
    for (const author of ["drew", "taylor"]) {
      const draft = ok(await w.cloud.service.saveDraft(author, { ...request, content: author, readers: [], expectedEditRevision: 0, operationId: "save-" + author }));
      ok(await w.cloud.service.submitDraft(author, { ...request, draftId: draft.id, expectedEditRevision: 1, operationId: "submit-" + author }));
      sources.push({ draftId: draft.id, disposition: "considered" });
    }
    ok(await w.cloud.service.publish("drew", { ...request, operationId: "publish", content: "Published", requiredSigners: ["taylor"], sources }));
    await w.settle();
    ok(await w.cloud.service.sign("taylor", request));
    // A different peer archives while the signature is still in flight.
    ok(await w.desktop.service.setArchived("user", { ...request, archived: true }));
    await w.settle();
    assert.equal((await w.desktop.store.listSignatures(request.artifactId)).length, 1);
    ok(await w.cloud.service.setArchived("user", { ...request, archived: false }));
    ok(await w.cloud.service.updateAccess("drew", { ...request, requiredSigners: ["drew", "taylor"], labels: ["after publication"] }));
    await w.settle();
    const record = await w.desktop.store.getById(request.artifactId);
    assert.deepEqual(record.requiredSigners, ["drew", "taylor"]);
    assert.deepEqual(record.labels, ["after publication"]);
    assert.equal(record.archivedAt, undefined);
    assert.equal(record.lifecycle, "published");
    await w.restart(1);
    assert.equal(ok(await w.desktop.service.read("user", request)).version.content, "Published");
  } finally { await w.close(); }
});

test("a submitted event alone contains the full readable draft and late saves cannot undo it", async () => {
  const w = await world();
  try {
    const request = await collection(w);
    const content = "z".repeat(512 * 1024);
    const draft = ok(await w.cloud.service.saveDraft("drew", { ...request, content, readers: [], expectedEditRevision: 0, operationId: "save" }));
    ok(await w.cloud.service.submitDraft("drew", { ...request, draftId: draft.id, expectedEditRevision: 1, operationId: "submit" }));
    const events = await w.events();
    const submitted = events.find(event => event.kind === "artifact.draft.submitted");
    await w.desktop.applier.apply(submitted, submitted.payload);
    assert.equal(ok(await w.desktop.service.readDraft("user", { ...request, draftId: draft.id })).content, content);
    for (const event of events) await w.desktop.applier.apply(event, event.payload);
    assert.equal((await w.desktop.store.getDraft(draft.id)).state, "submitted");
    await w.settle();
    assert.equal((await w.desktop.store.getDraft(draft.id)).content, content);
  } finally { await w.close(); }
});

test("receiving publication is atomic and deletion prevents old events resurrecting it", async () => {
  const w = await world();
  try {
    const created = ok(await w.cloud.service.create("drew", { conversationId: chat, name: "Atomic receive", content: "Complete version" }));
    const event = (await w.events())[0];
    await w.desktop.storage.runSql("create trigger fail_revision before insert on artifact_revisions begin select raise(abort, 'disk failure'); end;");
    await assert.rejects(w.desktop.applier.apply(event, event.payload));
    assert.equal(await w.desktop.store.getById(created.summary.id), undefined);
    await w.desktop.storage.runSql("drop trigger fail_revision;");
    await w.desktop.applier.apply(event, event.payload);
    assert.equal((await w.desktop.store.getVersion(created.summary.id, 1)).content, "Complete version");
    const request = await collection(w);
    const draft = ok(await w.cloud.service.saveDraft("drew", { ...request, content: "Deleted", readers: [], expectedEditRevision: 0, operationId: "save" }));
    const events = await w.events();
    await w.desktop.service.deleteConversationArtifacts(chat);
    const saved = events.find(e => e.kind === "artifact.draft.saved");
    assert.equal((await w.desktop.applier.apply(saved, saved.payload)).status, "superseded");
    assert.equal(await w.desktop.store.getDraft(draft.id), undefined);
    assert.equal(await w.desktop.store.getById(request.artifactId), undefined);
  } finally { await w.close(); }
});

test("editing, submitting and withdrawing from the receiving device preserves draft identity", async () => {
  const w = await world();
  try {
    const request = await collection(w);
    const first = ok(await w.cloud.service.saveDraft("drew", { ...request, content: "first", readers: [], expectedEditRevision: 0, operationId: "save" }));
    await w.settle();
    const edited = ok(await w.desktop.service.saveDraft("drew", { ...request, draftId: first.id, content: "edited on desktop", readers: ["taylor"], expectedEditRevision: 1, operationId: "edit" }));
    assert.equal(edited.id, first.id);
    ok(await w.desktop.service.submitDraft("drew", { ...request, draftId: first.id, expectedEditRevision: 2, operationId: "submit" }));
    await w.settle();
    const submitted = await w.cloud.store.getDraft(first.id);
    assert.equal(submitted.content, "edited on desktop");
    assert.equal(submitted.state, "submitted");
    ok(await w.cloud.service.withdrawDraft("drew", { ...request, draftId: first.id, operationId: "withdraw" }));
    await w.settle();
    assert.equal((await w.desktop.store.getDraft(first.id)).state, "withdrawn");
    assert.equal((await w.desktop.store.getDraft(first.id)).content, "edited on desktop");
  } finally { await w.close(); }
});
