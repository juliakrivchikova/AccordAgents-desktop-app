import { AWS_WORKER_INSTANCE_TYPE_SPECS } from "../../../shared/cloudRuns";
import type { AwsWorkerActualSpec, AwsWorkerOperationSnapshot } from "../../../shared/types";

/** The reason only: Electron prefixes errors thrown in the main process. */
export function cleanError(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

/** What each confirmed action does to the shared instance, stated before the
 *  click rather than discovered after it. */
export const CONFIRM_TEXT: Record<"stop" | "delete" | "recreate", string> = {
  stop: "Stopping interrupts members running on this instance and takes it away from every computer using it until it is started again.",
  delete: "Deleting terminates the instance and its disk for every computer using it. Cloud environments, sessions and sign-ins on it are lost.",
  recreate: "Recreating terminates the current instance and its disk, then creates a new one at the requested size. Cloud environments, sessions and sign-ins on it are lost."
};

/** How every AWS dialog that needs the setup command asks for it. */
export const ADMIN_COMMAND_TEXT = "Run this command once in Terminal with an AWS administrator account";

/** An instance type's processors and memory, the way AWS lists them. */
export function instanceTypeSpecs(instanceType: string, actual?: AwsWorkerActualSpec): string {
  const known = (AWS_WORKER_INSTANCE_TYPE_SPECS as Record<string, string | undefined>)[instanceType];
  if (known) return known;
  return [actual?.vCpu ? `${actual.vCpu} vCPU` : "", actual?.memoryMiB ? `${Math.round(actual.memoryMiB / 1024)} GB RAM` : ""]
    .filter(Boolean).join(" · ");
}

/** The box for the setup command's result. */
export function AwsPasteField(props: { value: string; disabled?: boolean; onChange: (value: string) => void }): JSX.Element {
  return (
    <label className="gen-aws-field">
      <span>Paste the result</span>
      <textarea className="gen-input gen-aws-paste" aria-label="AWS setup result" placeholder="accord-aws-v1:…"
        value={props.value} disabled={props.disabled} onChange={(event) => props.onChange(event.target.value)} />
    </label>
  );
}

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
    </ol>
  );
}
