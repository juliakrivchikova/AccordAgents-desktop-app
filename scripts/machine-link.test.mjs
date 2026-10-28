// The desktop side of the live control between the computer and the machines
// it set up (MachineLinkService), and the whole live path with the machine's
// side (MachineHostService) through a real server's room. A machine is a
// plain client of the User's server: its members' turns, replies and Stops
// travel through the server (chat.machineServer.test), and this link
// dispatches nothing. What it still carries, live and never stored: the
// machine's greeting and status, its scripts, a picture a member there reads
// from this desktop, background-task labels, next-prompt suggestions, live
// progress for this window, and a hold on its new turns while its runtime is
// replaced. And it publishes each machine's settings on the server, sealed
// for that machine alone.
import assert from "node:assert/strict";
import test from "node:test";
import { desktopEvents, hostEvents, DESKTOP_ID, MACHINE_ID, DESKTOP_ISSUER } from "./machine-test-events.mjs";
import { startHubWorld, machinePairing, desktopRoomClient, machineRoomClient, waitFor } from "./machine-hub-fixture.mjs";

const { MachineLinkService, machineActivityIsBusy } = await import("../dist/main/main/services/machineLink.js");
const { MachineHostService } = await import("../dist/main/main/services/machineHost.js");
const { isMachineLinkEnvelope, isMachineSettingsDocument, MACHINE_LINK_PROTOCOL, MACHINE_ATTACHMENT_PART_BYTES } = await import("../dist/main/shared/machineLink.js");
const { sealMachinePayload, openChannelPayload } = await import("../dist/main/main/services/machineChannelSealing.js");
const { deriveMachineChannelKey } = await import("../dist/main/shared/machineChannelKey.js");
const { createChatEventDeviceIdentity } = await import("../dist/main/main/services/chatEventLog.js");
const { HUB_ROOM_MAX_MESSAGE_BYTES } = await import("../dist/main/shared/hubProtocol.js");

const snapshotOf = (marker, token = "secret-token") => ({ version: 1, exportedAt: new Date().toISOString(),
  settingsJson: JSON.stringify({ marker }), agentEnvironment: [{ key: "TOKEN", value: token }] });

/** Settings → Machines as the link reads it. */
function machineSettings(records, pairings, snapshot = () => snapshotOf("first")) {
  return {
    listMachines: async () => records,
    saveMachine: async (next) => { Object.assign(records.find((record) => record.id === next.id) ?? {}, next); return records; },
    removeMachine: async () => [],
    getMachinePairing: async (key) => pairings.find((pairing) => pairing.rendezvousId === key),
    exportMachineSettingsSnapshot: async () => snapshot()
  };
}

/** A pairing whose room client is a stand-in that never dials. */
function offlinePairing(issuer = DESKTOP_ISSUER) {
  return machinePairing(issuer, "http://127.0.0.1:1");
}

function stubRoom() {
  const listeners = new Map();
  const sent = [];
  return {
    sent,
    on(event, listener) { listeners.set(event, [...(listeners.get(event) ?? []), listener]); return () => undefined; },
    emit(event, payload) { for (const listener of listeners.get(event) ?? []) listener(payload); },
    currentState: () => "connected", async connect() {}, close() {},
    async sendCiphertext(message) { sent.push(message); return []; }
  };
}

function settle(ms = 150) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("every live link message type passes the envelope validator; what the old order carried does not", () => {
  const envelope = (body) => ({ protocol: MACHINE_LINK_PROTOCOL, messageId: "m1", sentAt: new Date().toISOString(), body });
  for (const body of [
    { type: "machine.attachment.request", requestId: "r1", conversationId: "c1", attachmentId: "a1" },
    { type: "machine.attachment.result", requestId: "r1", conversationId: "c1", attachmentId: "a1", ok: true, dataBase64: "AA==" },
    { type: "machine.turns.hold", reason: "updating", until: new Date().toISOString() },
    { type: "machine.turns.release" },
    { type: "machine.member.background.request" },
    { type: "machine.scripts.changed" }
  ]) assert.equal(isMachineLinkEnvelope(envelope(body)), true, body.type);
  for (const type of ["machine.turn.request", "machine.turn.cancel", "machine.turn.result", "machine.settings", "machine.trust.roster",
    "machine.conversation.sync", "machine.approval.decision", "machine.compaction.request", "machine.not.a.message"]) {
    assert.equal(isMachineLinkEnvelope(envelope({ type })), false, `${type} is not carried in the room`);
  }
});

