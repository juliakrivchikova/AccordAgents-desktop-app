import assert from "node:assert/strict";
import test from "node:test";
import {
  AWS_WORKER_BLOB_PREFIX,
  AWS_WORKER_TAG_KEY,
  buildBootstrapCommand,
  buildScopedWorkerPolicy,
  buildWorkerCloudInit,
  buildWorkerInstanceSpec,
  encodeWorkerBlob,
  ipToCidr,
  parseWorkerBlob
} from "./awsWorkerProvisioning";
import { AwsWorkerLifecycle } from "./awsWorkerLifecycle";
import type { AwsWorkerHandle, AwsWorkerInstanceInfo, Ec2Client } from "./awsWorkerLifecycle";

const CREDS = { accessKeyId: "AKIAEXAMPLE0001XYZ", secretAccessKey: "secretzzz", region: "us-east-1" };

test("worker blob round-trips and validates", () => {
  const blob = encodeWorkerBlob(CREDS);
  assert.ok(blob.startsWith(AWS_WORKER_BLOB_PREFIX));
  assert.deepEqual(parseWorkerBlob(blob), CREDS);
  assert.deepEqual(parseWorkerBlob(blob.slice(AWS_WORKER_BLOB_PREFIX.length)), CREDS);
});

test("worker blob rejects malformed or incomplete input", () => {
  assert.throws(() => parseWorkerBlob("not-base64!!!"), /not valid|missing/);
  const missing = `${AWS_WORKER_BLOB_PREFIX}${Buffer.from(JSON.stringify({ region: "us-east-1" })).toString("base64")}`;
  assert.throws(() => parseWorkerBlob(missing), /missing required fields/);
  const badKey = `${AWS_WORKER_BLOB_PREFIX}${Buffer.from(JSON.stringify({ accessKeyId: "nope", secretAccessKey: "s", region: "us-east-1" })).toString("base64")}`;
  assert.throws(() => parseWorkerBlob(badKey), /access key/);
});

test("scoped policy limits state changes to tagged instances in-region", () => {
  const policy = buildScopedWorkerPolicy("eu-west-1") as {
    Statement: Array<{ Sid: string; Action: string[]; Condition: Record<string, Record<string, string>> }>;
  };
  const create = policy.Statement.find((statement) => statement.Sid === "CreateInfra");
  assert.ok(create);
  assert.ok(create.Action.includes("ec2:DeleteKeyPair"));
  assert.ok(create.Action.includes("ec2:RunInstances"));
  const manage = policy.Statement.find((statement) => statement.Sid === "ManageTaggedInstances");
  assert.ok(manage);
  assert.deepEqual(manage.Action.sort(), ["ec2:StartInstances", "ec2:StopInstances", "ec2:TerminateInstances"]);
  assert.equal(manage.Condition.StringEquals[`ec2:ResourceTag/${AWS_WORKER_TAG_KEY}`], "1");
});

test("bootstrap command creates a scoped user and prints a paste blob", () => {
  const command = buildBootstrapCommand("us-east-1", "abc123");
  assert.match(command, /aws iam create-user --user-name "\$USER"/);
  assert.match(command, /aws iam put-user-policy/);
  assert.match(command, /aws iam create-access-key/);
  assert.match(command, /accordagents-worker-abc123/);
  assert.match(command, new RegExp(AWS_WORKER_BLOB_PREFIX));
  assert.throws(() => buildBootstrapCommand("us-east-1", "bad;rm -rf"), /Invalid suffix/);
});

test("cloud-init and instance spec carry the toolchain and tag", () => {
  const init = buildWorkerCloudInit();
  assert.match(init, /@openai\/codex/);
  assert.match(init, /apparmor_restrict_unprivileged_userns=0/);
  const spec = buildWorkerInstanceSpec({ imageId: "ami-1", rootDeviceName: "/dev/sda1", keyName: "k", securityGroupId: "sg-1" });
  assert.equal(spec.instanceType, "t3.small");
  assert.equal(spec.rootVolumeSizeGb, 8);
  assert.equal(
    buildWorkerInstanceSpec({
      imageId: "ami-1",
      rootDeviceName: "/dev/sda1",
      keyName: "k",
      securityGroupId: "sg-1",
      rootVolumeSizeGb: 64
    }).rootVolumeSizeGb,
    64
  );
  assert.equal(spec.tagKey, AWS_WORKER_TAG_KEY);
  assert.equal(Buffer.from(spec.userData, "base64").toString("utf8"), init);
});

