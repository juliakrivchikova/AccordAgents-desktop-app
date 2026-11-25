import assert from "node:assert/strict";
import test from "node:test";
import { CommandError, commandFailureDetail, isDiskSpaceFailure } from "./command";
import { MACHINE_DISK_FULL_MESSAGE, machinePowerNeedsDelivery, readMachineBundle } from "./machineInstaller";
import { parseMachineProbe } from "./machineInstallScripts";
import { bundleFixture, harness, INSTANCE, POWER, probeOutput, TARGET } from "./machineInstaller/test/installerFixtures";

test("a damaged install-state file reads as an unknown version, never as none", () => {
  const probe = parseMachineProbe(probeOutput({ state: "{not json" }));
  assert.equal(probe.installedVersion, undefined);
});

// ---- install / upgrade ----------------------------------------------------

test("install walks the visible phases and ends connected", async () => {
  const h = harness();
  const phases: string[] = [];
  const result = await h.service.install(
    { machineId: "m1", operationId: "op1", target: TARGET },
    (snapshot) => phases.push(snapshot.phase)
  );
  assert.deepEqual(phases, ["preflight", "bundle", "transfer", "dependencies", "enroll", "drain", "activate", "service", "starting", "verify", "ready"]);
  assert.equal(result.snapshot.phase, "ready");
  assert.equal(result.record.installedVersion, "1.4.0");
  assert.equal(h.uploads.length, 1);
  assert.ok(h.uploads[0].remoteDir.includes("/releases/1.4.0-"));
  assert.deepEqual(result.snapshot.completed.includes("verify"), true);
  assert.equal(h.waitedVersion(), "1.4.0", "the hello must be required to report the new version");
});

test("even a first install proves nothing is running before it switches version", async () => {
  const h = harness();
  await h.service.install({ machineId: "m1", operationId: "op1", target: TARGET });
  const drainIndex = h.calls.findIndex((call) => call.script.includes("printf 'drained="));
  const activateIndex = h.calls.findIndex((call) => call.script.includes("mv -Tf"));
  assert.ok(drainIndex >= 0, "the drain must run even when the probe found nothing running");
  assert.ok(drainIndex < activateIndex, "the drain must come before the version switch");
});

test("a machine that connects but still runs the old release is not reported ready", async () => {
  const h = harness({
    probe: probeOutput({
      state: JSON.stringify({ version: "1.3.0", digest: "old" }),
      "active-release": "1.3.0-old", enrollment: "present", "service-scope": "system", "service-state": "active"
    }, ["1.3.0-old"]),
    // The unit failed to restart: the old process is still the one connected.
    probeAfter: probeOutput({
      state: JSON.stringify({ version: "1.3.0", digest: "old" }),
      "active-release": "1.3.0-old", enrollment: "present", "service-scope": "system", "service-state": "active"
    }, ["1.3.0-old"])
  });
  const result = await h.service.upgrade({ machineId: "m1", operationId: "op9", target: TARGET });
  assert.equal(result.snapshot.phase, "needs-attention");
  assert.equal(result.snapshot.recovery?.kind, "rolled-back");
  assert.notEqual(result.record.installedVersion, "1.4.0");
});

test("a machine that cannot compile node-pty fails with a message that says so", async () => {
  const h = harness({ dependenciesFail: "gyp ERR! build error" });
  const result = await h.service.install({ machineId: "m1", operationId: "op10", target: TARGET });
  assert.equal(result.snapshot.phase, "error");
  assert.match(result.snapshot.error ?? "", /build tools \(python3, make, a C\+\+ compiler\)/);
  assert.match(result.snapshot.error ?? "", /gyp ERR/);
  assert.equal(result.snapshot.recovery?.kind, "old-runtime-still-installed");
  assert.ok(!h.calls.some((call) => call.script.includes("mv -Tf")), "nothing may be switched");
});

test("an update that runs out of disk says the disk is full, not that build tools are missing", async () => {
  const h = harness({ dependenciesFail: "npm ERR! code ENOSPC\nnpm ERR! nospc ENOSPC: no space left on device, write" });
  const result = await h.service.install({ machineId: "m1", operationId: "op-disk", target: TARGET });
  assert.equal(result.snapshot.phase, "error");
  assert.equal(result.snapshot.error, MACHINE_DISK_FULL_MESSAGE);
  assert.doesNotMatch(result.snapshot.error ?? "", /build tools/);
});