test("the desktop answers a picture request in bounded parts, for any chat it holds, and refuses one it does not hold", async () => {
  const picture = Buffer.alloc(MACHINE_ATTACHMENT_PART_BYTES * 2 + 12345, 7);
  const record = { id: "machine-1", name: "Box", deviceId: "", pairingKey: "rv-att", createdAt: new Date().toISOString() };
  const reads = [];
  const link = new MachineLinkService(machineSettings([record], []), { write: async () => undefined }, {
    appVersion: "test", desktopDeviceId: DESKTOP_ID, eventLog: desktopEvents.eventLog,
    readChatAttachment: async (request) => { reads.push(request); return { attachment: { mimeType: "image/png", filename: "shot.png" }, dataBase64: picture.toString("base64") }; } });
  const chats = new Map([
    ["chat-on-box", { id: "chat-on-box", kind: "chat", messages: [], metadata: { participants: [{ id: "p1", handle: "bot", homeMachineId: "machine-1" }] } }],
    ["chat-elsewhere", { id: "chat-elsewhere", kind: "chat", messages: [], metadata: { participants: [{ id: "p2", handle: "local" }] } }]
  ]);
  link.setConversationLoader(async (id) => chats.get(id));
  const sent = [];
  link.send = async (_connection, body) => { sent.push(body); };
  const connection = { record };
  const request = (conversationId) => ({ type: "machine.attachment.request", requestId: `r-${conversationId}`, conversationId, attachmentId: "a1" });

  await link.answerAttachmentRequest(connection, request("chat-on-box"));
  const parts = sent.filter((body) => body.type === "machine.attachment.result" && body.requestId === "r-chat-on-box");
  assert.equal(parts.length, 3, "a picture above one part travels in several");
  assert.ok(parts.every((body) => body.ok && body.parts === 3), "every part says how many there are");
  assert.deepEqual(parts.map((body) => body.part), [0, 1, 2]);
  assert.equal(parts[0].mediaType, "image/png"); assert.equal(parts[0].fileName, "shot.png");
  assert.ok(Buffer.concat(parts.map((body) => Buffer.from(body.dataBase64, "base64"))).equals(picture), "the parts reassemble to the picture");
  // Parts travel in the machine's room on the server, whose frames are bounded.
  const sealed = await sealMachinePayload({ protocol: MACHINE_LINK_PROTOCOL, messageId: "m", sentAt: new Date().toISOString(), body: parts[0] },
    desktopEvents.identity, hostEvents.publicKeyDerBase64, "rv-att");
  assert.ok(Buffer.byteLength(sealed) < HUB_ROOM_MAX_MESSAGE_BYTES - 64 * 1024, "a sealed part (with room for its signature) fits the server room's message limit");

  // A chat without a member there is served too (an agent searching another chat).
  await link.answerAttachmentRequest(connection, request("chat-elsewhere"));
  assert.ok(sent.some((body) => body.requestId === "r-chat-elsewhere" && body.ok));
  await link.answerAttachmentRequest(connection, request("chat-missing"));
  const refused = sent.find((body) => body.requestId === "r-chat-missing");
  assert.equal(refused.ok, false);
  assert.match(refused.error, /not on this desktop/);
  assert.deepEqual(reads.map((read) => read.conversationId), ["chat-on-box", "chat-elsewhere"], "a chat this desktop does not hold is never read");
  link.close();
});

