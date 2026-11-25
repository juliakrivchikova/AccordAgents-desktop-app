import { compareVersions, MACHINE_POWER_MAX_ATTEMPTS, MACHINE_POWER_RETRY_MS } from "../../../shared/machineInstall";
import type { MachineMaintenanceTarget } from "../machineMaintenanceCommand";
import { MACHINE_POWER_REFUSED_EXIT_CODE, type AwsMachinePowerConfig } from "../../../shared/machinePower";
import type { MachineInstallKind, MachineInstallRecord } from "../../../shared/machineInstall";
import { CommandError } from "../command";
import type { ParsedMachineProbe } from "../machineInstallScripts";
import { MINIMUM_NODE_MAJOR } from "./constants";
import { errorMessage } from "./failureText";
import type { MachineBundle } from "./types";

// ---- helpers --------------------------------------------------------------


/** Whether the automatic update has to hand this stop key over: the machine
 *  has not taken it, has not refused this very key, and did not fail to take
 *  it within the last hour, nor MACHINE_POWER_MAX_ATTEMPTS times. A refused key is retried by the Update button,
 *  never automatically, so a machine that cannot take it is not restarted
 *  over and over. A new key (the setup command run again) is handed over
 *  automatically. */
export function machinePowerNeedsDelivery(
  record: Pick<MachineInstallRecord, "power" | "powerError" | "powerRetry">,
  power: AwsMachinePowerConfig | undefined,
  now: Date = new Date()
): boolean {
  if (!power) return false;
  const keyId = power.credentials.accessKeyId;
  if (record.power?.keyId === keyId || record.powerError?.keyId === keyId) return false;
  if (record.powerRetry?.keyId !== keyId) return true;
  if ((record.powerRetry.attempts ?? 1) >= MACHINE_POWER_MAX_ATTEMPTS) return false;
  return !(now.getTime() - Date.parse(record.powerRetry.failedAt) < MACHINE_POWER_RETRY_MS);
}

/** The machine answered that the key itself is refused, as opposed to a
 *  dropped SSH connection, a timeout, an unreachable AWS or a busy host. */
export function isMachineRefusal(error: unknown): boolean {
  return error instanceof CommandError && !error.result.timedOut && error.result.exitCode === MACHINE_POWER_REFUSED_EXIT_CODE;
}

/** The machine's own sentence, not the ssh wrapper around it. */
export function powerFailureMessage(error: unknown): string {
  const stderr = error instanceof CommandError ? error.result.stderr.trim().split("\n").filter(Boolean).pop() : undefined;
  return (stderr || errorMessage(error)).slice(0, 300);
}

export function maintenanceFor(layout: { installRoot: string; userDataDir: string }): MachineMaintenanceTarget {
  if (!layout.installRoot || !layout.userDataDir) throw new Error("The machine did not report its maintenance paths.");
  return {
    runtimePath: `${layout.installRoot}/current/accordagents-machine.cjs`,
    userDataDir: layout.userDataDir,
    capabilityPath: `${layout.installRoot}/current/maintenance-v1`
  };
}

/** The release just staged, used as the maintenance runtime for everything
 *  from the drain onward. It always understands `--maintenance`, so an upgrade
 *  from a release that predates maintenance is still protected. */
export function maintenanceForStagedRelease(
  layout: { releasesDir: string; userDataDir: string },
  release: string
): MachineMaintenanceTarget {
  return {
    runtimePath: `${layout.releasesDir}/${release}/accordagents-machine.cjs`,
    userDataDir: layout.userDataDir,
    capabilityPath: `${layout.releasesDir}/${release}/maintenance-v1`
  };
}

export function missingRequirements(probe: ParsedMachineProbe): string[] {
  const missing: string[] = [];
  const major = Number.parseInt((probe.nodeVersion ?? "").replace(/^v/, "").split(".")[0] ?? "", 10);
  if (!probe.nodeVersion || !Number.isInteger(major) || major < MINIMUM_NODE_MAJOR) {
    missing.push(`Node ${MINIMUM_NODE_MAJOR}+`);
  }
  if (!probe.hasNpm) missing.push("npm");
  if (!probe.hasPython3) missing.push("python3 (host admission locking)");
  if (!probe.hasSqlite3) missing.push("the sqlite3 CLI");
  if (!probe.hasGit) missing.push("git");
  if (!probe.hasRsync) missing.push("rsync");
  if (!probe.hasSystemd) missing.push("systemd");
  return missing;
}

export function releaseName(bundle: MachineBundle): string {
  return `${bundle.version}-${bundle.digest.slice(0, 12)}`;
}

/** Installing an older runtime over a newer one opens the machine's SQLite
 *  with an old binary. The accord's upgrade rule makes rollback a whole-version
 *  restore, never a live downgrade, so this refuses unless the User asked. */
export function versionFence(
  kind: MachineInstallKind,
  probe: { installedVersion?: string },
  bundle: MachineBundle,
  allowDowngrade: boolean
): string | undefined {
  if (allowDowngrade || !probe.installedVersion) return undefined;
  if (compareVersions(bundle.version, probe.installedVersion) >= 0) return undefined;
  return `The machine runs ${probe.installedVersion}; this desktop would install the older ${bundle.version}. `
    + "Installing an older runtime over a newer one opens the machine's data with an old binary, so it was refused.";
}
