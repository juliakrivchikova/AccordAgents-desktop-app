import assert from "node:assert/strict";
import test from "node:test";
import type { AwsWorkerHandleInfo, AwsWorkerOperationSnapshot, AwsWorkerSpec } from "../../shared/types";
import type { SettingsService } from "./settings";
import type { Ec2Client, AwsWorkerInstanceInfo } from "./awsWorkerLifecycle";
import { CloudRunAwsService } from "./cloudRunAws";
import { AwsWorkerSetupService } from "./awsWorkerSetup";
import type { CloudRunDoctorService } from "./cloudRunDoctor";

const HANDLE: AwsWorkerHandleInfo = {
  instanceId: "i-kept", region: "us-east-1", securityGroupId: "sg-test", keyName: "saved-key",
  instanceType: "t3.small", rootVolumeSizeGb: 40, createdAt: "2026-09-13T00:00:00Z"
};

function harness() {
  let operation: AwsWorkerOperationSnapshot | undefined;
  let savedSize: Partial<AwsWorkerSpec> | undefined;
  let handle: AwsWorkerHandleInfo | undefined = HANDLE;
  let info: AwsWorkerInstanceInfo | undefined = { ...HANDLE, state: "stopped", publicIp: "192.0.2.7", rootVolumeId: "vol-test" };
  let failure: Error | undefined;
  let saveFailure: Error | undefined;
  const touched: string[] = [];
  // A real interrupted growth exists. An innocent read must not resume it.
  const expansion = { instanceId: HANDLE.instanceId, volumeId: "vol-test", targetSizeGb: 80, updatedAt: "2026-09-12T00:00:00Z" };
  const forbidden = (name: string): never => { touched.push(name); throw new Error(`unexpected mutation: ${name}`); };
  const settings = {
    getPublicSettings: async () => ({ cloudRuns: { mode: "aws", awsHandle: handle, awsInstanceType: "t3.medium", awsRootVolumeSizeGb: 80 } }),
    getAwsWorkerCredentials: async () => ({ accessKeyId: "synthetic", secretAccessKey: "synthetic", region: "us-east-1" }),
    getAwsWorkerOperation: async () => operation,
    saveAwsWorkerOperation: async (next: AwsWorkerOperationSnapshot) => { operation = next; },
    getAwsWorkerVolumeExpansion: async () => expansion,
    saveAwsWorkerVolumeExpansion: async () => forbidden("save-expansion"),
    saveCloudRunsSettings: async (next: Partial<AwsWorkerSpec> & { awsInstanceType?: string; awsRootVolumeSizeGb?: number }) => {
      if (saveFailure) throw saveFailure;
      savedSize = { instanceType: next.awsInstanceType, rootVolumeSizeGb: next.awsRootVolumeSizeGb };
    },
    getCloudRunsDeviceId: async () => "home-laptop"
  };
  const client = new Proxy({
    describeInstance: async () => { touched.push("describe"); if (failure) throw failure; return info; }
  }, { get: (target, key) => key in target ? target[key as keyof typeof target] : () => forbidden(String(key)) });
  const aws = new CloudRunAwsService(settings as unknown as SettingsService, {
    createEc2Client: () => client as unknown as Ec2Client,
    generateKeyMaterial: async () => forbidden("generate-key"),
    privateKeyPathForKeyName: name => `/keys/${name}`,
    sshExec: async () => forbidden("ssh-mutation")
  });
  const setup = new AwsWorkerSetupService(aws, new Proxy({}, { get: (_target, key) => () => forbidden(`doctor-${String(key)}`) }) as CloudRunDoctorService, settings as unknown as SettingsService);
  return { aws, setup, touched, expansion, savedSize: () => savedSize, operation: () => operation,
    setInfo: (next: typeof info) => { info = next; }, setHandle: (next: typeof handle) => { handle = next; },
    failSave: (next?: Error) => { saveFailure = next; },
    fail: (next: Error) => { failure = next; } };
}

