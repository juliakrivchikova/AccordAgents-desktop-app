import { randomUUID } from "node:crypto";
import { findClaudeTranscript } from "../../memberSessionFiles";
import {
  claudeForkCut, FORK_CUT_COMPACTED, FORK_CUT_NOT_IN_SESSION, FORK_CUT_SESSION_GONE, readClaudeTranscriptRows,
  FORK_CUT_TRANSCRIPT_UNREADABLE, FORK_CUT_UNSUPPORTED, isForkCutMissingError, isForkCutUnsupportedError
} from "../../forkCut";
import type { ForkCutDecision, ForkCutRequest } from "../../forkCut";
import type { ConversationKind, ParticipantConfig } from "../../../../shared/types";
import { chatAgentModeForKind } from "../../../../shared/agentPermissions";
import { buildAgentContextUsage, contextWindowForModel } from "../../../../shared/agentContext";
import { CommandError, ensureLoginShellEnvPrimed, runCommand } from "../../command";
import type { ParticipantRunResult } from "../../providers";
import { CLAUDE_CODE_COMMAND_ENV_OPTIONS } from "./commandEnvironment";
import { CLAUDE_WARM_CANCELLED_MESSAGE, COMPACTION_CANCELLED } from "./constants";
import {
  claudeLaunchArgs, claudeOwnMode, claudePermissionMode, claudeToolConfig, isClaudeAgentFlagUnsupported,
  isClaudePermissionModeUnsupported, withClaudePermissionMode
} from "./launch";
import {
  claudeJsonResult, compactClaudeThroughProcess, extractClaudeSessionId, extractClaudeText, handleClaudeOneShotStreamChunk,
  handleClaudeOneShotStreamLine
} from "./output";
import {
  CLAUDE_PERMISSION_MODE_LABELS, ClaudeControlError, type ClaudePermissionMode, isClaudeAutoModeRefusal, isClaudePermissionMode
} from "./permissionModes";
import { notifyClaudeReplyStarted } from "./replies";
import type { ClaudeOneShotStreamState } from "./types";
import { finalTextFromMessageItems, trailingTextBlock } from "../codex/appServerText";
import { SESSION_LOG_RETRIES } from "../constants";
import { forkCopyNotMade, isForkSourceMissingError } from "../runs/forkSource";
import { emitLiveOutput, errorText, failedCompact, isResumeMiss, reportSessionId } from "../runs/outputText";
import { stringField } from "../runs/records";
import {
  agentModeForRun, agentRunEnv, normalizedExtraReadableDirs, promptWithImageFallback, withAppMcpClientStatus
} from "../runs/runEnvironment";
import type { CliAgentCompactResult, CliAgentOutputCallback, CliAgentRunOptions, CliAgentWarmOptions, WarmAgentEntry } from "../types";
import { warmAgentKey, warmAgentScopeKey, withoutWarm } from "../warm/warmKeys";
import type { CliModules } from "../modules";
import { extractClaudeWarmResultText } from "./streamText";

/** How long the CLI gets to answer `set_permission_mode` (Shift+Tab). */
export const CLAUDE_PERMISSION_MODE_TIMEOUT_MS = 15_000;

/** Claude Code turns and compactions. */
export class ClaudeRuns {
  claudeScopeWaits = 0;

  constructor(
    private readonly cli: Pick<
      CliModules,
      | "claudeProcess" | "claudeSettings" | "cliRuns" | "sessionLogs" | "warmAgentClose" | "warmAgents"
    >
  ) {}

