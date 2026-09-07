/**
 * A member on one machine asks a member on another, with no desktop running.
 *
 * Two machine runtimes over one reference relay, both told about each other by
 * the owner's desktop, which is then closed. Machine one hands the request
 * straight to machine two — the rows it needs and then the request itself —
 * and machine two runs only the members that live there.
 *
 * The trigger is called directly, where an agent would call the App MCP tool.
 * Everything after it is the real path: real channels, real relay, real
 * storage, real trust roster.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "..");
const { createReferenceRelayServer } = require(path.join(repoRoot, "scripts/relay-reference-server.cjs"));
const { MachineLinkService } = require(path.join(repoRoot, "dist/main/main/services/machineLink.js"));
const { MachineHostService } = require(path.join(repoRoot, "dist/main/main/services/machineHost.js"));
const { StorageService } = require(path.join(repoRoot, "dist/main/main/services/storage.js"));
const { ChatEventLogService } = require(path.join(repoRoot, "dist/main/main/services/chatEventLog.js"));

const log = (...args) => console.log("[delegation-e2e]", ...args);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await wait(150);
  }
}

const CONVERSATION = "delegation-chat";
const PARTICIPANTS = [
  { id: "p-one", handle: "one", kind: "codex-cli", roleConfigId: "engineer", homeMachineId: "machine-one" },
  { id: "p-two", handle: "two", kind: "codex-cli", roleConfigId: "engineer", homeMachineId: "machine-two" },
  { id: "p-desk", handle: "desk", kind: "codex-cli", roleConfigId: "engineer" }
];

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-delegation-e2e-"));
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  log("relay", address.url);

  const ownerStorage = new StorageService({ dbPath: path.join(dir, "owner.sqlite3") });
  const ownerLog = new ChatEventLogService(ownerStorage);
  const owner = await ownerLog.getOrCreateDeviceIdentity();
  const issuer = { originId: owner.originId, keyId: owner.keyId, publicKeyDerBase64: owner.publicKeyDerBase64 };

  const hosts = {};
  const pairings = new Map();
  const records = [];
  for (const [index, name] of ["one", "two"].entries()) {
    const storage = new StorageService({ dbPath: path.join(dir, `${name}.sqlite3`) });
    const eventLog = new ChatEventLogService(storage);
    const identity = await eventLog.getOrCreateDeviceIdentity();
    const pairing = {
      version: 1, purpose: "machine-host", issuer,
      rendezvousId: `room-${name}`, stableRoutingId: `route-${name}`,
      relaySealKeyBase64: Buffer.alloc(32, 40 + index).toString("base64url"),
      relayUrl: address.url,
      capabilities: [{ scope: "device", canRead: true, canWrite: true, canRunCloudParticipants: true, canListConversations: true }],
      fingerprint: `DELEG-${name}`, createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString()
    };
    pairings.set(pairing.rendezvousId, pairing);
    records.push({
      id: `machine-${name}`, name: `Machine ${name}`, deviceId: "",
      pairingKey: pairing.rendezvousId, createdAt: new Date().toISOString()
    });
    hosts[name] = { name, storage, eventLog, identity, pairing, delegations: [], logs: [] };
  }

  const conversation = {
    id: CONVERSATION, kind: "chat", title: "Delegation",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    messages: [{ id: "msg-1", role: "user", content: "start", status: "done", createdAt: new Date().toISOString() }],
    findings: [], metadata: { participants: PARTICIPANTS }
  };

  for (const name of ["one", "two"]) {
    const host = hosts[name];
    host.service = new MachineHostService(
      {
        runMachineHostedTurn: async () => ({ messages: [], warnings: [] }),
        cancelRun: () => true,
        respondToAppToolApproval: async () => undefined,
        applyReplicatedConversation: async () => undefined,
        runDelegatedParticipantRequest: async (request) => { host.delegations.push(request); }
      },
      { getConversation: async () => conversation },
      { importMachineSettingsSnapshot: async () => undefined },
      { write: async (event, payload) => { host.logs.push({ event, payload }); } },
      {
        pairing: host.pairing, deviceId: host.identity.originId, appVersion: "delegation-e2e",
        eventStorage: host.storage, eventLog: host.eventLog,
        publicKeyDerBase64: host.identity.publicKeyDerBase64,
        outboxPath: path.join(dir, `${name}-outbox.json`),
        trustRosterPath: path.join(dir, `${name}-trust.json`),
        onDesktopMachineId: () => undefined
      }
    );
    await host.service.start();
  }

  const ownerLink = new MachineLinkService({
    listMachines: async () => records,
    saveMachine: async (next) => {
      const index = records.findIndex((record) => record.id === next.id);
      if (index >= 0) Object.assign(records[index], next); else records.push(next);
      return records;
    },
    removeMachine: async () => records,
    getMachinePairing: async (key) => pairings.get(key),
    exportMachineSettingsSnapshot: async () => ({
      version: 1, exportedAt: new Date().toISOString(), settingsJson: "{}", agentEnvironment: []
    })
  }, { write: async () => undefined }, {
    eventStorage: ownerStorage, eventLog: ownerLog, appVersion: "delegation-e2e",
    desktopDeviceId: owner.originId, reconnectDelayMs: 50,
    trustedDevices: async () => []
  });
  await ownerLink.start();
  await waitFor(() => records.every((record) => Boolean(record.deviceId)), 30_000, "both machines to connect");
  // The second roster is the one that carries each machine to the other: a
  // machine's key is only known once it has said hello.
  await ownerLink.refreshTrustRosters();
  await waitFor(
    () => hosts.one.logs.some((entry) => entry.event === "machine-host.trust.peer-added" && entry.payload.role === "machine"),
    30_000,
    "machine one to learn about machine two"
  );
  log("machines know each other");

  ownerLink.close();
  await wait(1_000);
  log("owner desktop closed");

  // A member on machine one asks two members: one that lives on machine two,
  // and one that lives on the desktop.
  const requestMessage = {
    id: "request-1", role: "participant", participantId: "p-one", content: "asking",
    status: "done", createdAt: new Date().toISOString(),
    metadata: { participantRequest: { id: "batch-1", items: [] } }
  };
  await hosts.one.service.delegateParticipantRequest({
    conversationId: CONVERSATION,
    requestMessageId: requestMessage.id,
    batchId: "batch-1",
    depth: 1,
    homeMachineId: "machine-two",
    targetParticipantIds: ["p-two"],
    messages: [requestMessage]
  });

  await waitFor(() => hosts.two.delegations.length > 0, 90_000, "machine two to be asked").catch((error) => {
    console.error("machine one log:", hosts.one.logs.filter((e) => /trust|error|delegate|share/.test(e.event)).slice(-14).map((e) => `${e.event} ${JSON.stringify(e.payload).slice(0, 160)}`).join("\n"));
    console.error("machine two log:", hosts.two.logs.filter((e) => /trust|error|delegate|message/.test(e.event)).slice(-14).map((e) => `${e.event} ${JSON.stringify(e.payload).slice(0, 160)}`).join("\n"));
    throw error;
  });
  const delegated = hosts.two.delegations[0];
  log("machine two was asked:", JSON.stringify(delegated).slice(0, 200));
  assert.equal(delegated.conversationId, CONVERSATION);
  assert.equal(delegated.requestMessageId, "request-1", "the request keeps its identity across machines");
  assert.deepEqual(delegated.targetParticipantIds, ["p-two"], "only the members that live there are run");

  // Asking again is the same event, not a second run.
  await hosts.one.service.delegateParticipantRequest({
    conversationId: CONVERSATION,
    requestMessageId: requestMessage.id,
    batchId: "batch-1",
    depth: 1,
    homeMachineId: "machine-two",
    targetParticipantIds: ["p-two"],
    messages: [requestMessage]
  });
  await wait(3_000);
  assert.equal(hosts.two.delegations.length, 1, "a repeated ask must not run the members twice");
  log("repeat did not ask twice");

  // A machine that is not in the roster cannot be asked at all.
  await assert.rejects(
    () => hosts.one.service.delegateParticipantRequest({
      conversationId: CONVERSATION, requestMessageId: "request-2", batchId: "batch-2", depth: 1,
      homeMachineId: "machine-three", targetParticipantIds: ["p-three"], messages: []
    }),
    /not in this machine's trust roster/,
    "an unknown machine is refused, not guessed at"
  );
  log("unknown machine refused");

  assert.deepEqual(hosts.one.delegations, [], "machine one must not run the members it asked for");

  for (const name of ["one", "two"]) hosts[name].service.close();
  relay.close?.();
  await rm(dir, { recursive: true, force: true });
  log("PASS");
}

main().catch((error) => { console.error("[delegation-e2e] FAILED", error); process.exit(1); });
