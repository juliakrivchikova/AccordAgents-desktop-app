import assert from "node:assert/strict";
import test from "node:test";
import type { AppSettings, AwsWorkerHandleInfo } from "../../shared/types";
import { CloudRunAwsService } from "./cloudRunAws";
import type { CloudRunAwsServiceOptions } from "./cloudRunAws";
import { encodeWorkerBlob } from "./awsWorkerProvisioning";
import type { AwsWorkerCredentials } from "./awsWorkerProvisioning";
import type { AwsWorkerInstanceInfo, Ec2Client } from "./awsWorkerLifecycle";
import type { SettingsService } from "./settings";

const OLD_CREDS = { accessKeyId: "AKIAOLDKEY000000", secretAccessKey: "old-secret", region: "us-east-1" };
const NEW_CREDS = { accessKeyId: "AKIANEWKEY000000", secretAccessKey: "new-secret", region: "us-east-1" };
const OLD_HANDLE: AwsWorkerHandleInfo = {
  instanceId: "i-old",
  securityGroupId: "sg-old",
  keyName: "accordagents-worker-old",
  region: "us-east-1",
  instanceType: "t3.small",
  createdAt: "2026-07-03T00:00:00.000Z"
};

class FakeSettings {
  credentials: AwsWorkerCredentials | undefined;
  handle: AwsWorkerHandleInfo | undefined;
  mode: "ssh" | "aws" = "ssh";
  awsRootVolumeSizeGb = 8;
  deviceId = "device-a";
  volumeExpansion: { instanceId: string; volumeId: string; targetSizeGb: number; updatedAt: string } | undefined;
  provisioningToken: string | undefined;

  async getAwsWorkerCredentials(): Promise<AwsWorkerCredentials | undefined> {
    return this.credentials;
  }

  async getPublicSettings(): Promise<AppSettings> {
    return {
      cloudRuns: {
        enabled: true,
        mode: this.mode,
        worker: {},
        hasAwsCredentials: Boolean(this.credentials),
        awsHandle: this.handle,
        awsInstanceType: "t3.small",
        awsRootVolumeSizeGb: this.awsRootVolumeSizeGb,
        maxRuntimeMs: 24 * 60 * 60_000,
        pollIntervalMs: 2_500
      }
    } as AppSettings;
  }

  async saveAwsWorkerCredentials(credentials: AwsWorkerCredentials): Promise<void> {
    this.credentials = credentials;
  }

  async saveAwsWorkerHandle(handle: AwsWorkerHandleInfo | undefined): Promise<void> {
    this.handle = handle;
  }

  async saveCloudRunsSettings(update: { awsRootVolumeSizeGb?: number }): Promise<AppSettings> {
    this.awsRootVolumeSizeGb = update.awsRootVolumeSizeGb ?? this.awsRootVolumeSizeGb;
    return this.getPublicSettings();
  }

  async clearAwsWorker(): Promise<void> {
    this.credentials = undefined;
    this.handle = undefined;
  }

  async setCloudRunsMode(mode: "ssh" | "aws"): Promise<void> {
    this.mode = mode;
  }

  async getCloudRunsDeviceId(): Promise<string> {
    return this.deviceId;
  }

  async saveAwsWorkerVolumeExpansion(value: typeof this.volumeExpansion): Promise<void> {
    this.volumeExpansion = value;
  }

  async getAwsWorkerVolumeExpansion(): Promise<typeof this.volumeExpansion> {
    return this.volumeExpansion;
  }

  async saveAwsWorkerProvisioningToken(token: string | undefined): Promise<void> {
    this.provisioningToken = token;
  }

  async getAwsWorkerProvisioningToken(): Promise<string | undefined> {
    return this.provisioningToken;
  }
}

class FakeEc2Client implements Ec2Client {
  importedKeyPairs: string[] = [];
  terminatedInstances: string[] = [];
  deletedKeyPairs: string[] = [];
  deletedSecurityGroups: string[] = [];
  securityGroupNames: string[] = [];
  authorizedCidrs: string[] = [];
  revokedSecurityGroups: string[] = [];
  importError: Error | undefined;
  describeError: Error | undefined;
  terminateError: Error | undefined;
  stopError: Error | undefined;
  listRegionErrors: Error[] = [];
  discovered: AwsWorkerInstanceInfo[] = [];
  runCount = 0;
  describeCalls = 0;
  stopCount = 0;
  runTokens: Array<string | undefined> = [];
  modifiedSizes: number[] = [];
  enabledRegions = ["us-east-1"];
  listRegionCalls = 0;

  constructor(public state: AwsWorkerInstanceInfo | undefined = { instanceId: "i-new", state: "running", publicIp: "198.51.100.5" }) {}

  async resolveUbuntuImage(): Promise<{ imageId: string; rootDeviceName: string }> {
    return { imageId: "ami-ubuntu", rootDeviceName: "/dev/sda1" };
  }

  async listEnabledRegions(): Promise<string[]> {
    this.listRegionCalls += 1;
    const error = this.listRegionErrors.shift();
    if (error) throw error;
    return this.enabledRegions;
  }

  async findWorkerInstances(): Promise<AwsWorkerInstanceInfo[]> {
    return this.discovered;
  }

  async describeInstanceType(instanceType: string): Promise<{ vCpu: number; memoryMiB: number }> {
    return instanceType === "t3.medium" ? { vCpu: 2, memoryMiB: 4096 } : { vCpu: 2, memoryMiB: 2048 };
  }

