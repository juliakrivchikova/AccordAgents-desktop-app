import assert from "node:assert/strict";
import test from "node:test";
import { CommandError } from "./command";
import { machineDrainScript, machineMirrorProbeScript, machineProbeScript, writeFileFromStdinScript } from "./machineInstallScripts";
import { ENROLLMENT, harness, LAYOUT, probeOutput, TARGET } from "./machineInstaller/test/installerFixtures";

test("Settings resolves an unfinished installation's isolated profile before provider checks", async () => {
  const target = { ...TARGET, hostKeyAlias: "accordagents-i-home" };
  const h = harness({ probe: probeOutput({ "install-root": "/home/ubuntu/accordagents-home" }) });
  h.records.set("home", { machineId: "home", target, installRoot: "~/accordagents-home",
    userDataDir: "", serviceName: "accordagents-home", serviceScope: "system", isolatedProfile: true });
  const resolved = await h.service.providerEnvironment(target, "~/unused");
  assert.deepEqual(resolved, { workerRoot: "/home/ubuntu/accordagents-home", profileHome: "/home/ubuntu/accordagents-home/home" });
  const claim = h.calls.find(call => call.script.includes("environment-owner.json"));
  assert.ok(claim?.script.endsWith("'/home/ubuntu/accordagents-home' claim"));
});

test("a legacy failed attempt without resolved paths cannot reuse the default shared unit", async () => {
  const h = harness({ probe: probeOutput({ "install-root": "/home/ubuntu/accordagents-home",
    "service-name": "accordagents-home", "user-data": "/home/ubuntu/accordagents-home/data" }) });
  h.records.set("home", { machineId: "home", target: TARGET, installRoot: "", userDataDir: "",
    serviceName: "accordagents-machine", serviceScope: "system", isolatedProfile: false });
  const result = await h.service.install({ machineId: "home", operationId: "retry", target: TARGET,
    installRoot: "~/accordagents-home", isolatedProfile: true });
  assert.equal(result.record.profileHome, "/home/ubuntu/accordagents-home/home");
  assert.ok(!h.calls.find(call => call.script.includes("printf 'home=%s"))?.script.includes("SVC='accordagents-machine'"));
});

test("a foreign enrollment refuses installation before provider login, transfer or restart", async () => {
  const h = harness({ ownerFailure: "This installation belongs to another environment." });
  const result = await h.service.install({ machineId: "home", operationId: "one", target: TARGET, isolatedProfile: true });
  assert.equal(result.snapshot.phase, "error");
  assert.match(result.snapshot.error ?? "", /another environment/);
  assert.equal(h.doctorCalls.length, 0);
  assert.equal(h.uploads.length, 0);
  assert.ok(!h.calls.some(call => call.script.includes("systemctl restart")));
  assert.equal(result.record.isolatedProfile, true, "retry must keep the intended isolation");
});

test("SSH owner refusals reach setup, Settings and mirror callers without leaking command output", async () => {
  const reason = "This installation belongs to another environment; nothing was replaced.";
  const failure = new CommandError("ssh exited with code 1", {
    command: "ssh", args: [ENROLLMENT], stdout: ENROLLMENT,
    stderr: `Traceback:\n${ENROLLMENT}\nRuntimeError: ${reason}\n`, exitCode: 1, timedOut: false
  });
  const h = harness({ ownerFailure: failure });
  const result = await h.service.install({ machineId: "home", operationId: "one", target: TARGET, isolatedProfile: true });
  assert.equal(result.snapshot.error, reason);
  assert.equal(result.snapshot.phase, "error");
  assert.equal(h.doctorCalls.length, 0);
  assert.equal(h.uploads.length, 0);
  assert.ok(!JSON.stringify(h.logged).includes("SUPER-SECRET"));
  const record = { ...result.record, installRoot: LAYOUT.installRoot,
    target: { ...TARGET, hostKeyAlias: "same-instance" } };
  h.records.set("home", record);
  await assert.rejects(h.service.ensureEnvironmentOwner(record), { message: reason });
  await assert.rejects(h.service.providerEnvironment(record.target, LAYOUT.installRoot), { message: reason });
  await assert.rejects(h.service.bootstrapProjectMirror({ machineId: "home", localPath: "/project" }), { message: reason });
  assert.equal(h.syncedUp.length, 0);
});

