import type { MachineLinkDependencies } from "./dependencies";
import { BusyMachines } from "./busyMachines";
import { Enrollments } from "./enrollments";
import { MachineConnections } from "./machineConnections";
import { MachineMessages } from "./machineMessages";
import { MachineScripts } from "./machineScripts";
import { MachineSupport } from "./machineSupport";
import { SettingsPublication } from "./settingsPublication";
import { TurnHolds } from "./turnHolds";

/** The machine link's parts. Each names the ones it uses in its constructor. */
export interface MachineLinkModules {
  readonly machineConnections: MachineConnections;
  readonly enrollments: Enrollments;
  readonly settingsPublication: SettingsPublication;
  readonly turnHolds: TurnHolds;
  readonly machineMessages: MachineMessages;
  readonly machineScripts: MachineScripts;
  readonly machineSupport: MachineSupport;
  readonly busyMachines: BusyMachines;
}

/** Builds every part around one registry: parts call each other only once all of them exist. */
export function createMachineLinkModules(deps: MachineLinkDependencies): MachineLinkModules {
  const modules = {} as { -readonly [Key in keyof MachineLinkModules]: MachineLinkModules[Key] };
  modules.machineConnections = new MachineConnections(modules, deps);
  modules.enrollments = new Enrollments(modules, deps);
  modules.settingsPublication = new SettingsPublication(modules, deps);
  modules.turnHolds = new TurnHolds(modules, deps);
  modules.machineMessages = new MachineMessages(modules, deps);
  modules.machineScripts = new MachineScripts(modules, deps);
  modules.machineSupport = new MachineSupport(modules);
  modules.busyMachines = new BusyMachines(modules, deps);
  return modules;
}
