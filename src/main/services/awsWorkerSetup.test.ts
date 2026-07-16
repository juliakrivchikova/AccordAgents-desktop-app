import assert from "node:assert/strict";
import test from "node:test";
import type { AwsWorkerOperationSnapshot, AwsWorkerStatus } from "../../shared/types";
import { AwsWorkerSetupService } from "./awsWorkerSetup";
import type { PreparedAwsWorker } from "./cloudRunAws";

const PREPARED: PreparedAwsWorker = {
  credentials: { accessKeyId: "AKIAEXAMPLE0001XYZ", secretAccessKey: "secret", region: "us-east-1" },
  handle: {
    instanceId: "i-shared", securityGroupId: "sg-1", keyName: "key", region: "us-east-1",
    instanceType: "t3.small", rootVolumeSizeGb: 8, createdAt: "2026-01-01T00:00:00.000Z"
  },
  info: { instanceId: "i-shared", state: "running", publicIp: "198.51.100.10" },
  actualSpec: { instanceId: "i-shared", region: "us-east-1", instanceType: "t3.small", rootVolumeSizeGb: 8 },
  desiredSpec: { instanceType: "t3.small", rootVolumeSizeGb: 8 },
  created: false
};

test("start orchestrates the exact visible phases and reaches ready", async () => {
  const saved: AwsWorkerOperationSnapshot[] = [];
  const phases: string[] = [];
  const status: AwsWorkerStatus = { configured: true, state: "running", handle: PREPARED.handle };
  const aws = {
    prepareWorker: async () => ({ ...PREPARED }),
    resumePendingVolumeExpansion: async (prepared: PreparedAwsWorker) => prepared,
    hasAcceptedMismatch: async () => false,
    ensurePreparedRunning: async () => ({ host: "198.51.100.10" }),
    status: async () => status
  };
  const doctor = {
    waitForCloudInit: async () => undefined,
    setup: async () => ({ ok: true, message: "Worker ready.", checks: [] })
  };
  const settings = {
    saveAwsWorkerOperation: async (operation: AwsWorkerOperationSnapshot) => { saved.push(operation); },
    getAwsWorkerOperation: async () => undefined
  };
  const service = new AwsWorkerSetupService(aws as any, doctor as any, settings as any);
  const result = await service.start({ operationId: "op-1" }, (operation) => phases.push(operation.phase));
  assert.deepEqual(phases, ["starting", "waiting-running", "setting-up", "ready"]);
  assert.equal(result.operation.phase, "ready");
  assert.equal(saved.at(-1)?.phase, "ready");
});

test("undersized adopted worker stops before running until the user decides", async () => {
  let ensureCalls = 0;
  const mismatch = {
    instanceId: "i-shared",
    actual: PREPARED.actualSpec,
    desired: { instanceType: "t3.medium", rootVolumeSizeGb: 16 },
    diskTooSmall: true,
    computeTooSmall: true
  };
  const aws = {
    prepareWorker: async () => ({ ...PREPARED, mismatch }),
    resumePendingVolumeExpansion: async (prepared: PreparedAwsWorker) => prepared,
    hasAcceptedMismatch: async () => false,
    ensurePreparedRunning: async () => { ensureCalls += 1; return { host: "x" }; },
    status: async () => ({ configured: true })
  };
  const settings = { saveAwsWorkerOperation: async () => undefined, getAwsWorkerOperation: async () => undefined };
  const service = new AwsWorkerSetupService(aws as any, {} as any, settings as any);
  const result = await service.start({ operationId: "op-2" });
  assert.equal(result.operation.phase, "needs-decision");
  assert.equal(result.operation.specMismatch?.diskTooSmall, true);
  assert.equal(ensureCalls, 0);
});

test("retry reuses the persisted provisioning token", async () => {
  let snapshot: AwsWorkerOperationSnapshot | undefined;
  let attempts = 0;
  const tokens: string[] = [];
  const aws = {
    prepareWorker: async (request: { clientToken: string }) => {
      attempts += 1;
      tokens.push(request.clientToken);
      if (attempts === 1) throw new Error("ambiguous launch response");
      return { ...PREPARED };
    },
    resumePendingVolumeExpansion: async (prepared: PreparedAwsWorker) => prepared,
    hasAcceptedMismatch: async () => false,
    ensurePreparedRunning: async () => ({ host: "198.51.100.10" }),
    status: async () => ({ configured: attempts > 1 })
  };
  const doctor = {
    waitForCloudInit: async () => undefined,
    setup: async () => ({ ok: true, message: "Worker ready.", checks: [] })
  };
  const settings = {
    saveAwsWorkerOperation: async (operation: AwsWorkerOperationSnapshot) => { snapshot = operation; },
    getAwsWorkerOperation: async () => snapshot
  };
  const service = new AwsWorkerSetupService(aws as any, doctor as any, settings as any);
  const first = await service.start({ operationId: "op-stable", clientToken: "token-stable" });
  assert.equal(first.operation.phase, "error");
  const second = await service.start({ operationId: "op-stable" });
  assert.equal(second.operation.phase, "ready");
  assert.deepEqual(tokens, ["token-stable", "token-stable"]);
});