  async runClaude(
    participant: ParticipantConfig,
    prompt: string,
    repoPath: string | undefined,
    kind: ConversationKind,
    signal?: AbortSignal,
    options: CliAgentRunOptions = {}
  ): Promise<ParticipantRunResult> {
    const { forkCut, onForkCutMissed, ...rest } = options;
    if (!forkCut || !options.forkFromSessionId || options.sessionId) {
      return this.runClaudeTurn(participant, prompt, repoPath, kind, signal, rest);
    }
    // Fork to new chat: the copy ends with the reply the User saw last, in
    // the session that reply was in (the member's own now, unless its
    // session changed after it).
    const member = options.forkFromSessionId;
    const replySession = forkCut.sessionId?.trim() || member;
    const cut = forkCut.unknown
      ? await this.claudeForkSourceHere(member) ? { kind: "missed" as const, reason: forkCut.unknown } : { kind: "gone" as const, reason: forkCut.unknown }
      : await this.claudeForkCutFor(replySession, forkCut, member);
    void this.cli.cliRuns.writeDebugLog("cli-agent-claude-fork-cut", {
      participantId: participant.id,
      decision: cut.kind,
      otherSession: replySession !== member,
      ...(cut.kind !== "cut" ? { reason: cut.reason } : cut.afterCompaction ? { afterCompaction: true } : {})
    });
    // The whole of the member's session, said in the chat at once (before a
    // turn that may last hours, and an app that may stop during it).
    const whole = async (reason: string): Promise<ParticipantRunResult> => {
      onForkCutMissed?.(reason);
      const result = await this.runClaudeTurn(participant, prompt, repoPath, kind, signal, rest);
      return { ...result, forkCutMissed: reason };
    };
    if (cut.kind === "gone") {
      // Its transcript is nowhere on this device, so the CLI cannot copy it
      // either ("No conversation found") and the member starts clean: no
      // word that the copy may hold more. Made after all, it says so with
      // the turn.
      const result = await this.runClaudeTurn(participant, prompt, repoPath, kind, signal, rest);
      return result.ok || !forkCopyNotMade(result) ? { ...result, forkCutMissed: cut.reason } : result;
    }
    if (cut.kind === "missed") return whole(cut.reason);
    const result = await this.runClaudeTurn(participant, prompt, repoPath, kind, signal, { ...rest, forkFromSessionId: replySession, forkResumeAt: cut.at });
    const unsupported = isForkCutUnsupportedError(result.error);
    if (result.ok || signal?.aborted || (!unsupported && !isForkCutMissingError(result.error))) {
      return result;
    }
    // The CLI did not load that message (one its transcript holds on a branch
    // it does not follow, or one a later compaction kept that this CLI does
    // not load after all), or no longer knows the flag.
    void this.cli.cliRuns.writeDebugLog("cli-agent-claude-fork-cut-refused", { participantId: participant.id, unsupported, afterCompaction: Boolean(cut.afterCompaction) });
    return whole(unsupported ? FORK_CUT_UNSUPPORTED : cut.afterCompaction ? FORK_CUT_COMPACTED : FORK_CUT_NOT_IN_SESSION);
  }

  /** Whether the member's session is on this device for Claude Code to copy. */
  private async claudeForkSourceHere(sessionId: string): Promise<boolean> {
    try {
      return Boolean(await findClaudeTranscript(await this.cli.claudeSettings.claudeProjectsDirectory(), sessionId));
    } catch {
      return true;
    }
  }

  /** Where a Claude Code fork of `sessionId` ends, read from its transcript
   *  on this device (forkCut.ts); `sessionId` other than `memberSessionId`:
   *  the session the member's reply was in, not its own now. "gone": the
   *  member's own session is not on this device either, so there is nothing
   *  to copy. */
  private async claudeForkCutFor(sessionId: string, request: ForkCutRequest, memberSessionId: string): Promise<ForkCutDecision | { kind: "gone"; reason: string }> {
    const earlier = sessionId !== memberSessionId;
    try {
      const projects = await this.cli.claudeSettings.claudeProjectsDirectory();
      const file = await findClaudeTranscript(projects, sessionId);
      if (!file) {
        if (earlier && await findClaudeTranscript(projects, memberSessionId)) return { kind: "missed", reason: FORK_CUT_SESSION_GONE };
        return { kind: "gone", reason: earlier ? FORK_CUT_SESSION_GONE : FORK_CUT_TRANSCRIPT_UNREADABLE };
      }
      return claudeForkCut(await readClaudeTranscriptRows(file), request);
    } catch {
      return { kind: "missed", reason: FORK_CUT_TRANSCRIPT_UNREADABLE };
    }
  }

  private async runClaudeTurn(
    participant: ParticipantConfig,
    prompt: string,
    repoPath: string | undefined,
    kind: ConversationKind,
    signal?: AbortSignal,
    options: CliAgentRunOptions = {}
  ): Promise<ParticipantRunResult> {
    if (options.nativeGoal) {
      // The goal runs in its own process on the same session; the member's
      // warm process must not be writing to that session at the same time.
      const idle = await this.waitForClaudeWarmScopeIdle(options.warm, undefined, participant, "starting the goal", signal, options.onOutput);
      if (!idle || signal?.aborted) {
        return this.cli.cliRuns.failed(participant, new Error(CLAUDE_WARM_CANCELLED_MESSAGE));
      }
      return this.runClaudeOneShot(participant, prompt, repoPath, kind, signal, withoutWarm(options));
    }
    if (options.warm && kind === "chat") {
      return this.runClaudeWarmOrOneShot(participant, prompt, repoPath, kind, signal, options);
    }
    return this.runClaudeOneShot(participant, prompt, repoPath, kind, signal, options);
  }

