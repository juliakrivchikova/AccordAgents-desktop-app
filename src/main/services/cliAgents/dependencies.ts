import { CliReadinessService } from "../cliReadiness";
import type { ClaudeModelProbeExpectSpawn, ClaudeModelProbePtySpawn } from "./models/claudeModelProbe";
import type { CliAgentDebugLogger } from "./types";

/** What the CLI runner is given by the app. */
export interface CliDependencies {
  readonly debugLogs?: CliAgentDebugLogger;
  /** Settings → Environment as members get it (SettingsService.getManualAgentEnvironment). */
  readonly manualReadinessEnvironment?: () => Promise<{ env: NodeJS.ProcessEnv; version?: string }>;
  readonly claudeModelProbePtySpawn?: ClaudeModelProbePtySpawn;
  readonly claudeModelProbeExpectSpawn: ClaudeModelProbeExpectSpawn;
  readonly readiness: CliReadinessService;
  readonly codexExecutable: string;
  readonly electronAppPath: string | undefined;
  readonly nativeProcessDbPath?: string | undefined;
  readonly claudeModelProbeDir?: string | undefined;
}
