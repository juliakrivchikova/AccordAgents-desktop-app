import type { MachineInstallRecord, MachineSshTarget } from "../../shared/machineInstall";
import type { CloudRunWorkerSettings } from "../../shared/types";

type WorkerAddress = Pick<CloudRunWorkerSettings, "host" | "user" | "port" | "identityFile" | "hostKeyAlias">;

/** Long enough for AWS to renew access and SSH to answer on a working
 *  network; on one where SSH does not get through, the update goes on and
 *  fails with its own error instead of after minutes of retries. */
export const MACHINE_UPGRADE_ACCESS_WAIT_MS = 60_000;

export interface MachineUpgradeTargetOptions {
  /** The AWS instance the machine is on, as its machine entry names it. */
  machineInstanceId(machineId: string): Promise<string | undefined>;
  /** The instance set up in Settings → AWS. */
  configuredInstanceId(): Promise<string | undefined>;
  /** Renews this computer's SSH access to the instance and returns its
   *  address (CloudRunAwsService.ensureExistingWorkerForRun). */
  ensureExistingWorker(instanceId: string, options: { start: false }): Promise<WorkerAddress>;
  /** The configured instance's address, read from AWS only. */
  inspect(): Promise<WorkerAddress>;
  log(event: string, payload: Record<string, unknown>): void;
  accessWaitMs?: number;
}

/**
 * Where a machine's runtime update connects. An AWS instance gets a new
 * public address every stop/start, and lets SSH in only from the address this
 * computer had when it last started it: after a change of network every
 * update timed out. So this computer's access is renewed first, as checking
 * the machine does; a stopped instance is never started for it. When renewing
 * fails or takes too long, the update still goes to the address AWS names, so
 * its own error is what the User sees rather than a silent wait.
 */
export async function machineUpgradeTarget(record: MachineInstallRecord, options: MachineUpgradeTargetOptions): Promise<MachineSshTarget | undefined> {
  const machineInstanceId = await options.machineInstanceId(record.machineId);
  // A machine installed over an instance's pinned host key is on that
  // instance too, even when its entry does not name it.
  const instanceId = machineInstanceId ?? /^accordagents-(i-[a-f0-9]+)$/.exec(record.target?.hostKeyAlias ?? "")?.[1];
  if (!instanceId) return record.target;
  const failed = (event: string, error: unknown): undefined => {
    options.log(event, { machineId: record.machineId, message: error instanceof Error ? error.message : String(error) });
    return undefined;
  };
  const configured = await options.configuredInstanceId().catch((error: unknown) => failed("machines.auto-upgrade.access-renew-failed", error));
  const renewed = configured === instanceId ? await renewWithin(options, instanceId, failed) : undefined;
  const worker = renewed ?? await options.inspect().catch(() => undefined);
  if (!worker?.host || worker.hostKeyAlias !== `accordagents-${instanceId}`) {
    // Only a machine known to be on the app's instance waits for AWS to
    // name its address; one matched by its host key keeps the saved one.
    return machineInstanceId ? undefined : record.target;
  }
  return { host: worker.host, user: worker.user, port: worker.port, identityFile: worker.identityFile, hostKeyAlias: worker.hostKeyAlias };
}

/** The renewal, or nothing once it failed or ran past the wait. Access is
 *  renewed on AWS before SSH is tried, so a renewal still retrying SSH has
 *  already let this computer in; it finishes in the background. */
async function renewWithin(options: MachineUpgradeTargetOptions, instanceId: string,
  failed: (event: string, error: unknown) => undefined): Promise<WorkerAddress | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(failed("machines.auto-upgrade.access-renew-slow",
      `SSH did not answer within ${Math.round((options.accessWaitMs ?? MACHINE_UPGRADE_ACCESS_WAIT_MS) / 1000)} s`)),
    options.accessWaitMs ?? MACHINE_UPGRADE_ACCESS_WAIT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      options.ensureExistingWorker(instanceId, { start: false }).catch((error: unknown) => failed("machines.auto-upgrade.access-renew-failed", error)),
      late
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
