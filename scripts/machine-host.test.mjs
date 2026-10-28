// The machine side of the live control between a machine and the computer
// that set it up (MachineHostService). A machine is a plain client of the
// User's server: its members' turns, replies, Stops and settings travel
// through the server (chat.machineServer.test, machine-runtime-hub.test).
// What its room still carries, and what is tested here, is live and never
// stored: the greeting, scheduled scripts, a picture read from the computer,
// background-task labels, a hold on new turns while its runtime is replaced,
// and live progress (to the computer's window, and to the server for the
// phone). The room is a stand-in client; frames are signed and sealed as the
// computer seals them.
import assert from "node:assert/strict";
import test from "node:test";
import { desktopEvents, hostEvents, DESKTOP_ID, MACHINE_ID, DESKTOP_ISSUER } from "./machine-test-events.mjs";

const { sealMachinePayload, openMachinePayload } = await import("../dist/main/main/services/machineChannelSealing.js");
const { signMachineControl } = await import("../dist/main/main/services/machineControlAuthentication.js");
const { createChatEventDeviceIdentity } = await import("../dist/main/main/services/chatEventLog.js");
const { MachineHostService } = await import("../dist/main/main/services/machineHost.js");
const { decodeMachineProgress } = await import("../dist/main/shared/machineProgress.js");

const SEAL_KEY = Buffer.from(new Uint8Array(32).map((_, index) => index + 1)).toString("base64url");
let pairings = 0;

/** An enrollment that names the User's server (the only place a machine
 *  meets its devices). Nothing connects to it: the room is the stub client. */
function pairing() {
  const now = Date.now();
  pairings += 1;
  return {
    version: 1,
    purpose: "machine-host",
    issuer: DESKTOP_ISSUER,
    rendezvousId: `rv-host-test-${now}-${pairings}`,
    stableRoutingId: "route-host-test",
    relaySealKeyBase64: SEAL_KEY,
    hubUrl: "http://127.0.0.1:1",
    capabilities: [{ scope: "device", canRead: true, canWrite: true, canRunCloudParticipants: true, canListConversations: true }],
    fingerprint: "TEST-CAP",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString()
  };
}

/** A room client stand-in: the test injects inbound frames and reads what the machine sends. */
function stubClient({ desktopPresent = true } = {}) {
  const listeners = new Map();
  const sent = [];
  return {
    sent,
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return () => undefined;
    },
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
    async connect() {
      this.emit("peer", { type: "ready", deviceId: MACHINE_ID, peerConnected: desktopPresent,
        peers: desktopPresent ? [{ role: "desktop", deviceId: DESKTOP_ID }] : [] });
    },
    close() {},
    currentState: () => "connected",
    async sendCiphertext(request) {
      sent.push(request);
      return [];
    }
  };
}

/** The machine's live control, as the machine runtime builds it. */
function makeHost(client, { chat = {}, logs, ...options } = {}) {
  return new MachineHostService(
    { respondToChoice: async () => undefined, respondToAppToolApproval: async () => undefined, ...chat },
    { write: async (event, payload) => { logs?.push({ event, payload }); } },
    {
      pairing: pairing(), deviceId: MACHINE_ID, appVersion: "test", publicKeyDerBase64: hostEvents.publicKeyDerBase64,
      identity: () => hostEvents.eventLog.getOrCreateDeviceIdentity(), createClient: () => client, storage: hostEvents.eventStorage,
      ...options
    }
  );
}

/** A frame from the computer that set the machine up, signed and sealed to the machine. */
async function controlFrame(body, enrollment, signer = desktopEvents.identity) {
  const payload = signMachineControl({ protocol: "accord-machine-link-v1", messageId: `m-${Math.random()}`,
    sentAt: new Date().toISOString(), body }, signer, enrollment.rendezvousId, MACHINE_ID);
  return sealMachinePayload(payload, signer, hostEvents.identity.publicKeyDerBase64, enrollment.rendezvousId);
}

async function deliver(host, client, body, signer) {
  client.emit("message", { ciphertext: await controlFrame(body, host.options.pairing, signer) });
  await host.inbound;
}

