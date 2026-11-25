import type { MachineLinkDependencies } from "../dependencies";
import type { MachineLinkModules } from "../modules";

// The parts of the machine link as its tests set them up and watch them:
// their private members too, so a test names the part that does the work.
type Open<T> = { -readonly [Key in keyof T]-?: any };

export function linkParts(link: unknown): Open<MachineLinkModules> {
  return (link as { modules: Open<MachineLinkModules> }).modules;
}

/** What that link was given; one object, shared by every part. */
export function linkDependencies(link: unknown): Open<MachineLinkDependencies> {
  return linkParts(link).machineConnections.deps as Open<MachineLinkDependencies>;
}
