import assert from "node:assert/strict";
import test from "node:test";
import { CommandError } from "./command";
import type { MachineInstallRecord } from "../../shared/machineInstall";
import { machinePowerNeedsDelivery, readMachineBundle, redactKeyLikeText } from "./machineInstaller";
import { installerDependencies } from "./machineInstaller/test/installerParts";
import { bundleFixture, harness, type Harness, INSTANCE, POWER, probeOutput, TARGET } from "./machineInstaller/test/installerFixtures";

test("the last line a failed step printed is kept, without anything shaped like a key", async () => {
  const token = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4";
  const h = harness({ probeFailure: new CommandError("ssh exited with code 1", {
    command: "ssh", args: [], stdout: "", exitCode: 1, timedOut: false, stderr: `curl: (22) refused: Authorization: Bearer ${token}\n`
  }) });
  const result = await h.service.install({ machineId: "m1", operationId: "op-detail", target: TARGET });
  assert.equal(result.snapshot.phase, "error");
  assert.match(result.snapshot.error ?? "", /ssh exited with code 1: curl: \(22\) refused: Authorization: Bearer \[redacted\]/);
  assert.doesNotMatch(result.snapshot.error ?? "", new RegExp(token));
});

test("a key-shaped run in the service log is not written into settings", () => {
  const key = "k".repeat(48);
  const redacted = redactKeyLikeText(`relaySealKeyBase64=${key} and hash ${"a".repeat(64)}`);
  assert.ok(!redacted.includes(key));
  assert.ok(!redacted.includes("a".repeat(64)));
  assert.ok(redacted.includes("[redacted]"));
  assert.equal(redactKeyLikeText("machine.service: failed to start"), "machine.service: failed to start");
});

function runningSameBundle(): { dir: string; probe: string } {
  const dir = bundleFixture();
  const digest = readMachineBundle(dir).digest;
  return {
    dir,
    probe: probeOutput({
      state: JSON.stringify({ version: "1.4.0", digest }),
      "active-release": `1.4.0-${digest.slice(0, 12)}`,
      enrollment: "present", "service-scope": "system", "service-state": "active"
    }, [`1.4.0-${digest.slice(0, 12)}`])
  };
}

function installedRecord(extra: Partial<MachineInstallRecord> = {}): MachineInstallRecord {
  return {
    machineId: "m1", target: INSTANCE, installRoot: "/home/ubuntu/accordagents-machine", userDataDir: "/home/ubuntu/.accordagents/machine",
    serviceName: "accordagents-machine", serviceScope: "system", installedVersion: "1.4.0", ...extra
  };
}

const at = (h: Harness, needle: string) => h.calls.findIndex((call) => call.script.includes(needle));

test("the stop key is handed over on stdin while the runtime is drained, and counts only once it started with it", async () => {
  const h = harness({ machinePower: async () => POWER });
  const result = await h.service.install({ machineId: "m1", operationId: "op1", target: INSTANCE });
  assert.equal(result.snapshot.phase, "ready");
  const check = h.calls[at(h, "--check-power")];
  assert.ok(check, "AWS is asked about the key first");
  assert.deepEqual(JSON.parse(check.input ?? ""), POWER);
  assert.ok(check.script.includes("/releases/"), "with the release about to run, which knows how to check it");
  assert.ok(at(h, "--check-power") < at(h, "printf 'drained="), "while the runtime still serves members");
  const configure = h.calls[at(h, "--configure-power")];
  assert.ok(configure, "the stop key must be handed to the machine");
  assert.deepEqual(JSON.parse(configure.input ?? ""), POWER);
  assert.ok(configure.script.includes("/current/accordagents-machine.cjs"), "the release that is about to start reads it");
  assert.ok(configure.script.includes("--user-data '/home/ubuntu/.accordagents/machine'"));
  assert.ok(at(h, "printf 'drained=") >= 0 && at(h, "printf 'drained=") < at(h, "--configure-power"), "the runtime must be drained first");
  const start = h.calls.findIndex((call, i) => i > at(h, "--configure-power") && /systemctl.* start /.test(call.script));
  assert.ok(start > 0, "the runtime starts after it has the key");
  assert.deepEqual(result.record.power, { keyId: POWER.credentials.accessKeyId, configuredAt: "2026-09-07T00:00:00.000Z" });
  assert.equal(result.record.powerError, undefined);
  for (const call of h.calls) assert.ok(!call.script.includes("POWER-SECRET-DO-NOT-LOG"), "the secret never reaches a command line");
  assert.ok(!JSON.stringify(h.logged).includes("POWER-SECRET-DO-NOT-LOG"));
  assert.ok(!JSON.stringify([...h.records.values()]).includes("POWER-SECRET-DO-NOT-LOG"));
});