test("ipToCidr validates and appends /32", () => {
  assert.equal(ipToCidr("203.0.113.4"), "203.0.113.4/32");
  assert.throws(() => ipToCidr("999.1.1.1"), /valid IPv4/);
  assert.throws(() => ipToCidr("not-an-ip"), /valid IPv4/);
});

class FakeEc2Client implements Ec2Client {
  state: AwsWorkerInstanceInfo;
  readonly ingressCidrs = new Set<string>();
  readonly keyPairs = new Set<string>();
  readonly importedKeyPairs: string[] = [];
  readonly deletedKeyPairs: string[] = [];
  readonly securityGroupNames: string[] = [];
  readonly deletedSecurityGroups: string[] = [];
  readonly revokedSecurityGroups: string[] = [];
  readonly authorizedSecurityGroups: string[] = [];
  lastRunSpec: Parameters<Ec2Client["runInstance"]>[0] | undefined;
  terminateError: Error | undefined;
  revokedCount = 0;
  startCount = 0;
  stopCount = 0;

  constructor(initial?: Partial<AwsWorkerInstanceInfo>) {
    this.state = { instanceId: "i-123", state: "running", publicIp: "1.1.1.1", ...initial };
  }

  async resolveUbuntuImage(): Promise<{ imageId: string; rootDeviceName: string }> {
    return { imageId: "ami-ubuntu", rootDeviceName: "/dev/sda1" };
  }
  async keyPairExists(name: string): Promise<boolean> {
    return this.keyPairs.has(name);
  }
  async importKeyPair(name: string): Promise<void> {
    this.importedKeyPairs.push(name);
    this.keyPairs.add(name);
  }
  async deleteKeyPair(name: string): Promise<void> {
    this.deletedKeyPairs.push(name);
    this.keyPairs.delete(name);
  }
  async ensureSecurityGroup(name: string): Promise<string> {
    this.securityGroupNames.push(name);
    return "sg-123";
  }
  async deleteSecurityGroup(securityGroupId: string): Promise<void> {
    this.deletedSecurityGroups.push(securityGroupId);
  }
  async authorizeSshIngress(sg: string, cidr: string): Promise<void> {
    this.authorizedSecurityGroups.push(sg);
    this.ingressCidrs.add(cidr);
  }
  async revokeAllSshIngress(securityGroupId: string): Promise<void> {
    this.revokedSecurityGroups.push(securityGroupId);
    this.revokedCount += 1;
    this.ingressCidrs.clear();
  }
  async runInstance(spec: Parameters<Ec2Client["runInstance"]>[0]): Promise<string> {
    this.lastRunSpec = spec;
    return "i-123";
  }
  async describeInstance(): Promise<AwsWorkerInstanceInfo | undefined> {
    return this.state;
  }
  async startInstance(): Promise<void> {
    this.startCount += 1;
    this.state = { ...this.state, state: "running", publicIp: "2.2.2.2" };
  }
  async stopInstance(): Promise<void> {
    this.stopCount += 1;
    this.state = { ...this.state, state: "stopped", publicIp: undefined };
  }
  async terminateInstance(): Promise<void> {
    if (this.terminateError) {
      throw this.terminateError;
    }
    this.state = { ...this.state, state: "terminated", publicIp: undefined };
  }
}

function lifecycleWith(client: FakeEc2Client, overrides = {}): AwsWorkerLifecycle {
  return new AwsWorkerLifecycle({
    createEc2Client: () => client,
    generateKeyMaterial: async () => ({ keyName: "aa-key", publicKeyOpenSsh: "ssh-ed25519 AAAA", privateKeyPath: "/tmp/aa-key" }),
    currentPublicIp: async () => "203.0.113.9",
    waitForState: async (poll, predicate) => {
      const info = await poll();
      if (!predicate(info)) {
        throw new Error("predicate not satisfied in test");
      }
      return info;
    },
    ...overrides
  });
}

