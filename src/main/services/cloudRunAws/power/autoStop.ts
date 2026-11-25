import type {
  AwsWorkerAutoStop, AwsWorkerAutoStopProblem, SetAwsAutoStopRequest, AwsWorkerHandleInfo, AwsWorkerStatus
} from "../../../../shared/types";
import { machineIdleWarningKind, type AwsMachinePowerConfig } from "../../../../shared/machinePower";
import {
  isAutoUpgradeOf, isMachineInstallTerminalPhase, MACHINE_POWER_MAX_ATTEMPTS, type MachineInstallRecord
} from "../../../../shared/machineInstall";
import { parseWorkerBlob } from "../../awsWorkerProvisioning";
import type { AwsWorkerCredentials } from "../../awsWorkerProvisioning";
import { machineRecoveryMessage } from "../access/errorText";
import { powerConfigFor } from "../setup/workerSpec";
import type { AwsModules } from "../modules";
import type { AwsDependencies } from "../dependencies";

/** How soon after a switch change a machine's report can still predate it. */
const SWITCH_REPORT_MARGIN_MS = 2_000;

/** When the machine stops by itself. */
export class AutoStop {
  constructor(
    private readonly aws: Pick<AwsModules, "bootstrap" | "installedPrograms">,
    private readonly deps: Pick<AwsDependencies, "appVersion" | "machineConnected" | "machineRecoveryFailure" | "settings">
  ) {}

  /** The phone's start key for this app's instance, as a paired phone uses it,
   *  with the machine it wakes; undefined when the setup command has not made
   *  one, or made it for another region. It only ever leaves this desktop
   *  inside a pairing link. */
  async deviceWakePower(): Promise<{ machineId?: string; config: AwsMachinePowerConfig } | undefined> {
    const credentials = await this.deps.settings.getAwsWorkerCredentials();
    const handle = (await this.deps.settings.getPublicSettings()).cloudRuns.awsHandle;
    if (!credentials?.wake || !handle) return undefined;
    const config = powerConfigFor({ ...credentials, power: credentials.wake }, handle);
    if (!config) return undefined;
    const { machines } = await this.aws.installedPrograms.installsOnInstance(handle);
    return { ...(machines.length === 1 ? { machineId: machines[0].id } : {}), config };
  }

  /** The switch and the program's state added to an instance status. A
   *  settings read that fails leaves the switch unknown, never "on". */
  async withMachineState(credentials: AwsWorkerCredentials, handle: AwsWorkerHandleInfo,
    status: AwsWorkerStatus): Promise<AwsWorkerStatus> {
    const machineProblem = status.state === "running" ? await this.machineDown(handle).catch(() => undefined) : undefined;
    const autoStop = await this.autoStopFor(credentials, handle, status.state, Boolean(machineProblem)).catch(() => undefined);
    return { ...status, ...(autoStop ? { autoStop } : {}), ...(machineProblem ? { machineProblem } : {}) };
  }

  /** The stop key for a machine that runs on this app's instance, or
   *  undefined when the machine is elsewhere or no stop key was set up. The
   *  key only ever covers the instance's own region. */
  async machinePowerFor(machineId: string): Promise<AwsMachinePowerConfig | undefined> {
    const [credentials, publicSettings] = await Promise.all([this.deps.settings.getAwsWorkerCredentials(), this.deps.settings.getPublicSettings()]);
    const handle = publicSettings.cloudRuns.awsHandle;
    if (!credentials?.power || !handle) return undefined;
    const { machines } = await this.aws.installedPrograms.installsOnInstance(handle);
    if (!machines.some((machine) => machine.id === machineId)) return undefined;
    return powerConfigFor(credentials, handle);
  }

