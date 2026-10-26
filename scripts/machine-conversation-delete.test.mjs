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
const { hubPairChannelId } = require(path.join(repoRoot, "dist/main/main/services/hubChannels.js"));
const { HUB_SCOPE_PREFIXES } = require(path.join(repoRoot, "dist/main/main/services/hubSync.js"));
const { MachineLinkService } = require(path.join(repoRoot, "dist/main/main/services/machineLink.js"));
const { ChatService } = require(path.join(repoRoot, "dist/main/main/services/chat.js"));
const { machineCommandId } = require(path.join(repoRoot, "dist/main/shared/machineLink.js"));
const chatChanges = require(path.join(repoRoot, "dist/main/main/services/chatChanges.js"));

const CONVERSATION = "delete-chat";
/** Where the owner's devices meet on the User's server; the stub clients never dial it. */
const MEETING_PLACE = "ws://127.0.0.1:1";
const PARTICIPANT = { id: "p1", handle: "one", kind: "codex-cli", roleConfigId: "engineer", homeMachineId: "machine-one" };

function stubClient(sent) {
  return {
    on: () => () => undefined, connect: async () => undefined, close: () => undefined,
    sendCiphertext: async (request) => { sent.push(request); return []; }
  };
}

/** Another of the owner's devices: its own database and signing identity. */
async function device(dir, name) {
  const storage = new StorageService({ dbPath: path.join(dir, `${name}.sqlite3`) });
  const eventLog = new ChatEventLogService(storage);
  const identity = await eventLog.getOrCreateDeviceIdentity();
  return { storage, eventLog, identity, deviceId: identity.originId, publicKeyDerBase64: identity.publicKeyDerBase64 };
}

/** A roster entry for that device, met in the machine's room on the server. */
function rosterPeer(peer, box, role = "phone") {
  return { deviceId: peer.deviceId, publicKeyDerBase64: peer.publicKeyDerBase64, role, name: "Phone",
    relayUrl: MEETING_PLACE, rendezvousId: box.pairing.rendezvousId, fingerprint: box.pairing.fingerprint };
}

/** The machine's own signed events in the scopes it pushes to the server. */
async function ownHubEvents(box) {
  return (await box.storage.hub().ownEventsAfter(box.identity.originId, 0, 10_000, [...HUB_SCOPE_PREFIXES])).map((row) => row.event);
}

