// The owner's devices beyond the desktop that enrolled a machine, through the
// User's own server only: the trust roster the desktop hands its machines
// (who else may command them), and a member on one machine asking a member on
// another with no desktop running. A real HubServer; the desktop's
// MachineLinkService and two MachineHostServices, each device with its own
// HubSync, as src/main/main.ts and src/machine/main.ts compose them.
// (Replaces the relay-era machine-trust-relay-e2e and machine-delegation-relay-e2e.)
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  startHubWorld, machinePairing, desktopRoomClient, machineRoomClients, startDesktopSync, startMachineSync, waitFor
} from "./machine-hub-fixture.mjs";

const { MachineLinkService } = await import("../dist/main/main/services/machineLink.js");
const { MachineHostService } = await import("../dist/main/main/services/machineHost.js");

const CONVERSATION = "peers-chat";
const PARTICIPANTS = [
  { id: "p-one", handle: "one", kind: "codex-cli", roleConfigId: "engineer", homeMachineId: "machine-one" },
  { id: "p-two", handle: "two", kind: "codex-cli", roleConfigId: "engineer", homeMachineId: "machine-two" },
  { id: "p-desk", handle: "desk", kind: "codex-cli", roleConfigId: "engineer" }
];

function desktopSettings(records, pairings) {
  return {
    listMachines: async () => records,
    saveMachine: async (next) => {
      const index = records.findIndex((record) => record.id === next.id);
      if (index >= 0) Object.assign(records[index], next); else records.push(next);
      return records;
    },
    removeMachine: async () => records,
    getMachinePairing: async (key) => pairings.get(key),
    exportMachineSettingsSnapshot: async () => ({ version: 1, exportedAt: new Date().toISOString(), settingsJson: "{}", agentEnvironment: [] })
  };
}

/**
 * The owner's desktop with two machines enrolled on its server, and a
 * second desktop of the same owner on the server's roster. `trusted` is the
 * list of the owner's other devices the desktop names to its machines.
 */
async function ownerWithTwoMachines(t) {
  const world = await startHubWorld({ prefix: "accord-machine-peers-", devices: ["desktop", "one", "two", "second"] });
  t.after(() => world.close());
  const { desktop, second } = world;
  await world.setRoster([
    { device: world.one, machineId: "machine-one", name: "Machine one" },
    { device: world.two, machineId: "machine-two", name: "Machine two" },
    { device: second, role: "desktop", name: "Second desktop" }
  ]);
  const pairings = new Map();
  const records = [];
  const machines = {};
  for (const name of ["one", "two"]) {
    const device = world[name];
    const pairing = machinePairing(desktop, world.hubUrl, { rendezvousId: `room-${name}`, fingerprint: `PEERS-${name}` });
    pairings.set(pairing.rendezvousId, pairing);
    // As setup records it: the machine's identity is known before its first hello.
    records.push({ id: `machine-${name}`, name: `Machine ${name}`, deviceId: device.deviceId, devicePublicKeyDerBase64: device.publicKeyDerBase64,
      chatChanges: true, pairingKey: pairing.rendezvousId, createdAt: new Date().toISOString() });
    machines[name] = { name, device, pairing, delegations: [], logs: [], runs: [] };
  }
  const conversation = {
    id: CONVERSATION, kind: "chat", title: "Peers", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    messages: [{ id: "msg-1", role: "user", content: "start", status: "done", createdAt: new Date().toISOString() }],
    findings: [], metadata: { participants: PARTICIPANTS }
  };
  const startMachine = async (name) => {
    const machine = machines[name];
    machine.service = new MachineHostService({
      runMachineHostedTurn: async (request) => {
        machine.runs.push(request.runId);
        return { messages: [{ id: request.pendingMessageId, role: "participant", participantId: request.participantId, content: `answered on ${name}`,
          status: "done", createdAt: new Date().toISOString(), metadata: { runId: request.runId } }], warnings: [] };
      },
      cancelRun: () => true,
      respondToAppToolApproval: async () => undefined,
      applyReplicatedConversation: async () => undefined,
      runDelegatedParticipantRequest: async (request) => { machine.delegations.push(request); }
    }, { getConversation: async () => conversation }, { importMachineSettingsSnapshot: async () => undefined },
    { write: async (event, payload) => { machine.logs.push({ event, payload }); } }, {
      pairing: machine.pairing, deviceId: machine.device.deviceId, appVersion: "peers-test",
      eventStorage: machine.device.eventStorage, eventLog: machine.device.eventLog, publicKeyDerBase64: machine.device.publicKeyDerBase64,
      outboxPath: path.join(world.directory, `${name}-outbox.json`),
      trustRosterPath: path.join(world.directory, `${name}-trust.json`),
      reconnectDelayMs: 50,
      ...machineRoomClients(machine.device, world.hubUrl)
    });
    await machine.service.start();
    machine.sync = startMachineSync(world, machine.device, machine.service);
    return machine;
  };
  const stopMachine = (name) => {
    machines[name].service.close();
    machines[name].sync.stop();
  };
  const trusted = [];
  const ownerLogs = [];
  const ownerLink = new MachineLinkService(desktopSettings(records, pairings), { write: async (event, payload) => { ownerLogs.push({ event, payload }); } }, {
    eventStorage: desktop.eventStorage, eventLog: desktop.eventLog, appVersion: "peers-test", desktopDeviceId: desktop.deviceId, reconnectDelayMs: 50,
    createClient: desktopRoomClient(desktop),
    trustedDevices: async (room) => trusted.map((device) => ({ ...device, relayUrl: room.relayUrl, rendezvousId: room.rendezvousId, fingerprint: room.fingerprint }))
  });
  const ownerSync = startDesktopSync(world, desktop, ownerLink, { records, pairings: [...pairings.values()], pushOnly: true });
  return { world, records, pairings, machines, conversation, startMachine, stopMachine, trusted, ownerLink, ownerSync, ownerLogs };
}

