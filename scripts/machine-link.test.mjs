import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { desktopEvents, hostEvents, DESKTOP_ID, MACHINE_ID, DESKTOP_ISSUER } from "./machine-test-events.mjs";

const require = createRequire(import.meta.url);
const { createReferenceRelayServer } = require("./relay-reference-server.cjs");

// Machines transport: desktop MachineLinkService <-> machine MachineHostService
// through the reference relay, sealed with a machine-host pairing.
test("machine link replicates settings and conversations, runs a turn, streams progress, and cancels", async () => {
  const { MachineLinkService } = await import("../dist/main/main/services/machineLink.js");
  const { MachineHostService } = await import("../dist/main/main/services/machineHost.js");
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  const capturedLogs = [];
  try {
    const pairing = machinePairing(address.url);
    const record = { id: "machine-1", name: "Test box", deviceId: "", pairingKey: pairing.rendezvousId, createdAt: new Date().toISOString() };
    let rejectRunRecord;
    let holdRunRecord;
    let releaseRunRecord;
    const desktopSettings = {
      listMachines: async () => [record],
      saveMachine: async (next) => {
        if (rejectRunRecord && next.pendingRuns?.some((run) => run.runId === rejectRunRecord)) {
          throw new Error("ENOSPC: cannot store the run intent");
        }
        if (holdRunRecord && next.pendingRuns?.some((run) => run.runId === holdRunRecord)) {
          holdRunRecord = undefined;
          await new Promise((resolve) => { releaseRunRecord = resolve; });
        }
        Object.assign(record, next); return [record];
      },
      removeMachine: async () => [],
      getMachinePairing: async (key) => (key === pairing.rendezvousId ? pairing : undefined),
      exportMachineSettingsSnapshot: async () => {
        if (settingsDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, settingsDelayMs));
        }
        return { version: 1, exportedAt: new Date().toISOString(), settingsJson: JSON.stringify({ chatRoleConfigs: [{ id: "engineer" }] }), agentEnvironment: [{ key: "GH_TOKEN", value: "secret" }] };
      }
    };
    const logs = capturedLogs;
    let settingsDelayMs = 0;
    const debugLogs = { write: async (event, payload) => { logs.push({ event, payload, at: Date.now() }); } };
    const link = new MachineLinkService(desktopSettings, debugLogs, { ...desktopEvents, appVersion: "test", desktopDeviceId: DESKTOP_ID, reconnectDelayMs: 50 });

    const machineStore = new Map();
    const importedSnapshots = [];
    const hostRuns = [];
    const messagesAtStart = new Map();
    const approvalRequests = [];
    let failNextApplyContaining;
    let releaseLongTurn;
    const hostChat = {
      runMachineHostedTurn: async (request, signal, progress) => {
        hostRuns.push(request);
        messagesAtStart.set(request.runId, machineStore.get(request.conversationId)?.messages.length);
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
      ...hostEvents,
      pairing,
      deviceId: MACHINE_ID,
      machineName: "test-box",
      appVersion: "test",
      detectProviders: async () => [{ kind: "codex-cli", label: "Codex", installed: true, version: "0.153.4" }],
      reconnectDelayMs: 50
    });

    await link.start();
    await host.start();
    await waitFor(() => link.status()[0]?.connected === true, 5_000);
    await waitFor(() => record.lastHello?.machineName === "test-box", 5_000);
    assert.equal(record.deviceId, MACHINE_ID);
    await waitFor(() => importedSnapshots.length >= 1, 5_000);

    const participant = { id: "p1", handle: "bot", roleConfigId: "engineer", kind: "codex-cli", homeMachineId: "machine-1" };
    const conversation = {
      id: "conv-1", kind: "chat", title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      messages: [{ id: "msg-1", role: "user", content: "hi", createdAt: new Date().toISOString(), status: "done" }],
      metadata: { participants: [participant], participantSessions: [{ participantId: "p1", sessionId: "desktop-session" }], activeRunIds: ["run-1"] },
      findings: []
    };
    const progressSeen = [];
    rejectRunRecord = "run-no-store";
    const refused = await link.runTurn({ conversation, participant, triggerMessage: conversation.messages[0], runId: rejectRunRecord, pendingMessageId: "pending-no-store" });
    assert.equal(refused.status, "failed");
    assert.match(refused.error, /ENOSPC/);
    assert.ok(!hostRuns.some((run) => run.runId === rejectRunRecord), "a failed intent write must never start a provider turn");
    rejectRunRecord = undefined;
    holdRunRecord = "run-cancel-before-store";
    const preparingController = new AbortController();
    const preparing = link.runTurn({ conversation, participant, triggerMessage: conversation.messages[0], runId: holdRunRecord, pendingMessageId: "pending-before-store", signal: preparingController.signal });
    await waitFor(() => typeof releaseRunRecord === "function", 5_000);
    assert.ok(!hostRuns.some((run) => run.runId === "run-cancel-before-store"));
    preparingController.abort();
    releaseRunRecord();
    assert.equal((await preparing).status, "interrupted");
    assert.ok(!hostRuns.some((run) => run.runId === "run-cancel-before-store"));
    assert.ok(!(record.pendingRuns ?? []).some((run) => run.runId === "run-cancel-before-store"));
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
    await result.acknowledge();
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
    await second.acknowledge?.();
    assert.ok(machineStore.get("conv-1").messages.some((message) => message.id === "msg-2"));
    assert.equal(importedSnapshots.length, 5, "settings travel with every turn preparation, including a failed or cancelled intent write");

    // Cancel: the desktop aborts, the machine's turn signal fires, the result is interrupted.
    conversation.messages.push({ id: "msg-long", role: "user", content: "slow", createdAt: new Date().toISOString(), status: "done" });
    const controller = new AbortController();
    const pendingLong = link.runTurn({ conversation, participant, triggerMessage: conversation.messages[2], runId: "run-3", pendingMessageId: "pending-3", signal: controller.signal });
    await waitFor(() => hostRuns.length === 3 && typeof releaseLongTurn === "function", 5_000);
    controller.abort();
    const third = await pendingLong;
    assert.equal(third.status, "interrupted");
    await third.acknowledge?.();

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
    await bigResult.acknowledge?.();
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
    await waitFor(async () => (await hostEvents.eventStorage.deviceEvents().listPending(pairing.rendezvousId))
      .some(entry => entry.event.kind === "machine.turn.finished" && entry.event.payload.runId === "run-away"), 5_000);
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
    await failTurn.acknowledge?.();

    // When a machine asks for a copy again, the desktop serves its current state.
    const loadable = new Map([["conv-1", conversation]]);
    link.setConversationLoader(async (id) => loadable.get(id));

    // A regular delta that cannot be stored after the first copy makes the copy incomplete:
    // the next turn fails honestly and the copy is requested again.
    conversation.messages.push({ id: "msg-edit", role: "user", content: "edited instruction", createdAt: new Date().toISOString(), status: "done" });
    failNextApplyContaining = "msg-edit";
    const staleTurn = await link.runTurn({ conversation, participant, triggerMessage: conversation.messages[conversation.messages.length - 1], runId: "run-stale", pendingMessageId: "pending-stale" });
    assert.equal(staleTurn.status, "failed", "a turn on a copy with an unstored delta fails instead of running on stale rows");
    assert.match(staleTurn.error, /not complete/);
    await staleTurn.acknowledge?.();
    await waitFor(() => machineStore.get("conv-1")?.messages.some((message) => message.id === "msg-edit"), 10_000);
    const repairedTurn = await link.runTurn({ conversation, participant, triggerMessage: conversation.messages[conversation.messages.length - 1], runId: "run-repaired", pendingMessageId: "pending-repaired" });
    assert.equal(repairedTurn.status, "completed");
    await repairedTurn.acknowledge?.();

    // A hello that arrives while a turn is still being prepared must not close it:
    // the machine is asked only about turns whose request has left.
    settingsDelayMs = 400;
    const racedTurn = link.runTurn({ conversation, participant, triggerMessage: conversation.messages[0], runId: "run-raced", pendingMessageId: "pending-raced" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    host.client.close();
    await host.client.connect(); // the machine's hello lands during the desktop's preparation
    const raced = await racedTurn;
    settingsDelayMs = 0;
    assert.equal(raced.status, "completed", "a turn in preparation survives a hello");
    await raced.acknowledge?.();
    // A query may still be sent once the request has left (the machine simply holds the run and stays silent);
    // what must never happen is a close from an answer to a pre-dispatch query.
    assert.ok(!logs.some((entry) => entry.event === "machine-link.turn.unknown" && entry.payload?.runId === "run-raced" && entry.payload?.dispatched === true), "no lost-run close for a turn the machine holds");

    // A batch of the first copy that cannot be stored on the machine makes it ask for the copy again;
    // the completed copy never echoes back and the retry stores everything.
    const bigger = { ...big, id: "conv-bigger", messages: big.messages.map((message) => ({ ...message, id: message.id.replace("big-", "bigger-") })) };
    loadable.set("conv-bigger", bigger);
    failNextApplyContaining = "bigger-200";
    const biggerEchoes = [];
    const stopBiggerEcho = link.onConversationBackDelta((delta) => { if (delta.conversationId === "conv-bigger") biggerEchoes.push(delta); });
    const biggerResult = await link.runTurn({ conversation: bigger, participant, triggerMessage: bigger.messages[399], runId: "run-bigger", pendingMessageId: "pending-bigger" });
    assert.equal(biggerResult.status, "completed", "the retained failed event is retried before the copy boundary allows execution");
    assert.equal(messagesAtStart.get("run-bigger"), 400, "the provider cannot start against a partial copy");
    assert.equal(hostRuns.filter((run) => run.runId === "run-bigger").length, 1);
    await biggerResult.acknowledge?.();
    assert.ok(logs.some((entry) => entry.event === "machine-host.sync.batch-failed" && entry.payload?.conversationId === "conv-bigger"));
    assert.equal(machineStore.get("conv-bigger")?.messages.length, 401);
    const retried = await link.runTurn({ conversation: bigger, participant, triggerMessage: bigger.messages[399], runId: "run-bigger-2", pendingMessageId: "pending-bigger-2" });
    assert.equal(retried.status, "completed");
    await retried.acknowledge?.();
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

    // A desktop restart: the machine record remembers dispatched runs, the new desktop
    // asks about them, a result the machine still holds lands as a late result, and a
    // run the machine does not know is closed instead of staying pending forever.
    releaseLongTurn = undefined;
    const survivingTurn = link.runTurn({ conversation, participant, triggerMessage: conversation.messages[2], runId: "run-survives", pendingMessageId: "pending-survives" });
    await waitFor(() => hostRuns.some((run) => run.runId === "run-survives") && typeof releaseLongTurn === "function", 5_000);
    assert.ok((record.pendingRuns ?? []).some((run) => run.runId === "run-survives"), "the dispatched run is recorded durably");
    link.close(); // the desktop goes away mid-turn
    void survivingTurn.catch(() => undefined);
    record.pendingRuns = [...(record.pendingRuns ?? []), { runId: "run-forgotten", conversationId: "conv-1" }];
    const link2 = new MachineLinkService(desktopSettings, debugLogs, { ...desktopEvents, appVersion: "test", desktopDeviceId: DESKTOP_ID, reconnectDelayMs: 50 });
    const lateAfterRestart = [];
    link2.onLateTerminal(async (event) => { lateAfterRestart.push(event); });
    await link2.start();
    await waitFor(() => link2.status()[0]?.connected === true, 5_000);
    await waitFor(() => lateAfterRestart.some((event) => event.runId === "run-forgotten" && event.status === "failed"), 5_000);
    releaseLongTurn();
    await waitFor(() => lateAfterRestart.some((event) => event.runId === "run-survives" && event.status === "completed"), 5_000);
    await waitFor(() => !(record.pendingRuns ?? []).some((run) => run.runId === "run-survives" || run.runId === "run-forgotten"), 5_000);
    link2.close();
    await link.connectMachine(record);
    await waitFor(() => link.status()[0]?.connected === true, 5_000);

    // A machine restart closes the turns it lost instead of leaving them pending.
    releaseLongTurn = undefined;
    const lostTurn = link.runTurn({ conversation, participant, triggerMessage: conversation.messages[2], runId: "run-lost", pendingMessageId: "pending-lost" });
    await waitFor(() => typeof releaseLongTurn === "function", 5_000);
    host.close();
    const host2 = new MachineHostService(hostChat, hostStorage, hostSettings, debugLogs, {
      ...hostEvents, pairing, deviceId: MACHINE_ID, machineName: "test-box", appVersion: "test", detectProviders: async () => [], reconnectDelayMs: 50,
      // An outbox that cannot be written: results stay in memory and the desktop is told.
      outboxPath: "/dev/null/machine-outbox.json"
    });
    await host2.start();
    const lost = await lostTurn;
    assert.equal(lost.status, "failed");
    assert.match(lost.error, /does not know this run/);
    assert.ok(logs.some((entry) => entry.event === "machine-link.turn.queried" && entry.payload?.runId === "run-lost"), "the lost turn was asked about, not closed by process order");

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
    await unknown.acknowledge?.();
    await waitFor(() => (record.pendingCancels ?? []).length === 0, 5_000);
    // The failed outbox write is visible on the desktop as a machine warning.
    await waitFor(() => /outbox/.test(link.status()[0]?.warning ?? ""), 5_000);
    host2.close();

    link.close();
    host.close();
  } catch (error) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync("/tmp/link-logs.json", JSON.stringify(capturedLogs, null, 1));
    throw error;
  } finally {
    await relay.close();
  }
});