  /**
   * `/compact` as the dedicated CLI runs it: in the member's live session.
   *
   * The member's warm process holds the whole conversation in memory and
   * appends every turn to the session file, so the command goes to that
   * process. With none alive, the member's live process is started for it
   * exactly as its next turn would start it (same tools, app MCP connection,
   * role, model, resume) and stays the member's process afterwards, so the
   * figure shown is the one that process holds and the next turn continues in
   * it. The CLI's own count of the compacted context (`get_context_usage`,
   * what its `/context` shows) is what is reported.
   *
   * As in the dedicated CLI, a reply in progress finishes first, while work the
   * member runs in the background keeps running through the compaction. A
   * process started with other settings is replaced as a turn replaces it,
   * only once nothing runs in it; while it carries background work, the
   * compaction runs in it instead of waiting for that work.
   */
  async compactClaudeSession(
    participant: ParticipantConfig,
    repoPath: string | undefined,
    kind: ConversationKind,
    signal: AbortSignal | undefined,
    options: CliAgentRunOptions
  ): Promise<CliAgentCompactResult> {
    const warm = options.warm;
    if (!warm) {
      return { participant, ok: false, error: `${participant.label} has no chat session to compact.` };
    }
    const cancelled: CliAgentCompactResult = { participant, ok: false, error: COMPACTION_CANCELLED };
    const compactPrompt = options.compactInstructions?.trim()
      ? `/compact ${options.compactInstructions.trim()}`
      : "/compact";
    const key = warmAgentKey(participant, repoPath, kind, options);
    const scopeKey = warmAgentScopeKey(warm);
    const usable = (entry: WarmAgentEntry): boolean => !entry.closed && !entry.unusable && entry.process.exitCode === null;
    let member = this.cli.warmAgents.entries.get(key);
    if (!member || !usable(member)) {
      // A process the member's turns started with other settings (a one-time
      // approval, say) that still carries background work: the compaction
      // runs in it now, as the dedicated CLI's /compact does in its one live
      // session, instead of waiting for that work. The member's next turn
      // replaces it once nothing runs in it, as turns always do.
      member = Array.from(this.cli.warmAgents.entries.values()).find((entry) =>
        entry.scopeKey === scopeKey && entry.key !== key && usable(entry) && entry.hasLiveBackgroundWork?.() === true);
    }
    if (!member) {
      const acquired = await this.acquireClaudeMemberProcess(participant, repoPath, kind, options, warm, signal, "compacting", undefined);
      if ("error" in acquired) {
        return acquired.cancelled ? cancelled : failedCompact(participant, acquired.error);
      }
      member = acquired.entry;
    }
    const live = member;
    live.idleTimeoutMs = warm.idleTimeoutMs;
    // Held from here, so the idle timer cannot retire it before /compact.
    this.cli.warmAgents.clearWarmIdleTimer(live);
    try {
      return await this.cli.warmAgents.trackWarmRun(live, async () => {
        this.cli.warmAgents.clearWarmIdleTimer(live);
        try {
          // A reply in progress, or one the CLI is about to start for finished
          // work, ends first; background tasks keep running.
          await live.whenReplyIdle?.(signal);
          if (signal?.aborted) {
            return cancelled;
          }
          // The member's own process: its turns' timeout, and Stop.
          return await compactClaudeThroughProcess(live, participant, compactPrompt, signal, options, options.timeoutMs ?? this.cli.cliRuns.runTimeoutMs);
        } finally {
          if (!live.closed && this.cli.warmAgents.entries.get(live.key) === live) {
            if (live.unusable) {
              this.cli.warmAgents.entries.delete(live.key);
              await this.cli.warmAgentClose.closeWarmAgent(live, "unusable");
            } else {
              this.cli.warmAgents.scheduleWarmIdleTimer(live, warm.idleTimeoutMs);
            }
          }
        }
      });
    } catch (error) {
      // Refused before it ran (a fence, a host refusal): the process stays the
      // member's, with its idle timer.
      if (!live.closed && this.cli.warmAgents.entries.get(live.key) === live && !live.idleTimer) {
        this.cli.warmAgents.scheduleWarmIdleTimer(live, warm.idleTimeoutMs);
      }
      return signal?.aborted || (error instanceof Error && error.message === CLAUDE_WARM_CANCELLED_MESSAGE)
        ? cancelled
        : failedCompact(participant, error);
    }
  }

