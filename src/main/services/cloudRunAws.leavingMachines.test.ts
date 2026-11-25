import assert from "node:assert/strict";
import test from "node:test";
import type { PreparedAwsWorker } from "./cloudRunAws";
import { encodeWorkerBlob } from "./awsWorkerProvisioning";
import { isAwsAuthorizationError } from "./awsEc2Client";
import type { AwsWorkerInstanceInfo } from "./awsWorkerLifecycle";
import {
  FakeEc2Client, FakeSettings, GONE_NOTICE, InstancesEc2Client, instanceWithMachines, NEW_CREDS, notAuthorized, OLD_CREDS,
  OLD_HANDLE, OLD_RUNNING, serviceWith, waitFor
} from "./cloudRunAws/test/awsFixtures";

test("refreshed credentials use a new launch token after the configured worker is gone", async () => {
  const settings = new FakeSettings();
  settings.credentials = OLD_CREDS;
  settings.handle = OLD_HANDLE;
  settings.mode = "aws";
  settings.provisioningToken = "completed-launch-token";
  const previous = new FakeEc2Client({ instanceId: "i-old", state: "terminated" });
  const refreshed = new FakeEc2Client();
  refreshed.discovered = [];
  const originalRun = refreshed.runInstance.bind(refreshed);
  let ambiguous = true;
  refreshed.runInstance = async (spec) => {
    if (ambiguous) {
      ambiguous = false;
      refreshed.runCount += 1;
      refreshed.runTokens.push(spec.clientToken);
      throw new Error("socket closed after replacement launch");
    }
    return originalRun(spec);
  };
  const service = serviceWith(settings, new Map([
    [OLD_CREDS.accessKeyId, previous],
    [NEW_CREDS.accessKeyId, refreshed]
  ]));

  const request = {
    operationId: "old-operation",
    clientToken: "completed-launch-token",
    blob: encodeWorkerBlob(NEW_CREDS)
  };
  await assert.rejects(() => service.prepareWorker(request), /socket closed/);
  assert.notEqual(refreshed.runTokens[0], "completed-launch-token");
  await service.prepareWorker(request);
  assert.equal(refreshed.runCount, 2);
  assert.equal(refreshed.runTokens.length, 2);
  assert.equal(refreshed.runTokens[0], refreshed.runTokens[1]);
  assert.notEqual(refreshed.runTokens[0], "completed-launch-token");
  assert.equal(settings.provisioningToken, undefined);
});

test("Delete terminates the instance and removes its machines through Remove, then the connection", async () => {
  const { settings, removed, removeMachine } = instanceWithMachines();
  const client = new FakeEc2Client({ instanceId: OLD_HANDLE.instanceId, state: "running", publicIp: "198.51.100.10" });
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]), { removeMachine });

  const status = await service.deleteWorker();

  assert.deepEqual(status, { configured: false, message: undefined });
  assert.deepEqual(client.terminatedInstances, [OLD_HANDLE.instanceId]);
  assert.deepEqual(client.deletedKeyPairs, [OLD_HANDLE.keyName]);
  assert.deepEqual(client.deletedSecurityGroups, [OLD_HANDLE.securityGroupId]);
  assert.deepEqual(removed, ["cloud", "older"], "the machine on the instance and the older one pinned to it; nothing elsewhere");
  assert.deepEqual(settings.machines.map((machine) => machine.id), ["elsewhere"]);
  assert.equal(settings.handle, undefined);
  assert.equal(settings.credentials, undefined);
  assert.equal(settings.mode, "ssh");
  assert.equal(settings.goneNotice, undefined, "the User deleted it: nothing to tell her");
});

test("Delete never reads a failed look as gone: AWS's terminate answers", async () => {
  const { settings, removed, removeMachine } = instanceWithMachines();
  const client = new FakeEc2Client({ instanceId: OLD_HANDLE.instanceId, state: "running" });
  client.describeError = Object.assign(new Error("Rate exceeded"), { name: "RequestLimitExceeded" });
  client.terminateError = Object.assign(new Error("connect ETIMEDOUT"), { name: "TimeoutError" });
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]), { removeMachine });
  const status = await service.deleteWorker();
  assert.equal(status.configured, true);
  assert.match(status.message ?? "", /not deleted; settings were retained/);
  assert.deepEqual(client.terminatedInstances, [OLD_HANDLE.instanceId]);
  assert.deepEqual(removed, []);
  assert.deepEqual(settings.handle, OLD_HANDLE);
});

