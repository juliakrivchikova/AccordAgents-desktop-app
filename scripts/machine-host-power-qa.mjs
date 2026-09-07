/**
 * Host-wide idle stop and admission, driven from separate processes.
 *
 * Every deployment on one instance shares that instance. These scenarios are
 * run with real OS processes and a real shared directory, because the failures
 * they are about — a turn admitted in the window a stop was deciding, a
 * neighbour with no power configuration, a guardian that outlives its runtime
 * — only exist between processes.
 *
 * The AWS call itself is not made here: the boundary is proven by a client
 * that records the call, and a real EC2 stop is not something this can claim.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "..");
const { MachineHostPowerRegistry } = require(path.join(repoRoot, "dist/main/main/services/machineHostPower.js"));

const log = (...args) => console.log("[host-power-qa]", ...args);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A deployment in its own process, driving the real registry. */
function deployment(shared, profile, script, options = {}) {
  const child = spawn(process.execPath, ["-e", `
    const { MachineHostPowerRegistry } = require(${JSON.stringify(path.join(repoRoot, "dist/main/main/services/machineHostPower.js"))});
    const registry = new MachineHostPowerRegistry({
      dir: ${JSON.stringify(shared)},
      profilePath: ${JSON.stringify(profile)},
      bootId: "qa-boot",
      kind: ${JSON.stringify(options.kind ?? "runtime")},
      uptimeMs: () => Number(process.env.QA_UPTIME_MS ?? Date.now())
    });
    const say = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    ${script}
  `], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...(options.env ?? {}) } });
  const out = [];
  const err = [];
  child.stdout.on("data", (chunk) => out.push(String(chunk)));
  child.stderr.on("data", (chunk) => err.push(String(chunk)));
  return {
    child,
    lines: () => out.join("").split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    stderr: () => err.join(""),
    done: new Promise((resolve) => child.once("close", (code) => resolve(code)))
  };
}

async function scenarioTwoDeployments(shared) {
  // A: idle and about to stop. B: starts a turn in the window between A
  // deciding and A making it final.
  const a = new MachineHostPowerRegistry({ dir: shared, profilePath: "/srv/a", bootId: "qa-boot", uptimeMs: () => 100_000, pid: process.pid });
  a.publish(false);
  const b = deployment(shared, "/srv/b", `
    registry.publish(false);
    say({ ready: true });
    setTimeout(() => {
      const decision = registry.admit("a turn");
      say({ admitted: decision.admitted, reason: decision.reason ?? null });
    }, 300);
  `, { env: { QA_UPTIME_MS: "100000" } });
  await waitForLine(b, (line) => line.ready);

  assert.equal(a.beginStop({ minIdleMs: 0, ownIdleSinceUptimeMs: 0 }), true, "an idle host may be stopped");
  await wait(600);
  const admitted = b.lines().find((line) => line.admitted !== undefined);
  assert.equal(admitted?.admitted, true, "the other deployment starts its turn");
  assert.equal(a.commitStop(), false, "and the stop cannot be made final over it");
  assert.equal(a.stopIntent(), undefined, "the withdrawn intent does not linger");
  b.child.kill("SIGKILL");
  await b.done;
  log("two deployments: a turn started next door beat the stop");
}

async function scenarioStartDuringStop(shared) {
  const a = new MachineHostPowerRegistry({ dir: shared, profilePath: "/srv/a2", bootId: "qa-boot", uptimeMs: () => 200_000, pid: process.pid });
  a.publish(false);
  assert.equal(a.beginStop({ minIdleMs: 0, ownIdleSinceUptimeMs: 0 }), true);
  assert.equal(a.commitStop(), true, "nothing objected, so the stop is final");

  // B starts after the stop is final: it must be refused, not run into an
  // instance that is going away.
  const b = deployment(shared, "/srv/b2", `
    const decision = registry.admit("a turn");
    say({ admitted: decision.admitted, reason: decision.reason ?? null });
  `, { env: { QA_UPTIME_MS: "200000" } });
  await b.done;
  const [decision] = b.lines();
  assert.equal(decision.admitted, false, "a committed stop refuses new work");
  assert.match(decision.reason, /stopping after being idle/);
  assert.match(decision.reason, /\/srv\/a2/, "and names the deployment that decided it");
  log("start during a final stop: refused with a reason naming the decider");
  a.abandonStop();
  // A committed intent is not withdrawn by abandon; clear it for the next case.
  await rm(path.join(shared, "stop-intent.json"), { force: true });
}

