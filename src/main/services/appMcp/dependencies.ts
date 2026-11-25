import type { AppMcpDebugLogger } from "./types";

/** What the app tools are given by the app. */
export interface AppMcpDependencies {
  readonly debugLogs?: AppMcpDebugLogger;
}
