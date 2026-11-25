import type { CliDependencies } from "../dependencies";
import type { CliModules } from "../modules";

// The parts of a CLI runner as its tests set them up and watch them: their
// private members too, so a test names the part that does the work.
type Open<T> = { -readonly [Key in keyof T]-?: any };

export function cliParts(runner: unknown): Open<CliModules> {
  return (runner as { modules: Open<CliModules> }).modules;
}

/** What that runner was given; one object, shared by every part. */
export function cliDependencies(runner: unknown): Open<CliDependencies> {
  return cliParts(runner).cliRuns.deps as Open<CliDependencies>;
}
