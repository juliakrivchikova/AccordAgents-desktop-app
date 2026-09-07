import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { StorageService } from "../dist/main/main/services/storage.js";
import { ChatEventLogService } from "../dist/main/main/services/chatEventLog.js";
import { MachineHostService } from "../dist/main/main/services/machineHost.js";
import { MachineHostPowerRegistry } from "../dist/main/main/services/machineHostPower.js";
import { MachineIdleScheduler } from "../dist/main/main/services/machineIdle.js";
import { MachineIdlePower } from "../dist/main/main/services/machineIdlePower.js";
import { MACHINE_IDLE_STOP_MS } from "../dist/main/shared/machinePower.js";
import { openMobileRelayPayload } from "../dist/main/main/services/mobileRelaySealing.js";

test("idle fences the actual host admission path; retained results resend and late turns wait for a new boot", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-idle-host-"));
  let host; let scheduler;
  try {
    const storage = new StorageService({ dbPath: path.join(dir, "host.sqlite3") });
    const source = new StorageService({ dbPath: path.join(dir, "source.sqlite3") });
    const eventLog = new ChatEventLogService(storage); const sourceLog = new ChatEventLogService(source);
    const [identity, sender] = await Promise.all([eventLog.getOrCreateDeviceIdentity(), sourceLog.getOrCreateDeviceIdentity()]);
    const pairing = { version: 1, purpose: "machine-host", issuer: sender, rendezvousId: "idle-room", stableRoutingId: "idle-route",
      relaySealKeyBase64: Buffer.alloc(32, 6).toString("base64url"), relayUrl: "ws://127.0.0.1:1/v1/relay",
      capabilities: [{ scope: "device", canRead: true, canWrite: true, canRunCloudParticipants: true, canListConversations: true }],
      fingerprint: "idle-test", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString() };
    const sent = []; const conversations = new Map(); const runs = []; let finish;
    let activityCalls = 0; let nativeCloses = 0; let nativeFenced = false;
    const gate = new Promise(resolve => { finish = resolve; });
    const client = { on: () => () => undefined, connect: async () => undefined, close: () => undefined,
      sendCiphertext: async request => { sent.push(await openMobileRelayPayload(request.ciphertext, pairing.relaySealKeyBase64)); return []; } };
    const chat = { activeParticipantRuns: () => [], cancelRun: () => true,
      runMachineHostedTurn: async request => { runs.push(request.runId); await gate; return { messages: [], warnings: [] }; },
      applyReplicatedConversation: async (id, merge) => { const value = merge(conversations.get(id)); if (value) conversations.set(id, value); } };
    const options = { eventStorage: storage, eventLog, publicKeyDerBase64: identity.publicKeyDerBase64, deviceId: identity.originId,
      pairing, appVersion: "test", createClient: () => client, outboxPath: path.join(dir, "outbox.json"),
      onNativeActivitySettled: async () => { activityCalls++; await scheduler.noteActivity(); } };
    const create = () => new MachineHostService(chat, { getConversation: async id => conversations.get(id) },
      { importMachineSettingsSnapshot: async () => undefined }, { write: async () => undefined }, options);
    host = create();
    const power = storage.machinePower(); let now = 10;
    scheduler = new MachineIdleScheduler({ state: power, bootId: "boot", uptimeMs: () => now,
      isBusy: () => host.hasWorkForIdleStop(), prepareStop: async () => undefined, onError: () => undefined });
    await scheduler.check(); await host.start();
    await host.handleBody({ type: "machine.hello.ack", desktopDeviceId: sender.originId, machineId: "home", appVersion: "test" });
    const send = async (body, eventId) => {
      const event = (await sourceLog.appendLocalEvent({ conversationId: body.conversationId ?? body.conversation.id,
        kind: body.type, payload: body, eventId, logScopeId: `device:idle-room:${JSON.stringify(["chat", "actions"])}` })).event;
      await host.eventChannel.receive({ protocol: "accord-device-events-v1", from: sender.originId, to: identity.originId, type: "event", event });
      return event;
    };
    const conversation = { id: "chat", kind: "chat", title: "Idle test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      metadata: { participants: [{ id: "p1", handle: "machine", kind: "codex-cli", homeMachineId: "home" }] }, messages: [], findings: [] };
    const request = runId => ({ type: "machine.turn.request", conversationId: "chat", participantId: "p1", participant: conversation.metadata.participants[0],
      runId, messageId: "user", pendingMessageId: `pending-${runId}`, requestedAt: conversation.createdAt });
    await send({ type: "machine.conversation.sync", conversation });
    assert.equal(await host.hasWorkForIdleStop(), true, "an incomplete copy is busy even before a provider exists");
    await send({ type: "machine.conversation.sync.done", conversationId: "chat" });
    await send(request("active"), "machine-command:active");
    await until(() => runs.includes("active"));
    assert.equal(await host.hasWorkForIdleStop(), true);
    const prepare = () => host.prepareIdleStop({ bootId: "boot", uptimeMs: now, idleSinceMs: 10,
      fenceNative: () => { nativeFenced = true; return () => { nativeFenced = false; }; }, stopProviders: async () => { nativeCloses++; } });
    assert.equal(await prepare(), undefined); assert.equal(nativeFenced, false);
    finish(); await until(async () => (await storage.nativeCommands().forRun("active"))?.phase === "finished");
    await host.outbound; await until(async () => !await host.hasWorkForIdleStop());
    assert.equal(activityCalls, 1); assert.equal((await power.read()).idleSinceMs, null);
    assert.equal(host.pendingTerminals.size, 1, "a peer acknowledgement is deliberately withheld");
    await power.write({ version: 1, bootId: "boot", idleSinceMs: 10 }); now = 100_000;
    const drain = await prepare(); assert.equal(typeof drain, "function");
    scheduler.close(); await drain();
    assert.equal(nativeCloses, 1); assert.equal(activityCalls, 1, "resending a stored terminal cannot reset idle or deadlock the power drain");
    const late = await send(request("late"), "machine-command:late");
    assert.equal(await storage.nativeCommands().forRun("late"), undefined);
    assert.equal(await storage.deviceEvents().receipt(late.eventId), undefined);
    const beforeQuery = sent.length;
    await host.handleBody({ type: "machine.turn.query", conversationId: "chat", runId: "late" });
    assert.equal(sent.length, beforeQuery, "a held request must not receive a false unknown result");
    await assert.rejects(storage.nativeCommands().accept({ commandId: late.eventId, eventId: late.eventId, conversationId: "chat", participantId: "p1",
      runId: "late", terminalEventId: "machine-terminal:machine-command:late" }), /not stored/);
    host.close(); host = create(); host.retainIdleFence(); await host.start();
    await host.handleBody({ type: "machine.hello.ack", desktopDeviceId: sender.originId, machineId: "home", appVersion: "test" });
    assert.deepEqual(runs, ["active"], "the same-boot replacement leaves the late native command unapplied");
    assert.equal(activityCalls, 1);
  } finally { scheduler?.close(); host?.close(); await rm(dir, { recursive: true, force: true }); }
});

