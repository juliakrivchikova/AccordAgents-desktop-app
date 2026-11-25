import assert from "node:assert/strict";
import test from "node:test";
import { CloudRunAwsService } from "./cloudRunAws";
import { encodeWorkerBlob } from "./awsWorkerProvisioning";
import { isAwsAuthorizationError } from "./awsEc2Client";
import type { AwsWorkerInstanceInfo } from "./awsWorkerLifecycle";
import {
  FakeEc2Client, FakeSettings, GONE_NOTICE, installFor, InstancesEc2Client, instanceWithMachines, NEW_CREDS, OLD_CREDS,
  OLD_HANDLE, OLD_RUNNING, POWER_HANDLE, powerSettings, serviceWith
} from "./cloudRunAws/test/awsFixtures";

test("Cloud selection refuses a replaced or missing instance without provisioning another", async () => {
  const settings = new FakeSettings();
  settings.credentials = OLD_CREDS;
  settings.handle = OLD_HANDLE;
  const client = new FakeEc2Client();
  client.state = undefined;
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]));
  await assert.rejects(service.ensureExistingWorkerForRun("i-other"), /instance changed/);
  await assert.rejects(service.ensureExistingWorkerForRun(OLD_HANDLE.instanceId), /no longer available/);
  assert.equal(client.runCount, 0);
});

test("bringing a program back reaches a running instance only: nothing is started, grown or held to the configured size", async () => {
  const settings = new FakeSettings();
  settings.credentials = OLD_CREDS;
  settings.handle = OLD_HANDLE;
  settings.awsRootVolumeSizeGb = 64;
  settings.volumeExpansion = { instanceId: OLD_HANDLE.instanceId, volumeId: "vol-1", targetSizeGb: 64, updatedAt: "t" };
  const client = new FakeEc2Client({ instanceId: OLD_HANDLE.instanceId, state: "stopped" });
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]));
  await assert.rejects(service.ensureExistingWorkerForRun(OLD_HANDLE.instanceId, { start: false }), /is stopped, so nothing was started/);
  assert.equal(client.state?.state, "stopped", "a stop is never undone");
  assert.deepEqual(client.modifiedSizes, [], "a pending disk growth is left for a Cloud run the User chooses");
  client.state = { instanceId: OLD_HANDLE.instanceId, state: "running", publicIp: "198.51.100.7", rootVolumeSizeGb: 8 };
  const worker = await service.ensureExistingWorkerForRun(OLD_HANDLE.instanceId, { start: false });
  assert.equal(worker.host, "198.51.100.7");
  assert.deepEqual(client.modifiedSizes, []);
  assert.deepEqual(client.authorizedCidrs, ["203.0.113.9/32"], "this device's SSH access is renewed for its current address");
  await assert.rejects(service.ensureExistingWorkerForRun("i-other", { start: false }), /instance changed/);
});

test("bootstrap command reuses a stable device-scoped IAM identity", async () => {
  const settings = new FakeSettings();
  const service = serviceWith(settings, new Map());

  const first = await service.bootstrapCommand("us-east-1");
  const second = await service.bootstrapCommand("eu-west-1");

  assert.match(first, /USER=accordagents-worker-device-a/);
  assert.match(second, /USER=accordagents-worker-device-a/);
  assert.match(first, /REGION=us-east-1/);
  assert.match(second, /REGION=eu-west-1/);
});

