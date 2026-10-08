import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AwsAutoStopRow, AwsAutoStopSetupDialog } from "./aws-worker-auto-stop";
import { AwsConfirmDialog, AwsDialog, AwsWaiting } from "./aws-dialog";
import { cleanError, CONFIRM_TEXT, WorkerProgress } from "./aws-shared";
import { AwsSignInDialog } from "./aws-sign-in-dialog";
import { awsWorkerStateLabel, isAwsTransition } from "./use-aws-worker-status";
import type { AwsWorkerControl } from "./use-aws-worker-control";

const FAILED_PREFIX: Record<string, string> = {
  setup: "Start failed", resize: "The change failed", stop: "Stop failed", delete: "Delete failed"
};

/** The instance at a glance: its state, the one thing to do now, its size,
 *  and automatic stop. Start progress and its sign-ins show here too. */
export function AwsStatusSection(props: { control: AwsWorkerControl }): JSX.Element {
  const c = props.control;
  const [confirmStop, setConfirmStop] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [fixError, setFixError] = useState<string>();
  const status = c.status;
  const actual = c.actual;
  const transition = isAwsTransition(status) || c.monitor.awaitingStop;
  // An access check reads AWS only; the AWS access row shows it.
  const working = c.busy && (c.action === "setup" || c.action === "resize" || c.action === "delete") || c.showProgress && c.action !== "check";
  const workingLabel = c.action === "delete" ? "Deleting…" : c.action === "resize" ? "Applying…" : "Starting…";
  const tryAgain = c.attemptFailed && c.action === "setup";
  const showStop = status?.state === "running" && !transition;
  // A start that failed on a running instance keeps Stop beside its retry:
  // the instance bills while it runs.
  const showStart = !transition && (c.stoppedLike || tryAgain);
  const failure = c.feedback?.failed && c.feedback.action && c.feedback.action !== "check" && c.feedback.action !== "command"
    ? `${FAILED_PREFIX[c.feedback.action] ?? "Failed"}: ${c.feedback.message}` : undefined;
  const operation = c.currentOperation;
  const [closedSignIn, setClosedSignIn] = useState<string>();
  const signIn = operation?.phase === "setting-up" && operation.authUrl && operation.authRequestId !== closedSignIn ? operation : undefined;
  const problem = c.configured ? status?.autoStop?.problem : undefined;
  const fixProblem = async (): Promise<void> => {
    if (!problem) return;
    setFixing(true);
    setFixError(undefined);
    try { await c.autoStopControl.fix(problem); }
    catch (cause) { setFixError(cleanError(cause)); }
    finally { setFixing(false); }
  };

  return (
    <section className="gen-section">
      <div className="gen-card">
        <div className="gen-aws" data-testid="aws-worker-panel" aria-busy={c.locked}>
          <div className="gen-aws-summary" data-testid="aws-worker-actions">
            <div className="gen-aws-summary-main">
              <strong className={`gen-aws-state${c.isRunning ? " is-billable" : ""}`} data-testid="aws-worker-state">
                {awsWorkerStateLabel(status, Boolean(c.monitor.error))}
              </strong>
              <div className="gen-actions">
                {working ? (
                  <button type="button" className="gen-pill" data-testid="aws-worker-start" disabled>
                    <span className="gen-pill-label"><Loader2 size={14} className="gen-aws-spinner" aria-hidden /> {workingLabel}</span>
                  </button>
                ) : <>
                  {showStart ? (
                    <button type="button" className="gen-pill" data-testid="aws-worker-start" disabled={!c.canStart || c.locked}
                      onClick={() => void c.start(undefined, c.baseSpec, "setup")}>
                      <span className="gen-pill-label">{tryAgain ? "Try again" : "Start"}</span>
                    </button>
                  ) : null}
                  {showStop ? (
                    <button type="button" className="gen-pill" data-testid="aws-worker-stop" disabled={c.locked} onClick={() => setConfirmStop(true)}>
                      <span className="gen-pill-label">Stop</span>
                    </button>
                  ) : null}
                </>}
              </div>
            </div>
            {actual ? (
              <div className="gen-aws-specs" data-testid="aws-worker-actual-specs">
                <span>{actual.instanceType}</span>
                {actual.vCpu ? <span>{actual.vCpu} vCPU</span> : null}
                {actual.memoryMiB ? <span>{Math.round(actual.memoryMiB / 1024)} GB RAM</span> : null}
                <span>{actual.rootVolumeSizeGb} GiB disk</span>
                <span>{actual.region}</span>
              </div>
            ) : null}
            {transition ? <AwsTransitionLine control={c} /> : null}
            {failure ? <div className="gen-row-error" role="alert" data-testid="aws-worker-message">{failure}</div> : null}
          </div>
          {c.showProgress && operation && operation.intent !== "check" ? <WorkerProgress operation={operation} /> : null}
          {c.configured && status?.autoStop ? (
            <AwsAutoStopRow
              autoStop={status.autoStop}
              busy={c.autoStopControl.busy || c.locked}
              onToggle={c.autoStopControl.toggle}
              error={[problem?.message, fixError, c.autoStopError].filter(Boolean).join(" ") || undefined}
              fix={problem?.action ? { label: problem.actionLabel ?? "Fix", busy: fixing, onClick: () => void fixProblem() } : undefined}
            />
          ) : null}
        </div>
      </div>
      <AwsAutoStopSetupDialog mode={c.autoStopControl.setup} region={c.instanceRegion} onClose={c.autoStopControl.closeSetup} onEnabled={c.monitor.accept} />
      <AwsConfirmDialog
        open={confirmStop}
        title="Stop the instance?"
        description={CONFIRM_TEXT.stop}
        confirmLabel="Stop instance"
        testId="aws-stop-dialog"
        onClose={() => setConfirmStop(false)}
        onConfirm={() => { setConfirmStop(false); void c.stop(); }}
      />
      <AwsSizeDecisionDialog control={c} />
      <AwsSignInDialog open={Boolean(signIn)} provider={signIn?.authProvider === "claude-code" ? "claude-code" : "codex-cli"}
        request={signIn ?? undefined} onClose={() => setClosedSignIn(signIn?.authRequestId)} />
    </section>
  );
}

