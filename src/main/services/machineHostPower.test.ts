import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import {
  MachineHostPowerRegistry,
  machineHostProfileId,
  type MachineHostClaim
} from "./machineHostPower";

function dir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "accord-host-power-"));
}

function registry(options: {
  dir: string;
  profile: string;
  boot?: string;
  now?: () => number;
  pid?: number;
  alive?: (pid: number) => boolean;
  kind?: "runtime" | "maintenance";
}): MachineHostPowerRegistry {
  return new MachineHostPowerRegistry({
    dir: options.dir,
    profilePath: options.profile,
    bootId: options.boot ?? "boot-1",
    uptimeMs: options.now ?? (() => 1_000),
    pid: options.pid ?? 4242,
    kind: options.kind,
    isAlive: options.alive ?? (() => true)
  });
}

test("a busy deployment on the same host blocks another deployment's idle stop", () => {
  const shared = dir();
  const a = registry({ dir: shared, profile: "/home/ubuntu/.accordagents/one", pid: 11 });
  const b = registry({ dir: shared, profile: "/home/ubuntu/.accordagents/two", pid: 22 });

  a.publish(false);
  b.publish(false);
  assert.equal(a.blockingReason(), undefined, "two idle deployments do not block each other");

  b.publish(true);
  const reason = a.blockingReason();
  assert.match(reason ?? "", /Another deployment on this machine/);
  assert.match(reason ?? "", /\/home\/ubuntu\/\.accordagents\/two/);
  assert.match(reason ?? "", /running work/);

  b.publish(false);
  assert.equal(a.blockingReason(), undefined);
});

test("a maintenance command blocks a stop and says so", () => {
  const shared = dir();
  const runtime = registry({ dir: shared, profile: "/p/runtime", pid: 11 });
  const maintenance = registry({ dir: shared, profile: "/p/upgrade", pid: 22, kind: "maintenance" });
  runtime.publish(false);
  maintenance.publish(true);
  assert.match(runtime.blockingReason() ?? "", /running a maintenance command/);
});

test("a live deployment that stopped refreshing counts as busy, never as idle", () => {
  const shared = dir();
  let now = 1_000;
  const a = registry({ dir: shared, profile: "/p/a", pid: 11, now: () => now });
  const stalled = registry({ dir: shared, profile: "/p/b", pid: 22, now: () => now });
  a.publish(false);
  stalled.publish(false);
  assert.equal(a.blockingReason(), undefined);
  // Its process is still alive but it has not written for longer than the
  // stale window: a hung runtime must not be read as "idle, safe to stop".
  now += 120_000;
  assert.match(a.blockingReason() ?? "", /Another deployment on this machine/);
});

test("a dead owner still blocks until shutdown is proven; an earlier boot is pruned", () => {
  const shared = dir();
  const a = registry({ dir: shared, profile: "/p/a", pid: 11, alive: (pid) => pid === 11 });
  registry({ dir: shared, profile: "/p/dead", pid: 99, alive: () => true }).publish(true);
  const oldBoot = registry({ dir: shared, profile: "/p/old", boot: "boot-0", pid: 77 });
  oldBoot.publish(true);
  a.publish(false);

  assert.match(a.blockingReason() ?? "", /\/p\/dead/, "a dead controller can leave native work behind");
  const remaining = fs.readdirSync(shared).sort();
  assert.equal(remaining.length, 2);
  assert.ok(remaining.some(name => name.startsWith(`${machineHostProfileId("/p/a")}-`)));
  assert.ok(remaining.some(name => name.startsWith(`${machineHostProfileId("/p/dead")}-`)));
});

test("damaged and invalid claims suspend idle stop and retain the evidence", () => {
  const shared = dir();
  const a = registry({ dir: shared, profile: "/p/a", pid: 11 });
  a.publish(false);
  fs.writeFileSync(path.join(shared, "broken.json"), "{ not json");
  fs.writeFileSync(path.join(shared, "wrong.json"), JSON.stringify({ version: 9, profileId: "x" }));
  assert.throws(() => a.blockingReason(), /cannot be verified/);
  assert.equal(fs.existsSync(path.join(shared, "broken.json")), true);
  assert.equal(fs.existsSync(path.join(shared, "wrong.json")), true);
});

test("releasing a deployment stops it blocking the others", () => {
  const shared = dir();
  const a = registry({ dir: shared, profile: "/p/a", pid: 11 });
  const b = registry({ dir: shared, profile: "/p/b", pid: 22 });
  a.publish(false);
  b.publish(true);
  assert.notEqual(a.blockingReason(), undefined);
  b.release();
  assert.equal(a.blockingReason(), undefined);
  assert.throws(() => b.publish(true), /released/, "a caller must not believe it still publishes after releasing the registry");
  assert.equal(a.blockingReason(), undefined);
});

