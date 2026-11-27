import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChatReasoningEffort, ConversationKind, GitDiffMode, ParticipantConfig } from "../../../../shared/types";
import { ensureLoginShellEnvPrimed, runCommand } from "../../command";
import {
  buildCodexExecInvocation, createCodexLineHandler, emitCodexLiveOutput as emitCodexExecLiveOutput,
  extractCodexSessionId as extractCodexExecSessionId, extractCodexText as extractCodexExecText
} from "../../codexExec";
import type { ParticipantRunResult } from "../../providers";
import { CodexAppServerRunError } from "./appServerErrors";
import { codexReasoningEffort, codexRunAccess, isCodexDeveloperInstructionsUnsupported } from "./appServerParams";
import { errorText, failedCompact, isResumeMiss, reportSessionId, resumeOnlyMissError } from "../runs/outputText";
import { readOptionalFile } from "../runs/records";
import { agentRunEnv, withAppMcpClientStatus } from "../runs/runEnvironment";
import type { CliAgentCompactResult, CliAgentRunOptions, CliAgentWarmOptions, WarmAgentEntry } from "../types";
import { warmAgentKey, warmAgentScopeKey, withoutWarm } from "../warm/warmKeys";
import type { CliModules } from "../modules";

const CODEX_APP_SERVER_DISABLED_ENV = "ACCORD_AGENTS_CODEX_APP_SERVER";

/** Codex turns, goals and compactions. */
export class CodexRuns {
  constructor(
    private readonly cli: Pick<
      CliModules,
      | "cliRuns" | "codexAppServer" | "modelCatalogs" | "sessionLogs" | "warmAgentClose" | "warmAgents"
    >
  ) {}

  async runCodex(
    participant: ParticipantConfig,
    prompt: string,
    repoPath: string | undefined,
    diffMode: GitDiffMode | undefined,
    kind: ConversationKind,
    signal?: AbortSignal,
    options: CliAgentRunOptions = {}
  ): Promise<ParticipantRunResult> {
    if (options.nativeGoal) {
      if (kind !== "chat") {
        return {
          participant,
          ok: false,
          content: "",
          error: "Native /goal is available only in Chat."
        };
      }
      if (!options.warm) {
        return this.runCodexNativeGoalOneOff(participant, prompt, repoPath, diffMode, kind, signal, options);
      }
      return this.runCodexAppServerWarmOrOneShot(participant, prompt, repoPath, diffMode, kind, signal, options);
    }
    if (options.warm && kind === "chat") {
      return this.runCodexAppServerWarmOrOneShot(participant, prompt, repoPath, diffMode, kind, signal, options);
    }
    return this.runCodexOneShot(participant, prompt, repoPath, diffMode, kind, signal, options);
  }

  private async runCodexNativeGoalOneOff(
    participant: ParticipantConfig,
    prompt: string,
    repoPath: string | undefined,
    diffMode: GitDiffMode | undefined,
    kind: ConversationKind,
    signal: AbortSignal | undefined,
    options: CliAgentRunOptions
  ): Promise<ParticipantRunResult> {
    if (process.env[CODEX_APP_SERVER_DISABLED_ENV] === "0") {
      return this.cli.cliRuns.failed(participant, new Error("Native /goal requires the Codex app-server transport; it is disabled."));
    }
    const finishPreparation = this.cli.warmAgents.beginWarmPreparation(`native-goal:${participant.id}`);
    try {
      await ensureLoginShellEnvPrimed();
      const codexExecutable = await this.cli.cliRuns.codexExecutableForRun(options);
      const entry = await this.cli.codexAppServer.createCodexAppServerWarmAgent(
        `native-goal:${randomUUID()}`,
        `native-goal:${participant.id}`,
        participant,
        repoPath,
        diffMode,
        kind,
        withoutWarm(options),
        codexExecutable
      );
      finishPreparation();
      try {
        const result = await entry.run(
          prompt,
          signal,
          options.onOutput,
          options.onSessionId,
          options.timeoutMs,
          options.nativeGoal,
          options.onCodexServerRequest,
          undefined,
          options.images?.items
        );
        return withAppMcpClientStatus(result, participant, options);
      } finally {
        await this.cli.warmAgentClose.closeWarmAgent(entry, "native-goal-complete");
      }
    } catch (error) {
      return this.cli.cliRuns.failed(participant, error);
    } finally { finishPreparation(); }
  }