test("bootstrap command updates the active authorization-denied worker user in place", async () => {
  const settings = new FakeSettings();
  settings.operation = {
    operationId: "op-auth",
    phase: "error",
    message: "Cloud Run cannot access required AWS APIs",
    updatedAt: "2026-08-13T00:00:00.000Z",
    remediation: "refresh-aws-authorization",
    missingAwsActions: ["ec2:DescribeInstanceTypes"],
    awsPrincipalUserName: "accordagents-worker-pna6gbah"
  };
  const service = serviceWith(settings, new Map());

  const command = await service.bootstrapCommand("us-east-1", "op-auth");

  assert.match(command, /USER=accordagents-worker-pna6gbah/);
  assert.match(command, /aws iam create-policy-version --policy-arn "\$POLICY_ARN"/);
  assert.match(command, /aws iam attach-user-policy --user-name "\$USER" --policy-arn "\$POLICY_ARN"/);
  assert.match(command, /aws iam delete-user-policy --user-name "\$USER" --policy-name accordagents-worker/);
  assert.doesNotMatch(command, /UPDATE_EXISTING_USER/);
  assert.doesNotMatch(command, /aws iam create-access-key/);
  assert.doesNotMatch(command, /accord-aws-v1:/);
});

test("a fresh setup command ignores historical authorization recovery and still produces a connection result", async () => {
  const settings = new FakeSettings();
  settings.operation = { operationId: "old-error", phase: "error", message: "Old permission denial", updatedAt: "2026-08-10T00:00:00Z",
    remediation: "refresh-aws-authorization", awsPrincipalUserName: "old-worker-user" };
  const command = await serviceWith(settings, new Map()).bootstrapCommand("us-east-1");
  assert.match(command, /USER=accordagents-worker-device-a/);
  assert.match(command, /aws iam create-access-key/);
  assert.match(command, /accord-aws-v1:/);
  assert.doesNotMatch(command, /USER=old-worker-user/);
});

test("an outdated recovery request cannot silently generate a different IAM command", async () => {
  const settings = new FakeSettings();
  const service = serviceWith(settings, new Map());
  settings.operation = { operationId: "new-error", phase: "error", message: "New permission denial", updatedAt: "2026-09-13T00:00:00Z",
    remediation: "refresh-aws-authorization", awsPrincipalUserName: "new-worker-user" };
  await assert.rejects(service.bootstrapCommand("us-east-1", "old-error"), /no longer current/);
  settings.operation = { ...settings.operation, phase: "ready" };
  await assert.rejects(service.bootstrapCommand("us-east-1", "new-error"), /no longer current/);
  settings.operation = undefined;
  await assert.rejects(service.bootstrapCommand("us-east-1", "new-error"), /no longer current/);
});

test("connectWorker refuses to overwrite an active existing worker", async () => {
  const settings = new FakeSettings();
  settings.credentials = OLD_CREDS;
  settings.handle = OLD_HANDLE;
  settings.mode = "aws";
  const oldClient = new FakeEc2Client({ instanceId: "i-old", state: "running", publicIp: "198.51.100.10" });
  const newClient = new FakeEc2Client();
  const service = serviceWith(settings, new Map([
    [OLD_CREDS.accessKeyId, oldClient],
    [NEW_CREDS.accessKeyId, newClient]
  ]));

  await assert.rejects(() => service.connectWorker(encodeWorkerBlob(NEW_CREDS)), /already configured/);
  assert.deepEqual(settings.credentials, OLD_CREDS);
  assert.deepEqual(settings.handle, OLD_HANDLE);
  assert.deepEqual(newClient.importedKeyPairs, []);
});

test("connectWorker does not overwrite saved settings when new provisioning fails", async () => {
  const settings = new FakeSettings();
  settings.credentials = OLD_CREDS;
  settings.handle = OLD_HANDLE;
  settings.mode = "aws";
  const oldClient = new FakeEc2Client({ instanceId: "i-old", state: "terminated" });
  const newClient = new FakeEc2Client();
  newClient.importError = new Error("import failed");
  const service = serviceWith(settings, new Map([
    [OLD_CREDS.accessKeyId, oldClient],
    [NEW_CREDS.accessKeyId, newClient]
  ]));

  await assert.rejects(() => service.connectWorker(encodeWorkerBlob(NEW_CREDS)), /import failed/);
  assert.deepEqual(settings.credentials, OLD_CREDS);
  assert.deepEqual(settings.handle, OLD_HANDLE);
});

