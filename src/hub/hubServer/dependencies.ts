import type { HubServerOptions } from "./types";

/** What the server is started with. */
export interface HubServerDependencies {
  readonly options: HubServerOptions;
  readonly now: () => number;
}