test("the stop key never goes to a host that is not the instance's pinned host", async () => {
  const h = harness({ machinePower: async () => POWER });
  const result = await h.service.install({ machineId: "m1", operationId: "op1", target: TARGET });
  assert.equal(result.snapshot.phase, "ready");
  assert.equal(at(h, "--configure-power"), -1);
  assert.equal(result.record.power, undefined);
  assert.ok(h.logged.some((entry) => entry.event === "machines.install.power-skipped"));
});

test("a machine that refuses the stop key is still updated; the automatic update does not retry that key, the button does", async () => {
  const refusal = "The power configuration names a different AWS machine; automatic stop is suspended.";
  const h = harness({ machinePower: async () => POWER, powerRefusal: refusal });
  const result = await h.service.install({ machineId: "m1", operationId: "op1", target: INSTANCE });
  assert.equal(result.snapshot.phase, "ready", "the runtime update itself succeeded");
  assert.equal(at(h, "--configure-power"), -1, "a refused key is never written");
  assert.equal(result.record.power, undefined);
  assert.equal(result.record.powerError?.keyId, POWER.credentials.accessKeyId);
  assert.equal(result.record.powerError?.message, refusal);
  assert.ok(result.snapshot.warnings?.some((warning) => warning === `Automatic stop after three idle hours is not set up: ${refusal}`));
  assert.equal(machinePowerNeedsDelivery(result.record, POWER), false, "the same refused key is not handed over again automatically");
  assert.equal(machinePowerNeedsDelivery(result.record, { ...POWER, credentials: { ...POWER.credentials, accessKeyId: "AKIAPOWERKEY000000002" } }), true);

  const same = runningSameBundle();
  const refused = { powerError: { keyId: POWER.credentials.accessKeyId, message: refusal, failedAt: "t" } };
  const automatic = harness({ bundleDir: same.dir, probe: same.probe, machinePower: async () => POWER });
  automatic.records.set("m1", installedRecord(refused));
  await automatic.service.upgrade({ machineId: "m1", operationId: "auto-upgrade-1.4.0-1", target: INSTANCE });
  assert.equal(at(automatic, "--configure-power"), -1, "the automatic update leaves a refused key alone");
  assert.equal(at(automatic, "drained="), -1, "and does not stop the machine for it");
  const manual = harness({ bundleDir: same.dir, probe: same.probe, machinePower: async () => POWER });
  manual.records.set("m1", installedRecord(refused));
  const retried = await manual.service.upgrade({ machineId: "m1", operationId: "op-button", target: INSTANCE });
  assert.ok(at(manual, "--configure-power") > 0, "the Update button tries the refused key again");
  assert.equal(retried.record.power?.keyId, POWER.credentials.accessKeyId);
  assert.equal(retried.record.powerError, undefined);
});

test("a stop key AWS does not accept yet is not worth stopping a current runtime for", async () => {
  const same = runningSameBundle();
  const h = harness({ bundleDir: same.dir, probe: same.probe, machinePower: async () => POWER, powerFailure: { exitCode: 1 } });
  const result = await h.service.upgrade({ machineId: "m1", operationId: "auto-upgrade-1.4.0-1", target: INSTANCE });
  assert.equal(result.snapshot.phase, "ready");
  assert.equal(at(h, "drained="), -1, "the runtime that serves members is never stopped for a key that is not handed over");
  assert.equal(result.record.powerRetry?.keyId, POWER.credentials.accessKeyId);
});

const PREVIOUS_KEY = { keyId: "AKIAPOWERKEY000000000", configuredAt: "2026-09-01T00:00:00.000Z" };