test("connectWorker describe failure tells the user to delete the existing worker first", async () => {
  const settings = new FakeSettings();
  settings.credentials = OLD_CREDS;
  settings.handle = OLD_HANDLE;
  settings.mode = "aws";
  const oldClient = new FakeEc2Client({ instanceId: "i-old", state: "running", publicIp: "198.51.100.10" });
  oldClient.describeError = new Error("AccessDenied");
  const newClient = new FakeEc2Client();
  const service = serviceWith(settings, new Map([
    [OLD_CREDS.accessKeyId, oldClient],
    [NEW_CREDS.accessKeyId, newClient]
  ]));

  await assert.rejects(
    () => service.connectWorker(encodeWorkerBlob(NEW_CREDS)),
    /Could not verify the existing AWS worker.*Delete the existing worker first/
  );
  assert.deepEqual(settings.credentials, OLD_CREDS);
  assert.deepEqual(settings.handle, OLD_HANDLE);
});

test("prepareWorker adopts the tagged account worker without creating a duplicate", async () => {
  const settings = new FakeSettings();
  const client = new FakeEc2Client();
  client.discovered = [{
    instanceId: "i-shared",
    state: "running",
    publicIp: "198.51.100.20",
    region: "us-east-1",
    availabilityZone: "us-east-1a",
    securityGroupId: "sg-shared",
    keyName: "launch-key",
    instanceType: "t3.medium",
    vCpu: 2,
    memoryMiB: 4096,
    rootVolumeId: "vol-shared",
    rootVolumeSizeGb: 32
  }];
  const service = serviceWith(settings, new Map([[NEW_CREDS.accessKeyId, client]]));
  const prepared = await service.prepareWorker({
    operationId: "adopt-op",
    blob: encodeWorkerBlob(NEW_CREDS),
    instanceType: "t3.small",
    rootVolumeSizeGb: 8
  });
  assert.equal(prepared.info.instanceId, "i-shared");
  assert.equal(prepared.handle.adopted, true);
  assert.equal(prepared.mismatch, undefined);
  assert.equal(client.runCount, 0);
});

test("refreshed credentials adopt the configured tagged worker before replacing saved credentials", async () => {
  const settings = new FakeSettings();
  settings.credentials = OLD_CREDS;
  settings.handle = OLD_HANDLE;
  settings.mode = "aws";
  const refreshedWorker: AwsWorkerInstanceInfo = {
    instanceId: "i-old",
    state: "running",
    publicIp: "198.51.100.10",
    region: "us-east-1",
    availabilityZone: "us-east-1a",
    securityGroupId: "sg-old",
    keyName: "accordagents-worker-old",
    instanceType: "t3.small",
    rootVolumeSizeGb: 8
  };
  const newClient = new FakeEc2Client(refreshedWorker);
  newClient.discovered = [refreshedWorker];
  const service = serviceWith(settings, new Map([
    [OLD_CREDS.accessKeyId, new FakeEc2Client(refreshedWorker)],
    [NEW_CREDS.accessKeyId, newClient]
  ]));

  const prepared = await service.prepareWorker({ operationId: "refresh-auth", blob: encodeWorkerBlob(NEW_CREDS) });
  assert.equal(prepared.info.instanceId, "i-old");
  assert.deepEqual(settings.credentials, NEW_CREDS);
  assert.equal(settings.handle?.instanceId, "i-old");
  assert.equal(newClient.runCount, 0);
});

test("worker discovery retries a transient DescribeInstances authorization denial", async () => {
  const settings = new FakeSettings();
  const client = new FakeEc2Client();
  client.discovered = [];
  client.findErrors = [Object.assign(new Error("not authorized to perform ec2:DescribeInstances"), { name: "UnauthorizedOperation" })];
  const service = serviceWith(settings, new Map([[NEW_CREDS.accessKeyId, client]]));

  const prepared = await service.prepareWorker({ operationId: "transient-describe", blob: encodeWorkerBlob(NEW_CREDS) });
  assert.equal(prepared.info.instanceId, "i-new");
  assert.ok(client.findCalls >= 2);
  assert.equal(client.runCount, 1);
});