test("Delete whose machine removal fails still deletes; the machine is recorded and a later look removes it", async () => {
  const { settings, removed, removeMachine } = instanceWithMachines();
  let now = Date.parse("2026-10-22T10:00:00.000Z");
  const client = new FakeEc2Client({ instanceId: OLD_HANDLE.instanceId, state: "running" });
  let failing = true;
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]), {
    now: () => now,
    removeMachine: async (machineId) => { if (failing) throw new Error("disk full"); await removeMachine(machineId); }
  });

  const deleted = await service.deleteWorker();
  assert.equal(deleted.configured, false, "Delete is not left half done");
  assert.equal(deleted.message, undefined);
  assert.equal(deleted.notices?.join("\n"), "Your old cloud machine could not be removed from this computer yet: disk full. The app tries again by itself.");
  assert.equal(settings.handle, undefined);
  assert.equal(settings.credentials, undefined, "Delete forgets the keys, as it always did");
  assert.deepEqual(settings.leaving.map((entry) => entry.machineId), ["cloud", "older"], "recorded, so a restart finishes it");
  assert.equal((await service.status()).notices?.join("\n"),
    "Your old cloud machine could not be removed from this computer yet: disk full. The app tries again by itself.");

  failing = false;
  now += 5 * 60_000;
  await service.status();
  await waitFor(() => removed.length === 2);
  assert.deepEqual(removed, ["cloud", "older"]);
  await waitFor(() => settings.leaving.length === 0);
  assert.deepEqual(await service.status(), { configured: false, operation: undefined }, "the User's own Delete: nothing to tell her");
});

test("a stopped instance is never removed; a terminated one is, with its machines, and the page says so", async () => {
  const logs: string[] = [];
  const { settings, removed, removeMachine } = instanceWithMachines();
  const client = new FakeEc2Client({ instanceId: OLD_HANDLE.instanceId, state: "stopped" });
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]), { removeMachine, logger: (event) => { logs.push(event); } });

  for (const state of ["stopped", "stopping", "pending", "running", "absent"] as const) {
    client.state = { instanceId: OLD_HANDLE.instanceId, state };
    const status = await service.status();
    assert.equal(status.configured, true, state);
    assert.equal(status.state, state);
  }
  assert.deepEqual(removed, []);
  assert.deepEqual(settings.handle, OLD_HANDLE);

  client.state = { instanceId: OLD_HANDLE.instanceId, state: "terminated" };
  const status = await service.status();
  assert.deepEqual(status, { configured: false, operation: undefined, notices: [GONE_NOTICE] });
  assert.deepEqual(removed, ["cloud", "older"]);
  assert.equal(settings.handle, undefined);
  assert.deepEqual(settings.credentials, OLD_CREDS, "the keys still work for a new instance; only the instance is forgotten");
  assert.equal(settings.mode, "aws");
  assert.equal(settings.goneNotice?.instanceId, OLD_HANDLE.instanceId);
  assert.ok(logs.includes("aws-worker.instance-gone") && logs.includes("aws-worker.forgotten"), "the debug log says what happened");
  assert.deepEqual(client.terminatedInstances, [], "a terminated instance is not terminated again");
  assert.deepEqual(client.deletedKeyPairs, [], "the keys are kept, and so is what they reuse for the next instance");
  assert.deepEqual(await service.status(), { configured: false, operation: undefined, notices: [GONE_NOTICE] }, "the line stays until another instance is connected");
});

test("an AWS error is never read as gone", async () => {
  for (const error of [
    Object.assign(new Error("connect ETIMEDOUT"), { name: "TimeoutError" }),
    Object.assign(new Error("Rate exceeded"), { name: "RequestLimitExceeded" }),
    Object.assign(new Error("AWS was not able to validate the provided access credentials"), { name: "AuthFailure" }),
    notAuthorized()
  ]) {
    const { settings, removed, removeMachine } = instanceWithMachines();
    const client = new FakeEc2Client();
    client.state = undefined;
    client.describeError = error;
    const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]), { removeMachine });
    const status = await service.status();
    assert.equal(status.configured, true, error.name);
    assert.equal(status.message, error.message);
    assert.equal(await service.forgetInstanceIfGone(), false);
    assert.deepEqual(removed, [], error.name);
    assert.deepEqual(settings.handle, OLD_HANDLE);
  }
});

test("nothing is forgotten while a setup owns the instance", async () => {
  const { settings, removed, removeMachine } = instanceWithMachines();
  const client = new FakeEc2Client({ instanceId: OLD_HANDLE.instanceId, state: "terminated" });
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]), { removeMachine });
  for (const phase of ["starting", "waiting-running", "setting-up"] as const) {
    settings.operation = { operationId: "op", phase, message: "…", updatedAt: new Date().toISOString() };
    assert.equal((await service.status()).configured, true, phase);
  }
  assert.deepEqual(removed, []);
  settings.operation = { operationId: "op", phase: "error", message: "failed", updatedAt: new Date().toISOString() };
  assert.equal((await service.status()).notices?.join("\n"), GONE_NOTICE, "a finished attempt no longer holds it");
});