  private async autoStopFor(credentials: AwsWorkerCredentials, handle: AwsWorkerHandleInfo,
    state: AwsWorkerStatus["state"], machineDown = false): Promise<AwsWorkerAutoStop> {
    const power = powerConfigFor(credentials, handle);
    if (!power) return { enabled: false, needsSetup: true };
    // A program that is not back is shown as itself, not as a detail of
    // automatic stop: nothing else about the switch can be fixed meanwhile.
    if (state === "running" && machineDown) return { enabled: await this.deps.settings.getMachineAutoStopEnabled(), needsSetup: false };
    if (!await this.deps.settings.getMachineAutoStopEnabled()) {
      // Off must hold on the machine too: it is the one that stops.
      const problem = state === "running" ? await this.switchNotTaken(power, handle, false) : undefined;
      return { enabled: false, needsSetup: false, ...(problem ? { problem } : {}) };
    }
    // A stopped instance has nothing to stop; what keeps a running one up is
    // only worth showing while it runs.
    const problem = state === "running" ? await this.autoStopProblem(power, handle) : undefined;
    // Switched-on scheduled scripts keep it up on purpose, and that costs money: said, not hidden.
    const keptOnByScripts = state === "running"
      ? (await this.aws.installedPrograms.installsOnInstance(handle)).machines.reduce((sum, machine) => sum + (machine.lastHello?.keepAwakeScripts ?? 0), 0)
      : 0;
    return { enabled: true, needsSetup: false, ...(problem ? { problem } : {}), ...(keptOnByScripts > 0 ? { keptOnByScripts } : {}) };
  }

  /**
   * Why a running instance will not stop by itself although the switch is on,
   * for the Automatic stop row, or nothing. Agents working keep it up by design and are
   * not a problem. Each answer says what fixes it.
   */
  private async autoStopProblem(power: AwsMachinePowerConfig, handle: AwsWorkerHandleInfo): Promise<AwsWorkerAutoStopProblem | undefined> {
    const keyId = power.credentials.accessKeyId;
    const { machines, records: all } = await this.aws.installedPrograms.installsOnInstance(handle);
    const records = all.filter((record) => record.installedVersion);
    if (!records.length) {
      // The cloud program does the stopping; its own section installs it.
      return { message: "Works once the cloud program is installed (see Cloud program)." };
    }
    const machineOf = (machineId: string) => machines.find((machine) => machine.id === machineId);
    const warningOf = (machineId: string) => machineOf(machineId)?.lastHello?.idleStopWarning;
    const taken = records.find((record) => record.power?.keyId === keyId);
    const takenWarning = taken ? warningOf(taken.machineId) : undefined;
    const refused = records.find((record) => record.powerError?.keyId === keyId)
      ?? (takenWarning && machineIdleWarningKind(takenWarning) === "refused" ? taken : undefined);
    if (refused) {
      return { message: "AWS does not accept the automatic-stop key.", action: "set-up-again", actionLabel: "Set up again" };
    }
    if (!taken) {
      // The key goes over by an update that waits for the machine to be idle.
      // Only an update that gave up needs the User; one that waits does not.
      const appVersion = this.deps.appVersion;
      const stalled = appVersion ? records.find((item) => {
        const last = item.lastOperation;
        return last && last.phase !== "ready" && isMachineInstallTerminalPhase(last.phase) && last.recovery?.kind !== "machine-busy"
          && !last.interrupted && isAutoUpgradeOf(last.operationId, appVersion) && item.installedVersion !== appVersion;
      }) : undefined;
      const exhausted = records.find((item) => item.powerRetry?.keyId === keyId && (item.powerRetry.attempts ?? 1) >= MACHINE_POWER_MAX_ATTEMPTS);
      const failed = stalled ?? exhausted;
      if (failed) {
        return { message: "The cloud machine could not take its automatic-stop key.", action: "reconnect", actionLabel: "Try again",
          machineId: failed.machineId };
      }
      return undefined;
    }
    const notTaken = await this.switchNotTaken(power, handle, true);
    if (notTaken) return notTaken;
    const warning = warningOf(taken.machineId);
    const kind = warning ? machineIdleWarningKind(warning) : undefined;
    if (kind === "unconfirmed") {
      return { message: "The cloud machine is stopping the instance and has not finished yet; it keeps trying. Stop above stops it now." };
    }
    if (kind !== "fault") return undefined;
    return { message: "The cloud machine could not finish its check, so it stays on for now and tries again by itself. If this stays, stop the instance when you finish." };
  }

  /** Why the program on the instance's machine is still not back although
   *  the app tried to bring it back itself, or nothing. */
  private async machineDown(handle: AwsWorkerHandleInfo): Promise<string | undefined> {
    const { records } = await this.aws.installedPrograms.installsOnInstance(handle);
    for (const record of records) {
      if (!record.installedVersion || this.deps.machineConnected?.(record.machineId) !== false) continue;
      const failure = this.deps.machineRecoveryFailure?.(record.machineId);
      if (failure) return machineRecoveryMessage(failure);
    }
    return undefined;
  }