async function machine(dir, controls = {}) {
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
    // The User's server; the stub client never dials it.
    hubUrl: "http://127.0.0.1:1",
    capabilities: [{ scope: "device", canRead: true, canWrite: true, canRunCloudParticipants: true, canListConversations: true }],
    fingerprint: "DELETE-TEST", createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString()
  };
  const closed = [];
  const runs = [];
  const sent = [];
  const host = new MachineHostService(
    {
      runMachineHostedTurn: async (request, signal) => { runs.push(request.runId); await controls.run?.(request, signal); return { messages: [], warnings: [] }; },
      cancelRun: () => true,
      respondToAppToolApproval: async () => undefined,
      conversationIdForRun: () => CONVERSATION,
      closeReplicatedConversationSessions: async (id) => { await controls.close?.(id); closed.push(id); },
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
      createClient: () => stubClient(sent), createPeerClient: () => stubClient(sent),
      // What ChatService does with a chat change: never for a deleted chat.
      applyChatChanges: async (event, payload) => {
        if (await storage.conversationTombstones().isDeleted(payload.conversationId)) return "applied";
        const existing = await storage.getConversation(payload.conversationId);
        const result = chatChanges.applyChatChanges(existing ?? undefined, payload, event.originId, { acceptsConversationFields: () => true, acceptsMessageUpdate: () => true, acceptsMessageCreate: () => true, acceptsMessageRemoval: () => true, holdsUnknownChats: true });
        if (result.status !== "applied") return "missing-conversation";
        await storage.saveConversation(result.conversation);
        return "applied";
      }
    }
  );
  await host.start();
  await host.handleBody({ type: "machine.hello.ack", desktopDeviceId: desktop.originId, appVersion: "t", machineId: "machine-one" });

  /** The desktop's own signed durable event, through the real ingress: the
   *  server's order hands it in (HubSync -> receiveFromHub); the room never
   *  carries it. A chat's copy and later messages travel as the desktop's
   *  chat changes. Returns the event. */
  const deliver = async (body) => {
    let event;
    if (body.type === "machine.conversation.sync" || body.type === "machine.conversation.delta") {
      const id = body.type === "machine.conversation.sync" ? body.conversation.id : body.conversationId;
      const changes = body.type === "machine.conversation.sync"
        ? chatChanges.diffChatChanges(undefined, body.conversation, { emitsConversationFields: true, ownsMessage: () => true }).changes
        : body.messages.map((message) => ({ type: "message.created", message }));
      ({ event } = await desktopLog.appendLocalEvent({ conversationId: id, logScopeId: chatChanges.chatChangesLogScope(id),
        kind: chatChanges.CHAT_CHANGES_EVENT_KIND, payload: { version: 1, conversationId: id, updatedAt: new Date().toISOString(), changes } }));
    } else {
      ({ event } = await desktopLog.appendLocalEvent({
        conversationId: body.conversationId,
        logScopeId: `device:${pairing.rendezvousId}:${JSON.stringify([body.conversationId, "actions"])}`,
        kind: body.type, payload: body,
        // A turn request is named by its run, the way every device names it.
        ...(body.type === "machine.turn.request" ? { eventId: machineCommandId(body.runId) } : {})
      }));
    }
    assert.equal(await host.receiveFromHub(event), "delivered");
    return event;
  };

  return {
    host, storage, closed, runs, sent, pairing, identity, desktop, deliver,
    trust: async (peers) => {
      const body = { type: "machine.trust.roster", conversationId: `machine-trust:${pairing.rendezvousId}`,
        roster: { version: 1, issuerDeviceId: desktop.originId, updatedAt: new Date().toISOString(), peers } };
      const { event } = await desktopLog.appendLocalEvent({ conversationId: body.conversationId,
        logScopeId: `device:${pairing.rendezvousId}:${JSON.stringify([body.conversationId, "actions"])}`,
        kind: body.type, payload: body });
      assert.equal(await host.receiveFromHub(event), "delivered");
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
  // and roster are narrower, and a conversation is none of those. This is
  // the machine's rule for whatever a trusted device writes on its pair's
  // channel; the phone itself no longer writes machine commands (it reads
  // the server and writes chat changes and card answers only).
  const trusted = await device(dir, "trusted");
  await box.trust([rosterPeer(trusted, box)]);

  const body = { type: "machine.conversation.deleted", conversationId: CONVERSATION, deletedAt: new Date().toISOString() };
  const { event } = await trusted.eventLog.appendLocalEvent({
    conversationId: CONVERSATION, kind: body.type, payload: body,
    logScopeId: `device:${hubPairChannelId(box.identity.originId, trusted.deviceId)}:${JSON.stringify([CONVERSATION, "actions"])}`
  });
  assert.equal(await box.host.receiveFromHub(event), "delivered", "the server's order hands it to that device's channel");

  assert.equal(await box.storage.getConversation(CONVERSATION), undefined,
    "a device the owner trusts deletes the chat, wherever the User happens to be");
  assert.equal(await box.storage.conversationTombstones().isDeleted(CONVERSATION), true);

  // A device that is not in the roster still cannot.
  const stranger = await device(dir, "stranger");
  const { event: strangerEvent } = await stranger.eventLog.appendLocalEvent({
    conversationId: "other-chat", kind: body.type, payload: { ...body, conversationId: "other-chat" },
    logScopeId: `device:${hubPairChannelId(box.identity.originId, stranger.deviceId)}:${JSON.stringify(["other-chat", "actions"])}`
  });
  assert.equal(await box.host.receiveFromHub(strangerEvent), "not-mine", "no channel of this machine takes it");
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

  // The server's order kept the command and hands it in once the machine is back.
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

  // Through the server nobody is addressed: the result is in the machine's
  // own log, which it pushes to the server, and no row waits on any device.
  const published = (await ownHubEvents(box)).find((event) => event.kind === "machine.approval.requested");
  assert.ok(published, "the machine's log holds what it published, for the server's order");
  assert.equal((await box.storage.deviceEvents().pressure(box.pairing.rendezvousId)).events, 0, "no delivery row for anyone");

  // A phone joins the roster afterwards. It reads the server's order from its
  // own place, so a result published before it was trusted reaches it with
  // nothing re-addressed here: the event is still there, unchanged.
  const later = await device(dir, "later");
  await box.trust([rosterPeer(later, box)]);
  await new Promise((resolve) => setTimeout(resolve, 500));

  assert.ok((await ownHubEvents(box)).some((event) => event.eventId === published.eventId && event.eventHash === published.eventHash),
    "what the machine published stays in its log for the device trusted later");
  assert.equal((await box.storage.deviceEvents().pressure(box.pairing.rendezvousId)).events, 0, "still no delivery row");
  assert.deepEqual(await box.storage.deviceEvents().listPending(hubPairChannelId(box.identity.originId, later.deviceId), 0, later.deviceId), []);
});

