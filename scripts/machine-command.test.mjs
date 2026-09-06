import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { StorageService } from "../dist/main/main/services/storage.js";
import { ChatEventLogService } from "../dist/main/main/services/chatEventLog.js";
import { MachineHostService } from "../dist/main/main/services/machineHost.js";
import { machineCommandId, machineCommandTerminalId } from "../dist/main/shared/machineLink.js";
import { sealMobileRelayPayload } from "../dist/main/main/services/mobileRelaySealing.js";
import { NativeProcessRegistry } from "../dist/main/main/services/nativeProcessRegistry.js";

test("durable admission survives a receiver restart before the copy is complete; replay never executes twice", async () => {
  const f = await fixture();
  try {
    await f.send({ type: "machine.conversation.sync", conversation: f.conversation });
    const event = await f.request("queued");
    assert.equal((await f.store.nativeCommands().forRun("queued")).phase, "queued");
    assert.ok(await f.store.deviceEvents().receipt(event.eventId), "the command is admitted durably before acknowledgement");
    assert.deepEqual(f.runs, []);
    await f.restart();
    await f.send({ type: "machine.conversation.sync.done", conversationId: "chat" });
    await f.until(() => f.terminal("queued"));
    await f.deliver(event);
    assert.deepEqual(f.runs, ["queued"]);
    assert.equal((await f.store.nativeCommands().forRun("queued")).phase, "finished");
  } finally { await f.close(); }
});

test("a Stop arriving before its command is retained across restart and confirms no native input", async () => {
  const f = await fixture();
  try {
    await f.send({ type: "machine.turn.cancel", conversationId: "chat", runId: "stopped" }, { scope: "cancel:stopped", eventId: "cancel-stopped" });
    await f.restart();
    await f.request("stopped");
    await f.until(() => f.terminal("stopped"));
    assert.equal((await f.terminal("stopped")).status, "interrupted");
    assert.deepEqual(f.runs, []);
    assert.equal(await f.store.nativeCommands().executor("chat", "member"), undefined);
  } finally { await f.close(); }
});

test("queued commands recover in their signed logical order, not random command-id order", async () => {
  const f = await fixture();
  try {
    await f.send({ type: "machine.conversation.sync", conversation: f.conversation });
    await f.request("z-first");
    await f.request("a-second");
    await f.restart();
    await f.send({ type: "machine.conversation.sync.done", conversationId: "chat" });
    await f.until(() => f.terminal("a-second"));
    assert.deepEqual(f.runs, ["z-first", "a-second"]);
  } finally { await f.close(); }
});

test("SQLITE_FULL before command acceptance never acknowledges or runs; a failed claim stays queued", async () => {
  const f = await fixture();
  try {
    await f.sql("create trigger reject_command before insert on native_commands begin select raise(abort, 'SQLITE_FULL'); end;");
    const event = await f.makeRequest("full");
    await assert.rejects(f.deliver(event));
    assert.equal(await f.store.deviceEvents().receipt(event.eventId), undefined);
    assert.equal(await f.store.nativeCommands().forRun("full"), undefined);
    assert.deepEqual(f.runs, []);
    await f.sql("drop trigger reject_command; create trigger reject_claim before update on native_commands when new.phase = 'claimed' begin select raise(abort, 'SQLITE_FULL'); end;");
    await f.deliver(event);
    await f.until(async () => f.logs.some(entry => entry.event === "machine-host.turn.not-stored"));
    assert.equal((await f.store.nativeCommands().forRun("full")).phase, "queued");
    assert.deepEqual(f.runs, []);
    await f.sql("drop trigger reject_claim;");
    await f.host.recoverCommands();
    await f.until(() => f.terminal("full"));
    assert.deepEqual(f.runs, ["full"]);
  } finally { await f.close(); }
});

test("an accepted native command is never replayed after process loss and recovery waits for the guardian receipt", async () => {
  const f = await fixture();
  try {
    const event = await f.makeRequest("uncertain");
    await f.store.appendChatEvent(event);
    await f.store.nativeCommands().accept({ commandId: event.eventId, eventId: event.eventId, conversationId: "chat", participantId: "member", runId: "uncertain", terminalEventId: machineCommandTerminalId("uncertain") });
    const oldOwner = { runtimeId: "old-runtime", pid: 2_000_000_000, startedAt: "old-birth" };
    await f.store.nativeCommands().claim(event.eventId, oldOwner);
    const registry = new NativeProcessRegistry(f.registryPath);
    await registry.init();
    const lease = await registry.acquire({ scope: "chat:member", token: "old-token", parent: oldOwner, supervisor: { pid: 2_000_000_001, startedAt: "guardian-birth" } });
    await f.deliver(event);
    await f.host.recoverCommands();
    await f.until(async () => f.logs.some(entry => entry.event === "machine-host.turn.not-stored"));
    assert.equal(await f.terminal("uncertain"), undefined, "a missing runtime alone does not prove the provider is gone");
    assert.deepEqual(f.runs, []);
    await registry.update({ ...lease, phase: "closed", shutdownReason: "processes-gone" });
    await f.host.recoverCommands();
    await f.until(() => f.terminal("uncertain"));
    assert.match((await f.terminal("uncertain")).error, /uncertain.*not run again/);
    assert.deepEqual(f.runs, []);
    await f.request("next");
    await f.until(() => f.terminal("next"));
    assert.deepEqual(f.runs, ["next"], "a new command can claim the verified closed session generation");
  } finally { await f.close(); }
});