async function until(predicate) {
  const end = Date.now() + 5000;
  while (!await predicate()) { if (Date.now() >= end) throw new Error("Idle lifecycle condition was not reached"); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test("unknown fence writes recover in the same runtime after SQLite becomes readable", async () => {
  for (const { didCommit, failReads } of [{ didCommit: false, failReads: 1 }, { didCommit: false, failReads: Infinity }, { didCommit: true, failReads: Infinity }]) {
    const dir = await mkdtemp(path.join(tmpdir(), "accord-idle-uncertain-"));
    const storage = new StorageService({ dbPath: path.join(dir, "state.sqlite3") });
    const store = storage.machinePower();
    const identity = { machine: "a".repeat(64), boot: "a".repeat(32) };
    let nativeFenced = false, unreadable = false, stops = 0;
    let failuresRemaining = failReads;
    const readFence = store.stopFence.bind(store), writeFence = store.tryFence.bind(store);
    storage.machinePower = () => store;
    store.stopFence = async boot => { if (unreadable && failuresRemaining-- > 0) throw new Error("SQLITE_IOERR read"); return readFence(boot); };
    store.tryFence = async (...args) => {
      if (didCommit) await writeFence(...args);
      unreadable = true;
      throw new Error("SQLITE_IOERR write response");
    };
    const host = Object.create(MachineHostService.prototype);
    Object.assign(host, { idleFenced: false, inbound: Promise.resolve(), eventChannel: { flush: async () => {} },
      options: { eventStorage: storage }, debugLogs: { write: async () => {} },
      hasWorkForIdleStop: async () => false, publishPowerStatus: async () => {}, shutdown: async () => {} });
    const config = { version: 1, instanceId: "i-0123456789abcdef0", credentials: { accessKeyId: "synthetic", secretAccessKey: "synthetic", region: "us-east-1" } };
    const power = new MachineIdlePower({ config, store, host, nativeProcessDbPath: path.join(dir, "native.sqlite3"), log: () => {},
      runner: { hasActiveNativeWork: () => false, shutdownWarmAgents: async () => {},
        fenceIdleNativeAdmissions: () => { nativeFenced = true; return () => { nativeFenced = false; }; } } }, {
      identity: async () => identity, verifyAws: async () => {}, uptimeMs: () => MACHINE_IDLE_STOP_MS + 100,
      createHostRegistry: options => new MachineHostPowerRegistry({ ...options, dir: path.join(dir, "host"), profilePath: dir }),
      client: { close: () => {}, stopAfterDrain: async () => { stops++; return { instanceId: config.instanceId, state: "stopping" }; } }
    });
    try {
      await store.write({ version: 1, bootId: identity.boot, idleSinceMs: 1 });
      await power.start();
      if (failReads === 1) {
        await assert.rejects(power.scheduler.check(), /SQLITE_IOERR write/);
        assert.equal(nativeFenced, false); assert.equal(host.idleFenced, false);
        assert.equal(power.hostPower.stopIntent(), undefined);
        assert.equal(stops, 0, "the outer successful absence read also releases gates retained by the first failed read");
        continue;
      }
      await power.scheduler.check();
      assert.equal(power.uncertainFence, true); assert.equal(nativeFenced, true); assert.equal(host.idleFenced, true);
      assert.equal(power.hostPower.stopIntent().phase, "pending", "unknown persistence cannot discard the shared stop intent");
      await assert.rejects(power.stopAws(), /SQLITE_IOERR read/);
      assert.equal(stops, 0); assert.equal(nativeFenced, true);
      unreadable = false;
      await power.stopAws();
      assert.equal(power.uncertainFence, false);
      assert.equal(nativeFenced, didCommit); assert.equal(host.idleFenced, didCommit);
      assert.equal(stops, didCommit ? 1 : 0, "only a stored fence continues the stop; an absent one reopens queued work");
      if (!didCommit) assert.equal(power.hostPower.stopIntent(), undefined);
    } finally { power.close(); await rm(dir, { recursive: true, force: true }); }
  }
});


test("host stop loss leaves no local fence; failure after local commit keeps admission held", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-idle-commit-"));
  const storage = new StorageService({ dbPath: path.join(dir, "state.sqlite3") });
  const store = storage.machinePower();
  const create = profilePath => new MachineHostPowerRegistry({ dir: path.join(dir, "shared"), profilePath, bootId: "boot", uptimeMs: () => 10000 });
  const stopper = create("/stopper"), neighbour = create("/neighbour");
  let nativeFenced = false;
  // Exercise the real host preparation method and SQLite fence, with no
  // provider work or relay traffic required for this persistence interleaving.
  const host = Object.create(MachineHostService.prototype);
  Object.assign(host, { idleFenced: false, inbound: Promise.resolve(), eventChannel: { flush: async () => {} },
    options: { eventStorage: storage }, debugLogs: { write: async () => {} }, hasWorkForIdleStop: async () => false });
  const request = commitHostStop => ({ bootId: "boot", uptimeMs: 10000, idleSinceMs: 1,
    fenceNative: () => { nativeFenced = true; return () => { nativeFenced = false; }; }, stopProviders: async () => {}, commitHostStop });
  try {
    await store.write({ version: 1, bootId: "boot", idleSinceMs: 1 });
    stopper.publish(false); neighbour.publish(false);
    assert.equal(await stopper.beginStop({ minIdleMs: 0, ownIdleSinceUptimeMs: 0 }), true);
    await neighbour.admit("a turn");
    assert.equal(await host.prepareIdleStop(request(write => stopper.commitStop(write))), undefined);
    assert.equal(await store.stopFence("boot"), undefined);
    assert.equal(nativeFenced, false);
    assert.equal(host.idleFenced, false);
    neighbour.publish(false);
    assert.equal(await stopper.beginStop({ minIdleMs: 0, ownIdleSinceUptimeMs: 0 }), true);
    await assert.rejects(host.prepareIdleStop(request(write => stopper.commitStop(async () => {
      assert.equal(await write(), true);
      throw new Error("shared commit failed after SQLite stored the fence");
    }))), /shared commit failed/);
    assert.ok(await store.stopFence("boot"));
    assert.equal(nativeFenced, true);
    assert.equal(host.idleFenced, true);
    assert.equal(stopper.stopIntent().phase, "pending");
    // Recovery must establish the shared fence before it may call AWS.
    assert.equal(await stopper.commitStop(), true);
    assert.equal((await neighbour.admit("late turn")).admitted, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