test("a look while Delete is still waiting for AWS forgets nothing by itself and adds no notice", async () => {
  const { settings, removed, removeMachine } = instanceWithMachines();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  class SlowTerminate extends FakeEc2Client {
    override async terminateInstance(instanceId: string): Promise<void> {
      this.state = { instanceId, state: "terminated" };
      await gate;
      this.terminatedInstances.push(instanceId);
    }
  }
  const client = new SlowTerminate({ instanceId: OLD_HANDLE.instanceId, state: "running" });
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]), { removeMachine });
  const deleting = service.deleteWorker();
  await waitFor(() => client.state?.state === "terminated");
  const meanwhile = await service.status();
  assert.equal(meanwhile.configured, true);
  assert.equal(meanwhile.state, "terminated");
  assert.deepEqual(removed, []);
  release();
  assert.equal((await deleting).configured, false);
  assert.deepEqual(removed, ["cloud", "older"], "each machine is removed once");
  assert.equal(settings.goneNotice, undefined);
  assert.deepEqual(await service.status(), { configured: false, operation: undefined });
});

test("the startup look removes a terminated instance with its machines; one that runs stays", async () => {
  const { settings, removed, removeMachine } = instanceWithMachines();
  const client = new FakeEc2Client({ instanceId: OLD_HANDLE.instanceId, state: "running" });
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]), { removeMachine });
  assert.equal(await service.forgetInstanceIfGone(), false);
  assert.deepEqual(removed, []);
  client.state = { instanceId: OLD_HANDLE.instanceId, state: "terminated" };
  assert.equal(await service.forgetInstanceIfGone(), true);
  assert.deepEqual(removed, ["cloud", "older"]);
  assert.equal(settings.goneNotice?.instanceId, OLD_HANDLE.instanceId);
  assert.equal(await service.forgetInstanceIfGone(), false, "nothing left to look at");
});

test("two looks at once remove each machine once", async () => {
  const { settings, removed, removeMachine } = instanceWithMachines();
  const client = new FakeEc2Client({ instanceId: OLD_HANDLE.instanceId, state: "terminated" });
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]), { removeMachine });
  const [first, second] = await Promise.all([service.status(), service.status()]);
  assert.equal(first.notices?.join("\n"), GONE_NOTICE);
  assert.equal(second.configured, false);
  assert.deepEqual(removed, ["cloud", "older"]);
});

test("a machine removal that fails while looking says why on the page, is retried every five minutes, and survives a restart", async () => {
  const { settings, removed, removeMachine } = instanceWithMachines();
  let now = Date.parse("2026-10-22T10:00:00.000Z");
  let failing = true;
  let attempts = 0;
  const client = new FakeEc2Client({ instanceId: OLD_HANDLE.instanceId, state: "terminated" });
  const options = {
    now: () => now,
    removeMachine: async (machineId: string) => { attempts += 1; if (failing) throw new Error("disk full"); await removeMachine(machineId); }
  };
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]), options);
  const first = await service.status();
  assert.deepEqual(first, { configured: false, operation: undefined,
    notices: [GONE_NOTICE, "Your old cloud machine could not be removed from this computer yet: disk full. The app tries again by itself."] },
    "both lines: AWS no longer has the instance, and its machine is still here");
  assert.equal(settings.handle, undefined, "the gone instance is forgotten all the same");
  assert.deepEqual(settings.credentials, OLD_CREDS);
  assert.equal(attempts, 2, "each machine is tried");
  now += 60_000;
  await service.status();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2, "a minute later it is not retried");

  // A restart: a new app reads what was recorded and finishes it at start-up.
  failing = false;
  const restarted = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]), options);
  assert.equal(await restarted.forgetInstanceIfGone(), false);
  assert.deepEqual(removed, ["cloud", "older"]);
  assert.deepEqual(settings.leaving, []);
  assert.deepEqual(await restarted.status(), { configured: false, operation: undefined, notices: [GONE_NOTICE] });
});

test("a preparation that starts while a gone instance is forgotten waits, and keeps the connection it saves", async () => {
  const { settings, removed, removeMachine } = instanceWithMachines();
  settings.machines = [{ id: "cloud", awsInstanceId: OLD_HANDLE.instanceId }];
  settings.installs = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const client = new FakeEc2Client({ instanceId: OLD_HANDLE.instanceId, state: "terminated" });
  client.discovered = [];
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]), {
    removeMachine: async (machineId) => { await gate; await removeMachine(machineId); }
  });
  const looking = service.status();
  await waitFor(() => client.describeCalls > 0);
  await new Promise((resolve) => setImmediate(resolve));
  const preparing = service.prepareWorker({ operationId: "new-instance" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.runCount, 0, "nothing is launched while the old instance is being forgotten");
  release();
  assert.equal((await looking).notices?.join("\n"), GONE_NOTICE);
  const prepared = await preparing;
  assert.equal(prepared.handle.instanceId, "i-new");
  assert.equal(settings.handle?.instanceId, "i-new", "the new connection survives the forget");
  assert.deepEqual(settings.credentials, OLD_CREDS, "made with the keys the forget kept");
  assert.equal(settings.goneNotice, undefined);
  assert.deepEqual(removed, ["cloud"]);
});

