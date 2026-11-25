import type { CloudRunsSettings } from "../../../../shared/types";
import { AWS_WORKER_ROOT_VOLUME_SIZE_GB_DEFAULT, AWS_WORKER_INSTANCE_TYPE_DEFAULT } from "../../../../shared/cloudRuns";

export const DEFAULT_CLOUD_RUNS_SETTINGS: CloudRunsSettings = {
  enabled: false,
  mode: "ssh",
  worker: {},
  hasAwsCredentials: false,
  awsInstanceType: AWS_WORKER_INSTANCE_TYPE_DEFAULT,
  awsRootVolumeSizeGb: AWS_WORKER_ROOT_VOLUME_SIZE_GB_DEFAULT,
  maxRuntimeMs: 24 * 60 * 60_000,
  pollIntervalMs: 2_500
};