test("an installation set up for the shared relay keeps its identity and is written back naming the User's server", async () => {
  const relayEra = { version: 1, purpose: "machine-host", issuer: { originId: "desktop", keyId: "key", publicKeyDerBase64: "same-key" },
    rendezvousId: "installed-room", stableRoutingId: "route", relaySealKeyBase64: "c2VjcmV0",
    relayUrl: "wss://relay.accordagents.com/v1/relay", outboxUrl: "https://relay.accordagents.com/v1/mailbox/events",
    fingerprint: "fingerprint", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2036-01-01T00:00:00.000Z",
    capabilities: [{ scope: "device", canRead: true, canWrite: true, canRunCloudParticipants: true, canListConversations: true }] };
  const { relayUrl: _relay, outboxUrl: _outbox, ...kept } = relayEra;
  const requested = JSON.stringify({ ...kept, rendezvousId: "replacement-room", hubUrl: "https://hub.example/" });
  let saved = requested;
  let restored = "";
  const h = harness({ recoveryOutput: JSON.stringify({ enrollment: relayEra, machineId: "original" }), getEnrollmentJson: async () => saved,
    restoreEnrollment: async (_id, _expected, recovered, originalId) => { restored = recovered; saved = recovered; return originalId; } });
  const result = await h.service.install({ machineId: "one", operationId: "restore-relay-era", target: TARGET, isolatedProfile: true });
  assert.equal(result.snapshot.phase, "ready");
  const written = JSON.parse(h.calls.find(call => call.script.includes("enrollment.json.new"))?.input ?? "{}");
  assert.equal(written.rendezvousId, "installed-room", "the machine keeps its room and the id its members carry");
  assert.equal(written.hubUrl, "https://hub.example/", "and from now on meets this desktop on the User's server");
  assert.equal("relayUrl" in written || "outboxUrl" in written, false, "nothing of the relay is written back");
  assert.deepEqual(JSON.parse(restored), written, "the desktop keeps what the machine has");
});

