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
const { openMobileRelayPayload, sealMobileRelayPayload } =
  require(path.join(repoRoot, "dist/main/main/services/mobileRelaySealing.js"));

const { deriveMachineChannelKey } = require(path.join(repoRoot, "dist/main/shared/machineChannelKey.js"));
const { sealMachineRelayPayload } = require(path.join(repoRoot, "dist/main/main/services/machineRelaySealing.js"));

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

async function fabric(dir, outboxUrl) {
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
      ...(outboxUrl ? { outboxUrl } : {}),
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
      const opened = await openMobileRelayPayload(request.ciphertext, deriveMachineChannelKey(box.stays, box.self.publicKeyDerBase64, ROOM));
      assert.equal(opened.to, stays.deviceId);
    }
  } finally { await box.cleanup(); }
});

test("an existing offline identity derives its key without a handoff and the legacy room key is refused", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-sealing-inbound-"));
  const box = await fabric(dir);
  try {
    const stays = peer(box.stays.originId, box.stays.publicKeyDerBase64, STAYS_KEY);
    await box.peers.reconcile([stays]);

    // Persisted pre-upgrade identities need no secret handoff or re-pairing.
    const packet = { protocol: "accord-device-events-v1", from: stays.deviceId, to: box.self.originId,
      type: "resend", requestId: "r1", gap: { originId: stays.deviceId, logScopeId: "chat:actions", fromSeq: 1, toSeq: 1 } };
    const withRoomKey = await sealMobileRelayPayload(packet, ROOM_KEY);
    assert.equal(await box.peers.openHomeFrame(withRoomKey), undefined, "legacy content encryption is refused");

    const withOwnKey = await sealMachineRelayPayload(packet, box.stays, box.self.publicKeyDerBase64, ROOM);
    assert.ok(await box.peers.openHomeFrame(withOwnKey, ROOM_KEY), "the pair key works with the existing identity");

    const revoked = await sealMachineRelayPayload({ ...packet, from: box.goes.originId }, box.goes, box.self.publicKeyDerBase64, ROOM);
    assert.equal(await box.peers.openHomeFrame(revoked), undefined, "knowing the public roster cannot replace a trusted private identity");
    // A key belonging to nobody in the roster opens nothing.
    const stranger = await sealMobileRelayPayload(packet, Buffer.alloc(32, 42).toString("base64url"));
    assert.equal(await box.peers.openHomeFrame(stranger, ROOM_KEY), undefined);
  } finally { await box.cleanup(); }
});


test("a remaining offline device reads retained future frames after the machine exits, without another key handoff", async () => {
  const { createReferenceMailboxServer } = require("./mailbox-reference-server.cjs");
  const { DeviceEventChannel } = require(path.join(repoRoot, "dist/main/main/services/deviceEventChannel.js"));
  const { mailboxEndpointForSealKey, mailboxAuthHeaders } = require(path.join(repoRoot, "dist/main/main/services/mailboxAccess.js"));
  const mailbox = createReferenceMailboxServer({ locked: true });
  const address = await mailbox.listen();
  const outboxUrl = address.url + "/v1/mailbox/events";
  const dir = await mkdtemp(path.join(tmpdir(), "accord-sealed-retention-"));
  const box = await fabric(dir, outboxUrl);
  let receiver;
  try {
    const stays = peer(box.stays.originId, box.stays.publicKeyDerBase64, STAYS_KEY);
    await box.peers.reconcile([stays, peer(box.goes.originId, box.goes.publicKeyDerBase64, GOES_KEY)]);
    await box.peers.reconcile([stays]);
    const channel = box.peers.channel(stays.deviceId);
    const published = await channel.publish({ conversationId: "chat", kind: "machine.approval.requested",
      payload: { type: "machine.approval.requested", conversationId: "chat", approval: { summary: "future secret after revocation" } } });
    await channel.mailbox.flush();
    box.peers.close(); // The machine is gone before the retained device returns.

    const restartedStorage = new StorageService({ dbPath: path.join(dir, "stays.sqlite3") });
    const restartedLog = new ChatEventLogService(restartedStorage);
    const identity = await restartedLog.getOrCreateDeviceIdentity();
    assert.equal(identity.originId, box.stays.originId);
    const key = deriveMachineChannelKey(identity, box.self.publicKeyDerBase64, ROOM);
    const pageResponse = await fetch(mailboxEndpointForSealKey(outboxUrl, key), { headers: mailboxAuthHeaders(key) });
    const page = await pageResponse.json();
    assert.ok(page.events.length);
    assert.ok(!JSON.stringify(page).includes("future secret after revocation"));
    for (const event of page.events) {
      await assert.rejects(() => openMobileRelayPayload(JSON.stringify(event.payload), ROOM_KEY));
      await assert.rejects(() => openMobileRelayPayload(JSON.stringify(event.payload), GOES_KEY));
      await assert.rejects(() => openMobileRelayPayload(JSON.stringify(event.payload), deriveMachineChannelKey(box.goes, box.self.publicKeyDerBase64, ROOM)));
    }
    // Knowing every public field, even the mailbox URL, does not grant the token.
    const denied = await fetch(mailboxEndpointForSealKey(outboxUrl, key), { headers: mailboxAuthHeaders(ROOM_KEY) });
    assert.equal(denied.status, 401);
    const applied = [];
    receiver = new DeviceEventChannel({ storage: restartedStorage, eventLog: restartedLog,
      pairing: { ...box.peers.options.home, relaySealKeyBase64: key }, channelId: ROOM,
      localDeviceId: identity.originId, peerDeviceId: box.self.originId, peerPublicKeyDerBase64: box.self.publicKeyDerBase64,
      isPeerConnected: () => false, send: async () => undefined,
      apply: async (event, body) => { applied.push({ event, body }); return "applied"; }, onError: () => undefined });
    await receiver.mailbox.poll();
    assert.equal(applied[0].event.eventId, published.eventId);
    assert.equal(applied[0].body.approval.summary, "future secret after revocation");
  } finally { receiver?.close(); await box.cleanup(); await mailbox.close(); }
});
