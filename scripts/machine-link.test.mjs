import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createReferenceRelayServer } = require("./relay-reference-server.cjs");

// Machines transport: desktop MachineLinkService <-> machine MachineHostService
// through the reference relay, sealed with a machine-host pairing.
test("machine link replicates settings and conversations, runs a turn, streams progress, and cancels", async () => {
  const { MachineLinkService } = await import("../dist/main/main/services/machineLink.js");
  const { MachineHostService } = await import("../dist/main/main/services/machineHost.js");
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  try {
    const pairing = machinePairing(address.url);
    const record = { id: "machine-1", name: "Test box", deviceId: "", pairingKey: pairing.rendezvousId, createdAt: new Date().toISOString() };
    const desktopSettings = {
      listMachines: async () => [record],
      saveMachine: async (next) => { Object.assign(record, next); return [record]; },
      removeMachine: async () => [],
      getMachinePairing: async (key) => (key === pairing.rendezvousId ? pairing : undefined),
      exportMachineSettingsSnapshot: async () => ({ version: 1, exportedAt: new Date().toISOString(), settingsJson: JSON.stringify({ chatRoleConfigs: [{ id: "engineer" }] }), agentEnvironment: [{ key: "GH_TOKEN", value: "secret" }] })
    };
    const logs = [];
    const debugLogs = { write: async (event, payload) => { logs.push({ event, payload }); } };
    const link = new MachineLinkService(desktopSettings, debugLogs, { appVersion: "test", desktopDeviceId: "device-desktop", reconnectDelayMs: 50 });

    const machineStore = new Map();
    const importedSnapshots = [];
    const hostRuns = [];
    let releaseLongTurn;
    const hostChat = {
      runMachineHostedTurn: async (request, signal, progress) => {
        hostRuns.push(request);
        progress?.({ runId: request.runId, phase: "debate", message: "working", createdAt: new Date().toISOString() });
        if (request.messageId === "msg-long") {
          await new Promise((resolve) => { releaseLongTurn = resolve; signal?.addEventListener("abort", resolve, { once: true }); });
          if (signal?.aborted) {
            return { messages: [], warnings: [] };
          }
        }
        const conversation = machineStore.get(request.conversationId);
        const reply = { id: request.pendingMessageId, role: "participant", participantId: request.participantId, participantLabel: "@bot", content: `reply to ${request.messageId}`, createdAt: new Date().toISOString(), status: "done", metadata: { runId: request.runId } };
        conversation.messages.push(reply);
        return { messages: [reply], warnings: ["w1"] };
      },
      cancelRun: () => true
    };
    const hostStorage = {
      getConversation: async (id) => machineStore.get(id),
      saveConversation: async (conversation) => { machineStore.set(conversation.id, conversation); return conversation.id; }
    };
    const hostSettings = { importMachineSettingsSnapshot: async (snapshot) => { importedSnapshots.push(snapshot); } };
    const host = new MachineHostService(hostChat, hostStorage, hostSettings, debugLogs, {
      pairing,
      deviceId: "device-machine-1",
      machineName: "test-box",
      appVersion: "test",
      detectProviders: async () => [{ kind: "codex-cli", label: "Codex", installed: true, version: "0.153.4" }],
      reconnectDelayMs: 50
    });

    await link.start();
    await host.start();
    await waitFor(() => link.status()[0]?.connected === true, 5_000);
    await waitFor(() => record.lastHello?.machineName === "test-box", 5_000);
    assert.equal(record.deviceId, "device-machine-1");
    await waitFor(() => importedSnapshots.length >= 1, 5_000);

    const participant = { id: "p1", handle: "bot", roleConfigId: "engineer", kind: "codex-cli", homeMachineId: "machine-1" };
    const conversation = {
      id: "conv-1", kind: "chat", title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      messages: [{ id: "msg-1", role: "user", content: "hi", createdAt: new Date().toISOString(), status: "done" }],
      metadata: { participants: [participant], participantSessions: [{ participantId: "p1", sessionId: "desktop-session" }], activeRunIds: ["run-1"] },
      findings: []
    };
    const progressSeen = [];
    const result = await link.runTurn({
      conversation, participant, triggerMessage: conversation.messages[0], runId: "run-1", pendingMessageId: "pending-1",
      progress: (progress) => progressSeen.push(progress)
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(result.warnings, ["w1"]);
    assert.equal(result.messages[0].id, "pending-1");
    assert.equal(result.messages[0].content, "reply to msg-1");
    assert.equal(progressSeen.length, 1);
    assert.equal(hostRuns[0].pendingMessageId, "pending-1");
    // The machine keeps its own run bookkeeping and sessions, not the desktop's.
    const copy = machineStore.get("conv-1");
    assert.equal(copy.metadata.activeRunIds, undefined);
    assert.equal(copy.metadata.participantSessions, undefined);
    assert.equal(copy.messages.length, 2);

    // Second turn: only the new message travels as a delta and lands in the copy.
    conversation.messages.push({ id: "msg-2", role: "user", content: "again", createdAt: new Date().toISOString(), status: "done" });
    const second = await link.runTurn({ conversation, participant, triggerMessage: conversation.messages[1], runId: "run-2", pendingMessageId: "pending-2" });
    assert.equal(second.status, "completed");
    assert.ok(machineStore.get("conv-1").messages.some((message) => message.id === "msg-2"));
    assert.equal(importedSnapshots.length, 3, "settings travel with every turn request");

    // Cancel: the desktop aborts, the machine's turn signal fires, the result is interrupted.
    conversation.messages.push({ id: "msg-long", role: "user", content: "slow", createdAt: new Date().toISOString(), status: "done" });
    const controller = new AbortController();
    const pendingLong = link.runTurn({ conversation, participant, triggerMessage: conversation.messages[2], runId: "run-3", pendingMessageId: "pending-3", signal: controller.signal });
    await waitFor(() => hostRuns.length === 3 && typeof releaseLongTurn === "function", 5_000);
    controller.abort();
    const third = await pendingLong;
    assert.equal(third.status, "interrupted");

    link.close();
    host.close();
  } finally {
    await relay.close();
  }
});

test("machine link fails fast when the machine is not connected", async () => {
  const { MachineLinkService } = await import("../dist/main/main/services/machineLink.js");
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  try {
    const pairing = machinePairing(address.url);
    const record = { id: "machine-2", name: "Offline box", deviceId: "", pairingKey: pairing.rendezvousId, createdAt: new Date().toISOString() };
    const link = new MachineLinkService({
      listMachines: async () => [record],
      saveMachine: async () => [record],
      removeMachine: async () => [],
      getMachinePairing: async () => pairing,
      exportMachineSettingsSnapshot: async () => ({ version: 1, exportedAt: "", settingsJson: "{}", agentEnvironment: [] })
    }, { write: async () => undefined }, { appVersion: "test", desktopDeviceId: "device-desktop", reconnectDelayMs: 50 });
    await link.start();
    const result = await link.runTurn({
      conversation: { id: "c", kind: "chat", title: "", createdAt: "", updatedAt: "", messages: [], metadata: {}, findings: [] },
      participant: { id: "p", handle: "bot", roleConfigId: "r", kind: "codex-cli", homeMachineId: "machine-2" },
      triggerMessage: { id: "m", role: "user", content: "", createdAt: "", status: "done" },
      runId: "r", pendingMessageId: "pm"
    });
    assert.equal(result.status, "failed");
    assert.match(result.error, /not connected/);
    link.close();
  } finally {
    await relay.close();
  }
});

function machinePairing(relayUrl) {
  const now = Date.now();
  return {
    version: 1,
    purpose: "machine-host",
    issuer: { originId: "device-desktop", keyId: "key-desktop", publicKeyDerBase64: "AA==" },
    rendezvousId: "rv-machine-test-" + now,
    stableRoutingId: "route-machine-test",
    relaySealKeyBase64: Buffer.from(new Uint8Array(32).map((_, index) => index + 1)).toString("base64url"),
    relayUrl,
    capabilities: [{ scope: "device", canRead: true, canWrite: true, canRunCloudParticipants: true, canListConversations: true }],
    fingerprint: "TEST-CAP",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString()
  };
}

function waitFor(predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("waitFor timed out"));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}
