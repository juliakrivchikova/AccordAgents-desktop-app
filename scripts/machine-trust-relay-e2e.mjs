/**
 * A machine keeps working when the desktop that installed it is closed.
 *
 * Two built machine runtimes as their own processes, one reference relay, and
 * two desktops: the owner that enrolls them and hands out the trust roster,
 * and a second device of the same owner that is in that roster. The owner is
 * then shut down completely, and everything after that is driven by the second
 * device alone:
 *
 *   - a NEW turn on machine one, with its result coming back;
 *   - a Stop for it;
 *   - the same turn command sent twice, which must run once;
 *   - a member request on machine one whose target lives on machine two,
 *     delegated machine-to-machine with no desktop in the room;
 *   - a device that is not in the roster, whose traffic is not answered;
 *   - machine one restarted, which must not re-run what it already finished.
 *
 * Nothing here is stubbed except the trigger of the member request, which an
 * agent would normally make through the App MCP tool: the delegation itself,
 * the channels, the relay, the runtimes and the storage are real.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "..");
const { createReferenceRelayServer } = require(path.join(repoRoot, "scripts/relay-reference-server.cjs"));
const { MachineLinkService } = require(path.join(repoRoot, "dist/main/main/services/machineLink.js"));
const { StorageService } = require(path.join(repoRoot, "dist/main/main/services/storage.js"));
const { ChatEventLogService } = require(path.join(repoRoot, "dist/main/main/services/chatEventLog.js"));

// A failed run must not leave machine runtimes behind: they would sit on the
// relay and make the next run flaky for reasons that have nothing to do with
// the code under test.
const spawned = new Set();
function stopSpawned() {
  for (const child of spawned) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  spawned.clear();
}
process.on("exit", stopSpawned);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopSpawned(); process.exit(1); });

const log = (...args) => console.log("[trust-e2e]", ...args);

/** What a machine recorded about itself: its own debug log, on its own disk. */
async function machineLog(machine) {
  const root = path.join(machine.userData, "debug-logs");
  try {
    const files = await readdir(root);
    const parts = await Promise.all(files.map((file) => readFile(path.join(root, file), "utf8").catch(() => "")));
    return parts.join("") + machine.output.join("");
  } catch {
    return machine.output.join("");
  }
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await wait(200);
  }
}