test("cross-region discovery retries a transient DescribeInstances authorization denial", async () => {
  const settings = new FakeSettings();
  const local = new FakeEc2Client();
  local.discovered = [];
  local.enabledRegions = ["us-east-1", "us-west-2"];
  const west = new FakeEc2Client();
  west.discovered = [];
  west.findErrors = [new Error("not authorized to perform ec2:DescribeInstances")];
  const service = serviceWith(settings, new Map([
    [NEW_CREDS.accessKeyId, local],
    [`${NEW_CREDS.accessKeyId}:us-west-2`, west]
  ]));

  const prepared = await service.prepareWorker({ operationId: "transient-regional-describe", blob: encodeWorkerBlob(NEW_CREDS) });
  assert.equal(prepared.info.instanceId, "i-new");
  assert.ok(west.findCalls >= 2);
  assert.equal(local.runCount, 1);
});

test("persistent DescribeInstances denial preserves configured credentials and handle", async () => {
  const settings = new FakeSettings();
  settings.credentials = OLD_CREDS;
  settings.handle = OLD_HANDLE;
  settings.mode = "aws";
  const refreshed = new FakeEc2Client();
  refreshed.findErrors = Array.from({ length: 4 }, () => new Error("not authorized to perform ec2:DescribeInstances"));
  const service = serviceWith(settings, new Map([
    [OLD_CREDS.accessKeyId, new FakeEc2Client()],
    [NEW_CREDS.accessKeyId, refreshed]
  ]));

  await assert.rejects(
    () => service.prepareWorker({ operationId: "persistent-describe", blob: encodeWorkerBlob(NEW_CREDS) }),
    /not authorized to perform/
  );
  assert.equal(refreshed.findCalls, 4);
  assert.equal(refreshed.runCount, 0);
  assert.deepEqual(settings.credentials, OLD_CREDS);
  assert.deepEqual(settings.handle, OLD_HANDLE);
});

test("worker discovery retries a transient authorization denial without weakening cross-region discovery", async () => {
  const settings = new FakeSettings();
  const client = new FakeEc2Client();
  client.discovered = [];
  client.listRegionErrors = [Object.assign(new Error("not authorized to perform ec2:DescribeRegions"), { name: "UnauthorizedOperation" })];
  const service = serviceWith(settings, new Map([[NEW_CREDS.accessKeyId, client]]));

  const prepared = await service.prepareWorker({ operationId: "transient-auth", blob: encodeWorkerBlob(NEW_CREDS) });
  assert.equal(prepared.info.instanceId, "i-new");
  assert.ok(client.listRegionCalls >= 2);
  assert.equal(client.runCount, 1);
});

test("worker discovery surfaces a persistent authorization denial without creating a worker", async () => {
  const settings = new FakeSettings();
  const client = new FakeEc2Client();
  client.discovered = [];
  client.listRegionErrors = Array.from({ length: 4 }, () => new Error("not authorized to perform ec2:DescribeRegions"));
  const service = serviceWith(settings, new Map([[NEW_CREDS.accessKeyId, client]]));

  await assert.rejects(
    () => service.prepareWorker({ operationId: "persistent-auth", blob: encodeWorkerBlob(NEW_CREDS) }),
    /not authorized to perform/
  );
  assert.equal(client.listRegionCalls, 4);
  assert.equal(client.runCount, 0);
  assert.equal(settings.credentials, undefined);
  assert.equal(settings.handle, undefined);
});

