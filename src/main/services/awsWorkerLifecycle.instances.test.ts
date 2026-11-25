import assert from "node:assert/strict";
import test from "node:test";
import { AwsWorkerLifecycle } from "./awsWorkerLifecycle";
import type { AwsWorkerHandle, AwsWorkerInstanceInfo, Ec2Client } from "./awsWorkerLifecycle";
import { CREDS } from "./cloudRunAws/test/lifecycleFixtures";

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

test("a stop under way is waited for to its end: a stopped instance is started, one started meanwhile is not started again, one deleted fails at once", async () => {
  const waitingThrough = (client: FakeEc2Client, after: Partial<AwsWorkerInstanceInfo>) => lifecycleWith(client, {
    waitForState: async (poll: () => Promise<AwsWorkerInstanceInfo | undefined>, predicate: (info: AwsWorkerInstanceInfo | undefined) => boolean) => {
      if (client.state.state === "stopping") client.state = { ...client.state, ...after };
      const info = await poll();
      if (!predicate(info)) throw new Error("predicate not satisfied in test");
      return info;
    }
  });
  const stopped = new FakeEc2Client({ state: "stopping", publicIp: undefined });
  assert.equal((await waitingThrough(stopped, { state: "stopped" }).ensureRunning(CREDS, HANDLE)).publicIp, "2.2.2.2");
  assert.equal(stopped.startCount, 1);
  // The User's server started it again before a look saw it stopped.
  const restarted = new FakeEc2Client({ state: "stopping", publicIp: undefined });
  assert.equal((await waitingThrough(restarted, { state: "running", publicIp: "3.3.3.3" }).ensureRunning(CREDS, HANDLE)).publicIp, "3.3.3.3");
  assert.equal(restarted.startCount, 0);
  const deleted = new FakeEc2Client({ state: "stopping", publicIp: undefined });
  await assert.rejects(waitingThrough(deleted, { state: "terminated" }).ensureRunning(CREDS, HANDLE), /no longer exists/);
  assert.equal(deleted.startCount, 0);
});

test("without starting, a stopped instance is left stopped and a running one still gets this device's SSH access", async () => {
  const stopped = new FakeEc2Client({ state: "stopped", publicIp: undefined });
  await assert.rejects(lifecycleWith(stopped).ensureRunning(CREDS, HANDLE, "device", { start: false }), /is stopped, so nothing was started/);
  assert.equal(stopped.startCount, 0);
  const stopping = new FakeEc2Client({ state: "stopping", publicIp: undefined });
  await assert.rejects(lifecycleWith(stopping).ensureRunning(CREDS, HANDLE, "device", { start: false }), /is stopping/);
  assert.equal(stopping.startCount, 0, "a stop under way is not undone");
  const running = new FakeEc2Client({ state: "running", publicIp: "1.1.1.1" });
  const info = await lifecycleWith(running).ensureRunning(CREDS, HANDLE, "device", { start: false });
  assert.equal(info.publicIp, "1.1.1.1");
  assert.deepEqual([...running.ingressCidrs], ["203.0.113.9/32"], "a laptop on a new network can still reach the machine");
});

test("ensureRunning permits an EC2 root-volume state that is not known yet", async () => {
  const client = new FakeEc2Client({
    state: "running",
    publicIp: "1.1.1.1",
    rootVolumeBackedByEbs: undefined
  });
  const ip = await lifecycleWith(client).ensureRunning(CREDS, HANDLE);
  assert.equal(ip.publicIp, "1.1.1.1");
  assert.equal(client.revokedCount, 0);
});