  async compactCodexSession(
    participant: ParticipantConfig,
    repoPath: string | undefined,
    diffMode: GitDiffMode | undefined,
    kind: ConversationKind,
    signal: AbortSignal | undefined,
    options: CliAgentRunOptions
  ): Promise<CliAgentCompactResult> {
    if (this.cli.cliRuns.nativeAdmissionsFenced || this.cli.warmAgents.warmShutdown || (options.warm && this.cli.warmAgents.conversationClosing(options.warm.conversationId))) {
      return failedCompact(participant, new Error("Native sessions are shutting down; this command did not start."));
    }
    const compactWithEntry = async (entry: WarmAgentEntry, warm?: CliAgentWarmOptions): Promise<CliAgentCompactResult> => {
      if (!entry.compact) {
        return { participant, ok: false, error: "Codex app-server compact is not available." };
      }
      return this.cli.warmAgents.enqueueWarmRun(entry, async () => {
        this.cli.warmAgents.clearWarmIdleTimer(entry);
        try {
          const result = await entry.compact!(options.compactInstructions, signal, options.onSessionId);
          if (warm) {
            this.cli.warmAgents.scheduleWarmIdleTimer(entry, warm.idleTimeoutMs);
          }
          return result;
        } catch (error) {
          this.cli.warmAgents.entries.delete(entry.key);
          await this.cli.warmAgentClose.closeWarmAgent(entry, signal?.aborted ? "aborted" : "failed");
          return failedCompact(participant, error);
        }
      });
    };

    const warm = options.warm;
    if (warm && kind === "chat" && process.env[CODEX_APP_SERVER_DISABLED_ENV] !== "0") {
      const key = warmAgentKey(participant, repoPath, kind, options);
      const scopeKey = warmAgentScopeKey(warm);
      let entry: WarmAgentEntry | undefined;
      const finishPreparation = this.cli.warmAgents.beginWarmPreparation(key);
      try {
        await this.cli.warmAgents.closeStaleWarmAgents(scopeKey, key);
        entry = this.cli.warmAgents.entries.get(key);
        if (!entry || entry.closed || entry.process.exitCode !== null) {
          if (entry) {
            this.cli.warmAgents.entries.delete(key);
            await this.cli.warmAgentClose.closeWarmAgent(entry, "stale");
          }
          try {
            await ensureLoginShellEnvPrimed();
            const codexExecutable = await this.cli.cliRuns.codexExecutableForRun(options);
            entry = await this.cli.codexAppServer.createCodexAppServerWarmAgent(key, scopeKey, participant, repoPath, diffMode, kind, options, codexExecutable);
          } catch (error) {
            return failedCompact(participant, error);
          }
        }
      } finally { finishPreparation(); }
      return compactWithEntry(entry, warm);
    }

    const finishPreparation = this.cli.warmAgents.beginWarmPreparation(`compact:${options.sessionId}`);
    try {
      await ensureLoginShellEnvPrimed();
      const codexExecutable = await this.cli.cliRuns.codexExecutableForRun(options);
      const entry = await this.cli.codexAppServer.createCodexAppServerWarmAgent(
        `compact:${options.sessionId}:${randomUUID()}`,
        `compact:${options.sessionId}`,
        participant,
        repoPath,
        diffMode,
        kind,
        withoutWarm(options),
        codexExecutable
      );
      finishPreparation();
      try {
        return await compactWithEntry(entry);
      } finally {
        await this.cli.warmAgentClose.closeWarmAgent(entry, "compact-complete");
      }
    } catch (error) {
      return failedCompact(participant, error);
    } finally { finishPreparation(); }
  }

