import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { MachineIdlePower, assertNativeRegistryClosed, nativeRegistryHasLiveWork } from "./machineIdlePower";
import { capturePosixProcessIdentity } from "./processTermination";
import { MachineHostPowerRegistry } from "./machineHostPower";
import { assertCurrentAwsMachine } from "./awsMachineIdentity";
import { StorageService } from "./storage";
import { NativeProcessRegistry } from "./nativeProcessRegistry";
import { MACHINE_IDLE_STOP_MS } from "../../shared/machinePower";

const config = { version: 1 as const, instanceId: "i-0123456789abcdef0",
  credentials: { accessKeyId: "AKIAFAKEMACHINEPOWER1", secretAccessKey: "synthetic-power-secret", region: "us-east-1" } };
const identity = { machine: "a".repeat(64), boot: "a".repeat(32) };
/** A process that is certainly running: this test itself. */
const LIVE = capturePosixProcessIdentity(process.pid)!;
/** Identities no running process has. */
const GONE_PARENT = { pid: 1234, startedAt: "synthetic-parent" };
const GONE_SUPERVISOR = { pid: 1235, startedAt: "synthetic-guardian" };

test("a retained power stop survives runtime restart, never reopens admission and waits for native close receipts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-idle-power-"));
  const dbPath = path.join(dir, "state.sqlite3"); const nativePath = path.join(dir, "native.sqlite3");
  const store = new StorageService({ dbPath }).machinePower();
  let stops = 0; let fenced = false; let failedAws = true; let checks = 0;
  const host = { hasWorkForIdleStop: async () => false, recoverIdleFence: async () => Boolean(await store.stopFence(identity.boot)),
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
    createHostRegistry: options => new MachineHostPowerRegistry({ ...options, dir: path.join(dir, "host-power"), profilePath: dir }),
    client: { close: () => undefined, assertCanStop: async () => { checks++; },
      stopAfterDrain: async () => { stops++; if (failedAws) throw new Error("response lost"); return { instanceId: config.instanceId, state: "stopping" }; } }
  });
  let power: MachineIdlePower | undefined;
  try {
    await store.write({ version: 1, bootId: identity.boot, idleSinceMs: 1 });
    power = create(); await power.start(); await (power as any).scheduler.check();
    assert.equal(stops, 1); assert.equal(fenced, true);
    assert.equal(checks, 1, "the key is asked about, as a dry run, before any turn is fenced");
    assert.match(power.warning()!, /not confirmed/);
    assert.equal(await store.stopFence(identity.boot), "stop");
    power.close();
    const registry = new NativeProcessRegistry(nativePath); await registry.init();
    // A guardian still running has not proven anything about its agents.
    const lease = await registry.acquire({ scope: "chat:member", token: "owner", host: identity,
      parent: GONE_PARENT, supervisor: LIVE });
    assert.ok(lease);
    fenced = false; power = create(); await power.start();
    assert.equal(fenced, true, "retained intent fences native work before the link starts");
    power.ready();
    for (let attempt = 0; attempt < 100 && !power.warning()?.includes("processes are gone"); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.match(power.warning()!, /processes are gone/);
    await assert.rejects((power as any).stopAws(), /not confirmed that its processes are gone/);
    assert.equal(stops, 1, "a disappeared runtime whose guardian still runs is not a native-close receipt");
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
    await registry.acquire({ scope: "chat:member", token: "owner", host: identity, parent: GONE_PARENT, supervisor: LIVE });
    await assert.rejects(assertNativeRegistryClosed(registryPath, identity), /processes are gone/);
    await assertNativeRegistryClosed(registryPath, { ...identity, boot: "b".repeat(32) });
    assert.equal((await registry.get("chat:member"))?.shutdownReason, "host-rebooted");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a guardian killed with its runtime is closed once every process it recorded is gone, never while one runs", async () => {
  // A runtime under systemd that crashes takes its whole service with it,
  // guardians included, so no close receipt is ever written. On the User's
  // machine that kept the instance awake, and the member unable to start,
  // until the next reboot.
  const dir = await mkdtemp(path.join(tmpdir(), "accord-idle-killed-"));
  try {
    const registryPath = path.join(dir, "native.sqlite3"); const registry = new NativeProcessRegistry(registryPath);
    await registry.init();
    const running = await registry.acquire({ scope: "chat:a", token: "owner", host: identity, parent: GONE_PARENT, supervisor: GONE_SUPERVISOR });
    assert.ok(running);
    await registry.update({ ...running, phase: "running", provider: LIVE });
    assert.equal(await nativeRegistryHasLiveWork(registryPath, identity), true, "an agent still running keeps its lease");
    await assert.rejects(assertNativeRegistryClosed(registryPath, identity), /processes are gone/);
    await registry.update({ ...(await registry.get("chat:a"))!, provider: { pid: 1236, startedAt: "synthetic-provider" }, descendants: [LIVE] });
    assert.equal(await nativeRegistryHasLiveWork(registryPath, identity), true, "a captured descendant still running keeps it too");
    await registry.update({ ...(await registry.get("chat:a"))!, descendants: [{ pid: 1237, startedAt: "synthetic-child" }] });
    assert.equal(await nativeRegistryHasLiveWork(registryPath, identity), false);
    assert.equal((await registry.get("chat:a"))?.phase, "running", "reading another deployment's registry changes nothing");
    await assertNativeRegistryClosed(registryPath, identity);
    assert.equal((await registry.get("chat:a"))?.shutdownReason, "processes-gone");
    await registry.acquire({ scope: "chat:b", token: "owner", host: { ...identity, machine: "c".repeat(64) }, parent: GONE_PARENT, supervisor: GONE_SUPERVISOR });
    assert.equal(await nativeRegistryHasLiveWork(registryPath, identity), true, "pids from another host prove nothing here");
    assert.equal(await nativeRegistryHasLiveWork(path.join(dir, "never-ran.sqlite3"), identity), false,
      "a deployment that never started an agent has no registry");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a deployment sharing this instance keeps it awake, and its own claim is published", async () => {
  // Idle is measured per profile, the instance is shared. Before this, the
  // first profile to reach three hours would have stopped the instance under
  // another profile's provider turn or maintenance lease.
  const dir = await mkdtemp(path.join(tmpdir(), "accord-idle-shared-"));
  const shared = path.join(dir, "host-power");
  const dbPath = path.join(dir, "state.sqlite3");
  const store = new StorageService({ dbPath }).machinePower();
  let stops = 0;
  const host = {
    hasWorkForIdleStop: async () => false,
    recoverIdleFence: async () => Boolean(await store.stopFence(identity.boot)),
    retainIdleFence: () => undefined,
    publishPowerStatus: async () => undefined,
    shutdown: async () => undefined,
    prepareIdleStop: async () => async () => undefined
  };
  const runner = {
    hasActiveNativeWork: () => false,
    shutdownWarmAgents: async () => undefined,
    fenceIdleNativeAdmissions: () => () => undefined
  };
  // A shared host clock both sides read, so a neighbour's work can be placed
  // in time rather than assumed to be infinitely old.
  let now = MACHINE_IDLE_STOP_MS + 100;
  const neighbour = new MachineHostPowerRegistry({
    dir: shared, profilePath: "/home/ubuntu/.accordagents/other", bootId: identity.boot,
    uptimeMs: () => now, pid: 4321, isAlive: () => true
  });
  const power = new MachineIdlePower({
    config, store, host, runner, nativeProcessDbPath: path.join(dir, "native.sqlite3"),
    profilePath: "/home/ubuntu/.accordagents/mine", log: () => undefined
  }, {
    identity: async () => identity, verifyAws: async () => undefined,
    uptimeMs: () => now,
    createHostRegistry: options => new MachineHostPowerRegistry({ ...options, dir: shared, isAlive: () => true }),
    client: { close: () => undefined, assertCanStop: async () => undefined,
      stopAfterDrain: async () => { stops++; return { instanceId: config.instanceId, state: "stopping" }; } }
  });
  try {
    await store.write({ version: 1, bootId: identity.boot, idleSinceMs: 1 });
    await power.start();

    neighbour.publish(true);
    await (power as unknown as { scheduler: { check(): Promise<void> } }).scheduler.check();
    assert.equal(stops, 0, "a busy deployment on the same instance must prevent the stop");
    assert.equal(power.warning(), undefined, "agents working next door are the rule, not a fault to report");

    // This deployment's own state is visible to the others.
    const mine = neighbour.others().find((claim) => claim.profilePath === "/home/ubuntu/.accordagents/mine");
    assert.ok(mine, "the deployment publishes its own claim for the others to read");
    assert.equal(mine?.busy, false);

    // The neighbour goes idle, but it was working a moment ago: the host has
    // not been quiet for three hours, only this deployment has.
    neighbour.publish(false);
    await (power as unknown as { scheduler: { check(): Promise<void> } }).scheduler.check();
    assert.equal(stops, 0, "a neighbour's recent work is not three hours of host idle");
    assert.equal(power.warning(), undefined);

    // Once the whole host has been quiet for the window, the stop proceeds.
    now += MACHINE_IDLE_STOP_MS + 100;
    neighbour.publish(false);
    await (power as unknown as { scheduler: { check(): Promise<void> } }).scheduler.check();
    assert.equal(stops, 1, "once the host itself has been idle the stop proceeds");
  } finally {
    power.close();
    neighbour.release();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a stop key AWS refuses keeps the machine awake instead of fencing its turns", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-idle-refused-"));
  const store = new StorageService({ dbPath: path.join(dir, "state.sqlite3") }).machinePower();
  let prepared = 0; let stops = 0; let fenced = false; let checks = 0; let published = 0;
  let accepted = false; let now = MACHINE_IDLE_STOP_MS + 100;
  const host = { hasWorkForIdleStop: async () => false, recoverIdleFence: async () => Boolean(await store.stopFence(identity.boot)),
    retainIdleFence: () => { fenced = true; }, publishPowerStatus: async () => { published++; }, shutdown: async () => undefined,
    prepareIdleStop: async (request: { fenceNative(): unknown }) => { prepared++; request.fenceNative(); return async () => undefined; } };
  const runner = { hasActiveNativeWork: () => false, shutdownWarmAgents: async () => undefined,
    fenceIdleNativeAdmissions: () => { fenced = true; return () => { fenced = false; }; } };
  const warnings: string[] = [];
  // AWS appends a different encoded blob to every refusal.
  const refusal = () => Object.assign(new Error(`You are not authorized to perform this operation. Encoded authorization failure message: ${Math.random()}`),
    { name: "UnauthorizedOperation", $fault: "client" });
  const power = new MachineIdlePower({ config, store, host, runner, nativeProcessDbPath: path.join(dir, "native.sqlite3"),
    log: (event, payload) => { if (event === "machine.idle.status") warnings.push(String(payload.warning)); } }, {
    identity: async () => identity, verifyAws: async () => undefined, uptimeMs: () => now,
    createHostRegistry: options => new MachineHostPowerRegistry({ ...options, dir: path.join(dir, "host-power"), profilePath: dir }),
    client: { close: () => undefined, assertCanStop: async () => { checks++; if (!accepted) throw refusal(); },
      stopAfterDrain: async () => { stops++; return { instanceId: config.instanceId, state: "stopping" }; } }
  });
  try {
    await store.write({ version: 1, bootId: identity.boot, idleSinceMs: 1 });
    await power.start();
    // The scheduler's own error path, which is what runs every 15 s.
    const scheduler = (power as unknown as { scheduler: { check(): Promise<void>; options: { onError(error: unknown): void } } }).scheduler;
    const onError = scheduler.options.onError;
    await scheduler.check().catch(onError);
    assert.equal(prepared, 0, "no turn is fenced for a stop AWS would refuse");
    assert.equal(fenced, false);
    assert.equal(stops, 0);
    assert.equal(await store.stopFence(identity.boot), undefined, "nothing is retained across a restart");
    assert.match(warnings.at(-1) ?? "", /^Automatic idle stop is suspended: AWS does not accept this machine's stop key, so it stays awake \(UnauthorizedOperation: You are not authorized to perform this operation\.\)\.$/);
    const publishedAfterRefusal = published;

    // The scheduler polls every 15 s; a refused key is not asked again soon.
    now += 60_000;
    await scheduler.check().catch(onError);
    assert.equal(checks, 1, "a refused key is not asked about on every poll");
    assert.equal(published, publishedAfterRefusal, "the same refusal does not announce itself again");

    // After the back-off a refusal still reads the same, so nothing is resent.
    now += 31 * 60_000;
    await scheduler.check().catch(onError);
    assert.equal(checks, 2);
    assert.equal(published, publishedAfterRefusal, "a varying AWS message must not resend the machine's status");

    now += 31 * 60_000;
    accepted = true;
    await scheduler.check().catch(onError);
    assert.equal(checks, 3);
    assert.equal(stops, 1, "once AWS accepts the key the idle stop proceeds");
    assert.ok(warnings.indexOf("null") > warnings.findIndex((warning) => warning.includes("does not accept")),
      "and the refusal is no longer reported once AWS accepts the key");
  } finally { power.close(); await rm(dir, { recursive: true, force: true }); }
});

test("an AWS that cannot be reached is asked again on the next poll, not after the refusal back-off", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-idle-unreachable-"));
  const store = new StorageService({ dbPath: path.join(dir, "state.sqlite3") }).machinePower();
  let checks = 0; let prepared = 0;
  const host = { hasWorkForIdleStop: async () => false, recoverIdleFence: async () => Boolean(await store.stopFence(identity.boot)),
    retainIdleFence: () => undefined, publishPowerStatus: async () => undefined, shutdown: async () => undefined,
    prepareIdleStop: async () => { prepared++; return undefined; } };
  const runner = { hasActiveNativeWork: () => false, shutdownWarmAgents: async () => undefined, fenceIdleNativeAdmissions: () => () => undefined };
  const power = new MachineIdlePower({ config, store, host, runner, nativeProcessDbPath: path.join(dir, "native.sqlite3"), log: () => undefined }, {
    identity: async () => identity, verifyAws: async () => undefined, uptimeMs: () => MACHINE_IDLE_STOP_MS + 100,
    createHostRegistry: options => new MachineHostPowerRegistry({ ...options, dir: path.join(dir, "host-power"), profilePath: dir }),
    client: { close: () => undefined, assertCanStop: async () => { checks++; throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }); },
      stopAfterDrain: async () => ({ instanceId: config.instanceId, state: "stopping" }) }
  });
  try {
    await store.write({ version: 1, bootId: identity.boot, idleSinceMs: 1 });
    await power.start();
    const scheduler = (power as unknown as { scheduler: { check(): Promise<void> } }).scheduler;
    await scheduler.check().catch(() => undefined);
    await scheduler.check().catch(() => undefined);
    assert.equal(checks, 2, "a network failure says nothing about the key");
    assert.equal(prepared, 0, "and no turn is fenced for it");
  } finally { power.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a crashed deployment stops keeping the instance awake once its agents are gone; the User's switch can turn stopping off", async () => {
  // On the User's machine seven claims of runtimes that had crashed or were
  // killed counted as busy forever, so the instance ran for weeks.
  const dir = await mkdtemp(path.join(tmpdir(), "accord-idle-dead-claims-"));
  const shared = path.join(dir, "host-power");
  const store = new StorageService({ dbPath: path.join(dir, "state.sqlite3") }).machinePower();
  let stops = 0; let enabled = true;
  const live = new Set<string>();
  const host = { hasWorkForIdleStop: async () => false, recoverIdleFence: async () => Boolean(await store.stopFence(identity.boot)),
    retainIdleFence: () => undefined, publishPowerStatus: async () => undefined, shutdown: async () => undefined,
    prepareIdleStop: async (request: { commitHostStop?(prepare: () => Promise<boolean>): Promise<boolean> }) =>
      await request.commitHostStop?.(async () => true) ? async () => undefined : undefined };
  const runner = { hasActiveNativeWork: () => false, shutdownWarmAgents: async () => undefined, fenceIdleNativeAdmissions: () => () => undefined };
  const alive = new Set([4321]);
  const now = MACHINE_IDLE_STOP_MS * 3;
  const crashed = new MachineHostPowerRegistry({ dir: shared, profilePath: "/tmp/accord-choice-repro/machine", bootId: identity.boot,
    uptimeMs: () => 1_000, pid: 4321, isAlive: (pid) => alive.has(pid) });
  const power = new MachineIdlePower({ config, store, host, runner, nativeProcessDbPath: path.join(dir, "native.sqlite3"),
    profilePath: "/home/ubuntu/.accordagents/mine", enabled: async () => enabled, log: () => undefined }, {
    identity: async () => identity, verifyAws: async () => undefined, uptimeMs: () => now,
    createHostRegistry: options => new MachineHostPowerRegistry({ ...options, dir: shared, isAlive: (pid) => alive.has(pid) || pid === process.pid }),
    hasLiveNativeWork: async (profilePath) => live.has(profilePath),
    client: { close: () => undefined, assertCanStop: async () => undefined,
      stopAfterDrain: async () => { stops++; return { instanceId: config.instanceId, state: "stopping" }; } }
  });
  const check = () => (power as unknown as { scheduler: { check(): Promise<void> } }).scheduler.check();
  try {
    await store.write({ version: 1, bootId: identity.boot, idleSinceMs: 1 });
    crashed.publish(true);
    await power.start();
    await check();
    assert.equal(stops, 0, "a runtime that is still alive and busy keeps the instance up");
    alive.delete(4321);
    live.add("/tmp/accord-choice-repro/machine");
    await check();
    assert.equal(stops, 0, "its runtime died, but an agent it started is still running");
    assert.equal(power.warning(), undefined, "agents working are not a fault");
    live.clear();
    enabled = false;
    await check();
    assert.equal(stops, 0, "switched off, the machine never stops the instance");
    assert.equal(power.warning(), undefined, "and switched off is not a fault either");
    enabled = true;
    await check();
    assert.equal(stops, 1, "the dead runtime's claim no longer holds the instance");
    assert.deepEqual(new MachineHostPowerRegistry({ dir: shared, profilePath: "/home/ubuntu/.accordagents/probe", bootId: identity.boot,
      uptimeMs: () => now, isAlive: () => true }).others().map((claim) => claim.profilePath), ["/home/ubuntu/.accordagents/mine"],
    "its claim is gone from the host directory");
  } finally { power.close(); await rm(dir, { recursive: true, force: true }); }
});
