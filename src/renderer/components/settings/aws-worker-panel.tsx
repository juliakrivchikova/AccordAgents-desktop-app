import { useEffect, useRef, useState } from "react";
import { ChevronDown, Loader2, Server } from "lucide-react";
import type { AwsWorkerOperationSnapshot, AwsWorkerSpec, AwsWorkerSpecResolution, CloudRunsSettings } from "../../../shared/types";
import { writeClipboardText, type ClipboardWriteResult } from "../../../shared/clipboard";
import { AwsWorkerConnectionForm } from "./aws-worker-connection-form";
import { AwsWorkerSizeEditor } from "./aws-worker-size-editor";
import { AwsCloudRunReadiness, AwsWorkerHistory, AwsWorkerTransition } from "./aws-worker-activity";
import { isAwsTransition, useAwsWorkerStatus } from "./use-aws-worker-status";

type Action = "setup" | "resize" | "stop" | "delete" | "command";
type ConfirmAction = "stop" | "delete" | "recreate" | null;
const livePhase = (operation: AwsWorkerOperationSnapshot | null): boolean => Boolean(operation && !["ready", "error", "needs-decision"].includes(operation.phase));
const latestOperation = (previous: AwsWorkerOperationSnapshot | null, next: AwsWorkerOperationSnapshot | null): AwsWorkerOperationSnapshot | null => {
  if (!next) return previous;
  if (previous && (previous.updatedAt > next.updatedAt || previous.operationId === next.operationId && previous.updatedAt === next.updatedAt && !livePhase(previous) && livePhase(next))) return previous;
  return next;
};

