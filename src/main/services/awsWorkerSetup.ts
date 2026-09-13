import { isDeepStrictEqual } from "node:util";
import type {
  AwsWorkerOperationSnapshot,
  AwsWorkerStartRequest,
  AwsWorkerStartResult,
  AwsWorkerStatus,
  CloudRunWorkerSetupProgress
} from "../../shared/types";
import type { CloudRunDoctorService } from "./cloudRunDoctor";
import { awsAuthorizationErrorDetails, isAwsAuthorizationError } from "./awsEc2Client";
import type { CloudRunAwsService, PreparedAwsWorker } from "./cloudRunAws";
import type { SettingsService } from "./settings";

export class AwsWorkerSetupService {
  private active: Promise<AwsWorkerStartResult> | undefined;
  private activeRequest: AwsWorkerStartRequest | undefined;

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
      message: previous.intent === "check" ? "AWS access check was interrupted. Try again to check access." : "Worker start was interrupted. Retry to resume safely.",
      error: previous.intent === "check" ? "The desktop app closed before the AWS access check finished." : "The desktop app closed before worker setup finished.",
      retryable: true,
      updatedAt: new Date().toISOString()
    });
  }

  start(
    request: AwsWorkerStartRequest,
    onProgress?: (progress: AwsWorkerOperationSnapshot) => void
  ): Promise<AwsWorkerStartResult> {
    // Only a retry of the same request may join the one in flight. Handing a
    // different request the running one's result would answer "start" with
    // the outcome of a read-only check, or the other way round.
    if (this.active) {
      if (isDeepStrictEqual(this.activeRequest, { ...request, intent: request.intent ?? "setup" })) return this.active;
      return Promise.reject(new Error(`Another AWS action (${this.activeRequest?.intent ?? "setup"}) is still running. Wait for it to finish, then try again.`));
    }
    this.activeRequest = structuredClone({ ...request, intent: request.intent ?? "setup" });
    this.active = this.run(this.activeRequest, onProgress).finally(() => {
      this.active = undefined;
      this.activeRequest = undefined;
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
        intent: request.intent,
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
      if (request.intent === "check") {
        // Read-only: does this app still reach AWS? A refusal lands in the
        // catch below and becomes the permission recovery; nothing is
        // created, started or set up. Pasted credentials are adopted only
        // after they prove they can read the existing instance. The live
        // phase is saved so a reopened Settings panel sees the check running.
        await emit("starting", "Checking AWS access…");
        if (request.blob?.trim()) await this.aws.adoptCredentials(request.blob);
        const current = await this.aws.probeAccess();
        const operation = await emit("ready", current.configured
          ? `AWS access confirmed${current.state ? ` · instance ${current.state}` : ""}.`
          : "Connect the AWS account before checking access.");
        return { operation, status: current };
      }
      if (request.intent === "resize" && !request.expectedInstanceId) {
        throw new Error("Refresh and select the existing instance before changing its size.");
      }
      if (request.intent === "resize" && request.resolution === "keep") {
        await emit("starting", "Checking the current instance size…");
        const actual = await this.aws.keepCurrentSize(request.expectedInstanceId!);
        const operation = await emit("ready", `Kept the current instance: ${actual.instanceType} · ${actual.rootVolumeSizeGb} GiB disk.`);
        return { operation, status: await this.aws.status() };
      }
      if (request.expectedActualSpec) {
        const current = await this.aws.status();
        if (!current.actualSpec || current.actualSpec.instanceId !== request.expectedInstanceId
          || current.actualSpec.instanceType !== request.expectedActualSpec.instanceType
          || current.actualSpec.rootVolumeSizeGb !== request.expectedActualSpec.rootVolumeSizeGb) {
          throw new Error("The instance changed after the size editor opened. Refresh and review its current size before applying.");
        }
        if ((request.rootVolumeSizeGb ?? current.actualSpec.rootVolumeSizeGb) < current.actualSpec.rootVolumeSizeGb) {
          throw new Error("AWS cannot shrink an existing disk. Its current size has been kept.");
        }
      }
      await emit("starting", "Looking for your shared AWS worker…");
      let prepared = await this.aws.prepareWorker({
        operationId: request.operationId,
        blob: request.blob,
        instanceType: request.instanceType,
        rootVolumeSizeGb: request.rootVolumeSizeGb,
        clientToken,
        expectedInstanceId: request.intent === "resize" ? request.expectedInstanceId : undefined
      });
      if (request.intent === "resize" && prepared.info.instanceId !== request.expectedInstanceId) {
        throw new Error("The shared instance changed. Refresh before applying this size change.");
      }
      prepared = await this.aws.resumePendingVolumeExpansion(prepared);
      prepared = exactResizeMismatch(request, prepared);
      prepared = await this.resolveMismatch(request, prepared, emit);
      prepared = exactResizeMismatch(request, prepared);
      const accepted = request.intent !== "resize" && await this.aws.hasAcceptedMismatch(prepared);
      if (prepared.mismatch && !accepted) {
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
      const authorization = needsAuthorizationRefresh ? awsAuthorizationErrorDetails(error) : undefined;
      const message = actionableError(error, authorization);
      const operation = await emit("error", message, {
        error: message,
        retryable: true,
        ...(needsAuthorizationRefresh ? {
          remediation: "refresh-aws-authorization" as const,
          missingAwsActions: authorization?.missingActions,
          awsPrincipalArn: authorization?.principalArn,
          awsPrincipalUserName: authorization?.principalUserName
        } : {})
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
    prepared.mismatch?.computeTooSmall || prepared.actualSpec.instanceType !== prepared.desiredSpec.instanceType ? "instance type" : ""
  ].filter(Boolean).join(" and ");
  return `The existing shared worker's ${gaps || "size"} differs from the requested size. Choose what to do.`;
}

function exactResizeMismatch(request: AwsWorkerStartRequest, prepared: PreparedAwsWorker): PreparedAwsWorker {
  // Automatic setup accepts sufficient capacity; an explicit size edit promises
  // the requested type, including a cheaper/smaller one, unless User keeps it.
  if (request.intent !== "resize" || prepared.actualSpec.instanceType === prepared.desiredSpec.instanceType) return prepared;
  return { ...prepared, mismatch: {
    instanceId: prepared.info.instanceId, actual: prepared.actualSpec, desired: prepared.desiredSpec,
    diskTooSmall: prepared.actualSpec.rootVolumeSizeGb < prepared.desiredSpec.rootVolumeSizeGb,
    computeTooSmall: prepared.mismatch?.computeTooSmall ?? false
  } };
}

function actionableError(error: unknown, authorization?: ReturnType<typeof awsAuthorizationErrorDetails>): string {
  const needsAuthorizationRefresh = authorization || isAwsAuthorizationError(error);
  const message = error instanceof Error ? error.message : String(error);
  if (!needsAuthorizationRefresh) return message;
  const actions = authorization?.missingActions ?? [];
  const actionText = actions.length > 0 ? ` (${actions.join(", ")})` : "";
  return `Cloud Run cannot access required AWS APIs${actionText}. Update the existing worker permissions, then retry.`;
}
