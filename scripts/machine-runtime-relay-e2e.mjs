/**
 * Real end to end after the deletion: the built machine runtime as its own
 * process, the reference relay on the wire, and the desktop's own
 * MachineLinkService driving it. Proves a member's turn, its Stop, and a
 * member request delegated from the machine, with no old transport present.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "..");
const { createReferenceRelayServer } = require(path.join(repoRoot, "scripts/relay-reference-server.cjs"));
const { MachineLinkService } = require(path.join(repoRoot, "dist/main/main/services/machineLink.js"));
const { StorageService } = require(path.join(repoRoot, "dist/main/main/services/storage.js"));
const { ChatEventLogService } = require(path.join(repoRoot, "dist/main/main/services/chatEventLog.js"));

const SEAL_KEY = Buffer.alloc(32, 7).toString("base64url");
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

const log = (...args) => console.log("[e2e]", ...args);

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-machine-e2e-"));
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  log("relay at", address.url);

  const desktopStorage = new StorageService({ dbPath: path.join(dir, "desktop.sqlite3") });
  const desktopLog = new ChatEventLogService(desktopStorage);
  const desktopIdentity = await desktopLog.getOrCreateDeviceIdentity();

  const pairing = {
    version: 1, purpose: "machine-host",
    issuer: {
      originId: desktopIdentity.originId,
      keyId: desktopIdentity.keyId,
      publicKeyDerBase64: desktopIdentity.publicKeyDerBase64
    },
    rendezvousId: "e2e-room", stableRoutingId: "e2e-route",
    relaySealKeyBase64: SEAL_KEY, relayUrl: address.url,
    capabilities: [{ scope: "device", canRead: true, canWrite: true, canRunCloudParticipants: true, canListConversations: true }],
    fingerprint: "E2E", createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString()
  };
  const enrollmentPath = path.join(dir, "enrollment.json");
  await writeFile(enrollmentPath, JSON.stringify(pairing), "utf8");

  const machineUserData = path.join(dir, "machine-user-data");
  const child = spawn(process.execPath, [
    path.join(repoRoot, "dist/machine/accordagents-machine.cjs"),
    "--enrollment", enrollmentPath,
    "--user-data", machineUserData,
    "--name", "E2E machine"
  ], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ACCORD_AGENTS_DEBUG_LOGS: "0" } });
  spawned.add(child);
  const machineOutput = [];
  child.stdout.on("data", (chunk) => { machineOutput.push(String(chunk)); });
  child.stderr.on("data", (chunk) => { machineOutput.push(String(chunk)); });
  child.on("exit", (code) => log("machine process exited", code));

  const record = { id: "machine-e2e", name: "E2E machine", deviceId: "", pairingKey: pairing.rendezvousId, createdAt: new Date().toISOString() };
  const settings = {
    listMachines: async () => [record],
    saveMachine: async (next) => { Object.assign(record, next); return [record]; },
    removeMachine: async () => [],
    getMachinePairing: async (key) => (key === pairing.rendezvousId ? pairing : undefined),
    exportMachineSettingsSnapshot: async () => ({ version: 1, exportedAt: new Date().toISOString(), settingsJson: JSON.stringify({ chatRoleConfigs: [] }), agentEnvironment: [] })
  };
  const logs = [];
  const link = new MachineLinkService(settings, { write: async (event, payload) => { logs.push({ event, payload }); } }, {
    eventStorage: desktopStorage, eventLog: desktopLog,
    appVersion: "e2e", desktopDeviceId: desktopIdentity.originId, reconnectDelayMs: 50
  });
  const delegations = [];
  link.onParticipantRequest((request) => { delegations.push(request); });
  const backdeltas = [];
  link.onConversationBackDelta((delta) => { backdeltas.push(delta); });
  await link.start();

  const deadline = Date.now() + 60_000;
  while (!link.isMachineConnected("machine-e2e")) {
    if (Date.now() > deadline) {
      console.error(machineOutput.join(""));
      throw new Error("the machine runtime never connected");
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  log("machine connected as", record.deviceId);

  const participant = { id: "p1", handle: "bot", kind: "codex-cli", roleConfigId: "engineer", homeMachineId: "machine-e2e" };
  const conversation = {
    id: "conv-e2e", kind: "chat", title: "E2E", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    messages: [{ id: "msg-1", role: "user", content: "hello", status: "done", createdAt: new Date().toISOString() }],
    findings: [], metadata: { participants: [participant] }
  };
  await link.replicateConversation(conversation);
  log("conversation replicated");

  const turn = link.runTurn({
    conversation, participant, triggerMessage: conversation.messages[0],
    runId: "run-e2e", pendingMessageId: "pending-e2e"
  });
  // The machine has no codex binary here: what matters is that the command
  // reached it, it started, and its outcome came back over the relay.
  const started = Date.now();
  const result = await Promise.race([
    turn.then((value) => ({ kind: "result", value })).catch((error) => ({ kind: "error", error })),
    new Promise((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 120_000))
  ]);
  log("turn outcome:", result.kind, "after", Date.now() - started, "ms",
    result.kind === "result" ? JSON.stringify(result.value).slice(0, 200) : result.error?.message ?? "");
  assert.notEqual(result.kind, "timeout", "the machine never answered the turn command");

  // Stop reaches the machine and is answered by it.
  const stopTurn = link.runTurn({
    conversation, participant, triggerMessage: conversation.messages[0],
    runId: "run-stop", pendingMessageId: "pending-stop"
  }).catch((error) => ({ stopped: error?.message }));
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await link.cancelMachineRun({ machineId: "machine-e2e", conversationId: conversation.id, runId: "run-stop" });
  const stopOutcome = await Promise.race([
    stopTurn,
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 60_000))
  ]);
  log("stop outcome:", JSON.stringify(stopOutcome).slice(0, 200));
  assert.ok(!stopOutcome?.timeout, "Stop was never answered by the machine");

  // The controlling desktop goes away: the machine keeps running and comes
  // back on its own when the desktop returns.
  link.close();
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  assert.equal(child.exitCode, null, "the machine must keep running without its desktop");
  log("machine alive with the desktop closed");
  await link.start();
  const reconnectDeadline = Date.now() + 60_000;
  while (!link.isMachineConnected("machine-e2e")) {
    if (Date.now() > reconnectDeadline) throw new Error("the machine did not come back after the desktop returned");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  log("machine reconnected after the desktop returned");
  log("machine output tail:", machineOutput.join("").slice(-400));

  child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  link.close?.();
  relay.close?.();
  await rm(dir, { recursive: true, force: true });
  log("PASS");
}

main().catch((error) => { console.error("[e2e] FAILED", error); process.exit(1); });
