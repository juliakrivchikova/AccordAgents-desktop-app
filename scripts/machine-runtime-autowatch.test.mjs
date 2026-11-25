// The built machine runtime (dist/machine, from `npm run build:machine`) as its
// own process, reaching the User's own server over a link as slow as the
// internet, with a member that watches the chat. The User's message on the
// computer asks that member: the machine reads the message from the server
// before it takes the member's turn (it makes its settings and project
// current first, over that slow link), and its watch must not answer the same
// message meanwhile. On 2026-11-18 it did: the member ran twice.
//
// As in machine-runtime-hub.test.mjs, the runtime finds no agent CLI, so each
// turn of its member ends in an error the machine writes. What is counted is
// how many turns the machine ran for the one message.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, connect } from "node:net";
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
const { hubTurnRunId } = await import("../dist/main/shared/hubOps.js");
const BUNDLE = path.resolve(import.meta.dirname, "../dist/machine/accordagents-machine.cjs");

/** How late every byte is each way between the machine and the server. */
const LINK_DELAY_MS = Number(process.env.ACCORD_QA_LINK_DELAY_MS ?? 150);
/** How long a second wake has to show: on the User's machine it started 1 s
 *  after the message; over this link every round trip is slower. */
const SECOND_WAKE_WINDOW_MS = 8_000;

const member = { id: "44444444-4444-4444-8444-444444444444", handle: "mia", kind: "claude-code", roleConfigId: "software-engineer",
  homeMachineId: "machine-watch", autoWatch: true };

/** One way of the link, each chunk `ms` late and in order. */
function late(from, to, ms) {
  let chain = Promise.resolve();
  from.on("data", (chunk) => {
    chain = chain.then(() => new Promise((resolve) => setTimeout(() => {
      if (!to.destroyed) to.write(chunk);
      resolve();
    }, ms)));
  });
  from.on("end", () => { chain = chain.then(() => to.end()); });
  from.on("error", () => to.destroy());
}