export function AwsWorkerPanel(props: {
  settings: CloudRunsSettings;
  onDeleted: () => Promise<void>;
}): JSX.Element {
  const monitor = useAwsWorkerStatus();
  const { status } = monitor;
  const [region, setRegion] = useState(props.settings.awsRegion ?? "us-east-1");
  const [command, setCommand] = useState("");
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
    if (next && livePhase(next) && !action) { setActiveOperationId(next.operationId); setAction(next.intent ?? "setup"); }
  }, [status?.operation, action]);
  useEffect(() => window.consensus.onAwsWorkerProgress(next => {
    if (next.operationId !== activeOperationId || action !== "setup" && action !== "resize") return;
    setOperation(previous => latestOperation(previous, next));
    setFeedback(undefined);
  }), [activeOperationId, action]);

  const begin = (kind: Action): boolean => {
    if (active.current || isAwsTransition(status) || monitor.awaitingStop) return false;
    active.current = kind;
    monitor.beginAction();
    // Reading recovery instructions keeps the failed attempt current.
    if (kind !== "command" || !currentOperation) setAction(kind);
    setBusy(true); setFeedback(undefined); setConfirm(null); setStartedAt(Date.now());
    return true;
  };
  const finish = (): void => { active.current = undefined; monitor.endAction(); if (mounted.current) setBusy(false); };
  const fail = (cause: unknown): void => { if (mounted.current) setFeedback({ message: cause instanceof Error ? cause.message : String(cause), failed: true }); };
  const actual = status?.actualSpec;
  const baseSpec = actual ?? newSpec ?? { instanceType: props.settings.awsInstanceType, rootVolumeSizeGb: props.settings.awsRootVolumeSizeGb };
  const currentOperation = operation?.operationId === activeOperationId && (action === "setup" || action === "resize") ? operation : null;
  const mismatch = currentOperation?.phase === "needs-decision" ? currentOperation.specMismatch : undefined;
  const showProgress = livePhase(currentOperation) && !feedback?.failed;
  const locked = busy || showProgress || isAwsTransition(status) || monitor.awaitingStop;

  const start = async (resolution?: AwsWorkerSpecResolution, spec: AwsWorkerSpec = baseSpec, intent: "setup" | "resize" = "setup"): Promise<void> => {
    if (!begin(intent)) return;
    const continuation = operation && (operation.phase === "error" || operation.phase === "needs-decision") && (operation.intent ?? "setup") === intent ? operation : undefined;
    const operationId = continuation?.operationId ?? crypto.randomUUID();
    setActiveOperationId(operationId);
    try {
      const result = await window.consensus.startAwsWorker({
        operationId, clientToken: continuation?.clientToken ?? operationId, intent,
        blob: blob.trim() || undefined, instanceType: spec.instanceType, rootVolumeSizeGb: spec.rootVolumeSizeGb,
        resolution,
        expectedInstanceId: mismatch?.instanceId ?? (intent === "resize" ? actual?.instanceId : undefined),
        expectedDesiredSpec: resolution ? spec : undefined,
        expectedActualSpec: intent === "resize" && actual && !mismatch ? actual : undefined
      });
      if (!mounted.current) return;
      monitor.accept(result.status);
      setOperation(result.operation);
      setFeedback({ message: result.operation.message, failed: result.operation.phase === "error" });
      if (result.status.configured) setBlob("");
      if (intent === "resize" && result.operation.phase === "ready") setEditing(false);
    } catch (cause) { fail(cause); }
    finally { finish(); }
  };
  const applySize = async (spec: AwsWorkerSpec): Promise<void> => {
    if (!actual && !status?.configured) { setNewSpec(spec); setEditing(false); return; }
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
      setFeedback(next.actionError ? { message: next.message ?? next.actionError, failed: true }
        : next.state === "stopping" ? undefined : { message: next.state === "stopped" ? "AWS confirmed the instance is stopped." : "Stop requested; checking AWS for confirmation.", failed: false });
    } catch (cause) { fail(cause); }
    finally { finish(); }
  };
  const remove = async (): Promise<void> => {
    if (confirm !== "delete") { setConfirm("delete"); return; }
    if (!begin("delete")) return;
    try {
      const next = await window.consensus.deleteAwsWorker();
      if (!mounted.current) return;
      monitor.accept(next);
      setFeedback({ message: next.message ?? (next.configured ? "Deletion has not been confirmed." : "Instance deleted."), failed: Boolean(next.actionError || next.configured) });
      if (!next.configured) { setOperation(null); await props.onDeleted(); }
    } catch (cause) { fail(cause); }
    finally { finish(); }
  };
  const loadCommand = async (): Promise<void> => {
    if (!begin("command")) return;
    const recoveryOperationId = currentOperation?.phase === "error" && currentOperation.remediation === "refresh-aws-authorization" ? currentOperation.operationId : undefined;
    try { setCommand(await window.consensus.getAwsWorkerBootstrapCommand(region.trim() || "us-east-1", recoveryOperationId)); }
    catch (cause) { fail(cause); }
    finally { finish(); }
  };
  const copyCommand = async (): Promise<void> => {
    if (!command) return;
    setCopyFeedback(await writeClipboardText(command, value => navigator.clipboard.writeText(value)));
  };
  const connectionForm = <AwsWorkerConnectionForm operation={currentOperation} busy={locked} region={region} command={command} blob={blob} copyFeedback={copyFeedback}
    onRegionChange={setRegion} onBlobChange={setBlob} onLoadCommand={loadCommand} onCopyCommand={copyCommand} onApply={() => start()} />;
  const recovery = currentOperation?.phase === "error" && currentOperation.remediation === "refresh-aws-authorization" ? <div className="gen-aws-recovery">
    <button type="button" className="gen-pill" data-testid="aws-worker-authorization-toggle" aria-expanded={authorizationOpen} onClick={() => setAuthorizationOpen(!authorizationOpen)}><span className="gen-pill-label">Update AWS permissions</span><ChevronDown size={14} /></button>
    {authorizationOpen ? connectionForm : null}
    <button type="button" className="gen-pill" disabled={locked} onClick={() => void start()}><span className="gen-pill-label">Retry existing permissions</span></button>
  </div> : null;
  const isRunning = status?.state === "running" || status?.state === "pending";
  const canStart = Boolean(blob.trim() || props.settings.hasAwsCredentials || status?.configured);
  const message = monitor.error ?? (action === "resize" && editing ? undefined : feedback?.message ?? currentOperation?.message);
  const hasError = Boolean(monitor.error || feedback?.failed || currentOperation?.phase === "error");
  const stateLabel = !status ? monitor.error ? "Status unavailable" : "Checking status…" : !status.configured ? "Not connected" : !status.state ? "Status unavailable" : status.state === "running" ? "Running · billable" : status.state === "pending" ? "Starting · billable" : status.state[0].toUpperCase() + status.state.slice(1);
  const primaryLabel = monitor.awaitingStop ? "Stopping…" : isAwsTransition(status) ? status?.state === "stopping" ? "Stopping…" : "Starting…"
    : busy ? action === "stop" ? "Sending Stop…" : action === "delete" ? "Deleting…" : action === "resize" ? "Applying size…" : "Working…"
      : action === "setup" && feedback?.failed ? "Retry setup" : monitor.error || isRunning ? "Check cloud setup" : "Start instance";

  return <div className="gen-aws" data-testid="aws-worker-panel" aria-busy={locked}>
    <div className="gen-aws-summary" data-testid="aws-worker-actions">
      <div className="gen-aws-summary-main">
        <strong className={`gen-aws-state${isRunning ? " is-billable" : ""}`} data-testid="aws-worker-state">{stateLabel}</strong>
        <div className="gen-actions">
          <button type="button" className="gen-pill" data-testid="aws-worker-start" disabled={locked || !canStart || !status} onClick={() => void start()}>
            <span className="gen-pill-lead">{locked ? <Loader2 size={16} className="gen-aws-spinner" aria-hidden /> : <Server size={16} />}</span><span className="gen-pill-label">{primaryLabel}</span>
          </button>
          <button type="button" className="gen-pill" disabled={busy || monitor.checking} onClick={() => void monitor.refresh()}><span className="gen-pill-label">{monitor.checking ? "Checking status…" : "Refresh status"}</span></button>
          {status?.configured ? <button type="button" className="gen-pill" disabled={locked || !isRunning} onClick={() => void stop()}><span className="gen-pill-label">Stop</span></button> : null}
        </div>
      </div>
      {actual ? <div className="gen-aws-specs" data-testid="aws-worker-actual-specs"><span>{actual.instanceType}</span>{actual.vCpu ? <span>{actual.vCpu} vCPU</span> : null}{actual.memoryMiB ? <span>{Math.round(actual.memoryMiB / 1024)} GB RAM</span> : null}<span>{actual.rootVolumeSizeGb} GiB disk</span></div>
        : status && !status.configured ? <div className="gen-row-desc">New instance: {baseSpec.instanceType} · {baseSpec.rootVolumeSizeGb} GiB disk</div> : null}
      <AwsCloudRunReadiness status={status} />
      <div className="gen-row-desc">Shared by your laptops and projects. Does not stop automatically.</div>
    </div>
    {isAwsTransition(status) || monitor.awaitingStop ? <AwsWorkerTransition key={monitor.awaitingStop ? "stopping" : status?.state} state={monitor.awaitingStop ? "stopping" : status?.state ?? ""} since={monitor.stopRequestedAt ?? (action === "stop" ? startedAt : undefined)} checkedAt={monitor.checkedAt} checking={monitor.checking} error={monitor.error} /> : null}
    {message ? <div className={`gen-aws-feedback${hasError ? " is-error" : ""}`} data-testid="aws-worker-message" role={hasError ? "alert" : "status"}>{action && feedback && !monitor.error ? <strong>{action === "stop" ? "Stop" : action === "delete" ? "Delete" : "Cloud setup"}: </strong> : null}{message}</div> : null}
    {recovery}
    {status && !status.configured && !props.settings.hasAwsCredentials ? connectionForm : null}
    {showProgress && currentOperation ? <WorkerProgress operation={currentOperation} /> : null}
    {mismatch ? <div className="gen-aws-decision" data-testid="aws-worker-spec-decision">
      <strong>Review the requested size change</strong><span>Current: {mismatch.actual.instanceType} · {mismatch.actual.rootVolumeSizeGb} GiB; requested: {mismatch.desired.instanceType} · {mismatch.desired.rootVolumeSizeGb} GiB.</span>
      <div className="gen-actions">
        <button type="button" className="gen-pill" disabled={locked} onClick={() => void start("keep", mismatch.desired, "resize")}><span className="gen-pill-label">Keep using</span></button>
        {mismatch.diskTooSmall ? <button type="button" className="gen-pill" disabled={locked} onClick={() => void start("grow-disk", mismatch.desired, "resize")}><span className="gen-pill-label">Grow disk</span></button> : null}
        <button type="button" className="gen-pill gen-pill-danger" disabled={locked} onClick={() => setConfirm("recreate")}><span className="gen-pill-label">Recreate</span></button>
      </div>
      {confirm === "recreate" ? <ConfirmSharedAction label="Recreate" onCancel={() => setConfirm(null)} onConfirm={() => void start("recreate", mismatch.desired, "resize")} /> : null}
    </div> : null}
    {confirm === "stop" ? <ConfirmSharedAction label="Stop" onCancel={() => setConfirm(null)} onConfirm={() => void stop()} /> : null}
    {confirm === "delete" ? <ConfirmSharedAction label="Delete" onCancel={() => setConfirm(null)} onConfirm={() => void remove()} /> : null}
    <button type="button" className="gen-aws-disclosure" data-testid="aws-worker-config-toggle" aria-expanded={configOpen} aria-controls="aws-instance-configuration" onClick={() => setConfigOpen(!configOpen)}><span>Size &amp; instance details</span><ChevronDown size={16} aria-hidden /></button>
    {configOpen ? <div id="aws-instance-configuration">
      {editing ? <AwsWorkerSizeEditor actual={actual} initial={baseSpec} busy={locked || Boolean(mismatch)} error={action === "resize" && feedback?.failed ? feedback.message : undefined} onApply={applySize} onCancel={() => { setEditing(false); if (action === "resize") { setFeedback(undefined); setActiveOperationId(undefined); } }} />
        : <div className="gen-row gen-row-stack"><div className="gen-row-desc">{actual ? `Current disk: ${actual.rootVolumeSizeGb} GiB. Choose Change size to edit.` : `New instance: ${baseSpec.rootVolumeSizeGb} GiB disk.`}</div><div className="gen-actions"><button type="button" className="gen-pill" data-testid="aws-worker-size-edit" disabled={locked || Boolean(status?.configured && !actual)} onClick={() => { setFeedback(undefined); setEditing(true); }}><span className="gen-pill-label">Change size</span></button></div></div>}
      {status?.configured ? <div className="gen-row">
        {actual ? <div className="gen-row-text gen-row-desc gen-aws-identity">{actual.instanceId} · {actual.region}</div> : null}
        <button type="button" className="gen-pill gen-pill-danger" disabled={locked} onClick={() => void remove()}><span className="gen-pill-label">Delete</span></button>
      </div> : null}
    </div> : null}
    <AwsWorkerHistory operation={operation} />
  </div>;
}