test("prepareWorker returns an explicit mismatch for an undersized tagged worker", async () => {
  const settings = new FakeSettings();
  const client = new FakeEc2Client();
  client.discovered = [{
    instanceId: "i-small",
    state: "stopped",
    region: "us-east-1",
    securityGroupId: "sg-small",
    instanceType: "t3.small",
    vCpu: 2,
    memoryMiB: 2048,
    rootVolumeSizeGb: 8
  }];
  const service = serviceWith(settings, new Map([[NEW_CREDS.accessKeyId, client]]));
  const prepared = await service.prepareWorker({
    operationId: "mismatch-op",
    blob: encodeWorkerBlob(NEW_CREDS),
    instanceType: "t3.medium",
    rootVolumeSizeGb: 16
  });
  assert.equal(prepared.mismatch?.computeTooSmall, true);
  assert.equal(prepared.mismatch?.diskTooSmall, true);
  assert.equal(client.runCount, 0);
});

test("cross-region adopted workers use the handle region for start, stop, and delete", async () => {
  const settings = new FakeSettings();
  const east = new FakeEc2Client();
  east.state = undefined;
  east.enabledRegions = ["us-east-1", "eu-west-1"];
  const westInfo: AwsWorkerInstanceInfo = {
    instanceId: "i-eu",
    state: "running",
    publicIp: "198.51.100.30",
    region: "eu-west-1",
    availabilityZone: "eu-west-1a",
    securityGroupId: "sg-eu",
    keyName: "launch-eu",
    instanceType: "t3.small",
    vCpu: 2,
    memoryMiB: 2048,
    rootVolumeId: "vol-eu",
    rootVolumeSizeGb: 8
  };
  const west = new FakeEc2Client(westInfo);
  west.discovered = [westInfo];
  const service = serviceWith(settings, new Map([
    [`${NEW_CREDS.accessKeyId}:us-east-1`, east],
    [`${NEW_CREDS.accessKeyId}:eu-west-1`, west]
  ]));
  const prepared = await service.prepareWorker({ operationId: "cross-region", blob: encodeWorkerBlob(NEW_CREDS) });
  assert.equal(prepared.handle.region, "eu-west-1");
  await service.ensurePreparedRunning(prepared);
  await service.stopWorker();
  await service.deleteWorker();
  assert.equal(east.describeCalls, 0);
  assert.ok(west.describeCalls > 0);
  assert.equal(west.stopCount, 1);
  assert.deepEqual(west.terminatedInstances, ["i-eu"]);
});

test("concurrent preparation shares one creation and one client token", async () => {
  const settings = new FakeSettings();
  const client = new FakeEc2Client();
  client.discovered = [];
  const service = serviceWith(settings, new Map([[NEW_CREDS.accessKeyId, client]]));
  const request = { operationId: "same-operation", clientToken: "stable-token", blob: encodeWorkerBlob(NEW_CREDS) };
  const [first, second] = await Promise.all([service.prepareWorker(request), service.prepareWorker(request)]);
  assert.equal(first.info.instanceId, second.info.instanceId);
  assert.equal(client.runCount, 1);
  assert.deepEqual(client.runTokens, ["stable-token"]);
});

test("preparation never returns another request's instance, size or credentials", async () => {
  const settings = new FakeSettings();
  const client = new FakeEc2Client();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const originalFind = client.findWorkerInstances.bind(client);
  client.findWorkerInstances = async () => { await gate; return originalFind(); };
  const service = serviceWith(settings, new Map([[NEW_CREDS.accessKeyId, client]]));
  const request = { operationId: "same", blob: encodeWorkerBlob(NEW_CREDS), instanceType: "t3.small", rootVolumeSizeGb: 40 };
  const active = service.prepareWorker(request);
  try {
    for (const change of [{ operationId: "other" }, { instanceType: "t3.medium" }, { rootVolumeSizeGb: 80 },
      { expectedInstanceId: "i-other" }, { blob: encodeWorkerBlob(OLD_CREDS) }, { clientToken: "another" }]) {
      await assert.rejects(service.prepareWorker({ ...request, ...change }), /still running/);
    }
    assert.equal(client.runCount, 0);
  } finally { release(); }
  assert.equal((await active).desiredSpec.rootVolumeSizeGb, 40);
  await assert.rejects(service.prepareWorker({ ...request, expectedInstanceId: "i-other" }), /instance changed/,
    "after the first finishes the new request executes its own guard");
  assert.equal(client.runCount, 1);
});