test("through the server's room the desktop and its machine greet each other, and the desktop follows the machine's activity, live progress, background work and suggestions, serves its pictures and runs its scripts", async (t) => {
  const world = await startHubWorld({ prefix: "accord-machine-link-" });
  t.after(() => world.close());
  const { desktop, machine } = world;
  await world.setRoster([{ device: machine, machineId: "machine-1", name: "Box" }]);
  const pairing = machinePairing(desktop, world.hubUrl);
  // Setup read the machine's identity before its first hello.
  const record = { id: "machine-1", name: "Box", deviceId: machine.deviceId, devicePublicKeyDerBase64: machine.publicKeyDerBase64,
    pairingKey: pairing.rendezvousId, createdAt: new Date().toISOString() };
  const logs = [];
  const picture = Buffer.alloc(MACHINE_ATTACHMENT_PART_BYTES + 99, 3);
  const link = new MachineLinkService(machineSettings([record], [pairing]), { write: async (event, payload) => { logs.push({ event, payload }); } }, {
    appVersion: "desktop-v", desktopDeviceId: desktop.deviceId, eventLog: desktop.eventLog, createClient: desktopRoomClient(desktop),
    readChatAttachment: async () => ({ attachment: { mimeType: "image/png", filename: "p.png" }, dataBase64: picture.toString("base64") }) });
  link.setConversationLoader(async (id) => (id === "chat-1" ? { id, kind: "chat", messages: [], metadata: {} } : undefined));
  world.defer(() => link.close());

  // The machine's live control, as its runtime builds it.
  let suggest;
  let notifyBackground;
  const running = [];
  const names = [];
  const handled = [];
  const makeHost = () => new MachineHostService({
    respondToChoice: async () => undefined, respondToAppToolApproval: async () => undefined,
    activeParticipantRuns: () => running.map((runId) => ({ runId, conversationId: "chat-1" })),
    conversationIdForRun: (runId) => (running.includes(runId) ? "chat-1" : undefined),
    setPromptSuggestionForwarder: (forward) => { suggest = forward; },
    onBackgroundTasksChanged: (listener) => { notifyBackground = listener; return () => { notifyBackground = undefined; }; },
    localBackgroundTasks: () => []
  }, { write: async () => undefined }, {
    pairing, deviceId: machine.deviceId, appVersion: "machine-v", publicKeyDerBase64: machine.publicKeyDerBase64,
    identity: () => machine.eventLog.getOrCreateDeviceIdentity(), createClient: machineRoomClient(machine, world.hubUrl), storage: machine.eventStorage,
    onDesktopMachineName: (name) => names.push(name),
    scripts: { handle: async (operation) => { handled.push(operation.op); return [{ id: "s1" }]; }, keepsHostAwake: () => false, scheduledCount: () => 0 }
  });
  let host = makeHost();
  world.defer(() => host.close());
  await link.start();
  await host.start();
  await waitFor(() => link.isMachineConnected("machine-1") && record.lastHello?.appVersion === "machine-v" && host.isDesktopConnected(), 10_000, "the greeting");
  assert.equal(record.lastHello.deviceId, machine.deviceId, "the machine greeted with the identity setup read");
  assert.equal(link.presenceState("machine-1"), "connected");
  await waitFor(() => names.includes("Box"), 5_000, "the name the desktop gave it");

  // Its activity, asked afresh; two callers share one request, and the
  // hello that answers it is not announced.
  const announced = [];
  const offHello = link.onHello((event) => announced.push(event));
  const [idle, alsoIdle] = await Promise.all([link.machineActivity("machine-1"), link.machineActivity("machine-1")]);
  assert.equal(idle.fresh, true); assert.equal(alsoIdle.fresh, true);
  assert.equal(idle.appVersion, "machine-v", "the runtime's own version, not the desktop's");
  assert.equal(machineActivityIsBusy(idle), false);
  assert.equal(logs.filter((entry) => entry.event === "machine-link.activity").length, 1, "one request for both callers");
  assert.deepEqual(announced, [], "a hello the desktop asked for is not announced: a listener that asks on every hello would loop");
  offHello();
  running.push("turn-1");
  const busy = await link.machineActivity("machine-1");
  assert.deepEqual(busy.activeRunIds, ["turn-1"], "a member running now is seen without waiting for the next reconnect");
  assert.equal(machineActivityIsBusy(busy), true);
  assert.equal(link.hasActiveMachineWork(), true);

  // Its member's live progress, for this window.
  const shown = [];
  link.onProgress((progress) => shown.push(progress));
  const progress = (phase, state, partialContent) => ({ runId: "turn-1", phase, message: "working", createdAt: new Date().toISOString(),
    agentProgress: { participantId: "p1", participantLabel: "@bot", state, partialContent } });
  host.noteNativeProgress(progress("initial", "running", "Half"));
  host.noteNativeProgress(progress("initial", "running", "Half an answer"));
  host.noteNativeProgress(progress("done", "finished", "Half an answer, done"));
  await waitFor(() => shown.some((item) => item.phase === "done"), 5_000, "live progress");
  assert.equal(shown.at(-1).agentProgress.partialContent, "Half an answer, done");
  assert.ok(shown.every((item) => item.runId === "turn-1"));

  // Its members' background work, and a next-prompt suggestion.
  const background = [];
  link.onMemberBackgroundTasks((event) => background.push(event));
  notifyBackground({ conversationId: "chat-1", participantId: "p1", labels: ["long build"] });
  const suggestions = [];
  link.onPromptSuggestion((event) => suggestions.push(event));
  suggest({ conversationId: "chat-1", runId: "turn-1", participantId: "p1", text: "Run the tests next" });
  await waitFor(() => background.some((event) => event.member) && suggestions.length === 1, 5_000, "background and suggestion");
  assert.deepEqual(background.find((event) => event.member), { machineId: "machine-1", member: { conversationId: "chat-1", participantId: "p1", labels: ["long build"] } });
  assert.deepEqual(suggestions[0], { machineId: "machine-1", conversationId: "chat-1", runId: "turn-1", participantId: "p1", suggestion: "Run the tests next" });

  // A picture a member there reads from this desktop.
  const bytes = await host.requestAttachment("chat-1", "a1", 10_000);
  assert.ok(Buffer.from(bytes.dataBase64, "base64").equals(picture));
  assert.equal(bytes.mediaType, "image/png");
  await assert.rejects(host.requestAttachment("chat-elsewhere", "a1", 10_000), /not on this desktop/);

  // Its scheduled scripts.
  assert.deepEqual(link.scriptHosts(), [{ machineId: "machine-1", name: "Box", connected: true, supported: true }]);
  assert.deepEqual(await link.scriptsRequest("machine-1", { op: "list" }), [{ id: "s1" }]);
  assert.deepEqual(handled, ["list"]);

  // The desktop goes away: the machine keeps running and takes work.
  running.length = 0;
  link.close();
  await waitFor(() => !host.isDesktopConnected(), 10_000, "the machine to see the desktop leave");
  assert.equal(host.takesNewWork(), true, "the machine keeps working without its desktop");
  await assert.rejects(host.requestAttachment("chat-1", "a1", 10_000), /not connected/, "a picture is read only from a desktop that is there");
  // And finds it again when it is back.
  const again = new MachineLinkService(machineSettings([record], [pairing]), { write: async () => undefined }, {
    appVersion: "desktop-v", desktopDeviceId: desktop.deviceId, eventLog: desktop.eventLog, createClient: desktopRoomClient(desktop) });
  world.defer(() => again.close());
  await again.start();
  await waitFor(() => again.isMachineConnected("machine-1") && host.isDesktopConnected(), 10_000, "the machine found again");
});

