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
    const approvalRequests = [];
    let failNextApplyContaining;
    let releaseLongTurn;
    const hostChat = {
      runMachineHostedTurn: async (request, signal, progress) => {
        hostRuns.push(request);
        // A large progress frame right before a small finished result: the desktop must apply them in order.
        progress?.({ runId: request.runId, phase: "debate", message: "working " + "x".repeat(request.messageId === "msg-1" ? 2_000_000 : 10), createdAt: new Date().toISOString() });
        if (request.messageId === "msg-fail") {
          throw new Error("provider exploded");
        }
        if (request.messageId === "msg-long" || request.messageId === "msg-away") {
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
      cancelRun: () => true,
      applyReplicatedConversation: async (id, merge) => {
        const next = merge(machineStore.get(id));
        if (next && failNextApplyContaining && next.messages.some((message) => message.id === failNextApplyContaining)) {
          failNextApplyContaining = undefined;
          throw new Error("SQLITE_FULL: disk is full");
        }
        if (next) machineStore.set(id, next);
      },
      respondToAppToolApproval: async (request) => {
        approvalRequests.push(request);
        if (request.approvalId === "approval-bad") {
          throw new Error("decision rejected by the native session");
        }
        const conversation = machineStore.get(request.conversationId);
        return { ...conversation, metadata: { ...conversation.metadata, pendingAppToolApprovals: [{ id: request.approvalId, status: "approved", updatedAt: new Date().toISOString() }] } };
      }
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
    // The machine keeps a result until the desktop has stored it and acknowledges.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(!logs.some((entry) => entry.event === "machine-host.terminal.acked" && entry.payload?.runId === "run-1"), "no ack before the desktop stored the result");
    result.acknowledge();
    await waitFor(() => logs.some((entry) => entry.event === "machine-host.terminal.acked" && entry.payload?.runId === "run-1"), 5_000);

    // Approval decisions carry the whole card answer and resolve with the machine's outcome,
    // after the desktop stored the machine's view of the card.
    const storedApprovals = [];
    link.onApproval(async (event) => { await new Promise((resolve) => setTimeout(resolve, 50)); storedApprovals.push(event.approval); });
    await link.respondToMachineApproval({ machineId: "machine-1", conversationId: "conv-1", approvalId: "approval-1", approve: true, scope: "once", draftOverride: { kind: "edited" }, codexDecisionId: "decision-7" });
    assert.equal(approvalRequests.length, 1);
    assert.ok(storedApprovals.length >= 1, "the card call returns only after the stored approval");
    assert.ok(storedApprovals.every((approval) => approval.status === "approved"));
    assert.deepEqual(approvalRequests[0].draftOverride, { kind: "edited" });
    assert.equal(approvalRequests[0].codexDecisionId, "decision-7");
    await assert.rejects(
      () => link.respondToMachineApproval({ machineId: "machine-1", conversationId: "conv-1", approvalId: "approval-bad", approve: false }),
      /rejected by the native session/
    );
    // The machine keeps its own run bookkeeping and sessions, not the desktop's.
    const copy = machineStore.get("conv-1");
    assert.equal(copy.metadata.activeRunIds, undefined);
    assert.equal(copy.metadata.participantSessions, undefined);
    assert.equal(copy.messages.length, 2);

    // Second turn: only the new message travels as a delta and lands in the copy.
    conversation.messages.push({ id: "msg-2", role: "user", content: "again", createdAt: new Date().toISOString(), status: "done" });
    const second = await link.runTurn({ conversation, participant, triggerMessage: conversation.messages[1], runId: "run-2", pendingMessageId: "pending-2" });
    assert.equal(second.status, "completed");
    second.acknowledge?.();
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

    // Stop before dispatch: an already-cancelled turn never reaches the machine.
    const runsBefore = hostRuns.length;
    const preAborted = new AbortController();
    preAborted.abort();
    const early = await link.runTurn({ conversation, participant, triggerMessage: conversation.messages[0], runId: "run-early", pendingMessageId: "pending-early", signal: preAborted.signal });
    assert.equal(early.status, "interrupted");
    // Stop during preparation (settings/replication in flight): same outcome.
    const midPrep = new AbortController();
    const midPrepTurn = link.runTurn({ conversation, participant, triggerMessage: conversation.messages[0], runId: "run-midprep", pendingMessageId: "pending-midprep", signal: midPrep.signal });
    midPrep.abort();
    assert.equal((await midPrepTurn).status, "interrupted");
    assert.equal(hostRuns.length, runsBefore, "cancelled turns are not dispatched");

    // A large chat travels as a shell plus bounded batches and arrives whole.
    const big = {
      id: "conv-big", kind: "chat", title: "Big", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      metadata: { participants: [participant] },
      messages: Array.from({ length: 400 }, (_, index) => ({ id: `big-${index}`, role: "user", content: "x".repeat(10_000), createdAt: new Date(Date.now() + index).toISOString(), status: "done" })),
      findings: []
    };
    const bigResult = await link.runTurn({ conversation: big, participant, triggerMessage: big.messages[399], runId: "run-big", pendingMessageId: "pending-big" });
    assert.equal(bigResult.status, "completed");
    bigResult.acknowledge?.();
    assert.equal(machineStore.get("conv-big").messages.length, 401);
    const bigDeltas = logs.filter((entry) => entry.event === "machine-host.message" && entry.payload?.type === "machine.conversation.delta" && entry.payload?.conversationId === "conv-big");
    assert.ok(bigDeltas.length >= 3, `expected batched deltas, saw ${bigDeltas.length}`);
    // What the desktop replicated is never echoed back as a back delta.
    const echoes = [];
    const stopEchoListener = link.onConversationBackDelta((delta) => { if (delta.conversationId === "conv-big") echoes.push(delta); });
    host.noteConversationSnapshot(machineStore.get("conv-big"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const echoedReplicated = echoes.flatMap((delta) => delta.messages.map((message) => message.id)).filter((id) => id.startsWith("big-"));
    assert.deepEqual(echoedReplicated, [], "replicated messages must not come back as a back delta");
    stopEchoListener();

    // A reply finished while the desktop was away is delivered on reconnect,
    // stored through the late-terminal listener, and acknowledged only then.
    const lateTerminals = [];
    let lateStoreDelay = 0;
    link.onLateTerminal(async (event) => { await new Promise((resolve) => setTimeout(resolve, lateStoreDelay)); lateTerminals.push({ ...event, storedAt: Date.now() }); });
    const backdeltas = [];
    link.onConversationBackDelta((delta) => backdeltas.push(delta));
    conversation.messages.push({ id: "msg-away", role: "user", content: "away", createdAt: new Date().toISOString(), status: "done" });
    releaseLongTurn = undefined;
    const awayTurn = link.runTurn({ conversation, participant, triggerMessage: conversation.messages[3], runId: "run-away", pendingMessageId: "pending-away" });
    await waitFor(() => hostRuns.length === runsBefore + 2 && typeof releaseLongTurn === "function", 5_000);
    await link.disconnectMachine("machine-1");
    await awayTurn.catch(() => undefined);
    await waitFor(() => logs.some((entry) => entry.event === "machine-host.desktop.away"), 5_000);
    releaseLongTurn();
    await waitFor(() => logs.some((entry) => entry.event === "machine-host.terminal.retry-later"), 5_000);
    lateStoreDelay = 150;
    await link.connectMachine(record);
    await waitFor(() => lateTerminals.some((event) => event.runId === "run-away" && event.status === "completed"), 5_000);
    const awayEvent = lateTerminals.find((event) => event.runId === "run-away");
    assert.ok(awayEvent.messages.some((message) => message.id === "pending-away"));
    await waitFor(() => logs.some((entry) => entry.event === "machine-host.terminal.acked" && entry.payload?.runId === "run-away"), 5_000);
    const ackedAt = Date.parse(logs.find((entry) => entry.event === "machine-host.terminal.acked" && entry.payload?.runId === "run-away").payload?.at ?? "") || Date.now();
    assert.ok(ackedAt >= awayEvent.storedAt, "the ack follows the stored late result");
    lateStoreDelay = 0;

    // A turn that fails while the desktop is away is stored as a failure on reconnect, not acknowledged silently.
    conversation.messages.push({ id: "msg-fail", role: "user", content: "boom", createdAt: new Date().toISOString(), status: "done" });
    await link.disconnectMachine("machine-1");
    await waitFor(() => logs.some((entry) => entry.event === "machine-host.desktop.away"), 5_000);
    await link.connectMachine(record);
    await waitFor(() => link.status()[0]?.connected === true, 5_000);
    const failTurn = await link.runTurn({ conversation, participant, triggerMessage: conversation.messages[conversation.messages.length - 1], runId: "run-fail", pendingMessageId: "pending-fail" });
    assert.equal(failTurn.status, "failed");
    assert.match(failTurn.error, /provider exploded/);
    failTurn.acknowledge?.();

    // A batch of the first copy that cannot be stored on the machine makes it ask for the copy again;
    // the completed copy never echoes back and the retry stores everything.
    const bigger = { ...big, id: "conv-bigger", messages: big.messages.map((message) => ({ ...message, id: message.id.replace("big-", "bigger-") })) };
    link.setConversationLoader(async (id) => (id === "conv-bigger" ? bigger : conversation));
    failNextApplyContaining = "bigger-200";
    const biggerEchoes = [];
    const stopBiggerEcho = link.onConversationBackDelta((delta) => { if (delta.conversationId === "conv-bigger") biggerEchoes.push(delta); });
    const biggerResult = await link.runTurn({ conversation: bigger, participant, triggerMessage: bigger.messages[399], runId: "run-bigger", pendingMessageId: "pending-bigger" });
    assert.equal(biggerResult.status, "failed", "a turn requested while the copy is incomplete fails honestly");
    assert.match(biggerResult.error, /not complete/);
    biggerResult.acknowledge?.();
    await waitFor(() => logs.filter((entry) => entry.event === "machine-host.message" && entry.payload?.type === "machine.conversation.sync.done" && entry.payload?.conversationId === "conv-bigger").length >= 2, 10_000);
    assert.ok(logs.some((entry) => entry.event === "machine-link.resync" && entry.payload?.conversationId === "conv-bigger"));
    await waitFor(() => machineStore.get("conv-bigger")?.messages.length === 400, 5_000);
    const retried = await link.runTurn({ conversation: bigger, participant, triggerMessage: bigger.messages[399], runId: "run-bigger-2", pendingMessageId: "pending-bigger-2" });
    assert.equal(retried.status, "completed");
    retried.acknowledge?.();
    host.noteConversationSnapshot(machineStore.get("conv-bigger"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(biggerEchoes.flatMap((delta) => delta.messages.map((message) => message.id)).filter((id) => id.startsWith("bigger-")), []);
    stopBiggerEcho();

    // Rule 2: a Stop while the machine is unreachable is held and shown as
    // waiting, delivered when the machine is back, and confirmed only then.
    const stopsWaiting = [];
    releaseLongTurn = undefined;
    const heldController = new AbortController();
    const heldTurn = link.runTurn({ conversation, participant, triggerMessage: conversation.messages[2], runId: "run-held", pendingMessageId: "pending-held", signal: heldController.signal, onStopPending: (name) => stopsWaiting.push(name) });
    await waitFor(() => typeof releaseLongTurn === "function", 5_000);
    host.client.close(); // the machine's own link drops (network blip); the turn keeps running there
    await waitFor(() => link.status()[0]?.connected === false, 5_000);
    heldController.abort();
    await waitFor(() => stopsWaiting.length === 1, 5_000);
    assert.equal(stopsWaiting[0], "Test box");
    await host.client.connect(); // the machine is back: hello, the stop is redelivered, the machine confirms
    const held = await heldTurn;
    assert.equal(held.status, "interrupted");

    // A machine restart closes the turns it lost instead of leaving them pending.
    releaseLongTurn = undefined;
    const lostTurn = link.runTurn({ conversation, participant, triggerMessage: conversation.messages[2], runId: "run-lost", pendingMessageId: "pending-lost" });
    await waitFor(() => typeof releaseLongTurn === "function", 5_000);
    host.close();
    const host2 = new MachineHostService(hostChat, hostStorage, hostSettings, debugLogs, {
      pairing, deviceId: "device-machine-1", machineName: "test-box", appVersion: "test", detectProviders: async () => [], reconnectDelayMs: 50,
      // An outbox that cannot be written: results stay in memory and the desktop is told.
      outboxPath: "/dev/null/machine-outbox.json"
    });
    await host2.start();
    const lost = await lostTurn;
    assert.equal(lost.status, "failed");
    assert.match(lost.error, /restarted/);

    // A stop held for a run the (restarted) machine does not know is answered
    // "unknown": the desktop drops the held stop and reports it unconfirmed.
    const unknownController = new AbortController();
    const unknownTurn = link.runTurn({ conversation, participant, triggerMessage: conversation.messages[2], runId: "run-unknown", pendingMessageId: "pending-unknown", signal: unknownController.signal });
    await waitFor(() => hostRuns.some((run) => run.runId === "run-unknown"), 5_000);
    // Pretend the machine forgot the run (as after a restart without the outbox entry).
    host2.activeTurns.delete("run-unknown");
    unknownController.abort();
    const unknown = await unknownTurn;
    assert.equal(unknown.status, "unconfirmed");
    unknown.acknowledge?.();
    await waitFor(() => (record.pendingCancels ?? []).length === 0, 5_000);
    // The failed outbox write is visible on the desktop as a machine warning.
    await waitFor(() => /outbox/.test(link.status()[0]?.warning ?? ""), 5_000);
    host2.close();

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
