import type { ConversationKind, GitDiffMode, ParticipantConfig } from "../../../../shared/types";
import { commandEnvironment } from "../../command";
import { CodexAppServerProcess } from "./codexAppServerProcess";
import { agentRunEnv } from "../runs/runEnvironment";
import type { CliAgentRunOptions, WarmAgentEntry } from "../types";
import type { CliModules } from "../modules";
import type { CliDependencies } from "../dependencies";

/** A member's live codex app-server process. */
export class CodexAppServer {
  constructor(
    private readonly cli: Pick<
      CliModules,
      | "cliRuns" | "codexAppServerNotifications" | "codexRuns" | "planUsage" | "sessionLogs" | "warmAgentClose" | "warmAgents"
    >,
    private readonly deps: Pick<CliDependencies, "debugLogs">
  ) {}

  async createCodexAppServerWarmAgent(
    key: string,
    scopeKey: string,
    participant: ParticipantConfig,
    repoPath: string | undefined,
    diffMode: GitDiffMode | undefined,
    kind: ConversationKind,
    options: CliAgentRunOptions,
    codexExecutable: string
  ): Promise<WarmAgentEntry> {
    return this.cli.warmAgents.createTrackedWarmAgent(key, () => this.constructCodexAppServerWarmAgent(key, scopeKey, participant, repoPath, diffMode, kind, options, codexExecutable), options.agentEnvGeneration);
  }

  private async constructCodexAppServerWarmAgent(
    key: string,
    scopeKey: string,
    participant: ParticipantConfig,
    repoPath: string | undefined,
    diffMode: GitDiffMode | undefined,
    kind: ConversationKind,
    options: CliAgentRunOptions,
    codexExecutable: string
  ): Promise<WarmAgentEntry> {
    // `-c` overrides are global codex options; the app-server honors them for
    // every thread it hosts, which is how a member on an added provider reaches
    // that provider's Responses endpoint.
    const configArgs = (participant.codexConfigOverrides ?? []).flatMap((override) => ["-c", override]);
    const child = await this.cli.warmAgents.spawnResidentProcess(scopeKey, codexExecutable, ["app-server", ...configArgs, "--listen", "stdio://"], {
      cwd: repoPath,
      env: commandEnvironment(agentRunEnv(options)),
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });
    return new CodexAppServerProcess({
      cli: this.cli, debugLogs: this.deps.debugLogs, child, key, scopeKey, participant, repoPath, diffMode, kind, options
    }).start();
  }
}