test("while the desktop replaces a machine's runtime its new turns are held, also by the runtime that starts meanwhile, and go on once every holder let go", async (t) => {
  const world = await startHubWorld({ prefix: "accord-machine-hold-" });
  t.after(() => world.close());
  const { desktop, machine } = world;
  await world.setRoster([{ device: machine, machineId: "machine-h", name: "Hold box" }]);
  const pairing = machinePairing(desktop, world.hubUrl);
  const record = { id: "machine-h", name: "Hold box", deviceId: machine.deviceId, devicePublicKeyDerBase64: machine.publicKeyDerBase64,
    pairingKey: pairing.rendezvousId, createdAt: new Date().toISOString() };
  const link = new MachineLinkService(machineSettings([record], [pairing]), { write: async () => undefined }, {
    appVersion: "desktop-v", desktopDeviceId: desktop.deviceId, eventLog: desktop.eventLog, createClient: desktopRoomClient(desktop) });
  world.defer(() => link.close());
  let lifted = 0;
  const makeHost = () => {
    const created = new MachineHostService({ respondToChoice: async () => undefined, respondToAppToolApproval: async () => undefined },
      { write: async () => undefined }, {
        pairing, deviceId: machine.deviceId, appVersion: "machine-v", publicKeyDerBase64: machine.publicKeyDerBase64,
        identity: () => machine.eventLog.getOrCreateDeviceIdentity(), createClient: machineRoomClient(machine, world.hubUrl), storage: machine.eventStorage });
    created.onFenceLifted(() => { lifted += 1; });
    return created;
  };
  let host = makeHost();
  world.defer(() => host.close());
  await link.start();
  await host.start();
  await waitFor(() => link.isMachineConnected("machine-h") && host.isDesktopConnected(), 10_000, "the greeting");

  const release = link.holdTurns("machine-h", "updating the runtime");
  const otherRelease = link.holdTurns("machine-h", "setting the program up again");
  await waitFor(() => !host.takesNewWork(), 5_000, "the hold to reach the machine");
  assert.equal(link.turnWaitReason("machine-h"), "updating the runtime", "a waiting member's bubble says why");
  assert.equal(link.hasTurnHold("machine-h"), true);
  // The update replaces the runtime: the new one greets and is held too.
  host.close();
  host = makeHost();
  await host.start();
  await waitFor(() => !host.takesNewWork(), 10_000, "the new runtime to be held on its hello");
  release();
  release();
  await settle(400);
  assert.equal(host.takesNewWork(), false, "one holder letting go, even twice, does not release another's hold");
  otherRelease();
  await waitFor(() => host.takesNewWork(), 5_000, "the release to reach the machine");
  assert.equal(link.turnWaitReason("machine-h"), undefined);
  assert.ok(lifted >= 1, "turns that waited on the server are taken at once");
});

