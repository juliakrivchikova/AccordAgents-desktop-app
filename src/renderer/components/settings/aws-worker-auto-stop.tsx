import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AwsWorkerAutoStop, AwsWorkerAutoStopProblem, AwsWorkerStatus } from "../../../shared/types";
import { AwsCommandBox, AwsDialog } from "./aws-dialog";
import { ADMIN_COMMAND_TEXT, AwsPasteField, cleanError } from "./aws-shared";

/**
 * What the switch and the fix in its row do. On with a saved key is
 * immediate; on without one opens the setup dialog, and the switch turns on
 * only once that is applied. `report` gets a failure to show, or nothing when
 * one is cleared.
 */
export function useAwsAutoStop(
  autoStop: AwsWorkerAutoStop | undefined,
  accept: (status: AwsWorkerStatus) => void,
  report: (cause?: unknown) => void
): {
  busy: boolean;
  setup: AutoStopSetupMode | undefined;
  closeSetup: () => void;
  toggle: (enabled: boolean) => void;
  fix: (problem: AwsWorkerAutoStopProblem) => Promise<void>;
} {
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState<AutoStopSetupMode>();
  const toggle = (enabled: boolean): void => {
    if (enabled && autoStop?.needsSetup) { setSetup("turn-on"); return; }
    setBusy(true);
    report();
    window.consensus.setAwsAutoStop({ enabled }).then(accept, (cause) => report(new Error(cleanError(cause))))
      .finally(() => setBusy(false));
  };
  const fix = async (problem: AwsWorkerAutoStopProblem): Promise<void> => {
    if (problem.action === "set-up-again") { setSetup("set-up-again"); return; }
    accept(await window.consensus.reconnectAwsMachine(problem.machineId));
  };
  return { busy, setup, closeSetup: () => setSetup(undefined), toggle, fix };
}

/** Turning the switch on, or replacing a key AWS no longer accepts. */
export type AutoStopSetupMode = "turn-on" | "set-up-again";

/**
 * Automatic stop is one switch. Agents working keep the instance up by
 * design; anything else that keeps a switched-on instance from stopping is a
 * red line in this row, with its own way to fix it beside the switch.
 */
export function AwsAutoStopRow(props: {
  autoStop: AwsWorkerAutoStop;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  /** Why a switched-on automatic stop cannot work, and what fixes it. */
  error?: string;
  fix?: { label: string; busy: boolean; onClick: () => void };
}): JSX.Element {
  return (
    <div className="gen-row gen-aws-auto-stop" data-testid="aws-worker-auto-stop">
      <div className="gen-row-text">
        <div className="gen-row-title">Automatic stop</div>
        <div className="gen-row-desc">Stops the instance after three hours without working agents.</div>
        {props.error ? <div className="gen-row-error" data-testid="aws-auto-stop-problem">{props.error}</div> : null}
      </div>
      {props.fix ? (
        <div className="gen-actions">
          <button type="button" className="gen-pill" data-testid="aws-auto-stop-problem-action" disabled={props.fix.busy} onClick={props.fix.onClick}>
            <span className="gen-pill-label">{props.fix.busy ? "Working…" : props.fix.label}</span>
          </button>
        </div>
      ) : null}
      <label className="toggle">
        <input
          type="checkbox"
          data-testid="aws-worker-auto-stop-toggle"
          aria-label="Automatic stop"
          checked={props.autoStop.enabled}
          disabled={props.busy}
          onChange={(event) => props.onToggle(event.target.checked)}
        />
        <span />
      </label>
    </div>
  );
}

/**
 * Everything turning automatic stop on needs, in one place: the setup command
 * for the instance's region, ready to copy, and the box for its result. The
 * switch shows on once the result is applied, not before.
 */
export function AwsAutoStopSetupDialog(props: {
  mode: AutoStopSetupMode | undefined;
  region: string;
  onClose: () => void;
  onEnabled: (status: AwsWorkerStatus) => void;
}): JSX.Element {
  const open = Boolean(props.mode);
  const [command, setCommand] = useState("");
  const [commandError, setCommandError] = useState<string>();
  const [blob, setBlob] = useState("");
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string>();

  // Loaded once per opening: a status refresh while it is open must not
  // replace the command or clear what was pasted.
  useEffect(() => {
    if (!open) return;
    let current = true;
    setCommand("");
    setCommandError(undefined);
    setBlob("");
    setError(undefined);
    window.consensus.getAwsWorkerBootstrapCommand(props.region).then(
      (text) => { if (current) setCommand(text); },
      (cause) => { if (current) setCommandError(cleanError(cause)); }
    );
    return () => { current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const apply = async (): Promise<void> => {
    setApplying(true);
    setError(undefined);
    try {
      const status = await window.consensus.setAwsAutoStop({ enabled: true, blob: blob.trim() });
      props.onEnabled(status);
      props.onClose();
    } catch (cause) {
      setError(cleanError(cause));
    } finally {
      setApplying(false);
    }
  };

  return (
    <AwsDialog
      open={open}
      title={props.mode === "set-up-again" ? "Set up automatic stop again" : "Turn on automatic stop"}
      testId="aws-worker-auto-stop-dialog"
      busy={applying}
      onClose={props.onClose}
      description={props.mode === "set-up-again"
        ? `AWS no longer accepts the key the instance stops itself with. ${ADMIN_COMMAND_TEXT} to make a new one, then paste its result here.`
        : `The instance will stop by itself after three hours without working agents, even when this app is closed. ${ADMIN_COMMAND_TEXT}, then paste its result here.`}
      actions={<>
        <Button type="button" variant="outline" size="sm" disabled={applying} onClick={props.onClose}>Cancel</Button>
        <Button type="button" size="sm" data-testid="aws-worker-auto-stop-apply" disabled={applying || !blob.trim()} onClick={() => void apply()}>
          {applying ? <Loader2 size={14} className="gen-aws-spinner" aria-hidden /> : null}
          {applying ? "Applying…" : props.mode === "set-up-again" ? "Apply" : "Turn on"}
        </Button>
      </>}
    >
      <AwsCommandBox command={command} error={commandError} label="Copy AWS setup command" testId="aws-worker-auto-stop-command" />
      <AwsPasteField value={blob} disabled={applying} onChange={setBlob} />
      {error ? <div className="gen-row-error" role="alert" data-testid="aws-worker-auto-stop-error">{error}</div> : null}
    </AwsDialog>
  );
}
