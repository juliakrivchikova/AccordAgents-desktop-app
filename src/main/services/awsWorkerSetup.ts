import { isDeepStrictEqual } from "node:util";
import type {
  AwsSetupStep,
  AwsSetupStepId,
  AwsWorkerOperationSnapshot,
  AwsWorkerStartRequest,
  AwsWorkerStartResult,
  AwsWorkerStatus,
  ChatProviderKind,
  CloudRunWorkerSetupProgress
} from "../../shared/types";
import { enabledCloudProviders, type CloudRunDoctorService } from "./cloudRunDoctor";
import { awsAuthorizationErrorDetails, isAwsAuthorizationError } from "./awsEc2Client";
import type { CloudRunAwsService, PreparedAwsWorker } from "./cloudRunAws";
import type { SettingsService } from "./settings";

/** The program this desktop runs on the instance, as setup needs it. */
export interface AwsCloudProgram {
  /** Whether this desktop's program is already installed on that instance. */
  installed(instanceId: string): Promise<boolean>;
  /** Installs it and waits until it is connected; throws with the reason. */
  install(progress: (message: string) => void): Promise<void>;
  /** Throws, with what to do, when the program could not be installed at all
   *  (there is no server of the User's for it to connect through). */
  ready?(): Promise<void>;
}

const SIGN_IN_STEP: Record<"codex-cli" | "claude-code", AwsSetupStepId> = {
  "codex-cli": "sign-in-codex",
  "claude-code": "sign-in-claude"
};
const PROVIDER_NAME: Record<"codex-cli" | "claude-code", string> = { "codex-cli": "Codex", "claude-code": "Claude Code" };

export class AwsWorkerSetupService {
  private active: Promise<AwsWorkerStartResult> | undefined;
  private activeRequest: AwsWorkerStartRequest | undefined;

  constructor(
    private readonly aws: CloudRunAwsService,
    private readonly doctor: CloudRunDoctorService,
    private readonly settings: SettingsService,
    private readonly program?: AwsCloudProgram,
    private readonly now: () => Date = () => new Date()
  ) {}