test("setup restores and persists the installed channel before owner checks or provider work; failed save and cancellation stop there", async () => {
  const installed = JSON.stringify({ version: 1, purpose: "machine-host", issuer: { originId: "desktop", keyId: "key", publicKeyDerBase64: "same-key" },
    rendezvousId: "installed-room", stableRoutingId: "route", relaySealKeyBase64: "c2VjcmV0", hubUrl: "https://hub.example/",
    fingerprint: "fingerprint", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2036-01-01T00:00:00.000Z",
    capabilities: [{ scope: "device", canRead: true, canWrite: true, canRunCloudParticipants: true, canListConversations: true }] });
  const requested = JSON.stringify({ ...JSON.parse(installed), rendezvousId: "replacement-room" });
  let saved = requested;
  let saves = 0;
  const h = harness({ recoveryOutput: JSON.stringify({ enrollment: JSON.parse(installed), machineId: "original" }), getEnrollmentJson: async () => saved,
    restoreEnrollment: async (_id, expected, recovered, originalId) => { assert.equal(expected, requested); assert.equal(recovered, installed); assert.equal(originalId, "original"); saved = recovered; saves++; return originalId; } });
  const result = await h.service.install({ machineId: "one", operationId: "restore", target: TARGET, isolatedProfile: true });
  assert.equal(result.snapshot.phase, "ready");
  assert.equal(saves, 1);
  assert.equal(result.record.machineId, "original");
  assert.equal(result.snapshot.machineId, "original");
  assert.equal(h.calls.find(call => call.script.endsWith(" claim"))?.input, installed);
  assert.equal(h.calls.find(call => call.script.includes("enrollment.json.new"))?.input, installed);
  assert.ok(!JSON.stringify(h.logged).includes("c2VjcmV0"));
  let commit!: () => void;
  let saving!: () => void;
  const writing = new Promise<void>(resolve => { saving = resolve; });
  const held = harness({ recoveryOutput: JSON.stringify({ enrollment: JSON.parse(installed), machineId: "original" }), getEnrollmentJson: async () => installed,
    restoreEnrollment: async () => { saving(); await new Promise<void>(resolve => { commit = resolve; }); return "original"; } });
  const first = held.service.install({ machineId: "one", operationId: "recover-home", target: TARGET });
  await writing;
  await assert.rejects(held.service.install({ machineId: "original", operationId: "competing", target: TARGET }), /still running/);
  commit();
  assert.equal((await first).record.machineId, "original");
  const failed = harness({ recoveryOutput: JSON.stringify({ enrollment: JSON.parse(installed), machineId: "original" }), getEnrollmentJson: async () => requested,
    restoreEnrollment: async () => { throw new Error("ENOSPC: cannot save connection"); } });
  const failure = await failed.service.install({ machineId: "one", operationId: "failed", target: TARGET });
  assert.equal(failure.snapshot.phase, "error");
  assert.equal(failed.doctorCalls.length, 0);
  assert.equal(failed.uploads.length, 0);
  assert.ok(!failed.calls.some(call => call.script.endsWith(" claim")));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(failed.service.ensureEnvironmentOwner({ machineId: "one", target: TARGET, installRoot: LAYOUT.installRoot }, false, controller.signal));
  const reads = failed.calls.length;
  await failed.service.ensureEnvironmentOwner({ machineId: "one", target: TARGET, installRoot: LAYOUT.installRoot }, true);
  assert.equal(failed.calls.length, reads + 1);
  assert.ok(failed.calls.at(-1)?.script.endsWith(" check"), "Check must not restore settings");
  const during = new AbortController();
  let release!: (value: string) => void;
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  let restored = false;
  const cancelled = harness({ getEnrollmentJson: async () => requested,
    readRecovery: () => { began(); return new Promise(resolve => { release = resolve; }); },
    restoreEnrollment: async () => { restored = true; } });
  const operation = cancelled.service.ensureEnvironmentOwner({ machineId: "one", target: TARGET, installRoot: LAYOUT.installRoot }, false, during.signal);
  await started; during.abort(); release(JSON.stringify({ enrollment: JSON.parse(installed) }));
  await assert.rejects(operation);
  assert.equal(restored, false, "a late SSH result cannot restore a cancelled request");
});

test("an owner claim's SSH transport failure is not mislabeled as another owner", async () => {
  const failure = new CommandError("ssh exited with code 255", {
    command: "ssh", args: [], stdout: "",
    stderr: "Connection closed\nRuntimeError: This installation belongs to another environment; nothing was replaced.\n",
    exitCode: 255, timedOut: false
  });
  const h = harness({ ownerFailure: failure });
  await assert.rejects(h.service.ensureEnvironmentOwner({ machineId: "home", target: TARGET, installRoot: LAYOUT.installRoot }),
    error => error === failure);
});

