import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { desktopEvents, hostEvents, DESKTOP_ID, MACHINE_ID, DESKTOP_ISSUER } from "./machine-test-events.mjs";

const require = createRequire(import.meta.url);
const SEAL_KEY = Buffer.from(new Uint8Array(32).map((_, index) => index + 1)).toString("base64url");

function pairing() {
  const now = Date.now();
  return {
    version: 1,
    purpose: "machine-host",
    issuer: DESKTOP_ISSUER,
    rendezvousId: "rv-host-test-" + now,
    stableRoutingId: "route-host-test",
    relaySealKeyBase64: SEAL_KEY,
    relayUrl: "ws://127.0.0.1:1/v1/relay",
    capabilities: [{ scope: "device", canRead: true, canWrite: true, canRunCloudParticipants: true, canListConversations: true }],
    fingerprint: "TEST-CAP",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString()
  };
}

/** A relay client stand-in: the test injects inbound messages and reads what the machine sends. */
function stubClient() {
  const listeners = new Map();
  const sent = [];
  return {
    sent,
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return () => undefined;
    },
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) {
        listener(payload);
      }
    },
    async connect() {
      this.emit("peer", { type: "ready", deviceId: MACHINE_ID, peerConnected: true, peers: [{ role: "desktop", deviceId: DESKTOP_ID }] });
    },
    close() {},
    async sendCiphertext(request) {
      sent.push(request);
      return [];
    }
  };
}

async function envelope(body, enrollment) {
  const { sealMachineRelayPayload } = await import("../dist/main/main/services/machineRelaySealing.js");
  const { isMachineDurableMessage } = await import("../dist/main/shared/machineLink.js");
  const { signMachineControl } = await import("../dist/main/main/services/machineControlAuthentication.js");
  let payload;
  if (isMachineDurableMessage(body)) {
    const conversationId = body.type === "machine.conversation.sync" ? body.conversation.id : body.conversationId;
    const { event } = await desktopEvents.eventLog.appendLocalEvent({ conversationId,
      logScopeId: `device:${enrollment.rendezvousId}:${JSON.stringify([conversationId, "actions"])}`, kind: body.type, payload: body,
      ...(body.type === "machine.turn.request" ? { eventId: `machine-command:${body.runId}` } : {}) });
    payload = { protocol: "accord-device-events-v1", type: "event", from: DESKTOP_ID, to: MACHINE_ID, event };
  } else {
    payload = signMachineControl({ protocol: "accord-machine-link-v1", messageId: `m-${Math.random()}`,
      sentAt: new Date().toISOString(), body }, desktopEvents.identity, enrollment.rendezvousId, MACHINE_ID);
  }
  return sealMachineRelayPayload(payload, desktopEvents.identity, hostEvents.identity.publicKeyDerBase64, enrollment.rendezvousId);
}

async function sentBodies(client, enrollment) {
  const { openMachineRelayPayload } = await import("../dist/main/main/services/machineRelaySealing.js");
  const { openMobileRelayPayload } = await import("../dist/main/main/services/mobileRelaySealing.js");
  const bodies = [];
  for (const request of client.sent) {
    await assert.rejects(() => openMobileRelayPayload(request.ciphertext, SEAL_KEY), "the enrolling desktop channel never emits future content under the legacy room seal");
    const payload = await openMachineRelayPayload(request.ciphertext, desktopEvents.identity, [hostEvents.identity.publicKeyDerBase64], enrollment.rendezvousId);
    if (payload.protocol === "accord-device-events-v1") {
      if (payload.type === "event") bodies.push(await hostEvents.eventStorage.deviceEventBlobs().hydrate(payload.event.payload));
    } else bodies.push(payload.body);
  }
  return bodies;
}