  private async runClaudeOneShot(
    participant: ParticipantConfig,
    prompt: string,
    repoPath: string | undefined,
    kind: ConversationKind,
    signal?: AbortSignal,
    options: CliAgentRunOptions = {}
  ): Promise<ParticipantRunResult> {
    const startedAt = Date.now();
    const newSessionId = options.persistSession && !options.sessionId ? randomUUID() : undefined;
    const extraReadableDirs = normalizedExtraReadableDirs(options.extraReadableDirs);
    const toolConfig = claudeToolConfig(kind, repoPath, extraReadableDirs, options);
    try {
      const args = claudeLaunchArgs(
        participant,
        kind,
        options,
        toolConfig,
        extraReadableDirs,
        options.nativeGoal ? "one-shot-stream" : "one-shot",
        newSessionId
      );
      this.cli.claudeSettings.logClaudeLaunch(
        participant,
        repoPath,
        kind,
        options,
        args,
        toolConfig,
        extraReadableDirs,
        options.nativeGoal ? "one-shot-stream" : "one-shot"
      );
      reportSessionId(options.onSessionId, newSessionId);
      const streamState: ClaudeOneShotStreamState | undefined = options.nativeGoal
        ? {
            buffer: "",
            streamedText: "",
            toolContext: {},
            messages: [],
            nextTextBlockStartsBlock: false
          }
        : undefined;

      const claudeExecutable = await this.cli.cliRuns.providerExecutableForRun("claude", options, CLAUDE_CODE_COMMAND_ENV_OPTIONS);
      const result = await runCommand(
        claudeExecutable,
        args,
        {
          cwd: repoPath,
          // A one-shot's text input takes no pictures: they are named after it.
          input: options.nativeGoal ? `/goal ${promptWithImageFallback(prompt, options.images)}` : promptWithImageFallback(prompt, options.images),
          timeoutMs: options.timeoutMs ?? this.cli.cliRuns.runTimeoutMs,
          allowNoTimeout: Boolean(options.nativeGoal),
          env: agentRunEnv(options),
          envOptions: CLAUDE_CODE_COMMAND_ENV_OPTIONS,
          killProcessGroup: true,
          signal,
          onStdout: (chunk) => {
            options.onProviderActivity?.();
            if (streamState) {
              handleClaudeOneShotStreamChunk(chunk, streamState, participant, options);
            }
          },
          onStderr: () => options.onProviderActivity?.()
        }
      );
      if (streamState?.buffer.trim()) {
        handleClaudeOneShotStreamLine(streamState.buffer, streamState, participant, options);
        streamState.buffer = "";
      }
      if (streamState?.error) {
        throw new Error(streamState.error);
      }
      const sessionId = streamState?.sessionId ?? extractClaudeSessionId(result.stdout) ?? newSessionId ?? options.sessionId;
      reportSessionId(options.onSessionId, sessionId);
      const content = (
        streamState
          ? extractClaudeWarmResultText(streamState.resultEvent) ?? (
              streamState.messages.length > 0
                ? finalTextFromMessageItems(streamState.messages)
                : trailingTextBlock(streamState.streamedText)
            )
          : extractClaudeText(result.stdout)
      ).trim();
      if (!content && !options.allowEmptyContent) {
        throw new Error("Claude Code completed without response content.");
      }
      return this.cli.claudeSettings.withClaudePermissionDenialWarning(withAppMcpClientStatus({
        participant,
        ok: true,
        content,
        durationMs: Date.now() - startedAt,
        sessionId,
        ...(streamState?.lastAssistantUuid ? { sessionCut: streamState.lastAssistantUuid } : {}),
        roleRuntime: options.role && !options.sessionId && !options.forkFromSessionId ? "claude-agent" : undefined,
        contextUsage:
          (streamState
            ? buildAgentContextUsage({
                usedTokens: streamState.usedTokens,
                contextWindowTokens: streamState.contextWindowTokens ?? contextWindowForModel(participant.kind, streamState.contextModel ?? streamState.model),
                source: "claude-code",
                model: streamState.contextModel ?? streamState.model,
                windowFromCli: streamState.contextWindowTokens !== undefined
              })
            : undefined) ??
          // `--output-format json` prints only the result, whose usage sums
          // the turn's calls: the context is its session log's last call,
          // against the window the result names.
          await this.cli.sessionLogs.extractClaudeSessionLogContextUsageWithRetry(
            sessionId,
            participant,
            SESSION_LOG_RETRIES,
            streamState?.contextWindowTokens ?? claudeJsonResult(result.stdout)
          )
      }, participant, options), streamState?.resultEvent ?? result.stdout, participant, options.nativeGoal ? "one-shot-stream" : "one-shot");
    } catch (error) {
      if (chatAgentModeForKind("claude-code", agentModeForRun(kind, options)) === "auto" && isClaudePermissionModeUnsupported(error)) {
        // Fail loudly instead of silently downgrading: Auto-review must run as native
        // Claude auto, not a different mode under the same label.
        return this.cli.cliRuns.failed(
          participant,
          new Error("Claude Code in this environment does not support Auto-review (--permission-mode auto). Upgrade Claude Code, or set this member to Default or Plan mode."),
          Date.now() - startedAt
        );
      }
      if (options.role && !options.sessionId && !options.forkFromSessionId && isClaudeAgentFlagUnsupported(error)) {
        const fallback = await this.runClaudeOneShot(
          participant,
          options.role.promptFallbackPrompt,
          repoPath,
          kind,
          signal,
          {
            persistSession: options.persistSession,
            extraReadableDirs: options.extraReadableDirs,
            resumeFallbackPrompt: options.resumeFallbackPrompt,
            images: options.images,
            agentMode: options.agentMode,
            permissions: options.permissions,
            appMcp: options.appMcp,
            agentEnv: options.agentEnv,
            agentEnvKey: options.agentEnvKey,
            onOutput: options.onOutput,
            onSessionId: options.onSessionId,
            timeoutMs: options.timeoutMs,
            nativeGoal: options.nativeGoal,
            onProviderActivity: options.onProviderActivity
          }
        );
        return {
          ...fallback,
          roleRuntime: "prompt-fallback",
          warnings: [
            ...(fallback.warnings ?? []),
            `${participant.label}: Claude Code rejected --append-system-prompt; used prompt fallback for role instructions.`
          ]
        };
      }
      // The session it resumes or forks is gone: a new one from the saved
      // chat context, as the warning that follows says. A fork only when its
      // source is gone (not for any other "not found").
      if (options.sessionId ? isResumeMiss(error) : Boolean(options.forkFromSessionId) && isForkSourceMissingError(errorText(error))) {
        const restarted = await this.runClaudeOneShot(participant, options.resumeFallbackPrompt ?? prompt, repoPath, kind, signal, {
          persistSession: options.persistSession,
          extraReadableDirs: options.extraReadableDirs,
          images: options.images,
          role: options.role,
          agentMode: options.agentMode,
          permissions: options.permissions,
          appMcp: options.appMcp,
          agentEnv: options.agentEnv,
          agentEnvKey: options.agentEnvKey,
          onOutput: options.onOutput,
          onSessionId: options.onSessionId,
          timeoutMs: options.timeoutMs,
          nativeGoal: options.nativeGoal,
          onProviderActivity: options.onProviderActivity
        });
        return { ...restarted, sessionRestarted: true };
      }
      return this.cli.claudeSettings.withClaudePermissionDenialWarning(
        this.cli.cliRuns.failed(participant, error, Date.now() - startedAt),
        error instanceof CommandError ? `${error.result.stdout}\n${error.result.stderr}` : undefined,
        participant,
        "one-shot"
      );
    }
  }