/** What the machine sent through the room, each frame opened as the computer opens it. */
async function controlBodies(client, enrollment) {
  const bodies = [];
  for (const request of client.sent) {
    const payload = await openMachinePayload(request.ciphertext, desktopEvents.identity, [hostEvents.identity.publicKeyDerBase64], enrollment.rendezvousId);
    bodies.push(payload.body);
  }
  return bodies;
}

function settle(ms = 150) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(predicate, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error("until timed out");
    await settle(20);
  }
}

function progress(runId, phase, state, partialContent) {
  return { runId, phase, message: "working", createdAt: new Date().toISOString(),
    agentProgress: { participantId: "p1", participantLabel: "@bot", state, partialContent } };
}

test("a picture arrives in parts and is reassembled; a refusal reaches the member; a desktop that leaves fails the read at once", async () => {
  const client = stubClient();
  const host = makeHost(client);
  await host.start();
  await settle();
  const inbound = (body) => deliver(host, client, body);
  await inbound({ type: "machine.hello.ack", desktopDeviceId: DESKTOP_ID, appVersion: "test", machineId: "test-home" });

  const answered = host.requestAttachment("conv-1", "att-1", 5000);
  await settle();
  const request = (await controlBodies(client, host.options.pairing)).find((body) => body.type === "machine.attachment.request");
  assert.ok(request, "the machine asks the desktop");
  const reply = (extra) => ({ type: "machine.attachment.result", requestId: request.requestId, conversationId: "conv-1", attachmentId: "att-1", ok: true, parts: 2, ...extra });
  // A stale answer for another request is ignored; parts may arrive out of order.
  await inbound({ ...reply({ part: 0, dataBase64: Buffer.from("XX").toString("base64") }), requestId: "stale" });
  await inbound(reply({ part: 1, dataBase64: Buffer.from("NG!").toString("base64") }));
  await inbound(reply({ part: 0, dataBase64: Buffer.from("P").toString("base64"), mediaType: "image/png", fileName: "shot.png" }));
  const bytes = await answered;
  assert.equal(Buffer.from(bytes.dataBase64, "base64").toString(), "PNG!");
  assert.equal(bytes.mediaType, "image/png"); assert.equal(bytes.fileName, "shot.png");

  const refused = host.requestAttachment("conv-1", "att-2", 5000);
  await settle();
  const second = (await controlBodies(client, host.options.pairing)).filter((body) => body.type === "machine.attachment.request").at(-1);
  await inbound({ type: "machine.attachment.result", requestId: second.requestId, conversationId: "conv-1", attachmentId: "att-2", ok: false, error: "This chat is not on this desktop." });
  await assert.rejects(refused, /not on this desktop/);

  const orphaned = host.requestAttachment("conv-1", "att-3", 60_000);
  await settle();
  client.emit("peer", { type: "peer-disconnected", peer: { role: "desktop", deviceId: DESKTOP_ISSUER.originId } });
  await assert.rejects(Promise.race([orphaned, new Promise((_, reject) => setTimeout(() => reject(new Error("still waiting")), 1000))]),
    /desktop went away/, "a read outstanding when the desktop leaves fails now, not after the bound");
  // With no desktop in the room the read fails at once.
  await assert.rejects(host.requestAttachment("conv-1", "att-4", 60_000), /not connected/);
  host.close();
});