  async recoverInterruptedOperation(): Promise<void> {
    const previous = await this.settings.getAwsWorkerOperation();
    if (!previous || previous.phase === "ready" || previous.phase === "needs-decision" || previous.phase === "error") return;
    const message = previous.intent === "check" ? "AWS access check was interrupted. Try again to check access."
      : previous.intent === "resize" ? "The change was interrupted. Try again to finish it." : "Setup was interrupted. Try again to finish it.";
    await this.settings.saveAwsWorkerOperation({
      ...previous,
      phase: "error",
      message,
      error: previous.intent === "check" ? "The desktop app closed before the AWS access check finished." : "The desktop app closed before the setup finished.",
      retryable: true,
      // The step that was running did not finish; no sign-in waits any more.
      ...(previous.setupSteps ? { setupSteps: previous.setupSteps.map((step) => step.state === "current" ? { ...step, state: "failed" as const, detail: "The app closed before this step finished." } : step) } : {}),
      authUrl: undefined,
      authCode: undefined,
      authProvider: undefined,
      authRequestId: undefined,
      updatedAt: this.now().toISOString()
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
    // What the User sees step by step. A read-only check has none.
    let steps: AwsSetupStep[] | undefined = request.intent === "check" ? undefined : [{ id: "instance", state: "current", startedAt: this.now().toISOString() }];
    const setStep = (id: AwsSetupStepId, state: AwsSetupStep["state"], detail?: string): void => {
      if (!steps) return;
      steps = steps.map((step) => step.id !== id ? step : {
        ...step,
        state,
        ...(detail !== undefined ? { detail } : {}),
        ...(state === "current" && step.state !== "current" ? { startedAt: this.now().toISOString() } : {})
      });
    };
    const currentStep = (): AwsSetupStep | undefined => steps?.find((step) => step.state === "current");
    const emit = async (
      phase: AwsWorkerOperationSnapshot["phase"],
      message: string,
      extra: Partial<AwsWorkerOperationSnapshot> = {}
    ): Promise<AwsWorkerOperationSnapshot> => {
      // The instance step says what is happening to the instance itself; a
      // run that ends there (keeping the current size) ends it too.
      if (currentStep()?.id === "instance" && phase === "ready") setStep("instance", "done", message);
      else if (currentStep()?.id === "instance" && phase !== "error") setStep("instance", "current", message);
      const operation: AwsWorkerOperationSnapshot = {
        operationId: request.operationId,
        intent: request.intent,
        clientToken,
        phase,
        message,
        updatedAt: this.now().toISOString(),
        ...(steps ? { setupSteps: steps } : {}),
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
      await emit("starting", "Looking for your AWS instance…");
      // A setup that would have to install the program, and cannot, says so
      // before anything is created or anyone is asked to sign in.
      if (this.program?.ready) {
        const configured = (await this.settings.getPublicSettings()).cloudRuns?.awsHandle?.instanceId;
        if (!configured || !(await this.program.installed(configured))) await this.program.ready();
      }
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
      await emit("waiting-running", "Waiting for the instance to be running and reachable…");
      const worker = await this.aws.ensurePreparedRunning(prepared);
      // The first setup of this desktop on the instance also signs the agents
      // in (each one can be skipped) and installs the cloud program; a later
      // start only checks the tools, and leaves the program to its updates.
      const onboarding = Boolean(this.program) && !(await this.program!.installed(prepared.info.instanceId));
      const enabled = enabledCloudProviders((await this.settings.getPublicSettings()).providers)
        .filter((kind): kind is "codex-cli" | "claude-code" => kind === "codex-cli" || kind === "claude-code");
      // A retry of the same setup does not ask again for a sign-in the User skipped.
      const skippedBefore = new Map((previous?.operationId === request.operationId ? previous.setupSteps ?? [] : [])
        .filter((step) => step.state === "skipped").map((step) => [step.id, step.detail] as const));
      const signIns = onboarding ? (["codex-cli", "claude-code"] as const).filter((kind) => enabled.includes(kind)) : [];
      setStep("instance", "done", `${prepared.actualSpec.instanceType} · ${prepared.actualSpec.rootVolumeSizeGb} GiB disk · ${prepared.handle.region}`);
      steps = [
        ...(steps ?? []),
        { id: "tools", state: "current", startedAt: this.now().toISOString(), detail: "Setting up the tools the agents use…" },
        ...signIns.map((kind): AwsSetupStep => skippedBefore.has(SIGN_IN_STEP[kind])
          ? { id: SIGN_IN_STEP[kind], state: "skipped", detail: skippedBefore.get(SIGN_IN_STEP[kind]) }
          : { id: SIGN_IN_STEP[kind], state: "pending" }),
        ...(onboarding ? [{ id: "program" as const, state: "pending" as const }] : [])
      ];
      const offerSignIn: ChatProviderKind[] = signIns.filter((kind) => !skippedBefore.has(SIGN_IN_STEP[kind]));
      let progressWrites: Promise<unknown> = Promise.resolve();
      // How each sign-in ended, as the doctor reported it on its last frame.
      const signInOutcome = new Map<AwsSetupStepId, { outcome: NonNullable<CloudRunWorkerSetupProgress["signInOutcome"]>; message: string }>();
      const signInEnded = (id: AwsSetupStepId): AwsSetupStep["state"] => signInOutcome.get(id)?.outcome === "completed" ? "done" : "skipped";
      const doctorProgress = (progress: CloudRunWorkerSetupProgress): Promise<unknown> => {
        const stepId: AwsSetupStepId = progress.stage === "codex-auth" ? "sign-in-codex"
          : progress.stage === "claude-auth" ? "sign-in-claude" : "tools";
        if (stepId !== "tools" && progress.signInOutcome) signInOutcome.set(stepId, { outcome: progress.signInOutcome, message: progress.message });
        const current = currentStep();
        const order = (id: AwsSetupStepId | undefined): number => steps?.findIndex((step) => step.id === id) ?? -1;
        if (current && order(stepId) > order(current.id)) {
          // Moving on: what the previous step ended as, until the final check says.
          setStep(current.id, current.id === "tools" ? "done" : signInEnded(current.id), current.id === "tools" ? "Installed." : undefined);
          setStep(stepId, "current", progress.message);
        } else if (current && order(stepId) === order(current.id)) {
          setStep(stepId, "current", progress.message);
        }
        const setupSteps = steps;
        progressWrites = progressWrites.then(() => emit("setting-up", progress.message, {
          authUrl: progress.authUrl,
          authCode: progress.authCode,
          authProvider: progress.authProvider,
          authRequestId: progress.authRequestId,
          ...(setupSteps ? { setupSteps } : {})
        }));
        return progressWrites;
      };
      await emit("setting-up", "Setting up the tools the agents use…");
      await this.doctor.waitForCloudInit(worker, doctorProgress);
      await progressWrites;
      const report = await this.doctor.setup(worker, doctorProgress, {
        requiredProviderKinds: enabled,
        signIn: "optional",
        offerSignIn
      });
      await progressWrites;
      // Each sign-in is what the last check found, said with how it ended.
      // `reached`: the doctor got past the sign-ins, so one it did not run
      // (already signed in, or skipped in an earlier try) is settled too.
      const settleSignIns = (reached: boolean): void => {
        for (const kind of signIns) {
          const id = SIGN_IN_STEP[kind];
          const step = steps?.find((item) => item.id === id);
          const ranNow = signInOutcome.has(id) || step?.state === "current";
          if (!ranNow && !reached) continue;
          const check = report.checks.find((item) => item.id === (kind === "codex-cli" ? "codex-auth" : "claude-auth"));
          const signedIn = check ? check.status === "pass" : signInEnded(id) === "done";
          if (signedIn) setStep(id, "done", "Signed in.");
          else if (!ranNow && step?.state === "skipped") continue;
          else setStep(id, "skipped", signInOutcome.get(id)?.message ?? "Not signed in.");
        }
      };
      if (!report.ok) {
        // What failed are the tools (or the connection), not a sign-in.
        const missing = report.checks.filter((check) => check.status === "fail").map((check) => check.label);
        settleSignIns(false);
        setStep("tools", "failed", missing.length ? `Not ready: ${missing.join(", ")}.` : report.message);
        const operation = await emit("error", report.message, {
          error: report.message,
          retryable: true
        });
        return { operation, status: await this.aws.status(), report };
      }
      if (currentStep()?.id === "tools") setStep("tools", "done", "Installed.");
      settleSignIns(true);
      if (onboarding) {
        setStep("program", "current", "Installing the cloud program…");
        await emit("setting-up", "Installing the cloud program…");
        let programWrites: Promise<unknown> = Promise.resolve();
        try {
          await this.program!.install((message) => {
            setStep("program", "current", message);
            const setupSteps = steps;
            programWrites = programWrites.then(() => emit("setting-up", message, setupSteps ? { setupSteps } : {})).catch(() => undefined);
          });
          await programWrites;
        } catch (error) {
          await programWrites;
          const reason = error instanceof Error ? error.message : String(error);
          setStep("program", "failed", reason);
          const message = `The cloud program could not be installed: ${reason}`;
          const operation = await emit("error", message, { error: message, retryable: true });
          return { operation, status: await this.aws.status(), report };
        }
        setStep("program", "done", "Installed and connected.");
      }
      const operation = await emit("ready", readyMessage(steps));
      return { operation, status: await this.aws.status(), report };
    } catch (error) {
      const needsAuthorizationRefresh = isAwsAuthorizationError(error);
      const authorization = needsAuthorizationRefresh ? awsAuthorizationErrorDetails(error) : undefined;
      const message = actionableError(error, authorization);
      const failing = currentStep();
      if (failing) setStep(failing.id, "failed", message);
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

/** Ready, and what is left for later, in one sentence. */
function readyMessage(steps: AwsSetupStep[] | undefined): string {
  const notSignedIn = (steps ?? []).filter((step) => step.state === "skipped" && step.id.startsWith("sign-in-"))
    .map((step) => step.id === "sign-in-codex" ? PROVIDER_NAME["codex-cli"] : PROVIDER_NAME["claude-code"]);
  if (!notSignedIn.length) return "Ready.";
  return `Ready. ${notSignedIn.join(" and ")} ${notSignedIn.length === 1 ? "is" : "are"} not signed in; sign in from Setup on this page when you need ${notSignedIn.length === 1 ? "it" : "them"}.`;
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
