// The built machine runtime (dist/machine, from `npm run build:machine`) as its
// own process, a plain client of the User's own server running in this
// process. The computer is a ChatService with its ServerChatLink and its
// MachineLinkService, as src/main/main.ts composes them; the phone is a
// device on the server's roster writing through /v3/ops. Nothing else
// connects them: a member's turn on the machine is asked on the server and
// taken from there, its reply is written there by the machine, settings the
// computer publishes reach it there, a Stop of a turn it has not taken ends
// it there, and the machine answers a phone with the computer away.
//
// The runtime gets a temporary HOME and a PATH of system directories only, so
// it finds no agent CLI of this computer: its member's turn ends in an error
// the machine itself writes. What is proven is where the turn ran and how
// its outcome travelled, not a provider's answer (that is QA on a real box).
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { startHubWorld, machinePairing, desktopRoomClient, waitFor } from "./machine-hub-fixture.mjs";

const { MachineLinkService } = await import("../dist/main/main/services/machineLink.js");
const { ChatService } = await import("../dist/main/main/services/chat.js");
const { ServerChatLink } = await import("../dist/main/main/services/serverChatLink.js");
const { HubClient } = await import("../dist/main/main/services/hubClient.js");
const { signHubRequest } = await import("../dist/main/main/services/hubAuth.js");
const { createChatEventDeviceIdentity } = await import("../dist/main/main/services/chatEventLog.js");
const { hubTurnRunId } = await import("../dist/main/shared/hubOps.js");
const BUNDLE = path.resolve(import.meta.dirname, "../dist/machine/accordagents-machine.cjs");

const member = { id: "33333333-3333-4333-8333-333333333333", handle: "bot", kind: "codex-cli", roleConfigId: "software-engineer", homeMachineId: "machine-e2e" };

/** The computer's ChatService; its own members never run here. */
function desktopChat(storage) {
  const settings = { async getPublicSettings() {
    return { chatRoleConfigs: [], chatParticipantConfigs: [], providers: [{ kind: "claude-code", enabled: true }, { kind: "codex-cli", enabled: true }] };
  } };
  const cliRunner = { async detectAgents() { return []; }, async contextUsageForSession() { return undefined; }, async closeConversationSessions() { return undefined; } };
  const chat = new ChatService(storage, settings, cliRunner, { async write() { return undefined; } });
  chat.ensureHistoryFiles = async () => tmpdir();
  return chat;
}

