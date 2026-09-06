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
  const merged = mergeReplicatedMessages([done], [swept]);
  assert.equal(merged[0].status, "done");
  assert.equal(merged[0].content, "The page title is Example Domain.");
  // A genuine later edit by the desktop (no sweep marker) still wins.
  const edited = { ...done, content: "edited on the desktop", metadata: { runId: "run-x" } };
  assert.equal(mergeReplicatedMessages([done], [edited])[0].content, "edited on the desktop");
});