async function scenarioShortWorkBetweenTicks(shared) {
  let now = 300_000;
  const a = new MachineHostPowerRegistry({ dir: shared, profilePath: "/srv/a3", bootId: "qa-boot", uptimeMs: () => now, pid: process.pid });
  a.publish(false);
  // A neighbour does a short piece of work and finishes between two of A's
  // polls. A has been idle for hours; the host has not.
  // The neighbour stays running and idle afterwards, as a deployment does
  // between turns; its work is still recent.
  const b = deployment(shared, "/srv/b3", `
    registry.publish(true);
    registry.publish(false);
    say({ worked: true });
    setInterval(() => undefined, 1000);
  `, { env: { QA_UPTIME_MS: String(now) } });
  await waitForLine(b, (line) => line.worked);
  assert.equal(a.hostIdleForMs(0), 0, "the host was working a moment ago");
  assert.equal(a.beginStop({ minIdleMs: 60_000, ownIdleSinceUptimeMs: 0 }), false, "a short turn next door keeps the host awake");
  now += 90_000;
  assert.equal(a.beginStop({ minIdleMs: 60_000, ownIdleSinceUptimeMs: 0 }), true, "and stops blocking once the host is quiet");
  a.abandonStop();
  b.child.kill("SIGKILL");
  await b.done;
  log("short work between ticks: counted as host activity, not swallowed");
}