  private async runCodexAppServerWarmOrOneShot(
    participant: ParticipantConfig,
    prompt: string,
    repoPath: string | undefined,
    diffMode: GitDiffMode | undefined,
    kind: ConversationKind,
    signal: AbortSignal | undefined,
    options: CliAgentRunOptions
  ): Promise<ParticipantRunResult> {
    if (this.cli.cliRuns.nativeAdmissionsFenced || this.cli.warmAgents.warmShutdown || (options.warm && this.cli.warmAgents.conversationClosing(options.warm.conversationId))) {
      return this.cli.cliRuns.failed(participant, new Error("Native sessions are shutting down; this command did not start."));
    }
    const warm = options.warm;
    if (!warm || process.env[CODEX_APP_SERVER_DISABLED_ENV] === "0") {
      if (options.nativeGoal) {
        return this.cli.cliRuns.failed(participant, new Error(
          process.env[CODEX_APP_SERVER_DISABLED_ENV] === "0"
            ? "Native /goal requires the Codex app-server transport; it is disabled."
            : "Native /goal requires a Codex app-server session."
        ));
      }
      return this.cli.cliRuns.failed(participant, new Error("A resident Codex app-server session is required; the command was not replayed."));
    }
    const key = warmAgentKey(participant, repoPath, kind, options);
    const scopeKey = warmAgentScopeKey(warm);
    let entry: WarmAgentEntry | undefined;
    // A request delivered now goes into the turn that runs (Codex's steer).
    let steering = options.steerIntoRunningTurn;
    const busyOther = steering && [...this.cli.warmAgents.entries.values()]
      .find((item) => item.scopeKey === scopeKey && item.key !== key && !item.closed && (item.activeRuns ?? 0) > 0);
    if (busyOther && steering) {
      // The turn runs on a process started with other settings: it is not
      // steered, it is cut (the caller does), and this one starts after it.
      steering("not-steered");
      steering = undefined;
      await busyOther.queue.catch(() => undefined);
    }
    const finishPreparation = this.cli.warmAgents.beginWarmPreparation(key);
    try {
      await this.cli.warmAgents.closeStaleWarmAgents(scopeKey, key);
      entry = this.cli.warmAgents.entries.get(key);
      if (!entry || entry.closed || entry.process.exitCode !== null) {
        if (entry) {
          this.cli.warmAgents.entries.delete(key);
          await this.cli.warmAgentClose.closeWarmAgent(entry, "stale");
        }
        try {
          await ensureLoginShellEnvPrimed();
          const codexExecutable = await this.cli.cliRuns.codexExecutableForRun(options);
          entry = await this.cli.codexAppServer.createCodexAppServerWarmAgent(key, scopeKey, participant, repoPath, diffMode, kind, options, codexExecutable);
          void this.cli.cliRuns.writeDebugLog("cli-agent-warm-started", {
            providerKind: participant.kind,
            participantId: participant.id,
            conversationId: warm.conversationId,
            runtime: "codex-app-server"
          });
        } catch (error) {
          void this.cli.cliRuns.writeDebugLog("cli-agent-warm-start-failed", {
            providerKind: participant.kind,
            participantId: participant.id,
            conversationId: warm.conversationId,
            runtime: "codex-app-server",
            error: errorText(error)
          });
          return this.cli.cliRuns.failed(participant, error);
        }
      }
    } finally { finishPreparation(); }

    const runNow = (target: WarmAgentEntry): Promise<ParticipantRunResult> => target.run(
      prompt,
      signal,
      options.onOutput,
      options.onSessionId,
      options.timeoutMs,
      options.nativeGoal,
      options.onCodexServerRequest,
      undefined,
      options.images?.items
    );
    // Steered into the turn that runs, not behind it; with nothing to steer
    // it runs as soon as that turn ends.
    const earlier = entry.queue;
    const admit = <T>(task: () => Promise<T>): Promise<T> => steering
      ? this.cli.warmAgents.trackWarmRun(entry as WarmAgentEntry, task, Promise.resolve())
      : this.cli.warmAgents.enqueueWarmRun(entry as WarmAgentEntry, task);
    const reply = async (target: WarmAgentEntry): Promise<ParticipantRunResult> => {
      if (!steering) return runNow(target);
      const steered = await target.steer?.(prompt, signal, options.onOutput, options.onSessionId, options.timeoutMs, options.onCodexServerRequest, options.images?.items)
        .catch(() => undefined);
      steering(steered ? "steered" : "not-steered");
      if (steered) return steered;
      await earlier.catch(() => undefined);
      return runNow(target);
    };
    return admit(async () => {
      this.cli.warmAgents.clearWarmIdleTimer(entry as WarmAgentEntry);
      try {
        const result = withAppMcpClientStatus(
          await reply(entry as WarmAgentEntry),
          participant,
          options
        );
        if (result.appMcpClientFailed) {
          this.cli.warmAgents.entries.delete(key);
          await this.cli.warmAgentClose.closeWarmAgent(entry as WarmAgentEntry, "app-mcp-unavailable");
          return result;
        }
        this.cli.warmAgents.scheduleWarmIdleTimer(entry as WarmAgentEntry, warm.idleTimeoutMs);
        return result;
      } catch (error) {
        this.cli.warmAgents.entries.delete(key);
        await this.cli.warmAgentClose.closeWarmAgent(entry as WarmAgentEntry, signal?.aborted ? "aborted" : "failed");
        // A fork this turn made whole although it was to end earlier says
        // so even when the turn itself failed.
        const forkCutMissed = (error as { forkCutMissed?: unknown } | undefined)?.forkCutMissed;
        // A fork whose copy Codex did not make (thread/fork failed).
        const forkCopyFailed = (error as { forkCopyFailed?: unknown } | undefined)?.forkCopyFailed === true && !signal?.aborted;
        const failed = (): ParticipantRunResult => ({
          ...this.cli.cliRuns.failed(participant, error),
          ...(typeof forkCutMissed === "string" ? { forkCutMissed } : {}),
          ...(forkCopyFailed ? { forkCopyFailed: true } : {})
        });
        if (signal?.aborted) {
          return failed();
        }
        if (error instanceof CodexAppServerRunError && error.turnAccepted) {
          void this.cli.cliRuns.writeDebugLog("cli-agent-warm-terminal-after-turn-accepted", {
            providerKind: participant.kind,
            participantId: participant.id,
            conversationId: warm.conversationId,
            runtime: "codex-app-server",
            error: errorText(error)
          });
          return failed();
        }
        void this.cli.cliRuns.writeDebugLog("cli-agent-warm-failed-without-replay", {
          providerKind: participant.kind,
          participantId: participant.id,
          conversationId: warm.conversationId,
          runtime: "codex-app-server",
          error: errorText(error)
        });
        return failed();
      }
    });
  }