test("the desktop's script requests are answered by the machine's scripts, off the inbound chain, and enabled scripts keep the machine awake", async () => {
  const client = stubClient();
  const handled = [];
  const names = [];
  let awake = false;
  let releaseSlow;
  const host = makeHost(client, {
    onDesktopMachineName: (name) => names.push(name),
    scripts: {
      handle: async (operation) => {
        handled.push(operation.op);
        if (operation.op === "releaseHeld") await new Promise((resolve) => { releaseSlow = resolve; });
        if (operation.op === "runNow") throw new Error("That script is switched off.");
        return [{ id: "s1", name: "Alerts" }];
      },
      keepsHostAwake: () => awake,
      scheduledCount: () => (awake ? 1 : 0)
    }
  });
  await host.start();
  await settle();
  const inbound = async (body) => {
    await deliver(host, client, body);
    await host.outbound;
  };
  await inbound({ type: "machine.hello.ack", desktopDeviceId: DESKTOP_ID, appVersion: "test", machineId: "test-home", machineName: "  Box  " });
  await inbound({ type: "machine.hello.ack", desktopDeviceId: DESKTOP_ID, appVersion: "test", machineId: "test-home", machineName: "   " });
  assert.deepEqual(names, ["Box"], "the name the desktop gave it, trimmed; a blank one is ignored");
  const instanceId = host.instanceId;
  const expiresAt = new Date(Date.now() + 20_000).toISOString();
  // A slow operation (posting held messages into a large chat) does not hold
  // up the inbound chain: the next frame is handled while it runs.
  await inbound({ type: "machine.scripts.request", requestId: "slow", instanceId, expiresAt, operation: { op: "releaseHeld", scriptId: "s1" } });
  await inbound({ type: "machine.scripts.request", requestId: "r1", instanceId, expiresAt, operation: { op: "list" } });
  await settle(50);
  assert.deepEqual(handled, ["releaseHeld", "list"], "a read does not wait behind a slow change");
  assert.ok((await controlBodies(client, host.options.pairing)).some((body) => body.type === "machine.scripts.result" && body.requestId === "r1"),
    "the list is answered while held messages are still being posted");
  releaseSlow();
  await inbound({ type: "machine.scripts.request", requestId: "r2", instanceId, expiresAt, operation: { op: "runNow", scriptId: "s1" } });
  // A frame made for an earlier run of this runtime changes nothing.
  await inbound({ type: "machine.scripts.request", requestId: "stale", instanceId: "an-earlier-run", expiresAt, operation: { op: "delete", scriptId: "s1" } });
  // And one the desktop already gave up on is not done late.
  await inbound({ type: "machine.scripts.request", requestId: "late", instanceId, expiresAt: new Date(Date.now() - 120_000).toISOString(), operation: { op: "setEnabled", scriptId: "s1", enabled: true } });
  await settle();
  let bodies = await controlBodies(client, host.options.pairing);
  const results = bodies.filter((body) => body.type === "machine.scripts.result");
  assert.deepEqual(results.map((body) => [body.requestId, body.ok]).sort(), [["late", false], ["r1", true], ["r2", false], ["slow", true], ["stale", false]]);
  const byId = Object.fromEntries(results.map((body) => [body.requestId, body]));
  assert.deepEqual(byId.r1.result, [{ id: "s1", name: "Alerts" }]);
  assert.equal(byId.r2.error, "That script is switched off.");
  assert.match(byId.stale.error, /restarted/);
  assert.match(byId.late.error, /too old; nothing was changed/);
  assert.deepEqual(handled, ["releaseHeld", "list", "runNow"], "the stale and the late requests were never handled");
  assert.equal(bodies.filter((body) => body.type === "machine.hello").pop().scriptsSupported, true);

  awake = true;
  assert.equal(await host.hasWorkForIdleStop(), true, "a switched-on script vetoes the idle stop");
  await host.publishPowerStatus();
  // Several changes at once reach the desktop as one notice.
  host.noteScriptsChanged();
  host.noteScriptsChanged();
  await settle(400);
  bodies = await controlBodies(client, host.options.pairing);
  const hello = bodies.filter((body) => body.type === "machine.hello").pop();
  assert.equal(hello.keepAwake, true);
  assert.equal(hello.keepAwakeScripts, 1);
  assert.deepEqual(hello.activeRunIds ?? [], [], "keeping awake is not a run: the update gate does not wait for it");
  assert.equal(bodies.filter((body) => body.type === "machine.scripts.changed").length, 1);
  host.close();
});

test("a runtime without scheduled scripts answers the desktop instead of leaving it waiting", async () => {
  const client = stubClient();
  const host = makeHost(client);
  await host.start();
  await settle();
  await deliver(host, client, { type: "machine.hello.ack", desktopDeviceId: DESKTOP_ID, appVersion: "test", machineId: "test-home" });
  await deliver(host, client, { type: "machine.scripts.request", requestId: "r1", instanceId: host.instanceId, expiresAt: new Date(Date.now() + 20_000).toISOString(), operation: { op: "list" } });
  await settle();
  const result = (await controlBodies(client, host.options.pairing)).find((body) => body.type === "machine.scripts.result");
  assert.equal(result.ok, false);
  assert.match(result.error, /does not host scheduled scripts/);
  assert.equal((await controlBodies(client, host.options.pairing)).find((body) => body.type === "machine.hello").scriptsSupported, undefined);
  host.close();
});

