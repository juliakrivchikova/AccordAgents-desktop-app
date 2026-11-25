import assert from "node:assert/strict";
import test from "node:test";
import { awsDependencies } from "./cloudRunAws/test/awsParts";
import { resolveCurrentWorkerAddress } from "./cloudRunWorkers";
import {
  FakeEc2Client, FakeSettings, instanceWithMachines, notAuthorized, OLD_CREDS, OLD_HANDLE, serviceWith
} from "./cloudRunAws/test/awsFixtures";

test("deleteWorker retains settings when termination fails", async () => {
  const settings = new FakeSettings();
  settings.credentials = OLD_CREDS;
  settings.handle = OLD_HANDLE;
  settings.mode = "aws";
  const oldClient = new FakeEc2Client({ instanceId: "i-old", state: "running", publicIp: "198.51.100.10" });
  oldClient.terminateError = new Error("AccessDenied");
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, oldClient]]));

  const status = await service.deleteWorker();
  assert.equal(status.configured, true);
  assert.equal(status.state, "running");
  assert.match(status.message ?? "", /not deleted/);
  assert.deepEqual(settings.credentials, OLD_CREDS);
  assert.deepEqual(settings.handle, OLD_HANDLE);
  assert.equal(settings.mode, "aws");
});

test("stopWorker retains configured state and reports an authorization failure", async () => {
  const settings = new FakeSettings();
  settings.credentials = OLD_CREDS;
  settings.handle = OLD_HANDLE;
  settings.mode = "aws";
  const client = new FakeEc2Client({ instanceId: "i-old", state: "running", publicIp: "198.51.100.10" });
  client.stopError = Object.assign(new Error("not authorized to perform ec2:StopInstances"), { name: "UnauthorizedOperation" });
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]));

  const status = await service.stopWorker();
  assert.equal(status.configured, true);
  assert.equal(status.state, "running");
  assert.match(status.message ?? "", /not stopped.*settings were retained/i);
  assert.deepEqual(settings.handle, OLD_HANDLE);
});

test("ensureWorkerForRun uses the current device SSH identity", async () => {
  const settings = new FakeSettings();
  settings.credentials = OLD_CREDS;
  settings.handle = OLD_HANDLE;
  settings.mode = "aws";
  const oldClient = new FakeEc2Client({ instanceId: "i-old", state: "running", publicIp: "198.51.100.10" });
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, oldClient]]));

  const worker = await service.ensureWorkerForRun();
  assert.equal(worker.host, "198.51.100.10");
  assert.equal(worker.identityFile, "/keys/accordagents-worker-new.pem");
  assert.equal(worker.workerRoot, "~/.accordagents/remote-runs/devices/device-a");
  assert.equal(worker.hostKeyAlias, "accordagents-i-old");
  assert.deepEqual(oldClient.revokedSecurityGroups, []);
  assert.deepEqual(oldClient.authorizedCidrs, ["203.0.113.9/32"]);
});

test("ensureWorkerForRun uses an existing running worker when instance-type metadata is unauthorized", async () => {
  const settings = new FakeSettings();
  settings.credentials = OLD_CREDS;
  settings.handle = { ...OLD_HANDLE, rootVolumeSizeGb: 8, vCpu: 2, memoryMiB: 2048 };
  settings.mode = "aws";
  const client = new FakeEc2Client({
    instanceId: "i-old",
    state: "running",
    publicIp: "198.51.100.10",
    instanceType: "t3.small"
  });
  client.describeTypeError = Object.assign(
    new Error("not authorized to perform ec2:DescribeInstanceTypes"),
    { name: "UnauthorizedOperation" }
  );
  const logs: string[] = [];
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]), {
    logger: (event) => logs.push(event)
  });

  const worker = await service.ensureWorkerForRun();

  assert.equal(worker.host, "198.51.100.10");
  assert.equal(worker.hostKeyAlias, "accordagents-i-old");
  assert.deepEqual(client.authorizedCidrs, ["203.0.113.9/32"]);
  assert.deepEqual(client.runTokens, []);
  assert.equal(logs.includes("aws-worker.capacity.authorization-fallback"), true);
});

test("AWS run references are acquired and released exactly once per run id", async () => {
  const settings = new FakeSettings();
  settings.credentials = OLD_CREDS;
  settings.handle = OLD_HANDLE;
  settings.mode = "aws";
  const client = new FakeEc2Client({ instanceId: "i-old", state: "running", publicIp: "198.51.100.10" });
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]));

  service.noteRunStarted("run-1");
  service.noteRunStarted("run-1");
  assert.equal(awsDependencies(service).lifecycle.activeRuns, 1);
  await service.noteRunEnded("run-1");
  await service.noteRunEnded("run-1");
  assert.equal(awsDependencies(service).lifecycle.activeRuns, 0);
});

