import { randomUUID } from "node:crypto";
import type { ConversationKind, ParticipantConfig } from "../../../../shared/types";
import { buildAgentContextUsage } from "../../../../shared/agentContext";
import { commandEnvironment } from "../../command";
import {
  capturePosixDescendantsFromTable, capturePosixProcessIdentity, type CapturedPosixProcess, type PosixProcessRow
} from "../../processTermination";
import type { ParticipantRunResult } from "../../providers";
import { CLAUDE_CODE_COMMAND_ENV_OPTIONS } from "./commandEnvironment";
import { CLAUDE_WARM_CANCELLED_MESSAGE } from "./constants";
import { claudeLaunchArgs, claudeToolConfig, claudeWarmUserMessage } from "./launch";
import { claudeWarmStreamError } from "./output";
import { ClaudeControlError, isClaudePermissionMode } from "./permissionModes";
import {
  activateClaudeWarmReply, applyClaudeWarmReplyEvent, claudeWarmEventShowsModelStep, handleClaudeWarmControlResponse,
  newClaudeWarmReply, noteClaudeToolContext, noteClaudeWarmReplyIdentity, removeClaudeWarmReply, sendClaudeWarmControl,
  settleClaudeWarmReply
} from "./replies";
import type { ClaudeWarmProcessHooks, ClaudeWarmProcessState } from "./types";
import { MAX_CLI_ERROR_CHARS } from "../constants";
import { findModelId } from "../models/modelLists";
import { reportSessionId, truncateText } from "../runs/outputText";
import { asRecord, findSessionId, stringField } from "../runs/records";
import { agentRunEnv, normalizedExtraReadableDirs } from "../runs/runEnvironment";
import type {
  ClaudeWarmRunContext, CliAgentCodexServerRequestCallback, CliAgentOutputCallback, CliAgentRunOptions, CliAgentSessionIdCallback,
  NativeGoalRun, WarmAgentEntry
} from "../types";
import type { CliModules } from "../modules";

/** How long the CLI gets to answer `get_context_usage`. */
const CLAUDE_CONTEXT_USAGE_TIMEOUT_MS = 15_000;

const CLAUDE_BACKGROUND_PROCESS_URGENT_WINDOW_MS = 3_000;

// Older CLIs without `command_lifecycle`: quiet period after a result before
// the next held message is written.
const CLAUDE_WARM_LEGACY_FLUSH_QUIET_MS = 400;

// How long a CLI that closed its input may take to end and say why.
const CLAUDE_INPUT_CLOSED_EXIT_WAIT_MS = 5_000;

/** A member's live Claude Code process. */
export class ClaudeProcess {
  constructor(private readonly cli: Pick<CliModules, "claudeReplyFlow" | "claudeSettings" | "cliRuns" | "warmAgentClose" | "warmAgents">) {}

  async createClaudeWarmAgent(
    key: string,
    scopeKey: string,
    participant: ParticipantConfig,
    repoPath: string | undefined,
    kind: ConversationKind,
    options: CliAgentRunOptions,
    claudeExecutable: string
  ): Promise<WarmAgentEntry> {
    return this.cli.warmAgents.createTrackedWarmAgent(key, () => this.constructClaudeWarmAgent(key, scopeKey, participant, repoPath, kind, options, claudeExecutable));
  }

