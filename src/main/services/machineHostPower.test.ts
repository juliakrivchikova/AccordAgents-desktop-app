import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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

test("a stop cannot commit around work admitted while it was draining", () => {
  // The window a plain read leaves open: one deployment decides to stop, the
  // other starts a turn, and the stop still goes through. Admission and commit
  // take the same host lock, so the second one loses.
  const shared = dir();
  const stopper = registry({ dir: shared, profile: "/srv/one", pid: 11 });
  const neighbour = registry({ dir: shared, profile: "/srv/two", pid: 22 });
  stopper.publish(false);
  neighbour.publish(false);

  assert.equal(stopper.beginStop({ minIdleMs: 0, ownIdleSinceUptimeMs: 0 }), true, "an idle host may be stopped");
  // The neighbour starts work before the stop is final.
  assert.deepEqual(neighbour.admit("a turn"), { admitted: true });
  assert.equal(stopper.commitStop(), false, "work admitted meanwhile withdraws the stop");
  assert.equal(stopper.stopIntent(), undefined, "and the intent is gone, not left blocking the host");

  // With nobody working, the same sequence commits.
  neighbour.publish(false);
  assert.equal(stopper.beginStop({ minIdleMs: 0, ownIdleSinceUptimeMs: 0 }), true);
  assert.equal(stopper.commitStop(), true);
  assert.equal(stopper.stopIntent()?.phase, "committed");
});

test("a committed stop refuses new work instead of letting it start into a machine that is going away", () => {
  const shared = dir();
  const stopper = registry({ dir: shared, profile: "/srv/one", pid: 11 });
  const neighbour = registry({ dir: shared, profile: "/srv/two", pid: 22 });
  stopper.publish(false);
  neighbour.publish(false);
  assert.equal(stopper.beginStop({ minIdleMs: 0, ownIdleSinceUptimeMs: 0 }), true);
  assert.equal(stopper.commitStop(), true);

  const refused = neighbour.admit("a turn");
  assert.equal(refused.admitted, false);
  assert.match(refused.admitted === false ? refused.reason : "", /stopping after being idle/);
  assert.match(refused.admitted === false ? refused.reason : "", /\/srv\/one/, "the deployment that decided it is named");
});

test("a neighbour's recent work is not this profile's three hours of idle", () => {
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
  assert.equal(mine.beginStop({ minIdleMs: 60_000, ownIdleSinceUptimeMs: 0 }), false);
  now += 40_000;
  assert.equal(mine.beginStop({ minIdleMs: 60_000, ownIdleSinceUptimeMs: 0 }), true);
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

test("a lock left by a dead holder is broken, a live holder is waited for", () => {
  const shared = dir();
  let now = 0;
  const holder = registry({ dir: shared, profile: "/srv/one", pid: 11, now: () => now, alive: () => false });
  fs.mkdirSync(path.join(shared, "lock"), { recursive: true });
  fs.writeFileSync(path.join(shared, "lock", "owner.json"), JSON.stringify({ pid: 11, uptimeMs: 0 }));
  now = 60_000;
  // The holder is gone and the section is far older than it can legitimately be.
  assert.equal(holder.withLock(() => "ran"), "ran");

  const live = registry({ dir: shared, profile: "/srv/one", pid: 12, now: () => now, alive: () => true });
  fs.mkdirSync(path.join(shared, "lock"), { recursive: true });
  fs.writeFileSync(path.join(shared, "lock", "owner.json"), JSON.stringify({ pid: 4242, uptimeMs: now }));
  assert.throws(() => live.withLock(() => "ran"), /holding the power lock/, "a live holder is never overrun");
  fs.rmSync(path.join(shared, "lock"), { recursive: true, force: true });
});

test("an unreadable stop intent stops both stopping and admitting", () => {
  const shared = dir();
  const one = registry({ dir: shared, profile: "/srv/one", pid: 11 });
  one.publish(false);
  fs.writeFileSync(path.join(shared, "stop-intent.json"), "{\"version\":1,\"phase\":\"maybe\"}");
  assert.throws(() => one.stopIntent(), /cannot be read/);
  assert.throws(() => one.admit("a turn"), /cannot be read/);
  assert.throws(() => one.beginStop({ minIdleMs: 0, ownIdleSinceUptimeMs: 0 }), /cannot be read/);
});

test("maintenance is a host claim like any other and names itself", () => {
  const shared = dir();
  const runtime = registry({ dir: shared, profile: "/srv/one", pid: 11 });
  const maintenance = registry({ dir: shared, profile: "/srv/two", pid: 22, kind: "maintenance" });
  runtime.publish(false);
  assert.deepEqual(maintenance.admit("this maintenance command"), { admitted: true });
  assert.match(runtime.blockingReason() ?? "", /maintenance command/);
  assert.equal(runtime.beginStop({ minIdleMs: 0, ownIdleSinceUptimeMs: 0 }), false);
  maintenance.release();
  assert.equal(runtime.blockingReason(), undefined);
});
