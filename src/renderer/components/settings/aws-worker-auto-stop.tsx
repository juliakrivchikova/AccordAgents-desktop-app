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
  setupOpen: boolean;
  setSetupOpen: (open: boolean) => void;
  toggle: (enabled: boolean) => void;
  fix: (action: NonNullable<AwsWorkerAutoStopProblem["action"]>) => Promise<void>;
} {
  const [busy, setBusy] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const toggle = (enabled: boolean): void => {
    if (enabled && autoStop?.needsSetup) { setSetupOpen(true); return; }
    setBusy(true);
    report();
    window.consensus.setAwsAutoStop({ enabled }).then(accept, report).finally(() => setBusy(false));
  };
  const fix = async (action: NonNullable<AwsWorkerAutoStopProblem["action"]>): Promise<void> => {
    if (action === "set-up-again") { setSetupOpen(true); return; }
    accept(await window.consensus.reconnectAwsMachine());
  };
  return { busy, setupOpen, setSetupOpen, toggle, fix };
}

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
  open: boolean;
  region: string;
  onOpenChange: (open: boolean) => void;
  onEnabled: (status: AwsWorkerStatus) => void;
}): JSX.Element {
  const [command, setCommand] = useState("");
  const [commandError, setCommandError] = useState<string>();
  const [blob, setBlob] = useState("");
  const [copied, setCopied] = useState<"idle" | ClipboardWriteResult>("idle");
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!props.open) return;
    let current = true;
    setCommand("");
    setCommandError(undefined);
    setBlob("");
    setCopied("idle");
    setError(undefined);
    window.consensus.getAwsWorkerBootstrapCommand(props.region).then(
      (text) => { if (current) setCommand(text); },
      (cause) => { if (current) setCommandError(messageOf(cause)); }
    );
    return () => { current = false; };
  }, [props.open, props.region]);

  const copy = async (): Promise<void> => {
    if (command) setCopied(await writeClipboardText(command, (value) => navigator.clipboard.writeText(value)));
  };
  const apply = async (): Promise<void> => {
    setApplying(true);
    setError(undefined);
    try {
      const status = await window.consensus.setAwsAutoStop({ enabled: true, blob: blob.trim() });
      props.onEnabled(status);
      props.onOpenChange(false);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={(open) => { if (!applying) props.onOpenChange(open); }}>
      <DialogContent className="gen-aws-auto-stop-dialog" data-testid="aws-worker-auto-stop-dialog">
        <DialogHeader>
          <DialogTitle>Turn on automatic stop</DialogTitle>
          <DialogDescription>
            The instance will stop by itself after three hours without working agents, even when this app is closed.
            Run this command once in Terminal with an AWS administrator account, then paste its result here.
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
        {commandError ? <div className="gen-aws-dialog-error" role="alert">{commandError}</div> : null}
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
        {error ? <div className="gen-aws-dialog-error" role="alert" data-testid="aws-worker-auto-stop-error">{error}</div> : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" size="sm" disabled={applying}>Cancel</Button>
          </DialogClose>
          <Button type="button" size="sm" data-testid="aws-worker-auto-stop-apply" disabled={applying || !blob.trim()} onClick={() => void apply()}>
            {applying ? <Loader2 size={14} className="gen-aws-spinner" aria-hidden /> : null}
            {applying ? "Turning on…" : "Turn on"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function messageOf(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  // Electron prefixes errors thrown in the main process; the User needs the reason only.
  return text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}
