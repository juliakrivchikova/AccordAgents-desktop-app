import type { MachineInstallerDependencies } from "../dependencies";
import type { MachineInstallerModules } from "../modules";

// The parts of the installer as its tests set them up and watch them: their
// private members too, so a test names the part that does the work.
type Open<T> = { -readonly [Key in keyof T]-?: any };

export function installerParts(service: unknown): Open<MachineInstallerModules> {
  return (service as { modules: Open<MachineInstallerModules> }).modules;
}

/** What that service was given; one object, shared by every part. */
export function installerDependencies(service: unknown): Open<MachineInstallerDependencies> {
  return installerParts(service).installRun.deps as Open<MachineInstallerDependencies>;
}
