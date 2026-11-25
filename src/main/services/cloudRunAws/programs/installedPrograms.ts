import type { AwsWorkerHandleInfo } from "../../../../shared/types";
import type { MachineInstallRecord } from "../../../../shared/machineInstall";
import type { MachineRecord } from "../../../../shared/machineLink";
import type { AwsDependencies } from "../dependencies";

/** What AccordAgents installed on the instance. */
export class InstalledPrograms {
  constructor(private readonly deps: Pick<AwsDependencies, "settings">) {}

  /** This app's machines on its instance, and their install records. A
   *  machine counts when its record names the instance, or when it was
   *  installed over the instance's own pinned host key. */
  async installsOnInstance(handle: AwsWorkerHandleInfo): Promise<{ machines: MachineRecord[]; records: MachineInstallRecord[] }> {
    const [machines, installs] = await Promise.all([this.deps.settings.listMachines(), this.deps.settings.listMachineInstalls()]);
    const pinned = new Set(installs.filter((record) => record.target?.hostKeyAlias === `accordagents-${handle.instanceId}`).map((record) => record.machineId));
    const onInstance = machines.filter((machine) => machine.awsInstanceId === handle.instanceId || (!machine.awsInstanceId && pinned.has(machine.id)));
    const ids = new Set(onInstance.map((machine) => machine.id));
    return { machines: onInstance, records: installs.filter((record) => ids.has(record.machineId)) };
  }

  /** Whether this desktop's cloud program is on that instance and has
   *  connected at least once: one installed that never reached this desktop
   *  is not set up yet. */
  async programInstalledOn(instanceId: string): Promise<boolean> {
    const { machines, records } = await this.installsOnInstance({ instanceId } as AwsWorkerHandleInfo);
    return records.some((record) => Boolean(record.installedVersion)
      && Boolean(machines.find((machine) => machine.id === record.machineId)?.lastHello));
  }

  /** Where this desktop's program and its data live on the instance, as
   *  its setup recorded them; undefined before the first setup. */
  async programFoldersOnInstance(): Promise<{ installRoot: string; userDataDir?: string } | undefined> {
    const record = await this.programRecordOnInstance();
    return record ? { installRoot: record.installRoot, userDataDir: record.userDataDir || undefined } : undefined;
  }

  /** This desktop's cloud program on the instance, as its setup recorded
   *  it: the machine whose project copies Settings manages. */
  async programRecordOnInstance(): Promise<MachineInstallRecord | undefined> {
    const handle = (await this.deps.settings.getPublicSettings()).cloudRuns.awsHandle;
    if (!handle) return undefined;
    // The newest install, the same one whichever record was saved last.
    return (await this.installsOnInstance(handle)).records.filter((item) => item.installRoot && item.installedVersion)
      .sort((left, right) => (right.installedAt ?? "").localeCompare(left.installedAt ?? ""))[0];
  }

  /** The install record of one machine on this instance. */
  async machineRecordOnInstance(machineId: string): Promise<MachineInstallRecord | undefined> {
    const handle = (await this.deps.settings.getPublicSettings()).cloudRuns.awsHandle;
    if (!handle) return undefined;
    return (await this.installsOnInstance(handle)).records.find((record) => record.machineId === machineId && record.installedVersion);
  }
}
