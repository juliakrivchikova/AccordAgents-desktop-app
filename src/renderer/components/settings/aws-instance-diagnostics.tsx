import { useEffect, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import type { AwsWorkerAutoStopProblem, CloudRunWorkerDoctorReport, CloudRunWorkerSetupProgress } from "../../../shared/types";
import { CloudProviderAuth } from "../cloud-provider-auth";
import { ipcErrorMessage } from "./aws-worker-auto-stop";

/**
 * Checks of the instance, and the one place a switched-on automatic stop
 * that cannot work says why. Each problem names what fixes it; a collapsed
 * section still shows that there is one.
 */
export function AwsInstanceDiagnostics(props: {
  autoStopProblem?: AwsWorkerAutoStopProblem;
  onAutoStopAction?: (problem: AwsWorkerAutoStopProblem) => Promise<void>;
} = {}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [fixError, setFixError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [failed, setFailed] = useState(false);
  const [report, setReport] = useState<CloudRunWorkerDoctorReport | null>(null);
  const [setupProgress, setSetupProgress] = useState<CloudRunWorkerSetupProgress | null>(null);

  useEffect(() => {
    let current = true;
    let received = false;
    const apply = (progress: CloudRunWorkerSetupProgress): void => {
      const finished = progress.stage === "complete" || progress.stage === "error";
      setBusy(!finished); setStatus(progress.message); setFailed(progress.stage === "error");
      setSetupProgress(finished ? null : progress);
    };
    const off = window.consensus.onCloudRunSetupProgress(progress => { received = true; if (current) apply(progress); });
    void window.consensus.getCloudRunSetupProgress?.().then(progress => { if (current && !received && progress) apply(progress); }).catch(() => undefined);
    return () => { current = false; off(); };
  }, []);

  const run = async (prepare: boolean): Promise<void> => {
    setBusy(true);
    setFailed(false);
    setStatus(prepare ? "Preparing the instance…" : "Checking the instance…");
    setReport(null);
    setSetupProgress(null);
    try {
      const result = prepare
        ? await window.consensus.setupCloudRunWorker(undefined)
        : await window.consensus.diagnoseCloudRunWorker(undefined);
      setReport(result);
      setStatus(result.message);
      setFailed(!result.ok);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      setFailed(true);
    } finally {
      setBusy(false);
      setSetupProgress(null);
    }
  };

  const problem = props.autoStopProblem;
  const fix = async (current: AwsWorkerAutoStopProblem): Promise<void> => {
    setFixing(true);
    setFixError(undefined);
    try { await props.onAutoStopAction?.(current); }
    catch (error) { setFixError(ipcErrorMessage(error)); }
    finally { setFixing(false); }
  };

  return (
    <div className="gen-aws-diagnostics">
      <button type="button" className="gen-aws-disclosure" data-testid="machine-instance-diagnostics-toggle" aria-expanded={open} aria-controls="aws-instance-diagnostics" onClick={() => setOpen(!open)}>
        <span>Diagnostics{problem ? <>{" "}<span className="gen-aws-diagnostics-badge" data-testid="machine-instance-diagnostics-problem-count">1 problem</span></> : null}</span>
        <ChevronDown size={16} aria-hidden />
      </button>
      {status ? (
        <div className={`gen-aws-feedback${failed ? " is-error" : ""}`} data-testid="machine-instance-diagnostics-status" role={failed ? "alert" : "status"}>
          {(busy && setupProgress?.message) || status}
          {busy && setupProgress?.authUrl ? (
            <CloudProviderAuth authUrl={setupProgress.authUrl} authCode={setupProgress.authCode} authProvider={setupProgress.authProvider} authRequestId={setupProgress.authRequestId} />
          ) : null}
        </div>
      ) : null}
      {open ? (
        <div id="aws-instance-diagnostics">
          {problem ? (
            <div className="gen-aws-problem" data-testid="aws-auto-stop-problem" role="alert">
              <div className="gen-aws-problem-text">
                <strong>Automatic stop is not working.</strong> {problem.message}
              </div>
              {fixError ? <div className="gen-aws-inline-error" role="alert">{fixError}</div> : null}
              {problem.action ? (
                <div className="gen-actions">
                  <button type="button" className="gen-pill" data-testid="aws-auto-stop-problem-action" disabled={fixing} onClick={() => void fix(problem)}>
                    {fixing ? <span className="gen-pill-lead"><Loader2 size={16} className="gen-aws-spinner" aria-hidden /></span> : null}
                    <span className="gen-pill-label">{fixing && problem.action === "reconnect" ? "Working…" : problem.actionLabel ?? "Fix"}</span>
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="gen-row gen-row-stack">
            <div className="gen-row-desc">Check the cloud runtime and provider sign-in, or set up missing components.</div>
            <div className="gen-actions">
              <button type="button" className="gen-pill" data-testid="machine-instance-check" disabled={busy} onClick={() => void run(false)}><span className="gen-pill-label">Check</span></button>
              <button type="button" className="gen-pill" data-testid="machine-instance-setup" disabled={busy} onClick={() => void run(true)}><span className="gen-pill-label">Set up</span></button>
            </div>
          </div>
          {report ? (
            <ul className="gen-doctor-list" aria-label="Instance checks">
              {report.checks.map((check) => (
                <li key={check.id} className={`gen-doctor-item is-${check.status}`}>
                  <span className="gen-doctor-mark" aria-hidden>{check.status === "pass" ? "\u2713" : check.status === "warn" ? "!" : "\u2715"}</span>
                  <span className="gen-doctor-label">{check.label}</span>
                  {check.detail ? <span className="gen-doctor-detail">{check.detail}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
