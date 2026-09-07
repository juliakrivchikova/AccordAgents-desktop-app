import { shellQuotePosix } from "./cloudRunWorkers";

export interface MachineMaintenanceTarget {
  runtimePath: string;
  userDataDir: string;
}

/** Wrap only setup, upgrade, doctor and explicit mirror commands. Native
 * participant messages continue to use the relay exclusively. "$@" keeps
 * rsync's appended server arguments intact; input stays on the original pipe. */
export function machineMaintenanceCommand(target: MachineMaintenanceTarget | undefined, command: string): string {
  if (!target) return command;
  if (!target.runtimePath.startsWith("/") || !target.userDataDir.startsWith("/")) {
    throw new Error("Maintenance requires the absolute paths reported by the machine probe.");
  }
  const runtime = shellQuotePosix(target.runtimePath);
  const data = shellQuotePosix(target.userDataDir);
  const script = [
    `runtime=${runtime}; data=${data}`,
    'if [ -f "$runtime" ]; then',
    '  exec node "$runtime" --maintenance --user-data "$data" -- "$@"',
    'fi',
    // First installation has no runtime/timer yet. An existing power state,
    // unreadable database or missing runtime during upgrade is not that case.
    'if [ -f "$data/accordagents.sqlite3" ]; then',
    '  state=$(sqlite3 -readonly "$data/accordagents.sqlite3" "select count(*) from machine_power_state;" 2>/dev/null) || exit 69',
    '  if [ "$state" != 0 ]; then printf "%s\\n" "The installed runtime is unavailable; maintenance cannot protect its idle stop." >&2; exit 69; fi',
    'fi',
    'exec "$@"'
  ].join("\n");
  return `sh -c ${shellQuotePosix(script)} accord-machine-maintenance ${command}`;
}
