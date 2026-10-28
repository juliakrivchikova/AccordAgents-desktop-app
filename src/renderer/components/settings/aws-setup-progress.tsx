import { useEffect, useState } from "react";
import { Check, Loader2, Minus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AwsSetupStep, AwsWorkerOperationSnapshot } from "../../../shared/types";
import { CopyButton } from "../primitives";
import { AwsDialog, AwsWaiting } from "./aws-dialog";
import { cleanError } from "./aws-shared";
import type { AwsWorkerControl } from "./use-aws-worker-control";

const STEP_LABEL: Record<AwsSetupStep["id"], string> = {
  "instance": "AWS instance",
  "tools": "Tools the agents use",
  "sign-in-codex": "Sign in to Codex",
  "sign-in-claude": "Sign in to Claude Code",
  "program": "Cloud program"
};
const LIVE = new Set<AwsWorkerOperationSnapshot["phase"]>(["starting", "waiting-running", "setting-up"]);

/** A start or setup the User can follow step by step. */
export function setupOperation(control: AwsWorkerControl): AwsWorkerOperationSnapshot | undefined {
  const operation = control.currentOperation;
  return operation && operation.intent !== "check" && operation.setupSteps?.length ? operation : undefined;
}

/**
 * Whether the setup dialog shows. Hiding it leaves the setup running; a new
 * sign-in brings it back, because the setup then waits on the User.
 */
export function useAwsSetupView(control: AwsWorkerControl) {
  const operation = setupOperation(control);
  const [hidden, setHidden] = useState<{ operationId: string; authRequestId?: string }>();
  const live = Boolean(operation && LIVE.has(operation.phase));
  const waitsOnUser = Boolean(live && operation?.authRequestId && operation.authRequestId !== hidden?.authRequestId);
  const open = Boolean(operation) && (hidden?.operationId !== operation?.operationId || waitsOnUser);
  return {
    operation,
    live,
    open,
    hide: () => { if (operation) setHidden({ operationId: operation.operationId, authRequestId: operation.authRequestId }); },
    show: () => setHidden(undefined)
  };
}

export type AwsSetupView = ReturnType<typeof useAwsSetupView>;

/** One line beside the instance while the setup runs with its dialog hidden. */
export function AwsSetupProgressLine(props: { view: AwsSetupView }): JSX.Element | null {
  const { operation, live, open } = props.view;
  if (!operation || !live || open) return null;
  const current = operation.setupSteps?.find((step) => step.state === "current");
  return (
    <div className="gen-row-desc gen-aws-setup-line" data-testid="aws-setup-progress-line" role="status">
      <AwsWaiting>{current ? `${STEP_LABEL[current.id]}: ${current.detail ?? operation.message}` : operation.message}</AwsWaiting>
      <button type="button" className="gen-aws-setup-link" data-testid="aws-setup-progress-show" onClick={props.view.show}>Show steps</button>
    </div>
  );
}

/**
 * Setting the AWS instance up, step by step: the instance, the tools, each
 * agent's sign-in (which can be skipped) and the cloud program. The step
 * that runs says what it is doing and for how long; one that waits on the
 * User shows what to do right in its row.
 */
export function AwsSetupProgressDialog(props: { control: AwsWorkerControl; view: AwsSetupView }): JSX.Element | null {
  const { operation, live, open } = props.view;
  const now = useNow(live);
  if (!operation) return null;
  const steps = operation.setupSteps ?? [];
  const failed = operation.phase === "error";
  // A start of an instance already set up has no sign-ins and no program to install.
  const settingUp = steps.some((step) => step.id === "program");
  const title = live ? settingUp ? "Setting up the AWS instance" : "Starting the AWS instance"
    : failed ? settingUp ? "The setup stopped" : "The start stopped" : "The AWS instance is ready";
  const description = live
    ? "Each step shows here as it runs. Hiding this window does not stop the setup."
    : operation.message;
  const retry = failed && (operation.intent ?? "setup") === "setup";
  return (
    <AwsDialog
      open={open}
      title={title}
      testId="aws-setup-progress"
      dismissible={!live}
      onClose={props.view.hide}
      description={<span data-testid="aws-setup-progress-message">{description}</span>}
      actions={live ? (
        <Button type="button" variant="outline" size="sm" data-testid="aws-setup-progress-hide" onClick={props.view.hide}>Hide</Button>
      ) : <>
        {retry ? <Button type="button" variant="outline" size="sm" onClick={props.view.hide}>Close</Button> : null}
        <Button type="button" size="sm" data-testid={retry ? "aws-setup-progress-retry" : "aws-setup-progress-done"} disabled={props.control.locked}
          onClick={() => {
            if (!retry) { props.view.hide(); return; }
            void props.control.start(undefined, props.control.baseSpec, "setup");
          }}>
          {retry ? "Try again" : "Done"}
        </Button>
      </>}
    >
      <ol className="gen-aws-steps" data-testid="aws-setup-steps">
        {steps.map((step) => (
          <li key={step.id} className={`gen-aws-step is-${step.state}`} data-testid={`aws-setup-step-${step.id}`} data-state={step.state}>
            <span className="gen-aws-step-mark" aria-hidden><StepMark state={step.state} /></span>
            <div className="gen-aws-step-text">
              <div className="gen-aws-step-title">
                {STEP_LABEL[step.id]}
                {step.state === "current" && step.startedAt ? <span className="gen-aws-step-time">{elapsed(now, step.startedAt)}</span> : null}
              </div>
              {/* A sign-in on screen says itself what to do. */}
              {stepDetail(step) && !(step.state === "current" && signInFor(step, operation) && operation.authUrl)
                ? <div className={step.state === "failed" ? "gen-row-error" : "gen-aws-step-detail"}>{stepDetail(step)}</div> : null}
              {step.state === "current" && signInFor(step, operation) ? <SignInPanel operation={operation} /> : null}
            </div>
          </li>
        ))}
      </ol>
    </AwsDialog>
  );
}