test("a device taken off the roster stops being owed the room's history", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-revoke-"));
  const box = await machine(dir);
  t.after(async () => { await box.close(); await rm(dir, { recursive: true, force: true, maxRetries: 5 }); });

  await box.deliver({ type: "machine.conversation.sync", conversation: conversation() });
  const phone = await device(dir, "phone");
  await box.trust([rosterPeer(phone, box)]);
  assert.ok(box.host.peers.channel(phone.deviceId), "while trusted, the phone has a channel here");

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
  const owedToPhone = async () => (await events.listPending(box.pairing.rendezvousId, 0, phone.deviceId)).length +
    (await events.listPending(hubPairChannelId(box.identity.originId, phone.deviceId), 0, phone.deviceId)).length;
  const published = (await ownHubEvents(box)).find((event) => event.kind === "machine.approval.requested");
  assert.ok(published, "what the machine published is in its own log, for the server's order");
  // Nothing is kept per device, so there is no history to re-offer anyone.
  assert.equal(await owedToPhone(), 0, "no delivery row is kept for the phone, even while trusted");

  // The owner removes it. Its authority ends at once.
  await box.trust([]);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(box.host.peers.channel(phone.deviceId), undefined, "its channel is gone");
  const { event: late } = await phone.eventLog.appendLocalEvent({
    conversationId: CONVERSATION, kind: "machine.conversation.deleted",
    payload: { type: "machine.conversation.deleted", conversationId: CONVERSATION, deletedAt: new Date().toISOString() },
    logScopeId: `device:${hubPairChannelId(box.identity.originId, phone.deviceId)}:${JSON.stringify([CONVERSATION, "actions"])}`
  });
  assert.equal(await box.host.receiveFromHub(late), "not-mine", "a revoked device's command is nobody's here");
  assert.ok(await box.storage.getConversation(CONVERSATION), "and changes nothing");
  assert.equal(await owedToPhone(), 0,
    "a revoked device is not re-offered the room's history on every reconnect");
  // What the enrolling desktop reads is untouched: still in the machine's log.
  assert.ok((await ownHubEvents(box)).some((event) => event.eventId === published.eventId),
    "revoking one device does not discard what the others read");
});

function desktopChat(storage, dir, close = async () => undefined) {
  const chat = new ChatService(storage, { getPublicSettings: async () => ({}) },
    { closeConversationSessions: close }, { write: async () => undefined });
  chat.chatUserDataPath = () => dir;
  return chat;
}

function desktopLink(storage, eventLog, identity) {
  return new MachineLinkService({ listMachines: async () => [] }, { write: async () => undefined }, {
    appVersion: "test", desktopDeviceId: identity.originId, eventStorage: storage, eventLog,
    createClient: () => stubClient([])
  });
}

