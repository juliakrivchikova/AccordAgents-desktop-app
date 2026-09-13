import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Server } from "lucide-react";

import type {
  AwsWorkerOperationSnapshot,
  AwsWorkerSpec,
  AwsWorkerSpecResolution,
  AwsWorkerStatus,
  CloudRunsSettings
} from "../../../shared/types";
import {
  AWS_WORKER_INSTANCE_TYPE_OPTIONS,
  AWS_WORKER_ROOT_VOLUME_SIZE_GB_OPTIONS,
  normalizeAwsRootVolumeSizeGb
} from "../../../shared/cloudRuns";
import { writeClipboardText, type ClipboardWriteResult } from "../../../shared/clipboard";

import { AwsWorkerConnectionForm } from "./aws-worker-connection-form";

type ClipboardFeedback = "idle" | ClipboardWriteResult;
type ConfirmAction = "stop" | "delete" | "recreate" | null;

export function AwsWorkerPanel(props: {
  settings: CloudRunsSettings;
  onInstanceTypeChange: (value: string) => void;
  onDiskSizeChange: (value: number) => void;
  onDeleted: () => Promise<void>;
}): JSX.Element {
  const [region, setRegion] = useState(props.settings.awsRegion ?? "us-east-1");
  const [command, setCommand] = useState("");
  const [blob, setBlob] = useState("");
  const [status, setStatus] = useState<AwsWorkerStatus | null>(null);
  const [operation, setOperation] = useState<AwsWorkerOperationSnapshot | null>(null);
  const [activeOperationId, setActiveOperationId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmAction>(null);
  const [copyFeedback, setCopyFeedback] = useState<ClipboardFeedback>("idle");
  const [actionMessage, setActionMessage] = useState<string>();
  const [actionFailed, setActionFailed] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [authorizationOpen, setAuthorizationOpen] = useState(false);
  const showError = (error: unknown): void => {
    setActionMessage(error instanceof Error ? error.message : String(error));
    setActionFailed(true);
  };
  const diskOptions = useMemo(() => {
    const options: number[] = [...AWS_WORKER_ROOT_VOLUME_SIZE_GB_OPTIONS];
    return options.includes(props.settings.awsRootVolumeSizeGb)
      ? options
      : [...options, props.settings.awsRootVolumeSizeGb].sort((left, right) => left - right);
  }, [props.settings.awsRootVolumeSizeGb]);

  useEffect(() => {
    void window.consensus.getAwsWorkerStatus().then((next) => {
      setStatus(next);
      setOperation(next.operation ?? null);
      setActionMessage(next.message);
    }).catch(showError);
  }, []);

  useEffect(() => window.consensus.onAwsWorkerProgress((progress) => {
    if (!activeOperationId || progress.operationId === activeOperationId) {
      setOperation(progress);
      setActionMessage(undefined);
    }
  }), [activeOperationId]);

  const loadCommand = async (): Promise<void> => {
    setBusy(true);
    setActionFailed(false);
    setActionMessage(undefined);
    try {
      setCommand(await window.consensus.getAwsWorkerBootstrapCommand(region.trim() || "us-east-1"));
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const start = async (
    resolution?: AwsWorkerSpecResolution,
    expected?: { instanceId: string; desired: Pick<AwsWorkerSpec, "instanceType" | "rootVolumeSizeGb"> }
  ): Promise<void> => {
    const continuation = operation?.phase === "error" || operation?.phase === "needs-decision"
      ? operation
      : undefined;
    const operationId = continuation?.operationId ?? crypto.randomUUID();
    const clientToken = continuation?.clientToken ?? operationId;
    setActiveOperationId(operationId);
    setBusy(true);
    setActionFailed(false);
    setActionMessage(undefined);
    setConfirm(null);
    try {
      const result = await window.consensus.startAwsWorker({
        operationId,
        clientToken,
        blob: blob.trim() || undefined,
        instanceType: props.settings.awsInstanceType,
        rootVolumeSizeGb: props.settings.awsRootVolumeSizeGb,
        resolution,
        expectedInstanceId: expected?.instanceId ?? operation?.specMismatch?.instanceId,
        expectedDesiredSpec: resolution ? expected?.desired ?? operation?.specMismatch?.desired : undefined
      });
      setOperation(result.operation);
      setStatus(result.status);
      if (result.status.configured) setBlob("");
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const refresh = async (): Promise<void> => {
    setBusy(true);
    setActionFailed(false);
    setActionMessage(undefined);
    try {
      const next = await window.consensus.getAwsWorkerStatus();
      setStatus(next);
      setOperation(next.operation ?? operation);
      setActionMessage(next.message);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const stop = async (): Promise<void> => {
    if (confirm !== "stop") {
      setConfirm("stop");
      return;
    }
    setBusy(true);
    setActionFailed(false);
    setActionMessage(undefined);
    try {
      const next = await window.consensus.stopAwsWorker();
      setStatus(next);
      setActionMessage(next.message ?? stateMessage(next.state));
      setConfirm(null);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (confirm !== "delete") {
      setConfirm("delete");
      return;
    }
    setBusy(true);
    setActionFailed(false);
    setActionMessage(undefined);
    try {
      const next = await window.consensus.deleteAwsWorker();
      setStatus(next);
      setOperation(next.configured ? next.operation ?? operation : null);
      setActionMessage(next.message);
      setConfirm(null);
      if (!next.configured) await props.onDeleted();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const copyCommand = async (): Promise<void> => {
    if (!command) return;
    const result = await writeClipboardText(command, (value) => navigator.clipboard.writeText(value));
    setCopyFeedback(result);
    window.setTimeout(() => setCopyFeedback("idle"), 1400);
  };

  const actual = status?.actualSpec ?? operation?.specMismatch?.actual;
  const desired = {
    instanceType: props.settings.awsInstanceType,
    rootVolumeSizeGb: props.settings.awsRootVolumeSizeGb
  };
  const mismatch = operation?.specMismatch;
  const needsAuthorizationRefresh = operation?.remediation === "refresh-aws-authorization";
  const showInitialConnection = Boolean(status && !needsAuthorizationRefresh && !props.settings.hasAwsCredentials && !status.configured);
  const canStart = Boolean(blob.trim() || props.settings.hasAwsCredentials || status?.configured);
  const isRunning = status?.state === "running" || status?.state === "pending";
  const desiredInstanceDiffers = Boolean(actual?.instanceType && actual.instanceType !== desired.instanceType);
  const desiredDiskDiffers = Boolean(actual?.rootVolumeSizeGb && actual.rootVolumeSizeGb !== desired.rootVolumeSizeGb);
  const desiredDiskCanGrow = Boolean(actual?.instanceId && actual.rootVolumeSizeGb && desired.rootVolumeSizeGb > actual.rootVolumeSizeGb && !desiredInstanceDiffers);
  const desiredSizeDiffers = desiredInstanceDiffers || desiredDiskDiffers;
  const primaryActionLabel = needsAuthorizationRefresh
    ? "Retry existing permissions"
    : operation?.phase === "error" || actionFailed
      ? "Retry"
      : desiredDiskCanGrow
        ? `Apply disk resize to ${desired.rootVolumeSizeGb} GB`
        : desiredSizeDiffers
          ? "Review size change"
          : status?.configured && isRunning
            ? "Check worker"
            : "Start worker";
  const primaryAction = async (): Promise<void> => {
    if (desiredDiskCanGrow && actual?.instanceId) {
      await start("grow-disk", { instanceId: actual.instanceId, desired });
      return;
    }
    await start();
  };
  const connectionForm = (
    <AwsWorkerConnectionForm
      operation={operation} busy={busy} region={region} command={command} blob={blob} copyFeedback={copyFeedback}
      onRegionChange={setRegion} onBlobChange={setBlob} onLoadCommand={loadCommand} onCopyCommand={copyCommand}
      onApply={() => start()}
    />
  );
  const message = actionMessage ?? operation?.message ?? status?.message;
  const hasError = actionFailed || operation?.phase === "error" || Boolean(status?.configured && !status.state && status.message);
  const showProgress = operation && !["ready", "error", "needs-decision"].includes(operation.phase);

  return (
    <div className="gen-aws" data-testid="aws-worker-panel" aria-busy={busy}>
      <div className="gen-aws-summary" data-testid="aws-worker-actions">
        <div className="gen-aws-summary-main">
          <strong className={`gen-aws-state${isRunning ? " is-billable" : ""}`} data-testid="aws-worker-state">
            {instanceStateLabel(status, actionFailed)}
          </strong>
          <div className="gen-actions">
            <button type="button" className="gen-pill" data-testid="aws-worker-start" disabled={busy || !canStart || !status} onClick={() => void primaryAction()}>
              <span className="gen-pill-lead"><Server size={16} /></span>
              <span className="gen-pill-label">{primaryActionLabel}</span>
            </button>
            {status?.configured || actionFailed ? <button type="button" className="gen-pill" disabled={busy} onClick={() => void refresh()}><span className="gen-pill-label">Refresh status</span></button> : null}
            {status?.configured ? <button type="button" className="gen-pill" disabled={busy || !isRunning} onClick={() => void stop()}><span className="gen-pill-label">Stop</span></button> : null}
          </div>
        </div>
        {actual ? (
          <div className="gen-aws-specs" data-testid="aws-worker-actual-specs">
            <span>{actual.instanceType}</span>
            {actual.vCpu ? <span>{actual.vCpu} vCPU</span> : null}
            {actual.memoryMiB ? <span>{Math.round(actual.memoryMiB / 1024)} GB RAM</span> : null}
            <span>{actual.rootVolumeSizeGb} GB disk</span>
          </div>
        ) : showInitialConnection ? <div className="gen-row-desc">New instance: {desired.instanceType} · {desired.rootVolumeSizeGb} GB disk</div> : null}
        <div className="gen-row-desc">Shared by your laptops and projects. Does not stop automatically.</div>
      </div>

      {message ? <div className={`gen-aws-feedback${hasError ? " is-error" : ""}`} data-testid="aws-worker-message" role={hasError ? "alert" : "status"}>{message}</div> : null}
      {needsAuthorizationRefresh ? (
        <div className="gen-aws-recovery">
          <button type="button" className="gen-pill" data-testid="aws-worker-authorization-toggle" aria-expanded={authorizationOpen} aria-controls="aws-authorization-details" onClick={() => setAuthorizationOpen(!authorizationOpen)}>
            <span className="gen-pill-label">Update AWS permissions</span>
            <ChevronDown size={14} aria-hidden className={authorizationOpen ? "is-open" : ""} />
          </button>
          {authorizationOpen ? <div id="aws-authorization-details">{connectionForm}</div> : null}
        </div>
      ) : null}
      {showInitialConnection ? connectionForm : null}
      {showProgress ? <WorkerProgress operation={operation} /> : null}

      {actual && desiredSizeDiffers && operation?.phase !== "needs-decision" ? (
        <div className="gen-aws-size-change" data-testid="aws-worker-unapplied-size">
          Size change not applied: {desired.instanceType} · {desired.rootVolumeSizeGb} GB disk.
        </div>
      ) : null}
      {mismatch && operation?.phase === "needs-decision" ? (
        <div className="gen-aws-decision" data-testid="aws-worker-spec-decision">
          <strong>Existing worker is smaller than configured.</strong>
          <span>Actual: {mismatch.actual.instanceType}, {mismatch.actual.rootVolumeSizeGb} GB. Required: {mismatch.desired.instanceType}, {mismatch.desired.rootVolumeSizeGb} GB.</span>
          <div className="gen-actions">
            <button type="button" className="gen-pill" disabled={busy} onClick={() => void start("keep")}><span className="gen-pill-label">Keep using</span></button>
            {mismatch.diskTooSmall ? <button type="button" className="gen-pill" disabled={busy} onClick={() => void start("grow-disk")}><span className="gen-pill-label">Grow disk</span></button> : null}
            <button type="button" className="gen-pill gen-pill-danger" disabled={busy} onClick={() => setConfirm("recreate")}><span className="gen-pill-label">Recreate</span></button>
          </div>
          {confirm === "recreate" ? <ConfirmSharedAction label="Recreate" onCancel={() => setConfirm(null)} onConfirm={() => void start("recreate")} /> : null}
        </div>
      ) : null}
      {confirm === "stop" ? <ConfirmSharedAction label="Stop" onCancel={() => setConfirm(null)} onConfirm={() => void stop()} /> : null}
      {confirm === "delete" ? <ConfirmSharedAction label="Delete" onCancel={() => setConfirm(null)} onConfirm={() => void remove()} /> : null}

      <button type="button" className="gen-aws-disclosure" data-testid="aws-worker-config-toggle" aria-expanded={configOpen} aria-controls="aws-instance-configuration" onClick={() => setConfigOpen(!configOpen)}>
        <span>Size &amp; instance details</span><ChevronDown size={16} aria-hidden />
      </button>
      {configOpen ? (
        <div id="aws-instance-configuration">
          <div className="gen-row gen-row-stack">
            <div className="gen-row-desc">New instances use this size. Existing instances change only when you apply it.</div>
            <div className="gen-grid-form" data-testid="aws-worker-desired-specs">
              <label className="gen-aws-field">
                <span>Instance type</span>
                <span className="gen-select-wrap">
                  <select className="gen-input" aria-label="AWS worker instance type" disabled={busy || operation?.phase === "needs-decision"} value={props.settings.awsInstanceType} onChange={(event) => props.onInstanceTypeChange(event.target.value)}>
                    {AWS_WORKER_INSTANCE_TYPE_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                  <ChevronDown size={16} />
                </span>
              </label>
              <label className="gen-aws-field">
                <span>Disk size</span>
                <span className="gen-select-wrap">
                  <select className="gen-input" aria-label="AWS worker disk size" disabled={busy || operation?.phase === "needs-decision"} value={props.settings.awsRootVolumeSizeGb} onChange={(event) => props.onDiskSizeChange(normalizeAwsRootVolumeSizeGb(event.target.value))}>
                    {diskOptions.map((value) => <option key={value} value={value}>{value} GB</option>)}
                  </select>
                  <ChevronDown size={16} />
                </span>
              </label>
            </div>
            {actual ? <div className="gen-row-desc gen-aws-identity">{actual.instanceId} · {actual.region}</div> : null}
            {status?.configured ? (
              <div className="gen-actions">
                <button type="button" className="gen-pill gen-pill-danger" disabled={busy} onClick={() => void remove()}><span className="gen-pill-label">Delete</span></button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function instanceStateLabel(status: AwsWorkerStatus | null, failed: boolean): string {
  if (!status) return failed ? "Status unavailable" : "Checking status…";
  if (!status.configured) return "Not connected";
  if (!status.state && status.message) return "Status unavailable";
  if (status.state === "running") return "Running · billable";
  if (status.state === "pending") return "Starting · billable";
  return status.state ? status.state[0].toUpperCase() + status.state.slice(1) : "Configured";
}

function stateMessage(state: AwsWorkerStatus["state"]): string | undefined {
  return state ? `Worker ${state}.` : undefined;
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