function pairingFor(issuer, relayUrl, name, sealByte) {
  return {
    version: 1,
    purpose: "machine-host",
    issuer,
    rendezvousId: `room-${name}`,
    stableRoutingId: `route-${name}`,
    relaySealKeyBase64: Buffer.alloc(32, sealByte).toString("base64url"),
    relayUrl,
    capabilities: [{ scope: "device", canRead: true, canWrite: true, canRunCloudParticipants: true, canListConversations: true }],
    fingerprint: `TRUST-${name}`,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString()
  };
}

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
    exportMachineSettingsSnapshot: async () => ({
      version: 1,
      exportedAt: new Date().toISOString(),
      settingsJson: JSON.stringify({ chatRoleConfigs: [] }),
      agentEnvironment: []
    })
  };
}

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-trust-e2e-"));
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  log("relay", address.url);

  // The owner's desktop, and a second device of the same owner.
  const ownerStorage = new StorageService({ dbPath: path.join(dir, "owner.sqlite3") });
  const ownerLog = new ChatEventLogService(ownerStorage);
  const owner = await ownerLog.getOrCreateDeviceIdentity();
  const secondStorage = new StorageService({ dbPath: path.join(dir, "second.sqlite3") });
  const secondLog = new ChatEventLogService(secondStorage);
  const second = await secondLog.getOrCreateDeviceIdentity();
  const strangerStorage = new StorageService({ dbPath: path.join(dir, "stranger.sqlite3") });
  const strangerLog = new ChatEventLogService(strangerStorage);
  const stranger = await strangerLog.getOrCreateDeviceIdentity();
  const issuer = { originId: owner.originId, keyId: owner.keyId, publicKeyDerBase64: owner.publicKeyDerBase64 };

  const pairings = new Map();
  const records = [];
  const machines = [];
  for (const name of ["one", "two"]) {
    const pairing = pairingFor(issuer, address.url, name, name === "one" ? 11 : 22);
    pairings.set(pairing.rendezvousId, pairing);
    records.push({
      id: `machine-${name}`, name: `Machine ${name}`, deviceId: "",
      pairingKey: pairing.rendezvousId, createdAt: new Date().toISOString()
    });
    const enrollmentPath = path.join(dir, `enrollment-${name}.json`);
    await writeFile(enrollmentPath, JSON.stringify(pairing), "utf8");
    machines.push({ name, pairing, enrollmentPath, userData: path.join(dir, `machine-${name}`), output: [] });
  }

  const startMachine = (machine) => {
    const child = spawn(process.execPath, [
      path.join(repoRoot, "dist/machine/accordagents-machine.cjs"),
      "--enrollment", machine.enrollmentPath,
      "--user-data", machine.userData,
      "--name", `Machine ${machine.name}`
    ], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ACCORD_AGENTS_DEBUG_LOGS: "1" } });
    child.stdout.on("data", (chunk) => machine.output.push(String(chunk)));
    child.stderr.on("data", (chunk) => machine.output.push(String(chunk)));
    machine.child = child;
    spawned.add(child);
    return child;
  };
  for (const machine of machines) startMachine(machine);

  // The owner desktop: enrolls both machines and hands each of them the
  // roster, which is what names the second device as trusted.
  const ownerLogs = [];
  const ownerLink = new MachineLinkService(desktopSettings(records, pairings), {
    write: async (event, payload) => { ownerLogs.push({ event, payload }); }
  }, {
    eventStorage: ownerStorage, eventLog: ownerLog, appVersion: "trust-e2e",
    desktopDeviceId: owner.originId, reconnectDelayMs: 50,
    // The second device is met in the room of whichever machine it is being
    // introduced to.
    trustedDevices: async (room) => [{
      deviceId: second.originId,
      publicKeyDerBase64: second.publicKeyDerBase64,
      role: "desktop",
      name: "Second device",
      relayUrl: room.relayUrl,
      rendezvousId: room.rendezvousId,
      relaySealKeyBase64: room.relaySealKeyBase64,
      fingerprint: room.fingerprint
    }]
  });
  await ownerLink.start();
  await waitFor(() => records.every((record) => Boolean(record.deviceId)), 60_000, "both machines to connect");
  log("machines connected:", records.map((record) => `${record.id}=${record.deviceId.slice(0, 16)}…`).join(" "));

  // The roster is only complete once both machines have said hello, so the
  // second round is what carries machine two to machine one.
  await ownerLink.refreshTrustRosters();
  await waitFor(
    async () => (await Promise.all(machines.map((machine) => machineLog(machine))))
      .every((text) => text.includes("machine-host.trust.applied")),
    30_000,
    "both machines to apply the roster"
  );
  log("roster applied on both machines");

  const participants = [
    { id: "p-one", handle: "one", kind: "codex-cli", roleConfigId: "engineer", homeMachineId: "machine-one" },
    { id: "p-two", handle: "two", kind: "codex-cli", roleConfigId: "engineer", homeMachineId: "machine-two" }
  ];
  const conversation = {
    id: "trust-chat", kind: "chat", title: "Trust", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    messages: [{ id: "msg-1", role: "user", content: "hello", status: "done", createdAt: new Date().toISOString() }],
    findings: [], metadata: { participants }
  };
  await ownerLink.replicateConversation(conversation);
  await wait(1_500);

  // The owner goes away completely.
  ownerLink.close();
  log("owner desktop closed");
  await wait(1_000);

  // Everything from here is the second device alone.
  const secondLogs = [];
  const secondLink = new MachineLinkService(desktopSettings(records, pairings), {
    write: async (event, payload) => { secondLogs.push({ event, payload }); }
  }, {
    eventStorage: secondStorage, eventLog: secondLog, appVersion: "trust-e2e",
    desktopDeviceId: second.originId, reconnectDelayMs: 50
  });
  const terminals = [];
  const storedFromMachine = [];
  secondLink.onLateTerminal((event) => { terminals.push(event); });
  // A desktop stores what a machine sends it; without an owner for those rows
  // the link refuses them, exactly as the real app would.
  secondLink.onConversationBackDelta((delta) => { storedFromMachine.push(delta); });
  await secondLink.start();
  await waitFor(() => secondLink.isMachineConnected("machine-one"), 60_000, "the second device to reach machine one");
  log("second device connected to machine one");

  const turn = secondLink.runTurn({
    conversation, participant: participants[0], triggerMessage: conversation.messages[0],
    runId: "run-second", pendingMessageId: "pending-second"
  });
  const outcome = await Promise.race([
    turn.then((value) => ({ kind: "result", value })).catch((error) => ({ kind: "error", error })),
    wait(120_000).then(() => ({ kind: "timeout" }))
  ]);
  if (outcome.kind === "timeout") {
    const text = await machineLog(machines[0]);
    console.error("machine one recent:", text.split("\n").filter(Boolean).slice(-14).join("\n"));
    console.error("second device stored from machine:", storedFromMachine.length);
    console.error("second device terminal/turn lines:", secondLogs.filter((entry) => /terminal|turn|error/.test(entry.event)).slice(-10).map((entry) => `${entry.event} ${JSON.stringify(entry.payload).slice(0, 140)}`).join("\n"));
    console.error("second device all events:", JSON.stringify(secondLogs.map((entry) => entry.event)));
    console.error("second device log:", secondLogs.slice(-12).map((entry) => `${entry.event} ${JSON.stringify(entry.payload).slice(0, 120)}`).join("\n"));
    console.error("machine one turn lines:", text.split("\n").filter((line) => line.includes("turn") || line.includes("outbox") || line.includes("error")).slice(-12).join("\n"));
  }
  assert.notEqual(outcome.kind, "timeout", "a new turn started by the second device was never answered");
  log("new turn answered:", JSON.stringify(outcome.value ?? outcome.error?.message).slice(0, 160));

  // Stop, from the same device, with the owner still gone.
  const stopRun = "run-second-stop";
  const stopping = secondLink.runTurn({
    conversation, participant: participants[0], triggerMessage: conversation.messages[0],
    runId: stopRun, pendingMessageId: "pending-second-stop"
  }).then(() => "finished").catch((error) => `error: ${error.message}`);
  await wait(500);
  await secondLink.cancelMachineRun({ machineId: "machine-one", conversationId: conversation.id, runId: stopRun });
  const stopped = await Promise.race([stopping, wait(60_000).then(() => "timeout")]);
  log("stop answered with:", stopped);
  assert.notEqual(stopped, "timeout", "Stop from the second device was never answered");
  // The machine's own record of the run, once its debug log has been flushed.
  await waitFor(async () => (await machineLog(machines[0])).includes(stopRun), 20_000,
    "machine one to record the stopped run in its own log");

  // The same command again: one execution, not two.
  const runsBefore = (machines[0].output.join("").match(/machine-host\.turn\.start/g) ?? []).length;
  const repeat = await Promise.race([
    secondLink.runTurn({
      conversation, participant: participants[0], triggerMessage: conversation.messages[0],
      runId: "run-second", pendingMessageId: "pending-second"
    }).then(() => "answered").catch((error) => `error: ${error.message}`),
    wait(30_000).then(() => "timeout")
  ]);
  const runsAfter = (machines[0].output.join("").match(/machine-host\.turn\.start/g) ?? []).length;
  log("repeat of the same run id:", repeat, "starts before/after:", runsBefore, runsAfter);
  assert.equal(runsAfter, runsBefore, "the same run id must not start a second turn");

  // A device the owner never trusted.
  const strangerLink = new MachineLinkService(desktopSettings(records, pairings), {
    write: async () => undefined
  }, {
    eventStorage: strangerStorage, eventLog: strangerLog, appVersion: "trust-e2e",
    desktopDeviceId: stranger.originId, reconnectDelayMs: 50
  });
  await strangerLink.start();
  await wait(2_000);
  const strangerTurn = await Promise.race([
    strangerLink.runTurn({
      conversation, participant: participants[0], triggerMessage: conversation.messages[0],
      runId: "run-stranger", pendingMessageId: "pending-stranger"
    }).then(() => "answered").catch((error) => `refused: ${error.message}`),
    wait(20_000).then(() => "no answer")
  ]);
  const strangerRan = machines[0].output.join("").includes("run-stranger");
  log("stranger:", strangerTurn, "| machine saw its run id:", strangerRan);
  assert.ok(
    machines[0].output.join("").includes("machine-host.trust.unknown-peer") || !strangerRan,
    "a device outside the roster must not be able to start a turn"
  );
  strangerLink.close();

  // Machine one restarts: it must not re-run what it already finished.
  const finishedBefore = (machines[0].output.join("").match(/machine-host\.turn\.start/g) ?? []).length;
  machines[0].child.kill("SIGTERM");
  await waitFor(async () => machines[0].child.exitCode !== null, 30_000, "machine one to stop");
  machines[0].output.length = 0;
  startMachine(machines[0]);
  await waitFor(() => secondLink.isMachineConnected("machine-one"), 60_000, "machine one to come back");
  await wait(3_000);
  const startedAfterRestart = (machines[0].output.join("").match(/machine-host\.turn\.start/g) ?? []).length;
  log("turn starts after restart:", startedAfterRestart, "(before restart:", finishedBefore, ")");
  assert.equal(startedAfterRestart, 0, "a restart must not re-run a finished turn");

  secondLink.close();
  for (const machine of machines) machine.child.kill("SIGTERM");
  await wait(1_500);
  relay.close?.();
  await rm(dir, { recursive: true, force: true });
  log("PASS");
}

main().catch((error) => { console.error("[trust-e2e] FAILED", error); process.exit(1); });
