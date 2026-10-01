import { useEffect, useRef, useState } from "react";
import { ChevronDown, Loader2, Server } from "lucide-react";
import type { AwsWorkerOperationSnapshot, AwsWorkerSpec, AwsWorkerSpecResolution, CloudRunsSettings } from "../../../shared/types";
import { writeClipboardText, type ClipboardWriteResult } from "../../../shared/clipboard";
import { AwsWorkerConnectionForm } from "./aws-worker-connection-form";
import { AwsWorkerAutoStopSetup, AwsWorkerBillingNote, autoStopAppliedMessage } from "./aws-worker-auto-stop";
import { AwsWorkerSizeEditor } from "./aws-worker-size-editor";
import { AwsCloudRunNextStep, AwsWorkerHistory, AwsWorkerTransition } from "./aws-worker-activity";
import { awsWorkerStateLabel, isAwsTransition, useAwsWorkerStatus } from "./use-aws-worker-status";
import { CONFIRM_TEXT, ConfirmSharedAction, WorkerProgress } from "./aws-worker-panel-parts";
import { AwsInstanceDiagnostics } from "./aws-instance-diagnostics";

type Action = "setup" | "resize" | "check" | "stop" | "delete" | "command";
type AttemptIntent = "setup" | "resize" | "check";
const isAttempt = (action: Action | undefined): action is AttemptIntent => action === "setup" || action === "resize" || action === "check";
type ConfirmAction = "stop" | "delete" | "recreate" | null;

const TERMINAL_PHASES: AwsWorkerOperationSnapshot["phase"][] = ["ready", "error", "needs-decision"];
const livePhase = (operation: AwsWorkerOperationSnapshot | null): boolean =>
  Boolean(operation && !TERMINAL_PHASES.includes(operation.phase));
const latestOperation = (
  previous: AwsWorkerOperationSnapshot | null,
  next: AwsWorkerOperationSnapshot | null
): AwsWorkerOperationSnapshot | null => {
  if (!next) return previous;
  const sameStamp = previous?.operationId === next.operationId && previous?.updatedAt === next.updatedAt;
  if (previous && (previous.updatedAt > next.updatedAt || sameStamp && !livePhase(previous) && livePhase(next))) return previous;
  return next;
};

