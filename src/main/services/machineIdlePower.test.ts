import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { MachineIdlePower, assertNativeRegistryClosed } from "./machineIdlePower";
import { assertCurrentAwsMachine } from "./awsMachineIdentity";
import { StorageService } from "./storage";
import { NativeProcessRegistry } from "./nativeProcessRegistry";
import { MACHINE_IDLE_STOP_MS } from "../../shared/machinePower";

const config = { version: 1 as const, instanceId: "i-0123456789abcdef0",
  credentials: { accessKeyId: "AKIAFAKEMACHINEPOWER1", secretAccessKey: "synthetic-power-secret", region: "us-east-1" } };
const identity = { machine: "a".repeat(64), boot: "a".repeat(32) };

test("a retained power stop survives runtime restart, never reopens admission and waits for native close receipts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-idle-power-"));
  const dbPath = path.join(dir, "state.sqlite3"); const nativePath = path.join(dir, "native.sqlite3");
  const store = new StorageService({ dbPath }).machinePower();
  let stops = 0; let fenced = false; let failedAws = true;
  const host = { hasWorkForIdleStop: async () => false,
    retainIdleFence: () => { fenced = true; }, publishPowerStatus: async () => undefined, shutdown: async () => undefined,
    prepareIdleStop: async (request: any) => {
      if (!request.fenceNative()) return undefined;
      if (!await store.tryFence(identity.boot, MACHINE_IDLE_STOP_MS + 100, "stop", request.idleSinceMs)) return undefined;
      return async () => undefined;
    } };
  const runner = { hasActiveNativeWork: () => false, shutdownWarmAgents: async () => undefined,
    fenceIdleNativeAdmissions: () => { fenced = true; return () => { fenced = false; }; } };
  const create = () => new MachineIdlePower({ config, store, host, runner, nativeProcessDbPath: nativePath, log: () => undefined }, {
    identity: async () => identity, verifyAws: async () => undefined, uptimeMs: () => MACHINE_IDLE_STOP_MS + 100,
    client: { close: () => undefined, stopAfterDrain: async () => { stops++; if (failedAws) throw new Error("response lost"); return { instanceId: config.instanceId, state: "stopping" }; } }
  });
  let power: MachineIdlePower | undefined;
  try {
    await store.write({ version: 1, bootId: identity.boot, idleSinceMs: 1 });
    power = create(); await power.start(); await (power as any).scheduler.check();
    assert.equal(stops, 1); assert.equal(fenced, true);
    assert.match(power.warning()!, /not confirmed/);
    assert.equal(await store.stopFence(identity.boot), "stop");
    power.close();
    const registry = new NativeProcessRegistry(nativePath); await registry.init();
    const lease = await registry.acquire({ scope: "chat:member", token: "owner", host: identity,
      parent: { pid: 1234, startedAt: "synthetic-parent" }, supervisor: { pid: 1235, startedAt: "synthetic-guardian" } });
    assert.ok(lease);
    fenced = false; power = create(); await power.start();
    assert.equal(fenced, true, "retained intent fences native work before the link starts");
    power.ready();
    for (let attempt = 0; attempt < 100 && !power.warning()?.includes("processes are gone"); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.match(power.warning()!, /processes are gone/);
    await assert.rejects((power as any).stopAws(), /not confirmed that its processes are gone/);
    assert.equal(stops, 1, "a disappeared runtime is not a native-close receipt");
    await registry.update({ ...lease, phase: "closed", shutdownReason: "processes-gone" });
    failedAws = false; await (power as any).stopAws();
    assert.equal(stops, 2); assert.equal(fenced, true);
    assert.match(power.warning()!, /stopping/);
    power.close();
    await store.write({ version: 1, bootId: "b".repeat(32), idleSinceMs: 1 });
    assert.equal(await store.stopFence("b".repeat(32)), undefined);
  } finally { power?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("the runtime never issues power requests for a different instance and IMDS receives no AWS key", async () => {
  const calls: Array<{ url: string; options: RequestInit }> = [];
  let instanceId = config.instanceId;
  const request = (async (url: string | URL | Request, options?: RequestInit) => {
    calls.push({ url: String(url), options: options! });
    return new Response(String(url).endsWith("api/token") ? "test-metadata-token" : JSON.stringify({ region: "us-east-1", instanceId }));
  }) as typeof fetch;
  await assertCurrentAwsMachine(config, request);
  assert.equal(calls[0].options.method, "PUT");
  assert.equal(calls.every(call => call.url.startsWith("http://169.254.169.254/latest/") && call.options.redirect === "error"), true);
  assert.equal(JSON.stringify(calls).includes(config.credentials.accessKeyId), false);
  assert.equal(JSON.stringify(calls).includes(config.credentials.secretAccessKey), false);
  instanceId = "i-11111111111111111";
  await assert.rejects(assertCurrentAwsMachine(config, request), /different AWS machine/);
});

test("idle recovery accepts a verified host reboot but refuses missing native process receipts on the same boot", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-idle-native-"));
  try {
    const registryPath = path.join(dir, "native.sqlite3"); const registry = new NativeProcessRegistry(registryPath);
    await registry.init();
    await registry.acquire({ scope: "chat:member", token: "owner", host: identity,
      parent: { pid: 1234, startedAt: "parent" }, supervisor: { pid: 1235, startedAt: "guardian" } });
    await assert.rejects(assertNativeRegistryClosed(registryPath, identity), /processes are gone/);
    await assertNativeRegistryClosed(registryPath, { ...identity, boot: "b".repeat(32) });
    assert.equal((await registry.get("chat:member"))?.shutdownReason, "host-rebooted");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
