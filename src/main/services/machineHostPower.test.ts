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
