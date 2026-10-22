// A machine that talks only to the User's server (hub order): the desktop's
// MachineLinkService and the machine's MachineHostService through a real
// hub (its rooms, its one order, its fold), each with its own HubSync, as
// src/main/main.ts and src/machine/main.ts compose them. Nobody keeps a
// delivery row for a device that reads the hub: a writer is done once the
// hub holds the event, and each reader's place in the order is its only
// acknowledgement.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const { StorageService } = await import("../dist/main/main/services/storage.js");
const { ChatEventLogService } = await import("../dist/main/main/services/chatEventLog.js");
const { MachineLinkService } = await import("../dist/main/main/services/machineLink.js");
const { MachineHostService } = await import("../dist/main/main/services/machineHost.js");
const { HubTunnelClient } = await import("../dist/main/main/services/hubTunnelClient.js");
const { HubClient } = await import("../dist/main/main/services/hubClient.js");
const { HubSync, HUB_SCOPE_PREFIXES, HUB_SHARED_SCOPE_PREFIXES } = await import("../dist/main/main/services/hubSync.js");
const { ChatSearchService } = await import("../dist/main/main/services/chatSearch.js");
const chatChanges = await import("../dist/main/main/services/chatChanges.js");
const { HubServer } = await import("../dist/main/hub/hubServer.js");
const { HubLog } = await import("../dist/main/hub/hubLog.js");
const { HubFolder } = await import("../dist/main/hub/hubFolder.js");
const { hubApplyPolicy } = await import("../dist/main/hub/hubPolicy.js");

async function device(directory, name) {
  const dbPath = path.join(directory, `${name}.sqlite3`);
  const eventStorage = new StorageService({ dbPath });
  await eventStorage.init();
  const eventLog = new ChatEventLogService(eventStorage);
  const identity = await eventLog.getOrCreateDeviceIdentity();
  return { dbPath, eventStorage, eventLog, identity, publicKeyDerBase64: identity.publicKeyDerBase64 };
}

/** Rows straight from the file, not through the code under test: read-only,
 *  waiting out the writers' locks, and off the event loop the services run on. */