test("settings secrets stay sealed in the event store and receiver input uses the retained snapshot", async () => {
  const f = await fixture();
  try {
    const snapshot = { version: 1, exportedAt: new Date().toISOString(), settingsJson: "{}", agentEnvironment: [{ key: "TOKEN", value: "synthetic-secret-unique" }] };
    const sealedSettings = await sealMobileRelayPayload(snapshot, f.pairing.relaySealKeyBase64);
    const event = await f.request("sealed", { sealedSettings });
    await f.until(() => f.terminal("sealed"));
    assert.equal(JSON.stringify(event).includes("synthetic-secret-unique"), false);
    assert.deepEqual(f.imports.at(-1), snapshot);
    assert.deepEqual(f.runs, ["sealed"]);
  } finally { await f.close(); }
});

test("a terminal write failure retains the result and never repeats provider input", async () => {
  const f = await fixture();
  try {
    await f.sql("create trigger reject_result before insert on chat_events when new.kind = 'machine.turn.finished' begin select raise(abort, 'SQLITE_FULL'); end;");
    await f.request("result-full");
    await f.until(async () => f.logs.some(entry => entry.event === "machine-host.terminal.retry-later"));
    assert.equal((await f.store.nativeCommands().forRun("result-full")).phase, "claimed");
    await f.host.recoverCommands();
    assert.deepEqual(f.runs, ["result-full"]);
    await f.sql("drop trigger reject_result;");
    await f.host.flushPendingTerminals();
    assert.equal((await f.terminal("result-full")).status, "completed");
    assert.equal((await f.store.nativeCommands().forRun("result-full")).phase, "finished");
    assert.deepEqual(f.runs, ["result-full"]);
  } finally { await f.close(); }
});

test("a cancellation for another chat is rejected before it can reach the native run", async () => {
  const f = await fixture();
  try {
    await f.request("scoped");
    await f.until(() => f.terminal("scoped"));
    const event = (await f.log.appendLocalEvent({ conversationId: "wrong-chat", logScopeId: "stop", kind: "machine.turn.cancel", payload: { runId: "scoped" } })).event;
    await f.store.appendChatEvent(event);
    await assert.rejects(f.store.nativeCommands().cancel("scoped", "wrong-chat", event.eventId));
    assert.equal((await f.store.nativeCommands().forRun("scoped")).cancelled, false);
  } finally { await f.close(); }
});

test("Stop and recovery preserve the first queued receipt through a full disk and later redelivery", async () => {
  const f = await fixture();
  try {
    await f.send({ type: "machine.conversation.sync", conversation: f.conversation });
    const event = await f.request("queued-receipt");
    const body = event.payload;
    await f.sql("create trigger reject_result before insert on chat_events when new.kind = 'machine.turn.finished' begin select raise(abort, 'SQLITE_FULL'); end;");
    await f.host.finishQueuedTurn(body, "interrupted");
    const first = { ...f.host.pendingTerminals.get(body.runId) };
    await new Promise(resolve => setTimeout(resolve, 5));
    await f.host.finishQueuedTurn(body, "failed", "a later recovery attempt");
    assert.deepEqual(f.host.pendingTerminals.get(body.runId), first);
    await f.sql("drop trigger reject_result;");
    await f.host.flushPendingTerminals();
    assert.deepEqual(await f.terminal(body.runId), first);
    f.host.pendingTerminals.clear();
    await f.host.finishQueuedTurn(body, "failed", "redelivery after acknowledgement");
    assert.equal(f.host.pendingTerminals.size, 0);
    assert.deepEqual(await f.terminal(body.runId), first);
    assert.deepEqual(f.runs, []);
  } finally { await f.close(); }
});

test("a queued command cannot run after the participant's home changed", async () => {
  const f = await fixture();
  try {
    f.conversation.metadata.participants[0].homeMachineId = "another-home";
    await f.request("moved");
    await f.until(() => f.terminal("moved"));
    assert.equal((await f.terminal("moved")).status, "failed");
    assert.match((await f.terminal("moved")).error, /no longer belongs/);
    assert.deepEqual(f.runs, []);
  } finally { await f.close(); }
});