function StepMark(props: { state: AwsSetupStep["state"] }): JSX.Element {
  if (props.state === "done") return <Check size={14} />;
  if (props.state === "current") return <Loader2 size={14} className="gen-aws-spinner" />;
  if (props.state === "failed") return <X size={14} />;
  if (props.state === "skipped") return <Minus size={14} />;
  return <span className="gen-aws-step-dot" />;
}

/** What a step says; a skipped sign-in also says where to do it later. */
function stepDetail(step: AwsSetupStep): string | undefined {
  if (step.state === "pending") return undefined;
  if (step.state === "skipped" && step.id.startsWith("sign-in-")) {
    const name = step.id === "sign-in-codex" ? "Codex" : "Claude Code";
    return `${step.detail ?? "Not signed in."} Sign in later from Setup on the AWS page; until then ${name} members cannot run in the cloud.`;
  }
  return step.detail;
}

function signInFor(step: AwsSetupStep, operation: AwsWorkerOperationSnapshot): boolean {
  if (!operation.authRequestId) return false;
  return step.id === (operation.authProvider === "claude-code" ? "sign-in-claude" : "sign-in-codex");
}

/**
 * The provider's own sign-in, in its row: Codex shows a one-time code to
 * enter on its page; Claude Code approves in the browser and gives a code to
 * paste back. Skip ends it; the setup goes on without that agent.
 */
function SignInPanel(props: { operation: AwsWorkerOperationSnapshot }): JSX.Element {
  const { operation } = props;
  const claude = operation.authProvider === "claude-code";
  const requestId = operation.authRequestId ?? "";
  const [code, setCode] = useState("");
  const [state, setState] = useState<"input" | "submitting" | "submitted" | "skipping">("input");
  const [error, setError] = useState<string>();
  useEffect(() => { setCode(""); setState("input"); setError(undefined); }, [requestId]);

  const openPage = async (): Promise<void> => {
    if (!operation.authUrl) return;
    setError(undefined);
    try { await window.consensus.openExternal(operation.authUrl); }
    catch { setError(`Could not open the sign-in page: ${operation.authUrl}`); }
  };
  const finish = async (): Promise<void> => {
    if (!code.trim() || state !== "input") return;
    setState("submitting");
    setError(undefined);
    try {
      await window.consensus.submitCloudRunAuthCode({ requestId, code });
      setCode("");
      setState("submitted");
    } catch (cause) {
      setError(cleanError(cause));
      setState("input");
    }
  };
  const skip = async (): Promise<void> => {
    setState("skipping");
    setError(undefined);
    try { await window.consensus.cancelCloudRunAuth(requestId); }
    catch (cause) { setError(cleanError(cause)); setState("input"); }
  };
  const ready = Boolean(operation.authUrl);
  return (
    <div className="gen-aws-sign-in" data-testid="aws-setup-sign-in">
      {!ready ? null : claude ? (
        <>
          <div className="gen-aws-step-detail">The same sign-in as /login in Claude Code: open the sign-in page, approve access, then paste the code Claude shows.</div>
          <label className="gen-aws-field">
            <span>Code from Claude</span>
            <input className="gen-input" type="password" autoComplete="off" spellCheck={false} aria-label="Code from Claude"
              data-testid="aws-setup-sign-in-code-input" placeholder="Paste the code" maxLength={4096} value={code}
              disabled={state !== "input"} onChange={(event) => setCode(event.currentTarget.value)} />
          </label>
        </>
      ) : operation.authCode ? (
        <>
          <div className="gen-aws-step-detail">The same sign-in as codex login: open the sign-in page and enter this code there.</div>
          <div className="gen-aws-code">
            <code data-testid="aws-setup-sign-in-code">{operation.authCode}</code>
            <CopyButton text={operation.authCode} label="Copy sign-in code" />
          </div>
        </>
      ) : null}
      {state === "submitted" ? <AwsWaiting>Waiting for Claude to confirm…</AwsWaiting> : null}
      {state === "skipping" ? <AwsWaiting>Skipping…</AwsWaiting> : null}
      {error ? <div className="gen-row-error" role="alert">{error}</div> : null}
      <div className="gen-aws-sign-in-actions">
        {ready ? <Button type="button" variant="outline" size="sm" data-testid="aws-setup-sign-in-open" onClick={() => void openPage()}>Open sign-in page</Button> : null}
        {ready && claude ? (
          <Button type="button" variant="outline" size="sm" data-testid="aws-setup-sign-in-finish" disabled={!code.trim() || state !== "input"} onClick={() => void finish()}>
            {state === "submitting" ? <Loader2 size={14} className="gen-aws-spinner" aria-hidden /> : null}
            Finish sign-in
          </Button>
        ) : null}
        <Button type="button" variant="outline" size="sm" data-testid="aws-setup-sign-in-skip" disabled={state === "skipping" || state === "submitting"} onClick={() => void skip()}>Skip</Button>
      </div>
    </div>
  );
}

/** Ticks once a second while something runs, so its time moves on screen. */
function useNow(running: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

function elapsed(now: number, since: string): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1_000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