test("a look while a preparation runs forgets nothing", async () => {
  const { settings, removed, removeMachine } = instanceWithMachines();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  class SlowDiscovery extends FakeEc2Client {
    override async findWorkerInstances(): Promise<AwsWorkerInstanceInfo[]> {
      await gate;
      return [{ instanceId: "i-adopted", state: "running", region: "us-east-1", securityGroupId: "sg-a", keyName: "k", instanceType: "t3.small", rootVolumeSizeGb: 8 }];
    }
  }
  const client = new SlowDiscovery({ instanceId: OLD_HANDLE.instanceId, state: "terminated" });
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]), { removeMachine });
  const preparing = service.prepareWorker({ operationId: "adopt" });
  const meanwhile = await service.status();
  assert.equal(meanwhile.configured, true);
  assert.deepEqual(removed, []);
  release();
  assert.equal((await preparing).handle.instanceId, "i-adopted");
});

test("a look while Recreate takes the old instance down forgets nothing", async () => {
  const { settings, removed, removeMachine } = instanceWithMachines();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  class SlowTerminate extends FakeEc2Client {
    override async terminateInstance(instanceId: string): Promise<void> {
      this.state = { instanceId, state: "terminated" };
      await gate;
    }
  }
  const client = new SlowTerminate({ instanceId: OLD_HANDLE.instanceId, state: "running" });
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]), { removeMachine });
  const prepared = {
    credentials: OLD_CREDS, handle: OLD_HANDLE, info: { instanceId: OLD_HANDLE.instanceId, state: "running" as const },
    actualSpec: { instanceId: OLD_HANDLE.instanceId, region: "us-east-1", instanceType: "t3.small", rootVolumeSizeGb: 8 },
    desiredSpec: { instanceType: "t3.medium", rootVolumeSizeGb: 8 }, created: false
  };
  const recreating = service.recreateWorker(prepared, OLD_HANDLE.instanceId, "recreate").catch((error: unknown) => error);
  await waitFor(() => client.state?.state === "terminated");
  const meanwhile = await service.status();
  assert.equal(meanwhile.configured, true);
  assert.deepEqual(removed, [], "the replacement owns the old instance");
  assert.deepEqual(settings.credentials, OLD_CREDS);
  release();
  await recreating;
  assert.equal(settings.goneNotice, undefined);
});

function recreateRequest(): PreparedAwsWorker {
  return {
    credentials: OLD_CREDS, handle: OLD_HANDLE, info: OLD_RUNNING, created: false,
    actualSpec: { instanceId: OLD_HANDLE.instanceId, region: "us-east-1", instanceType: "t3.small", rootVolumeSizeGb: 8 },
    desiredSpec: { instanceType: "t3.medium", rootVolumeSizeGb: 8 }
  };
}

test("Recreate removes the old instance's machines once it is terminated, before the new instance is launched", async () => {
  const { settings, removeMachine } = instanceWithMachines();
  const client = new InstancesEc2Client(OLD_RUNNING);
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]), {
    removeMachine: async (machineId) => { client.events.push(`remove:${machineId}`); await removeMachine(machineId); }
  });

  const recreated = await service.recreateWorker(recreateRequest(), OLD_HANDLE.instanceId, "recreate");

  assert.deepEqual(client.events, [`terminate:${OLD_HANDLE.instanceId}`, "remove:cloud", "remove:older", "launch:i-new1"]);
  assert.equal(recreated.handle.instanceId, "i-new1");
  assert.equal(settings.handle?.instanceId, "i-new1");
  assert.deepEqual(settings.machines.map((machine) => machine.id), ["elsewhere"], "the new instance enrolls as a new machine");
  assert.deepEqual(settings.credentials, OLD_CREDS);
  assert.equal(settings.goneNotice, undefined, "the User replaced it: nothing to tell her");
});

test("Recreate that cannot terminate the old instance removes no machine", async () => {
  const { settings, removed, removeMachine } = instanceWithMachines();
  const client = new InstancesEc2Client(OLD_RUNNING);
  client.terminateError = Object.assign(new Error("connect ETIMEDOUT"), { name: "TimeoutError" });
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]), { removeMachine });
  await assert.rejects(service.recreateWorker(recreateRequest(), OLD_HANDLE.instanceId, "recreate"), /could not be confirmed terminated/);
  assert.deepEqual(removed, []);
  assert.deepEqual(settings.handle, OLD_HANDLE);
  assert.equal(client.runCount, 0);
});

