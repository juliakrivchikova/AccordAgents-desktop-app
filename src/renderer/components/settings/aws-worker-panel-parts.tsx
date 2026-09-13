import type { AwsWorkerOperationSnapshot } from "../../../shared/types";

/** What each confirmed action does to the shared instance, stated before the
 *  click rather than discovered after it. */
export const CONFIRM_TEXT: Record<"stop" | "delete" | "recreate", string> = {
  stop: "Stopping interrupts members running on this instance and takes it away from every laptop using it until it is started again.",
  delete: "Deleting terminates the instance and its disk for every laptop using it. Cloud environments, sessions and sign-ins on it are lost.",
  recreate: "Recreating terminates the current instance and its disk, then creates a new one at the requested size. Cloud environments, sessions and sign-ins on it are lost."
};

export function WorkerProgress({ operation }: { operation: AwsWorkerOperationSnapshot }): JSX.Element {
  const phases = [
    { id: "starting", label: "Starting" },
    { id: "waiting-running", label: "Waiting for running" },
    { id: "setting-up", label: "Setting up" },
    { id: "ready", label: "Ready" }
  ] as const;
  const current = operation.phase === "needs-decision" || operation.phase === "error" ? -1 : phases.findIndex((phase) => phase.id === operation.phase);
  return (
    <ol className={`gen-aws-progress is-${operation.phase}`} data-testid="aws-worker-progress" aria-label="AWS worker start progress">
      {phases.map((phase, index) => (
        <li key={phase.id} className={index < current || operation.phase === "ready" ? "is-done" : index === current ? "is-current" : ""}>
          <span aria-hidden>{index < current || operation.phase === "ready" ? "✓" : index + 1}</span>
          <span>{phase.label}</span>
        </li>
      ))}
      {operation.authUrl ? <li className="gen-aws-auth"><button type="button" className="gen-doctor-auth-link" onClick={() => void window.consensus.openExternal(operation.authUrl as string)}>Open Codex sign-in</button>{operation.authCode ? <code>{operation.authCode}</code> : null}</li> : null}
    </ol>
  );
}

export function ConfirmSharedAction(props: { label: string; description: string; onCancel: () => void; onConfirm: () => void }): JSX.Element {
  return (
    <div className="gen-aws-confirm" role="alert">
      <span>{props.description}</span>
      <div className="gen-actions">
        <button type="button" className="gen-pill" onClick={props.onCancel}><span className="gen-pill-label">Cancel</span></button>
        <button type="button" className="gen-pill gen-pill-danger" onClick={props.onConfirm}><span className="gen-pill-label">Confirm {props.label.toLowerCase()}</span></button>
      </div>
    </div>
  );
}