test("a runtime that does not come back after taking a new key gets its previous key back and is started again", async () => {
  const same = runningSameBundle();
  const h = harness({ bundleDir: same.dir, probe: same.probe, machinePower: async () => POWER, connectedSequence: [false, true] });
  h.records.set("m1", installedRecord({ power: PREVIOUS_KEY }));
  const result = await h.service.upgrade({ machineId: "m1", operationId: "op-button", target: INSTANCE });
  const configure = at(h, "--configure-power");
  const revert = at(h, "--revert-power");
  assert.ok(configure > 0 && revert > configure, "the previous key is put back");
  const drainBeforeRevert = h.calls.findIndex((call, i) => i > configure && i < revert && call.script.includes("printf 'drained="));
  assert.ok(drainBeforeRevert > 0, "only after the runtime is drained again");
  assert.ok(h.calls.some((call, i) => i > revert && /systemctl.* start /.test(call.script)), "and the runtime is started again");
  const probes = h.calls.filter((call, i) => i > revert && call.script.includes("printf 'home=%s")).length;
  assert.ok(probes > 0, "a connection alone is not proof: the release that runs is read back");
  assert.equal(result.snapshot.phase, "ready");
  assert.match(result.snapshot.message, /with its previous automatic-stop setting/);
  assert.deepEqual(result.record.power, PREVIOUS_KEY, "the machine still stops with the key it had");
  assert.equal(result.record.powerError, undefined, "AWS accepted the key: the cause may be anything, so it is not marked refused");
  assert.equal(result.record.powerRetry?.keyId, POWER.credentials.accessKeyId, "it is tried again later");
  assert.match(result.record.powerRetry?.message ?? "", /previous setting was put back/);
  assert.ok(h.logged.some((entry) => entry.event === "machines.install.power-reverted" && entry.machineId === "m1"));
});

test("when the previous key cannot be put back, the runtime is still started and nothing is claimed about its key", async () => {
  const same = runningSameBundle();
  const h = harness({ bundleDir: same.dir, probe: same.probe, machinePower: async () => POWER, connectedSequence: [false, true], revertFailure: true });
  h.records.set("m1", installedRecord({ power: PREVIOUS_KEY }));
  const result = await h.service.upgrade({ machineId: "m1", operationId: "op-button", target: INSTANCE });
  const revert = at(h, "--revert-power");
  assert.ok(h.calls.some((call, i) => i > revert && /systemctl.* start /.test(call.script)), "a stopped runtime is never left stopped");
  assert.equal(result.snapshot.phase, "ready");
  assert.equal(result.record.power, undefined, "a revert that did not confirm may still have run");
  assert.match(result.record.powerRetry?.message ?? "", /putting its previous setting back failed/, "so the key is handed over again");
  assert.ok(h.logged.some((entry) => entry.event === "machines.install.power-revert-failed" && entry.machineId === "m1"));
});

test("a runtime that still does not connect after the key is put back is reported, not called ready", async () => {
  const same = runningSameBundle();
  const h = harness({ bundleDir: same.dir, probe: same.probe, machinePower: async () => POWER, connectedSequence: [false, false] });
  const result = await h.service.upgrade({ machineId: "m1", operationId: "op-button", target: INSTANCE });
  assert.ok(at(h, "--revert-power") > 0);
  assert.equal(result.snapshot.phase, "needs-attention");
  assert.equal(result.record.power, undefined);
  assert.equal(result.record.powerRetry?.keyId, POWER.credentials.accessKeyId);
});

test("a new release that does not connect with a new key has the key put back before it is rolled back", async () => {
  const h = harness({ probe: probeOutput({ state: JSON.stringify({ version: "1.3.0", digest: "old" }), "active-release": "1.3.0-oldrelease00" }),
    machinePower: async () => POWER, connectedSequence: [false, true] });
  h.records.set("m1", installedRecord({ installedVersion: "1.3.0", power: PREVIOUS_KEY }));
  const result = await h.service.upgrade({ machineId: "m1", operationId: "op-button", target: INSTANCE });
  const revert = at(h, "--revert-power");
  const rollback = h.calls.findIndex((call, i) => i > revert && call.script.includes("1.3.0-oldrelease00") && call.script.includes("mv -Tf"));
  assert.ok(revert > 0, "the key is put back");
  assert.ok(rollback > revert, "before the previous release is restored");
  assert.equal(result.snapshot.phase, "needs-attention");
  assert.deepEqual(result.record.power, PREVIOUS_KEY);
});