test("Recreate whose machine removal fails still launches the new instance, and a later look removes the old machines", async () => {
  const { settings, removed, removeMachine } = instanceWithMachines();
  let now = Date.parse("2026-10-22T10:00:00.000Z");
  let failing = true;
  const client = new InstancesEc2Client(OLD_RUNNING);
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]), {
    now: () => now,
    removeMachine: async (machineId) => { if (failing) throw new Error("disk full"); await removeMachine(machineId); }
  });
  const recreated = await service.recreateWorker(recreateRequest(), OLD_HANDLE.instanceId, "recreate");
  assert.equal(recreated.handle.instanceId, "i-new1", "the type the User chose, not a stalled old instance");
  assert.deepEqual(settings.leaving.map((entry) => entry.machineId), ["cloud", "older"]);
  const running = await service.status();
  assert.equal(running.configured, true);
  assert.equal(running.notices?.join("\n"), "Your old cloud machine could not be removed from this computer yet: disk full. The app tries again by itself.",
    "said on the running instance's page too");
  failing = false;
  now += 5 * 60_000;
  const status = await service.status();
  assert.equal(status.configured, true);
  assert.equal(status.handle?.instanceId, "i-new1");
  await waitFor(() => removed.length === 2);
  assert.equal((await service.status()).notices?.join("\n"), undefined, "the line ends once the machines are gone");
  assert.deepEqual(settings.machines.map((machine) => machine.id), ["elsewhere"]);
  assert.deepEqual(settings.credentials, OLD_CREDS);
  assert.equal(settings.goneNotice, undefined);
});

test("a new instance started over a terminated saved one removes the old instance's machines first", async () => {
  const { settings, removeMachine } = instanceWithMachines();
  const client = new InstancesEc2Client({ ...OLD_RUNNING, state: "terminated" });
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]), {
    removeMachine: async (machineId) => { client.events.push(`remove:${machineId}`); await removeMachine(machineId); }
  });
  const prepared = await service.prepareWorker({ operationId: "start" });
  assert.deepEqual(client.events, ["remove:cloud", "remove:older", "launch:i-new1"]);
  assert.equal(prepared.handle.instanceId, "i-new1");
  assert.deepEqual(settings.machines.map((machine) => machine.id), ["elsewhere"]);
});

test("a new instance keeps the machines of a saved instance that is stopped or whose keys are unreadable", async () => {
  // Stopped in its own region while discovery adopts another instance.
  {
    const { settings, removed, removeMachine } = instanceWithMachines();
    settings.handle = { ...OLD_HANDLE, region: "eu-west-1" };
    const west = new InstancesEc2Client({ ...OLD_RUNNING, state: "stopped", region: "eu-west-1" });
    const east = new InstancesEc2Client({ ...OLD_RUNNING, instanceId: "i-shared", region: "us-east-1" });
    const logs: Array<[string, Record<string, unknown>]> = [];
    const service = serviceWith(settings, new Map([[`${OLD_CREDS.accessKeyId}:eu-west-1`, west], [`${OLD_CREDS.accessKeyId}:us-east-1`, east]]),
      { removeMachine, logger: (event, payload) => { logs.push([event, payload]); } });
    assert.equal((await service.prepareWorker({ operationId: "adopt" })).handle.instanceId, "i-shared");
    assert.deepEqual(removed, [], "stopped");
    assert.deepEqual(logs.find(([event]) => event === "aws-worker.replaced.kept")?.[1], { instanceId: OLD_HANDLE.instanceId, state: "stopped" },
      "looked at in its own region");
  }
  // The saved keys cannot be read: pasted keys of another account must not
  // decide that the old instance is gone.
  {
    const { settings, removed, removeMachine } = instanceWithMachines();
    settings.credentials = undefined;
    const other = new InstancesEc2Client();
    const service = serviceWith(settings, new Map([[NEW_CREDS.accessKeyId, other]]), { removeMachine });
    await service.prepareWorker({ operationId: "other-account", blob: encodeWorkerBlob(NEW_CREDS) });
    assert.deepEqual(removed, [], "keys unreadable");
    assert.equal(other.describeCalls, 0, "the old instance is never looked up with someone else's keys");
    assert.deepEqual(settings.leaving.map((entry) => [entry.machineId, entry.unverified]), [["cloud", "unreadable"], ["older", "unreadable"]]);
    assert.deepEqual((await service.status()).notices, ["We couldn't confirm your old cloud machine is gone, so it is still listed on this computer: "
      + "this computer can no longer read the keys its instance was made with."]);
  }
});

test("starting the saved instance again touches no machine", async () => {
  const { settings, removed, removeMachine } = instanceWithMachines();
  const client = new InstancesEc2Client({ ...OLD_RUNNING, state: "stopped" });
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]), { removeMachine });
  assert.equal((await service.prepareWorker({ operationId: "start" })).handle.instanceId, OLD_HANDLE.instanceId);
  assert.deepEqual(removed, []);
  assert.equal(client.runCount, 0);
});

// ---- the second review of leaving machines ------------------------------------

test("one machine that cannot be removed does not stop the others, and the first error is said", async () => {
  const { settings, removed, removeMachine } = instanceWithMachines();
  const client = new FakeEc2Client({ instanceId: OLD_HANDLE.instanceId, state: "terminated" });
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]), {
    removeMachine: async (machineId) => { if (machineId === "cloud") throw new Error("disk full."); await removeMachine(machineId); }
  });
  const status = await service.status();
  assert.deepEqual(removed, ["older"], "the next machine is still removed");
  assert.deepEqual(settings.leaving.map((entry) => entry.machineId), ["cloud"]);
  assert.deepEqual(status.notices, [GONE_NOTICE, "Your old cloud machine could not be removed from this computer yet: disk full. The app tries again by itself."],
    "both lines, each while it holds");
});