const HANDLE: AwsWorkerHandle = {
  instanceId: "i-123",
  securityGroupId: "sg-123",
  keyName: "aa-key",
  privateKeyPath: "/tmp/aa-key",
  region: "us-east-1"
};

test("createWorker provisions key, security group, ingress and instance", async () => {
  const client = new FakeEc2Client();
  const handle = await lifecycleWith(client).createWorker(CREDS, { rootVolumeSizeGb: 64 });
  assert.equal(handle.instanceId, "i-123");
  assert.equal(handle.securityGroupId, "sg-123");
  assert.deepEqual(client.importedKeyPairs, ["aa-key"]);
  assert.deepEqual(client.securityGroupNames, ["aa-key-sg"]);
  assert.equal(client.lastRunSpec?.keyName, "aa-key");
  assert.ok(client.ingressCidrs.has("203.0.113.9/32"));
  assert.equal(client.lastRunSpec?.rootDeviceName, "/dev/sda1");
  assert.equal(client.lastRunSpec?.rootVolumeSizeGb, 64);
});

test("createWorker reuses an existing local/AWS key without re-importing it", async () => {
  const client = new FakeEc2Client();
  client.keyPairs.add("aa-key");
  await lifecycleWith(client, {
    generateKeyMaterial: async () => ({ keyName: "aa-key", publicKeyOpenSsh: "ssh-ed25519 AAAA", privateKeyPath: "/tmp/aa-key", reused: true })
  }).createWorker(CREDS);
  assert.deepEqual(client.importedKeyPairs, []);
});

test("createWorker rotates fresh key material when AWS reports a duplicate key pair", async () => {
  const client = new FakeEc2Client();
  const deletedLocalKeys: string[] = [];
  const keys = [
    { keyName: "accordagents-worker-dup", publicKeyOpenSsh: "ssh-ed25519 AAAA", privateKeyPath: "/tmp/dup", reused: false },
    { keyName: "accordagents-worker-new", publicKeyOpenSsh: "ssh-ed25519 BBBB", privateKeyPath: "/tmp/new", reused: false }
  ];
  client.importKeyPair = async (name: string): Promise<void> => {
    client.importedKeyPairs.push(name);
    if (name === "accordagents-worker-dup") {
      const error = new Error("duplicate") as Error & { name: string };
      error.name = "InvalidKeyPair.Duplicate";
      throw error;
    }
    client.keyPairs.add(name);
  };
  const handle = await lifecycleWith(client, {
    generateKeyMaterial: async (options?: { rotate?: boolean }) => keys[options?.rotate ? 1 : 0],
    deleteKeyMaterial: async (keyName: string) => {
      deletedLocalKeys.push(keyName);
    }
  }).createWorker(CREDS);
  assert.equal(handle.keyName, "accordagents-worker-new");
  assert.deepEqual(client.importedKeyPairs, ["accordagents-worker-dup", "accordagents-worker-new"]);
  assert.deepEqual(deletedLocalKeys, ["accordagents-worker-dup"]);
});

test("ensureRunning starts a stopped instance and rebuilds ingress to the current IP", async () => {
  const client = new FakeEc2Client({ state: "stopped", publicIp: undefined });
  const info = await lifecycleWith(client).ensureRunning(CREDS, HANDLE);
  assert.equal(client.startCount, 1);
  assert.equal(info.publicIp, "2.2.2.2");
  assert.equal(client.revokedCount, 0);
  assert.deepEqual(client.revokedSecurityGroups, []);
  assert.deepEqual([...client.ingressCidrs], ["203.0.113.9/32"]);
});

test("ensureRunning on a running instance does not start again but still refreshes ingress", async () => {
  const client = new FakeEc2Client({ state: "running", publicIp: "5.5.5.5" });
  const info = await lifecycleWith(client).ensureRunning(CREDS, HANDLE);
  assert.equal(client.startCount, 0);
  assert.equal(info.publicIp, "5.5.5.5");
  assert.equal(client.revokedCount, 0);
});