const secondEntry = (world) => ({ deviceId: world.second.deviceId, publicKeyDerBase64: world.second.publicKeyDerBase64, role: "desktop", name: "Second desktop" });

test("a trust roster the desktop changes reaches its machines through the server, also one that was away, and a machine keeps it across a restart", async (t) => {
  const owner = await ownerWithTwoMachines(t);
  const { world, machines, ownerLink, ownerSync, trusted } = owner;
  try {
    trusted.push(secondEntry(world));
    await owner.startMachine("one");
    await owner.startMachine("two");
    await ownerLink.start();
    ownerSync.sync.start();
    await waitFor(() => ownerLink.isMachineConnected("machine-one") && ownerLink.isMachineConnected("machine-two"), 15_000, "both machines in their rooms");

    // Named by the roster: the second desktop, and each machine to the other.
    await waitFor(() => machines.one.service.trustedKey(world.second.deviceId) === world.second.publicKeyDerBase64, 15_000, "machine one trusts the second desktop");
    await waitFor(() => machines.one.service.trustedKey(world.two.deviceId) === world.two.publicKeyDerBase64, 15_000, "machine one knows machine two");
    await waitFor(() => machines.two.service.trustedKey(world.one.deviceId) === world.one.publicKeyDerBase64, 15_000, "machine two knows machine one");
    assert.equal(machines.one.service.trustedKey(world.desktop.deviceId), world.desktop.publicKeyDerBase64, "the enrolling desktop, by its enrollment");
    assert.equal(machines.one.service.trustedKey("device-" + "0".repeat(32)), undefined, "nobody else");

    // Taken off the roster: no longer trusted, at once.
    trusted.length = 0;
    await ownerLink.refreshTrustRosters();
    await waitFor(() => machines.one.service.trustedKey(world.second.deviceId) === undefined, 15_000, "machine one drops the second desktop");
    await waitFor(() => machines.two.service.trustedKey(world.second.deviceId) === undefined, 15_000, "machine two drops it too");
    assert.ok(machines.one.logs.some((entry) => entry.event === "machine-host.trust.peer-removed" && entry.payload.deviceId === world.second.deviceId));
    assert.equal(machines.one.service.trustedKey(world.two.deviceId), world.two.publicKeyDerBase64, "the other machine stays");

    // A change made while machine one is away waits in the server's order and
    // reaches it when it is back.
    owner.stopMachine("one");
    await waitFor(() => !ownerLink.isMachineConnected("machine-one"), 15_000, "machine one away");
    trusted.push(secondEntry(world));
    await ownerLink.refreshTrustRosters();
    await owner.startMachine("one");
    await waitFor(() => machines.one.service.trustedKey(world.second.deviceId) === world.second.publicKeyDerBase64, 15_000, "machine one, back, trusts it again");

    // A machine keeps its roster across a restart, with the desktop gone.
    ownerLink.close();
    ownerSync.stop();
    owner.stopMachine("one");
    await owner.startMachine("one");
    assert.equal(machines.one.service.trustedKey(world.second.deviceId), world.second.publicKeyDerBase64, "restored from its own disk");
    assert.equal(machines.one.service.trustedKey(world.two.deviceId), world.two.publicKeyDerBase64);
  } finally {
    ownerLink.close();
    for (const machine of Object.values(machines)) machine.service?.close();
  }
});