test("a failed first probe keeps isolation for a retry after restarting the desktop", async () => {
  const h = harness({ probeFailure: "SSH unavailable" });
  const result = await h.service.install({ machineId: "home", operationId: "one", target: TARGET,
    installRoot: "~/accordagents-home", isolatedProfile: true });
  assert.equal(result.record.isolatedProfile, true);
  assert.equal(result.record.profileHome, undefined);
  const restarted = harness({ probe: probeOutput({ "install-root": "/home/ubuntu/accordagents-home",
    "user-data": "/home/ubuntu/accordagents-home/data", "service-name": "accordagents-home" }) });
  restarted.records.set("home", JSON.parse(JSON.stringify(result.record)));
  const retried = await restarted.service.install({ machineId: "home", operationId: "retry", target: TARGET });
  assert.equal(retried.record.profileHome, "/home/ubuntu/accordagents-home/home");
  assert.equal(retried.record.serviceName, "accordagents-home");
  assert.equal(restarted.doctorCalls[0].options?.profileHome, retried.record.profileHome);
  assert.equal(restarted.doctorCalls[0].workerRoot, retried.record.installRoot);
  const unit = restarted.calls.find(call => call.input?.includes("[Service]"))?.input ?? "";
  assert.ok(unit.includes("Environment=HOME=" + retried.record.profileHome));
  assert.ok(unit.includes("Environment=ACCORD_AGENTS_MACHINE_PROFILE_HOME=" + retried.record.profileHome));
});

test("no script removes the machine's user data, enrollment or a worktree", () => {
  const scripts = [
    machineProbeScript({}),
    machineDrainScript(LAYOUT),
    machineMirrorProbeScript("/home/ubuntu/accordagents-machine/workspace/mirrors/p/repo"),
    writeFileFromStdinScript(LAYOUT.enrollmentPath, "600")
  ];
  for (const script of scripts) {
    assert.ok(!/\brm\b/.test(script), `a setup script must not remove anything: ${script.slice(0, 80)}`);
  }
});

test("the enrollment travels on stdin and never reaches a command line or a log", async () => {
  const h = harness();
  await h.service.install({ machineId: "m1", operationId: "op1", target: TARGET });
  const enrollCall = h.calls.find((call) => call.input === ENROLLMENT && call.script.includes("cat > "));
  assert.ok(enrollCall, "the enrollment must be written from stdin");
  assert.ok(enrollCall.script.includes("cat > "));
  assert.ok(enrollCall.script.includes("chmod 600"));
  for (const call of h.calls) {
    assert.ok(!call.script.includes("SUPER-SECRET-PAIRING-KEY"), "no script may contain the pairing key");
  }
  assert.ok(!JSON.stringify(h.logged).includes("SUPER-SECRET-PAIRING-KEY"));
  assert.ok(!JSON.stringify([...h.records.values()]).includes("SUPER-SECRET-PAIRING-KEY"));
});

test("an upgrade keeps the enrollment that is already on the machine", async () => {
  const h = harness({
    probe: probeOutput({
      state: JSON.stringify({ version: "1.3.0", digest: "old" }),
      "active-release": "1.3.0-old", enrollment: "present", "service-scope": "system", "service-state": "active"
    }, ["1.3.0-old"])
  });
  await h.service.upgrade({ machineId: "m1", operationId: "op4", target: TARGET });
  assert.ok(h.calls.some(call => call.input === ENROLLMENT && call.script.includes("environment-owner.json")), "the existing owner must be checked");
  assert.ok(!h.calls.some(call => call.input === ENROLLMENT && call.script.includes("cat > ")), "an upgrade must not re-pair the machine");
});

function recordingIdentity(known = false): { adopted: Array<{ machineId: string; originId: string; key: string }>; adoptIdentity(machineId: string, identity: { originId: string; publicKeyDerBase64: string }): Promise<void>; identityKnown(): Promise<boolean> } {
  const recorder = {
    adopted: [] as Array<{ machineId: string; originId: string; key: string }>,
    async adoptIdentity(machineId: string, identity: { originId: string; publicKeyDerBase64: string }) {
      recorder.adopted.push({ machineId, originId: identity.originId, key: identity.publicKeyDerBase64 });
    },
    async identityKnown() { return known; }
  };
  return recorder;
}