test("desktop row deletion and remote intent commit together; failed outbox writes survive restart", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-delete-intent-"));
  const storage = new StorageService({ dbPath: path.join(dir, "desktop.sqlite3") });
  const log = new ChatEventLogService(storage), identity = await log.getOrCreateDeviceIdentity();
  const initial = { ...conversation(), metadata: { ...conversation().metadata, archived: true } };
  await storage.saveConversation(initial);
  const first = desktopLink(storage, log, identity);
  const chat = desktopChat(storage, dir);
  chat.setConversationDeletedHandler(value => first.deleteConversationOnMachines(value));
  t.after(async () => { first.close(); await rm(dir, { recursive: true, force: true }); });
  // No connection exists at deletion time, including no channel/outbox yet.
  assert.equal(await chat.deleteConversation({ conversationId: CONVERSATION }), true);
  assert.equal(await storage.getConversation(CONVERSATION), undefined);
  assert.equal((await storage.conversationTombstones().pendingDeliveries()).length, 1);
  first.close();

  const restarted = new StorageService({ dbPath: path.join(dir, "desktop.sqlite3") });
  const second = desktopLink(restarted, new ChatEventLogService(restarted), identity);
  t.after(() => second.close());
  const { DeviceEventChannel } = require(path.join(repoRoot, "dist/main/main/services/deviceEventChannel.js"));
  const peerLog = new ChatEventLogService(new StorageService({ dbPath: path.join(dir, "peer.sqlite3") }));
  const peer = await peerLog.getOrCreateDeviceIdentity();
  const channel = new DeviceEventChannel({ storage: restarted, eventLog: new ChatEventLogService(restarted),
    channelId: "delete-intent-room", localDeviceId: identity.originId,
    peerDeviceId: peer.originId, peerPublicKeyDerBase64: peer.publicKeyDerBase64,
    send: async () => undefined, apply: async () => "applied", isPeerConnected: () => false,
    // As the desktop's link builds it (src/main/services/machineLink.ts): the
    // User's server carries the channel's events.
    hubMode: true });
  const connection = { record: { id: "machine-one" }, eventChannel: channel, outbound: Promise.resolve() };
  second.connections.set("machine-one", connection);
  const publish = channel.publish.bind(channel);
  channel.publish = async () => { throw new Error("SQLITE_FULL before outbox persistence"); };
  assert.equal(await second.deliverPendingConversationDeletions(), 0);
  assert.equal((await restarted.conversationTombstones().pendingDeliveries()).length, 1);
  channel.publish = publish;
  assert.equal(await second.deliverPendingConversationDeletions(), 1);
  const eventId = `machine-delete:${JSON.stringify([identity.originId, "machine-one", CONVERSATION])}`;
  assert.ok(await restarted.getChatEvent(eventId), "the desktop's log owns the immutable delete before intent removal");
  assert.equal((await restarted.conversationTombstones().pendingDeliveries()).length, 0);
  // It reaches the machine through the server's order: it is among the
  // desktop's own events in the machine's channel scope, which the desktop
  // pushes, and no delivery row waits on the machine.
  const own = await restarted.hub().ownEventsAfter(identity.originId, 0, 10_000, ["device:delete-intent-room:"]);
  assert.ok(own.some((row) => row.event.eventId === eventId), "the delete is in a scope the desktop pushes to the server");
  assert.deepEqual(await restarted.deviceEvents().listPending("delete-intent-room", 0, peer.originId), []);
  second.connections.clear(); channel.close();
});