test("the line counts only old machines that still exist, and one the User removed herself is no longer recorded", async () => {
  const { settings, removeMachine } = instanceWithMachines();
  let now = Date.parse("2026-10-22T10:00:00.000Z");
  const client = new FakeEc2Client({ instanceId: OLD_HANDLE.instanceId, state: "terminated" });
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]), {
    now: () => now,
    removeMachine: async () => { throw new Error("disk full"); }
  });
  assert.match((await service.status()).notices?.join("\n") ?? "", /could not be removed/);
  // The User removes both herself (Settings → Remove).
  await removeMachine("cloud");
  await removeMachine("older");
  assert.deepEqual(await service.status(), { configured: false, operation: undefined, notices: [GONE_NOTICE] });
  now += 5 * 60_000;
  await service.status();
  await waitFor(() => settings.leaving.length === 0);
});

test("pasted keys that see another worker while AWS refuses the saved ones adopt it, keep the old machines and say so", async () => {
  const { settings, removed, removeMachine } = instanceWithMachines();
  const refusedOld = new InstancesEc2Client({ ...OLD_RUNNING, state: "terminated" });
  refusedOld.describeError = notAuthorized();
  const shared = { ...OLD_RUNNING, instanceId: "i-shared" };
  const fresh = new InstancesEc2Client(shared);
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, refusedOld], [NEW_CREDS.accessKeyId, fresh]]), { removeMachine });

  const prepared = await service.prepareWorker({ operationId: "new-keys", blob: encodeWorkerBlob(NEW_CREDS) });

  assert.equal(prepared.handle.instanceId, "i-shared", "adopted as before this change: no dead end");
  assert.deepEqual(removed, [], "an unverifiable look never removes");
  assert.deepEqual(settings.leaving.map((entry) => [entry.machineId, entry.unverified]), [["cloud", "refused"], ["older", "refused"]]);
  const status = await service.status();
  assert.equal(status.configured, true);
  assert.deepEqual(status.notices, ["We couldn't confirm your old cloud machine is gone, so it is still listed on this computer: "
    + "AWS refused the keys its instance was made with."]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(removed, [], "never removed by a later look either");
});

test("the saved keys refused while they are also the keys in use is the permission error itself, unchanged", async () => {
  const { settings, removed, removeMachine } = instanceWithMachines();
  const client = new InstancesEc2Client({ ...OLD_RUNNING, instanceId: "i-shared" });
  const refusal = notAuthorized();
  client.describeError = refusal;
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]), { removeMachine });
  await assert.rejects(service.prepareWorker({ operationId: "same-keys" }), (error: unknown) => error === refusal && isAwsAuthorizationError(error));
  assert.deepEqual(removed, []);
  assert.deepEqual(settings.leaving, []);
});

test("an old entry the 50-machine limit drops is written to the debug log", async () => {
  const { settings, removeMachine } = instanceWithMachines();
  settings.leaving = Array.from({ length: 50 }, (_, index) => ({ machineId: `old-${index}`, instanceId: "i-older", at: "2026-10-01T00:00:00.000Z", unverified: "refused" as const }));
  settings.machines.push(...settings.leaving.map((entry) => ({ id: entry.machineId, awsInstanceId: "i-older" })));
  const logs: Array<[string, Record<string, unknown>]> = [];
  const client = new FakeEc2Client({ instanceId: OLD_HANDLE.instanceId, state: "terminated" });
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]), { removeMachine, logger: (event, payload) => { logs.push([event, payload]); } });
  await service.status();
  assert.deepEqual(logs.find(([event]) => event === "aws-worker.machine-leave.dropped")?.[1],
    { machineIds: ["old-0", "old-1"], instanceIds: ["i-older", "i-older"] });
});

test("an instance the app could not check that is the saved one again has no old machines, and its records go", async () => {
  const { settings, removed, removeMachine } = instanceWithMachines();
  settings.leaving = [{ machineId: "cloud", instanceId: OLD_HANDLE.instanceId, at: "2026-10-22T10:00:00.000Z", unverified: "refused" }];
  const client = new FakeEc2Client({ instanceId: OLD_HANDLE.instanceId, state: "running" });
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]), { removeMachine });
  const status = await service.status();
  assert.equal(status.configured, true);
  assert.equal(status.notices?.join("\n"), undefined, "no false line on the saved instance's own page");
  await waitFor(() => settings.leaving.length === 0);
  assert.deepEqual(removed, [], "its machine is the current one and stays");
});

test("Check access keeps the old-machine line", async () => {
  const { settings, removeMachine } = instanceWithMachines();
  settings.machines.push({ id: "gone-box", awsInstanceId: "i-older" });
  settings.leaving = [{ machineId: "gone-box", instanceId: "i-older", at: "2026-10-22T10:00:00.000Z", unverified: "refused" }];
  const client = new FakeEc2Client({ instanceId: OLD_HANDLE.instanceId, state: "running" });
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]), { removeMachine });
  assert.match((await service.probeAccess()).notices?.join("\n") ?? "", /AWS refused the keys its instance was made with/);
});