test("a failed command keeps the last line it printed instead of only its exit code", () => {
  const failure = new CommandError("ssh exited with code 1", {
    command: "ssh", args: [], stdout: "", exitCode: 1, timedOut: false,
    stderr: "Warning: Permanently added 'x' to the list of known hosts.\n\u001b[31mnpm ERR! network timeout at registry\u001b[0m\n"
  });
  assert.equal(commandFailureDetail(failure), "npm ERR! network timeout at registry");
  assert.equal(isDiskSpaceFailure(failure), false);
  assert.equal(isDiskSpaceFailure(new CommandError("x", { ...failure.result, stderr: "write: No space left on device" })), true);
});

test("running out of file watchers is not a full disk", () => {
  const watchers = new CommandError("x", { command: "node", args: [], stdout: "", exitCode: 1, timedOut: false,
    stderr: "Error: ENOSPC: System limit for number of file watchers reached, watch '/home/ubuntu/app'" });
  assert.equal(isDiskSpaceFailure(watchers), false);
  assert.equal(isDiskSpaceFailure(new Error("ENOSPC: no space left on device, write")), true);
  assert.equal(isDiskSpaceFailure(new Error("npm ERR! code ENOSPC")), true);
});

test("the chosen provider must be installed and signed in on the machine itself", async () => {
  const h = harness({ doctor: { ok: false, message: "Codex is not signed in on the machine.", checks: [] } });
  const seen: Array<{ authUrl?: string; authCode?: string }> = [];
  const result = await h.service.install(
    { machineId: "m1", operationId: "op-auth", target: TARGET, requiredProvider: "codex-cli" },
    (snapshot) => { if (snapshot.authUrl) seen.push({ authUrl: snapshot.authUrl, authCode: snapshot.authCode }); }
  );
  assert.deepEqual(h.doctorCalls.map((call) => call.options?.requiredProviderKinds), [["codex-cli"], ["codex-cli"]]);
  // The sign-in happens ON the machine: the desktop only relays the URL and
  // code, and never copies a credential of its own.
  assert.deepEqual(seen, [{ authUrl: "https://auth.example/device", authCode: "ABCD-1234" }]);
  assert.equal(result.snapshot.phase, "error");
  assert.equal(result.snapshot.recovery?.kind, "nothing-changed");
  assert.equal(h.uploads.length, 0);
});

test("installing the program alone asks for no provider sign-in", async () => {
  const h = harness();
  await h.service.install({ machineId: "m1", operationId: "op-no-provider", target: TARGET });
  // Nobody may be there to approve a sign-in (Settings → AWS setup, a
  // recovery, an update), and a provider not signed in is not the program's.
  assert.ok(h.doctorCalls.length > 0);
  for (const call of h.doctorCalls) assert.deepEqual(call.options?.requiredProviderKinds, []);
});

test("an upgrade that cannot prove the old runtime is gone replaces nothing", async () => {
  const h = harness({
    probe: probeOutput({
      state: JSON.stringify({ version: "1.3.0", digest: "old" }),
      "active-release": "1.3.0-old",
      enrollment: "present",
      "service-scope": "system",
      "service-state": "active",
      "runtime-pids": "4210",
      "supervisor-pids": "4300"
    }, ["1.3.0-old"]),
    // Observed on a real machine: the unit stops, and only then does the
    // drain find a process this install owns that will not exit.
    drain: "service-state=inactive\nruntime-pids=4210\nsupervisor-pids=4300\nprovider-pids=4400\ndrained=no\n"
  });
  const result = await h.service.upgrade({ machineId: "m1", operationId: "op2", target: TARGET });
  assert.equal(result.snapshot.phase, "needs-attention");
  assert.equal(result.snapshot.recovery?.kind, "manual-drain-required");
  assert.deepEqual(result.snapshot.recovery?.blockingPids, [4210, 4300, 4400]);
  assert.equal(result.snapshot.recovery?.activeVersion, "1.3.0");
  // The drain stopped the unit before it found the stray process. Saying "the
  // machine keeps working" there would be a lie: it is down, on purpose.
  assert.match(result.snapshot.recovery?.detail ?? "", /has deliberately NOT been started again/);
  assert.match(result.snapshot.recovery?.detail ?? "", /hosts no members until that is resolved/);
  assert.ok(!h.calls.some((call) => call.script.includes("mv -Tf")), "the release must not be switched");
  assert.ok(!h.calls.some((call) => call.script.includes("daemon-reload")), "the service must not be rewritten");
  assert.equal(result.record.installedVersion, "1.3.0");
  assert.ok(!result.snapshot.completed.includes("drain"));
});

