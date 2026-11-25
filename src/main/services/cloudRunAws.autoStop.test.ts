import assert from "node:assert/strict";
import type { MachineRecoveryFailure } from "./machineRecovery";
import test from "node:test";
import { awsDependencies } from "./cloudRunAws/test/awsParts";
import { encodeWorkerBlob } from "./awsWorkerProvisioning";
import {
  FakeEc2Client, FakeSettings, installFor, NEW_CREDS, OLD_CREDS, OLD_HANDLE, POWER_HANDLE, POWER_KEY, powerSettings, serviceWith,
  waitFor
} from "./cloudRunAws/test/awsFixtures";

test("a Settings-only AWS operation rearms automatic idle stop", async () => {
  const settings = new FakeSettings();
  // Automatic stop is on: a stop key for the instance's region is saved.
  settings.credentials = { ...OLD_CREDS, power: { accessKeyId: "AKIAPOWERKEY000000001", secretAccessKey: "power-secret" } };
  settings.handle = { ...OLD_HANDLE, instanceId: "i-0123456789abcdef0" };
  settings.mode = "aws";
  const client = new FakeEc2Client({ instanceId: "i-0123456789abcdef0", state: "running", publicIp: "198.51.100.10" });
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]), {
    idleStopMs: 5,
    idleStopRetryMs: 5,
    automaticStopGate: {
      authorizeAutomaticWorkerStop: async () => ({
        allowed: true,
        lease: { leaseId: "stop-lease", expiresAt: new Date(Date.now() + 30_000).toISOString() }
      }),
      renewAutomaticWorkerStopLease: async (_worker, lease) => lease,
      releaseAutomaticWorkerStopLease: async () => undefined
    }
  });

  await service.withRunReference("settings-operation", async () => {
    await service.ensureWorkerForRun();
    assert.equal(awsDependencies(service).lifecycle.activeRuns, 1);
  });
  assert.equal(awsDependencies(service).lifecycle.activeRuns, 0);
  await waitFor(() => client.state?.state === "stopped");
});

test("only the machine on this app's instance gets the stop key, scoped to the instance's region", async () => {
  const settings = powerSettings();
  const service = serviceWith(settings, new Map());
  assert.deepEqual(await service.machinePowerFor("cloud"), {
    version: 1, instanceId: POWER_HANDLE.instanceId, credentials: { ...POWER_KEY, region: "us-east-1" }
  });
  assert.equal(await service.machinePowerFor("desk-box"), undefined, "a machine elsewhere never gets it");
  assert.equal(await service.machinePowerFor("missing"), undefined);
  settings.handle = { ...POWER_HANDLE, region: "eu-west-1" };
  assert.equal(await service.machinePowerFor("cloud"), undefined, "a key for another region cannot stop this instance");
  settings.handle = POWER_HANDLE;
  settings.credentials = OLD_CREDS;
  assert.equal(await service.machinePowerFor("cloud"), undefined, "an older setup without a stop key hands nothing over");
});