// ---- an old instance the app could not check is looked at again ---------------

/** The refused-keys case: new keys adopted another worker, the old machines
 *  are listed as unconfirmed, with the region and, when known, the account. */
function unconfirmedOldMachines(accountId?: string): { settings: FakeSettings; removed: string[]; removeMachine: (machineId: string) => Promise<void> } {
  const setup = instanceWithMachines();
  setup.settings.credentials = NEW_CREDS;
  setup.settings.handle = { ...OLD_HANDLE, instanceId: "i-shared" };
  setup.settings.leaving = ["cloud", "older"].map((machineId) => ({ machineId, instanceId: OLD_HANDLE.instanceId, at: "2026-10-22T10:00:00.000Z",
    unverified: "refused" as const, region: "us-east-1", ...(accountId ? { accountId } : {}) }));
  return setup;
}

test("an unconfirmed old instance is looked at again every five minutes and its machines go once AWS says terminated", async () => {
  const { settings, removed, removeMachine } = unconfirmedOldMachines();
  let now = Date.parse("2026-10-22T10:00:00.000Z");
  const client = new InstancesEc2Client({ ...OLD_RUNNING, state: "stopped" }, { ...OLD_RUNNING, instanceId: "i-shared" });
  const service = serviceWith(settings, new Map([[NEW_CREDS.accessKeyId, client]]), { now: () => now, removeMachine });
  const first = await service.status();
  assert.match(first.notices?.join("\n") ?? "", /We couldn't confirm your old cloud machine is gone/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(removed, [], "stopped is not gone");
  const looks = client.describeCalls;
  client.instances.set(OLD_HANDLE.instanceId, { ...OLD_RUNNING, state: "terminated" });
  now += 60_000;
  await service.status();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(removed, [], "not looked at again within five minutes");
  assert.equal(client.describeCalls, looks + 1, "only the saved instance was described in that minute");
  now += 5 * 60_000;
  await service.status();
  await waitFor(() => removed.length === 2);
  assert.deepEqual(settings.leaving, []);
  assert.equal((await service.status()).notices, undefined, "the line ends once confirmed");
});

test("no such instance proves an unconfirmed old instance gone only to keys of its own account", async () => {
  // Another account: AWS says "no such instance" about everything.
  {
    const { settings, removed, removeMachine } = unconfirmedOldMachines("111111111111");
    const client = new InstancesEc2Client({ ...OLD_RUNNING, instanceId: "i-shared", ownerId: "222222222222" });
    const service = serviceWith(settings, new Map([[NEW_CREDS.accessKeyId, client]]), { removeMachine });
    await service.status();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(removed, [], "keys of another account prove nothing");
    assert.equal(settings.leaving.length, 2);
  }
  // The account is not known (keys that could not be read).
  {
    const { settings, removed, removeMachine } = unconfirmedOldMachines();
    const client = new InstancesEc2Client({ ...OLD_RUNNING, instanceId: "i-shared", ownerId: "111111111111" });
    const service = serviceWith(settings, new Map([[NEW_CREDS.accessKeyId, client]]), { removeMachine });
    await service.status();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(removed, [], "an unknown account proves nothing");
  }
  // The same account: gone.
  {
    const { settings, removed, removeMachine } = unconfirmedOldMachines("111111111111");
    const client = new InstancesEc2Client({ ...OLD_RUNNING, instanceId: "i-shared", ownerId: "111111111111" });
    const service = serviceWith(settings, new Map([[NEW_CREDS.accessKeyId, client]]), { removeMachine });
    await service.status();
    await waitFor(() => removed.length === 2);
    assert.deepEqual(settings.leaving, []);
  }
});

test("an AWS error while looking again keeps the unconfirmed machines listed", async () => {
  const { settings, removed, removeMachine } = unconfirmedOldMachines("111111111111");
  class FailingOld extends InstancesEc2Client {
    override async describeInstance(instanceId?: string): Promise<AwsWorkerInstanceInfo | undefined> {
      if (instanceId === OLD_HANDLE.instanceId) throw Object.assign(new Error("Rate exceeded"), { name: "RequestLimitExceeded" });
      return super.describeInstance(instanceId);
    }
  }
  const client = new FailingOld({ ...OLD_RUNNING, instanceId: "i-shared", ownerId: "111111111111" });
  const service = serviceWith(settings, new Map([[NEW_CREDS.accessKeyId, client]]), { removeMachine });
  await service.status();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(removed, []);
  assert.equal(settings.leaving.length, 2);
});

test("the refused keys' account is recorded from AWS's refusal", async () => {
  const { settings, removeMachine } = instanceWithMachines();
  const refusedOld = new InstancesEc2Client({ ...OLD_RUNNING, state: "terminated" });
  refusedOld.describeError = Object.assign(new Error("User: arn:aws:iam::111111111111:user/accordagents-worker-device-a is not authorized to perform: "
    + "ec2:DescribeInstances because no identity-based policy allows the ec2:DescribeInstances action"), { name: "UnauthorizedOperation" });
  const fresh = new InstancesEc2Client({ ...OLD_RUNNING, instanceId: "i-shared" });
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, refusedOld], [NEW_CREDS.accessKeyId, fresh]]), { removeMachine });
  await service.prepareWorker({ operationId: "new-keys", blob: encodeWorkerBlob(NEW_CREDS) });
  assert.deepEqual(settings.leaving.map((entry) => [entry.machineId, entry.unverified, entry.region, entry.accountId]),
    [["cloud", "refused", "us-east-1", "111111111111"], ["older", "refused", "us-east-1", "111111111111"]]);
});