  private async constructClaudeWarmAgent(
    key: string,
    scopeKey: string,
    participant: ParticipantConfig,
    repoPath: string | undefined,
    kind: ConversationKind,
    options: CliAgentRunOptions,
    claudeExecutable: string
  ): Promise<WarmAgentEntry> {
    const newSessionId = options.persistSession && !options.sessionId ? randomUUID() : undefined;
    const extraReadableDirs = normalizedExtraReadableDirs(options.extraReadableDirs);
    const toolConfig = claudeToolConfig(kind, repoPath, extraReadableDirs, options);
    const promptSuggestionsRequested = Boolean(options.warm?.onPromptSuggestion);
    const promptSuggestions = promptSuggestionsRequested && await this.cli.claudeSettings.claudeSupportsPromptSuggestions(claudeExecutable);
    if (promptSuggestionsRequested && !promptSuggestions) {
      void this.cli.cliRuns.writeDebugLog("cli.claude.prompt-suggestions-unsupported", { participantId: participant.id });
    }
    const args = claudeLaunchArgs(
      participant,
      kind,
      options,
      toolConfig,
      extraReadableDirs,
      "warm",
      newSessionId,
      promptSuggestions
    );
    this.cli.claudeSettings.logClaudeLaunch(participant, repoPath, kind, options, args, toolConfig, extraReadableDirs, "warm");

    const child = await this.cli.warmAgents.spawnResidentProcess(scopeKey, claudeExecutable, args, {
      cwd: repoPath,
      env: commandEnvironment(agentRunEnv(options), CLAUDE_CODE_COMMAND_ENV_OPTIONS),
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let processIdentity = capturePosixProcessIdentity(child.pid, this.cli.warmAgentClose.readPosixProcessTableForTermination);

    let stdoutBuffer = "";
    let stderr = "";
    let closed = false;
    let ended = false;
    const state: ClaudeWarmProcessState = {
      replies: [],
      stepActive: false,
      lifecycleSupported: false,
      backgroundTasks: new Map(),
      backgroundTaskLabels: new Map(),
      backgroundTaskOrigins: new Map(),
      finishedTaskIds: new Set(),
      pendingNotices: [],
      sessionId: options.sessionId ?? newSessionId,
      model: participant.model,
      cancelRequests: new Map(),
      reportedBackgroundTasks: "[]",
      lastTaskEventAt: 0,
      selfResumeExpectedUntil: 0,
      controlWaiters: new Map(),
      toolContext: {},
      scopeKey,
      permissionMode: toolConfig.permissionMode,
      requestedPermissionModes: new Map(),
      autoModeSeen: false,
      onCliPermissionMode: options.warm?.onCliPermissionMode
    };
    const capturedBackgroundProcesses = new Map<string, CapturedPosixProcess>();
    /** Each waiter settles once its condition holds (or the process is gone). */
    const idleWaiters = new Map<() => void, () => boolean>();

    const captureBackgroundProcesses = (rows: Map<number, PosixProcessRow>): void => {
      if (!processIdentity && child.exitCode === null && !child.killed) {
        const row = child.pid ? rows.get(child.pid) : undefined;
        processIdentity = row ? { pid: row.pid, startedAt: row.startedAt } : undefined;
      }
      const identities = capturePosixDescendantsFromTable(
        processIdentity?.pid,
        rows,
        Array.from(capturedBackgroundProcesses.values()),
        processIdentity
      );
      capturedBackgroundProcesses.clear();
      for (const identity of identities) {
        capturedBackgroundProcesses.set(`${identity.pid}:${identity.startedAt}`, identity);
      }
    };

    const refreshCapturedBackgroundProcesses = (): void => {
      if (state.backgroundTasks.size === 0) {
        capturedBackgroundProcesses.clear();
        this.cli.warmAgentClose.maybeStopClaudeBackgroundProcessCapture();
        return;
      }
      this.cli.warmAgentClose.ensureClaudeBackgroundProcessCapture();
    };

    /** No reply is waiting or running, and none is about to start on its own
     *  (a finished task the CLI is expected to answer). */
    const isReplyIdle = (): boolean => closed
      || (state.replies.length === 0 && !state.stepActive && Date.now() >= state.selfResumeExpectedUntil);
    const isIdle = (): boolean => isReplyIdle() && (closed || state.backgroundTasks.size === 0);
    const notifyIfIdle = (): void => {
      for (const [waiter, holds] of Array.from(idleWaiters)) {
        if (holds()) waiter();
      }
      if (!isIdle()) {
        return;
      }
      // Work the CLI did on its own (a reply it started when background work
      // finished) has no run of ours to re-arm the idle timer afterwards.
      if (!closed && !entry.closed && !entry.idleTimer && entry.idleTimeoutMs !== undefined && this.cli.warmAgents.entries.get(entry.key) === entry) {
        this.cli.warmAgents.scheduleWarmIdleTimer(entry, entry.idleTimeoutMs);
      }
    };

    const waitUntil = (holds: () => boolean, signal?: AbortSignal): Promise<void> => new Promise<void>((resolve, reject) => {
      if (holds()) {
        resolve();
        return;
      }
      const onAbort = (): void => {
        idleWaiters.delete(done);
        reject(new Error(CLAUDE_WARM_CANCELLED_MESSAGE));
      };
      const done = (): void => {
        idleWaiters.delete(done);
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      idleWaiters.set(done, holds);
      signal?.addEventListener("abort", onAbort, { once: true });
    });

    // If the step the CLI is expected to start for a finished task never comes,
    // re-check idleness when that expectation lapses.
    let selfResumeCheck: NodeJS.Timeout | undefined;
    const armSelfResumeCheck = (): void => {
      const wait = state.selfResumeExpectedUntil - Date.now();
      if (wait <= 0 || selfResumeCheck) {
        return;
      }
      selfResumeCheck = setTimeout(() => {
        selfResumeCheck = undefined;
        notifyIfIdle();
        armSelfResumeCheck();
      }, wait + 10);
      selfResumeCheck.unref();
    };

    const write = (message: Record<string, unknown>): void => {
      if (closed) {
        return;
      }
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) {
          inputFailed(error);
        }
      });
    };

    /** The process itself failed (exit, stdin error): every reply still open
     *  fails with it. */
    const failProcess = (error: Error): void => {
      for (const waiter of Array.from(state.controlWaiters.values())) waiter(undefined);
      state.controlWaiters.clear();
      const replies = Array.from(state.replies);
      state.replies = [];
      state.active = undefined;
      state.stepActive = false;
      for (const reply of replies) {
        settleClaudeWarmReply(reply);
        reply.reject(error);
      }
      notifyIfIdle();
    };

    /** The CLI closed its input: it is ending, and how it ends says why ("No
     *  conversation found", exit code 1), so its replies fail with that. One
     *  that never ends fails with the write's own error. */
    let inputFailure: NodeJS.Timeout | undefined;
    const inputFailed = (error: Error): void => {
      closed = true;
      if (inputFailure || ended) {
        return;
      }
      inputFailure = setTimeout(() => failProcess(error), CLAUDE_INPUT_CLOSED_EXIT_WAIT_MS);
      inputFailure.unref();
    };

    /** Writes messages that were held back: all of them once the CLI is known
     *  to queue them itself, otherwise one at a time, as before. */
    const flushUnwritten = (): void => {
      for (const reply of state.replies) {
        if (reply.written || reply.settled) {
          continue;
        }
        if (!state.lifecycleSupported && state.replies.some((other) => other.written && !other.settled)) {
          return;
        }
        reply.written = true;
        write(claudeWarmUserMessage(reply.prompt ?? "", reply.commandUuid, reply.images));
        reply.prompt = undefined;
        reply.images = undefined;
        try {
          reply.onWritten?.();
        } catch {
          // An observer failure must not stop the message.
        }
      }
    };
    // Without the command lifecycle a step cannot be told apart from one the
    // CLI starts by itself; after a result, give the CLI a moment to start
    // such a step (a notification still queued) before writing the next
    // message, so that step is not read as that message's answer.
    let flushTimer: NodeJS.Timeout | undefined;
    const flushAfterQuiet = (): void => {
      if (state.lifecycleSupported) {
        flushUnwritten();
        return;
      }
      if (flushTimer) {
        clearTimeout(flushTimer);
      }
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        if (!state.stepActive) {
          flushUnwritten();
        }
      }, CLAUDE_WARM_LEGACY_FLUSH_QUIET_MS);
      flushTimer.unref();
    };

    const hooks: ClaudeWarmProcessHooks = {
      write,
      settled: () => {
        flushAfterQuiet();
        notifyIfIdle();
      },
      flush: flushUnwritten,
      markUnusable: () => {
        entry.unusable = true;
      },
      markUnusableIfIdle: () => {
        if (state.replies.length === 0 && state.backgroundTasks.size === 0) {
          entry.unusable = true;
        }
      }
    };

    child.stderr.on("data", (chunk: string) => {
      stderr = truncateText(`${stderr}${chunk}`, MAX_CLI_ERROR_CHARS);
    });

    child.stdin.on("error", inputFailed);

    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let newline = stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line) {
          this.handleClaudeWarmLine(line, participant, newSessionId, state, hooks);
          refreshCapturedBackgroundProcesses();
          this.cli.claudeReplyFlow.reportClaudeBackgroundTasks(state, participant);
          notifyIfIdle();
          armSelfResumeCheck();
        }
        newline = stdoutBuffer.indexOf("\n");
      }
    });

    child.on("error", (error) => {
      closed = true;
      failProcess(error);
      // A process that failed this way may never report "close" (its
      // supervisor died); its background work is gone either way.
      this.cli.claudeReplyFlow.reportClaudeBackgroundTasks(state, participant, true);
    });
    child.on("close", (exitCode, signal) => {
      closed = true;
      ended = true;
      clearTimeout(inputFailure);
      const how = signal ? ` after signal ${signal}` : exitCode === null ? "" : ` with code ${exitCode}`;
      const said = stderr.trim() || state.errorOutsideReply;
      failProcess(new Error(`claude warm process exited${how}${said ? `: ${said}` : ""}`));
      // Its background tasks ended with it (stdin EOF or a kill).
      this.cli.claudeReplyFlow.reportClaudeBackgroundTasks(state, participant, true);
      if (!entry.closed) {
        // Nothing of ours will run on it again; retire it now so background
        // work it leaves behind is not kept until the next message.
        void this.cli.warmAgentClose.closeWarmAgent(entry, "exited").catch(() => undefined);
      }
    });

    const entry: WarmAgentEntry = {
      key,
      scopeKey,
      providerKind: participant.kind,
      process: child,
      processIdentity: () => processIdentity,
      queue: Promise.resolve(),
      closed: false,
      hasLiveBackgroundWork: () => state.backgroundTasks.size > 0,
      captureUrgent: () => state.stepActive || Date.now() - state.lastTaskEventAt < CLAUDE_BACKGROUND_PROCESS_URGENT_WINDOW_MS,
      isIdle,
      whenIdle: (signal?: AbortSignal) => waitUntil(isIdle, signal),
      whenReplyIdle: (signal?: AbortSignal) => waitUntil(isReplyIdle, signal),
      isReplyIdle,
      everStartedStep: () => state.everStartedStep === true,
      capturedBackgroundProcesses: () => Array.from(capturedBackgroundProcesses.values()),
      refreshCapturedBackgroundProcesses: captureBackgroundProcesses,
      contextUsage: async (signal?: AbortSignal) => {
        if (closed || child.exitCode !== null || child.killed || signal?.aborted) return undefined;
        const response = await new Promise<Record<string, unknown> | undefined>((resolve) => {
          const requestId = sendClaudeWarmControl(hooks, { subtype: "get_context_usage" });
          const timer = setTimeout(() => finish(undefined), CLAUDE_CONTEXT_USAGE_TIMEOUT_MS);
          timer.unref();
          const onAbort = (): void => finish(undefined);
          const finish = (value: Record<string, unknown> | undefined): void => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            state.controlWaiters.delete(requestId);
            resolve(value);
          };
          state.controlWaiters.set(requestId, finish);
          signal?.addEventListener("abort", onAbort, { once: true });
        });
        const answer = response && stringField(response, "subtype") === "success" ? asRecord(response.response) : undefined;
        return buildAgentContextUsage({
          usedTokens: typeof answer?.totalTokens === "number" ? answer.totalTokens : undefined,
          contextWindowTokens: typeof answer?.maxTokens === "number" ? answer.maxTokens : undefined,
          source: "claude-code",
          model: state.model ?? participant.model,
          windowFromCli: true
        });
      },
      control: async (request: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal) => {
        if (closed || child.exitCode !== null || child.killed) throw new Error("The member's Claude Code process has ended.");
        if (signal?.aborted) throw new Error(CLAUDE_WARM_CANCELLED_MESSAGE);
        // A mode asked for here is the app's switch until the CLI answers:
        // its `system/status` for it is not a switch the CLI made itself.
        const requestedMode = request.subtype === "set_permission_mode" && typeof request.mode === "string" ? request.mode : undefined;
        if (requestedMode) state.requestedPermissionModes.set(requestedMode, (state.requestedPermissionModes.get(requestedMode) ?? 0) + 1);
        try {
          const response = await new Promise<Record<string, unknown> | undefined>((resolve) => {
            const requestId = sendClaudeWarmControl(hooks, request);
            const timer = setTimeout(() => finish(undefined), timeoutMs);
            timer.unref();
            const onAbort = (): void => finish(undefined);
            const finish = (value: Record<string, unknown> | undefined): void => {
              clearTimeout(timer);
              signal?.removeEventListener("abort", onAbort);
              state.controlWaiters.delete(requestId);
              resolve(value);
            };
            state.controlWaiters.set(requestId, finish);
            signal?.addEventListener("abort", onAbort, { once: true });
          });
          if (signal?.aborted) throw new Error(CLAUDE_WARM_CANCELLED_MESSAGE);
          if (!response) throw new ClaudeControlError(`Claude Code did not answer ${String(request.subtype)} in time.`, { timedOut: true });
          if (stringField(response, "subtype") !== "success") {
            throw new ClaudeControlError(stringField(response, "error") || `Claude Code refused ${String(request.subtype)}.`, { code: stringField(response, "code") });
          }
          const answer = asRecord(response.response) ?? {};
          if (requestedMode) {
            // Claude Code 2.1.330 answers with the mode it switched to.
            state.permissionMode = stringField(answer, "mode") ?? requestedMode;
            if (state.permissionMode === "auto") state.autoModeSeen = true;
          }
          return answer;
        } finally {
          if (requestedMode) {
            const left = (state.requestedPermissionModes.get(requestedMode) ?? 1) - 1;
            if (left > 0) state.requestedPermissionModes.set(requestedMode, left);
            else state.requestedPermissionModes.delete(requestedMode);
          }
        }
      },
      permissionMode: () => state.permissionMode,
      autoModeSeen: () => state.autoModeSeen,
      lastCompactBoundary: () => state.lastCompactBoundary,
      run: (
        turnPrompt: string,
        signal?: AbortSignal,
        onOutput?: CliAgentOutputCallback,
        onSessionId?: CliAgentSessionIdCallback,
        timeoutMs?: number,
        _nativeGoal?: NativeGoalRun,
        _onCodexServerRequest?: CliAgentCodexServerRequestCallback,
        claude?: ClaudeWarmRunContext
      ) => {
        if (closed || child.exitCode !== null || child.killed) {
          return Promise.reject(new Error("claude warm process is not running"));
        }
        if (claude?.onSelfResumedTurn) {
          state.onSelfResumedTurn = claude.onSelfResumedTurn;
        }
        if (claude?.onBackgroundTasksChanged) {
          state.onBackgroundTasksChanged = claude.onBackgroundTasksChanged;
        }
        return new Promise<ParticipantRunResult>((resolve, reject) => {
          const reply = newClaudeWarmReply({
            commandUuid: randomUUID(),
            prompt: turnPrompt,
            images: claude?.images,
            written: false,
            started: false,
            origin: claude?.origin,
            onStarted: claude?.onReplyStarted,
            onWritten: claude?.onMessageWritten,
            onPromptSuggestion: claude?.onPromptSuggestion,
            roleRuntime: claude?.roleRuntime,
            allowEmptyContent: claude?.allowEmptyContent ?? false,
            localCommand: claude?.localCommand,
            sessionId: state.sessionId,
            model: state.model ?? participant.model,
            onOutput,
            onSessionId,
            resolve,
            reject
          });
          if (signal?.aborted) {
            reply.settled = true;
            reject(new Error(CLAUDE_WARM_CANCELLED_MESSAGE));
            return;
          }
          const effectiveTimeoutMs = timeoutMs ?? this.cli.cliRuns.runTimeoutMs;
          if (effectiveTimeoutMs > 0) {
            reply.timer = setTimeout(() => {
              if (reply.settled) {
                return;
              }
              // A turn that outlived its run timeout: stop the step and retire
              // the process, as before.
              if (state.active === reply) {
                // The step's remaining output drains into the settled reply
                // until its result; it must not become a reply of its own.
                sendClaudeWarmControl(hooks, { subtype: "interrupt" });
              }
              entry.unusable = true;
              removeClaudeWarmReply(state, reply);
              reply.reject(new Error(`claude warm process timed out after ${effectiveTimeoutMs}ms`));
              hooks.settled();
            }, effectiveTimeoutMs);
            reply.timer.unref();
          }
          if (signal) {
            const abort = (): void => this.cli.claudeReplyFlow.stopClaudeWarmReply(state, reply, hooks, participant);
            signal.addEventListener("abort", abort, { once: true });
            reply.detachSignal = () => signal.removeEventListener("abort", abort);
          }
          state.replies.push(reply);
          reportSessionId(onSessionId, reply.sessionId);
          flushUnwritten();
        });
      }
    };
    return entry;
  }

  /** Routes one line of the warm CLI's output. The CLI owns the queue of
   *  messages and background work (verified on Claude Code 2.1.280, the same
   *  stream-json transport the dedicated CLI's SDK uses): a message sent while
   *  the model is idle starts a step; one sent mid-step is handed to that step
   *  at its next tool result; a background task that finishes while the model
   *  is idle makes the CLI start a step on its own. Each uuid-stamped message's
   *  queue state arrives as `command_lifecycle`, which is what ties a step's
   *  output to the reply it belongs to. */
  private handleClaudeWarmLine(
    line: string,
    participant: ParticipantConfig,
    fallbackSessionId: string | undefined,
    state: ClaudeWarmProcessState,
    hooks: ClaudeWarmProcessHooks
  ): void {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      void this.cli.cliRuns.writeDebugLog("cli-agent-claude-warm-invalid-json", {
        participantId: participant.id,
        line: line.slice(0, 120)
      });
      const reply = state.active;
      if (reply && !reply.settled) {
        removeClaudeWarmReply(state, reply);
        reply.reject(new Error(`claude warm process emitted invalid JSON: ${line.slice(0, 120)}`));
        hooks.markUnusable();
        hooks.settled();
      }
      return;
    }
    const record = asRecord(event) ?? {};
    const type = stringField(record, "type");
    const subtype = stringField(record, "subtype");
    state.sessionId = findSessionId(event) ?? state.sessionId ?? fallbackSessionId;
    state.model = findModelId(event) ?? state.model ?? participant.model;
    // The CLI says its mode on `system/init` and on every `system/status`,
    // including a switch it made itself (a plan the User approved).
    const reportedMode = type === "system" && !record.parent_tool_use_id ? stringField(record, "permissionMode") : undefined;
    if (reportedMode) {
      const previous = state.permissionMode;
      state.permissionMode = reportedMode;
      if (reportedMode === "auto") state.autoModeSeen = true;
      // A switch the CLI made itself (a plan the User approved): the member's
      // mode follows it. Not its start (`system/init`), and not a switch the
      // app asked for.
      if (subtype === "status" && previous !== undefined && previous !== reportedMode &&
        !state.requestedPermissionModes.has(reportedMode) && isClaudePermissionMode(reportedMode)) {
        void this.cli.cliRuns.writeDebugLog("cli.claude.permission-mode-moved", { participantId: participant.id, from: previous, to: reportedMode });
        try {
          state.onCliPermissionMode?.(reportedMode);
        } catch {
          // The member's mode is the app's to follow; the process goes on.
        }
      }
    }
    if (type === "command_lifecycle") {
      this.cli.claudeReplyFlow.handleClaudeCommandLifecycle(record, state, participant, hooks);
      return;
    }
    if (type === "control_response") {
      handleClaudeWarmControlResponse(record, state, hooks);
      return;
    }
    if (type === "prompt_suggestion") {
      this.cli.claudeReplyFlow.deliverClaudePromptSuggestion(record, state, participant);
      return;
    }
    if (type === "system") {
      if (subtype === "compact_boundary") {
        const metadata = asRecord(record.compact_metadata) ?? {};
        state.lastCompactBoundary = {
          count: (state.lastCompactBoundary?.count ?? 0) + 1,
          ...(typeof metadata.post_tokens === "number" ? { postTokens: metadata.post_tokens } : {})
        };
        // Counted for the member whatever reply, if any, it happened in, and
        // even if the process closes before anyone asks; a subagent's own
        // compaction leaves the member's system prompt as it was.
        if (!record.parent_tool_use_id) {
          this.cli.warmAgents.claudeCompactionsUnreported.set(state.scopeKey, (this.cli.warmAgents.claudeCompactionsUnreported.get(state.scopeKey) ?? 0) + 1);
        }
      }
      if (subtype === "init") {
        noteClaudeToolContext(record, state.toolContext);
        this.startClaudeWarmStep(state, participant, hooks);
      } else {
        this.cli.claudeReplyFlow.trackClaudeBackgroundTasks(record, subtype, state, participant);
      }
    } else if (!state.stepActive && claudeWarmEventShowsModelStep(type)) {
      // Output only a running step produces: a step this copy did not see start.
      this.startClaudeWarmStep(state, participant, hooks);
    }
    if (type === "result") {
      this.cli.claudeReplyFlow.finishClaudeWarmStep(event, record, state, participant, fallbackSessionId, hooks);
      return;
    }
    const reply = state.active;
    if (!reply || reply.settled) {
      if (type === "error") {
        // An error outside any reply says the process itself is failing:
        // replace it before the next message rather than write into it.
        void this.cli.cliRuns.writeDebugLog("cli-agent-claude-warm-error-without-reply", {
          participantId: participant.id,
          error: claudeWarmStreamError(event)
        });
        hooks.markUnusable();
      }
      return;
    }
    noteClaudeWarmReplyIdentity(reply, event, state);
    if (type === "error") {
      // The reply failed; whatever else the process carries keeps running. Any
      // later output of this step is dropped with the settled reply.
      const message = claudeWarmStreamError(event) ?? "claude warm process reported an error";
      removeClaudeWarmReply(state, reply);
      hooks.markUnusableIfIdle();
      reply.resolve(this.cli.cliRuns.failed(participant, new Error(message), Date.now() - reply.startedAt));
      hooks.settled();
      return;
    }
    applyClaudeWarmReplyEvent(reply, event, state.toolContext);
  }

  /** A step started (`system/init`, or the first output of one). With the
   *  lifecycle the reply is already bound by its `started` frame; otherwise the
   *  oldest message written and not yet answered is the one the CLI took, and
   *  with none the CLI started this step on its own. */
  private startClaudeWarmStep(state: ClaudeWarmProcessState, participant: ParticipantConfig, hooks: ClaudeWarmProcessHooks): void {
    state.stepActive = true;
    state.everStartedStep = true;
    state.errorOutsideReply = undefined;
    state.promptSuggestionTarget = undefined;
    if (state.active && !state.active.settled) {
      return;
    }
    const waiting = state.lifecycleSupported
      ? undefined
      : state.replies.find((reply) => reply.commandUuid && reply.written && !reply.started && !reply.settled);
    if (waiting) {
      activateClaudeWarmReply(state, waiting);
      return;
    }
    this.cli.claudeReplyFlow.startClaudeSelfResumedReply(state, participant, hooks);
  }
}
