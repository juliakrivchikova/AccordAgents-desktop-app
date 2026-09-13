import { CheckCircle2, Copy } from "lucide-react";
import type { AwsWorkerOperationSnapshot } from "../../../shared/types";
import type { ClipboardWriteResult } from "../../../shared/clipboard";

export function AwsWorkerConnectionForm(props: {
  operation: AwsWorkerOperationSnapshot | null;
  busy: boolean;
  region: string;
  command: string;
  blob: string;
  copyFeedback: "idle" | ClipboardWriteResult;
  onRegionChange: (value: string) => void;
  onBlobChange: (value: string) => void;
  onLoadCommand: () => Promise<void>;
  onCopyCommand: () => Promise<void>;
  /** Starts the instance with the pasted result: the first connection and the
   *  retry after a permission update are the same call. */
  onApply: () => Promise<void>;
}): JSX.Element {
  const recovery = props.operation?.remediation === "refresh-aws-authorization";
  const updatesExistingUser = recovery && Boolean(props.operation?.awsPrincipalUserName);
  return (
    <div className="gen-aws-connection" data-testid={recovery ? "aws-worker-authorization-recovery" : "aws-worker-connect"}>
      <div className="gen-row gen-row-stack">
        <div className="gen-row-text">
          <div className="gen-row-title">{recovery ? "AWS administrator update required" : "Connect AWS account"}</div>
          {recovery ? (
            <div className="gen-row-desc" data-testid="aws-worker-authorization-steps">
              {updatesExistingUser ? (
                <>
                  The active worker IAM user <code>{props.operation?.awsPrincipalUserName}</code> is missing required permissions{props.operation?.missingAwsActions?.length ? <>: <code>{props.operation.missingAwsActions.join(", ")}</code></> : null}.<br />
                  1. Select Show update command, then Copy.<br />
                  2. Run it in Terminal using an AWS administrator account. It updates that user's policy in place and does not create a new key.<br />
                  3. Return here and select Try again.
                </>
              ) : (
                <>
                  The restricted worker credentials cannot update their own permissions.<br />
                  1. Select Show setup command, then Copy.<br />
                  2. Run it in Terminal using an AWS administrator account. If you do not have one, send the copied command to your AWS administrator.<br />
                  3. Paste its <code>accord-aws-v1:</code> result here, then select Apply update and try again.
                </>
              )}
            </div>
          ) : (
            <div className="gen-row-desc">Run this setup command once in Terminal, then paste its result here.</div>
          )}
        </div>
        <div className="gen-grid-form">
          <label className="gen-aws-field">
            <span>Region</span>
            <input className="gen-input" aria-label="AWS region" value={props.region} disabled={props.busy} onChange={(event) => props.onRegionChange(event.target.value)} />
          </label>
          <button type="button" className="gen-pill" disabled={props.busy} onClick={() => void props.onLoadCommand()}>
            <span className="gen-pill-label">{updatesExistingUser ? "Show update command" : "Show setup command"}</span>
          </button>
        </div>
      </div>
      {props.command ? (
        <div className="gen-aws-command-box">
          <button type="button" className="gen-aws-copy" aria-label="Copy AWS setup command" onClick={() => void props.onCopyCommand()}>
            {props.copyFeedback === "copied" ? <CheckCircle2 size={14} /> : <Copy size={14} />}
            <span>{props.copyFeedback === "copied" ? "Copied" : props.copyFeedback === "failed" ? "Copy failed" : "Copy"}</span>
          </button>
          <pre className="gen-aws-command" data-testid="aws-worker-command">{props.command}</pre>
        </div>
      ) : null}
      {!updatesExistingUser ? (
        <div className="gen-row gen-row-stack">
          <label className="gen-aws-field">
            <span>{recovery ? "Paste the updated result" : "Paste the result"}</span>
            <textarea className="gen-input gen-aws-paste" aria-label="AWS setup result" placeholder="accord-aws-v1:…" value={props.blob} disabled={props.busy} onChange={(event) => props.onBlobChange(event.target.value)} />
          </label>
          <div className="gen-actions">
            <button type="button" className="gen-pill" data-testid={recovery ? "aws-worker-apply-authorization" : "aws-worker-connect-start"} disabled={props.busy || !props.blob.trim()} onClick={() => void props.onApply()}>
              <span className="gen-pill-label">{recovery ? "Apply update and try again" : "Connect and start instance"}</span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
