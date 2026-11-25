import type { ScriptDependencies } from "./dependencies";
import { Approvals } from "./proposals/approvals";
import { Proposals } from "./proposals/proposals";
import { Scheduler } from "./runs/scheduler";
import { ScriptHealth } from "./runs/scriptHealth";
import { ScriptHost } from "./records/scriptHost";
import { ScriptPosts } from "./posts/scriptPosts";
import { ScriptRecords } from "./records/scriptRecords";
import { ScriptRuns } from "./runs/scriptRuns";

/** The scheduled scripts' parts. Each names the ones it uses in its constructor. */
export interface ScriptModules {
  readonly scheduler: Scheduler;
  readonly scriptRuns: ScriptRuns;
  readonly scriptHealth: ScriptHealth;
  readonly scriptPosts: ScriptPosts;
  readonly proposals: Proposals;
  readonly approvals: Approvals;
  readonly scriptRecords: ScriptRecords;
  readonly scriptHost: ScriptHost;
}

/** Builds every part around one registry: parts call each other only once all of them exist. */
export function createScriptModules(deps: ScriptDependencies): ScriptModules {
  const modules = {} as { -readonly [Key in keyof ScriptModules]: ScriptModules[Key] };
  modules.scheduler = new Scheduler(modules, deps);
  modules.scriptRuns = new ScriptRuns(modules, deps);
  modules.scriptHealth = new ScriptHealth(modules, deps);
  modules.scriptPosts = new ScriptPosts(modules, deps);
  modules.proposals = new Proposals(modules, deps);
  modules.approvals = new Approvals(modules, deps);
  modules.scriptRecords = new ScriptRecords(modules, deps);
  modules.scriptHost = new ScriptHost(deps);
  return modules;
}