  private async runClaudeWarmOrOneShot(
    participant: ParticipantConfig,
    prompt: string,
    repoPath: string | undefined,
    kind: ConversationKind,
    signal: AbortSignal | undefined,
    options: CliAgentRunOptions
  ): Promise<ParticipantRunResult> {
    if (this.cli.cliRuns.nativeAdmissionsFenced || this.cli.warmAgents.warmShutdown || (options.warm && this.cli.warmAgents.conversationClosing(options.warm.conversationId))) {
      return this.cli.cliRuns.failed(participant, new Error("Native sessions are shutting down; this command did not start."));
    }
    const warm = options.warm;
    if (!warm) {
      return this.runClaudeOneShot(participant, prompt, repoPath, kind, signal, options);
    }
    const key = warmAgentKey(participant, repoPath, kind, options);
    const acquired = await this.acquireClaudeMemberProcess(participant, repoPath, kind, options, warm, signal, "applying the changed settings", options.onOutput);
    if ("error" in acquired) {
      return this.cli.cliRuns.failed(participant, acquired.error);
    }
    // Messages are not serialized here: the CLI queues them itself and hands a
    // message sent mid-step to the running step, as the dedicated CLI does.
    const admit = (claudeEntry: WarmAgentEntry, freshProcess: boolean, replaced: boolean): Promise<ParticipantRunResult> => this.cli.warmAgents.trackWarmRun(claudeEntry, async () => {
      claudeEntry.idleTimeoutMs = warm.idleTimeoutMs;
      this.cli.warmAgents.clearWarmIdleTimer(claudeEntry);
      if (claudeOwnMode(kind, options)) {
        const wanted = warm.permissionMode?.() ?? claudePermissionMode(kind, options);
        // A process started for this message after one that did not switch
        // is asked once more, which says whether it really runs in the mode
        // (an account without auto mode refuses it).
        const notSwitched = await this.alignClaudePermissionMode(claudeEntry, wanted, participant, warm, signal, replaced);
        if (notSwitched) {
          if (signal?.aborted) {
            this.cli.warmAgents.scheduleWarmIdleTimerIfLive(claudeEntry, warm.idleTimeoutMs);
            return this.cli.cliRuns.failed(participant, notSwitched.error);
          }
          if (notSwitched.replaceable && !replaced) {
            // Nothing runs in it: a process started in the member's mode
            // takes the message instead, as the CLI started again in it.
            if (this.cli.warmAgents.entries.get(key) === claudeEntry) this.cli.warmAgents.entries.delete(key);
            await this.cli.warmAgentClose.closeWarmAgent(claudeEntry, "mode-not-switched");
            const again = await this.acquireClaudeMemberProcess(participant, repoPath, kind, withClaudePermissionMode(options, wanted), warm, signal,
              "starting it again in its mode", options.onOutput);
            if ("error" in again) return this.cli.cliRuns.failed(participant, again.error);
            return admit(again.entry, again.fresh, true);
          }
          if (claudeEntry.unusable) {
            if (this.cli.warmAgents.entries.get(key) === claudeEntry) this.cli.warmAgents.entries.delete(key);
            await this.cli.warmAgentClose.closeWarmAgent(claudeEntry, "unusable");
          } else {
            this.cli.warmAgents.scheduleWarmIdleTimerIfLive(claudeEntry, warm.idleTimeoutMs);
          }
          return { ...this.cli.cliRuns.failed(participant, notSwitched.error), content: notSwitched.error.message };
        }
      }
      // Whether the CLI took this message into a step: a fork's process that
      // ended before it did never made the copy (forkCopyFailed below).
      let replyStarted = false;
      try {
        const result = withAppMcpClientStatus(
          await claudeEntry.run(prompt, signal, options.onOutput, options.onSessionId, options.timeoutMs, undefined, undefined, {
            origin: warm.origin,
            onSelfResumedTurn: warm.onSelfResumedTurn,
            onBackgroundTasksChanged: warm.onBackgroundTasksChanged,
            onReplyStarted: (start) => {
              replyStarted = true;
              if (!freshProcess) warm.onReplyStarted?.(start);
            },
            onMessageWritten: warm.onMessageWritten,
            onPromptSuggestion: warm.onPromptSuggestion,
            allowEmptyContent: options.allowEmptyContent,
            roleRuntime: options.role && !options.sessionId && !options.forkFromSessionId ? "claude-agent" : undefined,
            images: options.images?.items
          }),
          participant,
          options
        );
        if (result.appMcpClientFailed) {
          this.cli.warmAgents.entries.delete(key);
          await this.cli.warmAgentClose.closeWarmAgent(claudeEntry, "app-mcp-unavailable");
          return result;
        }
        if (claudeEntry.unusable) {
          this.cli.warmAgents.entries.delete(key);
          await this.cli.warmAgentClose.closeWarmAgent(claudeEntry, "unusable");
          return result;
        }
        this.cli.warmAgents.scheduleWarmIdleTimer(claudeEntry, warm.idleTimeoutMs);
        return result;
      } catch (error) {
        if (!claudeEntry.unusable && !claudeEntry.closed && claudeEntry.process.exitCode === null) {
          // Only this reply ended (Stop interrupted it, or the CLI dropped it):
          // the process, its session and any background work keep running, as
          // after Esc in the dedicated CLI.
          this.cli.warmAgents.scheduleWarmIdleTimer(claudeEntry, warm.idleTimeoutMs);
          if (!signal?.aborted) {
            void this.cli.cliRuns.writeDebugLog("cli-agent-claude-reply-failed", {
              participantId: participant.id,
              conversationId: warm.conversationId,
              error: errorText(error)
            });
          }
          return this.cli.cliRuns.failed(participant, error);
        }
        this.cli.warmAgents.entries.delete(key);
        await this.cli.warmAgentClose.closeWarmAgent(claudeEntry, signal?.aborted ? "aborted" : "failed");
        if (signal?.aborted) {
          return this.cli.cliRuns.failed(participant, error);
        }
        void this.cli.cliRuns.writeDebugLog("cli-agent-warm-failed-without-replay", {
          providerKind: participant.kind,
          participantId: participant.id,
          conversationId: warm.conversationId,
          error: errorText(error)
        });
        // A new session (a fork's copy, or a clean one) whose CLI exited
        // before it started any step: no session was made (Claude Code exits
        // at once when it cannot load the session it forks), although the
        // id it was given has been reported. A process that never started is
        // not that; nor is one that took another message first (two sent at
        // once share the process: that one made the session).
        const notStarted = !options.sessionId && !replyStarted && claudeEntry.everStartedStep?.() !== true &&
          typeof claudeEntry.process.exitCode === "number";
        return notStarted
          ? { ...this.cli.cliRuns.failed(participant, error), sessionNotStarted: true, ...(options.forkFromSessionId ? { forkCopyFailed: true } : {}) }
          : this.cli.cliRuns.failed(participant, error);
      }
    });
    return admit(acquired.entry, acquired.fresh, false);
  }