test("the switch is on only with a stop key the User left on; Diagnostics names only what keeps it from working", async () => {
  const settings = powerSettings();
  const client = new FakeEc2Client({ instanceId: POWER_HANDLE.instanceId, state: "running" });
  let connected: boolean | undefined = true;
  let recoveryFailure: MachineRecoveryFailure | undefined;
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]),
    { machineConnected: () => connected, machineRecoveryFailure: () => recoveryFailure });
  const autoStop = async () => (await service.status()).autoStop;
  const ON = { enabled: true, needsSetup: false };
  const SET_UP_AGAIN = { ...ON, problem: { message: "AWS does not accept the automatic-stop key.", action: "set-up-again", actionLabel: "Set up again" } };
  const TRY_AGAIN = { ...ON, problem: { message: "The cloud machine could not take its automatic-stop key.", action: "reconnect", actionLabel: "Try again", machineId: "cloud" } };
  assert.deepEqual(await autoStop(), { ...ON, problem: { message: "Works once the cloud program is installed (see Cloud program)." } });
  settings.installs = [installFor("cloud")];
  assert.deepEqual(await autoStop(), ON, "a key the machine has not taken yet goes over once it is idle; nothing to do");
  settings.installs = [installFor("cloud", { power: { keyId: "AKIAPOWERKEY000000000", configuredAt: "t" } })];
  assert.deepEqual(await autoStop(), ON, "a machine still on its older key takes this one the same way");
  settings.installs = [installFor("cloud", { powerError: { keyId: POWER_KEY.accessKeyId, message: "names a different AWS machine", failedAt: "t" } })];
  assert.deepEqual(await autoStop(), SET_UP_AGAIN);
  settings.installs = [installFor("cloud", { power: { keyId: "AKIAPOWERKEY000000000", configuredAt: "t" },
    powerError: { keyId: POWER_KEY.accessKeyId, message: "AWS refused the automatic-stop key.", failedAt: "t" } })];
  assert.deepEqual(await autoStop(), SET_UP_AGAIN, "a refused new key is set up again even while an older one still works");
  const stalledOp = (operationId: string, extra: object = {}) => ({ machineId: "cloud", operationId, kind: "upgrade" as const,
    phase: "needs-attention" as const, message: "The desktop closed while the machine was being set up.", updatedAt: "t", completed: [], ...extra });
  const versioned = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]), { appVersion: "1.11.1-beta.6", machineConnected: () => connected });
  settings.installs = [installFor("cloud", { installedVersion: "1.11.1-beta.2", lastOperation: stalledOp("auto-upgrade-1.11.1-beta.6-1") })];
  assert.deepEqual((await versioned.status()).autoStop, TRY_AGAIN, "an update of this version that gave up is not repeated by itself");
  settings.installs = [installFor("cloud", { installedVersion: "1.11.1-beta.2", lastOperation: stalledOp("auto-upgrade-1.11.1-beta.3-1") })];
  assert.deepEqual((await versioned.status()).autoStop, ON, "an older version's failed update does not hold this one back");
  settings.installs = [installFor("cloud", { installedVersion: "1.11.1-beta.2",
    lastOperation: stalledOp("auto-upgrade-1.11.1-beta.6-2", { recovery: { kind: "machine-busy" } }) })];
  assert.deepEqual((await versioned.status()).autoStop, ON, "agents working on the machine are not a problem; it is tried again once idle");
  settings.installs = [installFor("cloud", { powerRetry: { keyId: POWER_KEY.accessKeyId, message: "AWS could not be reached.", failedAt: "t" } })];
  assert.deepEqual(await autoStop(), ON, "a hand-over that is retried by itself needs nothing");
  settings.installs = [installFor("cloud", { powerRetry: { keyId: POWER_KEY.accessKeyId, message: "AWS could not be reached.", failedAt: "t", attempts: 3 } })];
  assert.deepEqual(await autoStop(), TRY_AGAIN, "after the last automatic try the User is offered one");
  settings.installs = [installFor("cloud", { power: { keyId: POWER_KEY.accessKeyId, configuredAt: "t" } })];
  assert.deepEqual(await autoStop(), ON);
  settings.machines[0] = { ...settings.machines[0], lastHello: { keepAwakeScripts: 2 } };
  assert.deepEqual(await autoStop(), { ...ON, keptOnByScripts: 2 }, "switched-on scripts keep it running, and the row says so");
  settings.machines[0] = { ...settings.machines[0], lastHello: { idleStopWarning:
    "The machine stays awake: Another deployment on this machine (/tmp/accord-choice-repro-vYcpVH/machine and 6 more) is running work." } };
  assert.deepEqual(await autoStop(), ON, "an older runtime reporting agents at work is not a problem");
  for (const ordinary of [
    "The machine stays awake: Another deployment on this machine (/srv/other) is running a maintenance command.",
    "The machine stays awake: another deployment on this machine worked recently.",
    "The machine is stopping after three hours idle; new turns remain queued.",
    "The AWS machine is stopping after three hours idle; queued turns run after it wakes."
  ]) {
    settings.machines[0] = { ...settings.machines[0], lastHello: { idleStopWarning: ordinary } };
    assert.deepEqual(await autoStop(), ON, ordinary);
  }
  settings.machines[0] = { ...settings.machines[0], lastHello: { idleStopWarning: "Idle stop is not confirmed; native work remains queued: throttled" } };
  assert.match((await autoStop())?.problem?.message ?? "", /has not finished yet; it keeps trying/);
  settings.machines[0] = { ...settings.machines[0], lastHello: { idleStopWarning: "Automatic idle stop is suspended: metadata unavailable" } };
  assert.deepEqual(await autoStop(), { ...ON, problem: { message:
    "The cloud machine could not finish its check, so it stays on for now and tries again by itself. If this stays, stop the instance when you finish." } },
  "the machine's own fault is shown, in plain words");
  settings.changedAt = new Date(Date.now() - 60_000).toISOString();
  settings.machines[0] = { ...settings.machines[0], lastSeenAt: new Date(Date.now() - 120_000).toISOString(), lastHello: { autoStopEnabled: false } } as never;
  assert.deepEqual(await autoStop(), ON, "a report from before the change says nothing about it");
  settings.machines[0] = { ...settings.machines[0], lastSeenAt: new Date().toISOString(), lastHello: { autoStopEnabled: false } } as never;
  assert.match((await autoStop())?.problem?.message ?? "", /still has automatic stop switched off/, "the machine says it did not get the switch");
  settings.autoStopEnabled = false;
  assert.equal((await autoStop())?.problem, undefined, "off, and the machine has it off");
  settings.machines[0] = { ...settings.machines[0], lastSeenAt: new Date().toISOString(), lastHello: { autoStopEnabled: true } } as never;
  assert.match((await autoStop())?.problem?.message ?? "", /still has automatic stop switched on, so it may stop the instance/);
  settings.machines[0] = { ...settings.machines[0], lastSeenAt: new Date().toISOString(), lastHello: {} } as never;
  assert.match((await autoStop())?.problem?.message ?? "", /older and still stops the instance by itself/, "a runtime before the switch ignores off");
  connected = true;
  settings.changedAt = new Date().toISOString();
  settings.machines[0] = { ...settings.machines[0], lastSeenAt: new Date().toISOString(), lastHello: { autoStopEnabled: true } } as never;
  assert.equal((await autoStop())?.problem, undefined, "a report moments after the change may predate the settings it is about");
  settings.autoStopEnabled = true;
  settings.changedAt = undefined;
  settings.machines[0] = { ...settings.machines[0], lastHello: { idleStopWarning:
    "Automatic idle stop is suspended: AWS does not accept this machine's stop key, so it stays awake (AuthFailure: AWS was not able to validate the provided access credentials)." } };
  assert.deepEqual(await autoStop(), SET_UP_AGAIN, "a key AWS stopped accepting is set up again");
  settings.machines[0] = { id: "cloud", awsInstanceId: POWER_HANDLE.instanceId };
  connected = false;
  assert.deepEqual(await autoStop(), ON, "a program out of touch is brought back by the app; the User is not asked");
  assert.equal((await service.status()).machineProblem, undefined);
  recoveryFailure = { kind: "setup", reason: "ssh: connect to host 203.0.113.9 port 22: Operation timed out\nmore detail" };
  const DOWN = "The AccordAgents program on the cloud machine is not running, and the app could not start it again. "
    + "ssh: connect to host 203.0.113.9 port 22: Operation timed out. It tries again by itself. "
    + "Until it is, cloud members don't run and the instance does not stop by itself.";
  assert.equal((await service.status()).machineProblem, DOWN, "only what did not come back is shown, as itself and with its reason");
  assert.deepEqual(await autoStop(), ON, "not as a detail of automatic stop");
  settings.autoStopEnabled = false;
  assert.deepEqual(await service.status().then((status) => [status.autoStop, status.machineProblem]),
    [{ enabled: false, needsSetup: false }, DOWN], "switched off or not");
  settings.autoStopEnabled = true;
  recoveryFailure = { kind: "agents" };
  assert.match((await service.status()).machineProblem ?? "", /agents it started are still running there\. The app starts it again once they finish\./);
  recoveryFailure = { kind: "running" };
  assert.match((await service.status()).machineProblem ?? "", /is running, but this computer has not heard from it/);
  recoveryFailure = { kind: "check", reason: "The AWS instance is stopping, so nothing was started." };
  assert.match((await service.status()).machineProblem ?? "", /could not reach the machine to check it\. The AWS instance is stopping/);
  recoveryFailure = { kind: "setup", reason: "ssh: connect to host 203.0.113.9 port 22: Operation timed out\nmore detail" };
  client.state = { instanceId: POWER_HANDLE.instanceId, state: "stopped" };
  assert.deepEqual(await service.status().then((status) => [status.autoStop, status.machineProblem]), [ON, undefined],
    "a stopped instance has no program to run");
  client.state = { instanceId: POWER_HANDLE.instanceId, state: "running", launchedAt: new Date(Date.now() - 3_600_000).toISOString() };
  assert.equal((await service.probeAccess()).machineProblem, DOWN, "the read-only check reports it too");
  connected = undefined;
  assert.equal((await service.status()).machineProblem, undefined, "nothing is said while this desktop does not know yet");
  connected = false;
  assert.equal(await service.instanceRunningSince(), Date.parse(client.state.launchedAt!));
  client.state = { instanceId: POWER_HANDLE.instanceId, state: "stopped" };
  assert.equal(await service.instanceRunningSince(), undefined);
  client.state = { instanceId: POWER_HANDLE.instanceId, state: "running" };
  recoveryFailure = undefined;
  connected = true;
  settings.installs = [installFor("desk-box", { power: { keyId: POWER_KEY.accessKeyId, configuredAt: "t" } })];
  assert.equal((await autoStop())?.problem?.message, "Works once the cloud program is installed (see Cloud program).", "a machine elsewhere does not count");
  settings.autoStopEnabled = false;
  assert.deepEqual(await autoStop(), { enabled: false, needsSetup: false }, "switched off with a key: on again needs no command");
  settings.credentials = OLD_CREDS;
  settings.autoStopEnabled = true;
  assert.deepEqual(await autoStop(), { enabled: false, needsSetup: true }, "no stop key: the switch is off and turning it on asks for one");
});

