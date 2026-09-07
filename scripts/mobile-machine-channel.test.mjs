/**
 * The phone's whole control path, end to end in one process.
 *
 * Not "a command was generated": the User's action goes into this phone's own
 * journal in one transaction, over a connection that is held open, into a real
 * MachineHostService, and the machine's answer comes back the same way, is
 * verified, applied here, acknowledged, and only then released.
 *
 * The cases are the ones that used to lose things: the same ask twice, a
 * reload in the middle, two tabs, a connection that is not there, an
 * acknowledgement from the wrong key, and this phone's own storage failing.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "..");
const phone = require(path.join(repoRoot, "src/mobile/mobile-machine-command.js"));
const { createMobileEventLog } = require(path.join(repoRoot, "src/mobile/mobile-event-log.js"));
const { createMachineChannels } = require(path.join(repoRoot, "src/mobile/mobile-machine-channel.js"));
const { MachineHostService } = require(path.join(repoRoot, "dist/main/main/services/machineHost.js"));
const { StorageService } = require(path.join(repoRoot, "dist/main/main/services/storage.js"));
const { ChatEventLogService } = require(path.join(repoRoot, "dist/main/main/services/chatEventLog.js"));
const { sealMobileRelayPayload, openMobileRelayPayload } =
  require(path.join(repoRoot, "dist/main/main/services/mobileRelaySealing.js"));

const CONVERSATION = "phone-chat";
const PARTICIPANT = { id: "p1", handle: "bot", kind: "codex-cli", roleConfigId: "engineer", homeMachineId: "machine-one" };
const SEAL_KEY = Buffer.alloc(32, 23).toString("base64url");

/** A store the tests can break on demand, with real transaction semantics. */
function memoryPort() {
  const stores = new Map([["events", new Map()], ["outbox", new Map()], ["meta", new Map()]]);
  const keyOf = (store, value) => (store === "meta" ? value.key : value.eventId);
  const port = {
    failOn: null,
    async runAtomic(names, work) {
      const staged = new Map();
      for (const name of names) staged.set(name, new Map(stores.get(name)));
      const tx = {
        async get(name, key) { return staged.get(name).get(key); },
        async getAll(name) { return [...staged.get(name).values()].map((value) => structuredClone(value)); },
        async put(name, value) {
          if (port.failOn === name) throw new Error("QuotaExceededError: " + name);
          staged.get(name).set(keyOf(name, value), structuredClone(value));
        },
        async remove(name, key) { staged.get(name).delete(key); }
      };
      const result = await work(tx);
      for (const [name, values] of staged) stores.set(name, values);
      return result;
    },
    dump(name) { return [...stores.get(name).values()]; }
  };
  return port;
}

/** A socket the two sides really speak through, so the channel's own
 *  connect/close/reconnect handling is exercised rather than stubbed out. */
function socketPair() {
  const listeners = new Map();
  const socket = {
    readyState: 1,
    sent: [],
    onSend: undefined,
    addEventListener(type, handler) {
      const held = listeners.get(type) || [];
      held.push(handler);
      listeners.set(type, held);
    },
    send(text) { socket.sent.push(text); void socket.onSend?.(text); },
    close() {
      socket.readyState = 3;
      for (const handler of listeners.get("close") || []) handler({});
    },
    emit(data) {
      for (const handler of listeners.get("message") || []) handler({ data });
    }
  };
  return socket;
}

function chunk(request) {
  return [{
    protocol: "accord-relay-v1", streamId: request.streamId, logicalMessageId: request.logicalMessageId,
    index: 0, total: 1, ciphertext: request.ciphertext, to: request.to
  }];
}

function reassemble(frames) {
  const frame = frames[0];
  return { status: "complete", ciphertext: frame.ciphertext, logicalMessageId: frame.logicalMessageId };
}