  /**
   * Claude Code's permission mode belongs to the session, not to a message
   * (Shift+Tab in the CLI switches it for the reply running too). Before a
   * message of a member in its CLI's own mode goes into its live process, the
   * process is switched to the member's mode (`set_permission_mode`), and the
   * message waits for the CLI's answer: a mode changed between turns keeps
   * the process and its background work, as in the CLI. `confirm` asks even
   * when the process should be in it already. Undefined when it runs in the
   * mode; otherwise the turn does not run in another mode, and the error says
   * why in the CLI's terms. `replaceable`: nothing runs in the process and a
   * new one may get the mode (it did not answer, or it refused for a reason
   * a new process does not have); the process is retired then.
   */
  private async alignClaudePermissionMode(
    entry: WarmAgentEntry,
    wanted: ClaudePermissionMode,
    participant: ParticipantConfig,
    warm: CliAgentWarmOptions,
    signal: AbortSignal | undefined,
    confirm = false
  ): Promise<{ error: Error; replaceable: boolean } | undefined> {
    const current = entry.permissionMode?.();
    if ((current === wanted && !confirm) || !entry.control) {
      return undefined;
    }
    const label = CLAUDE_PERMISSION_MODE_LABELS[wanted];
    const audit = { participantId: participant.id, conversationId: warm.conversationId, from: current ?? null, to: wanted };
    let reported: string | undefined;
    try {
      const answer = await entry.control({ subtype: "set_permission_mode", mode: wanted }, CLAUDE_PERMISSION_MODE_TIMEOUT_MS, signal);
      reported = stringField(answer, "mode") ?? entry.permissionMode?.();
    } catch (error) {
      if (signal?.aborted) {
        return { error: new Error(CLAUDE_WARM_CANCELLED_MESSAGE), replaceable: false };
      }
      const reason = errorText(error).replace(/[.\s]+$/, "");
      const code = error instanceof ClaudeControlError ? error.code : undefined;
      const autoRefused = wanted === "auto" && isClaudeAutoModeRefusal(code);
      const idle = entry.isIdle?.() === true;
      // A refusal the account or its settings make (auto mode) comes from a
      // new process too; a hung or ended process may start again in the mode.
      const replaceable = idle && !autoRefused && code !== "invalid_mode";
      if (replaceable) entry.unusable = true;
      void this.cli.cliRuns.writeDebugLog("cli.claude.permission-mode-align-failed", { ...audit, code: code ?? null, replaceable, message: reason });
      const name = participant.label;
      if (autoRefused) {
        return { error: new Error(`Claude Code's auto mode is not available for ${name} (${reason}), so the message was not sent. Choose another mode for ${name}.`), replaceable: false };
      }
      if (error instanceof ClaudeControlError && error.timedOut) {
        return {
          error: new Error(idle
            ? `Claude Code did not answer when asked to switch ${name} to ${label}, so the message was not sent. Send it again.`
            : `Claude Code did not answer when asked to switch ${name} to ${label} while its background tasks run, so the message was not sent. Send it again when they have finished, or stop them.`),
          replaceable
        };
      }
      return {
        error: new Error(idle
          ? `Claude Code did not switch ${name} to ${label} (${reason}), so the message was not sent. Send it again.`
          : `Claude Code did not switch ${name} to ${label} while its background tasks run (${reason}), so the message was not sent. Send it again when they have finished, or stop them.`),
        replaceable
      };
    }
    if (reported !== undefined && reported !== wanted) {
      // The CLI says it runs another mode: the message is not sent in it.
      void this.cli.cliRuns.writeDebugLog("cli.claude.permission-mode-align-failed", { ...audit, reported, replaceable: false });
      const other = isClaudePermissionMode(reported) ? CLAUDE_PERMISSION_MODE_LABELS[reported] : reported;
      return { error: new Error(`Claude Code switched ${participant.label} to ${other} instead of ${label}, so the message was not sent.`), replaceable: false };
    }
    void this.cli.cliRuns.writeDebugLog("cli.claude.permission-mode-aligned", audit);
    return undefined;
  }