test("the switch turns on only with a usable key, and off keeps the key", async () => {
  const settings = powerSettings();
  const service = serviceWith(settings, new Map());
  assert.equal(await service.autoStopSwitchedOn(), true);
  assert.deepEqual(await service.setAutoStop({ enabled: false }), { keyAdded: false });
  assert.equal(settings.autoStopEnabled, false);
  assert.equal(await service.autoStopSwitchedOn(), false, "this desktop's own idle stop is held too");
  assert.deepEqual(settings.credentials?.power, POWER_KEY, "the key stays for turning it on again");
  await service.setAutoStop({ enabled: true });
  assert.equal(settings.autoStopEnabled, true);
  settings.handle = { ...POWER_HANDLE, region: "eu-west-1" };
  settings.autoStopEnabled = false;
  await assert.rejects(service.setAutoStop({ enabled: true }), /Run the setup command first/, "a key for another region cannot stop this instance");
  assert.equal(settings.autoStopEnabled, false, "nothing changes");
  settings.handle = POWER_HANDLE;
  settings.installs = [installFor("cloud", { power: { keyId: POWER_KEY.accessKeyId, configuredAt: "t" } }), installFor("other")];
  settings.machines.push({ id: "other", awsInstanceId: POWER_HANDLE.instanceId });
  assert.equal((await service.autoStopMachineRecord())?.machineId, "cloud", "the fix acts on the machine that holds the key");
});

