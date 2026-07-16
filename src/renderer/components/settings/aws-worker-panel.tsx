import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ChevronDown, Copy, Server } from "lucide-react";

import type {
  AwsWorkerOperationSnapshot,
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
    }).catch(() => undefined);
  }, []);

  useEffect(() => window.consensus.onAwsWorkerProgress((progress) => {
    if (!activeOperationId || progress.operationId === activeOperationId) setOperation(progress);
  }), [activeOperationId]);

  const loadCommand = async (): Promise<void> => {
    setBusy(true);
    try {
      setCommand(await window.consensus.getAwsWorkerBootstrapCommand(region.trim() || "us-east-1"));
    } finally {
      setBusy(false);
    }
  };

  const start = async (resolution?: AwsWorkerSpecResolution): Promise<void> => {
    const continuation = operation?.phase === "error" || operation?.phase === "needs-decision"
      ? operation
      : undefined;
    const operationId = continuation?.operationId ?? crypto.randomUUID();
    const clientToken = continuation?.clientToken ?? operationId;
    setActiveOperationId(operationId);
    setBusy(true);
    setConfirm(null);
    setActionMessage(undefined);
    try {
      const result = await window.consensus.startAwsWorker({
        operationId,
        clientToken,
        blob: blob.trim() || undefined,
        instanceType: props.settings.awsInstanceType,
        rootVolumeSizeGb: props.settings.awsRootVolumeSizeGb,
        resolution,
        expectedInstanceId: operation?.specMismatch?.instanceId,
        expectedDesiredSpec: resolution ? operation?.specMismatch?.desired : undefined
      });
      setOperation(result.operation);
      setStatus(result.status);
      if (result.status.configured) setBlob("");
    } finally {
      setBusy(false);
    }
  };

  const refresh = async (): Promise<void> => {
    setBusy(true);
    try {
      const next = await window.consensus.getAwsWorkerStatus();
      setStatus(next);
      setOperation(next.operation ?? operation);
      setActionMessage(next.message ?? stateMessage(next.state));
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
    try {
      const next = await window.consensus.stopAwsWorker();
      setStatus(next);
      setActionMessage(next.message ?? stateMessage(next.state));
      setConfirm(null);
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
    try {
      const next = await window.consensus.deleteAwsWorker();
      setStatus(next);
      setOperation(next.configured ? next.operation ?? operation : null);
      setActionMessage(next.message);
      setConfirm(null);
      if (!next.configured) await props.onDeleted();
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
  const mismatch = operation?.specMismatch;
  const needsAuthorizationRefresh = operation?.remediation === "refresh-aws-authorization";
  const showConnection = needsAuthorizationRefresh || !props.settings.hasAwsCredentials && !status?.configured;
  const canStart = Boolean(blob.trim() || props.settings.hasAwsCredentials || status?.configured);
  const isRunning = status?.state === "running" || status?.state === "pending";

  return (
    <div className="gen-aws" data-testid="aws-worker-panel">
      {showConnection ? (
        <>
          <div className="gen-row gen-row-stack" data-testid={needsAuthorizationRefresh ? "aws-worker-authorization-recovery" : "aws-worker-connect"}>
            <div className="gen-row-text">
              <div className="gen-row-title">{needsAuthorizationRefresh ? "Update AWS permissions" : "Connect AWS account"}</div>
              <div className="gen-row-desc">{needsAuthorizationRefresh
                ? "Run this command to refresh the scoped AWS policy, then paste its result and Retry."
                : "Run this scoped setup command once, then paste its result before starting the worker."}</div>
            </div>
            <div className="gen-grid-form gen-grid-form-compact">
              <input className="gen-input" aria-label="AWS region" value={region} onChange={(event) => setRegion(event.target.value)} />
              <button type="button" className="gen-pill" disabled={busy} onClick={() => void loadCommand()}>
                <span className="gen-pill-label">Show setup command</span>
              </button>
            </div>
          </div>
          {command ? (
            <div className="gen-aws-command-box">
              <button type="button" className="gen-aws-copy" aria-label="Copy AWS setup command" onClick={() => void copyCommand()}>
                {copyFeedback === "copied" ? <CheckCircle2 size={14} /> : <Copy size={14} />}
                <span>{copyFeedback === "copied" ? "Copied" : copyFeedback === "failed" ? "Copy failed" : "Copy"}</span>
              </button>
              <pre className="gen-aws-command" data-testid="aws-worker-command">{command}</pre>
            </div>
          ) : null}
          <div className="gen-card-divider" />
          <div className="gen-row gen-row-stack">
            <div className="gen-row-text">
              <div className="gen-row-title">{needsAuthorizationRefresh ? "Paste the updated result" : "Paste the result"}</div>
              <div className="gen-row-desc">The command prints a line beginning with <code>accord-aws-v1:</code>.</div>
            </div>
            <textarea className="gen-input gen-aws-paste" aria-label="AWS setup result" value={blob} onChange={(event) => setBlob(event.target.value)} />
          </div>
        </>
      ) : null}

      <div className="gen-card-divider" />
      <div className="gen-row gen-row-stack">
        <div className="gen-row-text">
          <div className="gen-row-title">Required worker size</div>
          <div className="gen-row-desc">Existing larger workers are adopted. Smaller workers always require your choice.</div>
        </div>
        <div className="gen-grid-form gen-grid-form-compact">
          <label className="gen-select-wrap">
            <select className="gen-input" aria-label="AWS worker instance type" disabled={busy || operation?.phase === "needs-decision"} value={props.settings.awsInstanceType} onChange={(event) => props.onInstanceTypeChange(event.target.value)}>
              {AWS_WORKER_INSTANCE_TYPE_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <ChevronDown size={16} />
          </label>
          <label className="gen-select-wrap">
            <select className="gen-input" aria-label="AWS worker disk size" disabled={busy || operation?.phase === "needs-decision"} value={props.settings.awsRootVolumeSizeGb} onChange={(event) => props.onDiskSizeChange(normalizeAwsRootVolumeSizeGb(event.target.value))}>
              {diskOptions.map((value) => <option key={value} value={value}>{value} GB</option>)}
            </select>
            <ChevronDown size={16} />
          </label>
        </div>
      </div>

      {actual ? (
        <div className="gen-aws-specs" data-testid="aws-worker-actual-specs">
          <span>{actual.instanceId}</span><span>{actual.region}</span><span>{actual.instanceType}</span>
          {actual.vCpu ? <span>{actual.vCpu} vCPU</span> : null}
          {actual.memoryMiB ? <span>{Math.round(actual.memoryMiB / 1024)} GB RAM</span> : null}
          <span>{actual.rootVolumeSizeGb} GB disk</span>
          {isRunning ? <strong>Running · billable</strong> : <span>{status?.state ?? "unknown"}</span>}
        </div>
      ) : null}

      {operation ? <WorkerProgress operation={operation} /> : null}

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

      <div className="gen-row">
        <div className="gen-row-text">
          <div className="gen-row-title">{actionMessage ?? operation?.message ?? status?.message ?? (status?.configured ? "Shared worker configured" : "Not connected")}</div>
          <div className="gen-row-desc">This worker is shared by every configured laptop and project. It does not stop automatically.</div>
        </div>
        <div className="gen-actions">
          <button type="button" className="gen-pill" data-testid="aws-worker-start" disabled={busy || !canStart} onClick={() => void start()}>
            <span className="gen-pill-lead"><Server size={16} /></span>
            <span className="gen-pill-label">{operation?.phase === "error" ? "Retry" : "Start worker"}</span>
          </button>
          {status?.configured ? <button type="button" className="gen-pill" disabled={busy} onClick={() => void refresh()}><span className="gen-pill-label">Refresh</span></button> : null}
          {status?.configured ? <button type="button" className="gen-pill" disabled={busy || !isRunning} onClick={() => void stop()}><span className="gen-pill-label">Stop</span></button> : null}
          {status?.configured ? <button type="button" className="gen-pill gen-pill-danger" disabled={busy} onClick={() => void remove()}><span className="gen-pill-label">Delete</span></button> : null}
        </div>
      </div>
    </div>
  );
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