async function outboxRows(dbPath, where = "1 = 1") {
  const { stdout } = await promisify(execFile)("sqlite3", ["-readonly", "-cmd", ".timeout 10000", dbPath, `select count(*) from device_event_outbox where ${where};`], { encoding: "utf8" });
  return Number(stdout.trim()) || 0;
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const started = Date.now();
  while (!await predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("through the User's hub a machine runs turns, streams, answers approvals and stops; nobody keeps a delivery row for a hub reader, and the hub folds the machine's reply with the desktop away", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "accord-machine-hub-order-"));
  const desktop = await device(directory, "desktop");
  const machine = await device(directory, "machine");
  const hubStore = await device(directory, "hub");
  const DESKTOP_ID = desktop.identity.originId;
  const MACHINE_ID = machine.identity.originId;
  const phone = await device(directory, "phone");

  // The hub, owned by the desktop, with the machine on its roster (as the
  // desktop publishes it once setup recorded the machine's key).
  await hubStore.eventStorage.hub().setOwner({ deviceId: DESKTOP_ID, publicKeyDerBase64: desktop.publicKeyDerBase64, name: "Desktop", addedAt: new Date().toISOString() });
  await hubStore.eventStorage.hub().replaceRoster([
    { deviceId: MACHINE_ID, publicKeyDerBase64: machine.publicKeyDerBase64, role: "machine", name: "Test box", machineId: "machine-1", addedAt: "" }
  ], new Date().toISOString());
  const hubLog = new HubLog(hubStore.eventStorage);
  const folder = new HubFolder(hubStore.eventStorage, hubApplyPolicy(hubStore.eventStorage));
  hubLog.onAppended(({ changedConversationIds }) => folder.enqueue(changedConversationIds));
  const server = new HubServer({ hubId: "hub-order-test", version: "test", storage: hubStore.eventStorage, log: hubLog,
    search: new ChatSearchService(hubStore.eventStorage), vapidPublicKey: "B" });
  const http = await server.listenHttp(0, "127.0.0.1");
  const hubUrl = `http://127.0.0.1:${http.address().port}`;
  const closers = [];
  t.after(async () => {
    for (const close of closers.reverse()) await Promise.resolve().then(close).catch(() => undefined);
    folder.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });

  const now = Date.now();
  const pairing = {
    version: 1, purpose: "machine-host",
    issuer: { originId: DESKTOP_ID, keyId: desktop.identity.keyId, publicKeyDerBase64: desktop.publicKeyDerBase64 },
    rendezvousId: `rv-hub-order-${now}`, stableRoutingId: "route-hub-order",
    relaySealKeyBase64: Buffer.from(new Uint8Array(32).map((_, index) => index + 7)).toString("base64url"),
    hubUrl,
    capabilities: [{ scope: "device", canRead: true, canWrite: true, canRunCloudParticipants: true, canListConversations: true }],
    fingerprint: "TEST-CAP", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString()
  };
  // Recorded at setup, before the machine's first hello.
  const record = { id: "machine-1", name: "Test box", deviceId: MACHINE_ID, devicePublicKeyDerBase64: machine.publicKeyDerBase64, chatChanges: true,
    pairingKey: pairing.rendezvousId, createdAt: new Date(now).toISOString() };
  const logs = [];
  const debugLogs = { write: async (event, payload) => { logs.push({ event, payload }); } };
  const chatHeads = new Map();
  const link = new MachineLinkService({
    listMachines: async () => [record],
    saveMachine: async (next) => { Object.assign(record, next); return [record]; },
    removeMachine: async () => [],
    getMachinePairing: async (key) => (key === pairing.rendezvousId ? pairing : undefined),
    exportMachineSettingsSnapshot: async () => ({ version: 1, exportedAt: new Date().toISOString(), settingsJson: JSON.stringify({ chatRoleConfigs: [{ id: "engineer" }] }), agentEnvironment: [] })
  }, debugLogs, {
    eventStorage: desktop.eventStorage, eventLog: desktop.eventLog, appVersion: "test", desktopDeviceId: DESKTOP_ID, reconnectDelayMs: 50,
    hubMode: true,
    createClient: (enrollment) => enrollment.hubUrl ? new HubTunnelClient({ hubUrl: enrollment.hubUrl, rendezvousId: enrollment.rendezvousId, role: "desktop",
      identity: () => desktop.eventLog.getOrCreateDeviceIdentity(), reconnectDelayMs: 50 }) : undefined,
    chatChangeHead: async (id) => ({ originId: DESKTOP_ID, logScopeId: chatChanges.chatChangesLogScope(id), originSeq: chatHeads.get(id) ?? 0 }),
    // A phone the User trusts is named to the machine too; through the hub
    // the machine keeps nothing for it either.
    trustedDevices: async (room) => [{ deviceId: phone.identity.originId, publicKeyDerBase64: phone.publicKeyDerBase64, role: "phone", name: "iPhone",
      relayUrl: room.relayUrl, rendezvousId: room.rendezvousId, fingerprint: room.fingerprint }]
  });
  closers.push(() => link.close());
  await link.loadMachines();
  assert.deepEqual(link.hubReaders(), [MACHINE_ID], "known as a hub reader before it connects");
  assert.deepEqual(link.chatChangeRecipients(), [], "a machine that reads the hub is never addressed");
  assert.deepEqual(link.chatActionRecipients(), []);

  const desktopSync = new HubSync({
    client: new HubClient({ url: hubUrl, identity: () => desktop.eventLog.getOrCreateDeviceIdentity(), storage: desktop.eventStorage }),
    storage: desktop.eventStorage,
    localOriginId: async () => DESKTOP_ID,
    trustedKey: async (originId) => originId === MACHINE_ID ? machine.publicKeyDerBase64 : undefined,
    deliver: (event) => link.receiveFromHub(event),
    applyChatChange: async () => "applied",
    onPushed: (eventIds) => desktop.eventStorage.hub().acknowledgeOutbox(eventIds, new Date().toISOString(), link.hubReaders()),
    scopePrefixes: [...HUB_SHARED_SCOPE_PREFIXES, `device:${pairing.rendezvousId}:`]
  });
  closers.push(() => desktopSync.stop());
  desktop.eventLog.onLocalAppend(() => desktopSync.nudgePush());

  // What the desktop's ChatService does on every save: one signed change.
  const baselines = new Map();
  const publishChat = async (conversation) => {
    const { changes } = chatChanges.diffChatChanges(baselines.get(conversation.id), conversation, { emitsConversationFields: true, ownsMessage: (message) => message.role !== "participant" || message.status === "pending" });
    if (!changes.length) return;
    const payload = await desktop.eventStorage.deviceEventBlobs().prepare({ version: 1, conversationId: conversation.id, updatedAt: conversation.updatedAt, changes });
    const { event } = await desktop.eventLog.appendLocalEvent({ conversationId: conversation.id, logScopeId: chatChanges.chatChangesLogScope(conversation.id),
      kind: chatChanges.CHAT_CHANGES_EVENT_KIND, payload, recipients: link.chatChangeRecipients() });
    baselines.set(conversation.id, chatChanges.chatChangeBaseline(JSON.parse(JSON.stringify(conversation))));
    chatHeads.set(conversation.id, event.originSeq);
  };

  const machineStore = new Map();
  const importedSnapshots = [];
  const hostRuns = [];
  const approvalRequests = [];
  let releaseLongTurn;
  const hostChat = {
    runMachineHostedTurn: async (request, signal, progress) => {
      hostRuns.push(request);
      progress?.({ runId: request.runId, phase: "debate", message: `working on ${request.messageId}`, createdAt: new Date().toISOString() });
      if (request.messageId === "msg-long") {
        await new Promise((resolve) => { releaseLongTurn = resolve; signal?.addEventListener("abort", resolve, { once: true }); });
        if (signal?.aborted) return { messages: [], warnings: [] };
      }
      const reply = { id: request.pendingMessageId, role: "participant", participantId: request.participantId, participantLabel: "@bot",
        content: `reply to ${request.messageId}`, createdAt: new Date().toISOString(), status: "done", metadata: { runId: request.runId } };
      return { messages: [reply], warnings: [] };
    },
    cancelRun: () => true,
    applyReplicatedConversation: async (id, merge) => { const next = merge(machineStore.get(id)); if (next) machineStore.set(id, next); },
    respondToAppToolApproval: async (request, _progress, execution) => {
      approvalRequests.push(request);
      const conversation = machineStore.get(request.conversationId);
      await execution?.beforeApply({ id: request.approvalId, requesterParticipantId: conversation.metadata.participants[0].id });
      const next = { ...conversation, metadata: { ...conversation.metadata, pendingAppToolApprovals: [{ id: request.approvalId, status: "approved", updatedAt: new Date().toISOString() }] } };
      machineStore.set(request.conversationId, next);
      return next;
    }
  };
  const host = new MachineHostService(hostChat, { getConversation: async (id) => machineStore.get(id) },
    { importMachineSettingsSnapshot: async (snapshot) => { importedSnapshots.push(snapshot); } }, debugLogs, {
      eventStorage: machine.eventStorage, eventLog: machine.eventLog, publicKeyDerBase64: machine.publicKeyDerBase64,
      chatActions: {
        handles: (event) => event.kind === "permission.decided",
        apply: async (event, payload) => {
          await host.applyApprovalAction(event, payload ?? event.payload);
          return { status: "applied", kind: event.kind, targetKey: (payload ?? event.payload).targetKey };
        }
      },
      pairing, deviceId: MACHINE_ID, machineName: "test-box", appVersion: "test", reconnectDelayMs: 50,
      trustRosterPath: path.join(directory, "machine-trust-roster.json"),
      outboxPath: path.join(directory, "machine-outbox.json"),
      hubMode: true,
      createClient: (enrollment) => new HubTunnelClient({ hubUrl, rendezvousId: enrollment.rendezvousId, role: "machine",
        identity: () => machine.eventLog.getOrCreateDeviceIdentity(), reconnectDelayMs: 50 }),
      createPeerClient: (room) => new HubTunnelClient({ hubUrl, rendezvousId: room.rendezvousId, role: "machine",
        identity: () => machine.eventLog.getOrCreateDeviceIdentity(), reconnectDelayMs: 50 }),
      detectProviders: async () => [{ kind: "codex-cli", label: "Codex", installed: true, version: "0.153.4" }],
      applyChatChanges: async (event, payload) => {
        const result = chatChanges.applyChatChanges(machineStore.get(payload.conversationId), payload, event.originId,
          { acceptsConversationFields: () => true, acceptsMessageUpdate: () => true, acceptsMessageCreate: () => true, acceptsMessageRemoval: () => true, holdsUnknownChats: true });
        if (result.status !== "applied") return "missing-conversation";
        machineStore.set(payload.conversationId, result.conversation);
        return "applied";
      }
    });
  const machineSync = new HubSync({
    client: new HubClient({ url: hubUrl, identity: () => machine.eventLog.getOrCreateDeviceIdentity(), storage: machine.eventStorage }),
    storage: machine.eventStorage,
    localOriginId: async () => MACHINE_ID,
    trustedKey: async (originId) => host.trustedKey(originId),
    deliver: (event) => host.receiveFromHub(event),
    applyChatChange: async () => "applied",
    onPushed: (eventIds) => machine.eventStorage.hub().acknowledgeOutbox(eventIds, new Date().toISOString()),
    scopePrefixes: HUB_SCOPE_PREFIXES
  });
  closers.push(() => host.close(), () => machineSync.stop());
  machine.eventLog.onLocalAppend(() => machineSync.nudgePush());

  // "Ever": every 25 ms during the whole session, on both sides.
  let desktopMax = 0;
  let machineMax = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const [desktopRows, machineRows] = await Promise.all([outboxRows(desktop.dbPath, `device_id = '${MACHINE_ID}'`), outboxRows(machine.dbPath)]);
      desktopMax = Math.max(desktopMax, desktopRows);
      machineMax = Math.max(machineMax, machineRows);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  })();
  closers.push(async () => { sampling = false; await sampler.catch(() => undefined); });

  desktopSync.startPushing();
  await link.start();
  desktopSync.start();
  await host.start();
  machineSync.start();
  await waitFor(() => link.isMachineConnected("machine-1"), 10_000);
  assert.equal(link.presenceState("machine-1"), "connected", "the hub's room says the machine is there");
  await waitFor(() => importedSnapshots.length >= 1, 10_000);

  const participant = { id: "p1", handle: "bot", roleConfigId: "engineer", kind: "codex-cli", homeMachineId: "machine-1" };
  const conversation = {
    id: "conv-hub", kind: "chat", title: "Through the hub", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    messages: [{ id: "msg-1", role: "user", content: "hi", createdAt: new Date().toISOString(), status: "done" }],
    metadata: { participants: [participant] }, findings: []
  };
  const runTurn = async (request) => { await publishChat(request.conversation); return link.runTurn(request); };

  // A turn: the command, the chat and the result all go through the hub's order.
  const progressSeen = [];
  const first = await runTurn({ conversation, participant, triggerMessage: conversation.messages[0], runId: "run-1", pendingMessageId: "pending-1",
    progress: (progress) => progressSeen.push(progress) });
  assert.equal(first.status, "completed", JSON.stringify(first));
  assert.equal(first.messages[0].content, "reply to msg-1");
  assert.ok(progressSeen.some((progress) => /working on msg-1/.test(progress.message ?? "")), "progress streams through the hub");
  await first.acknowledge?.();
  await waitFor(() => logs.some((entry) => entry.event === "machine-host.terminal.acked" && entry.payload?.runId === "run-1"), 10_000);

  // An approval answered on the desktop reaches the machine and its outcome comes back.
  const storedApprovals = [];
  link.onApproval(async (event) => { storedApprovals.push(event.approval); });
  await link.respondToMachineApproval({ machineId: "machine-1", conversationId: "conv-hub", approvalId: "approval-1", approve: true, scope: "once" });
  assert.equal(approvalRequests.length, 1);
  assert.equal(approvalRequests[0].approvalId, "approval-1");
  assert.ok(storedApprovals.some((approval) => approval.status === "approved"), "the machine's view of the card came back");

  // Stop: the machine's turn signal fires and the result is interrupted.
  conversation.messages.push({ id: "msg-long", role: "user", content: "slow", createdAt: new Date().toISOString(), status: "done" });
  const controller = new AbortController();
  const long = runTurn({ conversation, participant, triggerMessage: conversation.messages[1], runId: "run-2", pendingMessageId: "pending-2", signal: controller.signal });
  await waitFor(() => typeof releaseLongTurn === "function", 10_000);
  controller.abort();
  const stopped = await long;
  assert.equal(stopped.status, "interrupted");
  await stopped.acknowledge?.();

  // The machine's program goes away: the hub's room says so at once.
  const chatChangeRecipients = host.chatChangeRecipients();
  host.close();
  await waitFor(() => link.presenceState("machine-1") === "out-of-touch", 10_000);

  // The machine's own change (its member's reply), as its ChatService writes
  // it: through the hub nobody is addressed, and the hub folds it into its
  // copy of the chat although the desktop is gone.
  desktopSync.stop();
  link.close();
  assert.equal(link.presenceState("machine-1"), "unknown", "without its own link this desktop knows nothing about the machine");
  assert.deepEqual(chatChangeRecipients, [], "the machine addresses nobody through the hub");
  conversation.messages.push({ id: "pending-3", role: "participant", participantId: "p1", participantLabel: "@bot", content: "", status: "pending", createdAt: new Date().toISOString() });
  await publishChat(conversation);
  // Pushed by a desktop that has since gone: the pending bubble is in the hub.
  const pendingSync = new HubSync({
    client: new HubClient({ url: hubUrl, identity: () => desktop.eventLog.getOrCreateDeviceIdentity(), storage: desktop.eventStorage }),
    storage: desktop.eventStorage, localOriginId: async () => DESKTOP_ID, trustedKey: async () => undefined,
    applyChatChange: async () => "applied", scopePrefixes: HUB_SHARED_SCOPE_PREFIXES
  });
  pendingSync.startPushing();
  await waitFor(async () => (await hubStore.eventStorage.getConversation("conv-hub"))?.messages.some((message) => message.id === "pending-3"), 10_000);
  pendingSync.stop();
  const reply = { id: "pending-3", role: "participant", participantId: "p1", participantLabel: "@bot", content: "the machine answered with the desktop away",
    status: "done", createdAt: conversation.messages.at(-1).createdAt, metadata: { runId: "run-3" } };
  const machinePayload = await machine.eventStorage.deviceEventBlobs().prepare({ version: 1, conversationId: "conv-hub", updatedAt: new Date().toISOString(),
    changes: [{ type: "message.updated", message: reply }] });
  await machine.eventLog.appendLocalEvent({ conversationId: "conv-hub", logScopeId: chatChanges.chatChangesLogScope("conv-hub"), kind: chatChanges.CHAT_CHANGES_EVENT_KIND,
    payload: machinePayload, recipients: chatChangeRecipients });
  await waitFor(async () => (await hubStore.eventStorage.getConversation("conv-hub"))?.messages.find((message) => message.id === "pending-3")?.status === "done", 10_000);
  assert.equal((await hubStore.eventStorage.getConversation("conv-hub")).messages.find((message) => message.id === "pending-3").content,
    "the machine answered with the desktop away");

  await machineSync.idle();
  sampling = false;
  await sampler;
  assert.equal(desktopMax, 0, "the desktop never kept a delivery row for the machine that reads the hub");
  assert.equal(machineMax, 0, "the machine never kept a delivery row for anyone");
  assert.equal(await outboxRows(desktop.dbPath, `device_id = '${MACHINE_ID}'`), 0);
  assert.equal(await outboxRows(machine.dbPath), 0);
  // Every event the machine wrote reached the hub.
  assert.ok((await machine.eventStorage.hub().ownEventsAfter(MACHINE_ID, 0, 1000)).length > 0);
  assert.ok(Number(await machine.eventStorage.hub().clientState("pushed-rowid")) >= await machine.eventStorage.hub().newestOwnRowid(MACHINE_ID), "the machine pushed all it wrote");
});
