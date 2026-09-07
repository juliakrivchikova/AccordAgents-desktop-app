/**
 * Deleting a chat that lives on a machine.
 *
 * A machine holds its own copy of the conversation and its own providers for
 * it. Until now the desktop deleted its rows and the machine kept everything:
 * the chat, the sessions, and a provider that could still be resumed for a
 * conversation the User believes is gone. Archiving replicated, because
 * archived is a shape the conversation has; deletion is the conversation
 * ceasing to exist, which no snapshot can express.
 *
 * So it is a durable command with a tombstone, and these are the cases that
 * decide whether that is real: a machine that was off when it happened, a
 * snapshot still in flight afterwards, a restart, and a turn arriving for a
 * chat that is gone.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "..");
const { MachineHostService } = require(path.join(repoRoot, "dist/main/main/services/machineHost.js"));
const { StorageService } = require(path.join(repoRoot, "dist/main/main/services/storage.js"));
const { ChatEventLogService } = require(path.join(repoRoot, "dist/main/main/services/chatEventLog.js"));
const { sealMobileRelayPayload } = require(path.join(repoRoot, "dist/main/main/services/mobileRelaySealing.js"));
const { machineCommandId } = require(path.join(repoRoot, "dist/main/shared/machineLink.js"));
const phone = require(path.join(repoRoot, "src/mobile/mobile-machine-command.js"));

const CONVERSATION = "delete-chat";
const PARTICIPANT = { id: "p1", handle: "one", kind: "codex-cli", roleConfigId: "engineer", homeMachineId: "machine-one" };

function stubClient(sent) {
  return {
    on: () => () => undefined, connect: async () => undefined, close: () => undefined,
    sendCiphertext: async (request) => { sent.push(request); return []; }
  };
}

async function machine(dir) {
  const storage = new StorageService({ dbPath: path.join(dir, "machine.sqlite3") });
  const eventLog = new ChatEventLogService(storage);
  const identity = await eventLog.getOrCreateDeviceIdentity();
  const desktopStorage = new StorageService({ dbPath: path.join(dir, "desktop.sqlite3") });
  const desktopLog = new ChatEventLogService(desktopStorage);
  const desktop = await desktopLog.getOrCreateDeviceIdentity();
  const pairing = {
    version: 1, purpose: "machine-host",
    issuer: { originId: desktop.originId, keyId: desktop.keyId, publicKeyDerBase64: desktop.publicKeyDerBase64 },
    rendezvousId: "delete-room", stableRoutingId: "delete-route",
    relaySealKeyBase64: Buffer.alloc(32, 31).toString("base64url"),
    relayUrl: "ws://127.0.0.1:1/v1/relay",
    capabilities: [{ scope: "device", canRead: true, canWrite: true, canRunCloudParticipants: true, canListConversations: true }],
    fingerprint: "DELETE-TEST", createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString()
  };
  const closed = [];
  const runs = [];
  const sent = [];
  const host = new MachineHostService(
    {
      runMachineHostedTurn: async (request) => { runs.push(request.runId); return { messages: [], warnings: [] }; },
      cancelRun: () => true,
      respondToAppToolApproval: async () => undefined,
      conversationIdForRun: () => CONVERSATION,
      closeReplicatedConversationSessions: async (id) => { closed.push(id); },
      applyReplicatedConversation: async (conversationId, merge) => {
        const existing = await storage.getConversation(conversationId);
        const next = merge(existing ?? undefined);
        if (next) await storage.saveConversation(next);
      }
    },
    storage,
    { importMachineSettingsSnapshot: async () => undefined },
    { write: async () => undefined },
    {
      pairing, deviceId: identity.originId, appVersion: "delete-test",
      eventStorage: storage, eventLog, publicKeyDerBase64: identity.publicKeyDerBase64,
      outboxPath: path.join(dir, "outbox.json"), trustRosterPath: path.join(dir, "trust.json"),
      createClient: () => stubClient(sent), createPeerClient: () => stubClient(sent)
    }
  );
  await host.start();
  await host.handleBody({ type: "machine.hello.ack", desktopDeviceId: desktop.originId, appVersion: "t", machineId: "machine-one" });

  /** The desktop's own signed durable event, through the real ingress. */
  const deliver = async (body, options = {}) => {
    const { event } = await desktopLog.appendLocalEvent({
      conversationId: body.type === "machine.conversation.sync" ? body.conversation.id : body.conversationId,
      logScopeId: `device:${pairing.rendezvousId}:${JSON.stringify([
        body.type === "machine.conversation.sync" ? body.conversation.id : body.conversationId, "actions"])}`,
      kind: body.type, payload: body,
      // A turn request is named by its run, the way every device names it.
      ...(body.type === "machine.turn.request" ? { eventId: machineCommandId(body.runId) } : {})
    });
    const packet = { protocol: "accord-device-events-v1", from: desktop.originId, to: identity.originId, type: "event", event };
    if (options.raw) return host.handleMessage(await sealMobileRelayPayload(packet, pairing.relaySealKeyBase64));
    return host.handleMessage(await sealMobileRelayPayload(packet, pairing.relaySealKeyBase64));
  };

  return {
    host, storage, closed, runs, sent, pairing, identity, desktop, deliver,
    trust: async (peers) => {
      const body = { type: "machine.trust.roster", conversationId: `machine-trust:${pairing.rendezvousId}`,
        roster: { version: 1, issuerDeviceId: desktop.originId, updatedAt: new Date().toISOString(), peers } };
      const { event } = await desktopLog.appendLocalEvent({ conversationId: body.conversationId,
        logScopeId: `device:${pairing.rendezvousId}:${JSON.stringify([body.conversationId, "actions"])}`,
        kind: body.type, payload: body });
      await host.handleMessage(await sealMobileRelayPayload(
        { protocol: "accord-device-events-v1", from: desktop.originId, to: identity.originId, type: "event", event },
        pairing.relaySealKeyBase64));
    },
    close: async () => { host.close(); await new Promise((resolve) => setTimeout(resolve, 200)); }
  };
}