test("ensureRunning rejects an explicitly instance-store-backed root volume", async () => {
  const client = new FakeEc2Client({
    state: "running",
    publicIp: "1.1.1.1",
    rootVolumeBackedByEbs: false
  });
  await assert.rejects(
    () => lifecycleWith(client).ensureRunning(CREDS, HANDLE),
    /not backed by persistent EBS storage/
  );
  assert.equal(client.revokedCount, 0);
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

test("shared workers stop only after the last local ref ends and the worker gate authorizes", async () => {
  const client = new FakeEc2Client({ state: "running", publicIp: "1.1.1.1" });
  const lifecycle = new AwsWorkerLifecycle({
    createEc2Client: () => client,
    generateKeyMaterial: async () => ({ keyName: "k", publicKeyOpenSsh: "x", privateKeyPath: "/tmp/k" }),
    currentPublicIp: async () => "203.0.113.9",
    idleStopMs: 15,
    authorizeAutomaticStop: async () => ({
      renew: async () => undefined,
      release: async () => undefined
    }),
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
});

test("automatic stop fails closed while worker work is registered, then retries once idle", async () => {
  const client = new FakeEc2Client({ state: "running", publicIp: "1.1.1.1" });
  let attempts = 0;
  const lifecycle = new AwsWorkerLifecycle({
    createEc2Client: () => client,
    generateKeyMaterial: async () => ({ keyName: "k", publicKeyOpenSsh: "x", privateKeyPath: "/tmp/k" }),
    currentPublicIp: async () => "203.0.113.9",
    idleStopMs: 10,
    idleStopRetryMs: 10,
    authorizeAutomaticStop: async () => {
      attempts += 1;
      return attempts === 1
        ? undefined
        : { renew: async () => undefined, release: async () => undefined };
    }
  });

  lifecycle.runStarted();
  lifecycle.runEnded(CREDS, HANDLE);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(client.stopCount, 0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(client.stopCount, 1);
  assert.equal(attempts, 2);
});

test("with automatic stop switched off this desktop neither stops the instance nor keeps asking", async () => {
  const client = new FakeEc2Client({ state: "running", publicIp: "1.1.1.1" });
  let enabled = false; let asked = 0; let authorized = 0;
  const lifecycle = new AwsWorkerLifecycle({
    createEc2Client: () => client,
    generateKeyMaterial: async () => ({ keyName: "k", publicKeyOpenSsh: "x", privateKeyPath: "/tmp/k" }),
    currentPublicIp: async () => "203.0.113.9",
    idleStopMs: 10,
    idleStopRetryMs: 10,
    automaticStopEnabled: async () => { asked++; return enabled; },
    authorizeAutomaticStop: async () => { authorized++; return { renew: async () => undefined, release: async () => undefined }; }
  });
  lifecycle.runStarted();
  lifecycle.runEnded(CREDS, HANDLE);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(client.stopCount, 0);
  assert.equal(asked, 1, "a switch left off is not polled every minute");
  assert.equal(authorized, 0);
  enabled = true;
  lifecycle.runStarted();
  lifecycle.runEnded(CREDS, HANDLE);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(client.stopCount, 1, "the next run that ends arms it again");
});

test("automatic stop releases its worker lease when a local run starts during authorization", async () => {
  const client = new FakeEc2Client({ state: "running", publicIp: "1.1.1.1" });
  let authorizationRequested = false;
  let authorize!: (value: { renew(): Promise<void>; release(): Promise<void> }) => void;
  const authorization = new Promise<{ renew(): Promise<void>; release(): Promise<void> }>((resolve) => {
    authorize = resolve;
  });
  let releases = 0;
  const lifecycle = lifecycleWith(client, {
    idleStopMs: 5,
    authorizeAutomaticStop: async () => {
      authorizationRequested = true;
      return authorization;
    }
  });

  lifecycle.runStarted();
  lifecycle.runEnded(CREDS, HANDLE);
  for (let attempt = 0; attempt < 20 && !authorizationRequested; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(authorizationRequested, true);
  lifecycle.runStarted();
  authorize({
    renew: async () => undefined,
    release: async () => { releases += 1; }
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(client.stopCount, 0);
  assert.equal(releases, 1);
});

test("automatic stop retains its drain lease until AWS reports the instance stopped", async () => {
  const client = new FakeEc2Client({ state: "running", publicIp: "1.1.1.1" });
  let finishStopping!: () => void;
  const stopping = new Promise<void>((resolve) => { finishStopping = resolve; });
  client.stopInstance = async () => {
    client.stopCount += 1;
    client.state = { ...client.state, state: "stopping" };
  };
  let releases = 0;
  const lifecycle = new AwsWorkerLifecycle({
    createEc2Client: () => client,
    generateKeyMaterial: async () => ({ keyName: "k", publicKeyOpenSsh: "x", privateKeyPath: "/tmp/k" }),
    currentPublicIp: async () => "203.0.113.9",
    idleStopMs: 5,
    authorizeAutomaticStop: async () => ({
      renew: async () => undefined,
      release: async () => { releases += 1; }
    }),
    waitForState: async (poll, predicate) => {
      let info = await poll();
      if (!predicate(info)) {
        await stopping;
        client.state = { ...client.state, state: "stopped", publicIp: undefined };
        info = await poll();
      }
      assert.equal(predicate(info), true);
      return info;
    }
  });

  lifecycle.runStarted();
  lifecycle.runEnded(CREDS, HANDLE);
  for (let attempt = 0; attempt < 50 && client.stopCount === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(client.stopCount, 1);
  assert.equal(client.state.state, "stopping");
  assert.equal(releases, 0);
  finishStopping();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(client.state.state, "stopped");
  assert.equal(releases, 0, "successful automatic stop keeps the durable drain marker for next-boot clearing");
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

test("deleteWorker of an instance AWS already says is gone terminates nothing and still cleans up", async () => {
  const client = new FakeEc2Client({ state: "terminated", publicIp: undefined });
  client.terminateError = Object.assign(new Error("You are not authorized to perform this operation."), { name: "UnauthorizedOperation" });
  const deletedLocalKeys: string[] = [];
  let waited = false;
  const result = await lifecycleWith(client, {
    deleteKeyMaterial: async (keyName: string) => { deletedLocalKeys.push(keyName); },
    waitForState: async () => { waited = true; return undefined; }
  }).deleteWorker(CREDS, HANDLE, { alreadyGone: true });
  assert.deepEqual(result, { terminationConfirmed: true, cleanupFailures: [] });
  assert.equal(waited, false, "nothing to wait for");
  assert.deepEqual(client.deletedKeyPairs, ["aa-key"]);
  assert.deepEqual(deletedLocalKeys, ["aa-key"]);
  assert.deepEqual(client.deletedSecurityGroups, ["sg-123"]);
});

test("deleteWorker retains every access resource when termination fails", async () => {
  const client = new FakeEc2Client({ state: "running", publicIp: "1.1.1.1" });
  client.terminateError = new Error("AccessDenied");
  const result = await lifecycleWith(client).deleteWorker(CREDS, HANDLE);
  assert.equal(result.terminateFailed, "AccessDenied");
  assert.equal(client.state.state, "running");
  assert.equal(result.terminationConfirmed, false);
  assert.deepEqual(client.deletedKeyPairs, []);
  assert.deepEqual(client.deletedSecurityGroups, []);
});

test("deleteWorker treats an unverified termination wait as fatal and skips cleanup", async () => {
  const client = new FakeEc2Client({ state: "running", publicIp: "1.1.1.1" });
  const result = await lifecycleWith(client, {
    waitForState: async () => { throw new Error("wait timed out"); }
  }).deleteWorker(CREDS, HANDLE);
  assert.equal(result.terminationConfirmed, false);
  assert.equal(result.terminateFailed, "wait timed out");
  assert.deepEqual(client.deletedKeyPairs, []);
  assert.deepEqual(client.deletedSecurityGroups, []);
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

test("a new machine gets a host key made here, known here under its name before anything connects", async () => {
  const { generateWorkerHostKey, pinWorkerHostKey, workerKnownHostsPath } = await import("./awsWorkerHostKeys");
  const { mkdtemp, readFile, rm, stat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const keyDir = await mkdtemp(path.join(tmpdir(), "aa-host-keys-"));
  try {
    const made = await generateWorkerHostKey();
    assert.match(made.publicKey, /^ssh-ed25519 /);
    assert.match(made.privateKey, /BEGIN OPENSSH PRIVATE KEY/);
    const client = new FakeEc2Client();
    // A real instance id (what the names are checked against).
    client.runInstance = async (spec) => { client.lastRunSpec = spec; return "i-0123456789abcdef0"; };
    const pinned: Array<[string, string]> = [];
    const handle = await lifecycleWith(client, {
      hostKey: { generate: async () => made, pin: async (alias: string, key: string) => { pinned.push([alias, key]); await pinWorkerHostKey(keyDir, alias, key); } }
    }).createWorker(CREDS);
    const cloudInit = Buffer.from(client.lastRunSpec!.userData, "base64").toString("utf8");
    assert.ok(cloudInit.includes("ssh_keys:") && cloudInit.includes(`  ed25519_public: ${made.publicKey}`), "the machine is given the key at first boot");
    assert.ok(cloudInit.includes("    -----BEGIN OPENSSH PRIVATE KEY-----"));
    assert.deepEqual(pinned, [[`accordagents-${handle.instanceId}`, made.publicKey]], "known under the name every connection uses");
    const line = (await readFile(workerKnownHostsPath(keyDir), "utf8")).trim();
    assert.equal(line, `accordagents-${handle.instanceId} ${made.publicKey.split(" ").slice(0, 2).join(" ")}`);
    assert.equal((await stat(workerKnownHostsPath(keyDir))).mode & 0o777, 0o600);
    // A machine made again under the same name replaces its line; others stay.
    await pinWorkerHostKey(keyDir, "accordagents-i-0fedcba987654321", made.publicKey);
    await pinWorkerHostKey(keyDir, `accordagents-${handle.instanceId}`, "ssh-ed25519 AAAAnew");
    assert.deepEqual((await readFile(workerKnownHostsPath(keyDir), "utf8")).trim().split("\n").map((item) => item.split(" ")[0]).sort(),
      [`accordagents-${handle.instanceId}`, "accordagents-i-0fedcba987654321"].sort());
    await assert.rejects(() => pinWorkerHostKey(keyDir, "../../etc", made.publicKey));
    await assert.rejects(() => pinWorkerHostKey(keyDir, "accordagents-i-0fedcba987654321", "ssh-ed25519 AAAA\nevil"));
  } finally {
    await rm(keyDir, { recursive: true, force: true });
  }
});

test("a machine made without a host key (a test, or before) launches as before", async () => {
  const client = new FakeEc2Client();
  await lifecycleWith(client).createWorker(CREDS);
  assert.ok(!Buffer.from(client.lastRunSpec!.userData, "base64").toString("utf8").includes("ssh_keys:"));
});

test("connections to a machine this app made read the app's known hosts first; others are as before", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { createHeadlessPlatform, setHostPlatform } = await import("../platform");
  const { cloudRunSshOptionArgs } = await import("./cloudRunWorkers");
  const userData = await mkdtemp(path.join(tmpdir(), "aa user data "));
  try {
    setHostPlatform(createHeadlessPlatform({ userDataDir: userData, appVersion: "test" }));
    const made = cloudRunSshOptionArgs({ host: "1.2.3.4", hostKeyAlias: "accordagents-i-0123456789abcdef0" });
    const known = made[made.indexOf("HostKeyAlias=accordagents-i-0123456789abcdef0") + 2];
    assert.equal(known, `UserKnownHostsFile="${path.join(userData, "cloud-runs-keys", "known_hosts").replace(/\\/g, "\\\\")}" ~/.ssh/known_hosts`);
    assert.ok(made.includes("StrictHostKeyChecking=accept-new"), "a machine made before still connects as it did");
    const other = cloudRunSshOptionArgs({ host: "1.2.3.4", hostKeyAlias: "my-own-box" });
    assert.ok(!other.some((arg) => arg.startsWith("UserKnownHostsFile=")), "a machine the User set up herself is as before");
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

test("a Windows connection asks for no shared connection: Windows OpenSSH exits at once when it is asked for one", async () => {
  const { cloudRunSshOptionArgs } = await import("./cloudRunWorkers");
  const args = cloudRunSshOptionArgs({ host: "1.2.3.4", user: "ubuntu", identityFile: "C:\\Users\\a b\\key.pem" }, "win32");
  assert.ok(!args.some((arg) => /^Control(Master|Path|Persist)=/.test(arg)), args.join(" "));
  assert.deepEqual(args.slice(args.indexOf("-i"), args.indexOf("-i") + 2), ["-i", "C:\\Users\\a b\\key.pem"]);
});
