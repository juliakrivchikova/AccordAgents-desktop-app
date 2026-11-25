import type { ScriptServiceOptions } from "./types";

/** What scheduled scripts are given by their host. */
export interface ScriptDependencies {
  readonly options: ScriptServiceOptions;
  readonly now: () => number;
  readonly tickMs: number;
}