function conversation() {
  return {
    id: CONVERSATION, kind: "chat", title: "Delete", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    messages: [{ id: "m1", role: "user", content: "hello", createdAt: new Date().toISOString(), status: "done" }],
    findings: [], metadata: { participants: [PARTICIPANT] }
  };
}

test("a chat deleted by its owner is deleted here, with its providers closed", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-delete-"));
  const box = await machine(dir);
  t.after(async () => { await box.close(); await rm(dir, { recursive: true, force: true, maxRetries: 5 }); });

  await box.deliver({ type: "machine.conversation.sync", conversation: conversation() });
  assert.ok(await box.storage.getConversation(CONVERSATION), "the machine holds its copy");

  await box.deliver({ type: "machine.conversation.deleted", conversationId: CONVERSATION, deletedAt: new Date().toISOString() });
  assert.equal(await box.storage.getConversation(CONVERSATION), undefined, "the copy is gone");
  assert.deepEqual(box.closed, [CONVERSATION], "and the providers it held were closed, not left running");
  assert.equal(await box.storage.conversationTombstones().isDeleted(CONVERSATION), true);
});

test("a snapshot still in flight cannot bring a deleted chat back", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-delete-stale-"));
  const box = await machine(dir);
  t.after(async () => { await box.close(); await rm(dir, { recursive: true, force: true, maxRetries: 5 }); });

  await box.deliver({ type: "machine.conversation.sync", conversation: conversation() });
  await box.deliver({ type: "machine.conversation.deleted", conversationId: CONVERSATION, deletedAt: new Date().toISOString() });

  // The desktop sent these before it deleted the chat; they arrive after.
  await box.deliver({ type: "machine.conversation.sync", conversation: conversation() });
  await box.deliver({ type: "machine.conversation.delta", conversationId: CONVERSATION,
    messages: [{ id: "m2", role: "user", content: "late", createdAt: new Date().toISOString(), status: "done" }],
    updatedAt: new Date().toISOString() });
  assert.equal(await box.storage.getConversation(CONVERSATION), undefined,
    "a stale snapshot is not a new chat; the tombstone is what tells them apart");
});

test("a turn for a deleted chat does not run", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-delete-turn-"));
  const box = await machine(dir);
  t.after(async () => { await box.close(); await rm(dir, { recursive: true, force: true, maxRetries: 5 }); });

  await box.deliver({ type: "machine.conversation.sync", conversation: conversation() });
  await box.deliver({ type: "machine.conversation.deleted", conversationId: CONVERSATION, deletedAt: new Date().toISOString() });
  await box.deliver({ type: "machine.turn.request", conversationId: CONVERSATION, participantId: PARTICIPANT.id,
    participant: PARTICIPANT, messageId: "m1", runId: "run-after-delete", pendingMessageId: "pending-1",
    requestedAt: new Date().toISOString() });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(box.runs, [], "a member cannot be run against a chat that no longer exists");
});