  /**
   * The machine holding the key reports a different switch than the User set,
   * in a report made after the change: the change did not arrive. A runtime
   * from before the switch reports none and always stops when idle, which
   * matters only while the switch is off.
   */
  private async switchNotTaken(power: AwsMachinePowerConfig, handle: AwsWorkerHandleInfo,
    enabled: boolean): Promise<AwsWorkerAutoStopProblem | undefined> {
    const { machines, records } = await this.aws.installedPrograms.installsOnInstance(handle);
    const holder = records.find((record) => record.power?.keyId === power.credentials.accessKeyId);
    const machine = holder ? machines.find((item) => item.id === holder.machineId) : undefined;
    if (!machine?.lastHello || this.deps.machineConnected?.(machine.id) !== true) return undefined;
    const reported = machine.lastHello.autoStopEnabled;
    if (reported === undefined) {
      return enabled ? undefined : { message: "The program on the cloud machine is older and still stops the instance by itself; it takes the switch after its next update." };
    }
    const changedAt = Date.parse(await this.deps.settings.getMachineAutoStopChangedAt() ?? "");
    // A report within moments of the change may predate the settings it is
    // about; only a later one says the change did not arrive.
    const reportedAfterChange = !Number.isFinite(changedAt) || Date.parse(machine.lastSeenAt ?? "") > changedAt + SWITCH_REPORT_MARGIN_MS;
    if (reported === enabled || !reportedAfterChange) return undefined;
    return { message: enabled
      ? "The cloud machine still has automatic stop switched off. Switch it off and on again to send it once more."
      : "The cloud machine still has automatic stop switched on, so it may stop the instance. Switch it on and off again to send it once more." };
  }

  /** Saves the stop key from a pasted setup result. The result must carry
   *  one: a result from an older command would turn the switch on with
   *  nothing that can stop the instance. */
  async adoptAutoStopKey(blob: string): Promise<void> {
    if (!parseWorkerBlob(blob).power) {
      throw new Error("This result has no automatic-stop key. Copy the command shown here again and run it; it makes one.");
    }
    await this.aws.bootstrap.adoptCredentials(blob);
  }

  /** The switch. On with a pasted result saves its stop key first; on
   *  without one needs a usable key already saved. Off keeps the key. */
  async setAutoStop(request: SetAwsAutoStopRequest): Promise<{ keyAdded: boolean }> {
    const enabled = request?.enabled === true;
    const blob = typeof request?.blob === "string" ? request.blob.trim() : "";
    if (blob) await this.adoptAutoStopKey(blob);
    else if (enabled && !await this.hasAutoStopKey()) {
      throw new Error("Run the setup command first: there is no automatic-stop key yet.");
    }
    await this.deps.settings.setMachineAutoStopEnabled(enabled);
    return { keyAdded: Boolean(blob) };
  }

  /** The install record of the machine on this instance that holds, or is
   *  to take, the stop key: the one the Automatic stop row's fix acts on. */
  async autoStopMachineRecord(): Promise<MachineInstallRecord | undefined> {
    const [credentials, publicSettings] = await Promise.all([this.deps.settings.getAwsWorkerCredentials(), this.deps.settings.getPublicSettings()]);
    const handle = publicSettings.cloudRuns.awsHandle;
    if (!handle) return undefined;
    const records = (await this.aws.installedPrograms.installsOnInstance(handle)).records.filter((record) => record.installedVersion);
    const keyId = credentials?.power?.accessKeyId;
    return records.find((record) => keyId && record.power?.keyId === keyId) ?? records[0];
  }

  /** A stop key for the instance's own region is saved. */
  async hasAutoStopKey(): Promise<boolean> {
    const [credentials, publicSettings] = await Promise.all([this.deps.settings.getAwsWorkerCredentials(), this.deps.settings.getPublicSettings()]);
    const handle = publicSettings.cloudRuns.awsHandle;
    return Boolean(credentials && handle && powerConfigFor(credentials, handle));
  }

  /** The switch reads on: a usable key, and the User left it on. */
  async autoStopSwitchedOn(): Promise<boolean> {
    return await this.hasAutoStopKey() && await this.deps.settings.getMachineAutoStopEnabled();
  }
}