function settle(ms = 150) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("a turn waiting for its chat state counts as held, and a stop removes it before the chat arrives", async () => {
  const { MachineHostService } = await import("../dist/main/main/services/machineHost.js");
  const client = stubClient();
  const runs = [];
  const store = new Map();
  const logs = [];
  const host = new MachineHostService(
    {
      runMachineHostedTurn: async (request) => { runs.push(request.runId); return { messages: [], warnings: [] }; },
      cancelRun: () => true,
      respondToAppToolApproval: async () => undefined,
      applyReplicatedConversation: async (id, merge) => { const next = merge(store.get(id)); if (next) store.set(id, next); }
    },
    { getConversation: async (id) => store.get(id) },
    { importMachineSettingsSnapshot: async () => undefined },
    { write: async (event, payload) => { logs.push({ event, payload }); } },
    { ...hostEvents, pairing: pairing(), deviceId: MACHINE_ID, appVersion: "test", createClient: () => client }
  );
  await host.start();
  await settle();
  const inbound = async (body) => {
    client.emit("message", { ciphertext: await envelope(body, host.options.pairing) });
    await host.inbound;
    await host.outbound;
    await host.eventChannel.flush();
  };
  await inbound({ type: "machine.hello.ack", desktopDeviceId: DESKTOP_ID, appVersion: "test", machineId: "test-home" });
  store.set("conv-1", { id: "conv-1", kind: "chat", title: "t", createdAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z", metadata: { participants: [] }, messages: [], findings: [] });
  // The desktop's chat change the request names has not arrived: the turn waits instead of running or failing.
  const chatHead = { originId: DESKTOP_ID, logScopeId: "chat-changes:conv-1", originSeq: 3 };
  await inbound({ type: "machine.turn.request", conversationId: "conv-1", participantId: "p1", participant: { id: "p1", handle: "bot", homeMachineId: "test-home" }, messageId: "m1", runId: "run-wait", pendingMessageId: "pending-wait", chatHead, requestedAt: new Date().toISOString() });
  assert.deepEqual(runs, []);
  assert.ok(logs.some((entry) => entry.event === "machine-host.turn.awaiting-chat" && entry.payload?.runId === "run-wait"));
  // Asked about it, the machine holds it: no "unknown".
  await inbound({ type: "machine.turn.query", conversationId: "conv-1", runId: "run-wait" });
  let bodies = await sentBodies(client, host.options.pairing);
  assert.ok(!bodies.some((body) => body.type === "machine.turn.unknown"), "a waiting turn is held, not unknown");
  // Stop while waiting: a confirmed interruption is stored and reported, and the copy completing must not start it.
  await inbound({ type: "machine.turn.cancel", conversationId: "conv-1", runId: "run-wait" });
  bodies = await sentBodies(client, host.options.pairing);
  const terminal = bodies.find((body) => body.type === "machine.turn.finished" && body.runId === "run-wait");
  assert.ok(terminal, "a stopped waiting turn reports a result");
  assert.equal(terminal.status, "interrupted");
  await settle(1_500);
  assert.deepEqual(runs, [], "a stopped waiting turn never starts");
  host.close();
});

test("a run the chat stopped on the User's stop action is reported as interrupted, not failed", async () => {
  const { MachineHostService } = await import("../dist/main/main/services/machineHost.js");
  const client = stubClient();
  const store = new Map();
  const host = new MachineHostService(
    {
      // The stop action reached the chat before this host's cancel: the chat
      // ended the run and marked the bubble stopped by the User.
      runMachineHostedTurn: async (request) => ({ messages: [{ id: request.pendingMessageId, role: "participant", participantId: "p1", content: "@bot stopped by user.",
        createdAt: new Date().toISOString(), status: "error", metadata: { runId: request.runId, terminalReason: "user-stopped" } }], warnings: [] }),
      cancelRun: () => true,
      respondToAppToolApproval: async () => undefined,
      applyReplicatedConversation: async (id, merge) => { const next = merge(store.get(id)); if (next) store.set(id, next); }
    },
    { getConversation: async (id) => store.get(id) },
    { importMachineSettingsSnapshot: async () => undefined },
    { write: async () => undefined },
    { ...hostEvents, pairing: pairing(), deviceId: MACHINE_ID, appVersion: "test", createClient: () => client }
  );
  await host.start();
  await settle();
  const inbound = async (body) => {
    client.emit("message", { ciphertext: await envelope(body, host.options.pairing) });
    await host.inbound;
    await host.outbound;
    await host.eventChannel.flush();
  };
  const member = { id: "p1", handle: "bot", kind: "claude-code", homeMachineId: "test-home" };
  await inbound({ type: "machine.hello.ack", desktopDeviceId: DESKTOP_ID, appVersion: "test", machineId: "test-home" });
  store.set("conv-stop-action", { id: "conv-stop-action", kind: "chat", title: "t", createdAt: "2026-10-18T00:00:00.000Z", updatedAt: "2026-10-18T00:00:00.000Z",
    metadata: { participants: [member] }, messages: [{ id: "m1", role: "user", content: "hi", createdAt: "2026-10-18T00:00:00.000Z" }], findings: [] });
  await inbound({ type: "machine.turn.request", conversationId: "conv-stop-action", participantId: "p1", participant: member, messageId: "m1", runId: "run-stop-action", pendingMessageId: "pending-stop-action", requestedAt: new Date().toISOString() });
  let terminal;
  for (let attempt = 0; attempt < 40 && !terminal; attempt += 1) {
    await settle(50);
    await host.eventChannel.flush();
    terminal = (await sentBodies(client, host.options.pairing)).find((body) => body.type === "machine.turn.finished" && body.runId === "run-stop-action");
  }
  assert.ok(terminal, "the stopped run reports a result");
  assert.equal(terminal.status, "interrupted", "a stop the chat confirmed is an interruption");
  host.close();
});

test("a picture arrives in parts and is reassembled; a desktop that leaves fails the read at once", async () => {
  const { MachineHostService } = await import("../dist/main/main/services/machineHost.js");
  const client = stubClient();
  const store = new Map();
  const host = new MachineHostService(
    {
      runMachineHostedTurn: async () => ({ messages: [], warnings: [] }),
      cancelRun: () => true,
      respondToAppToolApproval: async () => undefined,
      applyReplicatedConversation: async (id, merge) => { const next = merge(store.get(id)); if (next) store.set(id, next); }
    },
    { getConversation: async (id) => store.get(id) },
    { importMachineSettingsSnapshot: async () => undefined },
    { write: async () => undefined },
    { ...hostEvents, pairing: pairing(), deviceId: MACHINE_ID, appVersion: "test", createClient: () => client }
  );
  await host.start();
  await settle();
  const inbound = async (body) => {
    client.emit("message", { ciphertext: await envelope(body, host.options.pairing) });
    await host.inbound;
  };
  await inbound({ type: "machine.hello.ack", desktopDeviceId: DESKTOP_ID, appVersion: "test", machineId: "test-home" });

  const answered = host.requestAttachment("conv-1", "att-1", 5000);
  await settle();
  const request = (await sentBodies(client, host.options.pairing)).find((body) => body.type === "machine.attachment.request");
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
  const second = (await sentBodies(client, host.options.pairing)).filter((body) => body.type === "machine.attachment.request").at(-1);
  await inbound({ type: "machine.attachment.result", requestId: second.requestId, conversationId: "conv-1", attachmentId: "att-2", ok: false, error: "This chat has no member on this machine." });
  await assert.rejects(refused, /no member on this machine/);

  const orphaned = host.requestAttachment("conv-1", "att-3", 60_000);
  await settle();
  client.emit("peer", { type: "peer-disconnected", peer: { role: "desktop", deviceId: DESKTOP_ISSUER.originId } });
  await assert.rejects(Promise.race([orphaned, new Promise((_, reject) => setTimeout(() => reject(new Error("still waiting")), 1000))]),
    /desktop went away/, "a read outstanding when the desktop leaves fails now, not after the bound");
  host.close();
});

test("the machine's hello lists turns waiting for their chat as active", async () => {
  const { MachineHostService } = await import("../dist/main/main/services/machineHost.js");
  const client = stubClient();
  const store = new Map();
  const host = new MachineHostService(
    {
      runMachineHostedTurn: async () => ({ messages: [], warnings: [] }),
      cancelRun: () => true,
      respondToAppToolApproval: async () => undefined,
      applyReplicatedConversation: async (id, merge) => { const next = merge(store.get(id)); if (next) store.set(id, next); }
    },
    { getConversation: async (id) => store.get(id) },
    { importMachineSettingsSnapshot: async () => undefined },
    { write: async () => undefined },
    { ...hostEvents, pairing: pairing(), deviceId: MACHINE_ID, appVersion: "test", createClient: () => client }
  );
  await host.start();
  await settle();
  const inbound = async (body) => {
    client.emit("message", { ciphertext: await envelope(body, host.options.pairing) });
    await host.inbound;
    await host.outbound;
    await host.eventChannel.flush();
  };
  await inbound({ type: "machine.hello.ack", desktopDeviceId: DESKTOP_ID, appVersion: "test", machineId: "test-home" });
  store.set("conv-2", { id: "conv-2", kind: "chat", title: "t", createdAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z", metadata: { participants: [] }, messages: [], findings: [] });
  await inbound({ type: "machine.turn.request", conversationId: "conv-2", participantId: "p1", participant: { id: "p1", handle: "bot", homeMachineId: "test-home" }, messageId: "m1", runId: "run-listed", pendingMessageId: "pending-listed",
    chatHead: { originId: DESKTOP_ID, logScopeId: "chat-changes:conv-2", originSeq: 2 }, requestedAt: new Date().toISOString() });
  // A fresh link announces itself again; the hello must list the waiting turn.
  client.emit("peer", { type: "ready", deviceId: MACHINE_ID, peerConnected: true, peers: [{ role: "desktop", deviceId: DESKTOP_ID }] });
  await settle();
  const bodies = await sentBodies(client, host.options.pairing);
  const hello = bodies.filter((body) => body.type === "machine.hello").pop();
  assert.ok(hello.activeRunIds.includes("run-listed"));
  host.close();
});

test("a turn waits for the chat change it names and then runs on the whole chat", async () => {
  const { MachineHostService } = await import("../dist/main/main/services/machineHost.js");
  const chatChanges = await import("../dist/main/main/services/chatChanges.js");
  const enrollment = pairing();
  const store = new Map();
  const runs = [];
  const host = new MachineHostService({
    runMachineHostedTurn: async (request) => { runs.push(store.get(request.conversationId).messages.map((message) => message.id)); return { messages: [], warnings: [] }; },
    cancelRun: () => true,
    respondToAppToolApproval: async () => undefined,
    applyReplicatedConversation: async (id, merge) => { const next = merge(store.get(id)); if (next) store.set(id, next); }
  }, { getConversation: async (id) => store.get(id) }, { importMachineSettingsSnapshot: async () => undefined }, { write: async () => undefined },
  { ...hostEvents, pairing: enrollment, deviceId: MACHINE_ID, appVersion: "test", createClient: stubClient,
    applyChatChanges: async (event, payload) => {
      const result = chatChanges.applyChatChanges(store.get(payload.conversationId), payload, event.originId, { acceptsConversationFields: () => true, acceptsMessageUpdate: () => true, acceptsMessageCreate: () => true, acceptsMessageRemoval: () => true, holdsUnknownChats: true });
      if (result.status !== "applied") return "missing-conversation";
      store.set(payload.conversationId, result.conversation);
      return "applied";
    } });
  const conversationId = "chat-head-" + Date.now();
  const scope = chatChanges.chatChangesLogScope(conversationId);
  const at = "2026-09-24T12:00:00.000Z";
  const change = async (changes) => (await desktopEvents.eventLog.appendLocalEvent({ conversationId, logScopeId: scope, kind: chatChanges.CHAT_CHANGES_EVENT_KIND,
    payload: { version: 1, conversationId, updatedAt: at, changes } })).event;
  const receive = (event) => host.eventChannel.receive({ protocol: "accord-device-events-v1", from: DESKTOP_ID, to: MACHINE_ID, type: "event", event });
  try {
    await host.start();
    await host.handleBody({ type: "machine.hello.ack", desktopDeviceId: DESKTOP_ID, machineId: "head-home", appVersion: "test" });
    const first = await change([
      { type: "conversation.created", conversation: { title: "t", kind: "chat", createdAt: at, metadata: { participants: [] } } },
      { type: "message.created", message: { id: "m1", role: "user", content: "one", createdAt: at, status: "done" } }
    ]);
    const second = await change([{ type: "message.created", message: { id: "m2", role: "user", content: "two", createdAt: "2026-09-24T12:00:01.000Z", status: "done" } }]);
    await receive(first);
    await host.handleBody({ type: "machine.turn.request", conversationId, participantId: "p1", participant: { id: "p1", handle: "bot" }, messageId: "m2", runId: "head-run",
      pendingMessageId: "pending", chatHead: { originId: DESKTOP_ID, logScopeId: scope, originSeq: second.originSeq }, requestedAt: at });
    await settle(1_300);
    assert.deepEqual(runs, [], "the chat has only its first change here: the member does not start on it");
    await receive(second);
    const deadline = Date.now() + 5_000;
    while (!runs.length && Date.now() < deadline) await settle(100);
    assert.deepEqual(runs, [["m1", "m2"]], "the turn runs once the named change is applied, on the whole chat");
  } finally { host.close(); }
});

test("a ChatService native resume is listed, stopped and delivered through the host's result outbox", async (t) => {
  const { ChatService } = await import("../dist/main/main/services/chat.js");
  const { MachineHostService } = await import("../dist/main/main/services/machineHost.js");
  const client = stubClient();
  const logs = { write: async () => undefined };
  const chat = Object.create(ChatService.prototype);
  Object.assign(chat, {
    chatRunMeta: new Map(), chatRunControllers: new Map(), activeConversationRunIds: new Map(), activeRunIds: new Set(),
    participantRequestRunners: new Map(), remoteRunHandlesByRun: new Map(), participantRunSettledListeners: new Set(),
    appSendMessageCountsByRun: new Map(), appSendMessageImageBytesByRun: new Map(), debugLogs: logs,
    settledParticipantRunResult: async () => ({ messages: [{ id: "native-bubble", role: "participant", participantId: "p1", status: "error", content: "partial", createdAt: new Date().toISOString(), metadata: { runId: "native-resume", terminalReason: "user-stopped" } }], warnings: [] })
  });
  const host = new MachineHostService(chat, {}, {}, logs, { ...hostEvents, pairing: pairing(), deviceId: MACHINE_ID, appVersion: "test", createClient: () => client });
  t.after(async () => { host.close(); await host.inbound; await host.outbound; await host.eventChannel.flush(); });
  const controller = new AbortController();
  chat.registerTargetRun("native-resume", controller, { conversationId: "native-chat", participantId: "p1", participantHandle: "bot" });
  await host.start();
  client.emit("peer", { type: "ready", peers: [{ role: "desktop", deviceId: DESKTOP_ID }] });
  await settle();
  let bodies = await sentBodies(client, host.options.pairing);
  assert.ok(bodies.find((body) => body.type === "machine.hello").activeRunIds.includes("native-resume"));
  client.emit("message", { ciphertext: await envelope({ type: "machine.turn.query", conversationId: "native-chat", runId: "native-resume" }, host.options.pairing) });
  client.emit("message", { ciphertext: await envelope({ type: "machine.turn.cancel", conversationId: "native-chat", runId: "native-resume" }, host.options.pairing) });
  await settle();
  assert.equal(controller.signal.aborted, true, "Stop reaches the actual ChatService controller");
  bodies = await sentBodies(client, host.options.pairing);
  assert.equal(bodies.filter((body) => body.type === "machine.turn.unknown").length, 0);
  assert.equal(bodies.filter((body) => body.type === "machine.turn.finished").length, 0, "abort is not completion");
  chat.unregisterTargetRun("native-resume", controller);
  const finishDeadline = Date.now() + 5000;
  while (!host.pendingTerminals.has("native-resume")) {
    assert.ok(Date.now() < finishDeadline, "the native completion must be retained");
    await settle(20);
  }
  await host.outbound;
  await host.eventChannel.flush();
  bodies = await sentBodies(client, host.options.pairing);
  const terminal = bodies.find((body) => body.type === "machine.turn.finished");
  assert.equal(terminal.status, "interrupted");
  assert.equal(terminal.messages[0].content, "partial");
  assert.ok(host.pendingTerminals.has("native-resume"), "result stays until the desktop acknowledges its saved copy");
  const newer = { ...terminal, receiptId: "newer-receipt", messages: [{ ...terminal.messages[0], content: "new result" }] };
  host.pendingTerminals.set("native-resume", newer);
  client.emit("message", { ciphertext: await envelope({ type: "machine.turn.finished.ack", conversationId: "native-chat", runId: "native-resume", receiptId: terminal.receiptId, finishedAt: terminal.finishedAt }, host.options.pairing) });
  await settle();
  assert.equal(host.pendingTerminals.get("native-resume"), newer, "an old ACK cannot remove a newer result, even with an equal finish timestamp");
  client.emit("message", { ciphertext: await envelope({ type: "machine.turn.finished.ack", conversationId: "native-chat", runId: "native-resume", receiptId: newer.receiptId, finishedAt: newer.finishedAt }, host.options.pairing) });
  await settle();
  assert.equal(host.pendingTerminals.has("native-resume"), false);
  host.close();
});


test("runtime shutdown stores the final outcome before closing its device channel", async () => {
  const { MachineHostService } = await import("../dist/main/main/services/machineHost.js");
  const client = stubClient();
  let closed = false;
  client.close = () => { closed = true; };
  let finishRun;
  const held = new Promise(resolve => { finishRun = resolve; });
  const enrollment = pairing();
  const host = new MachineHostService(
    { runMachineHostedTurn: async () => held, cancelRun: () => true,
      respondToAppToolApproval: async () => undefined, applyReplicatedConversation: async () => undefined },
    { getConversation: async () => undefined },
    { importMachineSettingsSnapshot: async () => undefined },
    { write: async () => undefined },
    { ...hostEvents, pairing: enrollment, deviceId: MACHINE_ID, appVersion: "test", createClient: () => client }
  );
  await host.start();
  await host.handleBody({ type: "machine.hello.ack", desktopDeviceId: DESKTOP_ID, appVersion: "test" });
  const request = { type: "machine.turn.request", conversationId: "shutdown-chat", participantId: "p", participant: {id:"p",handle:"bot"}, messageId:"input",runId:"shutdown-run",pendingMessageId:"reply",requestedAt:new Date().toISOString() };
  await host.handleBody(request);
  await host.shutdown(async () => {
    assert.equal(closed, false);
    finishRun({ messages: [{id:"reply",role:"participant",participantId:"p",status:"error",content:"The provider closed.",createdAt:new Date().toISOString()}], warnings:[] });
  });
  assert.equal(closed, true);
  const pending = await hostEvents.eventStorage.deviceEvents().listPending(enrollment.rendezvousId);
  assert.ok(pending.some(row => row.event.kind === "machine.turn.finished"));
  assert.equal(host.pendingTerminals.get("shutdown-run").status, "failed", "runtime closure must not be presented as User Stop");
});


test("a member request from this machine reaches the desktop as one durable delegation", async () => {
  const { MachineHostService } = await import("../dist/main/main/services/machineHost.js");
  const client = stubClient();
  const enrollment = pairing();
  const host = new MachineHostService(
    { runMachineHostedTurn: async () => ({ messages: [], warnings: [] }), cancelRun: () => true,
      respondToAppToolApproval: async () => undefined, applyReplicatedConversation: async () => undefined },
    { getConversation: async () => undefined },
    { importMachineSettingsSnapshot: async () => undefined },
    { write: async () => undefined },
    { ...hostEvents, pairing: enrollment, deviceId: MACHINE_ID, appVersion: "test", createClient: () => client }
  );
  try {
    await host.start();
    await host.handleBody({ type: "machine.hello.ack", desktopDeviceId: DESKTOP_ID, appVersion: "test" });
    const request = { conversationId: "delegating-chat", requestMessageId: "request-1", batchId: "batch-1", depth: 1 };
    await host.delegateParticipantRequest(request);
    // The member asked once; a retry of the same ask is the same event.
    await host.delegateParticipantRequest(request);
    await host.outbound;
    await host.eventChannel.flush();

    const pending = await hostEvents.eventStorage.deviceEvents().listPending(enrollment.rendezvousId);
    const delegations = pending.filter((row) => row.event.kind === "machine.participants.delegate");
    assert.equal(delegations.length, 1, "one request message is one delegation, however often it is retried");
    const body = await hostEvents.eventStorage.deviceEventBlobs().hydrate(delegations[0].event.payload);
    assert.equal(body.conversationId, "delegating-chat");
    assert.equal(body.requestMessageId, "request-1");
    assert.equal(body.batchId, "batch-1");
    assert.equal(body.depth, 1);
  } finally {
    host.close();
    await host.inbound;
    await host.outbound;
    await host.eventChannel.flush().catch(() => undefined);
  }
});

test("a Claude member's turns on a machine run as soon as they are admitted; another member's turns wait for the previous one", async () => {
  const { MachineHostService } = await import("../dist/main/main/services/machineHost.js");
  for (const kind of ["claude-code", "codex-cli"]) {
    const client = stubClient();
    const started = [];
    const store = new Map();
    let releaseFirst;
    const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
    const host = new MachineHostService(
      {
        runMachineHostedTurn: async (request) => {
          started.push(request.runId);
          if (request.runId.endsWith("-1")) await firstBlocked;
          return { messages: [], warnings: [] };
        },
        cancelRun: () => true,
        respondToAppToolApproval: async () => undefined,
        applyReplicatedConversation: async (id, merge) => { const next = merge(store.get(id)); if (next) store.set(id, next); }
      },
      { getConversation: async (id) => store.get(id) },
      { importMachineSettingsSnapshot: async () => undefined },
      { write: async () => undefined },
      { ...hostEvents, pairing: pairing(), deviceId: MACHINE_ID, appVersion: "test", createClient: () => client }
    );
    await host.start();
    await settle();
    const inbound = async (body) => {
      client.emit("message", { ciphertext: await envelope(body, host.options.pairing) });
      await host.inbound;
      await host.outbound;
      await host.eventChannel.flush();
    };
    const conversationId = `conv-concurrent-${kind}`;
    const member = { id: "p1", handle: "bot", kind, homeMachineId: "test-home" };
    await inbound({ type: "machine.hello.ack", desktopDeviceId: DESKTOP_ID, appVersion: "test", machineId: "test-home" });
    const shell = { id: conversationId, kind: "chat", title: "t", createdAt: "2026-10-17T00:00:00.000Z", updatedAt: "2026-10-17T00:00:00.000Z", metadata: { participants: [member] }, messages: [], findings: [] };
    // The chat, with the messages the member answers, is already on the
    // machine (chats arrive as change events).
    store.set(conversationId, { ...shell, messages: [1, 2].map((index) => ({ id: `m${index}`, role: "user", content: `hi ${index}`, createdAt: shell.createdAt })) });
    for (const index of [1, 2]) {
      await inbound({ type: "machine.turn.request", conversationId, participantId: "p1", participant: member, messageId: `m${index}`, runId: `${kind}-run-${index}`, pendingMessageId: `pending-${index}`, requestedAt: new Date().toISOString() });
    }
    await settle(400);
    if (kind === "claude-code") {
      assert.deepEqual(started, [`${kind}-run-1`, `${kind}-run-2`], "the second message reached the Claude member while the first was still running");
    } else {
      assert.deepEqual(started, [`${kind}-run-1`], "a non-Claude member's next turn waits for the running one");
    }
    releaseFirst();
    await settle(400);
    assert.deepEqual(started, [`${kind}-run-1`, `${kind}-run-2`]);
    host.close();
  }
});

test("the desktop's script requests are answered by the machine's scripts, off the inbound chain, and enabled scripts keep the machine awake", async () => {
  const { MachineHostService } = await import("../dist/main/main/services/machineHost.js");
  const client = stubClient();
  const handled = [];
  const names = [];
  let awake = false;
  let releaseSlow;
  const host = new MachineHostService(
    {
      runMachineHostedTurn: async () => ({ messages: [], warnings: [] }),
      cancelRun: () => true,
      respondToAppToolApproval: async () => undefined,
      applyReplicatedConversation: async () => undefined
    },
    { getConversation: async () => undefined },
    { importMachineSettingsSnapshot: async () => undefined },
    { write: async () => undefined },
    {
      ...hostEvents, pairing: pairing(), deviceId: MACHINE_ID, appVersion: "test", createClient: () => client,
      onDesktopMachineName: (name) => names.push(name),
      scripts: {
        handle: async (operation) => {
          handled.push(operation.op);
          if (operation.op === "releaseHeld") await new Promise((resolve) => { releaseSlow = resolve; });
          if (operation.op === "runNow") throw new Error("That script is switched off.");
          return [{ id: "s1", name: "Alerts" }];
        },
        keepsHostAwake: () => awake
      }
    }
  );
  await host.start();
  await settle();
  const inbound = async (body) => {
    client.emit("message", { ciphertext: await envelope(body, host.options.pairing) });
    await host.inbound;
    await host.outbound;
    await host.eventChannel.flush();
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
  assert.ok((await sentBodies(client, host.options.pairing)).some((body) => body.type === "machine.scripts.result" && body.requestId === "r1"),
    "the list is answered while held messages are still being posted");
  releaseSlow();
  await inbound({ type: "machine.scripts.request", requestId: "r2", instanceId, expiresAt, operation: { op: "runNow", scriptId: "s1" } });
  // A frame made for an earlier run of this runtime changes nothing.
  await inbound({ type: "machine.scripts.request", requestId: "stale", instanceId: "an-earlier-run", expiresAt, operation: { op: "delete", scriptId: "s1" } });
  // And one the desktop already gave up on is not done late.
  await inbound({ type: "machine.scripts.request", requestId: "late", instanceId, expiresAt: new Date(Date.now() - 120_000).toISOString(), operation: { op: "setEnabled", scriptId: "s1", enabled: true } });
  await settle();
  let bodies = await sentBodies(client, host.options.pairing);
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
  bodies = await sentBodies(client, host.options.pairing);
  const hello = bodies.filter((body) => body.type === "machine.hello").pop();
  assert.equal(hello.keepAwake, true);
  assert.deepEqual(hello.activeRunIds ?? [], [], "keeping awake is not a run: the update gate does not wait for it");
  assert.equal(bodies.filter((body) => body.type === "machine.scripts.changed").length, 1);
  host.close();
});

test("a runtime without scheduled scripts answers the desktop instead of leaving it waiting", async () => {
  const { MachineHostService } = await import("../dist/main/main/services/machineHost.js");
  const client = stubClient();
  const host = new MachineHostService(
    { runMachineHostedTurn: async () => ({ messages: [], warnings: [] }), cancelRun: () => true, respondToAppToolApproval: async () => undefined, applyReplicatedConversation: async () => undefined },
    { getConversation: async () => undefined },
    { importMachineSettingsSnapshot: async () => undefined },
    { write: async () => undefined },
    { ...hostEvents, pairing: pairing(), deviceId: MACHINE_ID, appVersion: "test", createClient: () => client }
  );
  await host.start();
  await settle();
  client.emit("message", { ciphertext: await envelope({ type: "machine.hello.ack", desktopDeviceId: DESKTOP_ID, appVersion: "test", machineId: "test-home" }, host.options.pairing) });
  client.emit("message", { ciphertext: await envelope({ type: "machine.scripts.request", requestId: "r1", instanceId: host.instanceId, expiresAt: new Date(Date.now() + 20_000).toISOString(), operation: { op: "list" } }, host.options.pairing) });
  await host.inbound;
  await settle();
  const result = (await sentBodies(client, host.options.pairing)).find((body) => body.type === "machine.scripts.result");
  assert.equal(result.ok, false);
  assert.match(result.error, /does not host scheduled scripts/);
  assert.equal((await sentBodies(client, host.options.pairing)).find((body) => body.type === "machine.hello").scriptsSupported, undefined);
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
