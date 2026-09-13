import { isDeepStrictEqual } from "node:util";
import type { CloudRunWorkerDoctorReport, CloudRunWorkerSettings, CloudRunWorkerSetupProgress } from "../../shared/types";

/** Settings can close during browser sign-in. Keep its live interaction in
 * main until it ends, so reopening does not lose the input or start it twice. */
export class CloudRunSetupSession {
  private active?: Promise<CloudRunWorkerDoctorReport>;
  private request?: CloudRunWorkerSettings;
  private progress?: CloudRunWorkerSetupProgress;

  getProgress(): CloudRunWorkerSetupProgress | null { return this.progress ? { ...this.progress } : null; }

  run(request: CloudRunWorkerSettings | undefined,
    action: (publish: (progress: CloudRunWorkerSetupProgress) => void) => Promise<CloudRunWorkerDoctorReport>,
    publish: (progress: CloudRunWorkerSetupProgress) => void): Promise<CloudRunWorkerDoctorReport> {
    if (this.active) {
      if (isDeepStrictEqual(request, this.request)) return this.active;
      return Promise.reject(new Error("Another worker setup is running. Complete or cancel its sign-in first."));
    }
    this.request = structuredClone(request);
    const update = (value: CloudRunWorkerSetupProgress): void => { this.progress = value; publish(value); };
    this.active = Promise.resolve().then(() => {
      update({ stage: "prepare", message: "Preparing the instance…" });
      return action(update);
    }).then(report => {
      update({ stage: report.ok ? "complete" : "error", message: report.message });
      return report;
    }, error => {
      update({ stage: "error", message: error instanceof Error ? error.message : String(error) });
      throw error;
    }).finally(() => { this.active = undefined; this.request = undefined; this.progress = undefined; });
    return this.active;
  }
}