async function scenarioNeighbourWithoutPowerConfig(shared, userDataRoot) {
  // The runtime publishes its claim from its own start, not from the power
  // service, so a deployment with no AWS configuration is still visible.
  const profile = path.join(userDataRoot, "no-power");
  await mkdir(profile, { recursive: true });
  const b = deployment(shared, profile, `
    registry.publish(true);
    say({ published: true });
    setTimeout(() => say({ alive: true }), 400);
  `, { env: { QA_UPTIME_MS: "400000" } });
  await waitForLine(b, (line) => line.published);
  const a = new MachineHostPowerRegistry({ dir: shared, profilePath: "/srv/a4", bootId: "qa-boot", uptimeMs: () => 400_000, pid: process.pid });
  a.publish(false);
  const reason = a.blockingReason();
  assert.ok(reason, "a deployment without power configuration still keeps the host awake");
  assert.match(reason, new RegExp(profile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(a.beginStop({ minIdleMs: 0, ownIdleSinceUptimeMs: 0 }), false);
  b.child.kill("SIGKILL");
  await b.done;
  log("neighbour without power config: visible and blocking");
}

async function scenarioMaintenance(shared) {
  const maintenance = deployment(shared, "/srv/maint", `
    const decision = registry.admit("this maintenance command");
    say({ admitted: decision.admitted });
    setTimeout(() => say({ holding: true }), 400);
  `, { kind: "maintenance", env: { QA_UPTIME_MS: "500000" } });
  await waitForLine(maintenance, (line) => line.admitted !== undefined);
  const a = new MachineHostPowerRegistry({ dir: shared, profilePath: "/srv/a5", bootId: "qa-boot", uptimeMs: () => 500_000, pid: process.pid });
  a.publish(false);
  assert.match(a.blockingReason() ?? "", /maintenance command/, "maintenance is host-wide work");
  assert.equal(a.beginStop({ minIdleMs: 0, ownIdleSinceUptimeMs: 0 }), false);
  maintenance.child.kill("SIGKILL");
  await maintenance.done;
  assert.ok(a.blockingReason(), "a killed maintenance process does not prove its command is gone");
  log("maintenance: blocks the stop, and a kill does not clear it");
}

async function scenarioKilledRuntimeWithLiveDescendant(shared) {
  // A runtime is killed while a process it started is still running. The dead
  // owner is not proof that its descendant died with it.
  const marker = path.join(shared, "descendant.txt");
  const runtime = deployment(shared, "/srv/hung", `
    const { spawn } = require("node:child_process");
    registry.publish(true);
    const marker = ${JSON.stringify(marker)};
    const child = spawn(process.execPath, ["-e", "const f=process.argv[1];setInterval(()=>require('node:fs').writeFileSync(f,String(Date.now())),100)", marker], { detached: true, stdio: "ignore" });
    child.unref();
    say({ descendant: child.pid });
    setInterval(() => undefined, 1000);
  `, { env: { QA_UPTIME_MS: "600000" } });
  const [{ descendant }] = await waitForLine(runtime, (line) => line.descendant);
  runtime.child.kill("SIGKILL");
  await runtime.done;

  const a = new MachineHostPowerRegistry({ dir: shared, profilePath: "/srv/a6", bootId: "qa-boot", uptimeMs: () => 600_000, pid: process.pid });
  a.publish(false);
  assert.ok(a.blockingReason(), "a killed runtime keeps the host awake; its descendant is still running");
  assert.equal(a.beginStop({ minIdleMs: 0, ownIdleSinceUptimeMs: 0 }), false);
  const before = await readFile(marker, "utf8").catch(() => "");
  await wait(300);
  const after = await readFile(marker, "utf8").catch(() => "");
  assert.notEqual(before, after, "the descendant really is alive during the check");
  process.kill(descendant, "SIGKILL");
  log("killed runtime with a live descendant: host stays awake");
}

async function scenarioPersistenceFailure(shared) {
  const a = new MachineHostPowerRegistry({ dir: shared, profilePath: "/srv/a7", bootId: "qa-boot", uptimeMs: () => 700_000, pid: process.pid });
  a.publish(false);
  await writeFile(path.join(shared, "stop-intent.json"), "{ not json");
  assert.throws(() => a.admit("a turn"), /cannot be read/, "unreadable coordination is not permission to start work");
  assert.throws(() => a.beginStop({ minIdleMs: 0, ownIdleSinceUptimeMs: 0 }), /cannot be read/, "and not permission to stop either");
  await rm(path.join(shared, "stop-intent.json"), { force: true });
  log("persistence failure: refuses both admission and stopping");
}

async function scenarioRestartDuringFence(shared, userDataRoot) {
  // A deployment commits a stop and dies before the instance goes away. Its
  // own restart clears the host-wide intent once its native work is proven
  // closed — otherwise one crash disables every deployment's work until the
  // host reboots.
  const profile = path.join(userDataRoot, "restarting");
  await mkdir(profile, { recursive: true });
  const first = deployment(shared, profile, `
    registry.publish(false);
    say({ began: registry.beginStop({ minIdleMs: 0, ownIdleSinceUptimeMs: 0 }) });
    say({ committed: registry.commitStop() });
    setInterval(() => undefined, 1000);
  `, { env: { QA_UPTIME_MS: "800000" } });
  await waitForLine(first, (line) => line.committed !== undefined);
  assert.deepEqual(first.lines(), [{ began: true }, { committed: true }]);
  first.child.kill("SIGKILL");
  await first.done;

  const other = new MachineHostPowerRegistry({ dir: shared, profilePath: "/srv/a8", bootId: "qa-boot", uptimeMs: () => 800_000, pid: process.pid });
  const refused = other.admit("a turn");
  assert.equal(refused.admitted, false, "the committed stop still holds after its owner died");

  const restarted = new MachineHostPowerRegistry({ dir: shared, profilePath: profile, bootId: "qa-boot", uptimeMs: () => 800_000, pid: process.pid });
  await assert.rejects(
    () => restarted.adoptOwnStaleClaims(async () => { throw new Error("a native executor has not confirmed that its processes are gone"); }),
    /processes are gone/,
    "an unproven restart does not clear its own fence"
  );
  assert.equal(other.admit("a turn").admitted, false, "so work is still refused");
  const cleared = await restarted.adoptOwnStaleClaims(async () => undefined);
  assert.ok(cleared >= 1, "proven closure clears the crashed deployment's claim and intent");
  assert.equal(other.admit("a turn").admitted, true, "and the host is usable again after a normal restart");
  log("restart during a fence: cleared only with proven closure, never left permanent");
}

async function scenarioSharedIdleOneStopIntent(shared) {
  await rm(path.join(shared, "stop-intent.json"), { force: true });
  for (const name of await readdir(shared)) {
    if (name.endsWith(".json")) await rm(path.join(shared, name), { force: true });
  }
  let now = 900_000;
  const registries = ["/srv/x", "/srv/y", "/srv/z"].map((profile) =>
    new MachineHostPowerRegistry({ dir: shared, profilePath: profile, bootId: "qa-boot", uptimeMs: () => now, pid: process.pid }));
  for (const registry of registries) registry.publish(false);
  now += 120_000;
  // Each of them polls on its own timer and republishes; a claim that stopped
  // being refreshed would count as busy, which is a different scenario.
  for (const registry of registries) registry.publish(false);

  // All three decide at once; exactly one intent may exist.
  const began = registries.map((registry) => registry.beginStop({ minIdleMs: 60_000, ownIdleSinceUptimeMs: 0 }));
  assert.equal(began.filter(Boolean).length, 1, "exactly one deployment takes the stop");
  const winner = registries[began.indexOf(true)];
  assert.equal(winner.commitStop(), true);
  const intents = (await readdir(shared)).filter((name) => name === "stop-intent.json");
  assert.deepEqual(intents, ["stop-intent.json"], "one intent file, not one per deployment");
  for (const registry of registries) {
    if (registry === winner) continue;
    assert.equal(registry.beginStop({ minIdleMs: 60_000, ownIdleSinceUptimeMs: 0 }), false, "the others do not stop it a second time");
  }
  log("shared idle: exactly one stop intent");
}

async function scenarioAwsBoundary() {
  // The AWS call is the last step and happens only after everything above.
  // Proven here by the client the runtime uses, recorded rather than made.
  const { MachineIdlePower } = require(path.join(repoRoot, "dist/main/main/services/machineIdlePower.js"));
  const { StorageService } = require(path.join(repoRoot, "dist/main/main/services/storage.js"));
  const dir = await mkdtemp(path.join(tmpdir(), "accord-power-aws-"));
  const store = new StorageService({ dbPath: path.join(dir, "state.sqlite3") }).machinePower();
  const shared = path.join(dir, "host-power");
  const identity = { machine: "b".repeat(64), boot: "b".repeat(32) };
  const MACHINE_IDLE_STOP_MS = require(path.join(repoRoot, "dist/main/shared/machinePower.js")).MACHINE_IDLE_STOP_MS;
  let now = MACHINE_IDLE_STOP_MS + 1000;
  const calls = [];
  const host = {
    hasWorkForIdleStop: async () => false, retainIdleFence: () => undefined,
    publishPowerStatus: async () => undefined, shutdown: async () => undefined,
    prepareIdleStop: async () => async () => undefined
  };
  const runner = { hasActiveNativeWork: () => false, shutdownWarmAgents: async () => undefined, fenceIdleNativeAdmissions: () => () => undefined };
  const power = new MachineIdlePower({
    config: { version: 1, instanceId: "i-0123456789abcdef0", credentials: { accessKeyId: "AKIAQAONLYNOTREAL01", secretAccessKey: "qa-not-a-real-secret", region: "us-east-1" } },
    store, host, runner, nativeProcessDbPath: path.join(dir, "native.sqlite3"),
    profilePath: path.join(dir, "profile"), log: () => undefined
  }, {
    identity: async () => identity, verifyAws: async () => { calls.push("verify"); }, uptimeMs: () => now,
    createHostRegistry: (options) => new MachineHostPowerRegistry({ ...options, dir: shared, isAlive: () => true }),
    client: { close: () => undefined, stopAfterDrain: async () => { calls.push("stop"); return { instanceId: "i-0123456789abcdef0", state: "stopping" }; } }
  });
  try {
    await store.write({ version: 1, bootId: identity.boot, idleSinceMs: 1 });
    await power.start();

    // A neighbour that is busy: no AWS call may be made at all.
    const neighbour = new MachineHostPowerRegistry({ dir: shared, profilePath: "/srv/neighbour", bootId: identity.boot, uptimeMs: () => now, pid: process.pid, isAlive: () => true });
    neighbour.publish(true);
    await power.scheduler.check();
    assert.deepEqual(calls, [], "a busy neighbour stops the flow before AWS is touched");

    neighbour.publish(false);
    now += MACHINE_IDLE_STOP_MS + 1000;
    // The neighbour is still running and still polling; it is simply idle.
    neighbour.publish(false);
    await power.scheduler.check();
    assert.deepEqual(calls, ["verify", "verify", "stop"], "AWS is verified before and at the stop, and stopped exactly once");
    neighbour.release();
  } finally {
    power.close();
    await rm(dir, { recursive: true, force: true });
  }
  log("AWS boundary: no call while the host is busy, one stop when it is not (call recorded, not made)");
}

async function waitForLine(process_, predicate) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const lines = process_.lines();
    const found = lines.filter(predicate);
    if (found.length) return found;
    if (Date.now() > deadline) throw new Error(`timed out; stderr: ${process_.stderr().slice(0, 400)}`);
    await wait(50);
  }
}

