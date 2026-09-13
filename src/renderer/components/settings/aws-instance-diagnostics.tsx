import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { CloudRunWorkerDoctorReport, CloudRunWorkerSetupProgress } from "../../../shared/types";

export function AwsInstanceDiagnostics(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [failed, setFailed] = useState(false);
  const [report, setReport] = useState<CloudRunWorkerDoctorReport | null>(null);
  const [setupProgress, setSetupProgress] = useState<CloudRunWorkerSetupProgress | null>(null);

  useEffect(() => window.consensus.onCloudRunSetupProgress(setSetupProgress), []);

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

  return (
    <div className="gen-aws-diagnostics">
      <button type="button" className="gen-aws-disclosure" data-testid="machine-instance-diagnostics-toggle" aria-expanded={open} aria-controls="aws-instance-diagnostics" onClick={() => setOpen(!open)}>
        <span>Diagnostics</span><ChevronDown size={16} aria-hidden />
      </button>
      {status ? (
        <div className={`gen-aws-feedback${failed ? " is-error" : ""}`} data-testid="machine-instance-diagnostics-status" role={failed ? "alert" : "status"}>
          {(busy && setupProgress?.message) || status}
          {busy && setupProgress?.authUrl ? (
            <div className="gen-row-desc">
              <button type="button" className="gen-doctor-auth-link" onClick={() => void window.consensus.openExternal(setupProgress.authUrl as string)}>Open the sign-in page</button>
              {setupProgress.authCode ? <> and enter code <code className="gen-doctor-auth-code" data-testid="cloud-run-device-auth-code">{setupProgress.authCode}</code></> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {open ? (
        <div id="aws-instance-diagnostics">
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
