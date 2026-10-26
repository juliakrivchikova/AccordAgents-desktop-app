import assert from "node:assert/strict";
import type { MachineRecoveryFailure } from "./machineRecovery";
import test from "node:test";
import type { AppSettings, AwsWorkerHandleInfo, AwsWorkerOperationSnapshot } from "../../shared/types";
import type { MachineInstallRecord } from "../../shared/machineInstall";
import { AWS_INSTANCE_GONE_NOTICE, CloudRunAwsService } from "./cloudRunAws";
import type { CloudRunAwsServiceOptions, PreparedAwsWorker } from "./cloudRunAws";
import { resolveCurrentWorkerAddress } from "./cloudRunWorkers";
import { encodeWorkerBlob } from "./awsWorkerProvisioning";
import { isAwsAuthorizationError } from "./awsEc2Client";
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

type LeavingEntry = { machineId: string; instanceId: string; at: string; unverified?: "refused" | "unreadable"; region?: string; accountId?: string };

class FakeSettings {
  credentials: AwsWorkerCredentials | undefined;
  handle: AwsWorkerHandleInfo | undefined;
  mode: "ssh" | "aws" = "ssh";
  awsRootVolumeSizeGb = 8;
  deviceId = "device-a";
  volumeExpansion: { instanceId: string; volumeId: string; targetSizeGb: number; updatedAt: string } | undefined;
  provisioningToken: string | undefined;
  operation: AwsWorkerOperationSnapshot | undefined;
  machines: Array<{ id: string; awsInstanceId?: string; lastSeenAt?: string; lastHello?: { idleStopWarning?: string; autoStopEnabled?: boolean; keepAwakeScripts?: number } }> = [];
  installs: MachineInstallRecord[] = [];
  autoStopEnabled = true;
  changedAt: string | undefined;

  async getMachineAutoStopChangedAt(): Promise<string | undefined> {
    return this.changedAt;
  }

  async getMachineAutoStopEnabled(): Promise<boolean> {
    return this.autoStopEnabled;
  }

  async setMachineAutoStopEnabled(enabled: boolean): Promise<void> {
    this.autoStopEnabled = enabled;
  }

  async listMachines(): Promise<Array<{ id: string; awsInstanceId?: string; lastSeenAt?: string; lastHello?: { idleStopWarning?: string; autoStopEnabled?: boolean; keepAwakeScripts?: number } }>> {
    return this.machines;
  }

  async listMachineInstalls(): Promise<MachineInstallRecord[]> {
    return this.installs;
  }

  async getAwsWorkerCredentials(): Promise<AwsWorkerCredentials | undefined> {
    return this.credentials;
  }

  async getPublicSettings(): Promise<AppSettings> {
    return {
      betaUpdates: false,
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

  async getAwsWorkerOperation(): Promise<AwsWorkerOperationSnapshot | undefined> {
    return this.operation;
  }

  goneNotice: { instanceId: string; at: string } | undefined;

  async getAwsWorkerGoneNotice(): Promise<{ instanceId: string; at: string } | undefined> {
    return this.goneNotice;
  }

  leaving: LeavingEntry[] = [];

  async addLeavingMachines(entries: LeavingEntry[]): Promise<LeavingEntry[]> {
    const waiting = new Set(this.leaving.filter((entry) => !entry.unverified).map((entry) => entry.machineId));
    const incoming = entries.filter((entry) => !(entry.unverified && waiting.has(entry.machineId)));
    const ids = new Set(incoming.map((entry) => entry.machineId));
    const all = [...this.leaving.filter((entry) => !ids.has(entry.machineId)), ...incoming];
    this.leaving = all.slice(-50);
    return all.slice(0, all.length - this.leaving.length);
  }

  async listLeavingMachines(): Promise<LeavingEntry[]> {
    return this.leaving.map((entry) => ({ ...entry }));
  }

  async clearLeavingMachine(machineId: string): Promise<void> {
    this.leaving = this.leaving.filter((entry) => entry.machineId !== machineId);
  }

  async saveAwsWorkerConnection(credentials: AwsWorkerCredentials, handle: AwsWorkerHandleInfo): Promise<void> {
    this.credentials = credentials;
    this.handle = handle;
    this.mode = "aws";
    this.goneNotice = undefined;
  }

  async forgetAwsWorkerInstance(instanceId: string, options: { keepCredentials: boolean; notice?: { instanceId: string; at: string }; mode?: "ssh" | "aws" }): Promise<boolean> {
    if (this.handle?.instanceId !== instanceId) return false;
    this.handle = undefined;
    this.operation = undefined;
    this.volumeExpansion = undefined;
    if (!options.keepCredentials) {
      this.credentials = undefined;
      this.provisioningToken = undefined;
    }
    if (options.mode) this.mode = options.mode;
    this.goneNotice = options.notice;
    return true;
  }
}

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
  describeTypeError: Error | undefined;
  terminateError: Error | undefined;
  stopError: Error | undefined;
  findErrors: Error[] = [];
  listRegionErrors: Error[] = [];
  discovered: AwsWorkerInstanceInfo[] = [];
  runCount = 0;
  describeCalls = 0;
  stopCount = 0;
  runTokens: Array<string | undefined> = [];
  modifiedSizes: number[] = [];
  enabledRegions = ["us-east-1"];
  findCalls = 0;
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
    this.findCalls += 1;
    const error = this.findErrors.shift();
    if (error) throw error;
    return this.discovered;
  }