test("a phone cannot approve a machine script that runs code; the desktop can, and the phone may still decline", async () => {
  const { MachineApprovalExecutor } = await import("../dist/main/main/services/machineApprovalExecutor.js");
  const change = (op) => ({ kind: "script-change", op, scriptId: "s1", name: "Alerts", secretNames: [],
    schedule: { kind: "interval", everySeconds: 60 }, permissions: { chatIds: ["chat"], participantIds: [] } });
  const approvals = {
    install: { id: "install", toolName: "app_scripts_request_change", status: "pending", requesterParticipantId: "p1", request: change("create") },
    pause: { id: "pause", toolName: "app_scripts_request_change", status: "pending", requesterParticipantId: "p1", request: change("disable") },
    unreadable: { id: "unreadable", toolName: "app_scripts_request_change", status: "pending", requesterParticipantId: "p1", request: { kind: "script-change" } }
  };
  const answered = [];
  const published = [];
  const executor = new MachineApprovalExecutor({
    storage: {
      getChatEvent: async () => undefined,
      nativeCommands: () => ({ approvalEffect: async () => undefined, claimApproval: async () => true })
    },
    deviceId: MACHINE_ID,
    chat: {
      respondToAppToolApproval: async (request, _progress, guard) => {
        await guard.beforeApply(approvals[request.approvalId]);
        answered.push([request.approvalId, request.approve]);
        return { id: "chat" };
      }
    },
    getConversation: async () => ({ id: "chat", metadata: { pendingAppToolApprovals: Object.values(approvals) } }),
    runtimeIdentity: async () => ({ runtimeId: "rt", instanceId: "i" }),
    publish: async (body) => { published.push(body); },
    codeApprover: (event) => event.originId === DESKTOP_ID
  });
  const decide = (eventId, originId, approvalId, approve) => executor.apply(
    { eventId, originId, kind: "machine.approval.decision", conversationId: "chat" },
    { type: "machine.approval.decision", decisionId: eventId, conversationId: "chat", approvalId, approve, decidedAt: "" }
  );

  const fromPhone = await decide("e1", "phone-device", "install", true);
  assert.equal(fromPhone.ok, false);
  assert.match(fromPhone.error, /approved on the desktop/);
  assert.deepEqual(answered, [], "nothing was applied for the phone's approval");
  assert.equal((await decide("e2", "phone-device", "pause", true)).ok, true, "switching a script off is not installing code");
  assert.equal((await decide("e5", "phone-device", "unreadable", true)).ok, false, "a card it cannot read is treated as installing code");
  assert.equal((await decide("e3", "phone-device", "install", false)).ok, true, "the phone may decline");
  // A phone's answer relayed by the desktop is signed by the desktop but says it was given on the phone.
  const relayed = await executor.applyAction({ eventId: "e6", originId: DESKTOP_ID, kind: "permission.decided", conversationId: "chat" },
    { targetKey: "approval:install", detail: { approve: true, decidedOn: "phone" } });
  assert.equal(relayed.ok, false, "a relayed phone approval of code is refused too");
  assert.equal((await decide("e4", DESKTOP_ID, "install", true)).ok, true, "the desktop that shows the code may approve");
  assert.deepEqual(answered, [["pause", true], ["install", false], ["install", true]]);
  assert.equal(published.length, 6, "every decision has a published outcome; the refusal is not retried forever");
});

