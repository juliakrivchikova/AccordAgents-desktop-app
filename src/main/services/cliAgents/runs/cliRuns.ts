import type { ConversationKind, GitDiffMode, ParticipantConfig } from "../../../../shared/types";
import { CLI_AGENT_RUN_TIMEOUT_DEFAULT_MS, normalizeCliAgentRunTimeoutMs } from "../../../../shared/cliAgentRunSettings";
import { cliFailureNoticeText } from "../../../../shared/warnings";
import { commandEnvironment, resolveCommandPath, type CommandEnvironmentOptions } from "../../command";
import type { ParticipantRunResult } from "../../providers";
import { errorText, failedCompact, isTimeoutError } from "./outputText";
import { agentRunEnv, repoPathForRun } from "./runEnvironment";
import { runsOnOwnSignIn } from "../../cliPlanUsage";
import type { CliAgentCompactResult, CliAgentRunOptions } from "../types";
import type { CliModules } from "../modules";
import type { CliDependencies } from "../dependencies";

/** What a compaction stopped before it started says; a member on a machine
 *  stopped before its compaction was sent says the same. */
export const COMPACTION_CANCELLED_BEFORE_START = "Compaction was cancelled before native execution started.";

/** Runs one turn or compaction of a member on its CLI, and says what may start now. */
export class CliRuns {
  private readonly warmUnsupportedLogged = new Set<ParticipantConfig["kind"]>();
  runTimeoutMs = CLI_AGENT_RUN_TIMEOUT_DEFAULT_MS;
  private nativeOperations = 0;
  nativeAdmissionsFenced = false;
  nativeShutdownGeneration = 0;
  /** Host-wide gate: another deployment on this machine may have committed an
   *  idle stop, and its decision has to be refused here, before a provider is
   *  started, not discovered when the instance disappears. */
  private hostAdmission?: (what: string) => Promise<{ admitted: true } | { admitted: false; reason: string }> | { admitted: true } | { admitted: false; reason: string };

  constructor(
    private readonly cli: Pick<
      CliModules,
      | "claudeRuns" | "claudeSettings" | "codexRuns" | "geminiRuns" | "planUsage" | "warmAgentClose" | "warmAgents"
    >,
    private readonly deps: Pick<CliDependencies, "codexExecutable" | "debugLogs">
  ) {}

  codexExecutableForRun(options: CliAgentRunOptions = {}): Promise<string> {
    if (this.deps.codexExecutable !== "codex") {
      return Promise.resolve(this.deps.codexExecutable);
    }
    return this.providerExecutableForRun("codex", options);
  }

  providerExecutableForRun(
    executable: "codex" | "claude" | "agy",
    options: CliAgentRunOptions = {},
    envOptions: CommandEnvironmentOptions = {}
  ): Promise<string> {
    return resolveCommandPath(executable, commandEnvironment(agentRunEnv(options), envOptions));
  }

  setRunTimeoutMs(timeoutMs: number): void {
    this.runTimeoutMs = normalizeCliAgentRunTimeoutMs(timeoutMs);
  }

