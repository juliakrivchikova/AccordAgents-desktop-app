import { useEffect, useState } from "react";
import { CheckCircle2, Copy, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { AwsWorkerAutoStop, AwsWorkerAutoStopProblem, AwsWorkerStatus } from "../../../shared/types";
import { writeClipboardText, type ClipboardWriteResult } from "../../../shared/clipboard";

/**
 * What the switch and Diagnostics do. On with a saved key is immediate; on
 * without one opens the setup dialog, and the switch turns on only once that
 * is applied. `report` gets a failure to show, or nothing when one is cleared.
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
  fix: (action: NonNullable<AwsWorkerAutoStopProblem["action"]>) => Promise<void>;
} {
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState<AutoStopSetupMode>();
  const toggle = (enabled: boolean): void => {
    if (enabled && autoStop?.needsSetup) { setSetup("turn-on"); return; }
    setBusy(true);
    report();
    window.consensus.setAwsAutoStop({ enabled }).then(accept, (cause) => report(new Error(ipcErrorMessage(cause))))
      .finally(() => setBusy(false));
  };
  const fix = async (action: NonNullable<AwsWorkerAutoStopProblem["action"]>): Promise<void> => {
    if (action === "set-up-again") { setSetup("set-up-again"); return; }
    accept(await window.consensus.reconnectAwsMachine());
  };
  return { busy, setup, closeSetup: () => setSetup(undefined), toggle, fix };
}

/** Turning the switch on, or replacing a key AWS no longer accepts. */
export type AutoStopSetupMode = "turn-on" | "set-up-again";

/**
 * Automatic stop is one switch. Whatever keeps a switched-on instance from
 * stopping is for Diagnostics, not for this row: agents working keep it up by
 * design, and anything else comes with its own way to fix it there.
 */
export function AwsAutoStopRow(props: {
  autoStop: AwsWorkerAutoStop;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}): JSX.Element {
  return (
    <div className="gen-row gen-aws-auto-stop" data-testid="aws-worker-auto-stop">
      <div className="gen-row-text">
        <div className="gen-row-title">Automatic stop</div>
        <div className="gen-row-desc">Stops the instance after three hours without working agents.</div>
      </div>
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
  const [copied, setCopied] = useState<"idle" | ClipboardWriteResult>("idle");
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
    setCopied("idle");
    setError(undefined);
    window.consensus.getAwsWorkerBootstrapCommand(props.region).then(
      (text) => { if (current) setCommand(text); },
      (cause) => { if (current) setCommandError(ipcErrorMessage(cause)); }
    );
    return () => { current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const copy = async (): Promise<void> => {
    if (command) setCopied(await writeClipboardText(command, (value) => navigator.clipboard.writeText(value)));
  };
  const apply = async (): Promise<void> => {
    setApplying(true);
    setError(undefined);
    try {
      const status = await window.consensus.setAwsAutoStop({ enabled: true, blob: blob.trim() });
      props.onEnabled(status);
      props.onClose();
    } catch (cause) {
      setError(ipcErrorMessage(cause));
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !applying) props.onClose(); }}>
      <DialogContent className="gen-aws-auto-stop-dialog" data-testid="aws-worker-auto-stop-dialog" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{props.mode === "set-up-again" ? "Set up automatic stop again" : "Turn on automatic stop"}</DialogTitle>
          <DialogDescription>
            {props.mode === "set-up-again"
              ? "AWS no longer accepts the key the instance stops itself with. Run this command once in Terminal with an AWS administrator account to make a new one, then paste its result here."
              : "The instance will stop by itself after three hours without working agents, even when this app is closed. Run this command once in Terminal with an AWS administrator account, then paste its result here."}
          </DialogDescription>
        </DialogHeader>
        <div className="gen-aws-command-box">
          <button type="button" className="gen-aws-copy" aria-label="Copy AWS setup command" disabled={!command} onClick={() => void copy()}>
            {copied === "copied" ? <CheckCircle2 size={14} /> : <Copy size={14} />}
            <span>{copied === "copied" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy"}</span>
          </button>
          <pre className="gen-aws-command" data-testid="aws-worker-auto-stop-command">
            {command || (commandError ? "" : "Preparing the command…")}
          </pre>
        </div>
        {commandError ? <div className="gen-aws-inline-error" role="alert">{commandError}</div> : null}
        <label className="gen-aws-field">
          <span>Paste the result</span>
          <textarea
            className="gen-input gen-aws-paste"
            aria-label="AWS setup result"
            placeholder="accord-aws-v1:…"
            value={blob}
            disabled={applying}
            onChange={(event) => setBlob(event.target.value)}
          />
        </label>
        {error ? <div className="gen-aws-inline-error" role="alert" data-testid="aws-worker-auto-stop-error">{error}</div> : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" size="sm" disabled={applying}>Cancel</Button>
          </DialogClose>
          <Button type="button" size="sm" data-testid="aws-worker-auto-stop-apply" disabled={applying || !blob.trim()} onClick={() => void apply()}>
            {applying ? <Loader2 size={14} className="gen-aws-spinner" aria-hidden /> : null}
            {applying ? "Applying…" : props.mode === "set-up-again" ? "Apply" : "Turn on"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The reason only: Electron prefixes errors thrown in the main process. */
export function ipcErrorMessage(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}