test("each machine's settings are published on the server sealed for that machine alone, once per change, and only by the desktop that set it up", async () => {
  const machineA = createChatEventDeviceIdentity(new Date().toISOString());
  const machineB = createChatEventDeviceIdentity(new Date().toISOString());
  const pairingA = offlinePairing();
  const pairingB = offlinePairing();
  const otherDesktop = createChatEventDeviceIdentity(new Date().toISOString());
  const pairingC = offlinePairing({ originId: otherDesktop.originId, keyId: otherDesktop.keyId, publicKeyDerBase64: otherDesktop.publicKeyDerBase64 });
  const createdAt = new Date().toISOString();
  const records = [
    { id: "a", name: "A", deviceId: machineA.originId, devicePublicKeyDerBase64: machineA.publicKeyDerBase64, pairingKey: pairingA.rendezvousId, createdAt },
    // Setup has not read B's identity yet.
    { id: "b", name: "B", deviceId: "", pairingKey: pairingB.rendezvousId, createdAt },
    // C was set up by another desktop of the User's: that one publishes its settings.
    { id: "c", name: "C", deviceId: machineB.originId, devicePublicKeyDerBase64: machineB.publicKeyDerBase64, pairingKey: pairingC.rendezvousId, createdAt }
  ];
  let snapshot = snapshotOf("first");
  const published = [];
  let failNext = false;
  const link = new MachineLinkService(machineSettings(records, [pairingA, pairingB, pairingC], () => snapshot), { write: async () => undefined }, {
    appVersion: "test", desktopDeviceId: DESKTOP_ID, eventLog: desktopEvents.eventLog,
    publishSettings: async (machineId, sealed) => {
      if (failNext) { failNext = false; throw new Error("The server did not answer."); }
      published.push({ machineId, sealed });
    },
    machineProjects: async (machineId) => (machineId === "a" ? { "/Users/me/project": "/home/a/project" } : {})
  });
  const open = (sealed, identity, rendezvousId) => openChannelPayload(sealed, deriveMachineChannelKey(identity, DESKTOP_ISSUER.publicKeyDerBase64, rendezvousId));

  await link.syncSettings();
  assert.deepEqual(published.map((item) => item.machineId), ["a"], "only a machine whose key is known, set up by this desktop");
  const document = await open(published[0].sealed, machineA, pairingA.rendezvousId);
  assert.equal(isMachineSettingsDocument(document), true);
  assert.equal(JSON.parse(document.settings.settingsJson).marker, "first");
  assert.equal(document.settings.agentEnvironment[0].value, "secret-token");
  assert.deepEqual(document.projects, { "/Users/me/project": "/home/a/project" }, "where this desktop's projects are on that machine");
  assert.ok(!published[0].sealed.includes("secret-token") && !published[0].sealed.includes("first"), "the server never reads it");
  await assert.rejects(open(published[0].sealed, machineB, pairingA.rendezvousId), "another machine cannot open it");

  await link.syncSettings();
  snapshot = { ...snapshot, exportedAt: new Date(Date.now() + 1000).toISOString() };
  await link.syncSettings();
  assert.equal(published.length, 1, "the same settings are not put again (an export time is no change)");

  snapshot = snapshotOf("second", "rotated");
  failNext = true;
  await assert.rejects(link.syncSettings(), /could not be published for A: The server did not answer/, "a failed write reaches the caller");
  await link.syncSettings();
  assert.equal(published.length, 2, "what failed is put on the next try");
  assert.equal(JSON.parse((await open(published[1].sealed, machineA, pairingA.rendezvousId)).settings.settingsJson).marker, "second");

  // Setup reads B's identity: B is given its settings.
  records[1].deviceId = machineB.originId;
  records[1].devicePublicKeyDerBase64 = machineB.publicKeyDerBase64;
  await link.syncSettings();
  assert.deepEqual(published.slice(2).map((item) => item.machineId), ["b"]);
  assert.equal(JSON.parse((await open(published[2].sealed, machineB, pairingB.rendezvousId)).settings.settingsJson).marker, "second");

  // Another server (or the link came back): everything is put again.
  link.resetPublishedSettings();
  await link.syncSettings();
  assert.deepEqual(published.slice(3).map((item) => item.machineId).sort(), ["a", "b"]);
  link.close();
});