test("right after start-up the first look already knows the keys' account, so a confirmed-gone old machine goes at once", async () => {
  const { settings, removed, removeMachine } = unconfirmedOldMachines("111111111111");
  const client = new InstancesEc2Client({ ...OLD_RUNNING, instanceId: "i-shared", ownerId: "111111111111" });
  const service = serviceWith(settings, new Map([[NEW_CREDS.accessKeyId, client]]), { removeMachine });
  await service.forgetInstanceIfGone();
  assert.deepEqual(removed, ["cloud", "older"], "the start-up pass removes them; no wait for a later look");
  assert.deepEqual(settings.leaving, []);
});

test("a confirmation is kept when the removal after it fails, and the line then says why", async () => {
  const { settings, removed, removeMachine } = unconfirmedOldMachines("111111111111");
  let now = Date.parse("2026-10-22T10:00:00.000Z");
  let failing = true;
  const client = new InstancesEc2Client({ ...OLD_RUNNING, state: "terminated" }, { ...OLD_RUNNING, instanceId: "i-shared", ownerId: "111111111111" });
  const service = serviceWith(settings, new Map([[NEW_CREDS.accessKeyId, client]]), {
    now: () => now,
    removeMachine: async (machineId) => { if (failing) throw new Error("disk full"); await removeMachine(machineId); }
  });
  await service.forgetInstanceIfGone();
  assert.deepEqual(settings.leaving.map((entry) => [entry.machineId, entry.unverified]), [["cloud", undefined], ["older", undefined]],
    "AWS's answer is saved: these now wait for removal");
  assert.deepEqual((await service.status()).notices,
    ["Your old cloud machine could not be removed from this computer yet: disk full. The app tries again by itself."]);
  // AWS forgets the terminated instance; the saved confirmation still holds.
  client.instances.delete(OLD_HANDLE.instanceId);
  failing = false;
  now += 5 * 60_000;
  await service.status();
  await waitFor(() => removed.length === 2);
});

test("a look again at an old instance never holds up Delete or a preparation", async () => {
  const { settings, removeMachine } = unconfirmedOldMachines("111111111111");
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let asked = false;
  class SlowOld extends InstancesEc2Client {
    override async describeInstance(instanceId?: string): Promise<AwsWorkerInstanceInfo | undefined> {
      if (instanceId === OLD_HANDLE.instanceId) { asked = true; await gate; }
      return super.describeInstance(instanceId);
    }
  }
  const client = new SlowOld({ ...OLD_RUNNING, instanceId: "i-shared", ownerId: "111111111111" });
  const service = serviceWith(settings, new Map([[NEW_CREDS.accessKeyId, client]]), { removeMachine });
  await service.status();
  await waitFor(() => asked);
  const deleted = await service.deleteWorker();
  assert.equal(deleted.configured, false, "Delete finished while AWS had not answered the look");
  release();
});

test("a look in the first moments after start removes no leaving machine before the machine link has started", async () => {
  const { settings, removed, removeMachine } = instanceWithMachines();
  let now = Date.parse("2026-10-22T10:00:00.000Z");
  const client = new FakeEc2Client({ instanceId: OLD_HANDLE.instanceId, state: "running" });
  let failing = true;
  let linkStarted!: () => void;
  const ready = new Promise<void>((resolve) => { linkStarted = resolve; });
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]), {
    now: () => now,
    removeMachine: async (machineId) => { if (failing) throw new Error("disk full"); await removeMachine(machineId); },
    machinesReady: () => ready
  });
  // Recorded as leaving by a Delete whose removal failed (as after a restart).
  linkStarted();
  await service.deleteWorker();
  assert.deepEqual(settings.leaving.map((entry) => entry.machineId), ["cloud", "older"]);
  // The desktop starts again: its link has not started when the first look runs.
  let started!: () => void;
  const startedAgain = new Promise<void>((resolve) => { started = resolve; });
  const restarted = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]), {
    now: () => now,
    removeMachine: async (machineId) => { await removeMachine(machineId); },
    machinesReady: () => startedAgain
  });
  failing = false;
  now += 5 * 60_000;
  await restarted.status();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(removed, [], "nothing is removed before the link knows its machines");
  started();
  await waitFor(() => removed.length === 2);
  assert.deepEqual(removed, ["cloud", "older"]);
});
