import type { MachineInstallRecord, MachineSshTarget } from "../../shared/machineInstall";

interface WorkerAddress {
  host?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  hostKeyAlias?: string;
}

export interface MachineUpgradeTargetOptions {
  /** The AWS instance the machine is on, as its machine entry names it. */
  machineInstanceId(machineId: string): Promise<string | undefined>;
  /** The instance set up in Settings → AWS. */
  configuredInstanceId(): Promise<string | undefined>;
  /** Renews this computer's SSH access to a running instance and returns
   *  its address; never starts a stopped one. */
  renewAccess(instanceId: string): Promise<WorkerAddress>;
  /** The configured instance's address, read from AWS only. */
  inspect(): Promise<WorkerAddress>;
  log(event: string, payload: Record<string, unknown>): void;
}

/**
 * Where a machine's runtime update connects. An AWS instance gets a new
 * public address every stop/start, and lets SSH in only from the address this
 * computer had when it last started it: after a change of network every
 * update timed out. So this computer's access is renewed first, as checking
 * the machine does; a stopped instance is not started for it. When renewing
 * fails the update still goes to the address AWS names, so its own error is
 * what the User sees rather than a silent wait.
 */
export async function machineUpgradeTarget(record: MachineInstallRecord, options: MachineUpgradeTargetOptions): Promise<MachineSshTarget | undefined> {
  const machineInstanceId = await options.machineInstanceId(record.machineId);
  // A machine installed over an instance's pinned host key is on that
  // instance too, even when its entry does not name it.
  const instanceId = machineInstanceId ?? /^accordagents-(i-[a-f0-9]+)$/.exec(record.target?.hostKeyAlias ?? "")?.[1];
  if (!instanceId) return record.target;
  const renewed = (await options.configuredInstanceId()) === instanceId
    ? await options.renewAccess(instanceId).catch((error: unknown) => {
      options.log("machines.auto-upgrade.access-renew-failed", { machineId: record.machineId,
        message: error instanceof Error ? error.message : String(error) });
      return undefined;
    })
    : undefined;
  const worker = renewed ?? await options.inspect().catch(() => undefined);
  if (!worker?.host || worker.hostKeyAlias !== `accordagents-${instanceId}`) {
    // Only a machine known to be on the app's instance waits for AWS to
    // name its address; one matched by its host key keeps the saved one.
    return machineInstanceId ? undefined : record.target;
  }
  return { host: worker.host, user: worker.user, port: worker.port, identityFile: worker.identityFile, hostKeyAlias: worker.hostKeyAlias };
}