  async keyPairExists(): Promise<boolean> {
    return false;
  }

  async importKeyPair(name: string): Promise<void> {
    this.importedKeyPairs.push(name);
    if (this.importError) {
      throw this.importError;
    }
  }

  async deleteKeyPair(name: string): Promise<void> {
    this.deletedKeyPairs.push(name);
  }

  async ensureSecurityGroup(name: string): Promise<string> {
    this.securityGroupNames.push(name);
    return "sg-new";
  }

  async deleteSecurityGroup(securityGroupId: string): Promise<void> {
    this.deletedSecurityGroups.push(securityGroupId);
  }

  async authorizeSshIngress(_securityGroupId: string, cidr: string): Promise<void> {
    this.authorizedCidrs.push(cidr);
  }

  async revokeAllSshIngress(securityGroupId: string): Promise<void> {
    this.revokedSecurityGroups.push(securityGroupId);
  }

  async runInstance(spec: Parameters<Ec2Client["runInstance"]>[0]): Promise<string> {
    this.runCount += 1;
    this.runTokens.push(spec.clientToken);
    const info = this.state ?? { instanceId: "i-new", state: "pending" as const };
    this.discovered = [{
      ...info,
      instanceId: "i-new",
      region: "us-east-1",
      securityGroupId: "sg-new",
      keyName: "accordagents-worker-new",
      instanceType: "t3.small",
      rootVolumeSizeGb: 8
    }];
    return "i-new";
  }

  async describeInstance(): Promise<AwsWorkerInstanceInfo | undefined> {
    this.describeCalls += 1;
    if (this.describeError) {
      throw this.describeError;
    }
    return this.state;
  }

  async startInstance(): Promise<void> {
    this.state = { instanceId: this.state?.instanceId ?? "i-new", state: "running", publicIp: "198.51.100.5" };
  }

  async stopInstance(): Promise<void> {
    this.stopCount += 1;
    if (this.stopError) throw this.stopError;
    this.state = { instanceId: this.state?.instanceId ?? "i-new", state: "stopped" };
  }

  async terminateInstance(instanceId: string): Promise<void> {
    this.terminatedInstances.push(instanceId);
    if (this.terminateError) {
      throw this.terminateError;
    }
    this.state = { instanceId, state: "terminated" };
  }

  async modifyVolumeSize(_volumeId: string, sizeGb: number): Promise<void> {
    this.modifiedSizes.push(sizeGb);
    if (this.state) this.state = { ...this.state, rootVolumeSizeGb: sizeGb };
  }

  async describeVolumeModification(): Promise<"completed"> {
    return "completed";
  }
}

function serviceWith(
  settings: FakeSettings,
  clients: Map<string, FakeEc2Client>,
  overrides: Partial<CloudRunAwsServiceOptions> = {}
): CloudRunAwsService {
  return new CloudRunAwsService(settings as unknown as SettingsService, {
    createEc2Client: (credentials) => {
      const client = clients.get(`${credentials.accessKeyId}:${credentials.region}`) ?? clients.get(credentials.accessKeyId);
      if (!client) {
        throw new Error(`missing fake client for ${credentials.accessKeyId}`);
      }
      return client;
    },
    generateKeyMaterial: async () => ({
      keyName: "accordagents-worker-new",
      publicKeyOpenSsh: "ssh-ed25519 AAAA",
      privateKeyPath: "/keys/accordagents-worker-new.pem"
    }),
    deleteKeyMaterial: async () => undefined,
    currentPublicIp: async () => "203.0.113.9",
    privateKeyPathForKeyName: (keyName) => `/keys/${keyName}.pem`,
    workerAccess: { ensureAccess: async () => undefined } as any,
    wait: async () => undefined,
    ...overrides
  });
}

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

test("AWS run references are acquired and released exactly once per run id", async () => {
  const settings = new FakeSettings();
  settings.credentials = OLD_CREDS;
  settings.handle = OLD_HANDLE;
  settings.mode = "aws";
  const client = new FakeEc2Client({ instanceId: "i-old", state: "running", publicIp: "198.51.100.10" });
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, client]]));

  service.noteRunStarted("run-1");
  service.noteRunStarted("run-1");
  assert.equal((service as any).lifecycle.activeRuns, 1);
  await service.noteRunEnded("run-1");
  await service.noteRunEnded("run-1");
  assert.equal((service as any).lifecycle.activeRuns, 0);
});

test("a Settings-only AWS operation rearms automatic idle stop", async () => {
  const settings = new FakeSettings();
  settings.credentials = OLD_CREDS;
  settings.handle = OLD_HANDLE;
  settings.mode = "aws";
  const client = new FakeEc2Client({ instanceId: "i-old", state: "running", publicIp: "198.51.100.10" });
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
    assert.equal((service as any).lifecycle.activeRuns, 1);
  });
  assert.equal((service as any).lifecycle.activeRuns, 0);
  await waitFor(() => client.state?.state === "stopped");
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for AWS lifecycle state.");
}

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
  const service = serviceWith(settings, new Map([[NEW_CREDS.accessKeyId, client]]), {
    sshExec: async () => {
      filesystemAttempts += 1;
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
  settings.handle = prepared.handle;
  settings.awsRootVolumeSizeGb = 16;
  await service.ensureWorkerForRun();
  assert.equal(settings.volumeExpansion, undefined);
  assert.deepEqual(client.modifiedSizes, [16]);
  assert.equal(filesystemAttempts, 2);
});
