import type { MachineMaintenanceTarget } from "../machineMaintenanceCommand";
import type { AwsMachinePowerConfig } from "../../../shared/machinePower";
import type { MachineInstallRecord, MachineSshTarget } from "../../../shared/machineInstall";
import {
  machineActivateReleaseScript, machinePowerScript, machineDrainScript, machineStartServiceScript, parseMachineDrainReport,
  type MachineInstallLayout, type ParsedMachineProbe
} from "../machineInstallScripts";
import { DRAIN_TIMEOUT_MS, SHORT_TIMEOUT_MS } from "./constants";
import { errorMessage } from "./failureText";
import { isMachineRefusal, maintenanceFor, powerFailureMessage } from "./installChecks";
import type { MachineInstallerDependencies } from "./dependencies";

/** Puts a machine back, and its stop key. */
export class InstallRecovery {
  constructor(private readonly deps: Pick<MachineInstallerDependencies, "now" | "options" | "sshExec">) {}

  async rollback(
    target: MachineSshTarget,
    layout: MachineInstallLayout,
    previousRelease: string,
    probe: ParsedMachineProbe
  ): Promise<boolean> {
    try {
      const maintenance = { ...maintenanceFor(layout), runtimePath: `${layout.releasesDir}/${previousRelease}/accordagents-machine.cjs` };
      const drain = parseMachineDrainReport(await this.deps.sshExec({
        target, script: machineDrainScript(layout), timeoutMs: DRAIN_TIMEOUT_MS, maintenance
      }));
      if (!drain.drained) return false;
      await this.deps.sshExec({
        target,
        maintenance,
        script: machineActivateReleaseScript(layout, previousRelease, {
          version: probe.installedVersion ?? previousRelease,
          digest: probe.installedDigest ?? "",
          installedAt: this.deps.now().toISOString()
        }),
        timeoutMs: SHORT_TIMEOUT_MS
      });
      await this.deps.sshExec({ target, script: machineStartServiceScript(layout), timeoutMs: SHORT_TIMEOUT_MS, maintenance });
      return true;
    } catch (error) {
      this.deps.options.logger?.("machines.install.rollback-failed", { error: errorMessage(error) });
      return false;
    }
  }

  /** The stop key for this machine, only when the SSH target is the instance
   *  itself (its pinned host key): the secret never reaches a host that merely
   *  answers at an address. The machine re-checks its identity on arrival. */
  async machinePowerFor(machineId: string, target: MachineSshTarget): Promise<AwsMachinePowerConfig | undefined> {
    try {
      const power = await this.deps.options.machinePower?.(machineId);
      if (power && target.hostKeyAlias !== `accordagents-${power.instanceId}`) {
        this.deps.options.logger?.("machines.install.power-skipped", { machineId, reason: "target-is-not-the-instance" });
        return undefined;
      }
      return power;
    } catch (error) {
      // An unreadable key must not block an update; the machine keeps what it has.
      this.deps.options.logger?.("machines.install.power-unavailable", { machineId, message: errorMessage(error) });
      return undefined;
    }
  }

  /** Records why a stop key was not handed over. Only the machine's own
   *  "this key is refused" (AWS or the instance said no) marks it refused,
   *  which the automatic update does not retry; anything else (a dropped
   *  connection, a timeout, an unreachable AWS, a busy host) is retried an
   *  hour later. */
  powerNotTaken(record: MachineInstallRecord, keyId: string, error: unknown, warnings?: string[]): MachineInstallRecord {
    const message = powerFailureMessage(error);
    const refused = isMachineRefusal(error);
    warnings?.push(`Automatic stop after three idle hours is not set up: ${message}`);
    this.deps.options.logger?.("machines.install.power-failed", { machineId: record.machineId, keyId, message, refused });
    const failedAt = this.deps.now().toISOString();
    if (refused) return { ...record, powerError: { keyId, message, failedAt }, powerRetry: undefined };
    const attempts = (record.powerRetry?.keyId === keyId ? record.powerRetry.attempts ?? 1 : 0) + 1;
    return { ...record, powerRetry: { keyId, message, failedAt, attempts } };
  }

  /** Drains the runtime and puts back the stop key the handover replaced.
   *  The caller starts it again. */
  async revertPower(
    machineId: string,
    target: MachineSshTarget,
    layout: MachineInstallLayout,
    nodePath: string,
    maintenance: MachineMaintenanceTarget | undefined
  ): Promise<{ drain?: ReturnType<typeof parseMachineDrainReport>; reverted: boolean }> {
    let drain: ReturnType<typeof parseMachineDrainReport> | undefined;
    try {
      drain = parseMachineDrainReport(await this.deps.sshExec({ target, script: machineDrainScript(layout), timeoutMs: DRAIN_TIMEOUT_MS, maintenance }));
      if (!drain.drained) {
        this.deps.options.logger?.("machines.install.power-revert-failed", { machineId, message: "The runtime could not be drained." });
        return { drain, reverted: false };
      }
      await this.deps.sshExec({ target, script: machinePowerScript(layout, nodePath, "revert"), timeoutMs: SHORT_TIMEOUT_MS, maintenance });
      this.deps.options.logger?.("machines.install.power-reverted", { machineId });
      return { drain, reverted: true };
    } catch (error) {
      this.deps.options.logger?.("machines.install.power-revert-failed", { machineId, message: errorMessage(error) });
      return { drain, reverted: false };
    }
  }
}
