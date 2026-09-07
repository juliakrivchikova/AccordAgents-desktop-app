import { shellQuotePosix } from "./cloudRunWorkers";

export interface MachineMaintenanceTarget {
  runtimePath: string;
  userDataDir: string;
  /** File a release ships to declare that its runtime understands
   *  `--maintenance`. Defaults to `maintenance-v1` beside the runtime. */
  capabilityPath?: string;
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
  const capability = shellQuotePosix(
    target.capabilityPath ?? `${target.runtimePath.replace(/\/[^/]+$/, "")}/maintenance-v1`
  );
  const script = [
    `runtime=${runtime}; data=${data}; capability=${capability}`,
    // An installed release older than maintenance ignores unknown flags, so
    // exec'ing it here would start a second runtime on this user-data
    // directory instead of running the command. Only a release that declares
    // the capability is used.
    'if [ -f "$runtime" ] && [ -f "$capability" ]; then',
    '  exec node "$runtime" --maintenance --user-data "$data" -- "$@"',
    'fi',
    // First installation has no runtime/timer yet. An existing power state,
    // unreadable database or missing runtime during upgrade is not that case.
    'if [ -f "$data/accordagents.sqlite3" ]; then',
    '  state=$(sqlite3 -readonly "$data/accordagents.sqlite3" "select count(*) from machine_power_state;" 2>/dev/null) || exit 69',
    '  if [ "$state" != 0 ]; then printf "%s\\n" "The installed runtime cannot protect its idle stop during maintenance; upgrade it from Settings first." >&2; exit 69; fi',
    'fi',
    'exec "$@"'
  ].join("\n");
  return `sh -c ${shellQuotePosix(script)} accord-machine-maintenance ${command}`;
}
