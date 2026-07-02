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
  const manage = policy.Statement.find((statement) => statement.Sid === "ManageTaggedInstances");
  assert.ok(manage);
  assert.deepEqual(manage.Action.sort(), ["ec2:StartInstances", "ec2:StopInstances", "ec2:TerminateInstances"]);
  assert.equal(manage.Condition.StringEquals["aws:RequestedRegion"], "eu-west-1");
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
  const spec = buildWorkerInstanceSpec({ imageId: "ami-1", keyName: "k", securityGroupId: "sg-1" });
  assert.equal(spec.instanceType, "t3.small");
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
  revokedCount = 0;
  startCount = 0;
  stopCount = 0;

  constructor(initial?: Partial<AwsWorkerInstanceInfo>) {
    this.state = { instanceId: "i-123", state: "running", publicIp: "1.1.1.1", ...initial };
  }

  async resolveUbuntuImageId(): Promise<string> {
    return "ami-ubuntu";
  }
  async ensureKeyPair(): Promise<void> {}
  async ensureSecurityGroup(): Promise<string> {
    return "sg-123";
  }
  async authorizeSshIngress(_sg: string, cidr: string): Promise<void> {
    this.ingressCidrs.add(cidr);
  }
  async revokeAllSshIngress(): Promise<void> {
    this.revokedCount += 1;
    this.ingressCidrs.clear();
  }
  async runInstance(): Promise<string> {
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
  const handle = await lifecycleWith(client).createWorker(CREDS);
  assert.equal(handle.instanceId, "i-123");
  assert.equal(handle.securityGroupId, "sg-123");
  assert.ok(client.ingressCidrs.has("203.0.113.9/32"));
});

test("ensureRunning starts a stopped instance and rebuilds ingress to the current IP", async () => {
  const client = new FakeEc2Client({ state: "stopped", publicIp: undefined });
  const ip = await lifecycleWith(client).ensureRunning(CREDS, HANDLE);
  assert.equal(client.startCount, 1);
  assert.equal(ip, "2.2.2.2");
  assert.equal(client.revokedCount, 1);
  assert.deepEqual([...client.ingressCidrs], ["203.0.113.9/32"]);
});

test("ensureRunning on a running instance does not start again but still refreshes ingress", async () => {
  const client = new FakeEc2Client({ state: "running", publicIp: "5.5.5.5" });
  const ip = await lifecycleWith(client).ensureRunning(CREDS, HANDLE);
  assert.equal(client.startCount, 0);
  assert.equal(ip, "5.5.5.5");
  assert.equal(client.revokedCount, 1);
});

test("ensureRunning refuses a terminated instance", async () => {
  const client = new FakeEc2Client({ state: "terminated", publicIp: undefined });
  await assert.rejects(() => lifecycleWith(client).ensureRunning(CREDS, HANDLE), /no longer exists/);
});

test("idle auto-stop fires only after the last run ends and is cancelled by a new run", async () => {
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
  assert.equal(client.stopCount, 1);
  void timers;
});

test("deleteWorker terminates the instance", async () => {
  const client = new FakeEc2Client({ state: "running", publicIp: "1.1.1.1" });
  await lifecycleWith(client).deleteWorker(CREDS, HANDLE);
  assert.equal(client.state.state, "terminated");
});