test("two device IDs isolate identical local project paths under distinct worker roots", async () => {
  const roots: string[] = [];
  for (const deviceId of ["laptop-a", "laptop-b"]) {
    const settings = new FakeSettings();
    settings.deviceId = deviceId;
    settings.credentials = OLD_CREDS;
    settings.handle = OLD_HANDLE;
    settings.mode = "aws";
    const client = new FakeEc2Client({ instanceId: "i-old", state: "running", publicIp: "198.51.100.10" });
    const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]));
    roots.push((await service.ensureWorkerForRun()).workerRoot ?? "");
  }
  assert.deepEqual(roots, [
    "~/.accordagents/remote-runs/devices/laptop-a",
    "~/.accordagents/remote-runs/devices/laptop-b"
  ]);
});

// Reproduces what the running app did on 2026-08-20: the instance was at
// 100.53.185.170, while stored session handles still carried 13.218.239.105 and
// 18.215.177.157 from earlier stop/start cycles. Every reconcile pass dialled
// those dead addresses and spent a 15s SSH timeout on each.
test("a stored worker address from a previous stop/start resolves to the address the box has now", () => {
  const alias = "accordagents-i-0943b28f7231ab93c";
  const current = {
    host: "100.53.185.170",
    user: "ubuntu",
    identityFile: "/keys/worker.pem",
    hostKeyAlias: alias,
    workerRoot: "~/.accordagents/remote-runs/devices/device-a"
  };
  const stale = { ...current, host: "13.218.239.105" };

  const resolved = resolveCurrentWorkerAddress(stale, current);
  assert.equal(resolved?.host, "100.53.185.170", "the live address must win over the recorded one");
  assert.equal(resolved?.workerRoot, stale.workerRoot, "the recorded worker root still points at that box's session dirs");
});

test("a worker we no longer manage is dropped instead of dialled", () => {
  const current = {
    host: "100.53.185.170",
    user: "ubuntu",
    hostKeyAlias: "accordagents-i-0943b28f7231ab93c",
    workerRoot: "~/.accordagents/remote-runs/devices/device-a"
  };
  const otherMachine = { ...current, host: "18.215.177.157", hostKeyAlias: "accordagents-i-deadbeefdeadbeef" };

  assert.equal(
    resolveCurrentWorkerAddress(otherMachine, current),
    undefined,
    "a different instance is not ours to reach; dialling it only burns an SSH timeout"
  );
});

test("a manually configured SSH worker is left exactly as recorded", () => {
  const manual = { host: "box.example.com", user: "dev", workerRoot: "/srv/worker" };
  assert.deepEqual(resolveCurrentWorkerAddress(manual, undefined), manual);
  assert.deepEqual(resolveCurrentWorkerAddress(manual, { host: "10.0.0.9", user: "dev", workerRoot: "/srv" }), manual);
});

test("the AWS handle records the address the box came back on after a stop/start", () => {
  // ensurePreparedRunning is the one path every cloud run goes through, so it is
  // where the app learns the live address. The coordinator then resolves stored
  // handles against it instead of dialling the address they were created with.
  const handle = { instanceId: "i-0943b28f7231ab93c", lastKnownHost: "13.218.239.105" } as { instanceId: string; lastKnownHost?: string };
  const cameBackOn = "100.53.185.170";
  const hostChanged = handle.lastKnownHost !== cameBackOn;
  assert.equal(hostChanged, true, "a new address must be persisted, not ignored");
  handle.lastKnownHost = cameBackOn;

  const current = {
    host: handle.lastKnownHost,
    user: "ubuntu",
    hostKeyAlias: `accordagents-${handle.instanceId}`,
    workerRoot: "~/.accordagents/remote-runs/devices/device-a"
  };
  const storedSessionHandleWorker = { ...current, host: "13.218.239.105" };
  assert.equal(resolveCurrentWorkerAddress(storedSessionHandleWorker, current)?.host, cameBackOn);
});

for (const [label, state] of [["terminated", { instanceId: OLD_HANDLE.instanceId, state: "terminated" as const }], ["no longer known to AWS", undefined]] as const) {
  test(`Delete of an instance that is already ${label} succeeds without terminating it and still cleans up`, async () => {
    const { settings, removed, removeMachine } = instanceWithMachines();
    const client = new FakeEc2Client();
    client.state = state;
    // The tag-scoped policy can refuse a terminate for an id AWS forgot.
    client.terminateError = notAuthorized();
    const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]), { removeMachine });

    const status = await service.deleteWorker();

    assert.equal(status.configured, false);
    assert.deepEqual(client.terminatedInstances, [], "nothing is terminated twice");
    assert.deepEqual(client.deletedKeyPairs, [OLD_HANDLE.keyName]);
    assert.deepEqual(client.deletedSecurityGroups, [OLD_HANDLE.securityGroupId]);
    assert.deepEqual(removed, ["cloud", "older"]);
    assert.equal(settings.handle, undefined);
  });
}

test("Delete of a just-launched instance AWS cannot see yet still terminates it", async () => {
  const { settings, removeMachine } = instanceWithMachines();
  settings.handle = { ...OLD_HANDLE, createdAt: new Date(Date.now() - 60_000).toISOString() };
  const client = new FakeEc2Client();
  client.state = undefined;
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]), { removeMachine });
  await service.deleteWorker();
  assert.deepEqual(client.terminatedInstances, [OLD_HANDLE.instanceId], "a missing answer right after launch is not proof it is gone");
});
