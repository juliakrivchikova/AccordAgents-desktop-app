/**
 * The phone commanding a machine directly.
 *
 * The phone signs with its own key now, so what it sends is a device event
 * like any other. These drive a real MachineHostService with events minted by
 * the phone's own module: the machine runs the turn when the phone is in its
 * trust roster, once however often the command is redelivered, and not at all
 * when the phone is not in it.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "..");
const phone = require(path.join(repoRoot, "src/mobile/mobile-machine-command.js"));
const { verifySignedChatEvent } = require(path.join(repoRoot, "dist/main/main/services/chatEventLog.js"));
const { signDevicePacket, verifyDevicePacket } = require(path.join(repoRoot, "dist/main/main/services/devicePacketAuthentication.js"));
const { MachineHostService } = require(path.join(repoRoot, "dist/main/main/services/machineHost.js"));
const { StorageService } = require(path.join(repoRoot, "dist/main/main/services/storage.js"));
const { ChatEventLogService } = require(path.join(repoRoot, "dist/main/main/services/chatEventLog.js"));
const { sealMachineRelayPayload } = require(path.join(repoRoot, "dist/main/main/services/machineRelaySealing.js"));

const CONVERSATION = "phone-chat";
const PARTICIPANT = { id: "p1", handle: "bot", kind: "codex-cli", roleConfigId: "engineer", homeMachineId: "machine-one" };

function stubClient() {
  return {
    on: () => () => undefined,
    connect: async () => undefined,
    close: () => undefined,
    sendCiphertext: async () => []
  };
}

async function machine(options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-phone-command-"));
  const storage = new StorageService({ dbPath: path.join(dir, "machine.sqlite3") });
  const eventLog = new ChatEventLogService(storage);
  const identity = await eventLog.getOrCreateDeviceIdentity();
  const desktopStorage = new StorageService({ dbPath: path.join(dir, "desktop.sqlite3") });
  const desktopLog = new ChatEventLogService(desktopStorage);
  const desktop = await desktopLog.getOrCreateDeviceIdentity();
  const desktopIdentity = { publicKeyDerBase64: desktop.publicKeyDerBase64, privateKeyDerBase64: desktop.privateKeyDerBase64 };
  const pairing = {
    version: 1, purpose: "machine-host",
    issuer: { originId: desktop.originId, keyId: desktop.keyId, publicKeyDerBase64: desktop.publicKeyDerBase64 },
    rendezvousId: "phone-room", stableRoutingId: "phone-route",
    relaySealKeyBase64: Buffer.alloc(32, 17).toString("base64url"),
    relayUrl: "ws://127.0.0.1:1/v1/relay",
    capabilities: [{ scope: "device", canRead: true, canWrite: true, canRunCloudParticipants: true, canListConversations: true }],
    fingerprint: "PHONE-TEST", createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString()
  };
  const runs = [];
  const logs = [];
  const replicated = [];
  const host = new MachineHostService(
    {
      runMachineHostedTurn: async (request) => {
        runs.push(request.runId);
        return { messages: [], warnings: [] };
      },
      cancelRun: () => true,
      respondToAppToolApproval: async () => undefined,
      applyReplicatedConversation: async (conversationId, merge) => {
        const next = merge({ id: conversationId, kind: "chat", messages: [], metadata: { participants: [PARTICIPANT] } });
        if (next) replicated.push(...(next.messages ?? []));
      }
    },
    {
      getConversation: async () => ({
        id: CONVERSATION, kind: "chat", messages: [], metadata: { participants: [PARTICIPANT] }
      })
    },
    { importMachineSettingsSnapshot: async () => undefined },
    { write: async (event, payload) => { logs.push({ event, payload }); } },
    {
      pairing, deviceId: identity.originId, appVersion: "phone-test",
      eventStorage: storage, eventLog, publicKeyDerBase64: identity.publicKeyDerBase64,
      outboxPath: path.join(dir, "outbox.json"),
      trustRosterPath: path.join(dir, "trust.json"),
      createClient: () => stubClient(),
      createPeerClient: () => stubClient(),
      ...options
    }
  );
  await host.start();
  await host.handleBody({ type: "machine.hello.ack", desktopDeviceId: desktop.originId, appVersion: "phone-test", machineId: "machine-one" });
  return {
    host, runs, logs, replicated, pairing, identity, desktop, dir,
    // The real ingress: a sealed frame off the relay, routed by who sent it.
    // Sealed to this machine by the sender's own identity. A shared room key
    // is no longer a way to put content into a machine's room: it never proved
    // who sent it, and every device that had ever been in the room held it.
    deliver: async (packet, sender = desktopIdentity) =>
      host.handleMessage(await sealMachineRelayPayload(packet, sender, identity.publicKeyDerBase64, pairing.rendezvousId)),
    trust: async (peers) => {
      const body = { type: "machine.trust.roster", conversationId: `machine-trust:${pairing.rendezvousId}`,
        roster: { version: 1, issuerDeviceId: desktop.originId, updatedAt: new Date().toISOString(), peers } };
      const { event } = await desktopLog.appendLocalEvent({ conversationId: body.conversationId,
        logScopeId: phone.deviceEventScope(pairing.rendezvousId, body.conversationId, "actions"), kind: body.type, payload: body });
      await host.handleMessage(await sealMachineRelayPayload(
        phone.eventPacket(desktop.originId, identity.originId, event), desktopIdentity, identity.publicKeyDerBase64, pairing.rendezvousId));
    },
    cleanup: async () => {
      host.close();
      // The runtime finishes its own writes after close; removing the
      // directory while it is still writing fails on a busy machine.
      await new Promise((resolve) => setTimeout(resolve, 250));
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
    }
  };
}

function phonePeer(identity, pairing) {
  return {
    deviceId: identity.deviceId,
    publicKeyDerBase64: identity.publicKeyDerBase64,
    role: "phone",
    name: "Phone",
    relayUrl: pairing.relayUrl,
    rendezvousId: pairing.rendezvousId,
    relaySealKeyBase64: pairing.relaySealKeyBase64,
    fingerprint: pairing.fingerprint
  };
}

async function command(identity, machineDeviceId, pairing, runId, originSeq = 1, prevHash) {
  const event = await phone.mintEvent(identity, {
    eventId: phone.machineCommandEventId(runId),
    conversationId: CONVERSATION,
    logScopeId: phone.deviceEventScope(pairing.rendezvousId, CONVERSATION, "actions"),
    kind: "machine.turn.request",
    originSeq,
    ...(prevHash ? { prevHash } : {}),
    payload: phone.turnRequest({
      conversationId: CONVERSATION,
      participant: PARTICIPANT,
      messageId: "msg-1",
      runId,
      pendingMessageId: `pending-${runId}`
    })
  });
  return { event, packet: phone.eventPacket(identity.deviceId, machineDeviceId, event) };
}

test("what the phone signs is what every other device verifies", async () => {
  const identity = await phone.createIdentity();
  const { event } = await command(identity, "device-x", { rendezvousId: "room" }, "run-verify");
  assert.equal(verifySignedChatEvent(event, identity.publicKeyDerBase64), true);
  const hash = createHash("sha256").update(Buffer.from(identity.publicKeyDerBase64, "base64")).digest("hex");
  assert.equal(identity.deviceId, `device-${hash.slice(0, 32)}`, "a device is named by its key, not by a label");
  // Another key must not pass: the signature is the whole point.
  const other = await phone.createIdentity();
  assert.equal(verifySignedChatEvent(event, other.publicKeyDerBase64), false);
});

test("the phone's transport signatures are the ones every other device makes and checks", async () => {
  const identity = await phone.createIdentity();
  const other = await phone.createIdentity();
  // An acknowledgement releases the sender's retained history, so a shared
  // room key must not be enough to make one. Both sides have to agree on the
  // exact bytes, or a phone's ACK would be silently ignored.
  const receipt = { eventId: "e-1", eventHash: "sha256:" + "a".repeat(64), outcome: "applied", appliedAt: "2026-09-07T00:00:00.000Z" };
  const packet = { protocol: "accord-device-events-v1", from: identity.deviceId, to: "device-machine", type: "ack", receipt };
  const signed = await phone.signPacket(identity, packet);
  assert.equal(verifyDevicePacket(signed, identity.publicKeyDerBase64), true,
    "the desktop must accept a packet the phone signed");
  assert.equal(verifyDevicePacket(signed, other.publicKeyDerBase64), false);
  assert.equal(verifyDevicePacket({ ...signed, to: "device-elsewhere" }, identity.publicKeyDerBase64), false,
    "the recipient is inside the signature");
  assert.equal(verifyDevicePacket({ ...signed, signature: undefined }, identity.publicKeyDerBase64), false);

  // And the other direction: what a machine signs, the phone verifies.
  const machineIdentity = { originId: "device-machine", privateKeyDerBase64: other.privateKeyDerBase64 };
  const fromMachine = signDevicePacket(
    { protocol: "accord-device-events-v1", from: "device-machine", to: identity.deviceId, type: "ack", receipt },
    machineIdentity
  );
  assert.equal(await phone.verifyPacket(fromMachine, other.publicKeyDerBase64), true,
    "the phone must accept a packet the machine signed");
  assert.equal(await phone.verifyPacket(fromMachine, identity.publicKeyDerBase64), false);
  assert.equal(await phone.verifyPacket({ ...fromMachine, receipt: { ...receipt, outcome: "superseded" } }, other.publicKeyDerBase64),
    false, "the receipt itself is inside the signature");
});

test("the phone refuses an event whose payload, envelope or signature does not match", async () => {
  const identity = await phone.createIdentity();
  const { event } = await command(identity, "device-x", { rendezvousId: "room" }, "run-verify-phone");
  assert.equal(await phone.verifyEvent(event, identity.publicKeyDerBase64), true);
  assert.equal(await phone.verifyEvent({ ...event, payload: { ...event.payload, runId: "other" } }, identity.publicKeyDerBase64),
    false, "a changed payload no longer hashes to what the envelope claims");
  assert.equal(await phone.verifyEvent({ ...event, createdAt: "2020-01-01T00:00:00.000Z" }, identity.publicKeyDerBase64),
    false, "a changed envelope no longer hashes to its event hash");
  const other = await phone.createIdentity();
  assert.equal(await phone.verifyEvent(event, other.publicKeyDerBase64), false);
});

test("a machine runs the turn the phone asked for, once, however often it arrives", async () => {
  const identity = await phone.createIdentity();
  const box = await machine();
  try {
    await box.trust([phonePeer(identity, box.pairing)]);
    const asked = await command(identity, box.identity.originId, box.pairing, "run-phone");
    await box.deliver(asked.packet);
    // The same command again: live and from the mailbox is the ordinary case.
    await box.deliver(asked.packet);
    for (let attempt = 0; attempt < 200 && box.runs.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.deepEqual(box.runs, ["run-phone"], "the phone's command runs exactly one turn");
  } finally { await box.cleanup(); }
});

test("a phone the owner has not allowed is not answered", async () => {
  const identity = await phone.createIdentity();
  const box = await machine();
  try {
    // No roster: this phone is a stranger.
    const asked = await command(identity, box.identity.originId, box.pairing, "run-stranger");
    await box.deliver(asked.packet);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(box.runs, [], "and nothing it sent is run");
    assert.ok(
      box.logs.some((entry) => entry.event === "machine-host.trust.rejected"),
      "the refusal is recorded, not silent"
    );
  } finally { await box.cleanup(); }
});

test("a phone taken off the roster stops being answered", async () => {
  const identity = await phone.createIdentity();
  const box = await machine();
  try {
    await box.trust([phonePeer(identity, box.pairing)]);
    const first = await command(identity, box.identity.originId, box.pairing, "run-allowed");
    await box.deliver(first.packet);
    for (let attempt = 0; attempt < 200 && box.runs.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.deepEqual(box.runs, ["run-allowed"]);

    await box.trust([]);
    const second = await command(identity, box.identity.originId, box.pairing, "run-after-removal", 2, first.event.eventHash);
    await box.deliver(second.packet);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(box.runs, ["run-allowed"]);
  } finally { await box.cleanup(); }
});

test("the row a phone's turn answers travels with the command", async () => {
  // A machine runs against its own copy of the chat. The phone carries the
  // message it is asking about, so the turn is not run against a chat that
  // does not have it.
  const identity = await phone.createIdentity();
  const box = await machine();
  try {
    await box.trust([phonePeer(identity, box.pairing)]);
    const scope = phone.deviceEventScope(box.pairing.rendezvousId, CONVERSATION, "actions");
    const message = {
      id: "phone-msg-1", role: "user", content: "from the phone",
      status: "done", createdAt: new Date().toISOString()
    };
    const delta = await phone.mintEvent(identity, {
      eventId: "phone-delta-run-carry",
      conversationId: CONVERSATION,
      logScopeId: scope,
      kind: "machine.conversation.delta",
      originSeq: 1,
      payload: {
        type: "machine.conversation.delta",
        conversationId: CONVERSATION,
        messages: [message],
        updatedAt: new Date().toISOString()
      }
    });
    await box.deliver(phone.eventPacket(identity.deviceId, box.identity.originId, delta));
    const asked = await command(identity, box.identity.originId, box.pairing, "run-carry", 2, delta.eventHash);
    await box.deliver(asked.packet);
    for (let attempt = 0; attempt < 200 && box.runs.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.deepEqual(box.runs, ["run-carry"]);
    assert.ok(
      box.replicated.some((row) => row.id === "phone-msg-1"),
      "the machine has the row the turn answers before it runs"
    );
  } finally { await box.cleanup(); }
});

test("knowing a room seal cannot replace trust, settings or the machine's home", async () => {
  const identity = await phone.createIdentity();
  const box = await machine();
  try {
    const attackerRoster = { type: "machine.trust.roster", conversationId: `machine-trust:${box.pairing.rendezvousId}`,
      roster: { version: 1, issuerDeviceId: box.desktop.originId, updatedAt: new Date().toISOString(), peers: [phonePeer(identity, box.pairing)] } };
    for (const body of [attackerRoster, { type: "machine.settings.sync", snapshot: {} },
      { type: "machine.hello.ack", desktopDeviceId: identity.deviceId, machineId: "stolen-home", appVersion: "test" }]) {
      await assert.rejects(box.deliver({ protocol: "accord-machine-link-v1", messageId: crypto.randomUUID(), sentAt: new Date().toISOString(), body }), /signature/);
    }
    assert.deepEqual(box.host.trust.peers(), []);
    assert.equal(box.host.homeMachineId, "machine-one");
    await box.trust([{ ...phonePeer(identity, box.pairing), role: "desktop" }]);
    const forged = await phone.mintEvent(identity, { eventId: "forged-roster", conversationId: attackerRoster.conversationId,
      logScopeId: phone.deviceEventScope(box.pairing.rendezvousId, attackerRoster.conversationId, "actions"),
      kind: attackerRoster.type, originSeq: 1, payload: { ...attackerRoster, roster: { ...attackerRoster.roster, peers: [] } } });
    await assert.rejects(box.deliver(phone.eventPacket(identity.deviceId, box.identity.originId, forged)));
    assert.equal(box.host.trust.peers().length, 1, "a trusted desktop is a controller, not the enrollment issuer");
    await box.trust([]);
    await assert.rejects(box.deliver({ protocol: "accord-machine-link-v1", messageId: crypto.randomUUID(), sentAt: new Date().toISOString(), body: attackerRoster }), /signature/);
    assert.deepEqual(box.host.trust.peers(), [], "revoked room-key holders cannot restore themselves");
  } finally { await box.cleanup(); }
});