  async run(
    participant: ParticipantConfig,
    prompt: string,
    repoPath: string | undefined,
    diffMode: GitDiffMode | undefined,
    kind: ConversationKind,
    signal?: AbortSignal,
    options: CliAgentRunOptions = {}
  ): Promise<ParticipantRunResult> {
    if (this.nativeAdmissionsFenced) return this.failed(participant, new Error("The machine is stopping after idle; this native command did not start."));
    if (options.warm && this.cli.warmAgents.conversationClosing(options.warm.conversationId)) {
      return this.failed(participant, new Error("This chat's native sessions are closing; this command did not start."));
    }
    const effectiveRepoPath = repoPathForRun(repoPath, diffMode, kind);
    const idleMonitor = options.nativeGoal
      ? this.cli.warmAgents.createNativeGoalIdleMonitor(participant, options.onOutput)
      : undefined;
    const effectiveOptions: CliAgentRunOptions = idleMonitor
      ? {
          ...options,
          timeoutMs: 0,
          onProviderActivity: idleMonitor.touch,
          onOutput: (event) => {
            idleMonitor.touch();
            options.onOutput?.(event);
          }
        }
      : options;
    this.nativeOperations++;
    this.cli.warmAgents.trackConversationOperation(options.warm?.conversationId, 1);
    const shutdownGeneration = this.nativeShutdownGeneration;
    // A turn routed into the member's busy process holds it until the turn is over.
    let releaseEnvironmentHold = (): void => undefined;
    try {
      // Every Claude turn (a goal, a warm or a one-shot one) starts its CLI
      // with the same Claude in Chrome. Read before the checks below, so a
      // shutdown during the read stops the turn too.
      let runOptions = effectiveOptions;
      if (participant.kind === "claude-code") {
        const routed = this.cli.warmAgents.withBusyMemberEnvironment(participant, effectiveRepoPath, kind,
          await this.cli.claudeSettings.withClaudeChrome(participant, effectiveRepoPath, kind, effectiveOptions));
        runOptions = routed.options;
        releaseEnvironmentHold = routed.release;
      }
      const refusal = await this.hostRefusal("this native command");
      if (shutdownGeneration !== this.nativeShutdownGeneration) return this.failed(participant, new Error("Native sessions shut down while this command waited; it did not start."));
      if (signal?.aborted) return this.failed(participant, new Error("The command was cancelled before native execution started."));
      if (options.warm && this.cli.warmAgents.conversationClosing(options.warm.conversationId)) return this.failed(participant, new Error("This chat is closing; the command did not start."));
      if (refusal || this.nativeAdmissionsFenced) return this.failed(participant, new Error(refusal ?? "Native admission is fenced."));
      if (participant.kind === "codex-cli") {
        return await this.cli.codexRuns.runCodex(participant, prompt, effectiveRepoPath, diffMode, kind, signal, effectiveOptions);
      }
      if (participant.kind === "claude-code") {
        return await this.cli.claudeRuns.runClaude(participant, prompt, effectiveRepoPath, kind, signal, runOptions);
      }
      if (participant.kind === "gemini-cli") {
        return await this.cli.geminiRuns.runGemini(participant, prompt, effectiveRepoPath, kind, signal, effectiveOptions);
      }
      return { participant, ok: false, content: "", error: `${participant.label} is not a CLI agent.` };
    } finally {
      releaseEnvironmentHold();
      this.nativeOperations--;
      this.cli.warmAgents.trackConversationOperation(options.warm?.conversationId, -1);
      idleMonitor?.close();
      // agy pushes no usage: `/usage` is read after its turns (a minute apart
      // at most), on its own sign-in only.
      if (participant.kind === "gemini-cli" && runsOnOwnSignIn(participant, options.agentEnv)) this.cli.planUsage.geminiTurnEnded();
    }
  }

  async compactSession(
    participant: ParticipantConfig,
    repoPath: string | undefined,
    diffMode: GitDiffMode | undefined,
    kind: ConversationKind,
    signal?: AbortSignal,
    options: CliAgentRunOptions = {}
  ): Promise<CliAgentCompactResult> {
    if (this.nativeAdmissionsFenced) return { participant, ok: false, error: "The machine is stopping after idle; compaction did not start." };
    if (options.warm && this.cli.warmAgents.conversationClosing(options.warm.conversationId)) {
      return { participant, ok: false, error: "This chat's native sessions are closing; compaction did not start." };
    }
    if (!options.sessionId) {
      return { participant, ok: false, error: `${participant.label} does not have an active CLI session to compact.` };
    }
    const effectiveRepoPath = repoPathForRun(repoPath, diffMode, kind);
    this.nativeOperations++;
    this.cli.warmAgents.trackConversationOperation(options.warm?.conversationId, 1);
    const shutdownGeneration = this.nativeShutdownGeneration;
    let releaseEnvironmentHold = (): void => undefined;
    try {
      // The same key as its turns: a compaction must not replace the process
      // the member's turns run in only because Chrome was not looked up here.
      let compactOptions = options;
      if (participant.kind === "claude-code") {
        const routed = this.cli.warmAgents.withBusyMemberEnvironment(participant, effectiveRepoPath, kind,
          await this.cli.claudeSettings.withClaudeChrome(participant, effectiveRepoPath, kind, options));
        compactOptions = routed.options;
        releaseEnvironmentHold = routed.release;
      }
      const compactionRefusal = await this.hostRefusal("compaction");
      if (shutdownGeneration !== this.nativeShutdownGeneration) return failedCompact(participant, new Error("Native sessions shut down while compaction waited; it did not start."));
      if (signal?.aborted) return failedCompact(participant, new Error(COMPACTION_CANCELLED_BEFORE_START));
      if (options.warm && this.cli.warmAgents.conversationClosing(options.warm.conversationId)) return failedCompact(participant, new Error("This chat is closing; compaction did not start."));
      if (compactionRefusal || this.nativeAdmissionsFenced) return { participant, ok: false, error: compactionRefusal ?? "Native admission is fenced." };
      if (participant.kind === "codex-cli") {
        return await this.cli.codexRuns.compactCodexSession(participant, effectiveRepoPath, diffMode, kind, signal, options);
      }
      if (participant.kind === "claude-code") {
        return await this.cli.claudeRuns.compactClaudeSession(participant, effectiveRepoPath, kind, signal, compactOptions);
      }
      if (participant.kind === "gemini-cli") {
        return await this.cli.geminiRuns.compactGeminiSession(participant, effectiveRepoPath, kind, signal, options);
      }
      return { participant, ok: false, error: `${participant.label} is not a CLI agent.` };
    } finally { releaseEnvironmentHold(); this.nativeOperations--; this.cli.warmAgents.trackConversationOperation(options.warm?.conversationId, -1); }
  }