test("the deletion survives a restart of the machine runtime", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-delete-restart-"));
  const first = await machine(dir);
  await first.deliver({ type: "machine.conversation.sync", conversation: conversation() });
  await first.deliver({ type: "machine.conversation.deleted", conversationId: CONVERSATION, deletedAt: new Date().toISOString() });
  await first.close();

  // A new runtime over the same disk. The tombstone is the only thing that
  // still knows, and it has to be enough.
  const second = await machine(dir);
  t.after(async () => { await second.close(); await rm(dir, { recursive: true, force: true, maxRetries: 5 }); });
  assert.equal(await second.storage.conversationTombstones().isDeleted(CONVERSATION), true);
  await second.deliver({ type: "machine.conversation.sync", conversation: conversation() });
  assert.equal(await second.storage.getConversation(CONVERSATION), undefined,
    "a restarted runtime does not accept a copy of a chat it was told was deleted");
});

test("a device the owner trusts can delete a chat from the machine, like any other control", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-delete-peer-"));
  const box = await machine(dir);
  t.after(async () => { await box.close(); await rm(dir, { recursive: true, force: true, maxRetries: 5 }); });

  await box.deliver({ type: "machine.conversation.sync", conversation: conversation() });

  // Every device in the roster drives members: sends a turn, stops one,
  // answers a card, deletes a chat. Only the machine's own settings, identity
  // and roster are narrower, and a conversation is none of those. Making
  // deletion desktop-only would be a control the User has on one device and
  // not another, which is not a restriction anyone approved.
  const phoneIdentity = await phone.createIdentity();
  await box.trust([{
    deviceId: phoneIdentity.deviceId, publicKeyDerBase64: phoneIdentity.publicKeyDerBase64,
    role: "phone", name: "Phone", relayUrl: box.pairing.relayUrl, rendezvousId: box.pairing.rendezvousId,
    relaySealKeyBase64: box.pairing.relaySealKeyBase64, fingerprint: box.pairing.fingerprint
  }]);

  const body = { type: "machine.conversation.deleted", conversationId: CONVERSATION, deletedAt: new Date().toISOString() };
  const event = await phone.mintEvent(phoneIdentity, {
    eventId: "phone-delete-1", conversationId: CONVERSATION,
    logScopeId: phone.deviceEventScope(box.pairing.rendezvousId, CONVERSATION, "actions"),
    kind: body.type, originSeq: 1, payload: body
  });
  await box.host.handleMessage(await sealMobileRelayPayload(
    phone.eventPacket(phoneIdentity.deviceId, box.identity.originId, event), box.pairing.relaySealKeyBase64));
  await new Promise((resolve) => setTimeout(resolve, 600));

  assert.equal(await box.storage.getConversation(CONVERSATION), undefined,
    "a device the owner trusts deletes the chat, wherever the User happens to be");
  assert.equal(await box.storage.conversationTombstones().isDeleted(CONVERSATION), true);

  // A device that is not in the roster still cannot.
  const stranger = await phone.createIdentity();
  const strangerEvent = await phone.mintEvent(stranger, {
    eventId: "stranger-delete-1", conversationId: "other-chat",
    logScopeId: phone.deviceEventScope(box.pairing.rendezvousId, "other-chat", "actions"),
    kind: body.type, originSeq: 1,
    payload: { ...body, conversationId: "other-chat" }
  });
  await box.host.handleMessage(await sealMobileRelayPayload(
    phone.eventPacket(stranger.deviceId, box.identity.originId, strangerEvent), box.pairing.relaySealKeyBase64)).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await box.storage.conversationTombstones().isDeleted("other-chat"), false,
    "a device the owner never trusted deletes nothing");
});
test("a machine that was off when the chat was deleted is told when it comes back", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-delete-offline-"));
  const first = await machine(dir);
  await first.deliver({ type: "machine.conversation.sync", conversation: conversation() });
  assert.ok(await first.storage.getConversation(CONVERSATION));
  // The machine goes away. The deletion happens while it is not there.
  await first.close();

  const second = await machine(dir);
  t.after(async () => { await second.close(); await rm(dir, { recursive: true, force: true, maxRetries: 5 }); });
  assert.ok(await second.storage.getConversation(CONVERSATION), "it still holds the chat when it returns");

  // The desktop's channel retained the command and delivers it on reconnect.
  await second.deliver({ type: "machine.conversation.deleted", conversationId: CONVERSATION, deletedAt: new Date().toISOString() });
  assert.equal(await second.storage.getConversation(CONVERSATION), undefined,
    "a deletion is not lost because the machine was off when it was made");
  assert.deepEqual(second.closed, [CONVERSATION], "and the providers it held are closed on return");
});