async function machineBox(options = {}) {
  const hooks = { onOutbound: undefined };
  const dir = await mkdtemp(path.join(tmpdir(), "accord-phone-channel-"));
  const storage = new StorageService({ dbPath: path.join(dir, "machine.sqlite3") });
  const eventLog = new ChatEventLogService(storage);
  const identity = await eventLog.getOrCreateDeviceIdentity();
  const desktopStorage = new StorageService({ dbPath: path.join(dir, "desktop.sqlite3") });
  const desktopLog = new ChatEventLogService(desktopStorage);
  const desktop = await desktopLog.getOrCreateDeviceIdentity();
  const pairing = {
    version: 1, purpose: "machine-host",
    issuer: { originId: desktop.originId, keyId: desktop.keyId, publicKeyDerBase64: desktop.publicKeyDerBase64 },
    rendezvousId: "phone-room", stableRoutingId: "phone-route",
    relaySealKeyBase64: SEAL_KEY, relayUrl: "ws://127.0.0.1:1/v1/relay",
    capabilities: [{ scope: "device", canRead: true, canWrite: true, canRunCloudParticipants: true, canListConversations: true }],
    fingerprint: "PHONE-TEST", createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString()
  };
  const runs = [];
  const aborted = [];
  const actions = [];
  const replicated = [];
  const outbound = [];
  const client = {
    on: () => () => undefined,
    connect: async () => undefined,
    close: () => undefined,
    sendCiphertext: async (request) => { outbound.push(request); await hooks.onOutbound?.(request); return []; }
  };
  const host = new MachineHostService(
    {
      runMachineHostedTurn: async (request, signal) => {
        runs.push(request.runId);
        if (options.holdUntilAborted) {
          await new Promise((resolve) => {
            if (signal?.aborted) { aborted.push(request.runId); resolve(); return; }
            signal?.addEventListener("abort", () => { aborted.push(request.runId); resolve(); }, { once: true });
            setTimeout(resolve, 15_000);
          });
        }
        return {
          messages: [{ id: `reply-${request.runId}`, role: "participant", participantId: PARTICIPANT.id,
            participantLabel: "@bot", content: options.replyContent || "answered from the machine",
            createdAt: new Date().toISOString(), status: "done" }],
          warnings: []
        };
      },
      cancelRun: () => true,
      respondToAppToolApproval: async () => undefined,
      applyReplicatedConversation: async (conversationId, merge) => {
        const next = merge({ id: conversationId, kind: "chat", messages: [], metadata: { participants: [PARTICIPANT] } });
        if (next) replicated.push(...(next.messages ?? []));
      }
    },
    { getConversation: async () => ({ id: CONVERSATION, kind: "chat", messages: [], metadata: { participants: [PARTICIPANT] } }) },
    { importMachineSettingsSnapshot: async () => undefined },
    { write: async () => undefined },
    {
      pairing, deviceId: identity.originId, appVersion: "phone-channel-test",
      eventStorage: storage, eventLog, publicKeyDerBase64: identity.publicKeyDerBase64,
      outboxPath: path.join(dir, "outbox.json"), trustRosterPath: path.join(dir, "trust.json"),
      createClient: () => client, createPeerClient: () => client,
      // The seam the owner's own applier sits behind. This test is about what
      // the phone sends and what the machine accepts from it, so the applier
      // records rather than executes.
      chatActions: {
        handles: (event) => ["permission.decided", "choice.answered"].includes(event.kind),
        apply: async (event, payload) => {
          actions.push({ kind: event.kind, payload, originId: event.originId });
          return { status: "applied", kind: event.kind, targetKey: payload?.targetKey };
        }
      }
    }
  );
  await host.start();
  await host.handleBody({ type: "machine.hello.ack", desktopDeviceId: desktop.originId, appVersion: "t", machineId: "machine-one" });
  return {
    host, runs, aborted, actions, replicated, outbound, pairing, identity, desktop, dir, hooks,
    trust: async (peers) => {
      const body = { type: "machine.trust.roster", conversationId: `machine-trust:${pairing.rendezvousId}`,
        roster: { version: 1, issuerDeviceId: desktop.originId, updatedAt: new Date().toISOString(), peers } };
      const { event } = await desktopLog.appendLocalEvent({ conversationId: body.conversationId,
        logScopeId: phone.deviceEventScope(pairing.rendezvousId, body.conversationId, "actions"), kind: body.type, payload: body });
      await host.handleMessage(await sealMobileRelayPayload(
        phone.eventPacket(desktop.originId, identity.originId, event), SEAL_KEY));
    },
    cleanup: async () => {
      host.close();
      await new Promise((resolve) => setTimeout(resolve, 250));
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
    }
  };
}