  hasActiveNativeWork(): boolean {
    return this.nativeOperations > 0 || this.cli.warmAgents.warmOperations > 0 || this.cli.claudeRuns.claudeScopeWaits > 0 || this.cli.warmAgents.warmPreparations.size > 0 || this.cli.warmAgents.warmAgentCreations.size > 0 || this.cli.warmAgentClose.closingWarmAgents.size > 0 || this.cli.warmAgentClose.failedWarmClosures.size > 0 ||
      [...this.cli.warmAgents.entries.values()].some(entry => !entry.closed && (entry.hasLiveBackgroundWork?.() || entry.isIdle?.() === false));
  }

  /** Every deployment on this host shares one instance. Consulted before any
   * native work starts; admission also tells the other deployments that this
   * one is busy, in the same step, so a stop cannot commit around it. */
  setHostAdmission(gate: ((what: string) => Promise<{ admitted: true } | { admitted: false; reason: string }> | { admitted: true } | { admitted: false; reason: string }) | undefined): void {
    this.hostAdmission = gate;
  }

  /** The reason new native work may not start, or undefined when it may. */
  async hostRefusal(what: string): Promise<string | undefined> {
    if (!this.hostAdmission) return undefined;
    let decision: { admitted: true } | { admitted: false; reason: string };
    try {
      decision = await this.hostAdmission(what);
    } catch (error) {
      // Coordination that cannot be read is not permission to start work on a
      // machine another deployment may be stopping.
      return `This machine's deployments cannot coordinate, so ${what} did not start: ${error instanceof Error ? error.message : String(error)}`;
    }
    return decision.admitted ? undefined : decision.reason;
  }

  /** Idle power-off must not race a queued turn/compaction. The caller can
   * release this gate only before committing its durable power-stop fence. */
  fenceIdleNativeAdmissions(): (() => void) | undefined {
    if (this.nativeAdmissionsFenced || this.cli.warmAgents.warmShutdown || this.hasActiveNativeWork()) return undefined;
    this.nativeAdmissionsFenced = true;
    return () => { this.nativeAdmissionsFenced = false; };
  }

  private logWarmUnsupportedOnce(providerKind: ParticipantConfig["kind"], reason: string): void {
    if (this.warmUnsupportedLogged.has(providerKind)) {
      return;
    }
    this.warmUnsupportedLogged.add(providerKind);
    void this.writeDebugLog("cli-agent-warm-unsupported", { providerKind, reason });
  }

  async writeDebugLog(event: string, payload: Record<string, unknown>): Promise<void> {
    await this.deps.debugLogs?.write(event, payload);
  }

  failed(participant: ParticipantConfig, error: unknown, durationMs?: number): ParticipantRunResult {
    const message = errorText(error);
    return {
      participant,
      ok: false,
      content: this.visibleFailureText(participant, error, message),
      error: message,
      durationMs
    };
  }

  private visibleFailureText(participant: ParticipantConfig, error: unknown, diagnostic: string): string {
    return cliFailureNoticeText(diagnostic, {
      label: participant.label,
      defaultTimeoutMs: this.runTimeoutMs,
      forceTimeout: isTimeoutError(error, diagnostic)
    });
  }
}