test("Keep current size reads the real stopped instance and never resumes a saved disk expansion", async () => {
  const h = harness();
  const result = await h.setup.start({ operationId: "keep", intent: "resize", resolution: "keep",
    expectedInstanceId: HANDLE.instanceId, instanceType: "t3.medium", rootVolumeSizeGb: 80 });
  assert.equal(result.operation.phase, "ready");
  assert.equal(result.status.state, "stopped");
  assert.deepEqual(h.savedSize(), { instanceType: "t3.small", rootVolumeSizeGb: 40 });
  assert.deepEqual(h.touched, ["describe", "describe"]);
  assert.equal(h.expansion.targetSizeGb, 80, "the pending expansion is retained for its explicit retry");
});

test("Keep refuses a replaced, absent or unreadable instance without changing the saved size", async () => {
  for (const state of ["replaced", "absent", "denied"] as const) {
    const h = harness();
    if (state === "replaced") h.setHandle({ ...HANDLE, instanceId: "i-other" });
    if (state === "absent") h.setInfo(undefined);
    if (state === "denied") h.fail(Object.assign(new Error("ec2:DescribeInstances denied"), { name: "UnauthorizedOperation" }));
    const result = await h.setup.start({ operationId: state, intent: "resize", resolution: "keep", expectedInstanceId: HANDLE.instanceId });
    assert.equal(result.operation.phase, "error", state);
    assert.equal(h.savedSize(), undefined, state);
    assert.ok(h.touched.every(call => call === "describe"), state);
  }
});

test("diagnostics reject every non-running state without starting, provisioning or growing a disk", async () => {
  for (const state of ["stopped", "stopping", "pending", "terminated", "absent"] as const) {
    const h = harness();
    h.setInfo({ ...HANDLE, state });
    await assert.rejects(h.aws.workerForInspection(), /Start the instance|no longer available/, state);
    assert.deepEqual(h.touched, ["describe"]);
    assert.equal(h.savedSize(), undefined);
  }
  const unconfigured = harness();
  unconfigured.setHandle(undefined);
  await assert.rejects(unconfigured.aws.workerForInspection(), /not configured/);
  assert.deepEqual(unconfigured.touched, []);
});

test("diagnostics use the current address and saved key, never an access-enrollment or run lifecycle", async () => {
  const h = harness();
  h.setInfo({ ...HANDLE, state: "running", publicIp: "192.0.2.8" });
  const worker = await h.aws.workerForInspection();
  assert.equal(worker.host, "192.0.2.8");
  assert.equal(worker.identityFile, "/keys/saved-key");
  assert.equal(worker.hostKeyAlias, "accordagents-i-kept");
  assert.deepEqual(h.touched, ["describe"]);
  assert.equal(h.savedSize(), undefined);
});

test("a diagnostic access refusal propagates without replacing credentials or starting anything", async () => {
  const h = harness();
  const error = Object.assign(new Error("AccessDenied"), { name: "UnauthorizedOperation" });
  h.fail(error);
  await assert.rejects(h.aws.workerForInspection(), cause => cause === error);
  assert.deepEqual(h.touched, ["describe"]);
});

test("a running instance without an address is not told to start again", async () => {
  const h = harness();
  h.setInfo({ ...HANDLE, state: "running" });
  await assert.rejects(h.aws.workerForInspection(), /No public IP address/);
  assert.deepEqual(h.touched, ["describe"]);
});

test("a failed local size save is reported as failed and a later explicit retry can succeed", async () => {
  const h = harness();
  h.failSave(new Error("ENOSPC"));
  const request = { operationId: "keep", intent: "resize" as const, resolution: "keep" as const, expectedInstanceId: HANDLE.instanceId };
  const failed = await h.setup.start(request);
  assert.equal(failed.operation.phase, "error");
  assert.match(failed.operation.message, /ENOSPC/);
  assert.equal(h.savedSize(), undefined);
  h.failSave();
  assert.equal((await h.setup.start(request)).operation.phase, "ready");
  assert.ok(h.touched.every(call => call === "describe"));
});
