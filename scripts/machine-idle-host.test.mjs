// A machine's idle stop against its live control (MachineHostService): a
// machine is a plain client of the User's server, so the work an idle stop
// must wait for is a member running here, a run still ending, a scheduled
// script that needs it awake, and anything it wrote that the server has not
// taken yet. Once the stop is fenced, a turn the server asks of a member
// here waits there for the next start instead of being taken.
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

test("idle waits for the members running here and for what the server has not taken; once fenced, new turns wait on the server, and a restart in the same boot keeps the fence", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-idle-host-"));
  let host; let scheduler;
  try {
    const storage = new StorageService({ dbPath: path.join(dir, "host.sqlite3") });
    const source = new StorageService({ dbPath: path.join(dir, "source.sqlite3") });
    const eventLog = new ChatEventLogService(storage); const sourceLog = new ChatEventLogService(source);
    const [identity, sender] = await Promise.all([eventLog.getOrCreateDeviceIdentity(), sourceLog.getOrCreateDeviceIdentity()]);
    const pairing = { version: 1, purpose: "machine-host", issuer: sender, rendezvousId: "idle-room", stableRoutingId: "idle-route",
      relaySealKeyBase64: Buffer.alloc(32, 6).toString("base64url"), hubUrl: "http://127.0.0.1:1",
      capabilities: [{ scope: "device", canRead: true, canWrite: true, canRunCloudParticipants: true, canListConversations: true }],
      fingerprint: "idle-test", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString() };
    const client = { on: () => () => undefined, connect: async () => undefined, close: () => undefined, sendCiphertext: async () => [] };
    let running = []; let ending = []; let unsent = { queued: 0 };
    let activityCalls = 0; let nativeCloses = 0; let nativeFenced = false; let lifted = 0;
    const settled = [];
    const chat = {
      respondToChoice: async () => undefined, respondToAppToolApproval: async () => undefined,
      activeParticipantRuns: () => running, liveRunIds: () => ending,
      onParticipantRunSettled: (listener) => { settled.push(listener); return () => undefined; }
    };
    const create = () => new MachineHostService(chat, { write: async () => undefined }, {
      pairing, deviceId: identity.originId, appVersion: "test", publicKeyDerBase64: identity.publicKeyDerBase64,
      identity: () => eventLog.getOrCreateDeviceIdentity(), createClient: () => client, storage,
      unsentServerWrites: async () => unsent,
      onNativeActivitySettled: async () => { activityCalls++; await scheduler.noteActivity(); } });
    host = create();
    host.onFenceLifted(() => { lifted += 1; });
    const power = storage.machinePower(); let now = 10;
    scheduler = new MachineIdleScheduler({ state: power, bootId: "boot", uptimeMs: () => now,
      isBusy: () => host.hasWorkForIdleStop(), prepareStop: async () => undefined, onError: () => undefined });
    await scheduler.check(); await host.start();
    const prepare = () => host.prepareIdleStop({ bootId: "boot", uptimeMs: now, idleSinceMs: 10,
      fenceNative: () => { nativeFenced = true; return () => { nativeFenced = false; }; }, stopProviders: async () => { nativeCloses++; } });

    // A member is running a turn it took from the server.
    running = [{ runId: "turn-a", conversationId: "chat" }];
    assert.equal(await host.hasWorkForIdleStop(), true);
    assert.equal(await prepare(), undefined, "not while a member runs");
    assert.equal(nativeFenced, false); assert.equal(host.takesNewWork(), true, "a refused stop leaves admission open");
    assert.equal(lifted, 0, "nothing was fenced, so nothing waits to be taken again");
    // Its run ended, but its reply has not reached the server yet.
    running = []; ending = ["turn-a"];
    assert.equal(await prepare(), undefined, "not while a run is still ending");
    ending = []; unsent = { queued: 1, lastError: "The server did not answer." };
    for (const listener of settled) await listener();
    assert.equal(activityCalls, 1, "a settled run counts as activity");
    assert.equal((await power.read()).idleSinceMs, null);
    assert.equal(await prepare(), undefined, "not before the server took what the member wrote");
    unsent = { queued: 0 };
    assert.equal(await host.hasWorkForIdleStop(), false);

    await power.write({ version: 1, bootId: "boot", idleSinceMs: 10 }); now = 100_000;
    const drain = await prepare();
    assert.equal(typeof drain, "function");
    assert.equal(nativeFenced, true);
    assert.ok(await power.stopFence("boot"), "the fence is stored before the stop");
    assert.equal(host.takesNewWork(), false, "a turn the server asks now waits there for the next start");
    scheduler.close(); await drain();
    assert.equal(nativeCloses, 1);
    assert.equal(activityCalls, 1, "the drain itself is no activity");

    // The runtime restarts in the same boot with the fence kept: it takes nothing.
    host.close(); host = create(); host.retainIdleFence(); await host.start();
    assert.equal(host.takesNewWork(), false, "a same-boot replacement keeps the fence");
    let liftedAfterRestart = 0;
    host.onFenceLifted(() => { liftedAfterRestart += 1; });
    assert.equal(await host.recoverIdleFence("boot"), true, "a stored fence holds");
    assert.equal(host.takesNewWork(), false);
    assert.equal(liftedAfterRestart, 0);
    // A new boot has no fence: admission reopens and waiting turns are taken.
    assert.equal(await host.recoverIdleFence("another-boot"), false);
    assert.equal(host.takesNewWork(), true);
    assert.equal(liftedAfterRestart, 1);
  } finally { scheduler?.close(); host?.close(); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

/** A host with only what the idle preparation reads, over a real SQLite fence. */
function bareHost(storage, extra = {}) {
  const host = Object.create(MachineHostService.prototype);
  Object.assign(host, { idleFenced: false, draining: false, closed: false, inbound: Promise.resolve(), scriptsQueue: Promise.resolve(), fenceListeners: [],
    options: { storage }, debugLogs: { write: async () => {} }, hasWorkForIdleStop: async () => false, ...extra });
  return host;
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
    const host = bareHost(storage, { publishPowerStatus: async () => {}, shutdown: async () => {} });
    const config = { version: 1, instanceId: "i-0123456789abcdef0", credentials: { accessKeyId: "synthetic", secretAccessKey: "synthetic", region: "us-east-1" } };
    const power = new MachineIdlePower({ config, store, host, nativeProcessDbPath: path.join(dir, "native.sqlite3"), log: () => {},
      runner: { hasActiveNativeWork: () => false, shutdownWarmAgents: async () => {},
        fenceIdleNativeAdmissions: () => { nativeFenced = true; return () => { nativeFenced = false; }; } } }, {
      identity: async () => identity, verifyAws: async () => {}, uptimeMs: () => MACHINE_IDLE_STOP_MS + 100,
      createHostRegistry: options => new MachineHostPowerRegistry({ ...options, dir: path.join(dir, "host"), profilePath: dir }),
      client: { close: () => {}, assertCanStop: async () => {}, stopAfterDrain: async () => { stops++; return { instanceId: config.instanceId, state: "stopping" }; } }
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
    } finally { power.close(); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
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
  // provider work or server traffic required for this persistence interleaving.
  const host = bareHost(storage);
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
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
