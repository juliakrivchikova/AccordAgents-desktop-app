import type { ScriptDependencies } from "../dependencies";
import type { ScriptModules } from "../modules";

// The parts of the scheduled scripts as their tests set them up and watch
// them: their private members too, so a test names the part that does the work.
type Open<T> = { -readonly [Key in keyof T]-?: any };

export function scriptParts(service: unknown): Open<ScriptModules> {
  return (service as { modules: Open<ScriptModules> }).modules;
}

/** What that service was given; one object, shared by every part. */
export function scriptDependencies(service: unknown): Open<ScriptDependencies> {
  return scriptParts(service).scriptHost.deps as Open<ScriptDependencies>;
}
