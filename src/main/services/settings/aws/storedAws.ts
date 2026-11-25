import type {
  AwsWorkerHandleInfo, AwsSetupStep, AwsWorkerOperationSnapshot, AwsWorkerSpec, AwsWorkerVolumeExpansion, CloudRunsSettings,
  CloudRunRemoteExecutionMode
} from "../../../../shared/types";
import { normalizeAwsInstanceType, normalizeAwsRootVolumeSizeGb, normalizeOptionalAwsRootVolumeSizeGb } from "../../../../shared/cloudRuns";
import { normalizeCloudRunWorkerSettings } from "../../cloudRunWorkers";
import { DEFAULT_CLOUD_RUNS_SETTINGS } from "./constants";
import type { StoredSettings } from "../types";

export function normalizeCloudRunsSettings(stored: StoredSettings): CloudRunsSettings {
  const record = stored.cloudRuns && typeof stored.cloudRuns === "object" && !Array.isArray(stored.cloudRuns)
    ? stored.cloudRuns as Partial<CloudRunsSettings>
    : {};
  const maxRuntimeMs = typeof record.maxRuntimeMs === "number" && Number.isFinite(record.maxRuntimeMs)
    ? Math.max(60_000, Math.floor(record.maxRuntimeMs))
    : DEFAULT_CLOUD_RUNS_SETTINGS.maxRuntimeMs;
  const pollIntervalMs = typeof record.pollIntervalMs === "number" && Number.isFinite(record.pollIntervalMs)
    ? Math.max(500, Math.floor(record.pollIntervalMs))
    : DEFAULT_CLOUD_RUNS_SETTINGS.pollIntervalMs;
  return {
    enabled: record.enabled === true,
    mode: stored.cloudRunsMode === "aws" ? "aws" : "ssh",
    worker: normalizeCloudRunWorkerSettings(record.worker),
    hasAwsCredentials: typeof stored.encryptedAwsCredentials === "string" && stored.encryptedAwsCredentials.length > 0,
    awsHandle: stored.awsWorkerHandle,
    awsRegion: stored.awsWorkerRegion,
    awsInstanceType: normalizeAwsInstanceType(record.awsInstanceType),
    awsRootVolumeSizeGb: normalizeAwsRootVolumeSizeGb(record.awsRootVolumeSizeGb),
    maxRuntimeMs,
    pollIntervalMs
  };
}

export function normalizeAwsWorkerHandle(value: unknown): AwsWorkerHandleInfo | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Partial<AwsWorkerHandleInfo>;
  const instanceId = typeof record.instanceId === "string" ? record.instanceId.trim() : "";
  const securityGroupId = typeof record.securityGroupId === "string" ? record.securityGroupId.trim() : "";
  const keyName = typeof record.keyName === "string" ? record.keyName.trim() : "";
  const region = typeof record.region === "string" ? record.region.trim() : "";
  if (!instanceId || !securityGroupId || !keyName || !region) {
    return undefined;
  }
  const rootVolumeSizeGb = normalizeOptionalAwsRootVolumeSizeGb(record.rootVolumeSizeGb);
  return {
    instanceId,
    securityGroupId,
    keyName,
    accessKeyName: typeof record.accessKeyName === "string" && record.accessKeyName.trim()
      ? record.accessKeyName.trim()
      : keyName,
    launchKeyName: typeof record.launchKeyName === "string" && record.launchKeyName.trim()
      ? record.launchKeyName.trim()
      : keyName,
    region,
    instanceType: normalizeAwsInstanceType(record.instanceType),
    ...(rootVolumeSizeGb ? { rootVolumeSizeGb } : {}),
    ...(typeof record.rootVolumeId === "string" && record.rootVolumeId.trim() ? { rootVolumeId: record.rootVolumeId.trim() } : {}),
    ...(typeof record.availabilityZone === "string" && record.availabilityZone.trim() ? { availabilityZone: record.availabilityZone.trim() } : {}),
    ...(typeof record.vCpu === "number" && record.vCpu > 0 ? { vCpu: Math.floor(record.vCpu) } : {}),
    ...(typeof record.memoryMiB === "number" && record.memoryMiB > 0 ? { memoryMiB: Math.floor(record.memoryMiB) } : {}),
    ...(typeof record.adopted === "boolean" ? { adopted: record.adopted } : {}),
    ...(typeof record.lastKnownHost === "string" && record.lastKnownHost.trim() ? { lastKnownHost: record.lastKnownHost.trim() } : {}),
    createdAt: typeof record.createdAt === "string" && record.createdAt ? record.createdAt : new Date().toISOString()
  };
}