test("a device trusted after a result was published still receives it", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-fanout-"));
  const box = await machine(dir);
  t.after(async () => { await box.close(); await rm(dir, { recursive: true, force: true, maxRetries: 5 }); });

  await box.deliver({ type: "machine.conversation.sync", conversation: conversation() });

  // The machine publishes something while only the enrolling desktop is known:
  // a member here asks for permission.
  box.host.noteConversationSnapshot({
    ...conversation(),
    metadata: {
      participants: [PARTICIPANT],
      pendingAppToolApprovals: [{ id: "approval-fanout", status: "pending", summary: "Write a file",
        requesterHandle: "one", createdAt: new Date().toISOString() }]
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 800));

  const owedBefore = await box.storage.deviceEvents().pressure(box.pairing.rendezvousId);
  assert.ok(owedBefore.events > 0, "the machine holds what it published until it is acknowledged");

  // A phone joins the roster afterwards. What the room already owes is owed to
  // it too: a result published before it was trusted still has to reach it.
  const phoneIdentity = await phone.createIdentity();
  await box.trust([{
    deviceId: phoneIdentity.deviceId, publicKeyDerBase64: phoneIdentity.publicKeyDerBase64,
    role: "phone", name: "Phone", relayUrl: box.pairing.relayUrl, rendezvousId: box.pairing.rendezvousId,
    relaySealKeyBase64: box.pairing.relaySealKeyBase64, fingerprint: box.pairing.fingerprint
  }]);
  await new Promise((resolve) => setTimeout(resolve, 500));

  const owedAfter = await box.storage.deviceEvents().pressure(box.pairing.rendezvousId);
  assert.ok(owedAfter.recipients > owedBefore.recipients,
    `the newly trusted device is owed what the room already held (${owedBefore.recipients} -> ${owedAfter.recipients})`);
});

test("a device taken off the roster stops being owed the room's history", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-revoke-"));
  const box = await machine(dir);
  t.after(async () => { await box.close(); await rm(dir, { recursive: true, force: true, maxRetries: 5 }); });

  await box.deliver({ type: "machine.conversation.sync", conversation: conversation() });
  const phoneIdentity = await phone.createIdentity();
  const peer = {
    deviceId: phoneIdentity.deviceId, publicKeyDerBase64: phoneIdentity.publicKeyDerBase64,
    role: "phone", name: "Phone", relayUrl: box.pairing.relayUrl, rendezvousId: box.pairing.rendezvousId,
    relaySealKeyBase64: box.pairing.relaySealKeyBase64, fingerprint: box.pairing.fingerprint
  };
  await box.trust([peer]);

  box.host.noteConversationSnapshot({
    ...conversation(),
    metadata: {
      participants: [PARTICIPANT],
      pendingAppToolApprovals: [{ id: "approval-revoke", status: "pending", summary: "Write a file",
        requesterHandle: "one", createdAt: new Date().toISOString() }]
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 800));
  const events = box.storage.deviceEvents();
  const owedToPhone = async () => (await events.listPending(box.pairing.rendezvousId, 0, phoneIdentity.deviceId)).length;
  assert.ok(await owedToPhone() > 0, "while trusted, the phone is owed what the room published");

  // The owner removes it. Its authority ends at once, and so does its claim on
  // what this machine is holding for it.
  await box.trust([]);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(await owedToPhone(), 0,
    "a revoked device is not re-offered the room's history on every reconnect");
  // What the enrolling desktop is owed is untouched.
  const owedToDesktop = await events.listPending(box.pairing.rendezvousId, 0, box.desktop.originId);
  assert.ok(owedToDesktop.length > 0, "revoking one device does not discard another's retention");
});
