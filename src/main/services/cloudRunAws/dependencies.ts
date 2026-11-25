import { randomUUID } from "node:crypto";
import type { CloudRunWorkerSettings } from "../../../shared/types";
import type { AwsWorkerCredentials } from "../awsWorkerProvisioning";
import { AwsWorkerLifecycle } from "../awsWorkerLifecycle";
import type { Ec2Client } from "../awsWorkerLifecycle";
import { generateAwsWorkerKeyMaterial } from "../awsEc2Client";
import { AwsWorkerAccess } from "../awsWorkerAccess";
import type { SettingsService } from "../settings";
import type { MachineRecoveryFailure } from "../machineRecovery";

/** What the AWS service is given by the app. */
export interface AwsDependencies {
  readonly settings: SettingsService;
  readonly lifecycle: AwsWorkerLifecycle;
  readonly createEc2Client: (credentials: AwsWorkerCredentials) => Ec2Client;
  readonly generateKeyMaterial: typeof generateAwsWorkerKeyMaterial;
  readonly workerAccess: AwsWorkerAccess;
  readonly privateKeyPathForKeyName: (keyName: string) => string;
  readonly logger?: ((event: string, payload: Record<string, unknown>) => void) | undefined;
  readonly appVersion?: string | undefined;
  readonly machineConnected?: ((machineId: string) => boolean | undefined) | undefined;
  readonly machineRecoveryFailure?: ((machineId: string) => MachineRecoveryFailure | undefined) | undefined;
  readonly wait: (delayMs: number) => Promise<void>;
  readonly sshExec: (worker: CloudRunWorkerSettings, command: string, timeoutMs: number) => Promise<void>;
  readonly platform: NodeJS.Platform;
  readonly removeMachine?: ((machineId: string) => Promise<void>) | undefined;
  readonly machinesReady?: (() => Promise<void>) | undefined;
  readonly now: () => number;
  readonly automaticStopOwnerId: string;
}
