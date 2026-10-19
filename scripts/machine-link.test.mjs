import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { desktopEvents, hostEvents, DESKTOP_ID, MACHINE_ID, DESKTOP_ISSUER } from "./machine-test-events.mjs";

const require = createRequire(import.meta.url);
const { createReferenceRelayServer } = require("./relay-reference-server.cjs");

test("every link message type passes the envelope validator, including picture requests", async () => {
  // The defect: machine.attachment.request/result were added to the message
  // union but not to the validator's allowlist, so both sides dropped them on
  // receipt and a member on a machine waited 30 s for a picture that never
  // came. The allowlist is now typed over the union; this pins the runtime.
  const { isMachineLinkEnvelope, MACHINE_LINK_PROTOCOL } = await import("../dist/main/shared/machineLink.js");
  const envelope = (body) => ({ protocol: MACHINE_LINK_PROTOCOL, messageId: "m1", sentAt: new Date().toISOString(), body });
  assert.equal(isMachineLinkEnvelope(envelope({ type: "machine.attachment.request", requestId: "r1", conversationId: "c1", attachmentId: "a1" })), true);
  assert.equal(isMachineLinkEnvelope(envelope({ type: "machine.attachment.result", requestId: "r1", conversationId: "c1", attachmentId: "a1", ok: true, dataBase64: "AA==" })), true);
  assert.equal(isMachineLinkEnvelope(envelope({ type: "machine.not.a.message" })), false);
});

