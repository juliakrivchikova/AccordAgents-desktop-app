import type {
  AwsWorkerOperationSnapshot,
  AwsWorkerStartRequest,
  AwsWorkerStartResult,
  AwsWorkerStatus,
  CloudRunWorkerSetupProgress
} from "../../shared/types";
import type { CloudRunDoctorService } from "./cloudRunDoctor";
import { isAwsAuthorizationError } from "./awsEc2Client";
import type { CloudRunAwsService, PreparedAwsWorker } from "./cloudRunAws";
import type { SettingsService } from "./settings";

export class AwsWorkerSetupService {
  private active: Promise<AwsWorkerStartResult> | undefined;

  constructor(
    private readonly aws: CloudRunAwsService,
    private readonly doctor: CloudRunDoctorService,
    private readonly settings: SettingsService
  ) {}

  async recoverInterruptedOperation(): Promise<void> {
    const previous = await this.settings.getAwsWorkerOperation();
    if (!previous || previous.phase === "ready" || previous.phase === "needs-decision" || previous.phase === "error") return;
    await this.settings.saveAwsWorkerOperation({
      ...previous,
      phase: "error",
      message: "Worker start was interrupted. Retry to resume safely.",
      error: "The desktop app closed before worker setup finished.",
      retryable: true,
      updatedAt: new Date().toISOString()
    });
  }

  start(
    request: AwsWorkerStartRequest,
    onProgress?: (progress: AwsWorkerOperationSnapshot) => void
  ): Promise<AwsWorkerStartResult> {
    if (this.active) return this.active;
    this.active = this.run(request, onProgress).finally(() => {
      this.active = undefined;
    });
    return this.active;
  }

  private async run(
    request: AwsWorkerStartRequest,
    onProgress?: (progress: AwsWorkerOperationSnapshot) => void
  ): Promise<AwsWorkerStartResult> {
    const previous = await this.settings.getAwsWorkerOperation();
    const pendingToken = await (this.settings as SettingsService & {
      getAwsWorkerProvisioningToken?: () => Promise<string | undefined>;
    }).getAwsWorkerProvisioningToken?.();
    const clientToken = pendingToken
      || request.clientToken?.trim()
      || (previous?.operationId === request.operationId ? previous.clientToken : undefined)
      || request.operationId;
    const emit = async (
      phase: AwsWorkerOperationSnapshot["phase"],
      message: string,
      extra: Partial<AwsWorkerOperationSnapshot> = {}
    ): Promise<AwsWorkerOperationSnapshot> => {
      const operation: AwsWorkerOperationSnapshot = {
        operationId: request.operationId,
        clientToken,
        phase,
        message,
        updatedAt: new Date().toISOString(),
        ...extra
      };
      await this.settings.saveAwsWorkerOperation(operation);
      onProgress?.(operation);
      return operation;
    };
    try {
      await emit("starting", "Looking for your shared AWS worker…");
      let prepared = await this.aws.prepareWorker({
        operationId: request.operationId,
        blob: request.blob,
        instanceType: request.instanceType,
        rootVolumeSizeGb: request.rootVolumeSizeGb,
        clientToken
      });
      prepared = await this.aws.resumePendingVolumeExpansion(prepared);
      prepared = await this.resolveMismatch(request, prepared, emit);
      if (prepared.mismatch && !await this.aws.hasAcceptedMismatch(prepared)) {
        const operation = await emit("needs-decision", mismatchMessage(prepared), {
          specMismatch: prepared.mismatch
        });
        return { operation, status: await this.aws.status() };
      }
      await emit("waiting-running", "Waiting for the worker to be running and reachable…");
      const worker = await this.aws.ensurePreparedRunning(prepared);
      let progressWrites: Promise<unknown> = Promise.resolve();
      const doctorProgress = (progress: CloudRunWorkerSetupProgress): void => {
        progressWrites = progressWrites.then(() => emit("setting-up", progress.message, {
          authUrl: progress.authUrl,
          authCode: progress.authCode
        }));
      };
      await emit("setting-up", "Setting up the worker…");
      await this.doctor.waitForCloudInit(worker, doctorProgress);
      await progressWrites;
      const report = await this.doctor.setup(worker, doctorProgress);
      await progressWrites;
      if (!report.ok) {
        const operation = await emit("error", report.message, {
          error: report.message,
          retryable: true
        });
        return { operation, status: await this.aws.status(), report };
      }
      const operation = await emit("ready", report.message || "Worker ready.");
      return { operation, status: await this.aws.status(), report };
    } catch (error) {
      const needsAuthorizationRefresh = isAwsAuthorizationError(error);
      const message = actionableError(error, needsAuthorizationRefresh);
      const operation = await emit("error", message, {
        error: message,
        retryable: true,
        ...(needsAuthorizationRefresh ? { remediation: "refresh-aws-authorization" as const } : {})
      });
      return { operation, status: await this.aws.status() };
    }
  }

  private async resolveMismatch(
    request: AwsWorkerStartRequest,
    prepared: PreparedAwsWorker,
    emit: (phase: AwsWorkerOperationSnapshot["phase"], message: string, extra?: Partial<AwsWorkerOperationSnapshot>) => Promise<AwsWorkerOperationSnapshot>
  ): Promise<PreparedAwsWorker> {
    if (!prepared.mismatch || !request.resolution) return prepared;
    if (!request.expectedInstanceId || !request.expectedDesiredSpec) {
      throw new Error("The worker-size decision is stale. Refresh and choose again.");
    }
    if (request.expectedInstanceId !== prepared.info.instanceId) {
      throw new Error("The shared worker changed after the choice was shown. Refresh and choose again.");
    }
    if (request.expectedDesiredSpec.instanceType !== prepared.desiredSpec.instanceType
      || request.expectedDesiredSpec.rootVolumeSizeGb !== prepared.desiredSpec.rootVolumeSizeGb) {
      throw new Error("The required worker size changed after the choice was shown. Refresh and choose again.");
    }
    if (request.resolution === "keep") {
      await this.aws.acceptMismatch(prepared);
      return prepared;
    }
    if (request.resolution === "grow-disk") {
      if (!prepared.mismatch.diskTooSmall) throw new Error("The worker disk is already large enough.");
      await emit("starting", "Growing the shared worker disk…");
      return this.aws.growDisk(prepared);
    }
    await emit("starting", "Recreating the shared worker at the configured size…");
    return this.aws.recreateWorker(prepared, request.expectedInstanceId ?? "", request.operationId);
  }
}

function mismatchMessage(prepared: PreparedAwsWorker): string {
  const gaps = [
    prepared.mismatch?.diskTooSmall ? "disk" : "",
    prepared.mismatch?.computeTooSmall ? "instance type" : ""
  ].filter(Boolean).join(" and ");
  return `The existing shared worker's ${gaps} is smaller than configured. Choose what to do.`;
}

function actionableError(error: unknown, needsAuthorizationRefresh = isAwsAuthorizationError(error)): string {
  const message = error instanceof Error ? error.message : String(error);
  return needsAuthorizationRefresh
    ? "Cloud Run cannot access required AWS APIs. First try Retry existing permissions. If it fails again, complete the AWS administrator update shown next."
    : message;
}