function machineAccess(box) {
  return {
    machineId: "machine-one", name: "Machine", deviceId: box.identity.originId,
    publicKeyDerBase64: box.identity.publicKeyDerBase64, relayUrl: box.pairing.relayUrl,
    rendezvousId: box.pairing.rendezvousId, relaySealKeyBase64: SEAL_KEY, fingerprint: box.pairing.fingerprint
  };
}

function phonePeer(identity, pairing) {
  return {
    deviceId: identity.deviceId, publicKeyDerBase64: identity.publicKeyDerBase64, role: "phone", name: "Phone",
    relayUrl: pairing.relayUrl, rendezvousId: pairing.rendezvousId,
    relaySealKeyBase64: SEAL_KEY, fingerprint: pairing.fingerprint
  };
}

function phoneLog(port, identity) {
  return createMobileEventLog({
    port, originId: identity.deviceId, keyId: identity.keyId,
    hashPayload: async (payload) => "sha256:" + await phone.sha256Hex(phone.textBytes(phone.stableJson(payload))),
    hashEvent: async (unsigned) => "sha256:" + await phone.sha256Hex(phone.textBytes(phone.stableJson(unsigned))),
    sign: (eventHash) => phone.signEventHash(identity, eventHash)
  });
}

/** The phone's body store, with the rule that matters: an incomplete or
 *  altered body does not read back as a body at all. */
function memoryBlobs() {
  const parts = new Map();
  return {
    store: async (fragment) => {
      parts.set(fragment.reference.blobHash + ":" + fragment.index, Buffer.from(fragment.bytesBase64, "base64"));
    },
    take: async (reference) => {
      const held = [];
      for (let index = 0; index < reference.fragments; index += 1) {
        const part = parts.get(reference.blobHash + ":" + index);
        if (!part) return undefined;
        held.push(part);
      }
      const bytes = Buffer.concat(held);
      if (bytes.byteLength !== reference.byteLength) return undefined;
      if ("sha256:" + createHash("sha256").update(bytes).digest("hex") !== reference.blobHash) return undefined;
      return JSON.parse(bytes.toString("utf8"));
    },
    count: () => parts.size
  };
}

/** The phone, its journal and its connection, wired to a machine's ingress. */
async function phoneOn(box, identity, options = {}) {
  const port = options.port || memoryPort();
  const log = phoneLog(port, identity);
  await log.restore();
  const applied = [];
  const socket = socketPair();
  socket.onSend = async (text) => {
    const frame = JSON.parse(text);
    await box.host.handleMessage(frame.ciphertext);
  };
  box.hooks.onOutbound = undefined;
  const channels = createMachineChannels({
    api: phone, identity, log,
    blobs: options.blobs || memoryBlobs(),
    seal: (payload, key) => sealMobileRelayPayload(payload, key),
    open: (ciphertext, key) => openMobileRelayPayload(ciphertext, key),
    chunk, reassemble,
    connect: async () => {
      if (options.offline && options.offline()) throw new Error("Relay tunnel reconnecting.");
      return socket;
    },
    apply: async (event, payload) => {
      if (options.applyFails && options.applyFails()) throw new Error("IndexedDB write failed.");
      applied.push({ kind: event.kind, payload });
      return "applied";
    },
    debug: () => undefined
  });
  channels.setMachines([machineAccess(box)]);
  return { port, log, channels, applied, socket };
}

/** Everything the machine sends this phone, delivered to its channel. */
function deliverMachineTraffic(box, device) {
  box.hooks.onOutbound = async (request) => {
    if (request.to && request.to !== device.identityId) return;
    device.socket.emit(JSON.stringify(chunk({
      streamId: "machine", logicalMessageId: request.logicalMessageId, ciphertext: request.ciphertext, to: request.to
    })[0]));
  };
}

