// The built machine runtime (dist/machine, from `npm run build:machine`) as its
// own process, on the User's own server running in this process, driven by
// the desktop's MachineLinkService with its HubSync: a member's turn is
// answered, its Stop is answered, and the machine keeps running while the
// desktop is away and is found again when it is back. (Replaces the
// relay-era machine-runtime-relay-e2e.)
//
// The runtime gets a temporary HOME and a PATH of system directories only, so
// it finds no agent CLI of this computer: what is proven is that the command
// reached it, ran there, and its outcome came back through the server.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { startHubWorld, machinePairing, desktopRoomClient, startDesktopSync, waitFor } from "./machine-hub-fixture.mjs";
import { chatPublisher } from "./machine-chat-publish.mjs";

const { MachineLinkService } = await import("../dist/main/main/services/machineLink.js");
const BUNDLE = path.resolve(import.meta.dirname, "../dist/machine/accordagents-machine.cjs");

test("the built machine runtime runs a turn and a Stop through the server, and stays up while the desktop is away", {
  skip: existsSync(BUNDLE) ? false : "needs the machine bundle: npm run build:machine"
}, async (t) => {
  const world = await startHubWorld({ prefix: "accord-machine-runtime-hub-", devices: ["desktop"] });
  const home = path.join(world.directory, "home");
  await mkdir(home, { recursive: true });
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, TMPDIR: world.directory, ACCORD_AGENTS_DEBUG_LOGS: "0", ACCORDAGENTS_CRASH_REPORTS: "0" };
  const userData = path.join(world.directory, "machine-user-data");
  const output = [];
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await world.close();
  });

  // Setup reads the runtime's identity before it starts it, and the desktop
  // puts the machine on its server's roster.
  const { stdout } = await promisify(execFile)(process.execPath, [BUNDLE, "--device-identity", "--user-data", userData], { env, encoding: "utf8" });
  const identity = JSON.parse(stdout.trim().split("\n").pop());
  await world.setRoster([{ device: { deviceId: identity.originId, publicKeyDerBase64: identity.publicKeyDerBase64, name: "E2E machine" }, machineId: "machine-e2e", name: "E2E machine" }]);
  const pairing = machinePairing(world.desktop, world.hubUrl, { rendezvousId: "e2e-room", fingerprint: "E2E" });
  const enrollmentPath = path.join(world.directory, "enrollment.json");
  await writeFile(enrollmentPath, JSON.stringify(pairing), "utf8");
  child = spawn(process.execPath, [BUNDLE, "--enrollment", enrollmentPath, "--user-data", userData, "--name", "E2E machine"], { stdio: ["ignore", "pipe", "pipe"], env });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  const record = { id: "machine-e2e", name: "E2E machine", deviceId: identity.originId, devicePublicKeyDerBase64: identity.publicKeyDerBase64, chatChanges: true,
    pairingKey: pairing.rendezvousId, createdAt: new Date().toISOString() };
  const settings = {
    listMachines: async () => [record],
    saveMachine: async (next) => { Object.assign(record, next); return [record]; },
    removeMachine: async () => [],
    getMachinePairing: async (key) => (key === pairing.rendezvousId ? pairing : undefined),
    exportMachineSettingsSnapshot: async () => ({ version: 1, exportedAt: new Date().toISOString(), settingsJson: JSON.stringify({ chatRoleConfigs: [] }), agentEnvironment: [] })
  };
  let chats;
  const link = new MachineLinkService(settings, { write: async () => undefined }, {
    eventStorage: world.desktop.eventStorage, eventLog: world.desktop.eventLog, appVersion: "e2e", desktopDeviceId: world.desktop.deviceId, reconnectDelayMs: 50,
    createClient: desktopRoomClient(world.desktop), chatChangeHead: (conversationId) => chats.head(conversationId)
  });
  chats = chatPublisher({ storage: world.desktop.eventStorage, log: world.desktop.eventLog, link });
  let sync = startDesktopSync(world, world.desktop, link, { records: [record], pairings: [pairing], pushOnly: true });
  try {
    await link.start();
    sync.sync.start();
    await waitFor(() => link.isMachineConnected("machine-e2e") && Boolean(record.lastHello), 60_000, "the runtime to join its room and greet");
    assert.equal(record.lastHello?.deviceId, identity.originId, "the runtime greeted with the identity setup read");

    const participant = { id: "p1", handle: "bot", kind: "codex-cli", roleConfigId: "engineer", homeMachineId: "machine-e2e" };
    const conversation = {
      id: "conv-e2e", kind: "chat", title: "E2E", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      messages: [{ id: "msg-1", role: "user", content: "hello", status: "done", createdAt: new Date().toISOString() }],
      findings: [], metadata: { participants: [participant] }
    };
    await chats.publish(conversation);

    const answered = (promise, ms) => Promise.race([promise.then((value) => ({ kind: "result", value }), (error) => ({ kind: "error", error })),
      new Promise((resolve) => setTimeout(() => resolve({ kind: "timeout" }), ms))]);
    const turn = await answered(link.runTurn({ conversation, participant, triggerMessage: conversation.messages[0], runId: "run-e2e", pendingMessageId: "pending-e2e" }), 120_000);
    assert.equal(turn.kind, "result", `the machine answered the turn: ${turn.error?.message ?? ""} ${output.join("").slice(-400)}`);
    assert.equal(turn.value.sent, undefined, `the command reached the machine: ${JSON.stringify(turn.value).slice(0, 300)}`);
    assert.ok(["completed", "failed"].includes(turn.value.status), JSON.stringify(turn.value).slice(0, 300));
    await turn.value.acknowledge?.();

    // Stop reaches the machine and is answered by it.
    const stopping = link.runTurn({ conversation, participant, triggerMessage: conversation.messages[0], runId: "run-stop", pendingMessageId: "pending-stop" });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await link.cancelMachineRun({ machineId: "machine-e2e", conversationId: conversation.id, runId: "run-stop" });
    const stopped = await answered(stopping, 60_000);
    assert.equal(stopped.kind, "result", "Stop was answered by the machine");
    await stopped.value.acknowledge?.();

    // The desktop goes away (its link and its HubSync): the machine keeps
    // running, and is found again when the desktop is back.
    link.close();
    sync.stop();
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    assert.equal(child.exitCode, null, "the machine keeps running without its desktop");
    sync = startDesktopSync(world, world.desktop, link, { records: [record], pairings: [pairing], pushOnly: true });
    await link.start();
    sync.sync.start();
    await waitFor(() => link.isMachineConnected("machine-e2e"), 60_000, "the machine found again after the desktop returned");
  } finally {
    link.close();
  }
  child.kill("SIGTERM");
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 30_000, "the runtime to stop");
});
