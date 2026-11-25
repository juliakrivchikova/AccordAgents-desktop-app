import type { AppMcpDependencies } from "./dependencies";
import { AccessTokens } from "./accessTokens";
import { ClientStates } from "./clientStates";
import { McpServer } from "./mcpServer";
import { ToolCalls } from "./toolCalls";
import { ToolHandlers } from "./toolHandlers";

/** The app tools' parts. Each names the ones it uses in its constructor. */
export interface AppMcpModules {
  readonly toolHandlers: ToolHandlers;
  readonly accessTokens: AccessTokens;
  readonly mcpServer: McpServer;
  readonly clientStates: ClientStates;
  readonly toolCalls: ToolCalls;
}

/** Builds every part around one registry: parts call each other only once all of them exist. */
export function createAppMcpModules(deps: AppMcpDependencies): AppMcpModules {
  const modules = {} as { -readonly [Key in keyof AppMcpModules]: AppMcpModules[Key] };
  modules.toolHandlers = new ToolHandlers();
  modules.accessTokens = new AccessTokens(modules);
  modules.mcpServer = new McpServer(modules, deps);
  modules.clientStates = new ClientStates();
  modules.toolCalls = new ToolCalls(modules, deps);
  return modules;
}