test("failed deletion transaction leaves rows and artifacts live, with no remote intent", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-delete-rollback-"));
  const storage = new StorageService({ dbPath: path.join(dir, "desktop.sqlite3") });
  await storage.saveConversation({ ...conversation(), metadata: { participants: [PARTICIPANT], archived: true } });
  const chat = desktopChat(storage, dir);
  let cleanups = 0;
  chat.setArtifactCleanup(async () => { cleanups++; });
  t.after(() => rm(dir, { recursive: true, force: true }));
  await storage.runSql("create trigger reject_delete before delete on conversations begin select raise(abort,'injected delete failure'); end;");
  await assert.rejects(chat.deleteConversation({ conversationId: CONVERSATION }), /injected delete failure/);
  assert.ok(await storage.getConversation(CONVERSATION));
  assert.equal(await storage.conversationTombstones().isDeleted(CONVERSATION), false);
  assert.deepEqual(await storage.conversationTombstones().pendingDeliveries(), []);
  await chat.reconcileDeletedConversationArtifacts();
  assert.equal(cleanups, 0, "a pre-transaction marker must not erase a surviving chat's artifacts");
});

test("tombstones fence independent stale writers and desktop replication after restart", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-delete-writer-"));
  const dbPath = path.join(dir, "desktop.sqlite3");
  const storage = new StorageService({ dbPath }), staleWriter = new StorageService({ dbPath });
  const stale = conversation();
  await staleWriter.saveConversation(stale);
  await storage.deleteConversation(CONVERSATION);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(staleWriter.saveConversation(stale), /permanently deleted/);
  const restarted = new StorageService({ dbPath });
  const chat = desktopChat(restarted, dir);
  await chat.applyReplicatedConversation(CONVERSATION, () => stale);
  assert.equal(await chat.applyMachineBackDelta({ conversationId: CONVERSATION, messages: stale.messages }), undefined);
  await chat.applyMachineLateTerminal({ conversationId: CONVERSATION, runId: "late", status: "completed", messages: stale.messages, machineName: "peer" });
  assert.equal(await restarted.getConversation(CONVERSATION), undefined);
});

test("a failed provider closure is unacknowledged and retries after machine restart", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-delete-close-"));
  const first = await machine(dir, { close: async () => { throw new Error("native descendants still live"); } });
  await first.deliver({ type: "machine.conversation.sync", conversation: conversation() });
  // The server's order moves on once the machine stored the command; the
  // machine's channel holds it unapplied (no receipt) and retries it itself.
  const deletion = await first.deliver({ type: "machine.conversation.deleted", conversationId: CONVERSATION, deletedAt: new Date().toISOString() });
  assert.ok(await first.storage.getChatEvent(deletion.eventId), "the command is kept on the machine");
  assert.equal(await first.storage.deviceEvents().receipt(deletion.eventId), undefined, "and not acknowledged as applied");
  assert.ok(await first.storage.getConversation(CONVERSATION), "rows survive until closure can be proved");
  assert.equal(await first.storage.conversationTombstones().isDeleted(CONVERSATION), true);
  await first.close();
  const second = await machine(dir);
  t.after(async () => { await second.close(); await rm(dir, { recursive: true, force: true, maxRetries: 5 }); });
  assert.equal(await second.storage.getConversation(CONVERSATION), undefined, "startup finishes the tombstoned copy before admitting work");
  assert.ok(second.closed.length >= 1 && second.closed.every(id => id === CONVERSATION), "startup and ingress replay may both prove closure");
});

test("a turn already waiting behind another participant turn cannot start after deletion", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-delete-queue-"));
  const box = await machine(dir);
  t.after(async () => { await box.close(); await rm(dir, { recursive: true, force: true, maxRetries: 5 }); });
  await box.deliver({ type: "machine.conversation.sync", conversation: conversation() });
  let release;
  box.host.commandSessions.set(`${CONVERSATION}:${PARTICIPANT.id}`, new Promise(resolve => { release = resolve; }));
  const pending = box.host.runTurn({ type: "machine.turn.request", conversationId: CONVERSATION,
    participantId: PARTICIPANT.id, participant: PARTICIPANT, runId: "queued-before-delete", messageId: "m1", pendingMessageId: "p" });
  await box.deliver({ type: "machine.conversation.deleted", conversationId: CONVERSATION, deletedAt: new Date().toISOString() });
  release();
  await pending;
  assert.deepEqual(box.runs, []);
});