test("an upgrade asks once more right before the drain and leaves a machine that started work alone", async () => {
  // The preflight said idle; minutes of staging later a member started a
  // turn on the machine. Stopping the runtime now would kill it.
  const asked: string[] = [];
  const h = harness({
    probe: probeOutput({
      state: JSON.stringify({ version: "1.3.0", digest: "old" }),
      "active-release": "1.3.0-old", enrollment: "present", "service-scope": "system", "service-state": "active",
      "runtime-pids": "4210"
    }, ["1.3.0-old"]),
    beforeDrain: async (record, operationId) => { asked.push(`${record.machineId}:${operationId}`); return "A member started work on the machine while the update was being staged, so its runtime was not stopped."; }
  });
  const result = await h.service.upgrade({ machineId: "m1", operationId: "auto-upgrade-1.4.0-1", target: TARGET });
  assert.deepEqual(asked, ["m1:auto-upgrade-1.4.0-1"], "the hook knows which operation asks, so the button can be exempt");
  assert.equal(result.snapshot.phase, "needs-attention");
  assert.equal(result.snapshot.recovery?.kind, "machine-busy");
  assert.match(result.snapshot.message, /started work on the machine while the update was being staged/);
  assert.match(result.snapshot.recovery?.detail ?? "", /attempted again once the machine is idle/);
  assert.ok(h.uploads.length > 0, "the release was staged");
  assert.ok(!h.calls.some((call) => call.script.includes("printf 'drained=")), "the runtime was not stopped");
  assert.ok(!h.calls.some((call) => call.script.includes("mv -Tf")), "the release must not be switched");
  assert.equal(result.record.installedVersion, "1.3.0");
  assert.equal(h.records.get("m1")?.lastOperation?.recovery?.kind, "machine-busy", "the outcome is on the record for the row and the retry");
});

test("a refused drain on a machine that is still running says so instead", async () => {
  const h = harness({
    probe: probeOutput({
      state: JSON.stringify({ version: "1.3.0", digest: "old" }),
      "active-release": "1.3.0-old", enrollment: "present", "service-scope": "system", "service-state": "active",
      "runtime-pids": "4210"
    }, ["1.3.0-old"]),
    drain: "service-state=active\nruntime-pids=4210\ndrained=no\n"
  });
  const result = await h.service.upgrade({ machineId: "m1", operationId: "op-drain2", target: TARGET });
  assert.equal(result.snapshot.recovery?.kind, "manual-drain-required");
  assert.match(result.snapshot.recovery?.detail ?? "", /The runtime is still running\./);
});

test("an upgrade that does not connect is rolled back to the previous release", async () => {
  const h = harness({
    connected: false,
    probe: probeOutput({
      state: JSON.stringify({ version: "1.3.0", digest: "old" }),
      "active-release": "1.3.0-old",
      enrollment: "present",
      "service-scope": "system",
      "service-state": "active",
      "runtime-pids": "4210"
    }, ["1.3.0-old"])
  });
  const result = await h.service.upgrade({ machineId: "m1", operationId: "op3", target: TARGET });
  assert.equal(result.snapshot.phase, "needs-attention");
  assert.equal(result.snapshot.recovery?.kind, "rolled-back");
  assert.equal(result.snapshot.recovery?.activeVersion, "1.3.0");
  assert.ok(result.snapshot.recovery?.serviceLog?.includes("failed to start"));
  const activations = h.calls.filter((call) => call.script.includes("mv -Tf"));
  assert.equal(activations.length, 2);
  assert.ok(activations[1].script.includes("1.3.0-old"), "the previous release must be restored");
  assert.notEqual(result.record.installedVersion, "1.4.0");
});

test("re-installing the same bundle on a running machine changes nothing", async () => {
  const dir = bundleFixture();
  const digest = readMachineBundle(dir).digest;
  const h = harness({
    bundleDir: dir,
    probe: probeOutput({
      state: JSON.stringify({ version: "1.4.0", digest }),
      "active-release": `1.4.0-${digest.slice(0, 12)}`,
      enrollment: "present", "service-scope": "system", "service-state": "active"
    })
  });
  const result = await h.service.upgrade({ machineId: "m1", operationId: "op5", target: TARGET });
  assert.equal(result.snapshot.phase, "ready");
  assert.equal(h.uploads.length, 0);
  assert.ok(!h.calls.some((call) => call.script.includes("drained=")), "a no-op upgrade must not stop the machine");
});