function WorkerProgress({ operation }: { operation: AwsWorkerOperationSnapshot }): JSX.Element {
  const phases = [
    { id: "starting", label: "Starting" },
    { id: "waiting-running", label: "Waiting for running" },
    { id: "setting-up", label: "Setting up" },
    { id: "ready", label: "Ready" }
  ] as const;
  const current = operation.phase === "needs-decision" || operation.phase === "error" ? -1 : phases.findIndex((phase) => phase.id === operation.phase);
  return (
    <ol className={`gen-aws-progress is-${operation.phase}`} data-testid="aws-worker-progress" aria-label="AWS worker start progress">
      {phases.map((phase, index) => (
        <li key={phase.id} className={index < current || operation.phase === "ready" ? "is-done" : index === current ? "is-current" : ""}>
          <span aria-hidden>{index < current || operation.phase === "ready" ? "✓" : index + 1}</span>
          <span>{phase.label}</span>
        </li>
      ))}
      {operation.authUrl ? <li className="gen-aws-auth"><button type="button" className="gen-doctor-auth-link" onClick={() => void window.consensus.openExternal(operation.authUrl as string)}>Open Codex sign-in</button>{operation.authCode ? <code>{operation.authCode}</code> : null}</li> : null}
    </ol>
  );
}

function ConfirmSharedAction(props: { label: string; onCancel: () => void; onConfirm: () => void }): JSX.Element {
  return (
    <div className="gen-aws-confirm" role="alert">
      <span>{props.label} affects every laptop and project using this shared worker.</span>
      <div className="gen-actions">
        <button type="button" className="gen-pill" onClick={props.onCancel}><span className="gen-pill-label">Cancel</span></button>
        <button type="button" className="gen-pill gen-pill-danger" onClick={props.onConfirm}><span className="gen-pill-label">Confirm {props.label.toLowerCase()}</span></button>
      </div>
    </div>
  );
}