test("turning automatic stop on takes only a result that carries a stop key", async () => {
  const settings = powerSettings();
  settings.credentials = OLD_CREDS;
  const client = new FakeEc2Client({ instanceId: POWER_HANDLE.instanceId, state: "running" });
  const service = serviceWith(settings, new Map([[NEW_CREDS.accessKeyId, client], [`${NEW_CREDS.accessKeyId}:us-east-1`, client]]));
  await assert.rejects(service.adoptAutoStopKey(encodeWorkerBlob(NEW_CREDS)), /no automatic-stop key/);
  assert.equal(settings.credentials, OLD_CREDS, "nothing is saved");
  await service.adoptAutoStopKey(encodeWorkerBlob({ ...NEW_CREDS, power: POWER_KEY }));
  assert.deepEqual(settings.credentials, { ...NEW_CREDS, power: POWER_KEY });
});

test("a pasted stop key is kept with the app's key; one for another region is refused and nothing is saved", async () => {
  const settings = powerSettings();
  settings.credentials = OLD_CREDS;
  const client = new FakeEc2Client({ instanceId: POWER_HANDLE.instanceId, state: "running" });
  const withPower = { ...NEW_CREDS, power: POWER_KEY };
  const service = serviceWith(settings, new Map([[NEW_CREDS.accessKeyId, client], [`${NEW_CREDS.accessKeyId}:us-east-1`, client]]));
  await assert.rejects(service.adoptCredentials(encodeWorkerBlob({ ...withPower, region: "eu-west-1" })), /run for eu-west-1, but the instance is in us-east-1/);
  assert.equal(settings.credentials, OLD_CREDS);
  await service.adoptCredentials(encodeWorkerBlob(withPower));
  assert.deepEqual(settings.credentials, withPower);
  assert.equal(client.runCount, 0, "turning on automatic stop creates nothing");
  // A later result without a stop key (none could be made) keeps the one the
  // app has: it is still valid, and the machine may be running with it.
  const later = { ...NEW_CREDS, accessKeyId: "AKIANEWWORKER0000009" };
  const laterService = serviceWith(settings, new Map([[later.accessKeyId, client], [`${later.accessKeyId}:us-east-1`, client]]));
  const WAKE_KEY = { accessKeyId: "AKIAWAKEKEY000000001", secretAccessKey: "wake-secret" };
  settings.credentials = { ...settings.credentials!, wake: WAKE_KEY };
  await laterService.adoptCredentials(encodeWorkerBlob(later));
  assert.deepEqual(settings.credentials, { ...later, power: POWER_KEY, wake: WAKE_KEY },
    "a later result never carries the start key phones hold, so the app keeps it");
  assert.equal((await laterService.status()).autoStop?.enabled, true, "automatic stop does not read as off");
});

