import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { AwsWorkerOperationSnapshot, AwsWorkerStatus } from "../../../shared/types";
import type { MachineListResult } from "../../../shared/machineLink";

export function AwsWorkerTransition(props: { state: string; since?: number; checkedAt?: number; checking: boolean; error?: string }): JSX.Element {
  const [began] = useState(() => props.since ?? Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(timer); }, []);
  const seconds = Math.max(0, Math.floor((now - began) / 1_000));
  const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return <div className="gen-aws-feedback" data-testid="aws-worker-transition" role="status">
    <strong><Loader2 size={14} className="gen-aws-spinner" aria-hidden /> {props.state === "stopping" ? "Waiting for AWS to confirm Stop" : "Waiting for AWS to confirm startup"} · watching {elapsed}</strong>
    <div>{seconds >= 120 ? "AWS has not confirmed completion yet. Still checking automatically." : "Waiting for confirmation from AWS. This panel updates automatically."}</div>
    <div className="gen-row-desc">{props.error ? "Could not refresh AWS; showing the last confirmed state. Retrying automatically." : props.checking ? "Checking AWS…" : props.checkedAt ? `Last confirmed ${new Date(props.checkedAt).toLocaleTimeString()}` : "Waiting for the first status update…"}</div>
  </div>;
}

export function AwsWorkerHistory(props: { operation?: AwsWorkerOperationSnapshot | null }): JSX.Element | null {
  if (!props.operation || !["ready", "error", "needs-decision"].includes(props.operation.phase)) return null;
  const message = props.operation.phase === "error" && props.operation.remediation === "refresh-aws-authorization"
    ? "AWS permissions were insufficient for this attempt." : props.operation.message;
  return <details className="gen-aws-history" data-testid="aws-worker-history">
    <summary className="gen-aws-disclosure">Activity history · last setup attempt</summary>
    <div className="gen-row gen-row-stack">
      <strong>{props.operation.intent === "resize" ? "Change instance size" : "Start / set up instance"} · {new Date(props.operation.updatedAt).toLocaleString()}</strong>
      <span>{props.operation.phase === "error" ? "Failed" : props.operation.phase === "needs-decision" ? "Not applied" : "Completed"}: {message}</span>
      <span className="gen-row-desc">Saved result of that operation, not a current AWS status check.</span>
    </div>
  </details>;
}

export function AwsCloudRunReadiness({ status }: { status: AwsWorkerStatus | null }): JSX.Element {
  const [machines, setMachines] = useState<MachineListResult>();
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let version = 0;
    void window.consensus.listMachines().then(value => { if (!cancelled && version === 0) setMachines(value); }).catch(() => { if (!cancelled && version === 0) setUnavailable(true); });
    const off = window.consensus.onMachinesUpdated(value => { version++; if (!cancelled) { setMachines(value); setUnavailable(false); } });
    return () => { cancelled = true; off(); };
  }, []);
  const id = status?.actualSpec?.instanceId ?? status?.handle?.instanceId;
  const machine = id ? machines?.machines.find(item => item.awsInstanceId === id) : undefined;
  const link = machines?.status.find(item => item.machineId === machine?.id);
  const text = !status?.configured ? "Connect AWS to use Cloud run."
    : status.state === "stopping" || status.state === "stopped" ? "Cloud Run: unavailable while the instance is stopped or stopping."
      : status.state !== "running" ? "Cloud Run: waiting for the instance."
        : link?.connected ? "Cloud Run: connected. Provider sign-in is checked when you select Cloud run."
          : unavailable ? "Cloud Run: connection could not be checked."
            : !machines ? "Cloud Run: checking connection…"
              : machine ? "Cloud Run: reconnecting to this instance…"
                : "Cloud Run: select it in a member’s settings to finish setup automatically.";
  return <div className="gen-row-desc" data-testid="aws-cloud-run-readiness">{text}</div>;
}
