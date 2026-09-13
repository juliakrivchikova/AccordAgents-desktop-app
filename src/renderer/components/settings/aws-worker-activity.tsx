import { useEffect, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
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

/** A previous attempt that did not complete, kept out of the way. A completed
 *  one is not news, and an attempt shown live above is not history. */
export function AwsWorkerHistory(props: { operation?: AwsWorkerOperationSnapshot | null }): JSX.Element | null {
  const operation = props.operation;
  if (!operation || operation.phase !== "error" && operation.phase !== "needs-decision") return null;
  const message = operation.phase === "error" && operation.remediation === "refresh-aws-authorization"
    ? "AWS permissions were insufficient for this attempt."
    : operation.message;
  const outcome = operation.phase === "error" ? "failed" : "not applied";
  return <details className="gen-aws-history" data-testid="aws-worker-history">
    <summary className="gen-aws-disclosure"><span>Previous attempt {outcome} · {new Date(operation.updatedAt).toLocaleString()}</span><ChevronDown size={16} aria-hidden /></summary>
    <div className="gen-row gen-row-stack">
      <strong>{operation.intent === "resize" ? "Change instance size" : "Start / set up instance"}</strong>
      <span>{message}</span>
      <span className="gen-row-desc">Saved result of that attempt, not a current AWS status check.</span>
    </div>
  </details>;
}

/** The one thing to do next for Cloud run, when there is one. The state line
 *  above already says stopped, starting or stopping; this does not repeat it. */
export function AwsCloudRunNextStep({ status }: { status: AwsWorkerStatus | null }): JSX.Element | null {
  const [machines, setMachines] = useState<MachineListResult>();
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let version = 0;
    void window.consensus.listMachines().then(value => { if (!cancelled && version === 0) setMachines(value); }).catch(() => { if (!cancelled && version === 0) setUnavailable(true); });
    const off = window.consensus.onMachinesUpdated(value => { version++; if (!cancelled) { setMachines(value); setUnavailable(false); } });
    return () => { cancelled = true; off(); };
  }, []);
  if (!status?.configured) return null;
  const id = status.actualSpec?.instanceId ?? status.handle?.instanceId;
  const machine = id ? machines?.machines.find(item => item.awsInstanceId === id) : undefined;
  const link = machines?.status.find(item => item.machineId === machine?.id);
  const text = status.state === "stopped" ? "Start the instance to use Cloud run."
    : status.state !== "running" ? undefined
      : link?.connected ? "Cloud run: connected."
        : unavailable ? "Cloud run: connection could not be checked."
          : !machines ? "Cloud run: checking connection…"
            : machine ? "Cloud run: reconnecting to this instance…"
              : "Cloud run: select it in a member’s settings to finish setup automatically.";
  return text ? <div className="gen-row-desc" data-testid="aws-cloud-run-readiness">{text}</div> : null;
}