  /**
   * The member's live Claude Code process for this key, as its turns and its
   * compaction get it: a process started with other settings is replaced, but
   * never while it still answers a message or carries background work (that
   * work would be lost, which the dedicated CLI never does to it); with none
   * alive, the member's process is started. The wait is visible and Stop ends
   * it; it is counted as native work from the first moment (idle power and
   * fencing see it), but not as a preparation: shutdown closes the busy
   * process, which ends this wait, instead of waiting for it.
   */
  private async acquireClaudeMemberProcess(
    participant: ParticipantConfig,
    repoPath: string | undefined,
    kind: ConversationKind,
    options: CliAgentRunOptions,
    warm: CliAgentWarmOptions,
    signal: AbortSignal | undefined,
    purpose: string,
    onOutput: CliAgentOutputCallback | undefined
  ): Promise<{ entry: WarmAgentEntry; fresh: boolean } | { error: Error; cancelled: boolean }> {
    const cancelled = { error: new Error(CLAUDE_WARM_CANCELLED_MESSAGE), cancelled: true };
    const shuttingDown = { error: new Error("Native sessions are shutting down; this command did not start."), cancelled: false };
    const key = warmAgentKey(participant, repoPath, kind, options);
    const scopeKey = warmAgentScopeKey(warm);
    this.claudeScopeWaits++;
    let settled: boolean;
    try {
      settled = await this.waitForClaudeWarmScopeIdle(warm, key, participant, purpose, signal, onOutput);
    } finally {
      this.claudeScopeWaits--;
    }
    if (!settled || signal?.aborted) {
      return cancelled;
    }
    if (this.cli.cliRuns.nativeAdmissionsFenced || this.cli.warmAgents.warmShutdown || this.cli.warmAgents.conversationClosing(warm.conversationId)) {
      return shuttingDown;
    }
    const finishPreparation = this.cli.warmAgents.beginWarmPreparation(key);
    try {
      await this.cli.warmAgents.closeStaleWarmAgents(scopeKey, key, (stale) => stale.isIdle?.() !== false);
      if (signal?.aborted) {
        return cancelled;
      }
      const live = this.cli.warmAgents.entries.get(key);
      if (live && !live.closed && !live.unusable && live.process.exitCode === null) {
        return { entry: live, fresh: false };
      }
      if (live) {
        this.cli.warmAgents.entries.delete(key);
        await this.cli.warmAgentClose.closeWarmAgent(live, live.unusable ? "unusable" : "stale");
      }
      try {
        await ensureLoginShellEnvPrimed();
        const claudeExecutable = await this.cli.cliRuns.providerExecutableForRun("claude", options, CLAUDE_CODE_COMMAND_ENV_OPTIONS);
        // Nothing can be running on a process that does not exist yet: the
        // member's app tool grant applies from the start, before the CLI
        // connects its MCP servers.
        notifyClaudeReplyStarted(warm);
        const entry = await this.cli.claudeProcess.createClaudeWarmAgent(key, scopeKey, participant, repoPath, kind, options, claudeExecutable);
        void this.cli.cliRuns.writeDebugLog("cli-agent-warm-started", {
          providerKind: participant.kind,
          participantId: participant.id,
          conversationId: warm.conversationId
        });
        return { entry, fresh: true };
      } catch (error) {
        void this.cli.cliRuns.writeDebugLog("cli-agent-warm-start-failed", {
          providerKind: participant.kind,
          participantId: participant.id,
          conversationId: warm.conversationId,
          error: errorText(error)
        });
        return { error: error instanceof Error ? error : new Error(String(error)), cancelled: false };
      }
    } finally { finishPreparation(); }
  }

