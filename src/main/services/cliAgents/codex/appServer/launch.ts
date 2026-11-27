import type { ConversationKind, GitDiffMode, ParticipantConfig } from "../../../../../shared/types";
import type { CliAgentRunOptions } from "../../types";
import type { CliModules } from "../../modules";
import type { CliDependencies } from "../../dependencies";

/** What one app-server process is started with. */
export interface AppServerLaunch {
  readonly cli: Pick<CliModules, "cliRuns" | "codexAppServerNotifications" | "codexRuns" | "planUsage" | "sessionLogs" | "warmAgentClose">;
  readonly debugLogs: CliDependencies["debugLogs"];
  readonly child: Awaited<ReturnType<CliModules["warmAgents"]["spawnResidentProcess"]>>;
  readonly key: string;
  readonly scopeKey: string;
  readonly participant: ParticipantConfig;
  readonly repoPath: string | undefined;
  readonly diffMode: GitDiffMode | undefined;
  readonly kind: ConversationKind;
  readonly options: CliAgentRunOptions;
}