test("an ambiguous launch persists its token for a later runtime retry", async () => {
  const settings = new FakeSettings();
  const client = new FakeEc2Client();
  const originalRun = client.runInstance.bind(client);
  let ambiguous = true;
  client.runInstance = async (spec) => {
    if (ambiguous) {
      ambiguous = false;
      client.runCount += 1;
      client.runTokens.push(spec.clientToken);
      throw new Error("socket closed after launch");
    }
    return originalRun(spec);
  };
  const service = serviceWith(settings, new Map([[NEW_CREDS.accessKeyId, client]]));
  await assert.rejects(
    () => service.prepareWorker({ operationId: "first-runtime", clientToken: "persisted-token", blob: encodeWorkerBlob(NEW_CREDS) }),
    /socket closed/
  );
  assert.equal(settings.provisioningToken, "persisted-token");
  await service.prepareWorker({ operationId: "later-runtime", blob: encodeWorkerBlob(NEW_CREDS) });
  assert.deepEqual(client.runTokens, ["persisted-token", "persisted-token"]);
  assert.equal(settings.provisioningToken, undefined);
});

test("post-create reconciliation tolerates an initially invisible tagged instance", async () => {
  const settings = new FakeSettings();
  const client = new FakeEc2Client();
  let afterCreateScans = 0;
  const originalFind = client.findWorkerInstances.bind(client);
  client.findWorkerInstances = async () => {
    if (client.runCount === 0) return [];
    afterCreateScans += 1;
    if (afterCreateScans === 1) return [];
    return originalFind();
  };
  const service = serviceWith(settings, new Map([[NEW_CREDS.accessKeyId, client]]));
  await service.prepareWorker({ operationId: "reconcile", clientToken: "reconcile-token", blob: encodeWorkerBlob(NEW_CREDS) });
  assert.equal(client.runCount, 1);
  assert.ok(afterCreateScans >= 3);
});

test("disk expansion retry resumes only filesystem work after EBS already grew", async () => {
  const settings = new FakeSettings();
  settings.credentials = NEW_CREDS;
  const info: AwsWorkerInstanceInfo = {
    instanceId: "i-grow",
    state: "running",
    publicIp: "198.51.100.40",
    region: "us-east-1",
    availabilityZone: "us-east-1a",
    securityGroupId: "sg-grow",
    keyName: "launch-grow",
    instanceType: "t3.small",
    rootVolumeId: "vol-grow",
    rootVolumeSizeGb: 8
  };
  const client = new FakeEc2Client(info);
  let filesystemAttempts = 0;
  const filesystemCommands: string[] = [];
  const service = serviceWith(settings, new Map([[NEW_CREDS.accessKeyId, client]]), {
    sshExec: async (_worker, command) => {
      filesystemAttempts += 1;
      filesystemCommands.push(command);
      if (filesystemAttempts === 1) throw new Error("resize failed");
    }
  });
  const prepared = {
    credentials: NEW_CREDS,
    handle: { ...OLD_HANDLE, instanceId: "i-grow", securityGroupId: "sg-grow", rootVolumeId: "vol-grow" },
    info,
    actualSpec: { instanceId: "i-grow", region: "us-east-1", instanceType: "t3.small", rootVolumeSizeGb: 8 },
    desiredSpec: { instanceType: "t3.small", rootVolumeSizeGb: 16 },
    mismatch: {
      instanceId: "i-grow",
      actual: { instanceId: "i-grow", region: "us-east-1", instanceType: "t3.small", rootVolumeSizeGb: 8 },
      desired: { instanceType: "t3.small", rootVolumeSizeGb: 16 },
      diskTooSmall: true,
      computeTooSmall: false
    },
    created: false
  };
  await assert.rejects(() => service.growDisk(prepared), /resize failed/);
  assert.equal(settings.volumeExpansion?.targetSizeGb, 16);
  assert.deepEqual(client.modifiedSizes, [16]);
  assert.ok(filesystemCommands[0].includes("PKNAME \"$root\" | head -1 | tr -d '[:space:]'"));
  assert.ok(filesystemCommands[0].includes("PARTN \"$root\" | head -1 | tr -d '[:space:]'"));
  settings.handle = prepared.handle;
  settings.awsRootVolumeSizeGb = 16;
  await service.ensureWorkerForRun();
  assert.equal(settings.volumeExpansion, undefined);
  assert.deepEqual(client.modifiedSizes, [16]);
  assert.equal(filesystemAttempts, 2);
});