test("the desktop dispatches nothing to a machine, and answers to a machine member's cards are not carried yet", async () => {
  const pairing = offlinePairing();
  const record = { id: "machine-x", name: "X", deviceId: MACHINE_ID, devicePublicKeyDerBase64: hostEvents.publicKeyDerBase64, pairingKey: pairing.rendezvousId,
    createdAt: new Date().toISOString() };
  const link = new MachineLinkService(machineSettings([record], [pairing]), { write: async () => undefined }, {
    appVersion: "test", desktopDeviceId: DESKTOP_ID, eventLog: desktopEvents.eventLog, createClient: () => stubRoom() });
  try {
    await link.start();
    for (const retired of ["runTurn", "cancelMachineRun", "compactParticipant", "receiveFromHub", "chatChangeRecipients", "hubReaders"]) {
      assert.equal(typeof link[retired], "undefined", `${retired} is gone: turns travel through the server`);
    }
    // Step 5 of "the server owns the chat" carries these through the server.
    await assert.rejects(link.respondToMachineApproval({ machineId: "machine-x", conversationId: "c", approvalId: "a", approve: true }), /does not carry yet/);
    await assert.rejects(link.respondToMachineChoice({ machineId: "machine-x", conversationId: "c", choiceId: "q", optionId: "o" }), /does not carry yet/);
    assert.equal(await link.machineActivity("machine-x"), undefined, "not connected: nothing to ask");
    await assert.rejects(link.scriptsRequest("machine-x", { op: "list" }), /not connected/);
    await assert.rejects(link.scriptsRequest("missing", { op: "list" }), /not set up/);
  } finally { link.close(); }
});

