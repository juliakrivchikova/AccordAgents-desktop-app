import assert from "node:assert/strict";
import test from "node:test";
import type { MachineInstallRecord } from "../../shared/machineInstall";
import { machineUpgradeTarget, type MachineUpgradeTargetOptions } from "./machineUpgradeTarget";

const INSTANCE = "i-00df441da575d4ca5";
const ALIAS = `accordagents-${INSTANCE}`;

function record(target: MachineInstallRecord["target"] = { host: "54.0.0.1", hostKeyAlias: ALIAS }): MachineInstallRecord {
  return { machineId: "m1", target, installRoot: "~/accordagents-machine", userDataDir: "~/.accordagents/machine",
    serviceName: "accordagents-machine", serviceScope: "user" } as MachineInstallRecord;
}

function harness(overrides: Partial<MachineUpgradeTargetOptions> = {}) {
  const calls: string[] = [];
  const logs: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const options: MachineUpgradeTargetOptions = {
    machineInstanceId: async () => INSTANCE,
    configuredInstanceId: async () => INSTANCE,
    ensureExistingWorker: async (instanceId, opts) => {
      calls.push(`renew:${instanceId}:start=${String(opts.start)}`);
      return { host: "54.235.55.108", user: "ubuntu", identityFile: "/key", hostKeyAlias: ALIAS };
    },
    inspect: async () => {
      calls.push("inspect");
      return { host: "54.235.55.108", user: "ubuntu", identityFile: "/key", hostKeyAlias: ALIAS };
    },
    log: (event, payload) => { logs.push({ event, payload }); },
    ...overrides
  };
  return { options, calls, logs };
}

test("an update to the app's AWS instance renews this computer's SSH access before connecting", async () => {
  // The User's update to 1.11.8-beta.1 timed out: the instance let SSH in
  // only from the address her computer had when it last started it.
  const h = harness();
  const target = await machineUpgradeTarget(record(), h.options);
  // Never with a start: an instance that stopped meanwhile stays stopped.
  assert.deepEqual(h.calls, [`renew:${INSTANCE}:start=false`]);
  assert.deepEqual(target, { host: "54.235.55.108", user: "ubuntu", port: undefined, identityFile: "/key", hostKeyAlias: ALIAS });
});

test("access that cannot be renewed still sends the update to the address AWS names, and says why", async () => {
  const h = harness({ ensureExistingWorker: async () => { throw new Error("UnauthorizedOperation: ec2:AuthorizeSecurityGroupIngress"); } });
  const target = await machineUpgradeTarget(record(), h.options);
  assert.deepEqual(h.calls, ["inspect"]);
  assert.equal(target?.host, "54.235.55.108");
  assert.equal(h.logs[0]?.event, "machines.auto-upgrade.access-renew-failed");
  assert.match(String(h.logs[0]?.payload.message), /AuthorizeSecurityGroupIngress/);
});

test("a stopped instance is not started for an update: it waits", async () => {
  const stopped = async (): Promise<never> => { throw new Error("The AWS instance is stopped, so nothing was started."); };
  const h = harness({ ensureExistingWorker: stopped, inspect: stopped });
  assert.equal(await machineUpgradeTarget(record(), h.options), undefined);
});

test("a machine on another instance than the one in Settings never touches that instance's access", async () => {
  const h = harness({ configuredInstanceId: async () => "i-0aaaaaaaaaaaaaaaa",
    inspect: async () => { h.calls.push("inspect"); return { host: "1.2.3.4", hostKeyAlias: "accordagents-i-0aaaaaaaaaaaaaaaa" }; } });
  assert.equal(await machineUpgradeTarget(record(), h.options), undefined);
  assert.deepEqual(h.calls, ["inspect"]);
});

test("a machine that is not on AWS keeps the address it was set up with", async () => {
  const h = harness({ machineInstanceId: async () => undefined });
  const saved = { host: "10.0.0.5", user: "me" };
  assert.deepEqual(await machineUpgradeTarget(record(saved), h.options), saved);
  assert.deepEqual(h.calls, []);
});

test("a machine matched only by its pinned host key is renewed too, and keeps its saved address when AWS cannot name one", async () => {
  const renewed = harness({ machineInstanceId: async () => undefined });
  assert.equal((await machineUpgradeTarget(record(), renewed.options))?.host, "54.235.55.108");
  assert.deepEqual(renewed.calls, [`renew:${INSTANCE}:start=false`]);
  const down = async (): Promise<never> => { throw new Error("throttled"); };
  const h = harness({ machineInstanceId: async () => undefined, ensureExistingWorker: down, inspect: down });
  assert.equal((await machineUpgradeTarget(record(), h.options))?.host, "54.0.0.1");
});

test("settings that cannot be read do not hold the update: it goes to the address AWS names", async () => {
  const h = harness({ configuredInstanceId: async () => { throw new Error("settings busy"); } });
  assert.equal((await machineUpgradeTarget(record(), h.options))?.host, "54.235.55.108");
  assert.deepEqual(h.calls, ["inspect"]);
});

test("a renewal still retrying SSH after the wait does not hold the update", async () => {
  // On a network where SSH does not get through, the renewal retries for
  // minutes; the update goes on and fails with its own error instead.
  const h = harness({ accessWaitMs: 20, ensureExistingWorker: () => new Promise(() => undefined) });
  const started = Date.now();
  assert.equal((await machineUpgradeTarget(record(), h.options))?.host, "54.235.55.108");
  assert.ok(Date.now() - started < 2_000);
  assert.deepEqual(h.calls, ["inspect"]);
  assert.equal(h.logs[0]?.event, "machines.auto-upgrade.access-renew-slow");
});
