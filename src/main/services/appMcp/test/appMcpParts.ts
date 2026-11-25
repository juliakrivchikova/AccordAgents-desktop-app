import type { AppMcpDependencies } from "../dependencies";
import type { AppMcpModules } from "../modules";

// The parts of the app tools as their tests set them up and watch them: their
// private members too, so a test names the part that does the work.
type Open<T> = { -readonly [Key in keyof T]-?: any };

export function appMcpParts(service: unknown): Open<AppMcpModules> {
  return (service as { modules: Open<AppMcpModules> }).modules;
}

/** What that service was given; one object, shared by every part. */
export function appMcpDependencies(service: unknown): Open<AppMcpDependencies> {
  return appMcpParts(service).toolCalls.deps as Open<AppMcpDependencies>;
}
