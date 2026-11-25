import type { MachineInstallerDependencies } from "./dependencies";
import { EnvironmentOwner } from "./environmentOwner";
import { InstallRecords } from "./installRecords";
import { InstallRecovery } from "./installRecovery";
import { InstallRun } from "./installRun";
import { Installs } from "./installs";
import { MachineProbe } from "./machineProbe";
import { ProjectMirrors } from "./projectMirrors";
import { RuntimePayload } from "./runtimePayload";

/** The installer's parts. Each names the ones it uses in its constructor. */
export interface MachineInstallerModules {
  readonly installs: Installs;
  readonly installRun: InstallRun;
  readonly runtimePayload: RuntimePayload;
  readonly machineProbe: MachineProbe;
  readonly environmentOwner: EnvironmentOwner;
  readonly installRecovery: InstallRecovery;
  readonly projectMirrors: ProjectMirrors;
  readonly installRecords: InstallRecords;
}

/** Builds every part around one registry: parts call each other only once all of them exist. */
export function createMachineInstallerModules(deps: MachineInstallerDependencies): MachineInstallerModules {
  const modules = {} as { -readonly [Key in keyof MachineInstallerModules]: MachineInstallerModules[Key] };
  modules.installs = new Installs(modules, deps);
  modules.installRun = new InstallRun(modules, deps);
  modules.runtimePayload = new RuntimePayload(deps);
  modules.machineProbe = new MachineProbe(deps);
  modules.environmentOwner = new EnvironmentOwner(modules, deps);
  modules.installRecovery = new InstallRecovery(deps);
  modules.projectMirrors = new ProjectMirrors(modules, deps);
  modules.installRecords = new InstallRecords(deps);
  return modules;
}