test("explicit disk input is rejected before settings or AWS are touched instead of silently clamped", async () => {
  let reads = 0;
  const settings = { getAwsWorkerCredentials: async () => { reads++; throw new Error("Input must be checked first"); } };
  const service = new CloudRunAwsService(settings as any);
  for (const size of [0, 7, 8.5, 1025, NaN, Infinity]) {
    await assert.rejects(service.prepareWorker({ operationId: "invalid-size", rootVolumeSizeGb: size }), /whole number/);
  }
  assert.equal(reads, 0);
});

test("a size edit refuses discovery of a replacement or missing instance without provisioning", async () => {
  for (const discovered of [[], [{ instanceId: "i-replacement", state: "running" as const, region: "us-east-1", securityGroupId: "sg-new", instanceType: "t3.small", rootVolumeSizeGb: 40 }]]) {
    const settings = new FakeSettings();
    settings.credentials = NEW_CREDS;
    settings.handle = OLD_HANDLE;
    const client = new FakeEc2Client();
    client.discovered = discovered;
    const service = serviceWith(settings, new Map([[NEW_CREDS.accessKeyId, client]]));
    await assert.rejects(service.prepareWorker({ operationId: "resize-stale", expectedInstanceId: "i-old", rootVolumeSizeGb: 41 }), /instance changed/);
    assert.equal(client.runCount, 0);
    assert.equal(settings.handle, OLD_HANDLE);
    assert.equal(settings.awsRootVolumeSizeGb, 8);
  }
});

test("probeAccess leaves AWS's refusal intact while status() reports it as a message", async () => {
  const settings = new FakeSettings();
  settings.credentials = OLD_CREDS;
  settings.handle = OLD_HANDLE;
  const client = new FakeEc2Client({ instanceId: "i-old", state: "stopped" });
  client.describeError = Object.assign(new Error("User: arn:aws:iam::123456789012:user/worker is not authorized to perform: ec2:DescribeInstances"), { name: "UnauthorizedOperation" });
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]));
  await assert.rejects(service.probeAccess(), /not authorized/);
  const status = await service.status();
  assert.equal(status.configured, true);
  assert.equal(status.state, undefined);
  assert.match(status.message ?? "", /not authorized/);
  client.describeError = undefined;
  assert.equal((await service.probeAccess()).state, "stopped");
  assert.equal(client.runCount, 0);
});