test("terminal ACK repairs its receipt index after a crash lost the legacy outbox", async () => {
  const f = await fixture();
  try {
    await f.request("indexed");
    await f.until(() => f.terminal("indexed"));
    await Promise.allSettled([...f.host.turnTasks]);
    const terminal = await f.terminal("indexed");
    f.host.pendingTerminals.clear();
    await f.sql("delete from native_run_outcomes;");
    await f.send({ type: "machine.turn.finished.ack", conversationId: "chat", runId: "indexed", receiptId: terminal.receiptId, finishedAt: terminal.finishedAt });
    assert.equal(await f.store.nativeCommands().latestOutcome("indexed"), machineCommandTerminalId("indexed"));
    assert.deepEqual(f.runs, ["indexed"]);
  } finally { await f.close(); }
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "accord-command-path-"));
  const store = new StorageService({ dbPath: path.join(directory, "host.sqlite3") });
  const source = new StorageService({ dbPath: path.join(directory, "source.sqlite3") });
  const log = new ChatEventLogService(source), hostLog = new ChatEventLogService(store);
  const identity = await log.getOrCreateDeviceIdentity(), peer = await hostLog.getOrCreateDeviceIdentity();
  const pairing = { version: 1, purpose: "machine-host", issuer: identity, rendezvousId: "test-room", relayUrl: "ws://127.0.0.1:1/v1/relay", relaySealKeyBase64: Buffer.alloc(32, 17).toString("base64url"), fingerprint: "test", stableRoutingId: "test-route", capabilities: [] };
  const logs = [], runs = [], imports = [], conversations = new Map();
  const registryPath = path.join(directory, "native-processes.sqlite3");
  const conversation = { id: "chat", kind: "chat", title: "test", messages: [], metadata: { participants: [{ id: "member", homeMachineId: "home" }] }, findings: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  conversations.set("chat", conversation);
  let host;
  const create = () => new MachineHostService({
    runMachineHostedTurn: async request => { runs.push(request.runId); return { messages: [], warnings: [] }; },
    cancelRun: () => true, respondToAppToolApproval: async () => undefined,
    applyReplicatedConversation: async (id, merge) => { const next = merge(conversations.get(id)); if (next) conversations.set(id, next); }
  }, { getConversation: async id => conversations.get(id) }, { importMachineSettingsSnapshot: async snapshot => imports.push(snapshot) },
  { write: async (event, payload) => logs.push({ event, payload }) }, {
    pairing, eventStorage: store, eventLog: hostLog, deviceId: peer.originId, publicKeyDerBase64: peer.publicKeyDerBase64, appVersion: "test", nativeProcessDbPath: registryPath,
    createClient: () => ({ on() {}, async connect() {}, close() {}, async sendCiphertext() { return []; } })
  });
  await store.deviceEvents().saveHostMachineId(pairing.rendezvousId, "home");
  host = create(); host.desktopDeviceId = identity.originId; await host.start();
  const deliver = event => host.eventChannel.receive({ protocol: "accord-device-events-v1", from: identity.originId, to: peer.originId, type: "event", event });
  const make = async (body, { scope = "actions", eventId } = {}) => (await log.appendLocalEvent({ conversationId: "chat", logScopeId: `device:${pairing.rendezvousId}:${JSON.stringify(["chat", scope])}`, kind: body.type, payload: body, eventId })).event;
  const makeRequest = (runId, extra = {}) => make({ type: "machine.turn.request", conversationId: "chat", participantId: "member", participant: { id: "member", homeMachineId: "home" }, runId, pendingMessageId: `pending-${runId}`, messageId: "message", requestedAt: new Date().toISOString(), ...extra }, { eventId: machineCommandId(runId) });
  return {
    store, source, log, registryPath, logs, runs, imports, pairing, conversation, get host() { return host; },
    deliver, makeRequest,
    request: async (runId, extra) => { const event = await makeRequest(runId, extra); await deliver(event); return event; },
    send: async (body, options) => { const event = await make(body, options); await deliver(event); return event; },
    terminal: async runId => { const event = await store.getChatEvent(machineCommandTerminalId(runId)); return event ? store.deviceEventBlobs().hydrate(event.payload) : undefined; },
    sql: sql => store.runSql(sql),
    restart: async () => { host.close(); await Promise.allSettled([...host.turnTasks]); host = create(); host.desktopDeviceId = identity.originId; await host.start(); },
    until: async predicate => { const deadline = Date.now() + 10_000; while (!await predicate()) { if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(logs.slice(-8))}`); await new Promise(resolve => setTimeout(resolve, 25)); } },
    close: async () => { host.close(); await Promise.allSettled([...host.turnTasks, host.inbound, host.outbound]); await rm(directory, { recursive: true, force: true }); }
  };
}
