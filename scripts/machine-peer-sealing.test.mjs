/**
 * Whose key a machine's frame is sealed with.
 *
 * Every device the owner trusted used to be handed the machine room's single
 * seal key. Taking one off the roster ended its authority at once — its
 * commands refused, its acknowledgements releasing nothing — and left it able
 * to open everything the devices that stayed were sent afterwards. Revoking
 * authority and revoking reading are different acts, and only the first
 * happened.
 *
 * A key per device makes the second act unnecessary: a revoked device never
 * held the others' keys, so there is nothing to rotate and no device that
 * stayed has to do anything. The room stays shared because the relay is a
 * room; the sealing does not.
 */
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
const { openMobileRelayPayload, sealMobileRelayPayload } =
  require(path.join(repoRoot, "dist/main/main/services/mobileRelaySealing.js"));

const ROOM = "sealing-room";
const ROOM_KEY = Buffer.alloc(32, 3).toString("base64url");
const STAYS_KEY = Buffer.alloc(32, 7).toString("base64url");
const GOES_KEY = Buffer.alloc(32, 9).toString("base64url");

function peer(deviceId, publicKeyDerBase64, sealKey) {
  return {
    deviceId, publicKeyDerBase64, role: "phone", name: "Device",
    relayUrl: "ws://127.0.0.1:1/v1/relay", rendezvousId: ROOM,
    relaySealKeyBase64: sealKey, fingerprint: "SEALING"
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
      relayUrl: "ws://127.0.0.1:1/v1/relay", fingerprint: "SEALING",
      capabilities: [], createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString()
    },
    homeClient,
    createClient: () => homeClient,
    isPeerConnected: () => true,
    apply: async () => "applied",
    onError: () => undefined,
    logger: () => undefined
  });
  return { peers, storage, sent, self, stays, goes,
    cleanup: async () => { peers.close(); await rm(dir, { recursive: true, force: true, maxRetries: 5 }); } };
}

test("a device the owner revoked cannot read what the devices that stayed are sent", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-sealing-"));
  const box = await fabric(dir);
  try {
    const stays = peer(box.stays.originId, box.stays.publicKeyDerBase64, STAYS_KEY);
    const goes = peer(box.goes.originId, box.goes.publicKeyDerBase64, GOES_KEY);
    await box.peers.reconcile([stays, goes]);
    box.peers.start();

    // The owner removes one of them, and the machine publishes afterwards.
    await box.peers.reconcile([stays]);
    box.sent.length = 0;
    await box.peers.channel(stays.deviceId).publish({
      conversationId: "chat", kind: "machine.approval.requested",
      payload: { type: "machine.approval.requested", conversationId: "chat",
        approval: { id: "a1", status: "pending", summary: "Secret work", createdAt: new Date().toISOString() } }
    });
    for (let attempt = 0; attempt < 60 && !box.sent.length; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(box.sent.length > 0, "the device that stayed is sent the new work");

    for (const request of box.sent) {
      // The revoked device is still in the room and still holds its old key.
      await assert.rejects(() => openMobileRelayPayload(request.ciphertext, GOES_KEY),
        "a revoked device must not open what a device that stayed was sent");
      // Nor does the room key it was originally handed open it.
      await assert.rejects(() => openMobileRelayPayload(request.ciphertext, ROOM_KEY),
        "and neither does the room key every device used to share");
      // The device it was sealed for reads it, so this is confidentiality and
      // not merely something unreadable.
      const opened = await openMobileRelayPayload(request.ciphertext, STAYS_KEY);
      assert.equal(opened.to, stays.deviceId);
    }
  } finally { await box.cleanup(); }
});

test("a device that has not picked up its own key yet is still heard", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-sealing-inbound-"));
  const box = await fabric(dir);
  try {
    const stays = peer(box.stays.originId, box.stays.publicKeyDerBase64, STAYS_KEY);
    await box.peers.reconcile([stays]);

    // A device the owner trusts, sending with the room key it was originally
    // given. Refusing it would lock out a working device rather than revoke a
    // removed one; authority is still decided by the roster and the signature.
    const packet = { protocol: "accord-device-events-v1", from: stays.deviceId, to: box.self.originId,
      type: "resend", requestId: "r1", gap: { originId: stays.deviceId, logScopeId: "chat:actions", fromSeq: 1, toSeq: 1 } };
    const withRoomKey = await sealMobileRelayPayload(packet, ROOM_KEY);
    assert.ok(await box.peers.openHomeFrame(withRoomKey, ROOM_KEY), "the room key still opens what a device sends");

    const withOwnKey = await sealMobileRelayPayload(packet, STAYS_KEY);
    assert.ok(await box.peers.openHomeFrame(withOwnKey, ROOM_KEY), "and so does the device's own key");

    // A key belonging to nobody in the roster opens nothing.
    const stranger = await sealMobileRelayPayload(packet, Buffer.alloc(32, 42).toString("base64url"));
    assert.equal(await box.peers.openHomeFrame(stranger, ROOM_KEY), undefined);
  } finally { await box.cleanup(); }
});