test("an unreadable claim directory never appears as an idle host", () => {
  const shared = dir();
  const a = registry({ dir: shared, profile: "/p/a" });
  a.publish(false);
  fs.rmSync(shared, { recursive: true });
  fs.writeFileSync(shared, "unreadable as a directory");
  assert.throws(() => a.blockingReason(), /ENOTDIR/);
});

test("each instance keeps a distinct claim that an earlier instance cannot overwrite or release", () => {
  const shared = dir();
  const a = registry({ dir: shared, profile: "/p/a", pid: 11 });
  const replacement = registry({ dir: shared, profile: "/p/a", pid: 22 });
  a.publish(false);
  replacement.publish(true);
  assert.equal(fs.readdirSync(shared).length, 2);
  a.publish(false);
  assert.match(a.blockingReason() ?? "", /running work/);
  a.release();
  assert.equal(fs.readdirSync(shared).length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(shared, fs.readdirSync(shared)[0]), "utf8")).pid, 22);
});

test("a claim survives a reader that cannot remove it", () => {
  const shared = dir();
  const a = registry({ dir: shared, profile: "/p/a", pid: 11 });
  a.publish(false);
  const file = path.join(shared, fs.readdirSync(shared)[0]);
  const claim = JSON.parse(fs.readFileSync(file, "utf8")) as MachineHostClaim;
  assert.equal(claim.profilePath, "/p/a");
  assert.equal(claim.kind, "runtime");
  assert.equal(claim.bootId, "boot-1");
});

test("a stop cannot commit around work admitted while it was draining", async () => {
  // The window a plain read leaves open: one deployment decides to stop, the
  // other starts a turn, and the stop still goes through. Admission and commit
  // take the same host lock, so the second one loses.
  const shared = dir();
  const stopper = registry({ dir: shared, profile: "/srv/one", pid: 11 });
  const neighbour = registry({ dir: shared, profile: "/srv/two", pid: 22 });
  stopper.publish(false);
  neighbour.publish(false);

  assert.equal(await stopper.beginStop({ minIdleMs: 0, ownIdleSinceUptimeMs: 0 }), true, "an idle host may be stopped");
  // The neighbour starts work before the stop is final.
  assert.deepEqual(await neighbour.admit("a turn"), { admitted: true });
  assert.equal(await stopper.commitStop(), false, "work admitted meanwhile withdraws the stop");
  assert.equal(stopper.stopIntent(), undefined, "and the intent is gone, not left blocking the host");

  // With nobody working, the same sequence commits.
  neighbour.publish(false);
  assert.equal(await stopper.beginStop({ minIdleMs: 0, ownIdleSinceUptimeMs: 0 }), true);
  assert.equal(await stopper.commitStop(), true);
  assert.equal(stopper.stopIntent()?.phase, "committed");
});

test("a committed stop refuses new work instead of letting it start into a machine that is going away", async () => {
  const shared = dir();
  const stopper = registry({ dir: shared, profile: "/srv/one", pid: 11 });
  const neighbour = registry({ dir: shared, profile: "/srv/two", pid: 22 });
  stopper.publish(false);
  neighbour.publish(false);
  assert.equal(await stopper.beginStop({ minIdleMs: 0, ownIdleSinceUptimeMs: 0 }), true);
  assert.equal(await stopper.commitStop(), true);

  const refused = await neighbour.admit("a turn");
  assert.equal(refused.admitted, false);
  assert.match(refused.admitted === false ? refused.reason : "", /stopping after being idle/);
  assert.match(refused.admitted === false ? refused.reason : "", /\/srv\/one/, "the deployment that decided it is named");
});

test("a neighbour's recent work is not this profile's three hours of idle", async () => {
  const shared = dir();
  let now = 10_000;
  const mine = registry({ dir: shared, profile: "/srv/one", pid: 11, now: () => now });
  const neighbour = registry({ dir: shared, profile: "/srv/two", pid: 22, now: () => now });

  neighbour.publish(true);
  neighbour.publish(false);
  mine.publish(false);
  // This profile has been idle since uptime 0, but the host has not: the
  // neighbour was working at this very moment.
  assert.equal(mine.hostIdleForMs(0), 0, "the neighbour was working a moment ago");
  now += 30_000;
  assert.equal(mine.hostIdleForMs(0), 30_000, "host idle runs from the neighbour's last work, not from this profile's");
  assert.equal(await mine.beginStop({ minIdleMs: 60_000, ownIdleSinceUptimeMs: 0 }), false);
  now += 40_000;
  assert.equal(await mine.beginStop({ minIdleMs: 60_000, ownIdleSinceUptimeMs: 0 }), true);
});