  /** Codex's collaboration mode for a chat turn: its Plan mode when the
   *  member has it on, else its Default mode, said on every turn because a
   *  thread stays in the last one it was given (Codex 0.155.1). Plan takes
   *  Codex's own effort for it, as its terminal does ("Model changed to …
   *  medium for Plan mode"); Default keeps the member's. Needs the model the
   *  thread runs on; none known, nothing is said. */
  codexCollaborationMode(
    participant: ParticipantConfig,
    kind: ConversationKind,
    options: CliAgentRunOptions,
    threadModel: string | undefined,
    threadEffort?: ChatReasoningEffort
  ): { mode: "plan" | "default"; settings: Record<string, unknown> } | undefined {
    const model = participant.model ?? threadModel;
    if (kind !== "chat" || !model) return undefined;
    const { plan } = codexRunAccess(kind, options);
    // Her config's effort goes with her config's model only (a model of the
    // member's own, or an added provider's, takes the thread's: Codex's own
    // choice for it).
    const runsConfigModel = !participant.model && !(participant.codexConfigOverrides?.length);
    return {
      mode: plan ? "plan" : "default",
      settings: {
        model,
        // Default keeps the member's effort, else her config.toml's (what her
        // terminal's Default runs at, also after a turn in Plan mode), else
        // the thread's: a null here would reset it to the model's own.
        reasoning_effort: plan ? null : codexReasoningEffort(participant.reasoningEffort) ??
          (runsConfigModel ? this.cli.modelCatalogs.codexConfigEffort() : undefined) ?? threadEffort ?? null,
        developer_instructions: null
      }
    };
  }

