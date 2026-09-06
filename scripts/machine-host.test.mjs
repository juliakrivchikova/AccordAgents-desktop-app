import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const SEAL_KEY = Buffer.from(new Uint8Array(32).map((_, index) => index + 1)).toString("base64url");

function pairing() {
  const now = Date.now();
  return {
    version: 1,
    purpose: "machine-host",
    issuer: { originId: "device-desktop", keyId: "key-desktop", publicKeyDerBase64: "AA==" },
    rendezvousId: "rv-host-test-" + now,
    stableRoutingId: "route-host-test",
    relaySealKeyBase64: SEAL_KEY,
    relayUrl: "ws://127.0.0.1:1/v1/relay",
    capabilities: [{ scope: "device", canRead: true, canWrite: true, canRunCloudParticipants: true, canListConversations: true }],
    fingerprint: "TEST-CAP",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString()
  };
}

/** A relay client stand-in: the test injects inbound messages and reads what the machine sends. */
function stubClient() {
  const listeners = new Map();
  const sent = [];
  return {
    sent,
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return () => undefined;
    },
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) {
        listener(payload);
      }
    },
    async connect() {
      this.emit("peer", { type: "ready", deviceId: "device-machine-1", peerConnected: true, peers: [{ role: "desktop", deviceId: "device-desktop" }] });
    },
    close() {},
    async sendCiphertext(request) {
      sent.push(request);
      return [];
    }
  };
}

async function envelope(body) {
  const { sealMobileRelayPayload } = await import("../dist/main/main/services/mobileRelaySealing.js");
  return sealMobileRelayPayload({ protocol: "accord-machine-link-v1", messageId: `m-${Math.random()}`, sentAt: new Date().toISOString(), body }, SEAL_KEY);
}

async function sentBodies(client) {
  const { openMobileRelayPayload } = await import("../dist/main/main/services/mobileRelaySealing.js");
  const bodies = [];
  for (const request of client.sent) {
    bodies.push((await openMobileRelayPayload(request.ciphertext, SEAL_KEY)).body);
  }
  return bodies;
}