test("adoptCredentials saves pasted credentials only after they read the existing instance", async () => {
  const settings = new FakeSettings();
  settings.credentials = OLD_CREDS;
  settings.handle = OLD_HANDLE;
  const rejected = { accessKeyId: "AKIAREJECTED0000", secretAccessKey: "rejected", region: "us-east-1" };
  const refusing = new FakeEc2Client({ instanceId: "i-old", state: "stopped" });
  refusing.describeError = new Error("AccessDenied");
  const accepting = new FakeEc2Client({ instanceId: "i-old", state: "stopped" });
  const service = serviceWith(settings, new Map([[rejected.accessKeyId, refusing], [NEW_CREDS.accessKeyId, accepting]]));
  await assert.rejects(service.adoptCredentials(encodeWorkerBlob(rejected)), /AccessDenied/);
  assert.equal(settings.credentials, OLD_CREDS);
  const blind = { accessKeyId: "AKIABLIND0000000", secretAccessKey: "blind", region: "us-east-1" };
  const elsewhere = { accessKeyId: "AKIAELSEWHERE000", secretAccessKey: "elsewhere", region: "us-east-1" };
  const service2 = serviceWith(settings, new Map([
    [rejected.accessKeyId, refusing], [NEW_CREDS.accessKeyId, accepting],
    [blind.accessKeyId, new FakeEc2Client(undefined)],
    [elsewhere.accessKeyId, new FakeEc2Client({ instanceId: "i-other", state: "running" })]
  ]));
  await assert.rejects(service2.adoptCredentials(encodeWorkerBlob(blind)), /cannot see the existing instance i-old/);
  await assert.rejects(service2.adoptCredentials(encodeWorkerBlob(elsewhere)), /cannot see the existing instance i-old/);
  assert.equal(settings.credentials, OLD_CREDS, "credentials that do not see the instance are never saved");
  await service2.adoptCredentials(encodeWorkerBlob(NEW_CREDS));
  assert.equal(settings.credentials?.accessKeyId, NEW_CREDS.accessKeyId);
  assert.equal(settings.handle, OLD_HANDLE);
  assert.equal(accepting.runCount, 0);
});

test("an instance AWS no longer has is removed once it is older than AWS's visibility delay", async () => {
  const { settings, removed, removeMachine } = instanceWithMachines();
  let now = Date.parse(OLD_HANDLE.createdAt) + 60_000;
  const client = new FakeEc2Client();
  client.state = undefined;
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]), { removeMachine, now: () => now });
  assert.equal((await service.status()).configured, true, "just launched: AWS may not show it yet");
  assert.deepEqual(removed, []);
  now += 10 * 60_000;
  assert.equal((await service.status()).notices?.join("\n"), GONE_NOTICE);
  assert.deepEqual(removed, ["cloud", "older"]);
});

test("a new instance is not started over a saved instance that cannot be checked or is not visible yet", async () => {
  {
    const { settings, removed, removeMachine } = instanceWithMachines();
    const client = new InstancesEc2Client({ ...OLD_RUNNING, state: "terminated" });
    client.describeError = Object.assign(new Error("Rate exceeded."), { name: "RequestLimitExceeded" });
    const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]), { removeMachine });
    await assert.rejects(service.prepareWorker({ operationId: "throttled" }), (error: Error) => {
      assert.equal(error.message, "Could not check the previous instance i-old in AWS: Rate exceeded. Nothing was changed; try again.", "one period");
      assert.equal(isAwsAuthorizationError(error), false);
      return true;
    });
    assert.equal(client.runCount, 0);
    assert.deepEqual(removed, []);
    assert.deepEqual(settings.handle, OLD_HANDLE);
  }
  {
    const { settings, removed, removeMachine } = instanceWithMachines();
    settings.handle = { ...OLD_HANDLE, createdAt: new Date(Date.now() - 60_000).toISOString() };
    const client = new InstancesEc2Client();
    const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]), { removeMachine });
    await assert.rejects(service.prepareWorker({ operationId: "fresh" }), /AWS does not show the previous instance i-old yet/);
    assert.equal(client.runCount, 0, "no second instance beside one AWS has not shown yet");
    assert.deepEqual(removed, []);
  }
});

test("the program counts as set up on an instance only once it has connected", async () => {
  const settings = powerSettings();
  const service = serviceWith(settings, new Map());
  settings.installs = [installFor("cloud")];
  assert.equal(await service.programInstalledOn(POWER_HANDLE.instanceId), false, "installed but never connected is not set up");
  settings.machines = [{ id: "cloud", awsInstanceId: POWER_HANDLE.instanceId, lastHello: { appVersion: "1.11.1" } } as never, { id: "desk-box" }];
  assert.equal(await service.programInstalledOn(POWER_HANDLE.instanceId), true);
  assert.equal(await service.programInstalledOn("i-another"), false);
});
