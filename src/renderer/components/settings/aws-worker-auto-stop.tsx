import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { AwsWorkerAutoStop } from "../../../shared/types";

/**
 * What a running instance costs, said once: whether it stops by itself after
 * three idle hours. A state the User has to act on (a refusal, or a machine
 * that reports it cannot stop) reads as a warning, not as a quiet note.
 */
export function AwsWorkerBillingNote(props: { autoStop?: AwsWorkerAutoStop; running: boolean }): JSX.Element | null {
  if (!props.running) return null;
  const { text, warning } = runningNote(props.autoStop);
  return <div className={`gen-row-desc${warning ? " is-warning" : ""}`} data-testid="aws-worker-billing-note">{text}</div>;
}

/**
 * The way to turn automatic stop on when it is off or was refused: the setup
 * command run once more, which mints the machine's stop key beside the app's
 * own key. Only one command-and-paste form is open at a time, so the caller
 * leaves this out while another one is shown.
 */
export function AwsWorkerAutoStopSetup(props: {
  autoStop?: AwsWorkerAutoStop;
  running: boolean;
  /** The command-and-paste form in its automatic-stop mode. */
  form: JSX.Element;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const state = props.autoStop?.state;
  if (state !== "off" && state !== "failed") return null;
  return (
    <div className="gen-aws-recovery" data-testid="aws-worker-auto-stop">
      {/* While the instance runs, the billing note already says why. */}
      {!props.running && state === "failed" ? (
        <div className="gen-aws-size-change">{COULD_NOT_SET_UP}{failedReason(props.autoStop)}</div>
      ) : null}
      <button type="button" className="gen-pill" data-testid="aws-worker-auto-stop-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="gen-pill-label">{state === "failed" ? "Set up automatic stop again" : "Set up automatic stop"}</span>
        <ChevronDown size={14} className={open ? "is-open" : undefined} aria-hidden />
      </button>
      {open ? props.form : null}
    </div>
  );
}

/** What pasting the setup result did, for the line under the panel. The
 *  billing note above already says what that means, so this only confirms. */
export function autoStopAppliedMessage(autoStop: AwsWorkerAutoStop | undefined): string {
  return autoStop?.state === "off"
    ? "The pasted result had no automatic-stop key."
    : "The new key is saved.";
}

const COULD_NOT_SET_UP = "The machine could not set up automatic stop: ";

function failedReason(autoStop: AwsWorkerAutoStop | undefined): string {
  return autoStop?.detail ?? "no reason was given";
}

/** The detail main sends while no machine runs on the instance. */
const NO_MACHINE_YET = "No machine runs on this instance yet.";

function runningNote(autoStop: AwsWorkerAutoStop | undefined): { text: string; warning: boolean } {
  switch (autoStop?.state) {
    case "on":
      return autoStop.detail
        ? { text: `Billed while running; automatic stop is set up, but the machine reports: ${autoStop.detail}`, warning: true }
        : { text: "Billed while running; it stops by itself after three hours without work.", warning: false };
    case "pending":
      if (autoStop.detail === NO_MACHINE_YET) return { text: "Billed while running. Automatic stop starts once a machine is set up on this instance.", warning: false };
      // A detail is something that holds the key back: the User may have to act.
      return autoStop.detail
        ? { text: `Billed while running. Automatic stop starts once the machine has its new key. ${autoStop.detail}`, warning: true }
        : { text: "Billed while running. Automatic stop starts once the machine has its new key, which it takes the next time it is idle.", warning: false };
    case "failed":
      return autoStop.previousKeyActive
        ? { text: `Billed while running; it still stops by itself after three hours without work, with its previous key. The new key was not taken: ${failedReason(autoStop)}`, warning: true }
        : { text: `Billed until you stop it; the machine could not set up automatic stop: ${failedReason(autoStop)}`, warning: true };
    case "off":
      return { text: "Billed until you stop it; it does not stop by itself.", warning: false };
    default:
      // Unknown is not "off": the state could not be read this time.
      return { text: "Billed while running.", warning: false };
  }
}