test("script requests go to the one machine, resolve on its answer, and refuse an older or absent machine", async () => {
  const record = { id: "machine-s", name: "Box", deviceId: "dev-s", pairingKey: "rv-s", createdAt: new Date().toISOString(),
    lastHello: { protocol: MACHINE_LINK_PROTOCOL, deviceId: "dev-s", instanceId: "run-7", scriptsSupported: true, keepAwake: true } };
  const link = new MachineLinkService(machineSettings([record], []), { write: async () => undefined }, {
    appVersion: "test", desktopDeviceId: DESKTOP_ID, eventLog: desktopEvents.eventLog });
  const sent = [];
  const connection = { record, machineDeviceId: "dev-s", pendingScripts: new Map(), client: { close() {} }, pairing: { issuer: { originId: DESKTOP_ID } } };
  link.connections.set(record.id, connection);
  link.send = async (_connection, body) => { sent.push(body); };

  const listed = link.scriptsRequest("machine-s", { op: "setSecret", scriptId: "s1", name: "SLACK_TOKEN", value: "xoxb-1" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "machine.scripts.request");
  assert.deepEqual(sent[0].operation, { op: "setSecret", scriptId: "s1", name: "SLACK_TOKEN", value: "xoxb-1" });
  assert.equal(sent[0].instanceId, "run-7", "the request names the run of the machine it was made for");
  assert.ok(Date.parse(sent[0].expiresAt) > Date.now(), "and when the desktop stops waiting for it");
  await link.handleBody(connection, { type: "machine.scripts.result", requestId: sent[0].requestId, ok: true, result: { id: "s1" } });
  assert.deepEqual(await listed, { id: "s1" });

  const refused = link.scriptsRequest("machine-s", { op: "runNow", scriptId: "s1" });
  await new Promise((resolve) => setImmediate(resolve));
  await link.handleBody(connection, { type: "machine.scripts.result", requestId: sent[1].requestId, ok: false, error: "That script is switched off." });
  await assert.rejects(refused, /switched off/);

  const changed = [];
  link.onScriptsChanged((machineId) => changed.push(machineId));
  await link.handleBody(connection, { type: "machine.scripts.changed" });
  assert.deepEqual(changed, ["machine-s"]);

  assert.equal(link.machineKeepsAwake(), true, "switched-on scripts keep the box from the AWS idle stop");
  assert.equal(link.hasActiveMachineWork(), false, "but they are not a run");

  const waiting = link.scriptsRequest("machine-s", { op: "list" });
  await new Promise((resolve) => setImmediate(resolve));
  link.rejectPendingScripts(connection, "The machine went away.");
  await assert.rejects(waiting, /went away/);

  connection.machineDeviceId = undefined;
  await assert.rejects(link.scriptsRequest("machine-s", { op: "list" }), /not connected/);
  assert.equal(link.machineKeepsAwake(), false, "a machine that is away is not counted");
  record.awsInstanceId = "i-box";
  assert.equal(link.machineKeepsAwake("i-box"), true, "for its own AWS instance, what it last said counts even while the link is down");
  assert.equal(link.machineKeepsAwake("i-other"), false, "another instance is not kept on by this machine's scripts");
  delete record.awsInstanceId;
  connection.machineDeviceId = "dev-s";
  record.lastHello = { ...record.lastHello, scriptsSupported: undefined };
  await assert.rejects(link.scriptsRequest("machine-s", { op: "list" }), /older runtime/);
  // A machine set up by another desktop takes no script requests from this one.
  record.lastHello = { ...record.lastHello, scriptsSupported: true };
  connection.pairing = { issuer: { originId: "device-another-desktop" } };
  await assert.rejects(link.scriptsRequest("machine-s", { op: "list" }), /managed from the desktop that set it up/);
  assert.deepEqual(link.scriptHosts(), [], "and Settings does not list it as one of this desktop's script hosts");
  link.close();
});

test("another machine meeting this one in its room does not make it look present or absent", async () => {
  const pairing = offlinePairing();
  const record = { id: "machine-presence", name: "Presence", deviceId: MACHINE_ID, pairingKey: pairing.rendezvousId, createdAt: new Date().toISOString() };
  const client = stubRoom();
  const link = new MachineLinkService(machineSettings([record], [pairing]), { write: async () => undefined }, {
    appVersion: "test", desktopDeviceId: DESKTOP_ID, eventLog: desktopEvents.eventLog, createClient: () => client });
  try {
    await link.start();
    const other = "device-" + "f".repeat(32);
    client.emit("peer", { type: "ready", deviceId: DESKTOP_ID, peerConnected: true, peers: [{ role: "machine", deviceId: other }] });
    assert.equal(link.isMachineConnected(record.id), false, "another machine is not this one");
    client.emit("peer", { type: "peer-connected", peer: { role: "machine", deviceId: MACHINE_ID } });
    assert.equal(link.isMachineConnected(record.id), true);
    client.emit("peer", { type: "peer-disconnected", peer: { role: "machine", deviceId: other } });
    assert.equal(link.isMachineConnected(record.id), true, "the other one leaving does not take this one away");
    client.emit("peer", { type: "peer-disconnected", peer: { role: "machine", deviceId: MACHINE_ID } });
    assert.equal(link.isMachineConnected(record.id), false);
  } finally { link.close(); }
});

test("when a machine goes away the desktop stops showing the background work it reported, and asks again when it is back", async () => {
  const link = Object.create(MachineLinkService.prototype);
  link.backgroundListeners = [];
  link.debugLogs = { write: async () => undefined };
  link.emitStatus = () => undefined;
  const events = [];
  MachineLinkService.prototype.onMemberBackgroundTasks.call(link, (event) => events.push(event));
  const connection = { record: { id: "machine-a", name: "A" }, machineDeviceId: "device-a", helloSeen: true, pendingScripts: new Map(), progress: new Map() };
  link.setMachinePeer(connection, undefined);
  assert.deepEqual(events, [{ machineId: "machine-a", snapshot: [] }]);
  link.setMachinePeer(connection, undefined);
  assert.equal(events.length, 1, "an already absent machine is not cleared twice");
  assert.equal(connection.helloSeen, false, "gone, what greeted it before counts for nothing");
  const sent = [];
  link.send = async (_connection, body) => { sent.push(body.type); };
  link.options = { desktopDeviceId: "desktop" };
  link.setMachinePeer(connection, "device-a");
  assert.ok(sent.includes("machine.member.background.request"), "back on the link, the desktop asks what is running now");
  // And, with no hello of its own, for a hello.
  for (let i = 0; i < 40 && !sent.includes("machine.hello.request"); i += 1) await settle(50);
  assert.ok(sent.includes("machine.hello.request"));
  clearTimeout(connection.helloRequestTimer);
});

test("every enrolled machine is met in its room on the server; one not set up with the server gets no room", async () => {
  const { hubUrl: _hub, ...withoutServer } = offlinePairing();
  const pairings = [offlinePairing(), offlinePairing(), withoutServer];
  const records = pairings.slice(0, 2).map((pairing, index) => ({ id: `machine-${index}`, name: `M${index}`, deviceId: "", pairingKey: pairing.rendezvousId,
    createdAt: new Date().toISOString() }));
  const noServer = { id: "machine-no-server", name: "No server", deviceId: "", pairingKey: withoutServer.rendezvousId, createdAt: new Date().toISOString() };
  const clients = [];
  const link = new MachineLinkService(machineSettings(records, pairings), { write: async () => undefined }, {
    appVersion: "test", desktopDeviceId: DESKTOP_ID, eventLog: desktopEvents.eventLog,
    createClient: (pairing) => { if (!pairing.hubUrl) return undefined; const client = stubRoom(); clients.push(client); return client; } });
  try {
    await link.start();
    assert.equal(clients.length, 2, "each machine is met in its room on the server");
    await assert.rejects(link.connectMachine(noServer), /not set up with your server/, "an enrollment that does not name the server has no room connection");
    assert.equal(clients.length, 2);
    assert.deepEqual(link.status().map((status) => [status.machineId, status.connected]), [["machine-0", false], ["machine-1", false]]);
  } finally { link.close(); }
});

test("a machine whose new connection takes the seat of its old one is asked for a hello, and stays present", async () => {
  const pairing = offlinePairing();
  const record = { id: "machine-seat", name: "Seat", deviceId: MACHINE_ID, pairingKey: pairing.rendezvousId,
    createdAt: new Date().toISOString(), lastHello: { publicKeyDerBase64: hostEvents.publicKeyDerBase64 } };
  const client = stubRoom();
  const link = new MachineLinkService(machineSettings([record], [pairing]), { write: async () => undefined }, {
    appVersion: "test", desktopDeviceId: DESKTOP_ID, eventLog: desktopEvents.eventLog, createClient: () => client });
  try {
    await link.start();
    const connection = link.connections.get(record.id);
    const types = [];
    link.send = async (_connection, body) => { types.push(body.type); };
    client.emit("peer", { type: "ready", deviceId: DESKTOP_ID, peerConnected: true, peers: [{ role: "machine", deviceId: MACHINE_ID }] });
    connection.helloSeen = true; // it greeted this connection (handleHello sets this)
    await settle(900);
    types.length = 0;
    // The machine restarted; the server seated its new connection and says so.
    client.emit("peer", { type: "peer-connected", peer: { role: "machine", deviceId: MACHINE_ID } });
    assert.equal(link.isMachineConnected(record.id), true, "it never reads as gone");
    await waitFor(() => types.includes("machine.hello.request"), 3_000);
    assert.deepEqual(types, ["machine.member.background.request", "machine.hello.request"],
      "it is asked what runs now and, with no hello of its own, for a hello");
  } finally { link.close(); }
});
