import type { WarmAgentEntry } from "../types";
import type { AppServerLaunch } from "./appServer/launch";
import { createAppServerModules, type AppServerModules } from "./appServer/modules";

/** One live codex app-server process. The work is done by the parts in ./appServer. */
export class CodexAppServerProcess {
  private readonly modules: AppServerModules;

  constructor(launch: AppServerLaunch) {
    this.modules = createAppServerModules(launch);
  }

  /** Starts listening and gives the runner its handle on the process. */
  start(): WarmAgentEntry {
    return this.modules.turns.start();
  }
}