test("a claim left by a crash keeps the host awake, and only proven closure clears it", async () => {
  const shared = dir();
  const crashed = registry({ dir: shared, profile: "/srv/one", pid: 4242, alive: () => false });
  crashed.publish(false);

  // Same profile, new instance: the dead owner is not proof its providers died.
  const restarted = registry({ dir: shared, profile: "/srv/one", pid: 4243, alive: (pid) => pid === 4243 });
  assert.ok(restarted.blockingReason(), "a dead owner's claim still keeps the host awake");

  let proved = 0;
  await assert.rejects(
    () => restarted.adoptOwnStaleClaims(async () => { proved += 1; throw new Error("a native executor has not confirmed that its processes are gone"); }),
    /processes are gone/,
    "closure that cannot be proven leaves the claim in place"
  );
  assert.equal(proved, 1);
  assert.ok(restarted.blockingReason());

  assert.equal(await restarted.adoptOwnStaleClaims(async () => undefined), 1, "proven closure clears this profile's own claim");
  assert.equal(restarted.blockingReason(), undefined, "and automatic stop is not disabled until the host reboots");
});

test("one deployment's crash does not let it clear another profile's claim", async () => {
  const shared = dir();
  const other = registry({ dir: shared, profile: "/srv/two", pid: 999, alive: () => false });
  other.publish(false);
  const mine = registry({ dir: shared, profile: "/srv/one", pid: 4243, alive: (pid) => pid === 4243 });
  assert.equal(await mine.adoptOwnStaleClaims(async () => undefined), 0, "only this profile's own leftovers are cleared");
  assert.ok(mine.blockingReason(), "the other profile still keeps the host awake");
});


test("an unreadable stop intent stops both stopping and admitting", async () => {
  const shared = dir();
  const one = registry({ dir: shared, profile: "/srv/one", pid: 11 });
  one.publish(false);
  fs.writeFileSync(path.join(shared, "stop-intent.json"), "{\"version\":1,\"phase\":\"maybe\"}");
  assert.throws(() => one.stopIntent(), /cannot be read/);
  await assert.rejects(() => one.admit("a turn"), /cannot be read/);
  await assert.rejects(() => one.beginStop({ minIdleMs: 0, ownIdleSinceUptimeMs: 0 }), /cannot be read/);
});

test("maintenance is a host claim like any other and names itself", async () => {
  const shared = dir();
  const runtime = registry({ dir: shared, profile: "/srv/one", pid: 11 });
  const maintenance = registry({ dir: shared, profile: "/srv/two", pid: 22, kind: "maintenance" });
  runtime.publish(false);
  assert.deepEqual(await maintenance.admit("this maintenance command"), { admitted: true });
  assert.match(runtime.blockingReason() ?? "", /maintenance command/);
  assert.equal(await runtime.beginStop({ minIdleMs: 0, ownIdleSinceUptimeMs: 0 }), false);
  maintenance.release();
  assert.equal(runtime.blockingReason(), undefined);
});