async function main() {
  if (spawnSync("uname").status !== 0) throw new Error("This QA needs a POSIX host.");
  const root = await mkdtemp(path.join(tmpdir(), "accord-host-power-qa-"));
  const userDataRoot = path.join(root, "profiles");
  await mkdir(userDataRoot, { recursive: true });
  // Each scenario gets its own host directory: a deployment killed in one of
  // them keeps its host awake on purpose, which is the behaviour under test
  // rather than something to carry into the next scenario.
  let index = 0;
  const freshShared = async () => {
    const dir = path.join(root, `host-power-${index++}`);
    await mkdir(dir, { recursive: true });
    return dir;
  };
  let lastShared = "";
  try {
    await scenarioTwoDeployments(lastShared = await freshShared());
    await scenarioStartDuringStop(lastShared = await freshShared());
    await scenarioShortWorkBetweenTicks(lastShared = await freshShared());
    await scenarioNeighbourWithoutPowerConfig(lastShared = await freshShared(), userDataRoot);
    await scenarioMaintenance(lastShared = await freshShared());
    await scenarioKilledRuntimeWithLiveDescendant(lastShared = await freshShared());
    await scenarioPersistenceFailure(lastShared = await freshShared());
    await scenarioRestartDuringFence(lastShared = await freshShared(), userDataRoot);
    await scenarioSharedIdleOneStopIntent(lastShared = await freshShared());
    await scenarioAwsBoundary();

    // What this leaves on the host, measured rather than assumed.
    const names = await readdir(lastShared);
    let bytes = 0;
    for (const name of names) {
      const contents = await readFile(path.join(lastShared, name)).catch(() => Buffer.alloc(0));
      bytes += contents.length;
    }
    log(`host directory after three deployments and one stop: ${names.length} entries, ${bytes} bytes`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  log("PASS");
}

main().catch((error) => { console.error("[host-power-qa] FAILED", error); process.exit(1); });