test("a member's background work on the machine is reported to the desktop as it changes and again with each hello", async () => {
  const client = stubClient();
  let notify;
  const live = [{ conversationId: "conv-bg", participantId: "p1", labels: ["long build"] }];
  const host = makeHost(client, { chat: {
    onBackgroundTasksChanged: (listener) => { notify = listener; return () => { notify = undefined; }; },
    localBackgroundTasks: () => live
  } });
  await host.start();
  await settle();
  const backgroundBodies = async () => (await controlBodies(client, host.options.pairing)).filter((body) => body.type === "machine.member.background");
  const snapshots = (await controlBodies(client, host.options.pairing)).filter((body) => body.type === "machine.member.background.snapshot");
  assert.deepEqual(snapshots.at(-1)?.members, [{ conversationId: "conv-bg", participantId: "p1", labels: ["long build"] }], "the hello is followed by the full list of what is running now");
  assert.equal(typeof notify, "function");
  notify({ conversationId: "conv-bg", participantId: "p1", labels: [] });
  await host.outbound;
  await settle(50);
  const bodies = await backgroundBodies();
  assert.deepEqual(bodies.at(-1), { type: "machine.member.background", conversationId: "conv-bg", participantId: "p1", labels: [] });
  // A desktop back from a network blip asks; the machine answers with the full list.
  live.length = 0;
  await deliver(host, client, { type: "machine.member.background.request" });
  await host.outbound;
  await settle(50);
  const snapshotsAfterRequest = (await controlBodies(client, host.options.pairing)).filter((body) => body.type === "machine.member.background.snapshot");
  assert.equal(snapshotsAfterRequest.length, 2);
  assert.deepEqual(snapshotsAfterRequest.at(-1).members, [], "nothing is running any more");
  host.close();
  assert.equal(notify, undefined, "closing the host stops reporting");
});