test("the desktop answers a picture request in bounded parts, for any chat it holds", async () => {
  const { MachineLinkService } = await import("../dist/main/main/services/machineLink.js");
  const { MACHINE_ATTACHMENT_PART_BYTES } = await import("../dist/main/shared/machineLink.js");
  const picture = Buffer.alloc(MACHINE_ATTACHMENT_PART_BYTES * 2 + 12345, 7);
  const record = { id: "machine-1", name: "Box", deviceId: "", pairingKey: "rv-att", createdAt: new Date().toISOString() };
  const reads = [];
  const link = new MachineLinkService({
    listMachines: async () => [record],
    saveMachine: async () => [record],
    removeMachine: async () => [],
    getMachinePairing: async () => undefined,
    exportMachineSettingsSnapshot: async () => ({ version: 1, exportedAt: "", settingsJson: "{}", agentEnvironment: [] })
  }, { write: async () => undefined }, { ...desktopEvents, appVersion: "test", desktopDeviceId: DESKTOP_ID,
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
  assert.ok(parts.every((body) => Buffer.byteLength(body.dataBase64) < 3 * 1024 * 1024), "no part approaches the relay's 10 MiB logical-message limit once sealed");

  // Every machine holds every chat now, so a picture of a chat without a
  // member there is served too (an agent searching another chat of the project).
  await link.answerAttachmentRequest(connection, request("chat-elsewhere"));
  assert.ok(sent.some((body) => body.requestId === "r-chat-elsewhere" && body.ok));
  await link.answerAttachmentRequest(connection, request("chat-missing"));
  const refused = sent.find((body) => body.requestId === "r-chat-missing");
  assert.equal(refused.ok, false);
  assert.match(refused.error, /not on this desktop/);
  assert.deepEqual(reads.map((read) => read.conversationId), ["chat-on-box", "chat-elsewhere"], "a chat this desktop does not hold is never read");
  link.close();
});

test("approval receipts resolve only their decision and every caller retrying that decision", async () => {
  const { MachineLinkService } = await import("../dist/main/main/services/machineLink.js");
  const resolved = [], rejected = [];
  const waiter = id => ({ resolve: () => resolved.push(id), reject: error => rejected.push([id, error.message]) });
  const connection = { record: { id: "machine", name: "Machine" }, pendingApprovals: new Map([
    ["earlier", new Set([waiter("first"), waiter("retry")])], ["later", new Set([waiter("later")])]
  ]) };
  await MachineLinkService.prototype.handleBody.call({}, connection, {
    type: "machine.approval.result", conversationId: "chat", approvalId: "approval", decisionId: "earlier", ok: true
  });
  assert.deepEqual(resolved, ["first", "retry"]);
  assert.ok(connection.pendingApprovals.has("later"));
  await MachineLinkService.prototype.handleBody.call({}, connection, {
    type: "machine.approval.result", conversationId: "chat", approvalId: "approval", decisionId: "later", ok: false, error: "already answered"
  });
  assert.deepEqual(rejected, [["later", "already answered"]]);
  assert.equal(connection.pendingApprovals.size, 0);
});

test("a command queued with the machine offline survives a desktop restart and executes once with its sealed settings", async () => {
  const { MachineLinkService } = await import("../dist/main/main/services/machineLink.js");
  const { MachineHostService } = await import("../dist/main/main/services/machineHost.js");
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  const pairing = machinePairing(address.url);
  const record = { id: "machine-offline", name: "Offline test", deviceId: MACHINE_ID, pairingKey: pairing.rendezvousId, chatChanges: true,
    createdAt: new Date().toISOString(), lastHello: { publicKeyDerBase64: hostEvents.publicKeyDerBase64 } };
  let envValue = "synthetic-retained-secret";
  const settings = {
    listMachines: async () => [record], getMachinePairing: async () => pairing,
    saveMachine: async next => { Object.assign(record, next); return [record]; },
    exportMachineSettingsSnapshot: async () => ({ version: 1, exportedAt: new Date().toISOString(), settingsJson: "{}", agentEnvironment: [{ key: "TEST", value: envValue }] })
  };
  const logs = [], outcomes = [], runs = [], conversations = new Map();
  const debugLogs = { write: async (event, payload) => logs.push({ event, payload }) };
  const createLink = () => new MachineLinkService(settings, debugLogs, { ...desktopEvents, appVersion: "test", desktopDeviceId: DESKTOP_ID, reconnectDelayMs: 50 });
  let link = createLink(), host;
  try {
    await link.start();
    assert.deepEqual(link.chatActionRecipients(), [{ deviceId: MACHINE_ID, channelId: pairing.rendezvousId }],
      "artifact actions retain their offline recipient before a live hello");
    const participant = { id: "offline-member", homeMachineId: record.id, handle: "bot", kind: "codex-cli" };
    const triggerMessage = { id: "offline-message", role: "user", content: "retained", createdAt: new Date().toISOString() };
    const conversation = { id: "offline-chat", kind: "chat", title: "offline", messages: [triggerMessage], metadata: { participants: [participant] }, findings: [], createdAt: triggerMessage.createdAt, updatedAt: triggerMessage.createdAt };
    const waiting = link.runTurn({ conversation, participant, triggerMessage, runId: "offline-command", pendingMessageId: "offline-reply" });
    void waiting.catch(() => undefined);
    await waitFor(async () => Boolean(await desktopEvents.eventStorage.getChatEvent("machine-command:offline-command")), 5_000);
    const event = await desktopEvents.eventStorage.getChatEvent("machine-command:offline-command");
    assert.equal(JSON.stringify(await desktopEvents.eventStorage.deviceEventBlobs().hydrate(event.payload)).includes(envValue), false);
    assert.ok(record.pendingRuns.some(run => run.runId === "offline-command"));
    link.close();
    envValue = "a-later-settings-value";
    link = createLink(); link.onLateTerminal(async outcome => outcomes.push(outcome));
    let rejectStartedSave = true, startedApplyAttempts = 0;
    link.onRunStarted(async () => {
      startedApplyAttempts++;
      if (rejectStartedSave) throw new Error("SQLITE_FULL: cannot store the started state");
    });
    await link.start();
    let imported;
    // The chat reached the machine before (as chat change events).
    conversations.set(conversation.id, conversation);
    host = new MachineHostService({
      runMachineHostedTurn: async request => { runs.push({ id: request.runId, environment: imported.agentEnvironment[0].value }); return { messages: [], warnings: [] }; },
      cancelRun: () => true, respondToAppToolApproval: async () => undefined,
      applyReplicatedConversation: async (id, merge) => { const next = merge(conversations.get(id)); if (next) conversations.set(id, next); }
    }, { getConversation: async id => conversations.get(id) }, { importMachineSettingsSnapshot: async snapshot => { imported = snapshot; } }, debugLogs,
    { ...hostEvents, pairing, deviceId: MACHINE_ID, appVersion: "test", createClient: undefined, reconnectDelayMs: 50 });
    await host.start();
    await waitFor(() => startedApplyAttempts > 0, 10_000);
    assert.equal(await desktopEvents.eventStorage.deviceEvents().receipt("machine-started:offline-command"), undefined);
    assert.deepEqual(outcomes, [], "the terminal does not apply across a failed started-state write");
    rejectStartedSave = false;
    link.connections.get(record.id).eventChannel.start();
    await waitFor(() => outcomes.some(outcome => outcome.runId === "offline-command"), 10_000);
    assert.deepEqual(runs, [{ id: "offline-command", environment: "synthetic-retained-secret" }]);
    assert.equal(outcomes.find(outcome => outcome.runId === "offline-command").status, "completed");
    await waitFor(() => !record.pendingRuns.some(run => run.runId === "offline-command"), 5_000);
    assert.ok(!logs.some(entry => entry.event === "machine-link.turn.queried" && entry.payload.runId === "offline-command"));
  } finally { link.close(); host?.close(); await relay.close(); }
});

test("a machine still on a runtime that cannot receive chat changes is sent no turn, and its chat changes are kept for it", async () => {
  const { MachineLinkService } = await import("../dist/main/main/services/machineLink.js");
  const pairing = machinePairing("ws://unused/v1/relay");
  const capable = { id: "machine-new", name: "New box", deviceId: "device-new", pairingKey: "room-new", chatChanges: true, createdAt: new Date().toISOString() };
  const outdated = { id: "machine-old", name: "Old box", deviceId: MACHINE_ID, pairingKey: pairing.rendezvousId, createdAt: new Date().toISOString(),
    lastHello: { publicKeyDerBase64: hostEvents.publicKeyDerBase64 } };
  const logs = [];
  const link = new MachineLinkService({
    listMachines: async () => [capable, outdated], getMachinePairing: async () => pairing,
    saveMachine: async () => [capable, outdated],
    exportMachineSettingsSnapshot: async () => ({ version: 1, exportedAt: "", settingsJson: "{}", agentEnvironment: [] })
  }, { write: async (event, payload) => logs.push({ event, payload }) }, { ...desktopEvents, appVersion: "test", desktopDeviceId: DESKTOP_ID,
    createClient: () => ({ on() {}, connect: async () => undefined, close() {}, sendCiphertext: async () => [] }) });
  // Before any machine connects, every enrolled one is known, and is a
  // recipient whatever its runtime: what it cannot read yet is kept for it.
  await link.loadMachines();
  assert.deepEqual(link.chatChangeRecipients().map((recipient) => recipient.deviceId).sort(), ["device-new", MACHINE_ID].sort());
  assert.deepEqual(link.chatActionRecipients().map((recipient) => recipient.deviceId).sort(), ["device-new", MACHINE_ID].sort());
  await link.start();
  try {
    const participant = { id: "old-member", homeMachineId: outdated.id, handle: "bot", kind: "codex-cli" };
    const triggerMessage = { id: "old-message", role: "user", content: "hello", createdAt: new Date().toISOString() };
    const conversation = { id: "old-chat", kind: "chat", title: "old", messages: [triggerMessage], metadata: { participants: [participant] }, findings: [],
      createdAt: triggerMessage.createdAt, updatedAt: triggerMessage.createdAt };
    const result = await link.runTurn({ conversation, participant, triggerMessage, runId: "old-run", pendingMessageId: "old-reply" });
    assert.equal(result.status, "failed");
    assert.equal(result.sent, false, "the desktop settles it");
    assert.match(result.error, /@bot is hosted on Old box, which still runs an older version of AccordAgents/);
    assert.equal(await desktopEvents.eventStorage.getChatEvent("machine-command:old-run"), undefined, "nothing was queued for it");
    assert.ok(logs.some((entry) => entry.event === "machine-link.turn.runtime-outdated"));
  } finally { link.close(); }
});

// Machines transport: desktop MachineLinkService <-> machine MachineHostService
// through the reference relay, sealed with a machine-host pairing.
test("machine link sends settings, chats as change events, runs a turn, streams progress, and cancels", async () => {
  const { MachineLinkService } = await import("../dist/main/main/services/machineLink.js");
  const { MachineHostService } = await import("../dist/main/main/services/machineHost.js");
  const chatChanges = await import("../dist/main/main/services/chatChanges.js");
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  const capturedLogs = [];
  try {
    const pairing = machinePairing(address.url);
    const record = { id: "machine-1", name: "Test box", deviceId: "", pairingKey: pairing.rendezvousId, createdAt: new Date().toISOString() };
    let rejectRunRecord;
    let holdRunRecord;
    let releaseRunRecord;
    const desktopSettings = {
      listMachines: async () => [record],
      saveMachine: async (next) => {
        if (rejectRunRecord && next.pendingRuns?.some((run) => run.runId === rejectRunRecord)) {
          throw new Error("ENOSPC: cannot store the run intent");
        }
        if (holdRunRecord && next.pendingRuns?.some((run) => run.runId === holdRunRecord)) {
          holdRunRecord = undefined;
          await new Promise((resolve) => { releaseRunRecord = resolve; });
        }
        Object.assign(record, next); return [record];
      },
      removeMachine: async () => [],
      getMachinePairing: async (key) => (key === pairing.rendezvousId ? pairing : undefined),
      exportMachineSettingsSnapshot: async () => {
        if (settingsDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, settingsDelayMs));
        }
        return { version: 1, exportedAt: new Date().toISOString(), settingsJson: JSON.stringify({ chatRoleConfigs: [{ id: "engineer" }] }), agentEnvironment: [{ key: "GH_TOKEN", value: "secret" }] };
      }
    };
    const logs = capturedLogs;
    let settingsDelayMs = 0;
    const debugLogs = { write: async (event, payload) => { logs.push({ event, payload, at: Date.now() }); } };
    // What the desktop's ChatService does on every save: the chat's changes as
    // one signed event for every enrolled machine, and the head a turn names.
    const chatBaselines = new Map();
    const chatHeads = new Map();
    const link = new MachineLinkService(desktopSettings, debugLogs, { ...desktopEvents, appVersion: "test", desktopDeviceId: DESKTOP_ID, reconnectDelayMs: 50,
      chatChangeHead: async (id) => ({ originId: DESKTOP_ID, logScopeId: chatChanges.chatChangesLogScope(id), originSeq: chatHeads.get(id) ?? 0 }) });
    const publishChat = async (conversation) => {
      const { changes } = chatChanges.diffChatChanges(chatBaselines.get(conversation.id), conversation, { emitsConversationFields: true, ownsMessage: () => true });
      if (!changes.length) return;
      const payload = await desktopEvents.eventStorage.deviceEventBlobs().prepare({ version: 1, conversationId: conversation.id, updatedAt: conversation.updatedAt, changes });
      const { event } = await desktopEvents.eventLog.appendLocalEvent({ conversationId: conversation.id, logScopeId: chatChanges.chatChangesLogScope(conversation.id),
        kind: chatChanges.CHAT_CHANGES_EVENT_KIND, payload, recipients: link.chatActionRecipients() });
      chatBaselines.set(conversation.id, chatChanges.chatChangeBaseline(JSON.parse(JSON.stringify(conversation))));
      chatHeads.set(conversation.id, event.originSeq);
      link.nudgeEventChannels();
    };
    const dispatchTurn = link.runTurn.bind(link);
    const runTurn = async (request) => { await publishChat(request.conversation); return dispatchTurn(request); };

    const machineStore = new Map();
    const importedSnapshots = [];
    const hostRuns = [];
    const messagesAtStart = new Map();
    const triggerAtStart = new Map();
    const approvalRequests = [];
    let failNextApplyContaining;
    let releaseLongTurn;
    const hostChat = {
      runMachineHostedTurn: async (request, signal, progress) => {
        hostRuns.push(request);
        messagesAtStart.set(request.runId, machineStore.get(request.conversationId)?.messages.length);
        triggerAtStart.set(request.runId, machineStore.get(request.conversationId)?.messages.find(message => message.id === request.messageId)?.content);
        // A large progress frame right before a small finished result: the desktop must apply them in order.
        progress?.({ runId: request.runId, phase: "debate", message: "working " + "x".repeat(request.messageId === "msg-1" ? 2_000_000 : 10), createdAt: new Date().toISOString() });
        if (request.messageId === "msg-fail") {
          throw new Error("provider exploded");
        }
        if (request.messageId === "msg-long" || request.messageId === "msg-away") {
          await new Promise((resolve) => { releaseLongTurn = resolve; signal?.addEventListener("abort", resolve, { once: true }); });
          if (signal?.aborted) {
            return { messages: [], warnings: [] };
          }
        }
        const conversation = machineStore.get(request.conversationId);
        const reply = { id: request.pendingMessageId, role: "participant", participantId: request.participantId, participantLabel: "@bot", content: `reply to ${request.messageId}`, createdAt: new Date().toISOString(), status: "done", metadata: { runId: request.runId } };
        conversation.messages.push(reply);
        return { messages: [reply], warnings: ["w1"] };
      },
      cancelRun: () => true,
      applyReplicatedConversation: async (id, merge) => {
        const next = merge(machineStore.get(id));
        if (next && failNextApplyContaining && next.messages.some((message) => message.id === failNextApplyContaining)) {
          failNextApplyContaining = undefined;
          throw new Error("SQLITE_FULL: disk is full");
        }
        if (next) machineStore.set(id, next);
      },
      respondToAppToolApproval: async (request, _progress, execution) => {
        approvalRequests.push(request);
        if (request.approvalId === "approval-bad") {
          throw new Error("decision rejected by the native session");
        }
        const conversation = machineStore.get(request.conversationId);
        await execution?.beforeApply({ id: request.approvalId, requesterParticipantId: conversation.metadata.participants[0].id });
        const next = { ...conversation, metadata: { ...conversation.metadata, pendingAppToolApprovals: [{ id: request.approvalId, status: "approved", updatedAt: new Date().toISOString() }] } };
        machineStore.set(request.conversationId, next);
        return next;
      }
    };
    const hostStorage = {
      getConversation: async (id) => machineStore.get(id),
      saveConversation: async (conversation) => { machineStore.set(conversation.id, conversation); return conversation.id; }
    };
    const hostSettings = { importMachineSettingsSnapshot: async (snapshot) => { importedSnapshots.push(snapshot); } };
    const host = new MachineHostService(hostChat, hostStorage, hostSettings, debugLogs, {
      ...hostEvents,
      chatActions: {
        handles: event => event.kind === "permission.decided",
        apply: async (event, payload) => {
          await host.applyApprovalAction(event, payload ?? event.payload);
          return { status: "applied", kind: event.kind, targetKey: (payload ?? event.payload).targetKey };
        }
      },
      pairing,
      deviceId: MACHINE_ID,
      machineName: "test-box",
      appVersion: "test",
      detectProviders: async () => [{ kind: "codex-cli", label: "Codex", installed: true, version: "0.153.4" }],
      reconnectDelayMs: 50,
      applyChatChanges: async (event, payload) => {
        const result = chatChanges.applyChatChanges(machineStore.get(payload.conversationId), payload, event.originId,
          { acceptsConversationFields: () => true, acceptsMessageUpdate: () => true, acceptsMessageCreate: () => true, acceptsMessageRemoval: () => true, holdsUnknownChats: true });
        if (result.status !== "applied") return "missing-conversation";
        if (failNextApplyContaining && result.conversation.messages.some((message) => message.id === failNextApplyContaining)) {
          failNextApplyContaining = undefined;
          throw new Error("SQLITE_FULL: disk is full");
        }
        machineStore.set(payload.conversationId, result.conversation);
        return "applied";
      }
    });

    await link.start();
    await host.start();
    await waitFor(() => link.status()[0]?.connected === true, 5_000);
    await waitFor(() => record.lastHello?.machineName === "test-box", 5_000);
    assert.equal(record.deviceId, MACHINE_ID);
    await waitFor(() => importedSnapshots.length >= 1, 5_000);

    const participant = { id: "p1", handle: "bot", roleConfigId: "engineer", kind: "codex-cli", homeMachineId: "machine-1" };
    const conversation = {
      id: "conv-1", kind: "chat", title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      messages: [{ id: "msg-1", role: "user", content: "hi", createdAt: new Date().toISOString(), status: "done" }],
      metadata: { participants: [participant], participantSessions: [{ participantId: "p1", sessionId: "desktop-session" }], activeRunIds: ["run-1"] },
      findings: []
    };
    const progressSeen = [];
    rejectRunRecord = "run-no-store";
    const refused = await runTurn({ conversation, participant, triggerMessage: conversation.messages[0], runId: rejectRunRecord, pendingMessageId: "pending-no-store" });
    assert.equal(refused.status, "failed");
    assert.match(refused.error, /ENOSPC/);
    assert.ok(!hostRuns.some((run) => run.runId === rejectRunRecord), "a failed intent write must never start a provider turn");
    rejectRunRecord = undefined;
    holdRunRecord = "run-cancel-before-store";
    const preparingController = new AbortController();
    const preparing = runTurn({ conversation, participant, triggerMessage: conversation.messages[0], runId: holdRunRecord, pendingMessageId: "pending-before-store", signal: preparingController.signal });
    await waitFor(() => typeof releaseRunRecord === "function", 5_000);
    assert.ok(!hostRuns.some((run) => run.runId === "run-cancel-before-store"));
    preparingController.abort();
    releaseRunRecord();
    assert.equal((await preparing).status, "interrupted");
    assert.ok(!hostRuns.some((run) => run.runId === "run-cancel-before-store"));
    assert.ok(!(record.pendingRuns ?? []).some((run) => run.runId === "run-cancel-before-store"));
    const result = await runTurn({
      conversation, participant, triggerMessage: conversation.messages[0], runId: "run-1", pendingMessageId: "pending-1",
      progress: (progress) => progressSeen.push(progress)
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(result.warnings, ["w1"]);
    assert.equal(result.messages[0].id, "pending-1");
    assert.equal(result.messages[0].content, "reply to msg-1");
    assert.equal(progressSeen.length, 1);
    assert.equal(hostRuns[0].pendingMessageId, "pending-1");
    // The machine keeps a result until the desktop has stored it and acknowledges.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(!logs.some((entry) => entry.event === "machine-host.terminal.acked" && entry.payload?.runId === "run-1"), "no ack before the desktop stored the result");
    await result.acknowledge();
    await waitFor(() => logs.some((entry) => entry.event === "machine-host.terminal.acked" && entry.payload?.runId === "run-1"), 5_000);

    // Approval decisions carry the whole card answer and resolve with the machine's outcome,
    // after the desktop stored the machine's view of the card.
    const storedApprovals = [];
    link.onApproval(async (event) => { await new Promise((resolve) => setTimeout(resolve, 50)); storedApprovals.push(event.approval); });
    let queued = false;
    await link.respondToMachineApproval({ machineId: "machine-1", conversationId: "conv-1", approvalId: "approval-1", approve: true, scope: "once", draftOverride: { kind: "edited" }, codexDecisionId: "decision-7",
      onQueued: async () => { queued = true; } });
    assert.equal(queued, true);
    assert.equal(approvalRequests.length, 1);
    assert.ok(storedApprovals.length >= 1, "the card call returns only after the stored approval");
    assert.ok(storedApprovals.every((approval) => approval.status === "approved"));
    assert.deepEqual(approvalRequests[0].draftOverride, { kind: "edited" });
    assert.equal(approvalRequests[0].codexDecisionId, "decision-7");
    await assert.rejects(
      () => link.respondToMachineApproval({ machineId: "machine-1", conversationId: "conv-1", approvalId: "approval-bad", approve: false }),
      /rejected by the native session/
    );
    // The machine keeps its own run bookkeeping and sessions, not the desktop's.
    const copy = machineStore.get("conv-1");
    assert.equal(copy.metadata.activeRunIds, undefined);
    assert.deepEqual(copy.metadata.participantSessions ?? [], [], "the desktop's own sessions never travel");
    assert.equal(copy.messages.length, 2);

    // Second turn: only the new message travels as a change and lands in the copy.
    conversation.messages.push({ id: "msg-2", role: "user", content: "again", createdAt: new Date().toISOString(), status: "done" });
    const second = await runTurn({ conversation, participant, triggerMessage: conversation.messages[1], runId: "run-2", pendingMessageId: "pending-2" });
    assert.equal(second.status, "completed");
    await second.acknowledge?.();
    assert.ok(machineStore.get("conv-1").messages.some((message) => message.id === "msg-2"));
    assert.equal(importedSnapshots.length, 3, "settings arrive on introduction and admitted requests, not failed or cancelled preparation");

    // Cancel: the desktop aborts, the machine's turn signal fires, the result is interrupted.
    conversation.messages.push({ id: "msg-long", role: "user", content: "slow", createdAt: new Date().toISOString(), status: "done" });
    const controller = new AbortController();
    const pendingLong = runTurn({ conversation, participant, triggerMessage: conversation.messages[2], runId: "run-3", pendingMessageId: "pending-3", signal: controller.signal });
    await waitFor(() => hostRuns.length === 3 && typeof releaseLongTurn === "function", 5_000);
    controller.abort();
    const third = await pendingLong;
    assert.equal(third.status, "interrupted");
    await third.acknowledge?.();

    // Stop before dispatch: an already-cancelled turn never reaches the machine.
    const runsBefore = hostRuns.length;
    const preAborted = new AbortController();
    preAborted.abort();
    const early = await runTurn({ conversation, participant, triggerMessage: conversation.messages[0], runId: "run-early", pendingMessageId: "pending-early", signal: preAborted.signal });
    assert.equal(early.status, "interrupted");
    // Stop during preparation (settings/replication in flight): same outcome.
    const midPrep = new AbortController();
    const midPrepTurn = runTurn({ conversation, participant, triggerMessage: conversation.messages[0], runId: "run-midprep", pendingMessageId: "pending-midprep", signal: midPrep.signal });
    midPrep.abort();
    assert.equal((await midPrepTurn).status, "interrupted");
    assert.equal(hostRuns.length, runsBefore, "cancelled turns are not dispatched");

    // A large chat travels as one change event in bounded fragments and arrives whole.
    const big = {
      id: "conv-big", kind: "chat", title: "Big", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      metadata: { participants: [participant] },
      messages: Array.from({ length: 400 }, (_, index) => ({ id: `big-${index}`, role: "user", content: "x".repeat(10_000), createdAt: new Date(Date.now() + index).toISOString(), status: "done" })),
      findings: []
    };
    const bigResult = await runTurn({ conversation: big, participant, triggerMessage: big.messages[399], runId: "run-big", pendingMessageId: "pending-big" });
    assert.equal(bigResult.status, "completed");
    await bigResult.acknowledge?.();
    assert.equal(machineStore.get("conv-big").messages.length, 401);

    // A member on the machine asked other members to answer. The machine does
    // not run them: the desktop does, where the roster and every member's home
    // are known. Asking twice is one delegation, not two runs.
    const delegations = [];
    const stopDelegationListener = link.onParticipantRequest((request) => { delegations.push(request); });
    await host.delegateParticipantRequest({ conversationId: "conv-1", requestMessageId: "request-1", batchId: "batch-1", depth: 2 });
    await host.delegateParticipantRequest({ conversationId: "conv-1", requestMessageId: "request-1", batchId: "batch-1", depth: 2 });
    await waitFor(() => delegations.length > 0, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(delegations.length, 1, "one request message is one delegation on the desktop");
    assert.equal(delegations[0].machineId, "machine-1");
    assert.equal(delegations[0].conversationId, "conv-1");
    assert.equal(delegations[0].requestMessageId, "request-1");
    assert.equal(delegations[0].depth, 2);
    stopDelegationListener();

    // A reply finished while the desktop was away is delivered on reconnect,
    // stored through the late-terminal listener, and acknowledged only then.
    const lateTerminals = [];
    let lateStoreDelay = 0;
    link.onLateTerminal(async (event) => { await new Promise((resolve) => setTimeout(resolve, lateStoreDelay)); lateTerminals.push({ ...event, storedAt: Date.now() }); });
    conversation.messages.push({ id: "msg-away", role: "user", content: "away", createdAt: new Date().toISOString(), status: "done" });
    releaseLongTurn = undefined;
    const awayTurn = runTurn({ conversation, participant, triggerMessage: conversation.messages[3], runId: "run-away", pendingMessageId: "pending-away" });
    await waitFor(() => hostRuns.length === runsBefore + 2 && typeof releaseLongTurn === "function", 5_000);
    await link.disconnectMachine("machine-1");
    await awayTurn.catch(() => undefined);
    await waitFor(() => logs.some((entry) => entry.event === "machine-host.desktop.away"), 5_000);
    releaseLongTurn();
    await waitFor(async () => (await hostEvents.eventStorage.deviceEvents().listPending(pairing.rendezvousId))
      .some(entry => entry.event.kind === "machine.turn.finished" && entry.event.payload.runId === "run-away"), 5_000);
    lateStoreDelay = 150;
    await link.connectMachine(record);
    await waitFor(() => lateTerminals.some((event) => event.runId === "run-away" && event.status === "completed"), 5_000);
    const awayEvent = lateTerminals.find((event) => event.runId === "run-away");
    assert.ok(awayEvent.messages.some((message) => message.id === "pending-away"));
    await waitFor(() => logs.some((entry) => entry.event === "machine-host.terminal.acked" && entry.payload?.runId === "run-away"), 5_000);
    const ackedAt = Date.parse(logs.find((entry) => entry.event === "machine-host.terminal.acked" && entry.payload?.runId === "run-away").payload?.at ?? "") || Date.now();
    assert.ok(ackedAt >= awayEvent.storedAt, "the ack follows the stored late result");
    lateStoreDelay = 0;

    // A turn that fails while the desktop is away is stored as a failure on reconnect, not acknowledged silently.
    conversation.messages.push({ id: "msg-fail", role: "user", content: "boom", createdAt: new Date().toISOString(), status: "done" });
    await link.disconnectMachine("machine-1");
    await waitFor(() => logs.some((entry) => entry.event === "machine-host.desktop.away"), 5_000);
    await link.connectMachine(record);
    await waitFor(() => link.status()[0]?.connected === true, 5_000);
    const failTurn = await runTurn({ conversation, participant, triggerMessage: conversation.messages[conversation.messages.length - 1], runId: "run-fail", pendingMessageId: "pending-fail" });
    assert.equal(failTurn.status, "failed");
    assert.match(failTurn.error, /provider exploded/);
    await failTurn.acknowledge?.();

    // When a machine asks for a copy again, the desktop serves its current state.
    const loadable = new Map([["conv-1", conversation]]);
    link.setConversationLoader(async (id) => loadable.get(id));

    // A chat change that cannot be stored on the machine is retried; the turn
    // that names it waits until it is stored, and never runs on stale rows.
    conversation.messages.push({ id: "msg-edit", role: "user", content: "edited instruction", createdAt: new Date().toISOString(), status: "done" });
    failNextApplyContaining = "msg-edit";
    const staleTurn = await runTurn({ conversation, participant, triggerMessage: conversation.messages[conversation.messages.length - 1], runId: "run-stale", pendingMessageId: "pending-stale" });
    assert.equal(staleTurn.status, "completed", "the request runs once the change it names is stored");
    assert.equal(triggerAtStart.get("run-stale"), "edited instruction", "the provider sees the repaired instruction, never stale rows");
    await staleTurn.acknowledge?.();
    await waitFor(() => machineStore.get("conv-1")?.messages.some((message) => message.id === "msg-edit"), 10_000);
    const repairedTurn = await runTurn({ conversation, participant, triggerMessage: conversation.messages[conversation.messages.length - 1], runId: "run-repaired", pendingMessageId: "pending-repaired" });
    assert.equal(repairedTurn.status, "completed");
    await repairedTurn.acknowledge?.();

    // A hello that arrives while a turn is still being prepared must not close it:
    // the machine is asked only about turns whose request has left.
    settingsDelayMs = 400;
    const racedTurn = runTurn({ conversation, participant, triggerMessage: conversation.messages[0], runId: "run-raced", pendingMessageId: "pending-raced" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    host.client.close();
    await host.client.connect(); // the machine's hello lands during the desktop's preparation
    const raced = await racedTurn;
    settingsDelayMs = 0;
    assert.equal(raced.status, "completed", "a turn in preparation survives a hello");
    await raced.acknowledge?.();
    // A query may still be sent once the request has left (the machine simply holds the run and stays silent);
    // what must never happen is a close from an answer to a pre-dispatch query.
    assert.ok(!logs.some((entry) => entry.event === "machine-link.turn.unknown" && entry.payload?.runId === "run-raced" && entry.payload?.dispatched === true), "no lost-run close for a turn the machine holds");

    // A large chat whose change fails to store the first time is retried whole;
    // the member starts only on the complete chat.
    const bigger = { ...big, id: "conv-bigger", messages: big.messages.map((message) => ({ ...message, id: message.id.replace("big-", "bigger-") })) };
    loadable.set("conv-bigger", bigger);
    failNextApplyContaining = "bigger-200";
    const biggerResult = await runTurn({ conversation: bigger, participant, triggerMessage: bigger.messages[399], runId: "run-bigger", pendingMessageId: "pending-bigger" });
    assert.equal(biggerResult.status, "completed", "the failed change is retried before the turn may run");
    assert.equal(messagesAtStart.get("run-bigger"), 400, "the provider cannot start against a partial copy");
    assert.equal(hostRuns.filter((run) => run.runId === "run-bigger").length, 1);
    await biggerResult.acknowledge?.();
    assert.equal(machineStore.get("conv-bigger")?.messages.length, 401);
    const retried = await runTurn({ conversation: bigger, participant, triggerMessage: bigger.messages[399], runId: "run-bigger-2", pendingMessageId: "pending-bigger-2" });
    assert.equal(retried.status, "completed");
    await retried.acknowledge?.();

    // Rule 2: a Stop while the machine is unreachable is held and shown as
    // waiting, delivered when the machine is back, and confirmed only then.
    const stopsWaiting = [];
    releaseLongTurn = undefined;
    const heldController = new AbortController();
    const heldTurn = runTurn({ conversation, participant, triggerMessage: conversation.messages[2], runId: "run-held", pendingMessageId: "pending-held", signal: heldController.signal, onStopPending: (name) => stopsWaiting.push(name) });
    await waitFor(() => typeof releaseLongTurn === "function", 5_000);
    host.client.close(); // the machine's own link drops (network blip); the turn keeps running there
    await waitFor(() => link.status()[0]?.connected === false, 5_000);
    heldController.abort();
    await waitFor(() => stopsWaiting.length === 1, 5_000);
    assert.equal(stopsWaiting[0], "Test box");
    await host.client.connect(); // the machine is back: hello, the stop is redelivered, the machine confirms
    const held = await heldTurn;
    assert.equal(held.status, "interrupted");

    // A desktop restart: the machine record remembers dispatched runs, the new desktop
    // asks about them, a result the machine still holds lands as a late result, and a
    // run the machine does not know is closed instead of staying pending forever.
    releaseLongTurn = undefined;
    const survivingTurn = runTurn({ conversation, participant, triggerMessage: conversation.messages[2], runId: "run-survives", pendingMessageId: "pending-survives" });
    await waitFor(() => hostRuns.some((run) => run.runId === "run-survives") && typeof releaseLongTurn === "function", 5_000);
    assert.ok((record.pendingRuns ?? []).some((run) => run.runId === "run-survives"), "the dispatched run is recorded durably");
    link.close(); // the desktop goes away mid-turn
    void survivingTurn.catch(() => undefined);
    record.pendingRuns = [...(record.pendingRuns ?? []), { runId: "run-forgotten", conversationId: "conv-1" }];
    const link2 = new MachineLinkService(desktopSettings, debugLogs, { ...desktopEvents, appVersion: "test", desktopDeviceId: DESKTOP_ID, reconnectDelayMs: 50 });
    const lateAfterRestart = [];
    link2.onLateTerminal(async (event) => { lateAfterRestart.push(event); });
    await link2.start();
    await waitFor(() => link2.status()[0]?.connected === true, 5_000);
    await waitFor(() => lateAfterRestart.some((event) => event.runId === "run-forgotten" && event.status === "failed"), 5_000);
    releaseLongTurn();
    await waitFor(() => lateAfterRestart.some((event) => event.runId === "run-survives" && event.status === "completed"), 5_000);
    await waitFor(() => !(record.pendingRuns ?? []).some((run) => run.runId === "run-survives" || run.runId === "run-forgotten"), 5_000);
    link2.close();
    await link.connectMachine(record);
    await waitFor(() => link.status()[0]?.connected === true, 5_000);

    // A machine restart closes the turns it lost instead of leaving them pending.
    releaseLongTurn = undefined;
    const lostTurn = runTurn({ conversation, participant, triggerMessage: conversation.messages[2], runId: "run-lost", pendingMessageId: "pending-lost" });
    await waitFor(() => typeof releaseLongTurn === "function", 5_000);
    host.close();
    await Promise.allSettled([...host.turnTasks]);
    // This fixture has no native OS process. Its terminated stub supplies the
    // verified release; machine-command.test exercises the real registry gate.
    const oldExecutor = await hostEvents.eventStorage.nativeCommands().executor("conv-1", "p1");
    await hostEvents.eventStorage.nativeCommands().releaseVerifiedExecutor(oldExecutor);
    const host2 = new MachineHostService(hostChat, hostStorage, hostSettings, debugLogs, {
      ...hostEvents, pairing, deviceId: MACHINE_ID, machineName: "test-box", appVersion: "test", detectProviders: async () => [], reconnectDelayMs: 50,
      // An outbox that cannot be written: results stay in memory and the desktop is told.
      outboxPath: "/dev/null/machine-outbox.json"
    });
    await host2.start();
    const lost = await lostTurn;
    assert.equal(lost.status, "failed");
    assert.match(lost.error, /outcome is uncertain.*not run again/);
    assert.equal(hostRuns.filter(run => run.runId === "run-lost").length, 1, "a claimed command is never replayed after a runtime restart");

    // A native continuation owned by ChatService can outlive the host wrapper:
    // Stop still reaches that owner, and confirms only after it has returned.
    const unknownController = new AbortController();
    const unknownTurn = runTurn({ conversation, participant, triggerMessage: conversation.messages[2], runId: "run-unknown", pendingMessageId: "pending-unknown", signal: unknownController.signal });
    await waitFor(() => hostRuns.some((run) => run.runId === "run-unknown"), 5_000);
    const nativeController = host2.activeTurns.get("run-unknown");
    host2.activeTurns.delete("run-unknown");
    hostChat.cancelRun = runId => { if (runId !== "run-unknown") return false; nativeController.abort(); return true; };
    unknownController.abort();
    const unknown = await unknownTurn;
    assert.equal(unknown.status, "interrupted");
    await unknown.acknowledge?.();
    await waitFor(() => (record.pendingCancels ?? []).length === 0, 5_000);
    // The failed outbox write is visible on the desktop as a machine warning.
    await waitFor(() => /outbox/.test(link.status()[0]?.warning ?? ""), 5_000);
    host2.close();

    link.close();
    host.close();
  } catch (error) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync("/tmp/link-logs.json", JSON.stringify(capturedLogs, null, 1));
    throw error;
  } finally {
    await relay.close();
  }
});

test("outgoing commands preserve order and Stop fences dispatch even when a write fails", async () => {
  const { MachineLinkService } = await import("../dist/main/main/services/machineLink.js");
  const { openMachineRelayPayload } = await import("../dist/main/main/services/machineRelaySealing.js");
  const pairing = machinePairing("ws://unused/v1/relay");
  const record = { id: "machine-fence", name: "Fence box", pairingKey: pairing.rendezvousId, chatChanges: true, createdAt: new Date().toISOString() };
  const writes = [];
  let onWrite = async () => undefined;
  let onSave = () => undefined;
  const client = {
    on() {}, connect: async () => undefined, close() {},
    sendCiphertext: async ({ ciphertext }) => {
      const envelope = await openMachineRelayPayload(ciphertext, hostEvents.identity, [desktopEvents.identity.publicKeyDerBase64], pairing.rendezvousId);
      writes.push(envelope.body);
      await onWrite(envelope.body);
    }
  };
  const link = new MachineLinkService({
    listMachines: async () => [record], getMachinePairing: async () => pairing,
    saveMachine: async (next) => { Object.assign(record, next); onSave(next); return [record]; },
    exportMachineSettingsSnapshot: async () => ({ version: 1, exportedAt: "", settingsJson: "{}", agentEnvironment: [] })
  }, { write: async () => undefined }, { ...desktopEvents, appVersion: "test", desktopDeviceId: "desktop-fence", createClient: () => client });
  await link.start();
  const connection = link.connections.get(record.id);
  connection.machineDeviceId = MACHINE_ID;
  connection.record.lastHello = { publicKeyDerBase64: hostEvents.identity.publicKeyDerBase64 };
  // This probe isolates the native dispatch fence after an already completed
  // copy; the real SQLite event channel is exercised by the link probe above.
  connection.eventChannel = { publish: async ({ payload }) => { writes.push(payload); await onWrite(payload); }, flush: async () => undefined, close() {} };
  connection.settingsSynced = true;
  try {
    let releaseWrite;
    onWrite = async () => { await new Promise((resolve) => { releaseWrite = resolve; }); };
    const first = link.send(connection, { type: "machine.settings.sync", snapshot: { version: 1, exportedAt: "", settingsJson: "x".repeat(2_000_000), agentEnvironment: [] } });
    await waitFor(() => Boolean(releaseWrite), 5_000);
    const second = link.send(connection, { type: "machine.hello.request", desktopDeviceId: "desktop-fence" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(writes.length, 1, "a later small command cannot overtake an unfinished large write");
    onWrite = async () => undefined;
    releaseWrite();
    await Promise.all([first, second]);
    assert.deepEqual(writes.map((body) => body.type), ["machine.settings.sealed", "machine.hello.request"]);

    const participant = { id: "p", handle: "bot", roleConfigId: "r", kind: "codex-cli", homeMachineId: record.id };
    const triggerMessage = { id: "m", role: "user", content: "test", createdAt: new Date().toISOString() };
    const conversation = { id: "c", kind: "chat", title: "", createdAt: "", updatedAt: "", messages: [triggerMessage], metadata: { participants: [participant] }, findings: [] };
    let releaseQueue;
    onSave = (next) => {
      if (next.pendingRuns?.some((run) => run.runId === "queued") && !releaseQueue) {
        connection.outbound = new Promise((resolve) => { releaseQueue = resolve; });
      }
    };
    const queuedStop = new AbortController();
    const queued = link.runTurn({ conversation, participant, triggerMessage, runId: "queued", pendingMessageId: "pq", signal: queuedStop.signal });
    await waitFor(() => Boolean(releaseQueue), 5_000);
    queuedStop.abort();
    releaseQueue();
    assert.equal((await queued).status, "interrupted");
    assert.ok(!writes.some((body) => body.type === "machine.turn.request" && body.runId === "queued"));
    assert.ok(!record.pendingRuns.some((run) => run.runId === "queued"));

    onSave = () => undefined;
    const ambiguousStop = new AbortController();
    onWrite = async (body) => {
      if (body.type === "machine.turn.request") {
        ambiguousStop.abort();
        throw new Error("write failed after the frame may have left");
      }
    };
    const ambiguous = await link.runTurn({ conversation, participant, triggerMessage, runId: "ambiguous", pendingMessageId: "pa", signal: ambiguousStop.signal });
    assert.equal(ambiguous.status, "failed");
    await waitFor(() => writes.some((body) => body.type === "machine.turn.cancel" && body.runId === "ambiguous"), 5_000);
    assert.ok(record.pendingCancels.some((run) => run.runId === "ambiguous"), "an ambiguous dispatch retains Stop until the machine confirms");
    assert.deepEqual(writes.filter((body) => body.runId === "ambiguous").map((body) => body.type), ["machine.turn.request", "machine.turn.cancel"]);
  } finally {
    link.close();
  }
});

test("a damaged outbox that cannot be set aside is never overwritten", async () => {
  const { MachineHostService } = await import("../dist/main/main/services/machineHost.js");
  const { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = mkdtempSync(path.join(os.tmpdir(), "machine-outbox-"));
  const file = path.join(dir, "machine-outbox.json");
  writeFileSync(file, "{not json", "utf8");
  chmodSync(dir, 0o500); // the damaged file cannot be renamed or copied within its directory
  const logs = [];
  const stubClient = { on: () => () => undefined, connect: async () => undefined, close: () => undefined, sendCiphertext: async () => [] };
  try {
    const host = new MachineHostService(
      { runMachineHostedTurn: async () => ({ messages: [], warnings: [] }), cancelRun: () => true, respondToAppToolApproval: async () => undefined, applyReplicatedConversation: async () => undefined },
      { getConversation: async () => undefined },
      { importMachineSettingsSnapshot: async () => undefined },
      { write: async (event, payload) => { logs.push({ event, payload }); } },
      { ...hostEvents, pairing: machinePairing("ws://127.0.0.1:1/v1/relay"), deviceId: "device-x", appVersion: "test", outboxPath: file, createClient: () => stubClient }
    );
    assert.ok(logs.some((entry) => entry.event === "machine-host.outbox.corrupt-preserve-failed"));
    // A later write must refuse rather than destroy the damaged bytes.
    host.persistOutbox();
    assert.equal(readFileSync(file, "utf8"), "{not json");
    assert.ok(logs.some((entry) => entry.event === "machine-host.outbox.write-skipped"));
    host.close();
  } finally {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("machineActivity asks the machine afresh: a turn that started or ended since its last hello is seen", async () => {
  // The hello a machine sends when it connects is a snapshot; a desktop that
  // decides to upgrade (drain) the runtime from it would cut short a turn
  // that started since, or wait for one that ended since.
  const { MachineLinkService, machineActivityIsBusy } = await import("../dist/main/main/services/machineLink.js");
  const { MachineHostService } = await import("../dist/main/main/services/machineHost.js");
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  let host;
  try {
    const pairing = machinePairing(address.url);
    const record = { id: "machine-act", name: "Act box", deviceId: "", pairingKey: pairing.rendezvousId, createdAt: new Date().toISOString() };
    const logs = [];
    const debugLogs = { write: async (event, payload) => logs.push({ event, payload }) };
    const link = new MachineLinkService({
      listMachines: async () => [record], saveMachine: async (next) => { Object.assign(record, next); return [record]; }, removeMachine: async () => [],
      getMachinePairing: async (key) => (key === pairing.rendezvousId ? pairing : undefined),
      exportMachineSettingsSnapshot: async () => ({ version: 1, exportedAt: new Date().toISOString(), settingsJson: "{}", agentEnvironment: [] })
    }, debugLogs, { ...desktopEvents, appVersion: "desktop-v", desktopDeviceId: DESKTOP_ID, reconnectDelayMs: 50 });
    const conversations = new Map();
    let releaseTurn;
    const hostRuns = [];
    let turnRunning = false;
    host = new MachineHostService({
      runMachineHostedTurn: async (request) => {
        hostRuns.push(request.runId); turnRunning = true;
        await new Promise((resolve) => { releaseTurn = resolve; });
        turnRunning = false;
        return { messages: [], warnings: [] };
      },
      activeParticipantRuns: () => (turnRunning ? hostRuns.map((runId) => ({ runId })) : []),
      cancelRun: () => true, respondToAppToolApproval: async () => undefined,
      applyReplicatedConversation: async (id, merge) => { const next = merge(conversations.get(id)); if (next) conversations.set(id, next); }
    }, { getConversation: async (id) => conversations.get(id) }, { importMachineSettingsSnapshot: async () => undefined }, debugLogs,
    { ...hostEvents, pairing, deviceId: MACHINE_ID, appVersion: "machine-v", createClient: undefined, reconnectDelayMs: 50 });
    assert.equal(await link.machineActivity("machine-act"), undefined, "not connected: nothing to ask");
    await link.start();
    await host.start();
    await waitFor(() => link.isMachineConnected("machine-act"), 10_000);
    const announced = [];
    const offHello = link.onHello((event) => announced.push(event));
    // Two callers asking at once (the restart gate and the automatic upgrade)
    // share one request; the one hello that answers it is not announced.
    const [idle, alsoIdle] = await Promise.all([link.machineActivity("machine-act"), link.machineActivity("machine-act")]);
    assert.equal(alsoIdle.fresh, true);
    assert.equal(logs.filter((entry) => entry.event === "machine-link.hello.requested").length, 0);
    assert.equal(logs.filter((entry) => entry.event === "machine-link.activity").length, 1, "one request for both callers");
    assert.equal(idle.connected, true);
    assert.equal(idle.fresh, true, "answered by a fresh hello");
    assert.equal(idle.appVersion, "machine-v", "the runtime's own version, not the desktop's");
    assert.equal(machineActivityIsBusy(idle), false);
    assert.ok(logs.some((entry) => entry.event === "machine-link.activity" && entry.payload.fresh === true));
    assert.deepEqual(announced, [], "a hello the desktop asked for is not announced: a listener that asks on every hello would loop");
    offHello();
    // A machine that does not answer in time: its last hello, marked stale.
    const realSend = link.send.bind(link);
    link.send = async (connection, body) => (body.type === "machine.hello.request" ? undefined : realSend(connection, body));
    // The settings sync that follows a hello makes the machine greet again
    // (its power status); let that settle so the dropped request is the only
    // thing the next probe could be answered by.
    await new Promise((resolve) => setTimeout(resolve, 600));
    const stale = await link.machineActivity("machine-act", { timeoutMs: 150 });
    assert.equal(stale.fresh, false, "no answer: the caller must not treat this as idle");
    assert.equal(await link.anyMachineBusy({ timeoutMs: 150 }), true, "a connected machine that did not answer is not known to be idle");
    link.send = realSend;

    const participant = { id: "p-act", homeMachineId: record.id, handle: "bot", kind: "codex-cli" };
    const triggerMessage = { id: "m-act", role: "user", content: "go", createdAt: new Date().toISOString() };
    const conversation = { id: "chat-act", kind: "chat", title: "act", messages: [triggerMessage], metadata: { participants: [participant] }, findings: [], createdAt: triggerMessage.createdAt, updatedAt: triggerMessage.createdAt };
    conversations.set(conversation.id, conversation);
    const turn = link.runTurn({ conversation, participant, triggerMessage, runId: "run-act", pendingMessageId: "pm-act" });
    await waitFor(() => hostRuns.includes("run-act"), 10_000);
    const busy = await link.machineActivity("machine-act");
    assert.equal(machineActivityIsBusy(busy), true, "a turn running now is seen without waiting for the next reconnect");
    assert.ok(busy.dispatchedRunIds.includes("run-act"), "the desktop's own dispatch counts");
    assert.ok(busy.activeRunIds.includes("run-act"), "and the machine reports it in its fresh hello");
    releaseTurn();
    const result = await turn;
    // The chat service acknowledges once the result is stored; until then the
    // machine rightly keeps the run in its outbox and the desktop keeps waiting.
    assert.equal(machineActivityIsBusy(await link.machineActivity("machine-act")), true, "a result not yet stored still counts");
    await result.acknowledge();
    await waitFor(async () => !machineActivityIsBusy(await link.machineActivity("machine-act")), 10_000);
    const again = await link.machineActivity("machine-act", { fresh: false });
    assert.equal(again.dispatchedRunIds.length, 0, "the finished turn is no longer counted");

    // While the runtime is being replaced, a turn waits instead of being
    // dispatched into a process about to be stopped; Stop ends the wait.
    const release = link.holdTurns("machine-act", "updating the runtime");
    const otherRelease = link.holdTurns("machine-act", "setting the program up again");
    const waitingMarks = [];
    const held = link.runTurn({ conversation, participant, triggerMessage, runId: "run-act-held", pendingMessageId: "pm-act-held", onMachineWaiting: async (name, reason) => { waitingMarks.push({ name, reason }); } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(!hostRuns.includes("run-act-held"), "not dispatched while held");
    assert.deepEqual(waitingMarks, [{ name: "Act box", reason: "updating the runtime" }], "the bubble says why the member has not started");
    const stopper = new AbortController();
    const stopped = link.runTurn({ conversation, participant, triggerMessage, runId: "run-act-stopped", pendingMessageId: "pm-act-stopped", signal: stopper.signal });
    stopper.abort();
    assert.equal((await stopped).status, "interrupted", "a held turn that is stopped ends without being sent");
    release();
    release();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(!hostRuns.includes("run-act-held"), "one holder letting go, even twice, does not release another's hold");
    otherRelease();
    await waitFor(() => hostRuns.includes("run-act-held"), 10_000);
    releaseTurn();
    await (await held).acknowledge();
    link.close();
  } finally { host?.close(); await relay.close(); }
});

test("machine link fails fast when the machine is not connected", async () => {
  const { MachineLinkService } = await import("../dist/main/main/services/machineLink.js");
  const relay = createReferenceRelayServer();
  const address = await relay.listen();
  try {
    const pairing = machinePairing(address.url);
    const record = { id: "machine-2", name: "Offline box", deviceId: "", pairingKey: pairing.rendezvousId, createdAt: new Date().toISOString() };
    const link = new MachineLinkService({
      listMachines: async () => [record],
      saveMachine: async () => [record],
      removeMachine: async () => [],
      getMachinePairing: async () => pairing,
      exportMachineSettingsSnapshot: async () => ({ version: 1, exportedAt: "", settingsJson: "{}", agentEnvironment: [] })
    }, { write: async () => undefined }, { ...desktopEvents, appVersion: "test", desktopDeviceId: DESKTOP_ID, reconnectDelayMs: 50 });
    await link.start();
    const result = await link.runTurn({
      conversation: { id: "c", kind: "chat", title: "", createdAt: "", updatedAt: "", messages: [], metadata: {}, findings: [] },
      participant: { id: "p", handle: "bot", roleConfigId: "r", kind: "codex-cli", homeMachineId: "machine-2" },
      triggerMessage: { id: "m", role: "user", content: "", createdAt: "", status: "done" },
      runId: "r", pendingMessageId: "pm"
    });
    assert.equal(result.status, "failed");
    assert.match(result.error, /not connected/);
    link.close();
  } finally {
    await relay.close();
  }
});

function machinePairing(relayUrl) {
  const now = Date.now();
  return {
    version: 1,
    purpose: "machine-host",
    issuer: DESKTOP_ISSUER,
    rendezvousId: "rv-machine-test-" + now,
    stableRoutingId: "route-machine-test",
    relaySealKeyBase64: Buffer.from(new Uint8Array(32).map((_, index) => index + 1)).toString("base64url"),
    relayUrl,
    capabilities: [{ scope: "device", canRead: true, canWrite: true, canRunCloudParticipants: true, canListConversations: true }],
    fingerprint: "TEST-CAP",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString()
  };
}

async function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  while (!await predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test("trust changes queue while a known machine is offline and outbox failures reach the caller", async () => {
  const { MachineLinkService } = await import("../dist/main/main/services/machineLink.js");
  const { createChatEventDeviceIdentity } = await import("../dist/main/main/services/chatEventLog.js");
  const controller = createChatEventDeviceIdentity(new Date().toISOString());
  const pairing = machinePairing("ws://127.0.0.1:1/v1/relay");
  const record = { id: "offline-trust", name: "Offline trust", deviceId: MACHINE_ID, pairingKey: pairing.rendezvousId,
    createdAt: new Date().toISOString(), lastHello: { publicKeyDerBase64: hostEvents.publicKeyDerBase64 } };
  let peers = [{ deviceId: controller.originId, publicKeyDerBase64: controller.publicKeyDerBase64, role: "desktop" }];
  const link = new MachineLinkService({ listMachines: async () => [record], getMachinePairing: async () => pairing,
    saveMachine: async () => [record] }, { write: async () => undefined }, {
    ...desktopEvents, appVersion: "test", desktopDeviceId: DESKTOP_ID, reconnectDelayMs: 60_000,
    trustedDevices: async room => peers.map(peer => ({ ...room, ...peer }))
  });
  const append = desktopEvents.eventStorage.appendChatEvent.bind(desktopEvents.eventStorage);
  try {
    await link.start();
    assert.equal(link.status()[0].connected, false);
    const pending = () => desktopEvents.eventStorage.deviceEvents().listPending(pairing.rendezvousId);
    assert.equal((await pending()).filter(row => row.event.kind === "machine.trust.roster").length, 1);
    peers = [];
    await link.refreshTrustRosters();
    const rows = (await pending()).filter(row => row.event.kind === "machine.trust.roster");
    assert.equal(rows.length, 2);
    const latest = await desktopEvents.eventStorage.deviceEventBlobs().hydrate(rows[1].event.payload);
    assert.equal(latest.roster.peers.some(peer => peer.deviceId === controller.originId), false);
    desktopEvents.eventStorage.appendChatEvent = async () => { throw new Error("SQLITE_FULL: trust outbox"); };
    await assert.rejects(link.refreshTrustRosters(), /SQLITE_FULL/);
  } finally {
    desktopEvents.eventStorage.appendChatEvent = append;
    link.close();
  }
});

test("script requests go to the one machine, resolve on its answer, and refuse an older or absent machine", async () => {
  const { MachineLinkService } = await import("../dist/main/main/services/machineLink.js");
  const record = { id: "machine-s", name: "Box", deviceId: "dev-s", pairingKey: "rv-s", createdAt: new Date().toISOString(),
    lastHello: { protocol: "accord-machine-link-v1", deviceId: "dev-s", instanceId: "run-7", scriptsSupported: true, keepAwake: true } };
  const link = new MachineLinkService({
    listMachines: async () => [record],
    saveMachine: async () => [record],
    removeMachine: async () => [],
    getMachinePairing: async () => undefined,
    exportMachineSettingsSnapshot: async () => ({ version: 1, exportedAt: "", settingsJson: "{}", agentEnvironment: [] })
  }, { write: async () => undefined }, { ...desktopEvents, appVersion: "test", desktopDeviceId: DESKTOP_ID });
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
  assert.deepEqual(link.scriptHosts(), [{ machineId: "machine-s", name: "Box", connected: true, supported: true }]);

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
  await assert.rejects(link.scriptsRequest("missing", { op: "list" }), /not set up/);
  // A machine set up by another desktop takes no script requests from this one.
  record.lastHello = { ...record.lastHello, scriptsSupported: true };
  connection.pairing = { issuer: { originId: "device-another-desktop" } };
  await assert.rejects(link.scriptsRequest("machine-s", { op: "list" }), /managed from the desktop that set it up/);
  assert.deepEqual(link.scriptHosts(), [], "and Settings does not list it as one of this desktop's script hosts");
  link.close();
});

test("a machine's capability recorded at its setup reaches the other machines' rosters", async () => {
  const { MachineLinkService } = await import("../dist/main/main/services/machineLink.js");
  const { createChatEventDeviceIdentity } = await import("../dist/main/main/services/chatEventLog.js");
  const upgraded = createChatEventDeviceIdentity(new Date().toISOString());
  const pairingA = { ...machinePairing("ws://127.0.0.1:1/v1/relay"), rendezvousId: "rv-capability-a-" + Date.now() };
  const pairingB = { ...machinePairing("ws://127.0.0.1:1/v1/relay"), rendezvousId: "rv-capability-b-" + Date.now() };
  const createdAt = new Date().toISOString();
  const records = [
    { id: "cap-a", name: "A", deviceId: MACHINE_ID, pairingKey: pairingA.rendezvousId, chatChanges: true, createdAt,
      lastHello: { publicKeyDerBase64: hostEvents.publicKeyDerBase64 } },
    // B still runs a runtime from before chat changes; its upgrade is under way.
    { id: "cap-b", name: "B", deviceId: upgraded.originId, pairingKey: pairingB.rendezvousId, createdAt,
      lastHello: { publicKeyDerBase64: upgraded.publicKeyDerBase64 } }
  ];
  const link = new MachineLinkService({
    listMachines: async () => records,
    getMachinePairing: async (key) => (key === pairingA.rendezvousId ? pairingA : pairingB),
    saveMachine: async (next) => { Object.assign(records.find((record) => record.id === next.id), next); return records; }
  }, { write: async () => undefined }, {
    ...desktopEvents, appVersion: "test", desktopDeviceId: DESKTOP_ID, reconnectDelayMs: 60_000, trustedDevices: async () => []
  });
  const rosters = async () => (await desktopEvents.eventStorage.deviceEvents().listPending(pairingA.rendezvousId))
    .filter((row) => row.event.kind === "machine.trust.roster");
  try {
    await link.start();
    const before = (await rosters()).length;
    await link.adoptMachineIdentity("cap-b", { originId: upgraded.originId, publicKeyDerBase64: upgraded.publicKeyDerBase64 });
    const rows = await rosters();
    assert.ok(rows.length > before, "machine A is told at once");
    const latest = await desktopEvents.eventStorage.deviceEventBlobs().hydrate(rows[rows.length - 1].event.payload);
    assert.equal(latest.roster.peers.find((peer) => peer.deviceId === upgraded.originId)?.chatChanges, true);
  } finally {
    link.close();
  }
});

test("another machine meeting this one in its room does not make it look present or absent", async () => {
  const { MachineLinkService } = await import("../dist/main/main/services/machineLink.js");
  const pairing = machinePairing("ws://127.0.0.1:1/v1/relay");
  const record = { id: "machine-presence", name: "Presence", deviceId: MACHINE_ID, pairingKey: pairing.rendezvousId, chatChanges: true,
    createdAt: new Date().toISOString() };
  const settings = {
    listMachines: async () => [record], getMachinePairing: async () => pairing,
    saveMachine: async next => { Object.assign(record, next); return [record]; },
    exportMachineSettingsSnapshot: async () => ({ version: 1, exportedAt: new Date().toISOString(), settingsJson: "{}", agentEnvironment: [] })
  };
  const listeners = new Map();
  const client = {
    on(event, listener) { listeners.set(event, [...(listeners.get(event) ?? []), listener]); return () => undefined; },
    emit(event, payload) { for (const listener of listeners.get(event) ?? []) listener(payload); },
    currentState: () => "connected", deviceId: () => DESKTOP_ID,
    async connect() {}, close() {}, async sendCiphertext() { return []; }
  };
  const link = new MachineLinkService(settings, { write: async () => undefined }, { ...desktopEvents, appVersion: "test", desktopDeviceId: DESKTOP_ID, createClient: () => client });
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

test("when a machine goes away the desktop stops showing the background work it reported", async () => {
  const { MachineLinkService } = await import("../dist/main/main/services/machineLink.js");
  const link = Object.create(MachineLinkService.prototype);
  link.backgroundListeners = [];
  link.debugLogs = { write: async () => undefined };
  link.emitStatus = () => undefined;
  const events = [];
  MachineLinkService.prototype.onMemberBackgroundTasks.call(link, (event) => events.push(event));
  const connection = { record: { id: "machine-a" }, machineDeviceId: "device-a", replicated: new Set(), settingsSynced: true, helloSeen: true, pendingScripts: new Map() };
  link.setMachinePeer(connection, undefined);
  assert.deepEqual(events, [{ machineId: "machine-a", snapshot: [] }]);
  link.setMachinePeer(connection, undefined);
  assert.equal(events.length, 1, "an already absent machine is not cleared twice");
  const sent = [];
  link.send = async (_connection, body) => { sent.push(body.type); };
  link.options = { desktopDeviceId: "desktop" };
  connection.helloSeen = true;
  link.setMachinePeer(connection, "device-a");
  assert.ok(sent.includes("machine.member.background.request"), "back on the link, the desktop asks what is running now");
});

test("the desktop asks a machine to move and waits for its answer; an older runtime is not asked", async () => {
  const { MachineLinkService } = await import("../dist/main/main/services/machineLink.js");
  const link = Object.create(MachineLinkService.prototype);
  link.debugLogs = { write: async () => undefined };
  link.now = () => new Date();
  const sent = [];
  const connection = { record: { id: "m", name: "Cloud run", lastHello: { instanceId: "i-1", transportMoveSupported: true } }, machineDeviceId: "device-m", pendingScripts: new Map() };
  link.connections = new Map([["m", connection]]);
  link.send = async (_connection, body) => { sent.push(body); };
  assert.equal(link.supportsTransportMove("m"), true);
  const moving = link.requestTransportMove("m", { relayUrl: "wss://hub/v1/relay", outboxUrl: "https://hub/v1/mailbox/events" }, 2_000);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sent[0].type, "machine.transport.move");
  assert.equal(sent[0].instanceId, "i-1");
  await link.handleBody(connection, { type: "machine.transport.moved", requestId: sent[0].requestId, ok: true });
  await moving;
  const refused = link.requestTransportMove("m", { relayUrl: "wss://hub/v1/relay", outboxUrl: "https://hub/v1/mailbox/events" }, 2_000);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await link.handleBody(connection, { type: "machine.transport.moved", requestId: sent[1].requestId, ok: false, error: "The machine is busy; it moves once it is idle." });
  await assert.rejects(refused, /busy/);
  connection.record.lastHello = { instanceId: "i-2" };
  assert.equal(link.supportsTransportMove("m"), false);
  await assert.rejects(link.requestTransportMove("m", { relayUrl: "wss://hub/v1/relay", outboxUrl: "https://hub/v1/mailbox/events" }), /older runtime/);
});