test("a machine missing Node 20 is refused before anything is copied", async () => {
  const h = harness({ probe: probeOutput({ node: "v18.19.0" }) });
  const result = await h.service.install({ machineId: "m1", operationId: "op6", target: TARGET });
  assert.equal(result.snapshot.phase, "error");
  assert.match(result.snapshot.error ?? "", /Node 20\+/);
  assert.equal(result.snapshot.recovery?.kind, "nothing-changed");
  assert.equal(h.uploads.length, 0);
});

test("two installs of one machine share a single operation", async () => {
  const h = harness();
  const first = h.service.install({ machineId: "m1", operationId: "op7", target: TARGET });
  const second = h.service.install({ machineId: "m1", operationId: "op7", target: TARGET });
  await assert.rejects(h.service.upgrade({ machineId: "m1", operationId: "op7", target: TARGET }), /still running/);
  await assert.rejects(h.service.install({ machineId: "m1", operationId: "op8", target: TARGET }), /still running/);
  await assert.rejects(h.service.install({ machineId: "m1", operationId: "op7", target: { ...TARGET, host: "another-host" } }), /still running/);
  await assert.rejects(h.service.install({ machineId: "m1", operationId: "op7", target: TARGET, requiredProvider: "claude-code" }), /still running/);
  assert.equal(await first, await second);
  assert.equal(h.uploads.length, 1);
});

test("an interrupted setup is offered for retry, never resumed silently", async () => {
  const h = harness();
  h.records.set("m1", {
    machineId: "m1", target: TARGET, installRoot: "/home/ubuntu/accordagents-machine",
    userDataDir: "/home/ubuntu/.accordagents/machine", serviceName: "accordagents-machine", serviceScope: "system",
    installedVersion: "1.3.0",
    lastOperation: {
      machineId: "m1", operationId: "op8", kind: "upgrade", phase: "transfer", message: "Copying…",
      updatedAt: "2026-09-06T00:00:00.000Z", completed: ["preflight", "bundle"]
    }
  });
  await h.service.recoverInterruptedOperation();
  const record = h.records.get("m1");
  assert.equal(record?.lastOperation?.phase, "needs-attention");
  assert.equal(record?.lastOperation?.recovery?.kind, "old-runtime-still-installed");
  assert.equal(record?.lastOperation?.retryable, true);
  assert.equal(h.calls.length, 0, "recovery must not touch the machine");
});

test("a machine without the host lock runtime is refused before transferring a release", async () => {
  const h = harness({ probe: probeOutput({ python3: "missing" }) });
  const result = await h.service.install({ machineId: "m1", operationId: "no-host-lock", target: TARGET });
  assert.equal(result.snapshot.phase, "error");
  assert.match(result.snapshot.error ?? "", /python3/);
  assert.equal(h.uploads.length, 0);
});

test("a dropped connection, a timeout, an unreachable AWS or a busy host is not taken as a refusal, and is tried again an hour later", async () => {
  // 255: ssh lost the connection; null: timed out; 1: the machine failed for
  // a temporary reason (AWS or its metadata unreachable); 69: host busy.
  const failedAt = new Date("2026-09-07T00:00:00.000Z");
  for (const failure of [{ exitCode: 255 }, { exitCode: null, timedOut: true }, { exitCode: 1 }, { exitCode: 69 }]) {
    for (const where of ["check", "configure"] as const) {
      const h = harness({ machinePower: async () => POWER, ...(where === "check" ? { powerFailure: failure } : { configureFailure: failure }) });
      const result = await h.service.install({ machineId: "m1", operationId: "op1", target: INSTANCE });
      assert.equal(result.snapshot.phase, "ready");
      assert.equal(result.record.power, undefined);
      assert.equal(result.record.powerError, undefined, "not a refusal");
      assert.equal(result.record.powerRetry?.keyId, POWER.credentials.accessKeyId);
      assert.equal(machinePowerNeedsDelivery(result.record, POWER, new Date(failedAt.getTime() + 10 * 60_000)), false,
        "not again on the next hello: each attempt stops the machine for a moment");
      assert.equal(machinePowerNeedsDelivery(result.record, POWER, new Date(failedAt.getTime() + 61 * 60_000)), true, "but an hour later");
      assert.ok(result.snapshot.warnings?.some((warning) => warning.startsWith("Automatic stop after three idle hours is not set up")));
    }
  }
});