test("a machine whose enrollment names no server of the User's is not started", () => {
  const { hubUrl: _hub, ...relayEra } = { ...pairing(), relayUrl: "wss://relay.accordagents.com/v1/relay" };
  assert.throws(() => makeHost(stubClient(), { pairing: relayEra }), /does not name the User's server/);
});

test("the hello says what runs here, what has not reached the server, and the automatic-stop switch; unsent writes keep the machine awake", async () => {
  const client = stubClient();
  let unsent = { queued: 2, lastError: "The server did not answer." };
  let failRead = false;
  let running = [{ runId: "run-a", conversationId: "c1" }];
  let live = ["run-a", "run-b"];
  const host = makeHost(client, {
    chat: { activeParticipantRuns: () => running, liveRunIds: () => live },
    autoStopEnabled: () => false,
    idleStopWarning: () => "Host-wide idle state cannot be saved.",
    unsentServerWrites: async () => { if (failRead) throw new Error("unreadable"); return unsent; }
  });
  await host.start();
  await settle();
  const hello = (await controlBodies(client, host.options.pairing)).filter((body) => body.type === "machine.hello").pop();
  assert.deepEqual(hello.activeRunIds.sort(), ["run-a", "run-b"], "a member's run, and a run still writing its end, count once each");
  assert.equal(hello.unsentWarning, "2 changes from this machine have not reached your server yet: The server did not answer.");
  assert.equal(hello.autoStopEnabled, false);
  assert.equal(hello.idleStopWarning, "Host-wide idle state cannot be saved.");
  assert.equal(hello.deviceId, MACHINE_ID);
  assert.equal(hello.publicKeyDerBase64, hostEvents.publicKeyDerBase64);
  assert.ok(hello.instanceId && hello.instanceStartedAt);
  for (const retired of ["pendingTerminalRunIds", "outboxError", "chatChanges", "compactionSupported"]) {
    assert.equal(hello[retired], undefined, `${retired} is gone with the old order`);
  }

  running = []; live = [];
  assert.equal(await host.hasWorkForIdleStop(), true, "a reply the server has not taken does not sleep with the machine");
  unsent = { queued: 0 };
  assert.equal(await host.hasWorkForIdleStop(), false);
  failRead = true;
  assert.equal(await host.hasWorkForIdleStop(), true, "unknown counts as unsent");
  failRead = false;
  live = ["run-c"];
  assert.equal(await host.hasWorkForIdleStop(), true, "a run still ending is work");
  host.close();
});

test("the computer holds this machine's new turns while its runtime is replaced, at most for a bounded time, and the turns go on once released", async () => {
  const client = stubClient();
  let stopCommitted = false;
  let now = Date.now();
  const logs = [];
  const host = makeHost(client, { logs, now: () => new Date(now), hostStopCommitted: () => stopCommitted });
  let lifted = 0;
  host.onFenceLifted(() => { lifted += 1; });
  await host.start();
  await settle();
  assert.equal(host.takesNewWork(), true);
  await deliver(host, client, { type: "machine.turns.hold", reason: "updating the runtime", until: new Date(now + 60_000).toISOString() });
  assert.equal(host.takesNewWork(), false, "a turn asked now waits on the server");
  await deliver(host, client, { type: "machine.turns.release" });
  assert.equal(host.takesNewWork(), true);
  assert.equal(lifted, 1, "the turns that waited are taken at once");
  await deliver(host, client, { type: "machine.turns.release" });
  assert.equal(lifted, 1, "a release with nothing held lifts nothing");
  // A hold already over is no hold.
  await deliver(host, client, { type: "machine.turns.hold", reason: "late", until: new Date(now - 1_000).toISOString() });
  assert.equal(host.takesNewWork(), true);
  // A hold far ahead is bounded: a computer that stops renewing it never
  // keeps the machine from working.
  await deliver(host, client, { type: "machine.turns.hold", reason: "updating the runtime", until: new Date(now + 24 * 3_600_000).toISOString() });
  assert.equal(host.takesNewWork(), false);
  now += 31 * 60_000;
  assert.equal(host.takesNewWork(), true, "lapsed after at most half an hour");
  // Only the computer that set it up may hold it.
  const stranger = createChatEventDeviceIdentity(new Date().toISOString());
  client.emit("message", { ciphertext: await controlFrame({ type: "machine.turns.hold", reason: "x", until: new Date(now + 60_000).toISOString() }, host.options.pairing, stranger) });
  await host.inbound;
  assert.equal(host.takesNewWork(), true, "a frame not from the enrolling computer changes nothing");
  assert.ok(logs.some((entry) => entry.event === "machine-host.message.error"));
  // A stop another deployment on this host made final takes no new turns either.
  stopCommitted = true;
  assert.equal(host.takesNewWork(), false);
  stopCommitted = false;
  host.close();
  assert.equal(host.takesNewWork(), false, "a closed runtime takes nothing");
});

test("a kind the old order carried, sent in the room, is not a link message and does nothing", async () => {
  const client = stubClient();
  const logs = [];
  const host = makeHost(client, { logs });
  await host.start();
  await settle();
  const before = client.sent.length;
  for (const type of ["machine.turn.request", "machine.turn.cancel", "machine.settings", "machine.trust.roster", "machine.conversation.sync"]) {
    await deliver(host, client, { type, conversationId: "c", runId: "r" });
  }
  await host.outbound;
  assert.equal(client.sent.length, before, "nothing answered, nothing run");
  assert.equal(logs.filter((entry) => entry.event === "machine-host.message").length, 0, "none of them was taken as a message");
  host.close();
});

test("the desktop's new connection in the seat of its old one is greeted again", async () => {
  const client = stubClient();
  const enrollment = pairing();
  const host = makeHost(client, { pairing: enrollment });
  await host.start();
  await settle();
  const hellos = async () => (await controlBodies(client, enrollment)).filter((body) => body.type === "machine.hello").length;
  const first = await hellos();
  assert.ok(first >= 1, "greeted on its own link");
  client.emit("peer", { type: "peer-connected", peer: { role: "desktop", deviceId: DESKTOP_ID } });
  await until(async () => { await host.outbound; return await hellos() >= first + 1; });
  assert.equal(await hellos(), first + 1);
  host.close();
});

test("a hello answer taken after this machine's link dropped, or after the desktop left, does not make the desktop look present", async () => {
  const client = stubClient();
  const host = makeHost(client);
  await host.start();
  await settle();
  assert.equal(host.isDesktopConnected(), true);
  client.emit("state", "tunnel-reconnecting");
  assert.equal(host.isDesktopConnected(), false, "nothing is known of the desktop while this machine's own link is down");
  await deliver(host, client, { type: "machine.hello.ack", desktopDeviceId: DESKTOP_ID, appVersion: "test", machineId: "test-home" });
  assert.equal(host.isDesktopConnected(), false, "an answer read before the drop does not bring it back");
  client.emit("state", "connected");
  client.emit("peer", { type: "ready", deviceId: MACHINE_ID, peerConnected: false, peers: [] });
  assert.equal(host.isDesktopConnected(), false, "back, in a room without the desktop");
  client.emit("peer", { type: "peer-connected", peer: { role: "desktop", deviceId: DESKTOP_ID } });
  assert.equal(host.isDesktopConnected(), true);
  client.emit("peer", { type: "peer-disconnected", peer: { role: "desktop", deviceId: DESKTOP_ID } });
  await deliver(host, client, { type: "machine.hello.ack", desktopDeviceId: DESKTOP_ID, appVersion: "test", machineId: "test-home" });
  assert.equal(host.isDesktopConnected(), false, "an answer applied after the desktop left does not bring it back");
  await deliver(host, client, { type: "machine.hello.request" });
  assert.equal(host.isDesktopConnected(), false, "nor an old greeting request");
  await host.outbound; await settle();
  host.close();
});

test("a member's live progress goes to the computer's window in the room and to the server for the phone; nothing is kept once the run ends", async () => {
  const client = stubClient();
  const posted = [];
  let failPosts = false;
  const logs = [];
  const host = makeHost(client, { logs, chat: { conversationIdForRun: (runId) => (runId.startsWith("run-") ? "conv-live" : undefined) },
    postProgress: async (frames) => { if (failPosts) throw new Error("server away"); posted.push(...frames); } });
  await host.start();
  await settle();
  host.noteNativeProgress(progress("run-1", "initial", "running", "Hel"));
  host.noteNativeProgress(progress("run-1", "initial", "running", "Hello wor"));
  host.noteNativeProgress(progress("run-1", "done", "finished", "Hello world"));
  // A run of no chat here is not streamed.
  host.noteNativeProgress(progress("other", "initial", "running", "?"));
  await until(async () => posted.some((frame) => frame.progress.phase === "done"), 5_000);
  await host.outbound;
  const decode = (frames) => {
    let state;
    for (const frame of frames) state = decodeMachineProgress(state?.runId === frame.runId ? state : undefined, frame);
    return state;
  };
  const room = (await controlBodies(client, host.options.pairing)).filter((body) => body.type === "machine.turn.progress.delta");
  assert.ok(room.length >= 1, "the computer's window sees it live");
  assert.ok(room.every((frame) => frame.conversationId === "conv-live" && frame.runId === "run-1"));
  assert.equal(decode(room).agentProgress.partialContent, "Hello world");
  assert.equal(decode(room).phase, "done");
  assert.ok(posted.every((frame) => frame.runId === "run-1"), "the phone gets it from the server");
  assert.equal(decode(posted).agentProgress.partialContent, "Hello world");
  assert.equal(host.roomProgress.size + host.serverProgress.size, 0, "no stream is kept once the run ended");

  // The desktop is away: the phone still gets it through the server.
  client.emit("peer", { type: "peer-disconnected", peer: { role: "desktop", deviceId: DESKTOP_ID } });
  const roomBefore = client.sent.length;
  posted.length = 0;
  host.noteNativeProgress(progress("run-2", "initial", "running", "Away"));
  await until(async () => posted.length > 0, 5_000);
  assert.equal(client.sent.length, roomBefore, "nothing is sent into a room without the desktop");
  // The server refuses: that stream stops, and the next update starts whole.
  failPosts = true;
  host.noteNativeProgress(progress("run-2", "initial", "running", "Away from the desk"));
  await until(async () => logs.some((entry) => entry.event === "machine-host.progress.not-sent"), 5_000);
  failPosts = false;
  posted.length = 0;
  host.noteNativeProgress(progress("run-2", "initial", "running", "Away from the desk, still"));
  await until(async () => posted.length > 0, 5_000);
  assert.equal(posted[0].sequence, 1, "a new stream, taken whole by the reader");
  assert.equal(decodeMachineProgress(undefined, posted[0]).agentProgress.partialContent, "Away from the desk, still");
  host.close();
});

test("shutdown waits for the members running here and lets their last progress go before the room closes", async () => {
  const client = stubClient();
  let running = ["run-s"];
  let stopCalls = 0;
  const posted = [];
  const host = makeHost(client, { chat: { liveRunIds: () => running, conversationIdForRun: () => "conv-s" },
    postProgress: async (frames) => { posted.push(...frames); } });
  await host.start();
  await settle();
  host.noteNativeProgress(progress("run-s", "initial", "running", "half"));
  const done = host.shutdown(async () => { stopCalls += 1; if (stopCalls === 2) running = []; });
  assert.equal(host.takesNewWork(), false, "nothing new is taken while it stops");
  await done;
  assert.ok(stopCalls >= 2, "providers stopped until nothing ran");
  assert.ok(posted.length >= 1, "the last progress was sent");
  assert.equal(host.takesNewWork(), false);
});