/** The server as a machine in the cloud reaches it: every byte `ms` late each way. */
async function slowLink(hubUrl, ms) {
  const upstream = new URL(hubUrl);
  const server = createServer((client) => {
    const hub = connect(Number(upstream.port), upstream.hostname);
    late(client, hub, ms);
    late(hub, client, ms);
    client.on("close", () => hub.destroy());
    hub.on("close", () => client.destroy());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

function desktopChat(storage) {
  const settings = { async getPublicSettings() {
    return { chatRoleConfigs: [], chatParticipantConfigs: [], providers: [{ kind: "claude-code", enabled: true }, { kind: "codex-cli", enabled: true }] };
  } };
  const cliRunner = { async detectAgents() { return []; }, async contextUsageForSession() { return undefined; }, async closeConversationSessions() { return undefined; } };
  const chat = new ChatService(storage, settings, cliRunner, { async write() { return undefined; } });
  chat.modules.chatHistory.ensureHistoryFiles = async () => tmpdir();
  return chat;
}

test("a machine member that watches the chat runs once for a User's message that asks it, over a slow link to the server", {
  skip: existsSync(BUNDLE) ? false : "needs the machine bundle: npm run build:machine"
}, async (t) => {
  const world = await startHubWorld({ prefix: "accord-machine-autowatch-", devices: ["desktop"] });
  const link = await slowLink(world.hubUrl, LINK_DELAY_MS);
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
    await link.close();
    await world.close();
  });
  const tail = () => output.join("").slice(-1500);

  const { stdout } = await promisify(execFile)(process.execPath, [BUNDLE, "--device-identity", "--user-data", userData], { env, encoding: "utf8" });
  const identity = JSON.parse(stdout.trim().split("\n").pop());
  await world.setRoster([
    { device: { deviceId: identity.originId, publicKeyDerBase64: identity.publicKeyDerBase64, name: "Watch machine" }, machineId: "machine-watch", name: "Watch machine" }
  ]);
  // The machine reaches the server only over the slow link.
  const pairing = machinePairing(world.desktop, link.url, { rendezvousId: "watch-room", fingerprint: "WATCH" });
  const enrollmentPath = path.join(world.directory, "enrollment.json");
  await writeFile(enrollmentPath, JSON.stringify(pairing), "utf8");

  const desktop = world.desktop;
  const chat = desktopChat(desktop.eventStorage);
  const chatLink = new ServerChatLink({ storage: desktop.eventStorage, chat, identity: () => desktop.deviceIdentity.getOrCreateDeviceIdentity(),
    hubConfig: async () => ({ url: world.hubUrl }), machineNames: async () => [{ id: "machine-watch", name: "Watch machine" }], movesChats: true, log: () => undefined });
  const desktopHub = new HubClient({ url: world.hubUrl, identity: () => desktop.deviceIdentity.getOrCreateDeviceIdentity() });
  const record = { id: "machine-watch", name: "Watch machine", deviceId: identity.originId, devicePublicKeyDerBase64: identity.publicKeyDerBase64,
    pairingKey: pairing.rendezvousId, createdAt: new Date().toISOString() };
  const settings = {
    listMachines: async () => [record],
    saveMachine: async (next) => { Object.assign(record, next); return [record]; },
    removeMachine: async () => [],
    getMachinePairing: async (key) => (key === pairing.rendezvousId ? { ...pairing, hubUrl: world.hubUrl } : undefined),
    exportMachineSettingsSnapshot: async () => ({ version: 1, exportedAt: new Date().toISOString(), settingsJson: JSON.stringify({ machineAutoStopEnabled: false }), agentEnvironment: [] })
  };
  const machines = new MachineLinkService(settings, { write: async () => undefined }, { appVersion: "e2e", desktopDeviceId: desktop.deviceId,
    deviceIdentity: desktop.deviceIdentity, createClient: desktopRoomClient(desktop),
    publishSettings: async (machineId, sealed) => { await desktopHub.putMachineSettings({ machineId, sealed }); }, machineProjects: async () => ({}) });
  chat.setRemoteTurnPreparation({ beforeRemoteTurn: () => machines.syncSettings() });
  const at = new Date().toISOString();
  await chat.modules.store.saveConversation({ id: "conv-watch", kind: "chat", title: "Watch", createdAt: at, updatedAt: at, findings: [],
    messages: [{ id: "conv-watch-start", role: "system", content: "Chat started.", createdAt: at, status: "done" }],
    metadata: { participants: [member], participantSessions: [], running: false, warnings: [] } });
  const page = async () => {
    const pathWithQuery = "/v3/chat?conversationId=conv-watch";
    const response = await fetch(`${world.hubUrl}${pathWithQuery}`, { headers: { authorization: signHubRequest(desktop.identity, { method: "GET", pathWithQuery, body: "" }) } });
    return await response.json();
  };
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
    await machines.start();
    await machines.syncSettings();

    child = spawn(process.execPath, [BUNDLE, "--enrollment", enrollmentPath, "--user-data", userData, "--name", "Watch machine"], { stdio: ["ignore", "pipe", "pipe"], env });
    child.stdout.on("data", (chunk) => output.push(String(chunk)));
    child.stderr.on("data", (chunk) => output.push(String(chunk)));
    await waitFor(() => machines.isMachineConnected("machine-watch") && Boolean(record.lastHello), 60_000, "the runtime to join its room and greet");
    // The machine holds the chat before the User writes in it (otherwise it
    // would read the chat and the message together, with the turn).
    const machineDb = path.join(userData, "accordagents.sqlite3");
    await until(async () => (await promisify(execFile)("sqlite3", ["-readonly", machineDb, "select count(*) from conversations where id = 'conv-watch';"],
      { encoding: "utf8" }).catch(() => ({ stdout: "0" }))).stdout.trim(), (count) => count === "1", 60_000, "the machine to hold the chat");

    await chat.sendMessage({ conversationId: "conv-watch", content: "@mia hello" });
    const first = await until(page, (value) => value.turns?.some((turn) => turn.state === "finished"), 120_000, "the machine to take and end the turn");
    const user = first.messages.find((message) => message.role === "user");
    await new Promise((resolve) => setTimeout(resolve, SECOND_WAKE_WINDOW_MS));
    const settled = await until(page, (value) => !value.messages.some((message) => message.status === "pending"), 60_000, "every reply to settle");
    const replies = settled.messages.filter((message) => message.role === "participant" && message.participantId === member.id);
    const wakes = settled.messages.filter((message) => message.metadata?.autoWatchTrigger);
    t.diagnostic(`turns: ${JSON.stringify(settled.turns.map((turn) => [turn.runId, turn.state, turn.outcome]))}`);
    t.diagnostic(`member replies: ${replies.length}, watch wakes: ${wakes.length}`);
    assert.equal(wakes.length, 0, `no watch wake for the message that asked the member: ${JSON.stringify(wakes.map((wake) => wake.metadata.autoWatchTrigger))}`);
    assert.equal(replies.length, 1, "one reply from the member");
    assert.equal(replies[0].metadata?.runId, hubTurnRunId(user.id, member.id), "the reply is its own turn's");
    assert.equal(replies[0].metadata?.serverWriter, identity.originId, "written by the machine");
  } finally {
    machines.close();
    await chatLink.stop();
    await chat.settleChatSaves();
  }
  child.kill("SIGTERM");
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 30_000, "the runtime to stop");
});