test("setup reads the machine's identity while nothing runs, after the drain and before the switch, and records it on this desktop", async () => {
  const identity = recordingIdentity();
  const h = harness({ adoptIdentity: identity.adoptIdentity, identityKnown: identity.identityKnown });
  const phases: string[] = [];
  const result = await h.service.install({ machineId: "m1", operationId: "op-identity", target: TARGET }, (snapshot) => phases.push(snapshot.phase));
  assert.equal(result.snapshot.phase, "ready");
  assert.deepEqual(phases, ["preflight", "bundle", "transfer", "dependencies", "enroll", "drain", "identity", "activate", "service", "starting", "verify", "ready"]);
  // The User's server admits it by this key before it first connects.
  assert.deepEqual(identity.adopted, [{ machineId: "m1", originId: "machine-origin", key: "MACHINE-PUBLIC-KEY" }]);
  const identityIndex = h.calls.findIndex((call) => call.script.includes(" --device-identity "));
  const drainIndex = h.calls.findIndex((call) => call.script.includes("printf 'drained="));
  const activateIndex = h.calls.findIndex((call) => call.script.includes("mv -Tf"));
  assert.ok(drainIndex < identityIndex && identityIndex < activateIndex);
  assert.ok(!h.calls.some((call) => /chat-copy|import-chat/.test(call.script)), "no copy of the chats goes over the setup connection");
});

test("an upgrade of a machine whose identity this desktop knows reads nothing", async () => {
  const identity = recordingIdentity(true);
  const h = harness({
    adoptIdentity: identity.adoptIdentity, identityKnown: identity.identityKnown,
    probe: probeOutput({
      state: JSON.stringify({ version: "1.3.0", digest: "old" }),
      "active-release": "1.3.0-old", enrollment: "present", "service-scope": "system", "service-state": "active"
    }, ["1.3.0-old"])
  });
  const result = await h.service.upgrade({ machineId: "m1", operationId: "op-up", target: TARGET });
  assert.equal(result.snapshot.phase, "ready");
  assert.deepEqual(identity.adopted, []);
  assert.ok(!h.calls.some((call) => call.script.includes(" --device-identity ")));
});

test("the first upgrade of a machine whose identity this desktop does not know reads it", async () => {
  const identity = recordingIdentity(false);
  const h = harness({
    adoptIdentity: identity.adoptIdentity, identityKnown: identity.identityKnown,
    probe: probeOutput({
      state: JSON.stringify({ version: "1.3.0", digest: "old" }),
      "active-release": "1.3.0-old", enrollment: "present", "service-scope": "system", "service-state": "active"
    }, ["1.3.0-old"])
  });
  const result = await h.service.upgrade({ machineId: "m1", operationId: "op-first", target: TARGET });
  assert.equal(result.snapshot.phase, "ready");
  assert.equal(identity.adopted.length, 1);
});

test("a failed identity read replaces nothing and starts the old runtime again", async () => {
  const identity = recordingIdentity(false);
  const h = harness({
    adoptIdentity: identity.adoptIdentity, identityKnown: identity.identityKnown,
    identityFailure: "disk full",
    probe: probeOutput({
      state: JSON.stringify({ version: "1.3.0", digest: "old" }),
      "active-release": "1.3.0-old", enrollment: "present", "service-scope": "system", "service-state": "active",
      "runtime-pids": "4210"
    }, ["1.3.0-old"])
  });
  const result = await h.service.upgrade({ machineId: "m1", operationId: "op-fail", target: TARGET });
  assert.equal(result.snapshot.phase, "error");
  assert.match(result.snapshot.error ?? "", /Reading the machine's identity failed: disk full/);
  assert.equal(result.snapshot.recovery?.kind, "old-runtime-still-installed");
  assert.match(result.snapshot.recovery?.detail ?? "", /it was started again/);
  assert.ok(!h.calls.some((call) => call.script.includes("mv -Tf")), "the release must not be switched");
  const identityIndex = h.calls.findIndex((call) => call.script.includes(" --device-identity "));
  assert.ok(h.calls.slice(identityIndex + 1).some((call) => call.script.includes(" start 'accordagents-machine.service'")),
    "the old runtime is started again");
  assert.deepEqual(identity.adopted, []);
});