test("ensureRunning refuses a terminated instance", async () => {
  const client = new FakeEc2Client({ state: "terminated", publicIp: undefined });
  await assert.rejects(() => lifecycleWith(client).ensureRunning(CREDS, HANDLE), /no longer exists/);
});

test("shared workers are never auto-stopped from per-process idle state", async () => {
  const client = new FakeEc2Client({ state: "running", publicIp: "1.1.1.1" });
  const timers: Array<() => void> = [];
  const lifecycle = new AwsWorkerLifecycle({
    createEc2Client: () => client,
    generateKeyMaterial: async () => ({ keyName: "k", publicKeyOpenSsh: "x", privateKeyPath: "/tmp/k" }),
    currentPublicIp: async () => "203.0.113.9",
    idleStopMs: 15,
    now: () => 0
  });
  // Two overlapping runs: the first ending must NOT stop the instance.
  lifecycle.runStarted();
  lifecycle.runStarted();
  lifecycle.runEnded(CREDS, HANDLE);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(client.stopCount, 0);
  // A new run cancels any pending idle timer.
  lifecycle.runStarted();
  lifecycle.runEnded(CREDS, HANDLE);
  // Last run ends → idle timer stops it.
  lifecycle.runEnded(CREDS, HANDLE);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(client.stopCount, 0);
  void timers;
});

test("deleteWorker terminates the instance and cleans up key material and security group", async () => {
  const client = new FakeEc2Client({ state: "running", publicIp: "1.1.1.1" });
  const deletedLocalKeys: string[] = [];
  await lifecycleWith(client, {
    deleteKeyMaterial: async (keyName: string) => {
      deletedLocalKeys.push(keyName);
    }
  }).deleteWorker(CREDS, HANDLE);
  assert.equal(client.state.state, "terminated");
  assert.deepEqual(client.deletedKeyPairs, ["aa-key"]);
  assert.deepEqual(deletedLocalKeys, ["aa-key"]);
  assert.deepEqual(client.deletedSecurityGroups, ["sg-123"]);
});

test("deleteWorker reports terminate failure but still attempts cleanup", async () => {
  const client = new FakeEc2Client({ state: "running", publicIp: "1.1.1.1" });
  client.terminateError = new Error("AccessDenied");
  const result = await lifecycleWith(client).deleteWorker(CREDS, HANDLE);
  assert.equal(result.terminateFailed, "AccessDenied");
  assert.equal(client.state.state, "running");
  assert.deepEqual(client.deletedKeyPairs, ["aa-key"]);
  assert.deepEqual(client.deletedSecurityGroups, ["sg-123"]);
});

test("deleteWorker waits up to three minutes before first security group cleanup", async () => {
  const client = new FakeEc2Client({ state: "running", publicIp: "1.1.1.1" });
  let observedTimeout = 0;
  await lifecycleWith(client, {
    waitForState: async (_poll: () => Promise<AwsWorkerInstanceInfo | undefined>, _predicate: (info: AwsWorkerInstanceInfo | undefined) => boolean, timeoutMs: number) => {
      observedTimeout = timeoutMs;
      return { instanceId: "i-123", state: "terminated" };
    }
  }).deleteWorker(CREDS, HANDLE);
  assert.equal(observedTimeout, 3 * 60_000);
});

test("stopWorker stops a running instance without terminating it", async () => {
  const client = new FakeEc2Client({ state: "running", publicIp: "1.1.1.1" });
  await lifecycleWith(client).stopWorker(CREDS, HANDLE);
  assert.equal(client.stopCount, 1);
  assert.equal(client.state.state, "stopped");
});

test("stopWorker is a no-op for an already stopped instance", async () => {
  const client = new FakeEc2Client({ state: "stopped", publicIp: undefined });
  await lifecycleWith(client).stopWorker(CREDS, HANDLE);
  assert.equal(client.stopCount, 0);
  assert.equal(client.state.state, "stopped");
});