async function settle(check, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test("the User's ask reaches the machine, its answer reaches the phone, and only then is it released", async () => {
  const identity = await phone.createIdentity();
  const box = await machineBox();
  try {
    await box.trust([phonePeer(identity, box.pairing)]);
    const device = await phoneOn(box, identity);
    device.identityId = identity.deviceId;
    deliverMachineTraffic(box, device);

    const scope = phone.deviceEventScope(box.pairing.rendezvousId, CONVERSATION, "actions");
    await device.log.append({
      eventId: "phone-delta-run-1", conversationId: CONVERSATION, logScopeId: scope,
      kind: "machine.conversation.delta", recipients: [box.identity.originId],
      payload: { type: "machine.conversation.delta", conversationId: CONVERSATION,
        messages: [{ id: "msg-1", role: "user", content: "run it", createdAt: new Date().toISOString(), status: "done" }],
        updatedAt: new Date().toISOString() }
    });
    await device.log.append({
      eventId: phone.machineCommandEventId("run-1"), conversationId: CONVERSATION, logScopeId: scope,
      kind: "machine.turn.request", recipients: [box.identity.originId],
      payload: phone.turnRequest({ conversationId: CONVERSATION, participant: PARTICIPANT,
        messageId: "msg-1", runId: "run-1", pendingMessageId: "pending-run-1" })
    });
    await device.channels.deliver("machine-one");

    assert.equal(await settle(() => box.runs.length === 1), true, "the machine ran the turn the phone asked for");
    assert.equal(box.replicated.some((message) => message.id === "msg-1"), true, "the row the turn answers travelled with it");

    // The answer comes back on the same connection, is applied here, and the
    // acknowledgement is what finally lets the ask be forgotten.
    assert.equal(await settle(() => device.applied.some((entry) => entry.kind === "machine.turn.finished")), true,
      "the machine's result is applied on the phone");
    assert.equal(await settle(async () => (await device.log.pendingFor(box.identity.originId)).length === 0), true,
      "an acknowledged ask is no longer owed");
    const decision = await device.log.retention([box.identity.originId]);
    assert.deepEqual(decision.retained, [], "nothing is retained once the machine has acknowledged it");
  } finally { await box.cleanup(); }
});

test("the same ask twice, a reload and a second tab are one command and one run", async () => {
  const identity = await phone.createIdentity();
  const box = await machineBox();
  try {
    await box.trust([phonePeer(identity, box.pairing)]);
    const device = await phoneOn(box, identity);
    device.identityId = identity.deviceId;
    deliverMachineTraffic(box, device);
    const scope = phone.deviceEventScope(box.pairing.rendezvousId, CONVERSATION, "actions");
    const ask = {
      eventId: phone.machineCommandEventId("run-once"), conversationId: CONVERSATION, logScopeId: scope,
      kind: "machine.turn.request", recipients: [box.identity.originId],
      payload: phone.turnRequest({ conversationId: CONVERSATION, participant: PARTICIPANT,
        messageId: "msg-once", runId: "run-once", pendingMessageId: "pending-run-once" })
    };
    const first = await device.log.append(ask);
    const again = await device.log.append(ask);
    assert.equal(again.eventId, first.eventId);
    assert.equal(again.originSeq, first.originSeq, "a repeated tap does not consume a second sequence number");

    // A reload: the same storage, a new log. A second tab: another one on top.
    const reloaded = phoneLog(device.port, identity);
    await reloaded.restore();
    const other = phoneLog(device.port, identity);
    await other.restore();
    const third = await other.append(ask);
    assert.equal(third.originSeq, first.originSeq, "a second tab does not fork this device's log");
    const next = await reloaded.append({
      ...ask,
      eventId: phone.machineCommandEventId("run-second"),
      payload: phone.turnRequest({ conversationId: CONVERSATION, participant: PARTICIPANT,
        messageId: "msg-second", runId: "run-second", pendingMessageId: "pending-run-second" })
    });
    assert.equal(next.originSeq, first.originSeq + 1, "the sequence continues rather than restarting");

    await device.channels.deliver("machine-one");
    await device.channels.deliver("machine-one");
    assert.equal(await settle(() => box.runs.length >= 1), true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(box.runs.filter((runId) => runId === "run-once"), ["run-once"], "one run, however often it arrived");
  } finally { await box.cleanup(); }
});

test("an ask made with no connection is held, and delivered when there is one", async () => {
  const identity = await phone.createIdentity();
  const box = await machineBox();
  try {
    await box.trust([phonePeer(identity, box.pairing)]);
    let offline = true;
    const device = await phoneOn(box, identity, { offline: () => offline });
    device.identityId = identity.deviceId;
    deliverMachineTraffic(box, device);
    const scope = phone.deviceEventScope(box.pairing.rendezvousId, CONVERSATION, "actions");
    await device.log.append({
      eventId: phone.machineCommandEventId("run-offline"), conversationId: CONVERSATION, logScopeId: scope,
      kind: "machine.turn.request", recipients: [box.identity.originId],
      payload: phone.turnRequest({ conversationId: CONVERSATION, participant: PARTICIPANT,
        messageId: "msg-offline", runId: "run-offline", pendingMessageId: "pending-run-offline" })
    });
    await device.channels.deliver("machine-one").catch(() => undefined);
    assert.deepEqual(box.runs, [], "nothing ran while there was nowhere to send it");
    assert.equal((await device.log.pendingFor(box.identity.originId)).length, 1, "the ask is still owed, not lost");

    offline = false;
    await device.channels.deliver("machine-one");
    assert.equal(await settle(() => box.runs.length === 1), true, "the ask is delivered once there is a connection");
  } finally { await box.cleanup(); }
});

test("an acknowledgement from the wrong key releases nothing", async () => {
  const identity = await phone.createIdentity();
  const stranger = await phone.createIdentity();
  const box = await machineBox();
  try {
    await box.trust([phonePeer(identity, box.pairing)]);
    const device = await phoneOn(box, identity);
    device.identityId = identity.deviceId;
    const scope = phone.deviceEventScope(box.pairing.rendezvousId, CONVERSATION, "actions");
    const event = await device.log.append({
      eventId: phone.machineCommandEventId("run-forged"), conversationId: CONVERSATION, logScopeId: scope,
      kind: "machine.turn.request", recipients: [box.identity.originId],
      payload: phone.turnRequest({ conversationId: CONVERSATION, participant: PARTICIPANT,
        messageId: "msg-forged", runId: "run-forged", pendingMessageId: "pending-run-forged" })
    });
    // The attack this is here for: the room key is shared, so anyone in the
    // room can seal a packet that says it came from the machine. Only the
    // machine's own signing key makes it an acknowledgement.
    const forged = await phone.signPacket({ ...stranger, deviceId: box.identity.originId }, {
      protocol: "accord-device-events-v1", from: box.identity.originId, to: identity.deviceId, type: "ack",
      receipt: { eventId: event.eventId, eventHash: event.eventHash, outcome: "applied", appliedAt: new Date().toISOString() }
    });
    await device.channels.receiveSealed("machine-one", await sealMobileRelayPayload(forged, SEAL_KEY));
    assert.equal((await device.log.pendingFor(box.identity.originId)).length, 1,
      "a signature that is not the machine's does not release this phone's history");
  } finally { await box.cleanup(); }
});

test("a machine's result this phone cannot store is not acknowledged", async () => {
  const identity = await phone.createIdentity();
  const box = await machineBox();
  try {
    await box.trust([phonePeer(identity, box.pairing)]);
    let broken = true;
    const device = await phoneOn(box, identity, { applyFails: () => broken });
    device.identityId = identity.deviceId;
    deliverMachineTraffic(box, device);
    const scope = phone.deviceEventScope(box.pairing.rendezvousId, CONVERSATION, "actions");
    await device.log.append({
      eventId: phone.machineCommandEventId("run-broken"), conversationId: CONVERSATION, logScopeId: scope,
      kind: "machine.turn.request", recipients: [box.identity.originId],
      payload: phone.turnRequest({ conversationId: CONVERSATION, participant: PARTICIPANT,
        messageId: "msg-broken", runId: "run-broken", pendingMessageId: "pending-run-broken" })
    });
    await device.channels.deliver("machine-one");
    assert.equal(await settle(() => box.runs.length === 1), true);
    // The result arrived and could not be stored: it stays owed to this phone
    // rather than being acknowledged into nothing.
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(device.applied.length, 0, "nothing was applied while storage was failing");
    broken = false;
    await device.channels.drain("machine-one");
    assert.equal(await settle(() => device.applied.some((entry) => entry.kind === "machine.turn.finished")), true,
      "the held result is applied once storage works again");
  } finally { await box.cleanup(); }
});

test("a reply too large for one event arrives in fragments and is put back together", async () => {
  const identity = await phone.createIdentity();
  // Past BLOB_FRAGMENT_MAX_BYTES several times over, so the reply really is
  // split rather than merely moved out of the envelope.
  const long = "MACHINE_LONG_REPLY " + "x".repeat(900_000);
  const box = await machineBox({ replyContent: long });
  try {
    await box.trust([phonePeer(identity, box.pairing)]);
    const blobs = memoryBlobs();
    const device = await phoneOn(box, identity, { blobs });
    device.identityId = identity.deviceId;
    deliverMachineTraffic(box, device);
    const scope = phone.deviceEventScope(box.pairing.rendezvousId, CONVERSATION, "actions");
    await device.log.append({
      eventId: phone.machineCommandEventId("run-long"), conversationId: CONVERSATION, logScopeId: scope,
      kind: "machine.turn.request", recipients: [box.identity.originId],
      payload: phone.turnRequest({ conversationId: CONVERSATION, participant: PARTICIPANT,
        messageId: "msg-long", runId: "run-long", pendingMessageId: "pending-run-long" })
    });
    await device.channels.deliver("machine-one");
    assert.equal(await settle(() => box.runs.length === 1), true);
    assert.equal(await settle(() => device.applied.some((entry) => entry.kind === "machine.turn.finished")), true,
      "a long reply must still reach the phone");
    const finished = device.applied.find((entry) => entry.kind === "machine.turn.finished");
    assert.equal(finished.payload.messages[0].content, long, "and it must be the whole reply, not a truncated one");
    assert.ok(blobs.count() > 1, `it really did travel as more than one fragment (${blobs.count()})`);
  } finally { await box.cleanup(); }
});

test("Stop from the phone reaches the member that is running, not only the machine", async () => {
  const identity = await phone.createIdentity();
  const box = await machineBox({ holdUntilAborted: true });
  try {
    await box.trust([phonePeer(identity, box.pairing)]);
    const device = await phoneOn(box, identity);
    device.identityId = identity.deviceId;
    deliverMachineTraffic(box, device);
    const scope = phone.deviceEventScope(box.pairing.rendezvousId, CONVERSATION, "actions");
    await device.log.append({
      eventId: phone.machineCommandEventId("run-stop"), conversationId: CONVERSATION, logScopeId: scope,
      kind: "machine.turn.request", recipients: [box.identity.originId],
      payload: phone.turnRequest({ conversationId: CONVERSATION, participant: PARTICIPANT,
        messageId: "msg-stop", runId: "run-stop", pendingMessageId: "pending-run-stop" })
    });
    await device.channels.deliver("machine-one");
    assert.equal(await settle(() => box.runs.length === 1), true, "the turn is running on the machine");

    // The Stop the User taps, as the phone sends it.
    await device.log.append({
      eventId: phone.machineCancelEventId("run-stop"), conversationId: CONVERSATION, logScopeId: scope,
      kind: "machine.turn.cancel", recipients: [box.identity.originId],
      payload: phone.cancelRequest({ conversationId: CONVERSATION, runId: "run-stop" })
    });
    await device.channels.deliver("machine-one");
    assert.equal(await settle(() => box.aborted.includes("run-stop"), 200), true,
      "the running member's own turn must be aborted, not merely recorded as cancelled");
  } finally { await box.cleanup(); }
});

test("a permission a member raises on a machine reaches the phone, and the phone's answer reaches the member", async () => {
  const identity = await phone.createIdentity();
  const box = await machineBox();
  try {
    await box.trust([phonePeer(identity, box.pairing)]);
    const device = await phoneOn(box, identity);
    device.identityId = identity.deviceId;
    deliverMachineTraffic(box, device);

    // The machine's own conversation gains a pending approval, exactly as it
    // does when a member asks for permission while running there.
    box.host.noteConversationSnapshot({
      id: CONVERSATION, kind: "chat", messages: [], updatedAt: new Date().toISOString(),
      metadata: {
        participants: [PARTICIPANT],
        pendingAppToolApprovals: [{
          id: "approval-1", status: "pending", summary: "Write phone-approval-qa.txt",
          requesterHandle: "bot", createdAt: new Date().toISOString()
        }]
      }
    });
    assert.equal(await settle(() => device.applied.some((entry) => entry.kind === "machine.approval.requested")), true,
      "the phone must be shown the permission its member is waiting on");
    const raised = device.applied.find((entry) => entry.kind === "machine.approval.requested");
    assert.equal(raised.payload.approval.id, "approval-1");
    assert.equal(raised.payload.approval.summary, "Write phone-approval-qa.txt",
      "with the words the desktop would show, not a simplified copy");

    // The User taps Allow. The phone emits the same chat action every device
    // emits, on the shared action log.
    const answer = await device.log.append({
      eventId: "phone-action:permission:approval-1:allow",
      conversationId: CONVERSATION, logScopeId: "chat:actions", kind: "permission.decided",
      recipients: [box.identity.originId],
      payload: { operationId: "permission:approval-1:allow", targetKey: "approval:approval-1",
        stateId: "approved", detail: { approve: true } }
    });
    await device.channels.deliver("machine-one");
    assert.equal(await settle(() => box.actions.length === 1), true, "the machine must apply the phone's answer");
    assert.equal(box.actions[0].kind, "permission.decided");
    assert.equal(box.actions[0].payload.targetKey, "approval:approval-1");
    assert.equal(box.actions[0].originId, identity.deviceId, "and know which device answered");

    // Answered is not the same as sent: the phone stops owing it only once the
    // machine has acknowledged applying it.
    assert.equal(await settle(async () => (await device.log.pendingFor(box.identity.originId)).length === 0), true,
      "an applied answer is acknowledged and released");
    const receipt = await device.log.receipt(identity.deviceId, answer.eventId);
    assert.equal(receipt, undefined, "the phone's own action is not its own receipt");
  } finally { await box.cleanup(); }
});

test("a body whose fragments did not all arrive is not applied and not acknowledged", async () => {
  const identity = await phone.createIdentity();
  const long = "MACHINE_HELD_REPLY " + "y".repeat(900_000);
  const box = await machineBox({ replyContent: long });
  try {
    await box.trust([phonePeer(identity, box.pairing)]);
    // A store that refuses to keep anything: the phone's own disk failing, or
    // a fragment lost. Either way the body cannot be read.
    let broken = true;
    const real = memoryBlobs();
    const blobs = {
      store: async (fragment) => {
        if (broken) throw new Error("QuotaExceededError: machineBlobs");
        return real.store(fragment);
      },
      take: (reference) => real.take(reference),
      count: () => real.count()
    };
    const device = await phoneOn(box, identity, { blobs });
    device.identityId = identity.deviceId;
    deliverMachineTraffic(box, device);
    const scope = phone.deviceEventScope(box.pairing.rendezvousId, CONVERSATION, "actions");
    await device.log.append({
      eventId: phone.machineCommandEventId("run-held"), conversationId: CONVERSATION, logScopeId: scope,
      kind: "machine.turn.request", recipients: [box.identity.originId],
      payload: phone.turnRequest({ conversationId: CONVERSATION, participant: PARTICIPANT,
        messageId: "msg-held", runId: "run-held", pendingMessageId: "pending-run-held" })
    });
    await device.channels.deliver("machine-one");
    assert.equal(await settle(() => box.runs.length === 1), true);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(device.applied.some((entry) => entry.kind === "machine.turn.finished"), false,
      "a body the phone could not keep must not be applied");
    const receipt = await device.log.receipt(box.identity.originId, "machine-terminal:machine-command:run-held");
    assert.equal(receipt, undefined, "and must not be acknowledged, so the machine keeps holding it");

    // The store works again and the machine re-offers what it still holds.
    broken = false;
    assert.equal(await settle(() => device.applied.some((entry) => entry.kind === "machine.turn.finished"), 300), true,
      "once the phone can keep the body, the held result is applied");
    const finished = device.applied.find((entry) => entry.kind === "machine.turn.finished");
    assert.equal(finished.payload.messages[0].content, long, "and it is the whole reply");
  } finally { await box.cleanup(); }
});
