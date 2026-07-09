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