test("DescribeRegions authorization denial requests an AWS authorization refresh", async () => {
  let snapshot: AwsWorkerOperationSnapshot | undefined;
  let attempts = 0;
  const tokens: string[] = [];
  const aws = {
    prepareWorker: async (request: { clientToken: string }) => {
      attempts += 1;
      tokens.push(request.clientToken);
      if (attempts === 1) {
        throw new Error("User is not authorized to perform: ec2:DescribeRegions because no identity-based policy allows the ec2:DescribeRegions action");
      }
      return { ...PREPARED };
    },
    resumePendingVolumeExpansion: async (prepared: PreparedAwsWorker) => prepared,
    hasAcceptedMismatch: async () => false,
    ensurePreparedRunning: async () => ({ host: "198.51.100.10" }),
    status: async () => ({ configured: true, state: "running" })
  };
  const doctor = {
    waitForCloudInit: async () => undefined,
    setup: async () => ({ ok: true, message: "Worker ready.", checks: [] })
  };
  const settings = {
    saveAwsWorkerOperation: async (operation: AwsWorkerOperationSnapshot) => { snapshot = operation; },
    getAwsWorkerOperation: async () => snapshot
  };
  const service = new AwsWorkerSetupService(aws as any, doctor as any, settings as any);
  const failed = await service.start({ operationId: "op-auth", clientToken: "token-auth" });
  assert.equal(failed.operation.phase, "error");
  assert.equal(failed.operation.remediation, "refresh-aws-authorization");
  assert.match(failed.operation.message, /Update AWS permissions/);
  const recovered = await service.start({ operationId: "op-auth" });
  assert.equal(recovered.operation.phase, "ready");
  assert.deepEqual(tokens, ["token-auth", "token-auth"]);
});

test("non-authorization setup failures do not request an AWS authorization refresh", async () => {
  const aws = {
    prepareWorker: async () => { throw new Error("EC2 capacity is unavailable"); },
    status: async () => ({ configured: false })
  };
  const settings = {
    saveAwsWorkerOperation: async () => undefined,
    getAwsWorkerOperation: async () => undefined
  };
  const service = new AwsWorkerSetupService(aws as any, {} as any, settings as any);
  const failed = await service.start({ operationId: "op-capacity" });
  assert.equal(failed.operation.remediation, undefined);
  assert.match(failed.operation.message, /capacity/);
});

test("doctor access failures do not request an AWS authorization refresh", async () => {
  const aws = {
    prepareWorker: async () => ({ ...PREPARED }),
    resumePendingVolumeExpansion: async (prepared: PreparedAwsWorker) => prepared,
    hasAcceptedMismatch: async () => false,
    ensurePreparedRunning: async () => ({ host: "198.51.100.10" }),
    status: async () => ({ configured: true, state: "running" })
  };
  const doctor = {
    waitForCloudInit: async () => undefined,
    setup: async () => { throw new Error("GitHub API returned 403 access denied"); }
  };
  const settings = {
    saveAwsWorkerOperation: async () => undefined,
    getAwsWorkerOperation: async () => undefined
  };
  const service = new AwsWorkerSetupService(aws as any, doctor as any, settings as any);
  const failed = await service.start({ operationId: "op-doctor-access" });
  assert.equal(failed.operation.phase, "error");
  assert.equal(failed.operation.remediation, undefined);
  assert.match(failed.operation.message, /403 access denied/);
});

test("mismatch resolution rejects a desired spec that differs from the displayed decision", async () => {
  const mismatch = {
    instanceId: "i-shared",
    actual: PREPARED.actualSpec,
    desired: { instanceType: "t3.medium", rootVolumeSizeGb: 16 },
    diskTooSmall: true,
    computeTooSmall: true
  };
  const aws = {
    prepareWorker: async () => ({ ...PREPARED, desiredSpec: mismatch.desired, mismatch }),
    resumePendingVolumeExpansion: async (prepared: PreparedAwsWorker) => prepared,
    status: async () => ({ configured: true })
  };
  const settings = { saveAwsWorkerOperation: async () => undefined, getAwsWorkerOperation: async () => undefined };
  const service = new AwsWorkerSetupService(aws as any, {} as any, settings as any);
  const result = await service.start({
    operationId: "op-stale",
    resolution: "recreate",
    expectedInstanceId: "i-shared",
    expectedDesiredSpec: { instanceType: "t3.large", rootVolumeSizeGb: 32 }
  });
  assert.equal(result.operation.phase, "error");
  assert.match(result.operation.message, /required worker size changed/);
});

test("queued doctor progress cannot overwrite the terminal ready snapshot", async () => {
  const saved: AwsWorkerOperationSnapshot[] = [];
  const aws = {
    prepareWorker: async () => ({ ...PREPARED }),
    resumePendingVolumeExpansion: async (prepared: PreparedAwsWorker) => prepared,
    hasAcceptedMismatch: async () => false,
    ensurePreparedRunning: async () => ({ host: "198.51.100.10" }),
    status: async () => ({ configured: true })
  };
  const doctor = {
    waitForCloudInit: async (_worker: unknown, progress: (value: any) => void) => {
      progress({ stage: "cloud-init", message: "slow-progress" });
    },
    setup: async (_worker: unknown, progress: (value: any) => void) => {
      progress({ stage: "diagnose", message: "final-progress" });
      return { ok: true, message: "Worker ready.", checks: [] };
    }
  };
  const settings = {
    saveAwsWorkerOperation: async (operation: AwsWorkerOperationSnapshot) => {
      if (operation.message === "slow-progress") await new Promise((resolve) => setTimeout(resolve, 5));
      saved.push(operation);
    },
    getAwsWorkerOperation: async () => undefined
  };
  const service = new AwsWorkerSetupService(aws as any, doctor as any, settings as any);
  await service.start({ operationId: "op-ordered" });
  assert.equal(saved.at(-1)?.phase, "ready");
  assert.deepEqual(saved.filter((item) => item.phase === "setting-up").map((item) => item.message), [
    "Setting up the worker…",
    "slow-progress",
    "final-progress"
  ]);
});