test("the setup command keeps every key still in use: the app's, the one not handed over yet, and the machine's", async () => {
  const settings = powerSettings();
  settings.installs = [installFor("cloud", { power: { keyId: "AKIAPOWERKEY000000000", configuredAt: "t" } })];
  const service = serviceWith(settings, new Map());
  const command = await service.bootstrapCommand("us-east-1");
  assert.match(command, new RegExp(`^KEEP_WORKER_KEY=${OLD_CREDS.accessKeyId}$`, "m"));
  assert.match(command, new RegExp(`^KEEP_POWER_KEYS='${POWER_KEY.accessKeyId} AKIAPOWERKEY000000000'$`, "m"));
  settings.installs = [installFor("desk-box", { power: { keyId: "AKIAPOWERKEY000000009", configuredAt: "t" } })];
  assert.match(await service.bootstrapCommand("us-east-1"), new RegExp(`^KEEP_POWER_KEYS='${POWER_KEY.accessKeyId}'$`, "m"),
    "only a machine on this instance counts");
  settings.credentials = { ...settings.credentials!, wake: { accessKeyId: "AKIAWAKEKEY000000001", secretAccessKey: "wake-secret" } };
  assert.match(await service.bootstrapCommand("us-east-1"), /^KEEP_WAKE_KEY=AKIAWAKEKEY000000001$/m, "the phone's start key is never made again");
  // A stop key a machine refused, and no machine holds, may be replaced.
  settings.installs = [installFor("cloud", { power: { keyId: "AKIAPOWERKEY000000000", configuredAt: "t" },
    powerError: { keyId: POWER_KEY.accessKeyId, message: "refused", failedAt: "t" } })];
  assert.match(await service.bootstrapCommand("us-east-1"), /^KEEP_POWER_KEYS='AKIAPOWERKEY000000000'$/m,
    "setting automatic stop up again can make a new key");
  // Not knowing which keys are in use is not "none in use".
  settings.listMachineInstalls = async () => { throw new Error("settings unreadable"); };
  await assert.rejects(service.bootstrapCommand("us-east-1"), /settings unreadable/);
});

test("the phone's start key is offered for this app's instance and its region only", async () => {
  const settings = powerSettings();
  const service = serviceWith(settings, new Map());
  assert.equal(await service.deviceWakePower(), undefined, "an older setup without a start key hands nothing to a phone");
  const wake = { accessKeyId: "AKIAWAKEKEY000000001", secretAccessKey: "wake-secret" };
  settings.credentials = { ...settings.credentials!, wake };
  assert.deepEqual(await service.deviceWakePower(), {
    machineId: "cloud",
    config: { version: 1, instanceId: POWER_HANDLE.instanceId, credentials: { ...wake, region: "us-east-1" } }
  });
  settings.handle = { ...POWER_HANDLE, region: "eu-west-1" };
  assert.equal(await service.deviceWakePower(), undefined, "a key for another region cannot start this instance");
});

test("a machine installed over the instance's pinned host key counts as on the instance", async () => {
  const settings = powerSettings();
  settings.machines = [{ id: "pinned" }];
  settings.installs = [installFor("pinned", { target: { host: "203.0.113.9", user: "ubuntu", hostKeyAlias: `accordagents-${POWER_HANDLE.instanceId}` } })];
  const service = serviceWith(settings, new Map());
  assert.equal((await service.machinePowerFor("pinned"))?.instanceId, POWER_HANDLE.instanceId);
});

test("a setup command for another region leaves the instance's stop and start keys alone", async () => {
  const settings = powerSettings();
  const service = serviceWith(settings, new Map());
  const elsewhere = await service.bootstrapCommand("eu-west-1");
  assert.doesNotMatch(elsewhere, /POWER_USER=|WAKE_USER=/);
  assert.match(await service.bootstrapCommand("us-east-1"), /POWER_USER=/);
});