test("an unreadable stop key does not block the update", async () => {
  const h = harness({ machinePower: async () => { throw new Error("settings unreadable"); } });
  const result = await h.service.install({ machineId: "m1", operationId: "op1", target: INSTANCE });
  assert.equal(result.snapshot.phase, "ready");
  assert.equal(at(h, "--configure-power"), -1);
  assert.ok(h.logged.some((entry) => entry.event === "machines.install.power-unavailable"));
});

test("a current runtime that lacks the stop key is restarted with it, without copying or rebuilding anything", async () => {
  const same = runningSameBundle();
  const h = harness({ bundleDir: same.dir, probe: same.probe, machinePower: async () => POWER });
  const phases: string[] = [];
  const result = await h.service.upgrade({ machineId: "m1", operationId: "auto-upgrade-1.4.0-1", target: INSTANCE }, (snapshot) => phases.push(snapshot.phase));
  assert.equal(result.snapshot.phase, "ready");
  assert.equal(h.uploads.length, 0, "nothing is copied again");
  assert.ok(!h.calls.some((call) => call.script.includes("npm install") || call.script.includes("npm ci")), "nothing is rebuilt");
  assert.ok(!phases.includes("transfer") && !phases.includes("dependencies"));
  assert.ok(at(h, "printf 'drained=") >= 0 && at(h, "printf 'drained=") < at(h, "--configure-power"), "the runtime is drained before the key is written");
  assert.equal(result.record.power?.keyId, POWER.credentials.accessKeyId);
});

test("a runtime that already has this stop key is left alone, and a version upgrade does not hand it over again", async () => {
  const same = runningSameBundle();
  const has = { power: { keyId: POWER.credentials.accessKeyId, configuredAt: "2026-09-06T00:00:00.000Z" } };
  const h = harness({ bundleDir: same.dir, probe: same.probe, machinePower: async () => POWER });
  h.records.set("m1", installedRecord(has));
  const result = await h.service.upgrade({ machineId: "m1", operationId: "auto-upgrade-1.4.0-2", target: INSTANCE });
  assert.equal(result.snapshot.phase, "ready");
  assert.equal(at(h, "drained="), -1, "a machine that has its key is not stopped");
  assert.equal(at(h, "--configure-power"), -1);
  assert.equal(result.record.power?.keyId, POWER.credentials.accessKeyId, "the delivery survives the record being rebuilt");
  const upgrade = harness({
    probe: probeOutput({ state: JSON.stringify({ version: "1.3.0", digest: "old" }), "active-release": "1.3.0-old", enrollment: "present",
      "service-scope": "system", "service-state": "active" }, ["1.3.0-old"]),
    machinePower: async () => POWER
  });
  upgrade.records.set("m1", installedRecord({ ...has, installedVersion: "1.3.0" }));
  const upgraded = await upgrade.service.upgrade({ machineId: "m1", operationId: "auto-upgrade-1.4.0-3", target: INSTANCE });
  assert.equal(upgraded.snapshot.phase, "ready");
  assert.equal(at(upgrade, "--configure-power"), -1, "the new release reads the key the machine already keeps");
  assert.equal(upgraded.record.power?.keyId, POWER.credentials.accessKeyId);
});

test("a busy machine keeps running and does not get the key until it is idle", async () => {
  const same = runningSameBundle();
  const h = harness({ bundleDir: same.dir, probe: same.probe, machinePower: async () => POWER,
    beforeDrain: async () => "A member started work on the machine while the update was being staged, so its runtime was not stopped." });
  const result = await h.service.upgrade({ machineId: "m1", operationId: "auto-upgrade-1.4.0-1", target: INSTANCE });
  assert.equal(result.snapshot.recovery?.kind, "machine-busy");
  assert.equal(at(h, "drained="), -1);
  assert.equal(at(h, "--configure-power"), -1);
  assert.equal(result.record.power, undefined);
});

test("a key that keeps failing for a temporary reason stops being tried automatically after a few attempts", async () => {
  let record: MachineInstallRecord | undefined;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const h = harness({ machinePower: async () => POWER, powerFailure: { exitCode: 1 } });
    if (record) h.records.set("m1", record);
    const result = await h.service.install({ machineId: "m1", operationId: `op${attempt}`, target: INSTANCE });
    record = result.record;
    assert.equal(record.powerRetry?.attempts, attempt);
  }
  const later = new Date("2026-09-07T05:00:00.000Z");
  assert.equal(machinePowerNeedsDelivery(record!, POWER, later), false, "every attempt counts as work, so endless tries would keep the machine awake");
});

