import { randomUUID } from "node:crypto";
import { machineMaintenanceCommand, type MachineMaintenanceTarget } from "./machineMaintenanceCommand";

/** Openrsync strips the quotes in --rsync-path before SSH joins its arguments.
 * A remote executable preserves the maintenance boundary on both macOS and GNU
 * rsync. Only this random, private temporary directory is created and removed. */
export async function withMachineRsyncPath<T>(
  target: MachineMaintenanceTarget | undefined,
  execute: (command: string, input?: string) => Promise<unknown>,
  transfer: (rsyncPath?: string) => Promise<T>
): Promise<T> {
  if (!target) return transfer();
  const dir = `/tmp/accordagents-rsync-${randomUUID()}`;
  const file = `${dir}/run`;
  const script = `#!/bin/sh\n${machineMaintenanceCommand(target, 'rsync "$@"')}\n`;
  try {
    await execute(`umask 077; mkdir ${dir} && cat > ${file} && chmod 700 ${file}`, script);
    return await transfer(file);
  } finally {
    // A lost connection can leave this small path-only script in /tmp; never
    // hide the transfer error behind a cleanup failure or remove other files.
    await execute(`rm -f ${file}; rmdir ${dir}`).catch(() => undefined);
  }
}
