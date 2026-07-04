export const AWS_WORKER_ROOT_VOLUME_SIZE_GB_DEFAULT = 8;
export const AWS_WORKER_ROOT_VOLUME_SIZE_GB_MIN = 8;
export const AWS_WORKER_ROOT_VOLUME_SIZE_GB_MAX = 1024;
export const AWS_WORKER_ROOT_VOLUME_SIZE_GB_OPTIONS = [8, 16, 32, 64, 128, 256] as const;

export function normalizeAwsRootVolumeSizeGb(value: unknown): number {
  const numeric = numericValue(value);
  if (!Number.isFinite(numeric)) {
    return AWS_WORKER_ROOT_VOLUME_SIZE_GB_DEFAULT;
  }
  return clampRootVolumeSizeGb(numeric);
}

export function normalizeOptionalAwsRootVolumeSizeGb(value: unknown): number | undefined {
  const numeric = numericValue(value);
  if (!Number.isFinite(numeric)) {
    return undefined;
  }
  return clampRootVolumeSizeGb(numeric);
}

function numericValue(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    return Number(value);
  }
  return Number.NaN;
}

function clampRootVolumeSizeGb(value: number): number {
  return Math.max(
    AWS_WORKER_ROOT_VOLUME_SIZE_GB_MIN,
    Math.min(AWS_WORKER_ROOT_VOLUME_SIZE_GB_MAX, Math.floor(value))
  );
}
