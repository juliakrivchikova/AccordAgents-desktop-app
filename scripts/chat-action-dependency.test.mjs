/**
 * A revision has to reach a machine that has never held the artifact, and a
 * signature made on a revision that machine never received has to have a way
 * of getting it — not an endless wait.
 *
 * Two real device channels, two real SQLite stores, a real ArtifactService on
 * the desktop side and a real ArtifactStore on the machine side. Nothing about
 * the transport is stubbed except the wire between them, which is a function
 * here instead of a relay.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { StorageService } from "../dist/main/main/services/storage.js";
import { ChatEventLogService } from "../dist/main/main/services/chatEventLog.js";
import { DeviceEventChannel } from "../dist/main/main/services/deviceEventChannel.js";
import { ChatActionApplier } from "../dist/main/main/services/chatActionApplier.js";
import { ArtifactStore } from "../dist/main/main/services/artifactStore.js";
import { ArtifactService } from "../dist/main/main/services/artifacts.js";
import { artifactNameKey } from "../dist/main/shared/artifacts.js";

const CONVERSATION = "chat-1";
const MEMBERS = ["user", "drew", "gera"];

async function world() {
  const directory = await mkdtemp(path.join(tmpdir(), "accord-action-dependency-"));
  const desktopStorage = new StorageService({ dbPath: path.join(directory, "desktop.sqlite3") });
  const machineStorage = new StorageService({ dbPath: path.join(directory, "machine.sqlite3") });
  const desktopLog = new ChatEventLogService(desktopStorage);
  const machineLog = new ChatEventLogService(machineStorage);
  const [desktopId, machineId] = await Promise.all([
    desktopLog.getOrCreateDeviceIdentity(), machineLog.getOrCreateDeviceIdentity()
  ]);
  const desktopArtifacts = new ArtifactStore(path.join(directory, "desktop-artifacts.sqlite3"));
  const machineArtifacts = new ArtifactStore(path.join(directory, "machine-artifacts.sqlite3"));
  await Promise.all([desktopArtifacts.init(), machineArtifacts.init()]);

  // Held revision events, so the machine can be put in the position of a peer
  // that was not there when a revision was published.
  const withheld = new Set();
  const wire = [];
  const packets = { toMachine: [], toDesktop: [] };
  const applied = [];
  const unavailable = [];

  const desktopService = new ArtifactService({
    store: desktopArtifacts,
    getMembers: async () => MEMBERS,
    emitAction: async (action) => {
      await desktop.publish({ conversationId: action.conversationId, kind: action.kind, payload: action.payload,
        eventId: `chat-action:${action.payload.operationId}`, sharedScope: true });
    },
    hasEmittedAction: async (eventId) => Boolean(await desktopStorage.getChatEvent(eventId))
  });

  const desktop = new DeviceEventChannel({
    storage: desktopStorage, eventLog: desktopLog, channelId: "room",
    localDeviceId: desktopId.originId, peerDeviceId: machineId.originId,
    peerPublicKeyDerBase64: machineId.publicKeyDerBase64,
    // The wire is a queue, not a function call: a relay never delivers inside
    // the sender's own turn, and neither does this.
    send: async (packet) => {
      packets.toMachine.push(packet);
      // Held at delivery, not at send: an event queued a moment earlier must
      // not slip past the machine while it is still meant to be missing it.
      wire.push(() => (packet.type === "event" && withheld.has(packet.event.eventId))
        ? Promise.resolve() : machine.receive(packet));
    },
    serveDependency: async (dependency) => dependency.targetKey.startsWith("artifact:")
      && desktopService.emitRevisionActionFor(dependency.targetKey.slice("artifact:".length), dependency.stateId),
    apply: async () => "applied",
    onError: () => undefined
  });

  const machine = new DeviceEventChannel({
    storage: machineStorage, eventLog: machineLog, channelId: "room",
    localDeviceId: machineId.originId, peerDeviceId: desktopId.originId,
    peerPublicKeyDerBase64: desktopId.publicKeyDerBase64,
    send: async (packet) => { packets.toDesktop.push(packet); wire.push(() => desktop.receive(packet)); },
    onDependencyUnavailable: (dependency) => { unavailable.push(dependency); },
    apply: async (event, payload) => {
      const outcome = await applier.apply(event, payload);
      applied.push(outcome);
      if (outcome.status !== "deferred") return "applied";
      return outcome.dependency ? { deferred: true, dependency: outcome.dependency } : "deferred";
    },
    onError: () => undefined
  });

  const applier = new ChatActionApplier({
    artifacts: {
      getRevision: async (artifactId, versionEventId) => {
        const revision = await machineArtifacts.getRevision(artifactId, versionEventId);
        return revision ? { version: revision.version, contentHash: revision.contentHash, superseded: revision.superseded } : undefined;
      },
      insertSignature: (record) => machineArtifacts.insertSignature(record),
      hasArtifact: async (artifactId) => Boolean(await machineArtifacts.getById(artifactId)),
      createArtifact: async (request) => {
        await machineArtifacts.insertArtifact({
          id: request.artifactId, conversationId: request.conversationId, name: request.name,
          owner: request.owner, contributors: request.contributors, requiredSigners: request.requiredSigners,
          labels: request.labels, lifecycle: "published", allowedDraftAuthors: [], requiredDraftAuthors: [],
          audiencePolicyByAuthor: {}, draftRosterRevision: 0, headVersion: request.revision.version,
          createdAt: request.createdAt, updatedAt: request.revision.createdAt
        }, artifactNameKey(request.name), {
          artifactId: request.artifactId, version: request.revision.version,
          versionEventId: request.revision.versionEventId, content: request.revision.content,
          author: request.revision.author, note: request.revision.note, createdAt: request.revision.createdAt
        });
      },
      retainRevision: (request) => machineArtifacts.retainProjectedRevision({
        artifactId: request.artifactId, versionEventId: request.versionEventId,
        baseVersionEventId: request.baseVersionEventId, version: request.version,
        content: request.content, contentHash: "", author: request.author,
        note: request.note, createdAt: request.createdAt
      })
    }
  });

  desktop.start();
  machine.start();
  const settle = async () => {
    for (let round = 0; round < 40; round += 1) {
      await desktop.flush();
      await machine.flush();
      const pending = wire.splice(0, wire.length);
      for (const deliver of pending) await deliver().catch(() => undefined);
      await new Promise((resolve) => setImmediate(resolve));
      if (!pending.length && !wire.length && round > 2) return;
    }
  };
  return {
    publishAction: (action) => desktop.publish({
      conversationId: action.conversationId, kind: action.kind, payload: action.payload,
      eventId: `chat-action:${action.payload.operationId}`, sharedScope: true
    }),
    desktopService, desktopArtifacts, machineArtifacts, withheld, packets, applied, unavailable, settle,
    cleanup: async () => {
      desktop.close(); machine.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

test("a machine that never held the artifact receives it, its revision and the signature on it", async () => {
  const w = await world();
  try {
    const created = await w.desktopService.create("user", {
      conversationId: CONVERSATION, name: "plan", content: "first draft", requiredSigners: ["gera"]
    });
    assert.ok(created.ok, created.ok ? "" : created.error);
    await w.settle();

    const artifactId = created.value.summary.id;
    const here = await w.machineArtifacts.getById(artifactId);
    assert.ok(here, "the artifact itself has to exist on the machine, not only the event");
    assert.equal(here.name, "plan");
    const revisions = await w.machineArtifacts.listVersionMetas(artifactId);
    assert.equal(revisions.length, 1);
    const revision = await w.machineArtifacts.getRevision(artifactId, revisions[0].versionEventId);
    assert.equal(revision.content, "first draft", "the body travelled with the action");

    const signed = await w.desktopService.sign("gera", { conversationId: CONVERSATION, artifactId });
    assert.ok(signed.ok, signed.ok ? "" : signed.error);
    await w.settle();
    const signatures = await w.machineArtifacts.listSignatures(artifactId);
    assert.equal(signatures.length, 1, "the signature applied because its revision was already here");
    assert.equal(signatures[0].signer, "gera");
  } finally { await w.cleanup(); }
});

test("a signature on a revision the machine never received asks for it, and then applies", async () => {
  const w = await world();
  try {
    const created = await w.desktopService.create("user", {
      conversationId: CONVERSATION, name: "plan", content: "v1", contributors: ["drew"], requiredSigners: ["gera"]
    });
    const artifactId = created.value.summary.id;
    await w.settle();

    // A revision made on another machine: the desktop holds it, this machine
    // is not a recipient of that machine's stream and never sees the event.
    const v1 = (await w.desktopArtifacts.listVersionMetas(artifactId))[0].versionEventId;
    const v2 = "revision-from-another-machine";
    await w.desktopArtifacts.retainProjectedRevision({
      artifactId, versionEventId: v2, baseVersionEventId: v1, version: 2,
      content: "v2", contentHash: "", author: "drew", createdAt: "2026-09-07T10:00:00.000Z"
    });
    await w.settle();
    assert.equal(await w.machineArtifacts.getRevision(artifactId, v2), undefined, "the machine really does not have it");

    // The signature on it is made here, and does reach the machine.
    const signed = await w.desktopService.sign("gera", { conversationId: CONVERSATION, artifactId });
    assert.ok(signed.ok, signed.ok ? "" : JSON.stringify(signed));
    await w.settle();
    assert.ok(
      w.applied.some((outcome) => outcome.status === "deferred" && outcome.dependency?.stateId === v2),
      `it is held, and it names what it is waiting for: ${JSON.stringify(w.applied)}`
    );
    assert.ok(
      w.packets.toDesktop.some((packet) => packet.type === "need" && packet.dependency.stateId === v2),
      "the machine asks the desktop for exactly that revision"
    );

    // Which the desktop serves out of its own artifact store, so the held
    // signature finally has something to attach to.
    await w.settle();
    const arrived = await w.machineArtifacts.getRevision(artifactId, v2);
    assert.ok(arrived, "the revision it asked for arrived");
    assert.equal(arrived.content, "v2");
    const signatures = await w.machineArtifacts.listSignatures(artifactId);
    assert.equal(signatures.length, 1, "the held signature applied once its revision was here");
    assert.equal(signatures[0].versionEventId, v2);
  } finally { await w.cleanup(); }
});

test("a dependency nobody can produce is answered, not left hanging", async () => {
  const w = await world();
  try {
    const created = await w.desktopService.create("user", {
      conversationId: CONVERSATION, name: "plan", content: "v1", requiredSigners: ["gera"]
    });
    await w.settle();
    const artifactId = created.value.summary.id;
    // A signature made on a revision that exists nowhere.
    await w.desktopService.recoverActionEvents(CONVERSATION);
    w.applied.length = 0;
    await w.publishAction({
      conversationId: CONVERSATION,
      kind: "artifact.signature.added",
      payload: {
        operationId: `artifact-signature:${artifactId}:missing-revision:gera`,
        targetKey: `artifact:${artifactId}`,
        signer: "gera", signedStateId: "missing-revision", signedContentHash: "nope"
      }
    });
    await w.settle();
    await w.settle();
    assert.ok(
      w.unavailable.some((dependency) => dependency.stateId === "missing-revision"),
      "the machine is told plainly that it will not be getting it"
    );
    assert.deepEqual(await w.machineArtifacts.listSignatures(artifactId), [], "and nothing was invented in its place");
  } finally { await w.cleanup(); }
});
