import type { AwsWorkerHandleInfo } from "../../../../shared/types";
import { normalizeAwsInstanceType } from "../../../../shared/cloudRuns";
import type { AwsWorkerCredentials } from "../../awsWorkerProvisioning";
import type { AwsWorkerInstanceInfo } from "../../awsWorkerLifecycle";

export function safeAwsErrorLogFields(error: unknown): Record<string, unknown> {
  const record = error && typeof error === "object"
    ? error as { name?: unknown; code?: unknown; Code?: unknown; message?: unknown }
    : undefined;
  const message = error instanceof Error
    ? error.message
    : typeof record?.message === "string"
      ? record.message
      : String(error ?? "");
  return {
    errorName: typeof record?.name === "string" ? record.name : undefined,
    errorCode: typeof record?.code === "string" ? record.code : typeof record?.Code === "string" ? record.Code : undefined,
    errorMessage: message.slice(0, 500)
  };
}

export function credentialsForHandle(credentials: AwsWorkerCredentials, handle: AwsWorkerHandleInfo): AwsWorkerCredentials {
  return { ...credentials, region: handle.region };
}

export function handleFromInfo(info: AwsWorkerInstanceInfo, options: {
  keyName: string;
  privateKeyPath: string;
  securityGroupId?: string;
  created: boolean;
}): AwsWorkerHandleInfo {
  const securityGroupId = info.securityGroupId ?? options.securityGroupId;
  if (!securityGroupId) {
    throw new Error("The tagged worker has no app-managed security group. Re-run the AWS setup command to migrate it safely, then retry.");
  }
  return {
    instanceId: info.instanceId,
    securityGroupId,
    keyName: options.keyName,
    accessKeyName: options.keyName,
    launchKeyName: info.keyName,
    region: info.region ?? "us-east-1",
    instanceType: normalizeAwsInstanceType(info.instanceType),
    rootVolumeSizeGb: info.rootVolumeSizeGb,
    rootVolumeId: info.rootVolumeId,
    availabilityZone: info.availabilityZone,
    vCpu: info.vCpu,
    memoryMiB: info.memoryMiB,
    adopted: !options.created,
    createdAt: info.launchedAt ?? new Date().toISOString()
  };
}
