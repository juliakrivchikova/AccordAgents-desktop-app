/** Real fabric sealing across revocation and persisted identities. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "..");
const { MachinePeerFabric } = require(path.join(repoRoot, "dist/main/main/services/machinePeerFabric.js"));
const { StorageService } = require(path.join(repoRoot, "dist/main/main/services/storage.js"));
const { ChatEventLogService } = require(path.join(repoRoot, "dist/main/main/services/chatEventLog.js"));
const { hubPairChannelId } = require(path.join(repoRoot, "dist/main/main/services/hubChannels.js"));
const { HUB_SCOPE_PREFIXES } = require(path.join(repoRoot, "dist/main/main/services/hubSync.js"));

const { deriveMachineChannelKey } = require(path.join(repoRoot, "dist/main/shared/machineChannelKey.js"));
const { sealMachinePayload, sealChannelPayload, openChannelPayload } =
  require(path.join(repoRoot, "dist/main/main/services/machineChannelSealing.js"));

const ROOM = "sealing-room";
const ROOM_KEY = Buffer.alloc(32, 3).toString("base64url");

function peer(deviceId, publicKeyDerBase64) {
  return {
    deviceId, publicKeyDerBase64, role: "phone", name: "Device",
    // The meeting place on the User's server; the stub client never dials it.
    relayUrl: "ws://127.0.0.1:1", rendezvousId: ROOM, fingerprint: "SEALING"
  };
}

async function fabric(dir) {
  const storage = new StorageService({ dbPath: path.join(dir, "machine.sqlite3") });
  const eventLog = new ChatEventLogService(storage);
  const self = await eventLog.getOrCreateDeviceIdentity();
  // Two devices of the owner, each with a real signing key, because a device
  // id has to be the one its key produces.
  const staysStorage = new StorageService({ dbPath: path.join(dir, "stays.sqlite3") });
  const stays = await new ChatEventLogService(staysStorage).getOrCreateDeviceIdentity();
  const goesStorage = new StorageService({ dbPath: path.join(dir, "goes.sqlite3") });
  const goes = await new ChatEventLogService(goesStorage).getOrCreateDeviceIdentity();

  const sent = [];
  const homeClient = {
    on: () => () => undefined, connect: async () => undefined, close: () => undefined,
    sendCiphertext: async (request) => { sent.push(request); return []; }
  };
  const peers = new MachinePeerFabric({
    selfDeviceId: self.originId,
    storage, eventLog,
    home: {
      version: 1, purpose: "machine-host",
      issuer: { originId: "device-issuer", keyId: "k", publicKeyDerBase64: self.publicKeyDerBase64 },
      rendezvousId: ROOM, stableRoutingId: "route", relaySealKeyBase64: ROOM_KEY,
      hubUrl: "http://127.0.0.1:1", fingerprint: "SEALING",
      capabilities: [], createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString()
    },
    homeClient,
    createClient: () => homeClient,
    isPeerConnected: () => true,
    apply: async () => "applied",
    onError: () => undefined,
    logger: () => undefined
  });
  return { peers, storage, sent, self, stays, staysStorage, goes,
    cleanup: async () => { peers.close(); await rm(dir, { recursive: true, force: true, maxRetries: 5 }); } };
}

test("a device the owner revoked cannot read what the devices that stayed are sent", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-sealing-"));
  const box = await fabric(dir);
  try {
    const stays = peer(box.stays.originId, box.stays.publicKeyDerBase64);
    const goes = peer(box.goes.originId, box.goes.publicKeyDerBase64);
    await box.peers.reconcile([stays, goes]);
    box.peers.start();

    // The owner removes one of them, and the machine publishes afterwards.
    await box.peers.reconcile([stays]);
    assert.equal(box.peers.channel(goes.deviceId), undefined, "the revoked device has no channel here any more");
    box.sent.length = 0;
    const published = await box.peers.channel(stays.deviceId).publish({
      conversationId: "chat", kind: "machine.approval.requested",
      payload: { type: "machine.approval.requested", conversationId: "chat",
        approval: { id: "a1", status: "pending", summary: "Secret work", createdAt: new Date().toISOString() } }
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    // The work reaches the device that stayed only through the server's
    // order: it is in the machine's own log, on that pair's channel, in a
    // scope the machine pushes to the server.
    const own = (await box.storage.hub().ownEventsAfter(box.self.originId, 0, 10_000, [...HUB_SCOPE_PREFIXES])).map((row) => row.event);
    const event = own.find((item) => item.eventId === published.eventId);
    assert.ok(event, "the new work is in the machine's own log, which the server's order carries");
    assert.ok(event.logScopeId.startsWith(`device:${hubPairChannelId(box.self.originId, stays.deviceId)}:`), event.logScopeId);
    // Nothing of it goes over the room, and nobody, the revoked device least
    // of all, is kept a delivery row the machine would later re-offer.
    assert.equal(box.sent.length, 0, "durable work never travels over the room");
    for (const deviceId of [stays.deviceId, goes.deviceId]) {
      assert.deepEqual(await box.storage.deviceEvents().listPendingHeaders(hubPairChannelId(box.self.originId, deviceId), 0, deviceId), []);
    }

    // What the room still carries (a hello, progress) the machine seals for
    // the one device it answers. The revoked device still holds its private
    // key and the machine's public key, and once held the room key every
    // device used to share: neither opens a frame sealed for a device that stayed.
    const frame = await sealMachinePayload({ to: stays.deviceId, body: "Secret work" }, box.self, stays.publicKeyDerBase64, ROOM);
    await assert.rejects(() => openChannelPayload(frame, deriveMachineChannelKey(box.goes, box.self.publicKeyDerBase64, ROOM)),
      "a revoked device must not open what a device that stayed was sent");
    await assert.rejects(() => openChannelPayload(frame, ROOM_KEY),
      "and neither does the room key every device used to share");
    // The device it was sealed for reads it, so this is confidentiality and
    // not merely something unreadable.
    const opened = await openChannelPayload(frame, deriveMachineChannelKey(box.stays, box.self.publicKeyDerBase64, ROOM));
    assert.equal(opened.to, stays.deviceId);
  } finally { await box.cleanup(); }
});

test("an existing offline identity derives its key without a handoff and the legacy room key is refused", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-sealing-inbound-"));
  const box = await fabric(dir);
  try {
    const stays = peer(box.stays.originId, box.stays.publicKeyDerBase64);
    await box.peers.reconcile([stays]);

    // Persisted pre-upgrade identities need no secret handoff or re-pairing.
    const packet = { protocol: "accord-device-events-v1", from: stays.deviceId, to: box.self.originId,
      type: "resend", requestId: "r1", gap: { originId: stays.deviceId, logScopeId: "chat:actions", fromSeq: 1, toSeq: 1 } };
    const withRoomKey = await sealChannelPayload(packet, ROOM_KEY);
    assert.equal(await box.peers.openHomeFrame(withRoomKey), undefined, "legacy content encryption is refused");

    const withOwnKey = await sealMachinePayload(packet, box.stays, box.self.publicKeyDerBase64, ROOM);
    assert.ok(await box.peers.openHomeFrame(withOwnKey, ROOM_KEY), "the pair key works with the existing identity");

    const revoked = await sealMachinePayload({ ...packet, from: box.goes.originId }, box.goes, box.self.publicKeyDerBase64, ROOM);
    assert.equal(await box.peers.openHomeFrame(revoked), undefined, "knowing the public roster cannot replace a trusted private identity");
    // A key belonging to nobody in the roster opens nothing.
    const stranger = await sealChannelPayload(packet, Buffer.alloc(32, 42).toString("base64url"));
    assert.equal(await box.peers.openHomeFrame(stranger, ROOM_KEY), undefined);
  } finally { await box.cleanup(); }
});
