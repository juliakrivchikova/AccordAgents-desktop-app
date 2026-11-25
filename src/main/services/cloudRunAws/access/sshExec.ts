import type { CloudRunWorkerSettings } from "../../../../shared/types";
import { buildCloudRunSshTarget, cloudRunSshOptionArgs } from "../../cloudRunWorkers";
import { runCommand } from "../../command";

export async function defaultSshExec(worker: CloudRunWorkerSettings, command: string, timeoutMs: number): Promise<void> {
  const target = buildCloudRunSshTarget(worker as CloudRunWorkerSettings & { host: string });
  await runCommand("ssh", [...cloudRunSshOptionArgs(worker as CloudRunWorkerSettings & { host: string }), target, command], { timeoutMs });
}
