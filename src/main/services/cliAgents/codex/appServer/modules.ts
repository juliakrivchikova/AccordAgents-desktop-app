import type { AppServerLaunch } from "./launch";
import { AppServerApprovals } from "./appServerApprovals";
import { AppServerConnection } from "./appServerConnection";
import { AppServerGuardian } from "./appServerGuardian";
import { AppServerThread } from "./appServerThread";
import { AppServerTurns } from "./appServerTurns";

/** One app-server process, by what each part of it keeps. */
export interface AppServerModules {
  readonly connection: AppServerConnection;
  readonly thread: AppServerThread;
  readonly turns: AppServerTurns;
  readonly approvals: AppServerApprovals;
  readonly guardian: AppServerGuardian;
}

/** Builds the parts of one process: they call each other only once all of them exist. */
export function createAppServerModules(deps: AppServerLaunch): AppServerModules {
  const modules = {} as { -readonly [Key in keyof AppServerModules]: AppServerModules[Key] };
  modules.connection = new AppServerConnection(modules, deps);
  modules.thread = new AppServerThread(modules, deps);
  modules.turns = new AppServerTurns(modules, deps);
  modules.approvals = new AppServerApprovals(modules);
  modules.guardian = new AppServerGuardian(modules, deps);
  return modules;
}