  /** Waits until the member's warm Claude processes (other than `exceptKey`)
   *  hold nothing that a concurrent operation on the same session, or closing
   *  them, would disturb: no reply running or queued, no background task. */
  private async waitForClaudeWarmScopeIdle(
    warm: CliAgentWarmOptions | undefined,
    exceptKey: string | undefined,
    participant: ParticipantConfig,
    purpose: string,
    signal: AbortSignal | undefined,
    onOutput: CliAgentOutputCallback | undefined
  ): Promise<boolean> {
    if (!warm) {
      return true;
    }
    const scopeKey = warmAgentScopeKey(warm);
    const busy = Array.from(this.cli.warmAgents.entries.values()).filter((entry) => (
      entry.scopeKey === scopeKey && entry.key !== exceptKey && !entry.closed && entry.isIdle?.() === false
    ));
    if (busy.length === 0) {
      return true;
    }
    const itemId = `claude-scope-wait-${randomUUID()}`;
    const label = `Waiting for ${participant.label}'s running work to finish before ${purpose}`;
    emitLiveOutput(onOutput, "tool", `${label}\n`, undefined, {
      activityKind: "status",
      activityStatus: "started",
      activityItemId: itemId
    });
    let status: "completed" | "failed" = "completed";
    try {
      for (const entry of busy) {
        await entry.whenIdle?.(signal);
      }
    } catch {
      status = "failed";
    } finally {
      emitLiveOutput(onOutput, "tool", `${label}\n`, undefined, {
        activityKind: "status",
        activityStatus: status,
        activityItemId: itemId
      });
    }
    return status === "completed";
  }
}