export function normalizeAwsWorkerOperation(value: unknown): AwsWorkerOperationSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Partial<AwsWorkerOperationSnapshot>;
  const phases = new Set(["starting", "waiting-running", "setting-up", "ready", "needs-decision", "error"]);
  if (typeof record.operationId !== "string" || !record.operationId.trim()
    || typeof record.phase !== "string" || !phases.has(record.phase)
    || typeof record.message !== "string" || typeof record.updatedAt !== "string") {
    return undefined;
  }
  // The page reads the steps as they are: anything else is dropped.
  const stepIds = new Set(["instance", "tools", "sign-in-codex", "sign-in-claude", "program"]);
  const stepStates = new Set(["pending", "current", "done", "skipped", "failed"]);
  const setupSteps = Array.isArray(record.setupSteps) ? record.setupSteps.filter((step): step is AwsSetupStep => Boolean(step)
    && typeof step === "object" && stepIds.has(step.id) && stepStates.has(step.state)
    && (step.detail === undefined || typeof step.detail === "string") && (step.startedAt === undefined || typeof step.startedAt === "string")) : undefined;
  const { setupSteps: _stored, ...rest } = record;
  return {
    ...rest,
    operationId: record.operationId.trim(),
    ...(setupSteps?.length ? { setupSteps } : {}),
    ...(typeof record.clientToken === "string" && record.clientToken.trim()
      ? { clientToken: record.clientToken.trim().slice(0, 64) }
      : {})
  } as AwsWorkerOperationSnapshot;
}

export function normalizeAwsWorkerVolumeExpansion(value: unknown): AwsWorkerVolumeExpansion | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Partial<AwsWorkerVolumeExpansion>;
  if (typeof record.instanceId !== "string" || !record.instanceId.trim()
    || typeof record.volumeId !== "string" || !record.volumeId.trim()
    || typeof record.targetSizeGb !== "number" || !Number.isFinite(record.targetSizeGb)
    || typeof record.updatedAt !== "string" || !record.updatedAt) {
    return undefined;
  }
  return {
    instanceId: record.instanceId.trim(),
    volumeId: record.volumeId.trim(),
    targetSizeGb: normalizeAwsRootVolumeSizeGb(record.targetSizeGb),
    updatedAt: record.updatedAt
  };
}

export function normalizeAwsWorkerSpecAcceptance(value: unknown): { instanceId: string; desired: AwsWorkerSpec } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as { instanceId?: unknown; desired?: Partial<AwsWorkerSpec> };
  if (typeof record.instanceId !== "string" || !record.instanceId.trim() || !record.desired) {
    return undefined;
  }
  return {
    instanceId: record.instanceId.trim(),
    desired: {
      instanceType: normalizeAwsInstanceType(record.desired.instanceType),
      rootVolumeSizeGb: normalizeAwsRootVolumeSizeGb(record.desired.rootVolumeSizeGb),
      ...(typeof record.desired.vCpu === "number" ? { vCpu: Math.floor(record.desired.vCpu) } : {}),
      ...(typeof record.desired.memoryMiB === "number" ? { memoryMiB: Math.floor(record.desired.memoryMiB) } : {})
    }
  };
}

export function normalizeRemoteExecutionMode(value: unknown): CloudRunRemoteExecutionMode | undefined {
  return value === "inherit" || value === "local" || value === "remote" ? value : undefined;
}

export function normalizeConcreteRemoteExecutionMode(value: unknown): Extract<CloudRunRemoteExecutionMode, "local" | "remote"> {
  return normalizeRemoteExecutionMode(value) === "remote" ? "remote" : "local";
}