  async describeInstanceType(instanceType: string): Promise<{ vCpu: number; memoryMiB: number }> {
    if (this.describeTypeError) {
      throw this.describeTypeError;
    }
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
  assert.equal((service as any).lifecycle.activeRuns, 1);
  await service.noteRunEnded("run-1");
  await service.noteRunEnded("run-1");
  assert.equal((service as any).lifecycle.activeRuns, 0);
});

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

// ---- automatic stop key ----------------------------------------------------

const POWER_HANDLE: AwsWorkerHandleInfo = { ...OLD_HANDLE, instanceId: "i-0943b28f7231ab93c" };
const POWER_KEY = { accessKeyId: "AKIAPOWERKEY000000001", secretAccessKey: "power-secret" };

function powerSettings(): FakeSettings {
  const settings = new FakeSettings();
  settings.credentials = { ...OLD_CREDS, power: POWER_KEY };
  settings.handle = POWER_HANDLE;
  settings.machines = [{ id: "cloud", awsInstanceId: POWER_HANDLE.instanceId }, { id: "desk-box" }];
  return settings;
}

function installFor(machineId: string, extra: Partial<MachineInstallRecord> = {}): MachineInstallRecord {
  return { machineId, target: { host: "203.0.113.9", user: "ubuntu" }, installRoot: "/r", userDataDir: "/d", serviceName: "s",
    serviceScope: "system", installedVersion: "1.11.1", ...extra };
}

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
  assert.deepEqual(await autoStop(), { ...ON, problem: { message: "The program that stops the instance is not set up on it yet.",
    action: "reconnect", actionLabel: "Set it up" } });
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
  assert.equal((await autoStop())?.problem?.actionLabel, "Set it up", "a machine elsewhere does not count");
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

// ---- an instance that can never come back -----------------------------------

const GONE_NOTICE = AWS_INSTANCE_GONE_NOTICE;

/** This app's instance with the machine on it, one from an older version
 *  matched by its pinned host key, and one machine elsewhere. */
function instanceWithMachines(): { settings: FakeSettings; removed: string[]; removeMachine: (machineId: string) => Promise<void> } {
  const settings = new FakeSettings();
  settings.credentials = OLD_CREDS;
  settings.handle = OLD_HANDLE;
  settings.mode = "aws";
  settings.machines = [{ id: "cloud", awsInstanceId: OLD_HANDLE.instanceId }, { id: "older" }, { id: "elsewhere", awsInstanceId: "i-other" }];
  settings.installs = [installFor("older", { target: { host: "203.0.113.9", user: "ubuntu", hostKeyAlias: `accordagents-${OLD_HANDLE.instanceId}` } }),
    installFor("elsewhere")];
  const removed: string[] = [];
  const removeMachine = async (machineId: string): Promise<void> => {
    removed.push(machineId);
    settings.machines = settings.machines.filter((machine) => machine.id !== machineId);
    settings.installs = settings.installs.filter((record) => record.machineId !== machineId);
  };
  return { settings, removed, removeMachine };
}

const notAuthorized = (): Error => Object.assign(new Error("You are not authorized to perform this operation."), { name: "UnauthorizedOperation" });

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

// ---- an instance replaced by a new one ---------------------------------------

/** Each instance answers for itself; a launch makes a new running one. */
class InstancesEc2Client extends FakeEc2Client {
  readonly instances = new Map<string, AwsWorkerInstanceInfo>();
  readonly events: string[] = [];

  constructor(...initial: AwsWorkerInstanceInfo[]) {
    super(undefined);
    for (const info of initial) this.instances.set(info.instanceId, info);
    this.discovered = initial.filter((info) => info.state !== "terminated");
  }

  override async describeInstance(instanceId?: string): Promise<AwsWorkerInstanceInfo | undefined> {
    this.describeCalls += 1;
    if (this.describeError) throw this.describeError;
    return instanceId ? this.instances.get(instanceId) : undefined;
  }

  override async runInstance(spec: Parameters<Ec2Client["runInstance"]>[0]): Promise<string> {
    this.runCount += 1;
    const instanceId = `i-new${this.runCount}`;
    const info: AwsWorkerInstanceInfo = { instanceId, state: "running", publicIp: "198.51.100.20", region: "us-east-1",
      securityGroupId: "sg-new", keyName: "accordagents-worker-new", instanceType: spec.instanceType, rootVolumeSizeGb: 8 };
    this.instances.set(instanceId, info);
    this.discovered = [info];
    this.events.push(`launch:${instanceId}`);
    return instanceId;
  }

  override async terminateInstance(instanceId: string): Promise<void> {
    this.terminatedInstances.push(instanceId);
    if (this.terminateError) throw this.terminateError;
    const info = this.instances.get(instanceId);
    if (info) this.instances.set(instanceId, { ...info, state: "terminated" });
    this.discovered = this.discovered.filter((item) => item.instanceId !== instanceId);
    this.events.push(`terminate:${instanceId}`);
  }
}

const OLD_RUNNING: AwsWorkerInstanceInfo = { instanceId: OLD_HANDLE.instanceId, state: "running", publicIp: "198.51.100.10", region: "us-east-1",
  securityGroupId: OLD_HANDLE.securityGroupId, keyName: OLD_HANDLE.keyName, instanceType: "t3.small", rootVolumeSizeGb: 8 };

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