  private async runCodexOneShot(
    participant: ParticipantConfig,
    prompt: string,
    repoPath: string | undefined,
    diffMode: GitDiffMode | undefined,
    kind: ConversationKind,
    signal?: AbortSignal,
    options: CliAgentRunOptions = {}
  ): Promise<ParticipantRunResult> {
    const startedAt = Date.now();
    const nonInteractiveApprovalWarning = "Codex is using non-interactive exec mode, so protected actions that require approval are refused. Run this member locally in Chat for an interactive approval card.";
    let outputDir: string | undefined;
    try {
      outputDir = await mkdtemp(path.join(tmpdir(), "accordagents-codex-"));
      const outputPath = path.join(outputDir, "last-message.txt");
      const invocation = buildCodexExecInvocation({
        participant,
        prompt,
        outputPath,
        repoPath,
        diffMode,
        kind,
        options: {
          ...options,
          extraEnv: agentRunEnv(options)
        }
      });
      const codexDeltaAccumulator = { value: "" };
      const stdoutLines = createCodexLineHandler((line) =>
        emitCodexExecLiveOutput(line, options.onOutput, codexDeltaAccumulator, options.onSessionId)
      );
      const codexExecutable = await this.cli.cliRuns.codexExecutableForRun(options);
      const result = await runCommand(codexExecutable, invocation.args, {
        cwd: repoPath,
        input: invocation.input,
        timeoutMs: options.timeoutMs ?? this.cli.cliRuns.runTimeoutMs,
        env: invocation.env,
        killProcessGroup: true,
        signal,
        onStdout: options.onOutput || options.onSessionId ? stdoutLines : undefined
      });
      const lastMessage = await readOptionalFile(outputPath);
      const sessionId = extractCodexExecSessionId(result.stdout) ?? options.sessionId;
      reportSessionId(options.onSessionId, sessionId);
      return withAppMcpClientStatus({
        participant,
        ok: true,
        content: lastMessage.trim() || extractCodexExecText(result.stdout),
        durationMs: Date.now() - startedAt,
        sessionId,
        roleRuntime: options.role ? "codex-developer-instructions" : undefined,
        // `codex exec --json` reports no context (its turn.completed usage
        // sums the turn's calls): the rollout's token counts do.
        contextUsage: await this.cli.sessionLogs.extractCodexSessionLogContextUsageWithRetry(sessionId, participant),
        warnings: [nonInteractiveApprovalWarning]
      }, participant, options);
    } catch (error) {
      if (options.role && isCodexDeveloperInstructionsUnsupported(error)) {
        const fallback = await this.runCodexOneShot(
          participant,
          options.role.promptFallbackPrompt,
          repoPath,
          diffMode,
          kind,
          signal,
          {
            persistSession: options.persistSession,
            sessionId: options.sessionId,
            extraReadableDirs: options.extraReadableDirs,
            resumeFallbackPrompt: options.resumeFallbackPrompt,
            agentMode: options.agentMode,
            permissions: options.permissions,
            appMcp: options.appMcp,
            agentEnv: options.agentEnv,
            agentEnvKey: options.agentEnvKey,
            onSessionId: options.onSessionId
          }
        );
        return {
          ...fallback,
          roleRuntime: "prompt-fallback",
          warnings: [
            ...(fallback.warnings ?? []),
            `${participant.label}: Codex rejected developer_instructions config; used prompt fallback for role instructions.`
          ]
        };
      }
      if (options.sessionId && isResumeMiss(error)) {
        if (options.resumeOnly) throw resumeOnlyMissError("Codex", error);
        const restarted = await this.runCodexOneShot(participant, options.resumeFallbackPrompt ?? prompt, repoPath, diffMode, kind, signal, {
          persistSession: options.persistSession,
          extraReadableDirs: options.extraReadableDirs,
          role: options.role,
          agentMode: options.agentMode,
          permissions: options.permissions,
          appMcp: options.appMcp,
          agentEnv: options.agentEnv,
          agentEnvKey: options.agentEnvKey,
          onSessionId: options.onSessionId
        });
        return { ...restarted, sessionRestarted: true };
      }
      const failed = this.cli.cliRuns.failed(participant, error, Date.now() - startedAt);
      return { ...failed, warnings: [...(failed.warnings ?? []), nonInteractiveApprovalWarning] };
    } finally {
      if (outputDir) {
        await rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}
