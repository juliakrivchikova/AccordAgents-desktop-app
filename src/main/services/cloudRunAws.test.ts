import assert from "node:assert/strict";
import test from "node:test";
import type { AppSettings, AwsWorkerHandleInfo } from "../../shared/types";
import { CloudRunAwsService } from "./cloudRunAws";
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

  constructor(public state: AwsWorkerInstanceInfo | undefined = { instanceId: "i-new", state: "running", publicIp: "198.51.100.5" }) {}

  async resolveUbuntuImage(): Promise<{ imageId: string; rootDeviceName: string }> {
    return { imageId: "ami-ubuntu", rootDeviceName: "/dev/sda1" };
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

  async runInstance(): Promise<string> {
    return "i-new";
  }

  async describeInstance(): Promise<AwsWorkerInstanceInfo | undefined> {
    if (this.describeError) {
      throw this.describeError;
    }
    return this.state;
  }

  async startInstance(): Promise<void> {
    this.state = { instanceId: this.state?.instanceId ?? "i-new", state: "running", publicIp: "198.51.100.5" };
  }

  async stopInstance(): Promise<void> {
    this.state = { instanceId: this.state?.instanceId ?? "i-new", state: "stopped" };
  }

  async terminateInstance(instanceId: string): Promise<void> {
    this.terminatedInstances.push(instanceId);
    if (this.terminateError) {
      throw this.terminateError;
    }
    this.state = { instanceId, state: "terminated" };
  }
}

function serviceWith(
  settings: FakeSettings,
  clients: Map<string, FakeEc2Client>
): CloudRunAwsService {
  return new CloudRunAwsService(settings as unknown as SettingsService, {
    createEc2Client: (credentials) => {
      const client = clients.get(credentials.accessKeyId);
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
    privateKeyPathForKeyName: (keyName) => `/keys/${keyName}.pem`
  });
}

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

test("deleteWorker clears settings but warns when termination fails", async () => {
  const settings = new FakeSettings();
  settings.credentials = OLD_CREDS;
  settings.handle = OLD_HANDLE;
  settings.mode = "aws";
  const oldClient = new FakeEc2Client({ instanceId: "i-old", state: "running", publicIp: "198.51.100.10" });
  oldClient.terminateError = new Error("AccessDenied");
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, oldClient]]));

  const status = await service.deleteWorker();
  assert.equal(status.configured, false);
  assert.match(status.message ?? "", /Settings cleared/);
  assert.match(status.message ?? "", /i-old may still exist/);
  assert.match(status.message ?? "", /EC2 console/);
  assert.equal(settings.credentials, undefined);
  assert.equal(settings.handle, undefined);
  assert.equal(settings.mode, "ssh");
});

test("ensureWorkerForRun resolves the SSH identity file from the persisted key name", async () => {
  const settings = new FakeSettings();
  settings.credentials = OLD_CREDS;
  settings.handle = OLD_HANDLE;
  settings.mode = "aws";
  const oldClient = new FakeEc2Client({ instanceId: "i-old", state: "running", publicIp: "198.51.100.10" });
  const service = serviceWith(settings, new Map([[OLD_CREDS.accessKeyId, oldClient]]));

  const worker = await service.ensureWorkerForRun();
  assert.equal(worker.host, "198.51.100.10");
  assert.equal(worker.identityFile, "/keys/accordagents-worker-old.pem");
  assert.deepEqual(oldClient.revokedSecurityGroups, ["sg-old"]);
  assert.deepEqual(oldClient.authorizedCidrs, ["203.0.113.9/32"]);
});