function settle(ms = 150) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("a turn waiting for a chat copy counts as held, and a stop removes it before the copy completes", async () => {
  const { MachineHostService } = await import("../dist/main/main/services/machineHost.js");
  const client = stubClient();
  const runs = [];
  const store = new Map();
  const logs = [];
  const host = new MachineHostService(
    {
      runMachineHostedTurn: async (request) => { runs.push(request.runId); return { messages: [], warnings: [] }; },
      cancelRun: () => true,
      respondToAppToolApproval: async () => undefined,
      applyReplicatedConversation: async (id, merge) => { const next = merge(store.get(id)); if (next) store.set(id, next); }
    },
    { getConversation: async (id) => store.get(id) },
    { importMachineSettingsSnapshot: async () => undefined },
    { write: async (event, payload) => { logs.push({ event, payload }); } },
    { pairing: pairing(), deviceId: "device-machine-1", appVersion: "test", createClient: () => client }
  );
  await host.start();
  await settle();
  const inbound = async (body) => { client.emit("message", { ciphertext: await envelope(body) }); await settle(); };
  await inbound({ type: "machine.hello.ack", desktopDeviceId: "device-desktop", appVersion: "test" });
  const shell = { id: "conv-1", kind: "chat", title: "t", createdAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z", metadata: { participants: [] }, messages: [], findings: [] };
  await inbound({ type: "machine.conversation.sync", conversation: shell });
  // The copy is still arriving: the turn waits instead of running or failing.
  await inbound({ type: "machine.turn.request", conversationId: "conv-1", participantId: "p1", participant: { id: "p1", handle: "bot" }, messageId: "m1", runId: "run-wait", pendingMessageId: "pending-wait", requestedAt: new Date().toISOString() });
  assert.deepEqual(runs, []);
  assert.ok(logs.some((entry) => entry.event === "machine-host.turn.awaiting-copy" && entry.payload?.runId === "run-wait"));
  // Asked about it, the machine holds it: no "unknown".
  await inbound({ type: "machine.turn.query", conversationId: "conv-1", runId: "run-wait" });
  let bodies = await sentBodies(client);
  assert.ok(!bodies.some((body) => body.type === "machine.turn.unknown"), "a waiting turn is held, not unknown");
  // Stop while waiting: a confirmed interruption is stored and reported, and the copy completing must not start it.
  await inbound({ type: "machine.turn.cancel", conversationId: "conv-1", runId: "run-wait" });
  bodies = await sentBodies(client);
  const terminal = bodies.find((body) => body.type === "machine.turn.finished" && body.runId === "run-wait");
  assert.ok(terminal, "a stopped waiting turn reports a result");
  assert.equal(terminal.status, "interrupted");
  await inbound({ type: "machine.conversation.sync.done", conversationId: "conv-1" });
  await settle(300);
  assert.deepEqual(runs, [], "the copy completing never starts a stopped turn");
  host.close();
});

test("the machine's hello lists turns waiting for a copy as active", async () => {
  const { MachineHostService } = await import("../dist/main/main/services/machineHost.js");
  const client = stubClient();
  const store = new Map();
  const host = new MachineHostService(
    {
      runMachineHostedTurn: async () => ({ messages: [], warnings: [] }),
      cancelRun: () => true,
      respondToAppToolApproval: async () => undefined,
      applyReplicatedConversation: async (id, merge) => { const next = merge(store.get(id)); if (next) store.set(id, next); }
    },
    { getConversation: async (id) => store.get(id) },
    { importMachineSettingsSnapshot: async () => undefined },
    { write: async () => undefined },
    { pairing: pairing(), deviceId: "device-machine-1", appVersion: "test", createClient: () => client }
  );
  await host.start();
  await settle();
  const inbound = async (body) => { client.emit("message", { ciphertext: await envelope(body) }); await settle(); };
  await inbound({ type: "machine.hello.ack", desktopDeviceId: "device-desktop", appVersion: "test" });
  await inbound({ type: "machine.conversation.sync", conversation: { id: "conv-2", kind: "chat", title: "t", createdAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z", metadata: { participants: [] }, messages: [], findings: [] } });
  await inbound({ type: "machine.turn.request", conversationId: "conv-2", participantId: "p1", participant: { id: "p1", handle: "bot" }, messageId: "m1", runId: "run-listed", pendingMessageId: "pending-listed", requestedAt: new Date().toISOString() });
  // A fresh link announces itself again; the hello must list the waiting turn.
  client.emit("peer", { type: "ready", deviceId: "device-machine-1", peerConnected: true, peers: [{ role: "desktop", deviceId: "device-desktop" }] });
  await settle();
  const bodies = await sentBodies(client);
  const hello = bodies.filter((body) => body.type === "machine.hello").pop();
  assert.ok(hello.activeRunIds.includes("run-listed"));
  host.close();
});

test("a desktop sweep never overrides an outcome the machine produced", async () => {
  const { mergeReplicatedMessages } = await import("../dist/main/main/services/machineHost.js");
  const done = { id: "bubble", role: "participant", participantId: "p1", content: "The page title is Example Domain.", createdAt: "2026-09-06T09:04:38.000Z", status: "done", metadata: { runId: "run-x" } };
  const swept = { ...done, content: "Interrupted before completion.", status: "error", metadata: { runId: "run-x", staleRunRecovery: { runId: "run-x", at: "2026-09-06T09:04:38.002Z" } } };
  const owned = new Set(["p1"]);
  const merged = mergeReplicatedMessages([done], [swept], [], owned);
  assert.equal(merged[0].status, "done");
  assert.equal(merged[0].content, "The page title is Example Domain.");
  // The same holds for a bubble the machine is still filling in.
  const partial = { ...done, content: "half", status: "pending" };
  assert.equal(mergeReplicatedMessages([partial], [swept], [], owned)[0].status, "pending");
  // The desktop is authoritative for its local member: its genuine recovery
  // must reach the machine's replica rather than leave a permanent pending row.
  assert.equal(mergeReplicatedMessages([partial], [swept], [], new Set(["other-member"]))[0].status, "error");
  // A genuine later edit by the desktop (no sweep marker) still wins.
  const edited = { ...done, content: "edited on the desktop", metadata: { runId: "run-x" } };
  assert.equal(mergeReplicatedMessages([done], [edited])[0].content, "edited on the desktop");
});

test("a ChatService native resume is listed, stopped and delivered through the host's result outbox", async () => {
  const { ChatService } = await import("../dist/main/main/services/chat.js");
  const { MachineHostService } = await import("../dist/main/main/services/machineHost.js");
  const client = stubClient();
  const logs = { write: async () => undefined };
  const chat = Object.create(ChatService.prototype);
  Object.assign(chat, {
    chatRunMeta: new Map(), chatRunControllers: new Map(), activeConversationRunIds: new Map(),
    remoteRunHandlesByRun: new Map(), participantRunSettledListeners: new Set(),
    appSendMessageCountsByRun: new Map(), appSendMessageImageBytesByRun: new Map(), debugLogs: logs,
    settledParticipantRunResult: async () => ({ messages: [{ id: "native-bubble", role: "participant", participantId: "p1", status: "error", content: "partial", createdAt: new Date().toISOString(), metadata: { runId: "native-resume", terminalReason: "user-stopped" } }], warnings: [] })
  });
  const host = new MachineHostService(chat, {}, {}, logs, { pairing: pairing(), deviceId: "device-machine-1", appVersion: "test", createClient: () => client });
  const controller = new AbortController();
  chat.registerTargetRun("native-resume", controller, { conversationId: "native-chat", participantId: "p1", participantHandle: "bot" });
  await host.start();
  client.emit("peer", { type: "ready", peers: [{ role: "desktop", deviceId: "device-desktop" }] });
  await settle();
  let bodies = await sentBodies(client);
  assert.ok(bodies.find((body) => body.type === "machine.hello").activeRunIds.includes("native-resume"));
  client.emit("message", { ciphertext: await envelope({ type: "machine.turn.query", conversationId: "native-chat", runId: "native-resume" }) });
  client.emit("message", { ciphertext: await envelope({ type: "machine.turn.cancel", conversationId: "native-chat", runId: "native-resume" }) });
  await settle();
  assert.equal(controller.signal.aborted, true, "Stop reaches the actual ChatService controller");
  bodies = await sentBodies(client);
  assert.equal(bodies.filter((body) => body.type === "machine.turn.unknown").length, 0);
  assert.equal(bodies.filter((body) => body.type === "machine.turn.finished").length, 0, "abort is not completion");
  chat.unregisterTargetRun("native-resume", controller);
  await settle();
  bodies = await sentBodies(client);
  const terminal = bodies.find((body) => body.type === "machine.turn.finished");
  assert.equal(terminal.status, "interrupted");
  assert.equal(terminal.messages[0].content, "partial");
  assert.ok(host.pendingTerminals.has("native-resume"), "result stays until the desktop acknowledges its saved copy");
  const newer = { ...terminal, receiptId: "newer-receipt", messages: [{ ...terminal.messages[0], content: "new result" }] };
  host.pendingTerminals.set("native-resume", newer);
  client.emit("message", { ciphertext: await envelope({ type: "machine.turn.finished.ack", conversationId: "native-chat", runId: "native-resume", receiptId: terminal.receiptId, finishedAt: terminal.finishedAt }) });
  await settle();
  assert.equal(host.pendingTerminals.get("native-resume"), newer, "an old ACK cannot remove a newer result, even with an equal finish timestamp");
  client.emit("message", { ciphertext: await envelope({ type: "machine.turn.finished.ack", conversationId: "native-chat", runId: "native-resume", receiptId: newer.receiptId, finishedAt: newer.finishedAt }) });
  await settle();
  assert.equal(host.pendingTerminals.has("native-resume"), false);
  host.close();
});