/** AWS has not confirmed a start or stop yet; the page keeps checking. */
function AwsTransitionLine(props: { control: AwsWorkerControl }): JSX.Element {
  const c = props.control;
  const stopping = c.monitor.awaitingStop || c.status?.state === "stopping";
  const [began] = useState(() => c.monitor.stopRequestedAt ?? (c.action === "stop" ? c.startedAt : undefined) ?? Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(timer); }, []);
  const seconds = Math.max(0, Math.floor((now - began) / 1_000));
  const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return (
    <div className="gen-row-desc" data-testid="aws-worker-transition" role="status">
      <AwsWaiting>{stopping ? "Waiting for AWS to confirm the stop" : "Waiting for AWS to confirm the start"} · {elapsed}</AwsWaiting>
      {c.monitor.error ? " Could not reach AWS just now; checking again by itself." : null}
    </div>
  );
}

/** A start or change found the instance at another size than asked: keep
 *  it, grow its disk, or replace it. Replacing is said before it is chosen.
 *  Closing it leaves everything as it is; Start asks again. */
function AwsSizeDecisionDialog(props: { control: AwsWorkerControl }): JSX.Element {
  const c = props.control;
  const mismatch = c.mismatch;
  const [closed, setClosed] = useState<string>();
  const decision = c.currentOperation?.phase === "needs-decision" ? `${c.currentOperation.operationId}:${c.currentOperation.updatedAt}` : undefined;
  const open = Boolean(mismatch) && decision !== closed;
  return (
    <AwsDialog
      open={open}
      title="Review the size change"
      testId="aws-worker-spec-decision"
      busy={c.locked}
      onClose={() => setClosed(decision)}
      description={mismatch ? <>
        The instance is {mismatch.actual.instanceType} with {mismatch.actual.rootVolumeSizeGb} GiB; {mismatch.desired.instanceType} with {mismatch.desired.rootVolumeSizeGb} GiB was asked for.
        {` Growing the disk keeps the instance and everything on it. ${CONFIRM_TEXT.recreate}`}
      </> : ""}
      actions={mismatch ? <>
        <Button type="button" variant="outline" size="sm" disabled={c.locked} onClick={() => setClosed(decision)}>Not now</Button>
        <Button type="button" variant="outline" size="sm" disabled={c.locked} onClick={() => void c.start("recreate", mismatch.desired, c.decisionIntent)}>Recreate</Button>
        {mismatch.diskTooSmall ? (
          <Button type="button" variant="outline" size="sm" disabled={c.locked} onClick={() => void c.start("grow-disk", mismatch.desired, c.decisionIntent)}>Grow disk</Button>
        ) : null}
        <Button type="button" size="sm" disabled={c.locked} onClick={() => void c.start("keep", mismatch.desired, c.decisionIntent)}>Keep current size</Button>
      </> : null}
    />
  );
}
