import { createHash } from "node:crypto";
import type {
  AwsWorkerActualSpec, AwsWorkerHandleInfo, AwsWorkerSpec, AwsWorkerSpecMismatch, AwsWorkerStatus, CloudRunWorkerSettings
} from "../../../../shared/types";
import { normalizeAwsInstanceType, normalizeAwsRootVolumeSizeGb } from "../../../../shared/cloudRuns";
import { assertAwsMachinePowerConfig, type AwsMachinePowerConfig } from "../../../../shared/machinePower";
import type { AwsWorkerCredentials } from "../../awsWorkerProvisioning";
import type { AwsWorkerInstanceInfo } from "../../awsWorkerLifecycle";
import { WORKER_ROOT, WORKER_SSH_USER } from "../constants";

export function actualSpecFrom(info: AwsWorkerInstanceInfo, handle: AwsWorkerHandleInfo): AwsWorkerActualSpec {
  return {
    instanceId: info.instanceId,
    region: info.region ?? handle.region,
    availabilityZone: info.availabilityZone ?? handle.availabilityZone,
    rootVolumeId: info.rootVolumeId ?? handle.rootVolumeId,
    instanceType: normalizeAwsInstanceType(info.instanceType ?? handle.instanceType),
    rootVolumeSizeGb: normalizeAwsRootVolumeSizeGb(info.rootVolumeSizeGb ?? handle.rootVolumeSizeGb),
    vCpu: info.vCpu ?? handle.vCpu,
    memoryMiB: info.memoryMiB ?? handle.memoryMiB
  };
}

export function specMismatch(actual: AwsWorkerActualSpec, desired: AwsWorkerSpec): AwsWorkerSpecMismatch | undefined {
  const diskTooSmall = actual.rootVolumeSizeGb < desired.rootVolumeSizeGb;
  const computeTooSmall = typeof actual.vCpu === "number" && typeof actual.memoryMiB === "number"
    && typeof desired.vCpu === "number" && typeof desired.memoryMiB === "number"
    ? actual.vCpu < desired.vCpu || actual.memoryMiB < desired.memoryMiB
    : actual.instanceType !== desired.instanceType;
  return diskTooSmall || computeTooSmall
    ? { instanceId: actual.instanceId, actual, desired, diskTooSmall, computeTooSmall }
    : undefined;
}

export function workerSettings(publicIp: string, identityFile: string, deviceId: string, instanceId: string): CloudRunWorkerSettings {
  const safeDeviceId = deviceId.replace(/[^A-Za-z0-9._-]/g, "_");
  return {
    host: publicIp,
    user: WORKER_SSH_USER,
    identityFile,
    hostKeyAlias: `accordagents-${instanceId}`,
    workerRoot: `${WORKER_ROOT}/devices/${safeDeviceId}`
  };
}

export function knownInstanceCapacity(instanceType: string): { vCpu?: number; memoryMiB?: number } {
  const known: Record<string, { vCpu: number; memoryMiB: number }> = {
    "t3.small": { vCpu: 2, memoryMiB: 2048 },
    "t3.medium": { vCpu: 2, memoryMiB: 4096 },
    "t3.large": { vCpu: 2, memoryMiB: 8192 },
    "t3.xlarge": { vCpu: 4, memoryMiB: 16384 }
  };
  return known[instanceType] ?? {};
}

/** A pasted result without a stop key (the account refused to make one, or
 *  both slots were in use) keeps the one the app has: it is still valid, and
 *  the machine may run with it. The phone's start key is made only once, so a
 *  later result never carries it and the app keeps the one phones hold. */
export function withRetainedKeys(pasted: AwsWorkerCredentials, saved: AwsWorkerCredentials | undefined): AwsWorkerCredentials {
  if (!saved || saved.region !== pasted.region) return pasted;
  return {
    ...pasted,
    ...(!pasted.power && saved.power ? { power: saved.power } : {}),
    ...(!pasted.wake && saved.wake ? { wake: saved.wake } : {})
  };
}

export function powerConfigFor(credentials: AwsWorkerCredentials, handle: AwsWorkerHandleInfo): AwsMachinePowerConfig | undefined {
  if (!credentials.power || handle.region !== credentials.region) return undefined;
  const config: AwsMachinePowerConfig = {
    version: 1,
    instanceId: handle.instanceId,
    credentials: { accessKeyId: credentials.power.accessKeyId, secretAccessKey: credentials.power.secretAccessKey, region: handle.region }
  };
  try {
    assertAwsMachinePowerConfig(config);
  } catch {
    return undefined;
  }
  return config;
}

export function multipleWorkerError(workers: AwsWorkerInstanceInfo[]): Error {
  const ids = workers.map((worker) => `${worker.instanceId} (${worker.region ?? "unknown region"})`).join(", ");
  return new Error(`Multiple tagged AccordAgents workers exist: ${ids}. Resolve the conflict in AWS before retrying; nothing was changed.`);
}

export function growRootFilesystemCommand(targetSizeGb: number): string {
  const minimumBytes = Math.floor(targetSizeGb * 1024 * 1024 * 1024 * 0.85);
  return [
    "set -eu",
    "root=$(findmnt -n -o SOURCE /)",
    "parent=$(lsblk -n -o PKNAME \"$root\" | head -1 | tr -d '[:space:]')",
    "if [ -n \"$parent\" ]; then part=$(lsblk -n -o PARTN \"$root\" | head -1 | tr -d '[:space:]'); sudo -n env TMPDIR=/run growpart \"/dev/$parent\" \"$part\" || true; fi",
    "fstype=$(findmnt -n -o FSTYPE /)",
    "if [ \"$fstype\" = ext4 ]; then sudo -n resize2fs \"$root\"; elif [ \"$fstype\" = xfs ]; then sudo -n xfs_growfs -d /; else echo \"Unsupported root filesystem: $fstype\" >&2; exit 2; fi",
    `size=$(df -B1 --output=size / | tail -1 | tr -d ' '); [ \"$size\" -ge ${minimumBytes} ] || { echo \"Root filesystem did not reach the requested size.\" >&2; exit 3; }`
  ].join("; ");
}

export function replacementLaunchToken(operationId: string, instanceId: string): string {
  return createHash("sha256")
    .update(`accordagents:replacement:${operationId}:${instanceId}`)
    .digest("hex");
}

export function retainedActionFailure(
  action: "stopped" | "deleted",
  state: AwsWorkerStatus["state"],
  detail: string
): string {
  const observed = state ? ` Observed state: ${state}.` : " Observed state is unknown.";
  return `The shared worker was not ${action}; settings were retained.${observed} ${detail}`;
}
