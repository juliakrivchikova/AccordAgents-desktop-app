import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SettingsService } from "./settings";

test("concurrent AWS progress and settings updates persist one merged state", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-settings-atomic-"));
  try {
    const service = Object.create(SettingsService.prototype) as any;
    service.settingsPath = path.join(dir, "settings.json");
    service.storedWriteQueue = Promise.resolve();
    service.storedState = {
      settingsVersion: 1,
      roundLimitDefault: 1,
      providers: [],
      cloudRunsMode: "aws",
      cloudRuns: {
        enabled: true,
        mode: "aws",
        worker: {},
        hasAwsCredentials: false,
        awsInstanceType: "t3.small",
        awsRootVolumeSizeGb: 8,
        maxRuntimeMs: 86_400_000,
        pollIntervalMs: 2_500
      }
    };
    await Promise.all([
      service.saveAwsWorkerOperation({
        operationId: "op-atomic",
        clientToken: "token-atomic",
        phase: "setting-up",
        message: "Installing",
        updatedAt: "2026-07-10T00:00:00.000Z"
      }),
      service.saveCloudRunsSettings({ awsRootVolumeSizeGb: 32 })
    ]);
    const stored = JSON.parse(await readFile(service.settingsPath, "utf8"));
    assert.equal(stored.awsWorkerOperation.operationId, "op-atomic");
    assert.equal(stored.cloudRuns.awsRootVolumeSizeGb, 32);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
