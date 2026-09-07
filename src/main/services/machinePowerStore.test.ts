import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { StorageService } from "./storage";
import { MachineIdleScheduler } from "./machineIdle";

test("maintenance and idle drain cannot both acquire the local power gate", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "machine-power-gate-"));
  try {
    const dbPath = path.join(dir, "state.sqlite3");
    const runtime = new StorageService({ dbPath }).machinePower();
    const installer = new StorageService({ dbPath }).machinePower();
    await runtime.write({ version: 1, bootId: "boot", idleSinceMs: 100 });
    assert.equal(await installer.maintenance("install", "boot", 1000, 2000), true);
    assert.equal(await runtime.tryFence("boot", 1000, "idle-stop", 100), false);
    assert.equal(await installer.maintenance("install", "boot", 1900, 3000, true), true);
    await installer.releaseMaintenance("install", "boot");
    assert.equal((await runtime.read())?.idleSinceMs, null);
    assert.equal(await runtime.tryFence("boot", 2000, "stale-deadline", 100), false);
    await runtime.write({ version: 1, bootId: "boot", idleSinceMs: 2000 });
    assert.equal(await runtime.tryFence("boot", 4000, "idle-stop", 2000), true);
    assert.equal(await installer.maintenance("late-install", "boot", 4000, 5000), false);
    await assert.rejects(runtime.write({ version: 1, bootId: "boot", idleSinceMs: null }), /retained idle-stop fence/);
    assert.equal(await new StorageService({ dbPath }).machinePower().stopFence("boot"), "idle-stop");
    await runtime.write({ version: 1, bootId: "new-boot", idleSinceMs: 10 });
    assert.equal(await runtime.stopFence("new-boot"), undefined);
    assert.equal(await installer.maintenance("new-install", "new-boot", 20, 200), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a concurrent lease acquisition and stop fence yield exactly one winner", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "machine-power-race-"));
  try {
    const dbPath = path.join(dir, "state.sqlite3");
    const a = new StorageService({ dbPath }).machinePower();
    const b = new StorageService({ dbPath }).machinePower();
    await a.write({ version: 1, bootId: "boot", idleSinceMs: 1 });
    const results = await Promise.all([a.tryFence("boot", 2000, "stop", 1), b.maintenance("install", "boot", 2000, 3000)]);
    assert.equal(results.filter(Boolean).length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("lease expiry never revives an old operation and external activity resets a running scheduler", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "machine-power-activity-"));
  try {
    const dbPath = path.join(dir, "state.sqlite3"); const a = new StorageService({ dbPath }).machinePower();
    const b = new StorageService({ dbPath }).machinePower(); let now = 100; let stops = 0;
    const scheduler = new MachineIdleScheduler({ state: a, bootId: "boot", uptimeMs: () => now, idleMs: 1000,
      isBusy: () => a.hasMaintenance("boot", now), prepareStop: async since => await a.tryFence("boot", now, "stop", since)
        ? async () => { stops++; } : undefined, onError: () => undefined });
    await scheduler.check();
    assert.equal(await b.maintenance("install", "boot", 200, 800), true);
    assert.equal(await b.maintenance("install", "boot", 900, 1800, true), false);
    assert.equal(await b.maintenance("install", "boot", 900, 1800), false);
    assert.equal(await a.hasMaintenance("boot", 1200), true, "an expired heartbeat does not prove the installer stopped");
    assert.equal(await a.tryFence("boot", 1200, "unsafe-expiry", 100), false);
    await b.releaseMaintenance("install", "boot"); now = 1200;
    await scheduler.check(); assert.equal(stops, 0, "release outside this process invalidated its original deadline");
    now = 2200; await scheduler.check(); assert.equal(stops, 1); scheduler.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