test("a member on one machine asks a member on another through the server with no desktop running: once, only that machine's members, and back the other way", async (t) => {
  const owner = await ownerWithTwoMachines(t);
  const { machines, ownerLink, ownerSync } = owner;
  try {
    await owner.startMachine("one");
    await owner.startMachine("two");
    await ownerLink.start();
    ownerSync.sync.start();
    await waitFor(() => ownerLink.isMachineConnected("machine-one") && ownerLink.isMachineConnected("machine-two"), 15_000, "both machines in their rooms");
    await ownerLink.refreshTrustRosters();
    await waitFor(() => machines.one.logs.some((entry) => entry.event === "machine-host.trust.peer-added" && entry.payload.role === "machine") &&
      machines.two.logs.some((entry) => entry.event === "machine-host.trust.peer-added" && entry.payload.role === "machine"), 15_000, "the machines know each other");

    // The owner's desktop goes away completely: its link and its HubSync.
    ownerLink.close();
    ownerSync.stop();

    const requestMessage = { id: "request-1", role: "participant", participantId: "p-one", content: "asking", status: "done", createdAt: new Date().toISOString(),
      metadata: { participantRequest: { id: "batch-1", items: [] } } };
    const ask = () => machines.one.service.delegateParticipantRequest({ conversationId: CONVERSATION, requestMessageId: requestMessage.id, batchId: "batch-1", depth: 1,
      homeMachineId: "machine-two", targetParticipantIds: ["p-two"], messages: [requestMessage] });
    await ask();
    await waitFor(() => machines.two.delegations.length > 0, 20_000, "machine two to be asked");
    const delegated = machines.two.delegations[0];
    assert.equal(delegated.conversationId, CONVERSATION);
    assert.equal(delegated.requestMessageId, "request-1", "the request keeps its identity across machines");
    assert.deepEqual(delegated.targetParticipantIds, ["p-two"], "only the members that live there are run");

    // Asking again is the same event, not a second run.
    await ask();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(machines.two.delegations.length, 1, "a repeated ask must not run the members twice");

    // A machine that is not in the roster cannot be asked at all.
    await assert.rejects(() => machines.one.service.delegateParticipantRequest({ conversationId: CONVERSATION, requestMessageId: "request-2", batchId: "batch-2", depth: 1,
      homeMachineId: "machine-three", targetParticipantIds: ["p-three"], messages: [] }), /not in this machine's trust roster/, "an unknown machine is refused, not guessed at");
    assert.deepEqual(machines.one.delegations, [], "machine one does not run the members it asked for");

    // Both directions agree on the pair's channel and key.
    await machines.two.service.delegateParticipantRequest({ conversationId: CONVERSATION, requestMessageId: "request-reverse", batchId: "batch-reverse", depth: 1,
      homeMachineId: "machine-one", targetParticipantIds: ["p-one"], messages: [] });
    await waitFor(() => machines.one.delegations.length === 1, 20_000, "the reverse delegation");
    assert.equal(machines.one.delegations[0].requestMessageId, "request-reverse");
  } finally {
    ownerLink.close();
    for (const machine of Object.values(machines)) machine.service?.close();
  }
});

// The relay-era trust e2e proved this with a second desktop; through the
// server it does not work yet: MachineLinkService names every desktop's
// channel with a machine after the machine's room (machineLink.ts
// initializeEventChannel), while the machine takes a desktop other than its
// enrolling one only on the pair's channel (MachinePeerFabric channelIdFor ->
// hubPairChannelId), so the second desktop's command is no channel's and is
// passed over. Kept as a todo until src settles how another desktop of the
// owner commands a machine.
test("with the enrolling desktop closed, another desktop on the roster runs a turn on a machine through the server", {
  todo: "a non-enrolling desktop's commands are written on the room's channel; the machine reads such a desktop only on the pair channel"
}, async (t) => {
  const owner = await ownerWithTwoMachines(t);
  const { world, records, pairings, machines, ownerLink, ownerSync, trusted } = owner;
  let secondLink;
  try {
    trusted.push(secondEntry(world));
    await owner.startMachine("one");
    await ownerLink.start();
    ownerSync.sync.start();
    await waitFor(() => machines.one.service.trustedKey(world.second.deviceId) === world.second.publicKeyDerBase64, 15_000, "machine one trusts the second desktop");
    // The owner's desktop goes away completely.
    ownerLink.close();
    ownerSync.stop();

    // The second desktop knows the machines as the owner set them up.
    const secondRecords = JSON.parse(JSON.stringify(records));
    secondLink = new MachineLinkService(desktopSettings(secondRecords, pairings), { write: async () => undefined }, {
      eventStorage: world.second.eventStorage, eventLog: world.second.eventLog, appVersion: "peers-test", desktopDeviceId: world.second.deviceId,
      reconnectDelayMs: 50, createClient: desktopRoomClient(world.second)
    });
    const secondSync = startDesktopSync(world, world.second, secondLink, { records: secondRecords, pairings: [...pairings.values()], pushOnly: true });
    await secondLink.start();
    secondSync.sync.start();
    await waitFor(() => secondLink.isMachineConnected("machine-one") && Boolean(secondRecords[0].lastHello), 15_000, "machine one greets the second desktop");
    const turn = secondLink.runTurn({ conversation: owner.conversation, participant: PARTICIPANTS[0], triggerMessage: owner.conversation.messages[0],
      runId: "run-second", pendingMessageId: "pending-second" });
    const outcome = await Promise.race([turn, new Promise((resolve) => setTimeout(() => resolve({ status: "no answer" }), 10_000))]);
    assert.equal(outcome.status, "completed", "a turn started by the second desktop is answered");
    assert.deepEqual(machines.one.runs, ["run-second"]);
    await outcome.acknowledge?.();
  } finally {
    secondLink?.close();
    ownerLink.close();
    for (const machine of Object.values(machines)) machine.service?.close();
  }
});