export function AwsWorkerPanel(props: {
  settings: CloudRunsSettings;
  onDeleted: () => Promise<void>;
}): JSX.Element {
  const monitor = useAwsWorkerStatus();
  const { status } = monitor;
  const [region, setRegion] = useState(props.settings.awsRegion ?? "us-east-1");
  // Each form shows only its own command: the automatic-stop one always mints a key.
  const [command, setCommand] = useState({ text: "", autoStop: false });
  const [autoStopApply, setAutoStopApply] = useState(false);
  const [blob, setBlob] = useState("");
  const [operation, setOperation] = useState<AwsWorkerOperationSnapshot | null>(null);
  const [activeOperationId, setActiveOperationId] = useState<string>();
  const [action, setAction] = useState<Action>();
  const [busy, setBusy] = useState(false);
  const active = useRef<Action>();
  const [startedAt, setStartedAt] = useState<number>();
  const [confirm, setConfirm] = useState<ConfirmAction>(null);
  const [copyFeedback, setCopyFeedback] = useState<"idle" | ClipboardWriteResult>("idle");
  const [feedback, setFeedback] = useState<{ message: string; failed: boolean }>();
  const [configOpen, setConfigOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [authorizationOpen, setAuthorizationOpen] = useState(false);
  const [newSpec, setNewSpec] = useState<AwsWorkerSpec>();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    if (active.current) return;
    const next = status?.operation;
    setOperation(previous => latestOperation(previous, next ?? null));
    if (next && livePhase(next) && !action) {
      setActiveOperationId(next.operationId);
      setAction(next.intent ?? "setup");
    }
  }, [status?.operation, action]);
  useEffect(() => window.consensus.onAwsWorkerProgress(next => {
    if (next.operationId !== activeOperationId || !isAttempt(action)) return;
    setOperation(previous => latestOperation(previous, next));
    setFeedback(undefined);
  }), [activeOperationId, action]);

  const begin = (kind: Action): boolean => {
    if (active.current || isAwsTransition(status) || monitor.awaitingStop) return false;
    active.current = kind;
    monitor.beginAction();
    // Reading recovery instructions keeps the failed attempt current.
    if (kind !== "command" || !currentOperation) setAction(kind);
    setBusy(true);
    setFeedback(undefined);
    setConfirm(null);
    setStartedAt(Date.now());
    return true;
  };
  const finish = (): void => {
    active.current = undefined;
    monitor.endAction();
    if (mounted.current) setBusy(false);
  };
  const fail = (cause: unknown): void => {
    if (mounted.current) setFeedback({ message: cause instanceof Error ? cause.message : String(cause), failed: true });
  };

  const actual = status?.actualSpec;
  const configured = Boolean(status?.configured);
  const baseSpec = actual ?? newSpec ?? { instanceType: props.settings.awsInstanceType, rootVolumeSizeGb: props.settings.awsRootVolumeSizeGb };
  const currentOperation = operation?.operationId === activeOperationId && isAttempt(action) ? operation : null;
  const mismatch = currentOperation?.phase === "needs-decision" ? currentOperation.specMismatch : undefined;
  // A size decision answers the attempt that raised it: "keep" during Start
  // continues the start, "keep" during an explicit resize changes nothing.
  const decisionIntent: AttemptIntent = currentOperation?.intent === "resize" ? "resize" : "setup";
  const showProgress = livePhase(currentOperation) && !feedback?.failed;
  const locked = busy || showProgress || isAwsTransition(status) || monitor.awaitingStop;

  const start = async (
    resolution?: AwsWorkerSpecResolution,
    spec: AwsWorkerSpec = baseSpec,
    intent: AttemptIntent = "setup",
    autoStop = false
  ): Promise<void> => {
    if (!begin(intent)) return;
    setAutoStopApply(autoStop);
    const continuation = operation && (operation.phase === "error" || operation.phase === "needs-decision") && (operation.intent ?? "setup") === intent
      ? operation
      : undefined;
    const operationId = continuation?.operationId ?? crypto.randomUUID();
    setActiveOperationId(operationId);
    try {
      const result = await window.consensus.startAwsWorker({
        operationId,
        clientToken: continuation?.clientToken ?? operationId,
        intent,
        blob: blob.trim() || undefined,
        instanceType: spec.instanceType,
        rootVolumeSizeGb: spec.rootVolumeSizeGb,
        resolution,
        expectedInstanceId: mismatch?.instanceId ?? (intent === "resize" ? actual?.instanceId : undefined),
        expectedDesiredSpec: resolution ? spec : undefined,
        expectedActualSpec: intent === "resize" && actual && !mismatch ? actual : undefined
      });
      if (!mounted.current) return;
      monitor.accept(result.status);
      setOperation(result.operation);
      const failed = result.operation.phase === "error";
      setFeedback({ message: autoStop && !failed ? autoStopAppliedMessage(result.status.autoStop) : result.operation.message, failed });
      if (result.status.configured) setBlob("");
      if (intent === "resize" && result.operation.phase === "ready") setEditing(false);
    } catch (cause) {
      fail(cause);
    } finally {
      finish();
    }
  };
  const applySize = async (spec: AwsWorkerSpec): Promise<void> => {
    if (!actual && !configured) {
      setNewSpec(spec);
      setEditing(false);
      return;
    }
    const growOnly = actual && actual.instanceType === spec.instanceType && spec.rootVolumeSizeGb > actual.rootVolumeSizeGb;
    await start(growOnly ? "grow-disk" : undefined, spec, "resize");
  };
  const stop = async (): Promise<void> => {
    if (confirm !== "stop") { setConfirm("stop"); return; }
    if (!begin("stop")) return;
    try {
      const next = await window.consensus.stopAwsWorker();
      monitor.acceptStop(next, Date.now());
      if (!mounted.current) return;
      setFeedback(next.actionError
        ? { message: next.message ?? next.actionError, failed: true }
        : next.state === "stopping"
          ? undefined
          : { message: next.state === "stopped" ? "AWS confirmed the instance is stopped." : "Stop requested; checking AWS for confirmation.", failed: false });
    } catch (cause) {
      fail(cause);
    } finally {
      finish();
    }
  };
  const remove = async (): Promise<void> => {
    if (confirm !== "delete") { setConfirm("delete"); return; }
    if (!begin("delete")) return;
    try {
      const next = await window.consensus.deleteAwsWorker();
      if (!mounted.current) return;
      monitor.accept(next);
      setFeedback({
        message: next.message ?? (next.configured ? "Deletion has not been confirmed." : "Instance deleted."),
        failed: Boolean(next.actionError || next.configured)
      });
      if (!next.configured) {
        setOperation(null);
        await props.onDeleted();
      }
    } catch (cause) {
      fail(cause);
    } finally {
      finish();
    }
  };
  /** `autoStop`: always the key-minting setup command, for the instance's own region. */
  const loadCommand = async (options: { autoStop?: boolean; region?: string } = {}): Promise<void> => {
    if (!begin("command")) return;
    const recoveryOperationId = !options.autoStop && currentOperation?.phase === "error" && currentOperation.remediation === "refresh-aws-authorization"
      ? currentOperation.operationId
      : undefined;
    try {
      const text = await window.consensus.getAwsWorkerBootstrapCommand((options.region ?? region).trim() || "us-east-1", recoveryOperationId);
      setCommand({ text, autoStop: Boolean(options.autoStop) });
    } catch (cause) {
      fail(cause);
    } finally {
      finish();
    }
  };
  const copyCommand = async (): Promise<void> => {
    if (!command.text) return;
    setCopyFeedback(await writeClipboardText(command.text, value => navigator.clipboard.writeText(value)));
  };

  const isRunning = status?.state === "running" || status?.state === "pending";
  const stoppedLike = configured && (status?.state === "stopped" || status?.state === "absent" || status?.state === "terminated");
  // Configured but AWS is not answering (never, or not any more): the last
  // known state may still be shown, but the only honest action is to check
  // access again, which is also how a revoked permission reaches recovery.
  const statusUnavailable = Boolean(status) && configured && (Boolean(monitor.error) || !status?.state);
  const canStart = Boolean(blob.trim() || props.settings.hasAwsCredentials || configured);
  const authorizationFailure = currentOperation?.phase === "error" && currentOperation.remediation === "refresh-aws-authorization";
  const setupFailed = (action === "setup" || action === "check") && Boolean(feedback?.failed || currentOperation?.phase === "error");
  // Retrying repeats what failed: a read-only check stays a check.
  const retryIntent: AttemptIntent = action === "check" ? "check" : "setup";
  const needsConnection = Boolean(status) && !configured && !props.settings.hasAwsCredentials;
  const stopInFlight = monitor.awaitingStop || status?.state === "stopping" || busy && action === "stop";
  const showStop = status?.state === "running" || stopInFlight;
  const stopLabel = busy && action === "stop" ? "Sending Stop…" : stopInFlight ? "Stopping…" : "Stop";
  const workingLabel = action === "delete" ? "Deleting…" : action === "resize" ? "Applying size…" : action !== "check" ? "Starting…"
    : autoStopApply ? "Turning on automatic stop…" : "Checking AWS access…";
  // One primary action, only when the user can act now; starting is always named as starting, a check reads only.
  const primary: { label: string; disabled: boolean; intent: AttemptIntent } | null =
    isAwsTransition(status) || monitor.awaitingStop ? null
      : busy ? (action === "stop" || action === "command" ? null : { label: workingLabel, disabled: true, intent: "setup" })
        : showProgress ? { label: workingLabel, disabled: true, intent: "setup" }
          : setupFailed ? { label: "Try again", disabled: !canStart, intent: retryIntent }
            : statusUnavailable ? { label: "Check AWS access", disabled: false, intent: "check" }
              : !status || needsConnection ? null
                : !configured || stoppedLike ? { label: "Start instance", disabled: !canStart, intent: "setup" }
                  : null;
  // The check already re-reads the status; a second read button beside it would be the same action twice.
  const showRefresh = configured && !statusUnavailable || Boolean(monitor.error) && !status;

  const message = monitor.error ?? (action === "resize" && editing ? undefined : feedback?.message ?? currentOperation?.message);
  const hasError = Boolean(monitor.error || feedback?.failed || currentOperation?.phase === "error");
  const messagePrefix = action && feedback && !monitor.error
    ? action === "stop" ? "Stop" : action === "delete" ? "Delete" : action === "check" ? autoStopApply ? "Automatic stop" : "AWS access" : "Cloud setup"
    : undefined;
  const stateLabel = awsWorkerStateLabel(status, Boolean(monitor.error));

  const formProps = { operation: currentOperation, busy: locked, region, blob, copyFeedback, onRegionChange: setRegion, onBlobChange: setBlob, onCopyCommand: copyCommand };
  const connectionForm = (
    <AwsWorkerConnectionForm {...formProps} command={command.autoStop ? "" : command.text}
      onLoadCommand={() => loadCommand()} onApply={() => start(undefined, baseSpec, retryIntent)} />
  );
  const instanceRegion = status?.handle?.region ?? actual?.region ?? region;
  const autoStopForm = (
    <AwsWorkerConnectionForm {...formProps} autoStop region={instanceRegion} command={command.autoStop ? command.text : ""}
      onLoadCommand={() => loadCommand({ autoStop: true, region: instanceRegion })} onApply={() => start(undefined, baseSpec, "check", true)} />
  );

  return (
    <div className="gen-aws" data-testid="aws-worker-panel" aria-busy={locked}>
      <div className="gen-aws-summary" data-testid="aws-worker-actions">
        <div className="gen-aws-summary-main">
          <strong className={`gen-aws-state${isRunning ? " is-billable" : ""}`} data-testid="aws-worker-state">{stateLabel}</strong>
          <div className="gen-actions">
            {primary ? (
              <button type="button" className="gen-pill" data-testid="aws-worker-start" disabled={primary.disabled || locked} onClick={() => void start(undefined, baseSpec, primary.intent)}>
                <span className="gen-pill-lead">{locked ? <Loader2 size={16} className="gen-aws-spinner" aria-hidden /> : <Server size={16} />}</span>
                <span className="gen-pill-label">{primary.label}</span>
              </button>
            ) : null}
            {showRefresh ? (
              <button type="button" className="gen-pill" disabled={busy} onClick={() => void monitor.refresh()}>
                <span className="gen-pill-label">Refresh status</span>
              </button>
            ) : null}
            {showStop ? (
              <button type="button" className="gen-pill" data-testid="aws-worker-stop" disabled={locked} onClick={() => void stop()}>
                <span className="gen-pill-label">{stopLabel}</span>
              </button>
            ) : null}
          </div>
        </div>
        {actual ? (
          <div className="gen-aws-specs" data-testid="aws-worker-actual-specs">
            <span>{actual.instanceType}</span>
            {actual.vCpu ? <span>{actual.vCpu} vCPU</span> : null}
            {actual.memoryMiB ? <span>{Math.round(actual.memoryMiB / 1024)} GB RAM</span> : null}
            <span>{actual.rootVolumeSizeGb} GiB disk</span>
          </div>
        ) : status && !configured ? (
          <div className="gen-row-desc">New instance: {baseSpec.instanceType} · {baseSpec.rootVolumeSizeGb} GiB disk</div>
        ) : null}
        <AwsCloudRunNextStep status={status} />
        <AwsWorkerBillingNote autoStop={status?.autoStop} running={isRunning} />
      </div>
      {isAwsTransition(status) || monitor.awaitingStop ? (
        <AwsWorkerTransition
          key={monitor.awaitingStop ? "stopping" : status?.state}
          state={monitor.awaitingStop ? "stopping" : status?.state ?? ""}
          since={monitor.stopRequestedAt ?? (action === "stop" ? startedAt : undefined)}
          checkedAt={monitor.checkedAt}
          checking={monitor.checking}
          error={monitor.error}
        />
      ) : null}
      {message ? (
        <div className={`gen-aws-feedback${hasError ? " is-error" : ""}`} data-testid="aws-worker-message" role={hasError ? "alert" : "status"}>
          {messagePrefix ? <strong>{messagePrefix}: </strong> : null}{message}
        </div>
      ) : null}
      {authorizationFailure ? (
        <div className="gen-aws-recovery">
          <button type="button" className="gen-pill" data-testid="aws-worker-authorization-toggle" aria-expanded={authorizationOpen} onClick={() => setAuthorizationOpen(!authorizationOpen)}>
            <span className="gen-pill-label">Update AWS permissions</span>
            <ChevronDown size={14} className={authorizationOpen ? "is-open" : undefined} aria-hidden />
          </button>
          {authorizationOpen ? connectionForm : null}
        </div>
      ) : null}
      {needsConnection ? connectionForm : null}
      {configured && !authorizationFailure ? <AwsWorkerAutoStopSetup autoStop={status?.autoStop} running={isRunning} form={autoStopForm} /> : null}
      {showProgress && currentOperation && currentOperation.intent !== "check" ? <WorkerProgress operation={currentOperation} /> : null}
      {mismatch ? (
        <div className="gen-aws-decision" data-testid="aws-worker-spec-decision">
          <strong>Review the requested size change</strong>
          <span>Current: {mismatch.actual.instanceType} · {mismatch.actual.rootVolumeSizeGb} GiB; requested: {mismatch.desired.instanceType} · {mismatch.desired.rootVolumeSizeGb} GiB.</span>
          {mismatch.actual.instanceType !== mismatch.desired.instanceType ? (
            <span>This app changes the instance type only by recreating the instance; growing the disk keeps it.</span>
          ) : null}
          <div className="gen-actions">
            <button type="button" className="gen-pill" disabled={locked} onClick={() => void start("keep", mismatch.desired, decisionIntent)}>
              <span className="gen-pill-label">Keep current size</span>
            </button>
            {mismatch.diskTooSmall ? (
              <button type="button" className="gen-pill" disabled={locked} onClick={() => void start("grow-disk", mismatch.desired, decisionIntent)}>
                <span className="gen-pill-label">Grow disk</span>
              </button>
            ) : null}
            <button type="button" className="gen-pill gen-pill-danger" disabled={locked} onClick={() => setConfirm("recreate")}>
              <span className="gen-pill-label">Recreate</span>
            </button>
          </div>
          {confirm === "recreate" ? (
            <ConfirmSharedAction label="Recreate" description={CONFIRM_TEXT.recreate} onCancel={() => setConfirm(null)} onConfirm={() => void start("recreate", mismatch.desired, decisionIntent)} />
          ) : null}
        </div>
      ) : null}
      {confirm === "stop" ? <ConfirmSharedAction label="Stop" description={CONFIRM_TEXT.stop} onCancel={() => setConfirm(null)} onConfirm={() => void stop()} /> : null}
      {confirm === "delete" ? <ConfirmSharedAction label="Delete" description={CONFIRM_TEXT.delete} onCancel={() => setConfirm(null)} onConfirm={() => void remove()} /> : null}
      <button type="button" className="gen-aws-disclosure" data-testid="aws-worker-config-toggle" aria-expanded={configOpen} aria-controls="aws-instance-configuration" onClick={() => setConfigOpen(!configOpen)}>
        <span>Size &amp; instance details</span><ChevronDown size={16} aria-hidden />
      </button>
      {configOpen ? (
        <div id="aws-instance-configuration">
          {editing ? (
            <AwsWorkerSizeEditor
              actual={actual}
              initial={baseSpec}
              busy={locked || Boolean(mismatch)}
              startsInstance={Boolean(actual) && !isRunning}
              error={action === "resize" && feedback?.failed ? feedback.message : undefined}
              onApply={applySize}
              onCancel={() => {
                setEditing(false);
                if (action === "resize") {
                  setFeedback(undefined);
                  setActiveOperationId(undefined);
                }
              }}
            />
          ) : (
            <div className="gen-row">
              <div className="gen-row-text gen-row-desc">{actual ? "Instance type and disk size" : "Size for the new instance"}</div>
              <div className="gen-actions">
                <button type="button" className="gen-pill" data-testid="aws-worker-size-edit" disabled={locked || Boolean(configured && !actual)} onClick={() => { setFeedback(undefined); setEditing(true); }}>
                  <span className="gen-pill-label">Change size</span>
                </button>
              </div>
            </div>
          )}
          {configured ? (
            <div className="gen-row">
              {actual ? <div className="gen-row-text gen-row-desc gen-aws-identity">{actual.instanceId} · {actual.region}</div> : null}
              <button type="button" className="gen-pill gen-pill-danger" disabled={locked} onClick={() => void remove()}>
                <span className="gen-pill-label">Delete</span>
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      <AwsWorkerHistory operation={currentOperation ? null : operation} />
      {/* Checks and setup exist once an instance does; the live status knows
          that before the parent's settings are re-read. */}
      {configured ? <AwsInstanceDiagnostics /> : null}
    </div>
  );
}