test("outgoing commands preserve order and Stop fences dispatch even when a write fails", async () => {
  const { MachineLinkService } = await import("../dist/main/main/services/machineLink.js");
  const { openMobileRelayPayload } = await import("../dist/main/main/services/mobileRelaySealing.js");
  const pairing = machinePairing("ws://unused/v1/relay");
  const record = { id: "machine-fence", name: "Fence box", pairingKey: pairing.rendezvousId, createdAt: new Date().toISOString() };
  const writes = [];
  let onWrite = async () => undefined;
  let onSave = () => undefined;
  const client = {
    on() {}, connect: async () => undefined, close() {},
    sendCiphertext: async ({ ciphertext }) => {
      const envelope = await openMobileRelayPayload(ciphertext, pairing.relaySealKeyBase64);
      writes.push(envelope.body);
      await onWrite(envelope.body);
    }
  };
  const link = new MachineLinkService({
    listMachines: async () => [record], getMachinePairing: async () => pairing,
    saveMachine: async (next) => { Object.assign(record, next); onSave(next); return [record]; },
    exportMachineSettingsSnapshot: async () => ({ version: 1, exportedAt: "", settingsJson: "{}", agentEnvironment: [] })
  }, { write: async () => undefined }, { ...desktopEvents, appVersion: "test", desktopDeviceId: "desktop-fence", createClient: () => client });
  await link.start();
  const connection = link.connections.get(record.id);
  connection.machineDeviceId = "machine-device";
  // This probe isolates the native dispatch fence after an already completed
  // copy; the real SQLite event channel is exercised by the link probe above.
  connection.eventChannel = { publish: async () => undefined, flush: async () => undefined, close() {} };
  connection.settingsSynced = true;
  try {
    let releaseWrite;
    onWrite = async () => { await new Promise((resolve) => { releaseWrite = resolve; }); };
    const first = link.send(connection, { type: "machine.settings.sync", snapshot: { version: 1, exportedAt: "", settingsJson: "x".repeat(2_000_000), agentEnvironment: [] } });
    await waitFor(() => Boolean(releaseWrite), 5_000);
    const second = link.send(connection, { type: "machine.hello.request", desktopDeviceId: "desktop-fence" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(writes.length, 1, "a later small command cannot overtake an unfinished large write");
    onWrite = async () => undefined;
    releaseWrite();
    await Promise.all([first, second]);
    assert.deepEqual(writes.map((body) => body.type), ["machine.settings.sync", "machine.hello.request"]);

    const participant = { id: "p", handle: "bot", roleConfigId: "r", kind: "codex-cli", homeMachineId: record.id };
    const triggerMessage = { id: "m", role: "user", content: "test", createdAt: new Date().toISOString() };
    const conversation = { id: "c", kind: "chat", title: "", createdAt: "", updatedAt: "", messages: [triggerMessage], metadata: { participants: [participant] }, findings: [] };
    let releaseQueue;
    onSave = (next) => {
      if (next.pendingRuns?.some((run) => run.runId === "queued") && !releaseQueue) {
        connection.outbound = new Promise((resolve) => { releaseQueue = resolve; });
      }
    };
    const queuedStop = new AbortController();
    const queued = link.runTurn({ conversation, participant, triggerMessage, runId: "queued", pendingMessageId: "pq", signal: queuedStop.signal });
    await waitFor(() => Boolean(releaseQueue), 5_000);
    queuedStop.abort();
    releaseQueue();
    assert.equal((await queued).status, "interrupted");
    assert.ok(!writes.some((body) => body.type === "machine.turn.request" && body.runId === "queued"));
    assert.ok(!record.pendingRuns.some((run) => run.runId === "queued"));

    onSave = () => undefined;
    const ambiguousStop = new AbortController();
    onWrite = async (body) => {
      if (body.type === "machine.turn.request") {
        ambiguousStop.abort();
        throw new Error("write failed after the frame may have left");
      }
    };
    const ambiguous = await link.runTurn({ conversation, participant, triggerMessage, runId: "ambiguous", pendingMessageId: "pa", signal: ambiguousStop.signal });
    assert.equal(ambiguous.status, "failed");
    await waitFor(() => writes.some((body) => body.type === "machine.turn.cancel" && body.runId === "ambiguous"), 5_000);
    assert.ok(record.pendingCancels.some((run) => run.runId === "ambiguous"), "an ambiguous dispatch retains Stop until the machine confirms");
    assert.deepEqual(writes.filter((body) => body.runId === "ambiguous").map((body) => body.type), ["machine.turn.request", "machine.turn.cancel"]);
  } finally {
    link.close();
  }
});

test("a damaged outbox that cannot be set aside is never overwritten", async () => {
  const { MachineHostService } = await import("../dist/main/main/services/machineHost.js");
  const { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = mkdtempSync(path.join(os.tmpdir(), "machine-outbox-"));
  const file = path.join(dir, "machine-outbox.json");
  writeFileSync(file, "{not json", "utf8");
  chmodSync(dir, 0o500); // the damaged file cannot be renamed or copied within its directory
  const logs = [];
  const stubClient = { on: () => () => undefined, connect: async () => undefined, close: () => undefined, sendCiphertext: async () => [] };
  try {
    const host = new MachineHostService(
      { runMachineHostedTurn: async () => ({ messages: [], warnings: [] }), cancelRun: () => true, respondToAppToolApproval: async () => undefined, applyReplicatedConversation: async () => undefined },
      { getConversation: async () => undefined },
      { importMachineSettingsSnapshot: async () => undefined },
      { write: async (event, payload) => { logs.push({ event, payload }); } },
      { ...hostEvents, pairing: machinePairing("ws://127.0.0.1:1/v1/relay"), deviceId: "device-x", appVersion: "test", outboxPath: file, createClient: () => stubClient }
    );
    assert.ok(logs.some((entry) => entry.event === "machine-host.outbox.corrupt-preserve-failed"));
    // A later write must refuse rather than destroy the damaged bytes.
    host.persistOutbox();
    assert.equal(readFileSync(file, "utf8"), "{not json");
    assert.ok(logs.some((entry) => entry.event === "machine-host.outbox.write-skipped"));
    host.close();
  } finally {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
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
    }, { write: async () => undefined }, { ...desktopEvents, appVersion: "test", desktopDeviceId: DESKTOP_ID, reconnectDelayMs: 50 });
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
    issuer: DESKTOP_ISSUER,
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

async function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  while (!await predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