test("a run that fails before the key is checked still records the key, so it is not tried on every hello", async () => {
  const h = harness({ machinePower: async () => POWER, dependenciesFail: "npm install failed" });
  const result = await h.service.install({ machineId: "m1", operationId: "op1", target: INSTANCE });
  assert.equal(result.snapshot.phase, "error");
  assert.equal(result.record.powerRetry?.keyId, POWER.credentials.accessKeyId);
  assert.equal(machinePowerNeedsDelivery(result.record, POWER, new Date("2026-09-07T00:10:00.000Z")), false);
});

test("a runtime whose drain is not proven is never started again beside what is still alive", async () => {
  const same = runningSameBundle();
  let drains = 0;
  const h = harness({ bundleDir: same.dir, probe: same.probe, machinePower: async () => POWER, connectedSequence: [false, true] });
  const original = (installerDependencies(h.service) as unknown as { sshExec: (request: { script: string }) => Promise<string> }).sshExec;
  (installerDependencies(h.service) as unknown as { sshExec: (request: { script: string }) => Promise<string> }).sshExec = async (request) => {
    if (request.script.includes("printf 'drained=") && ++drains === 2) {
      h.calls.push(request as never);
      return "drained=no\nruntime-pids=4242\nsupervisor-pids=\nprovider-pids=\n";
    }
    return original(request);
  };
  const result = await h.service.upgrade({ machineId: "m1", operationId: "op-button", target: INSTANCE });
  const secondDrain = h.calls.findIndex((call, i) => i > at(h, "--configure-power") && call.script.includes("printf 'drained="));
  assert.ok(secondDrain > 0);
  assert.ok(!h.calls.some((call, i) => i > secondDrain && /systemctl.* start /.test(call.script)), "no second runtime beside a live one");
  assert.equal(result.snapshot.phase, "needs-attention");
});

test("an automatic attempt that fails before the key is checked records the key too", async () => {
  const h = harness({ machinePower: async () => POWER, probeFailure: "ssh: connect to host 203.0.113.9 port 22: Operation timed out" });
  const result = await h.service.upgrade({ machineId: "m1", operationId: "auto-upgrade-1.4.0-1", target: INSTANCE });
  assert.notEqual(result.snapshot.phase, "ready");
  assert.equal(result.record.powerRetry?.keyId, POWER.credentials.accessKeyId);
  assert.equal(result.record.powerRetry?.attempts, 1);
});

test("the Update button stops a current runtime for its stop key only when the machine is idle", async () => {
  const same = runningSameBundle();
  const purposes: string[] = [];
  const h = harness({ bundleDir: same.dir, probe: same.probe, machinePower: async () => POWER,
    beforeDrain: async (_record, _operationId, purpose) => { purposes.push(purpose); return "A member is working on the machine."; } });
  const result = await h.service.upgrade({ machineId: "m1", operationId: "op-button", target: INSTANCE });
  assert.deepEqual(purposes, ["key"]);
  assert.equal(result.snapshot.recovery?.kind, "machine-busy");
  assert.equal(at(h, "drained="), -1, "a member's turn is never cut off to hand over a key");
});

test("a runtime that will not start after taking the key gets its previous key back, as one that does not connect", async () => {
  const same = runningSameBundle();
  let starts = 0;
  const h = harness({ bundleDir: same.dir, probe: same.probe, machinePower: async () => POWER, connectedSequence: [true] });
  h.records.set("m1", installedRecord({ power: PREVIOUS_KEY }));
  const original = (installerDependencies(h.service) as unknown as { sshExec: (request: { script: string }) => Promise<string> }).sshExec;
  (installerDependencies(h.service) as unknown as { sshExec: (request: { script: string }) => Promise<string> }).sshExec = async (request) => {
    if (/systemctl.* start /.test(request.script) && ++starts === 1) throw new Error("Job for accordagents-machine.service failed");
    return original(request);
  };
  const result = await h.service.upgrade({ machineId: "m1", operationId: "op-button", target: INSTANCE });
  assert.ok(at(h, "--revert-power") > 0, "the previous key is put back");
  assert.equal(result.snapshot.phase, "ready");
  assert.deepEqual(result.record.power, PREVIOUS_KEY);
});