test("the built machine runtime takes its member's turns from the server, applies the settings published for it, never starts a turn stopped before it took it, and answers the phone with the computer away", {
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
  const tail = () => output.join("").slice(-1500);

  // Setup reads the runtime's identity before it starts it; the computer puts
  // the machine (and the User's phone) on its server's roster.
  const { stdout } = await promisify(execFile)(process.execPath, [BUNDLE, "--device-identity", "--user-data", userData], { env, encoding: "utf8" });
  const identity = JSON.parse(stdout.trim().split("\n").pop());
  const phone = createChatEventDeviceIdentity(new Date().toISOString());
  await world.setRoster([
    { device: { deviceId: identity.originId, publicKeyDerBase64: identity.publicKeyDerBase64, name: "E2E machine" }, machineId: "machine-e2e", name: "E2E machine" },
    { device: { deviceId: phone.originId, publicKeyDerBase64: phone.publicKeyDerBase64, name: "Phone" }, role: "phone" }
  ]);
  const pairing = machinePairing(world.desktop, world.hubUrl, { rendezvousId: "e2e-room", fingerprint: "E2E" });
  const enrollmentPath = path.join(world.directory, "enrollment.json");
  await writeFile(enrollmentPath, JSON.stringify(pairing), "utf8");

  // The computer.
  const desktop = world.desktop;
  const chat = desktopChat(desktop.eventStorage);
  const chatLink = new ServerChatLink({ storage: desktop.eventStorage, chat, identity: () => desktop.eventLog.getOrCreateDeviceIdentity(),
    hubConfig: async () => ({ url: world.hubUrl }), machineNames: async () => [{ id: "machine-e2e", name: "E2E machine" }], movesChats: true, log: () => undefined });
  const desktopHub = new HubClient({ url: world.hubUrl, identity: () => desktop.eventLog.getOrCreateDeviceIdentity(), storage: desktop.eventStorage });
  const record = { id: "machine-e2e", name: "E2E machine", deviceId: identity.originId, devicePublicKeyDerBase64: identity.publicKeyDerBase64,
    pairingKey: pairing.rendezvousId, createdAt: new Date().toISOString() };
  // The User switched automatic stop off: the machine has it once it read its settings.
  const settings = {
    listMachines: async () => [record],
    saveMachine: async (next) => { Object.assign(record, next); return [record]; },
    removeMachine: async () => [],
    getMachinePairing: async (key) => (key === pairing.rendezvousId ? pairing : undefined),
    exportMachineSettingsSnapshot: async () => ({ version: 1, exportedAt: new Date().toISOString(), settingsJson: JSON.stringify({ machineAutoStopEnabled: false }), agentEnvironment: [] })
  };
  const linkOptions = { appVersion: "e2e", desktopDeviceId: desktop.deviceId, eventLog: desktop.eventLog, createClient: desktopRoomClient(desktop),
    publishSettings: async (machineId, sealed) => { await desktopHub.putMachineSettings({ machineId, sealed }); }, machineProjects: async () => ({}) };
  let link = new MachineLinkService(settings, { write: async () => undefined }, linkOptions);
  chat.setRemoteTurnPreparation({ beforeRemoteTurn: () => link.syncSettings() });
  const at = new Date().toISOString();
  await chat.saveConversation({ id: "conv-e2e", kind: "chat", title: "E2E", createdAt: at, updatedAt: at, findings: [],
    messages: [{ id: "conv-e2e-start", role: "system", content: "Chat started.", createdAt: at, status: "done" }],
    metadata: { participants: [member], participantSessions: [], running: false, warnings: [] } });
  const call = async (who, method, pathWithQuery, body) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const response = await fetch(`${world.hubUrl}${pathWithQuery}`, { method, headers: { authorization: signHubRequest(who, { method, pathWithQuery, body: text }),
      ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: text }) });
    return await response.json();
  };
  const page = () => call(desktop.identity, "GET", "/v3/chat?conversationId=conv-e2e");
  const until = async (read, done, ms, what) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await read();
      if (done(value)) return value;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}; last: ${JSON.stringify(value).slice(0, 1500)}\n${tail()}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  try {
    await chatLink.start();
    await until(page, (value) => Boolean(value.messages?.length), 20_000, "the chat on the server");
    await link.start();
    await link.syncSettings();

    child = spawn(process.execPath, [BUNDLE, "--enrollment", enrollmentPath, "--user-data", userData, "--name", "E2E machine"], { stdio: ["ignore", "pipe", "pipe"], env });
    child.stdout.on("data", (chunk) => output.push(String(chunk)));
    child.stderr.on("data", (chunk) => output.push(String(chunk)));
    await waitFor(() => link.isMachineConnected("machine-e2e") && Boolean(record.lastHello), 60_000, "the runtime to join its room and greet");
    assert.equal(record.lastHello.deviceId, identity.originId, "the runtime greeted with the identity setup read");
    // Settings reached it through the server: its hello carries the switch it read there.
    await waitFor(() => record.lastHello?.autoStopEnabled === false, 60_000, `the machine to apply its published settings: ${tail()}`);

    // A message on the computer to the machine's member.
    await chat.sendMessage({ conversationId: "conv-e2e", content: "@bot hello" });
    const first = await until(page, (value) => value.turns?.some((turn) => turn.state === "finished"), 120_000, "the machine to take and end the turn");
    const turn = first.turns.find((item) => item.state === "finished");
    assert.equal(turn.executorDeviceId, identity.originId, "taken by the machine (the second mark)");
    assert.equal(turn.requestedBy, desktop.deviceId, "asked by the computer");
    assert.ok(["done", "error"].includes(turn.outcome), JSON.stringify(turn));
    const reply = first.messages.find((message) => message.role === "participant" && message.participantId === member.id);
    assert.ok(reply, `the machine wrote its member's bubble: ${JSON.stringify(first.messages).slice(0, 800)}`);
    assert.equal(reply.metadata?.serverWriter, identity.originId, "written on the server by the machine");
    t.diagnostic(`the machine ended its member's turn as ${turn.outcome}: ${String(reply.content).slice(0, 200)}`);
    await until(() => desktop.eventStorage.getConversation("conv-e2e"), (local) => local.messages.some((message) => message.id === reply.id && message.status !== "pending") &&
      !local.messages.some((message) => message.metadata?.serverPlaceholder), 20_000, "the computer to show the machine's bubble in place of its own");

    // While the computer replaces the runtime it holds the machine's new
    // turns; one stopped meanwhile ends on the server and never starts.
    const release = link.holdTurns("machine-e2e", "updating the runtime");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await chat.sendMessage({ conversationId: "conv-e2e", content: "@bot second" });
    const held = await until(page, (value) => value.turns?.length === 2, 20_000, "the second turn on the server");
    const second = held.turns.find((item) => item.runId !== turn.runId);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal((await page()).turns.find((item) => item.runId === second.runId).state, "requested", "a held machine does not take it");
    assert.equal(chat.cancelRun(second.runId), true);
    await until(page, (value) => value.turns.find((item) => item.runId === second.runId)?.state === "stopped", 20_000, "the stop on the server");
    release();
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const after = await page();
    assert.equal(after.turns.find((item) => item.runId === second.runId).executorDeviceId, undefined, "the machine never took it");
    assert.equal(after.messages.filter((message) => message.role === "participant" && message.metadata?.serverWriter === identity.originId).length, 1,
      "the machine wrote nothing for the stopped turn");

    // The computer goes away: the machine keeps running and answers the phone.
    link.close();
    await chatLink.stop();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal(child.exitCode, null, "the machine keeps running without its computer");
    const sent = await call(phone, "POST", "/v3/ops", { ops: [{ opId: "op-phone-1", kind: "message.create", conversationId: "conv-e2e",
      message: { id: "phone-m1", role: "user", content: "@bot from the phone", createdAt: new Date().toISOString(), metadata: { deliveryTargets: [member.id] } } }] });
    assert.equal(sent.results?.[0]?.status, "accepted", JSON.stringify(sent));
    const phoneRun = hubTurnRunId("phone-m1", member.id);
    const answered = await until(page, (value) => value.turns.find((item) => item.runId === phoneRun)?.state === "finished", 120_000, "the machine to answer the phone");
    assert.equal(answered.turns.find((item) => item.runId === phoneRun).executorDeviceId, identity.originId, "the machine took the phone's turn");
    assert.equal(answered.turns.find((item) => item.runId === phoneRun).requestedBy, phone.originId);

    // The computer is back and finds its machine again.
    link = new MachineLinkService(settings, { write: async () => undefined }, linkOptions);
    await link.start();
    await waitFor(() => link.isMachineConnected("machine-e2e"), 60_000, "the machine found again after the computer returned");
  } finally {
    link.close();
    await chatLink.stop();
    await chat.settleChatSaves();
  }
  child.kill("SIGTERM");
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 30_000, "the runtime to stop");
});