test("kernel admission lock excludes concurrent owners and releases after its parent dies", async () => {
  const shared = dir();
  const modulePath = path.join(__dirname, "machineHostPower.js");
  const child = spawn(process.execPath, ["-e", `
    const { MachineHostPowerRegistry } = require(process.argv[1]);
    const r = new MachineHostPowerRegistry({ dir: process.argv[2], profilePath: "/srv/killed", bootId: "boot-1", uptimeMs: () => 1000 });
    r.withLock(async () => {
      r.publish(true);
      process.stdout.write("locked\\n");
      await new Promise(() => {});
    }).catch(error => { console.error(error); process.exit(1); });
  `, modulePath, shared], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  let stderr = "";
  child.stderr.on("data", data => { stderr += data; });
  try {
    await Promise.race([
      once(child.stdout, "data"),
      closed.then(() => { throw new Error(`lock owner exited: ${stderr}`); }),
      delay(5000, undefined, { ref: false }).then(() => { throw new Error("lock owner did not acquire"); })
    ]);
    const contender = registry({ dir: shared, profile: "/srv/contender", pid: process.pid, alive: pid => pid === process.pid });
    let entered = false;
    const waiting = contender.withLock(() => { entered = true; return "acquired"; });
    // Even a paused controller still owns its kernel lock; nobody removes it
    // based on an unfinished owner file, pid probe, or wall-clock age.
    child.kill("SIGSTOP");
    await delay(150);
    assert.equal(entered, false);
    child.kill("SIGKILL");
    await closed;
    assert.equal(await waiting, "acquired");
    assert.ok(contender.blockingReason(), "freeing the lock does not erase the dead owner's native-work claim");
    const inode = fs.statSync(path.join(shared, "admission.lock")).ino;
    await contender.withLock(() => undefined);
    assert.equal(fs.statSync(path.join(shared, "admission.lock")).ino, inode, "the lock file is never unlinked or replaced");
  } finally {
    child.kill("SIGKILL");
    await closed;
    fs.rmSync(shared, { recursive: true, force: true });
  }
});


test("a losing stop never commits a local fence, and local persistence is inside host admission exclusion", async () => {
  const shared = dir();
  const stopper = registry({ dir: shared, profile: "/srv/one", pid: 11 });
  const neighbour = registry({ dir: shared, profile: "/srv/two", pid: 22 });
  stopper.publish(false); neighbour.publish(false);
  assert.equal(await stopper.beginStop({ minIdleMs: 0, ownIdleSinceUptimeMs: 0 }), true);
  await neighbour.admit("a turn");
  let writes = 0;
  assert.equal(await stopper.commitStop(async () => { writes++; return true; }), false);
  assert.equal(writes, 0, "no stuck local stop fence when another deployment won");
  neighbour.publish(false);
  assert.equal(await stopper.beginStop({ minIdleMs: 0, ownIdleSinceUptimeMs: 0 }), true);
  let entered!: () => void; let release!: () => void;
  const begun = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const committing = stopper.commitStop(async () => { entered(); await held; return true; });
  await begun;
  let admitted = false;
  const competing = neighbour.admit("another turn").then(result => { admitted = true; return result; });
  await delay(100);
  assert.equal(admitted, false, "admission waits for local persistence and shared commit together");
  release();
  assert.equal(await committing, true);
  assert.equal((await competing).admitted, false);
});


test("a neighbour using the old admission protocol suspends automatic stop even when idle", async () => {
  const shared = dir();
  const current = registry({ dir: shared, profile: "/srv/current" });
  const old = registry({ dir: shared, profile: "/srv/old" });
  current.publish(false); old.publish(false);
  const entry = fs.readdirSync(shared).find(name => name.startsWith(machineHostProfileId("/srv/old")))!;
  const record = JSON.parse(fs.readFileSync(path.join(shared, entry), "utf8"));
  record.version = 1;
  fs.writeFileSync(path.join(shared, entry), JSON.stringify(record));
  assert.match(current.blockingReason() ?? "", /needs an upgrade/);
  assert.equal(await current.beginStop({ minIdleMs: 0, ownIdleSinceUptimeMs: 0 }), false);
  const own = fs.readdirSync(shared).find(name => name.startsWith(machineHostProfileId("/srv/current")))!;
  assert.equal(JSON.parse(fs.readFileSync(path.join(shared, own), "utf8")).version, 2, "old readers refuse the new claim instead of using a different lock concurrently");
});

test("helper-only death cannot unlock a live runtime's pending SQLite commit", async () => {
  const shared = dir();
  const modulePath = path.join(__dirname, "machineHostPower.js");
  const child = spawn(process.execPath, ["-e", `
    const cp = require('node:child_process'); const spawn = cp.spawn; let helper;
    cp.spawn = (...args) => { const result = spawn(...args); if (args[0] === 'python3') helper = result; return result; };
    const { MachineHostPowerRegistry } = require(process.argv[1]);
    const r = new MachineHostPowerRegistry({ dir: process.argv[2], profilePath: '/srv/stopper', bootId: 'boot-1', uptimeMs: () => 1000 });
    (async () => {
      r.publish(false);
      if (!await r.beginStop({minIdleMs: 0, ownIdleSinceUptimeMs: 0})) throw new Error('no pending stop');
      const committed = await r.commitStop(async () => {
        process.send({ helper: helper.pid });
        await new Promise(resolve => process.once('message', resolve));
        return true;
      });
      process.send({ committed }); process.disconnect();
    })().catch(error => { console.error(error); process.exit(1); });
  `, modulePath, shared], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const closed = once(child, "close");
  let error = "";
  child.stderr!.on("data", data => { error += data; });
  try {
    const [message] = await Promise.race([
      once(child, "message"),
      closed.then(() => { throw new Error(`owner exited: ${error}`); })
    ]);
    process.kill(message.helper, "SIGKILL");
    const other = registry({ dir: shared, profile: "/srv/other", pid: process.pid });
    let settled = false;
    const admission = other.admit("new turn").then(value => { settled = true; return value; });
    await delay(150);
    assert.equal(settled, false, "Node retains the shared open-file description after its helper dies");
    const committed = once(child, "message");
    child.send("finish SQLite");
    assert.equal((await committed)[0].committed, true);
    assert.equal((await admission).admitted, false, "the committed stop is visible before any new admission");
  } finally {
    child.kill("SIGKILL");
    await closed;
    fs.rmSync(shared, { recursive: true, force: true });
  }
});
