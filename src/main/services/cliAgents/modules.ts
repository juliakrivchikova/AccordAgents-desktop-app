import type { CliDependencies } from "./dependencies";
import { AgentReadiness } from "./runs/agentReadiness";
import { ClaudeProcess } from "./claude/claudeProcess";
import { ClaudeReplyFlow } from "./claude/claudeReplyFlow";
import { ClaudeRuns } from "./claude/claudeRuns";
import { ClaudeSettings } from "./claude/claudeSettings";
import { CliRuns } from "./runs/cliRuns";
import { CodexAppServer } from "./codex/codexAppServer";
import { CodexAppServerNotifications } from "./codex/codexAppServerNotifications";
import { CodexRuns } from "./codex/codexRuns";
import { GeminiRuns } from "./gemini/geminiRuns";
import { ModelCatalogs } from "./models/modelCatalogs";
import { SessionLogs } from "./runs/sessionLogs";
import { WarmAgentClose } from "./warm/warmAgentClose";
import { WarmAgents } from "./warm/warmAgents";

/** The CLI runner's parts. Each names the ones it uses in its constructor. */
export interface CliModules {
  readonly cliRuns: CliRuns;
  readonly sessionLogs: SessionLogs;
  readonly agentReadiness: AgentReadiness;
  readonly modelCatalogs: ModelCatalogs;
  readonly warmAgents: WarmAgents;
  readonly warmAgentClose: WarmAgentClose;
  readonly geminiRuns: GeminiRuns;
  readonly codexRuns: CodexRuns;
  readonly codexAppServer: CodexAppServer;
  readonly codexAppServerNotifications: CodexAppServerNotifications;
  readonly claudeRuns: ClaudeRuns;
  readonly claudeProcess: ClaudeProcess;
  readonly claudeReplyFlow: ClaudeReplyFlow;
  readonly claudeSettings: ClaudeSettings;
}

/** Builds every part around one registry: parts call each other only once all of them exist. */
export function createCliModules(deps: CliDependencies): CliModules {
  const modules = {} as { -readonly [Key in keyof CliModules]: CliModules[Key] };
  modules.cliRuns = new CliRuns(modules, deps);
  modules.sessionLogs = new SessionLogs(modules);
  modules.agentReadiness = new AgentReadiness(modules, deps);
  modules.modelCatalogs = new ModelCatalogs(modules, deps);
  modules.warmAgents = new WarmAgents(modules, deps);
  modules.warmAgentClose = new WarmAgentClose(modules);
  modules.geminiRuns = new GeminiRuns(modules, deps);
  modules.codexRuns = new CodexRuns(modules);
  modules.codexAppServer = new CodexAppServer(modules, deps);
  modules.codexAppServerNotifications = new CodexAppServerNotifications(deps);
  modules.claudeRuns = new ClaudeRuns(modules);
  modules.claudeProcess = new ClaudeProcess(modules);
  modules.claudeReplyFlow = new ClaudeReplyFlow(modules);
  modules.claudeSettings = new ClaudeSettings(modules, deps);
  return modules;
}
