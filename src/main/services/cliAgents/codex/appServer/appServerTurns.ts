import { capturePosixDescendantsFromTable, capturePosixProcessIdentity, type CapturedPosixProcess } from "../../../processTermination";
import type { ParticipantRunResult } from "../../../providers";
import { CodexAppServerRunError, isCodexCollaborationModeRefusal } from "../appServerErrors";
import { handleCodexAppServerCompactNotification } from "../appServerEvents";
import { codexAppServerThreadResumeParams, codexAppServerTurnInput, codexPrompt, codexReasoningEffort } from "../appServerParams";
import { codexAppServerFinalContent, flushCodexAppServerAgentText } from "../appServerText";
import type { CodexAppServerPendingCompact, CodexAppServerPendingTurn } from "../types";
import { CLI_AGENT_COMPACT_TIMEOUT_MS } from "../../constants";
import { errorText, reportSessionId } from "../../runs/outputText";
import { asRecord } from "../../runs/records";
import type {
  ClaudeWarmRunContext, CliAgentCodexServerRequestCallback, CliAgentCompactResult, CliAgentImageInput, CliAgentOutputCallback,
  CliAgentRunOptions, CliAgentSessionIdCallback, NativeGoalRun, WarmAgentEntry
} from "../../types";
import type { CodexAppServerThreadStartResult } from "./types";
import type { AppServerModules } from "./modules";
import type { AppServerLaunch } from "./launch";

export function resolveCodexCompactTimeoutMs(requestedTimeoutMs: number | undefined): number {
  return typeof requestedTimeoutMs === "number" && requestedTimeoutMs > 0
    ? requestedTimeoutMs
    : CLI_AGENT_COMPACT_TIMEOUT_MS;
}

/** How long Codex has to take a message steered into its running turn. */
const CODEX_STEER_TIMEOUT_MS = 15_000;

interface CodexAppServerTurnStartResult {
  turn?: {
    id?: string;
  };
}

/** The turn or compaction the app-server works on now. */
export class AppServerTurns {
  private processIdentity: ReturnType<typeof capturePosixProcessIdentity>;
  private capturedProcesses: CapturedPosixProcess[] = [];
  pendingTurn?: CodexAppServerPendingTurn;
  pendingCompact?: CodexAppServerPendingCompact;

  constructor(
    private readonly server: Pick<AppServerModules, "approvals" | "connection" | "guardian" | "thread">,
    private readonly launch: Pick<
      AppServerLaunch,
      | "child" | "cli" | "debugLogs" | "diffMode" | "key" | "kind" | "options" | "participant" | "repoPath" | "scopeKey"
    >
  ) {}

  private captureBeforeInterrupt(): boolean {
    if (process.platform === "win32") return true;
    const rows = this.launch.cli.warmAgentClose.readPosixProcessTableForTermination();
    if (!rows) return false;
    this.processIdentity ??= capturePosixProcessIdentity(this.launch.child.pid, () => rows);
    this.capturedProcesses = capturePosixDescendantsFromTable(this.launch.child.pid, rows, this.capturedProcesses, this.processIdentity);
    return true;
  }

  cleanupPendingTurn(): CodexAppServerPendingTurn | undefined {
    const current = this.pendingTurn;
    if (!current) {
      return undefined;
    }
    if (current.timer) {
      clearTimeout(current.timer);
    }
    if (current.abort) {
      current.abort();
    }
    for (const [requestKey, request] of this.server.approvals.pendingInboundRequests) {
      if (request.turn !== current) {
        continue;
      }
      this.server.approvals.pendingInboundRequests.delete(requestKey);
      request.controller.abort(new Error("Codex turn ended before the approval was answered."));
    }
    const turnPrefix = current.turnId ? `${current.threadId}:${current.turnId}:` : `${current.threadId}:`;
    for (const key of this.server.approvals.pendingFileChangeSummaries.keys()) {
      if (key.startsWith(turnPrefix)) this.server.approvals.pendingFileChangeSummaries.delete(key);
    }
    current.outstandingServerRequestIds.clear();
    this.pendingTurn = undefined;
    return current;
  }

  rejectPendingTurn(error: Error): void {
    const current = this.cleanupPendingTurn();
    if (!current) {
      return;
    }
    current.reject(error instanceof CodexAppServerRunError
      ? error
      : new CodexAppServerRunError(error, current.acceptedByProvider === true));
  }

  cleanupPendingCompact(): CodexAppServerPendingCompact | undefined {
    const current = this.pendingCompact;
    if (!current) {
      return undefined;
    }
    clearTimeout(current.timer);
    if (current.abort) {
      current.abort();
    }
    this.pendingCompact = undefined;
    return current;
  }

  rejectPendingCompact(error: Error): void {
    const current = this.cleanupPendingCompact();
    current?.reject(error);
  }

  private armPendingTurnTimer(turn: CodexAppServerPendingTurn, delayMs: number): void {
    if (delayMs <= 0 || this.pendingTurn !== turn) {
      return;
    }
    if (turn.timer) {
      clearTimeout(turn.timer);
    }
    turn.timeoutRemainingMs = delayMs;
    turn.timeoutDeadline = Date.now() + delayMs;
    turn.timer = setTimeout(() => {
      void this.server.approvals.cancelPendingInboundApprovals(turn, "Codex approval expired because the turn timed out.")
        .catch((error) => {
          void this.launch.debugLogs?.write("cli.codex-app-server.timeout-refusal-write-failed", {
            threadId: turn.threadId,
            turnId: turn.turnId,
            message: errorText(error)
          });
        });
      this.server.guardian.rejectPendingGuardianApprovals(new Error("Codex Guardian approval expired because the provider turn timed out."));
      this.rejectPendingTurn(new Error(`codex app-server timed out after ${delayMs}ms`));
    }, delayMs);
    turn.timer.unref();
  }

  pausePendingTurnTimer(turn: CodexAppServerPendingTurn): void {
    if (!turn.timer) {
      return;
    }
    clearTimeout(turn.timer);
    turn.timer = undefined;
    turn.timeoutRemainingMs = Math.max(1, (turn.timeoutDeadline ?? Date.now()) - Date.now());
    turn.timeoutDeadline = undefined;
  }

  resumePendingTurnTimer(turn: CodexAppServerPendingTurn): void {
    if (turn.outstandingServerRequestIds.size > 0 || turn.timer || !turn.timeoutRemainingMs) {
      return;
    }
    this.armPendingTurnTimer(turn, turn.timeoutRemainingMs);
  }

  /** Starts listening and gives the runner its handle on the process. */
  start(): WarmAgentEntry {
    this.launch.child.stdout.setEncoding("utf8");
    this.launch.child.stderr.setEncoding("utf8");
    this.processIdentity = capturePosixProcessIdentity(this.launch.child.pid, this.launch.cli.warmAgentClose.readPosixProcessTableForTermination);
    this.server.thread.threadId = this.launch.options.sessionId;
    this.server.thread.activeModel = this.launch.participant.model;
    this.server.connection.listen();
    return {
      key: this.launch.key,
      scopeKey: this.launch.scopeKey,
      providerKind: this.launch.participant.kind,
      process: this.launch.child,
      processIdentity: () => this.processIdentity,
      capturedBackgroundProcesses: () => this.capturedProcesses,
      queue: Promise.resolve(),
      closed: false,
      compact: (instructions, signal, onSessionId) => this.compact(instructions, signal, onSessionId),
      run: (...args) => this.run(...args),
      steer: (...args) => this.steer(...args)
    };
  }

  /**
   * A message typed into the running turn (WarmAgentEntry.steer): Codex's own
   * `turn/steer`, as Enter mid-turn does in its CLI. Once Codex takes it, the
   * reply so far ends as a turn that goes on (`turnContinues`), and what the
   * turn does from here is this message's reply. Not while the turn waits on
   * an approval (the CLI's prompt takes the input then) or runs a native goal.
   */
  private async steer(
    turnPrompt: string,
    signal?: AbortSignal,
    onOutput?: CliAgentOutputCallback,
    onSessionId?: CliAgentSessionIdCallback,
    timeoutMsOverride?: number,
    onCodexServerRequest?: CliAgentCodexServerRequestCallback,
    images?: CliAgentImageInput[]
  ): Promise<Promise<ParticipantRunResult> | undefined> {
    // A turn Codex is still starting (its `turn/start` not answered yet) is
    // steered once it has its id: cutting it then could leave it running.
    const starting = this.pendingTurn;
    for (const deadline = Date.now() + CODEX_STEER_TIMEOUT_MS; starting && !starting.turnId && this.pendingTurn === starting && Date.now() < deadline && !signal?.aborted;) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const running = this.pendingTurn;
    if (!running?.turnId || running.nativeGoal || running.outstandingServerRequestIds.size > 0 || signal?.aborted) return undefined;
    const turnId = running.turnId;
    const input = codexAppServerTurnInput(codexPrompt(turnPrompt, this.launch.repoPath, this.launch.diffMode, this.launch.kind, this.launch.options), images);
    let reply: Promise<ParticipantRunResult> | undefined;
    try {
      // Handed over as Codex's answer is read: what the turn says after it
      // (in the same output too) is this message's reply. Its reply so far
      // may be another message's steered in meanwhile (same Codex turn).
      await this.server.connection.sendRequest("turn/steer", { threadId: running.threadId, expectedTurnId: turnId, input }, CODEX_STEER_TIMEOUT_MS, (answer) => {
        const current = this.pendingTurn;
        if (answer.ok && current && current.threadId === running.threadId && current.turnId === turnId) {
          reply = this.handOverSteeredTurn(current, signal, onOutput, onSessionId, timeoutMsOverride, onCodexServerRequest);
        }
      });
    } catch (error) {
      void this.launch.debugLogs?.write("cli.codex-app-server.steer-refused", { threadId: running.threadId, turnId, message: errorText(error) });
      return undefined;
    }
    return reply;
  }

  private handOverSteeredTurn(
    running: CodexAppServerPendingTurn,
    signal: AbortSignal | undefined,
    onOutput: CliAgentOutputCallback | undefined,
    onSessionId: CliAgentSessionIdCallback | undefined,
    timeoutMsOverride: number | undefined,
    onCodexServerRequest: CliAgentCodexServerRequestCallback | undefined
  ): Promise<ParticipantRunResult> {
    flushCodexAppServerAgentText(running);
    const startedAt = Date.now();
    const timeoutMs = timeoutMsOverride ?? this.launch.cli.cliRuns.runTimeoutMs;
    reportSessionId(onSessionId, running.threadId);
    const reply = new Promise<ParticipantRunResult>((resolve, reject) => {
      this.pendingTurn = {
        startedAt,
        threadId: running.threadId,
        cwd: running.cwd,
        turnId: running.turnId,
        acceptedByProvider: true,
        messages: [],
        streamedText: "",
        visibleTranscript: "",
        // A step that started before the message ends in this reply.
        activityItems: new Map(running.activityItems),
        completedAgentMessages: [],
        nextAgentMessageStartsBlock: false,
        model: running.model,
        contextUsage: running.contextUsage,
        timeoutRemainingMs: timeoutMs > 0 ? timeoutMs : undefined,
        outstandingServerRequestIds: new Set(),
        onOutput,
        onCodexServerRequest,
        resolve,
        reject
      };
    });
    const steered = this.pendingTurn!;
    // An approval the turn asked for meanwhile goes on with it.
    for (const id of running.outstandingServerRequestIds) steered.outstandingServerRequestIds.add(id);
    running.outstandingServerRequestIds.clear();
    for (const request of this.server.approvals.pendingInboundRequests.values()) {
      if (request.turn === running) request.turn = steered;
    }
    // The reply so far is over: its timer and Stop no longer reach the turn.
    if (running.timer) clearTimeout(running.timer);
    running.abort?.();
    running.resolve({
      participant: this.launch.participant,
      ok: true,
      content: codexAppServerFinalContent(running),
      durationMs: Date.now() - running.startedAt,
      sessionId: running.threadId,
      roleRuntime: undefined,
      contextUsage: running.contextUsage,
      turnContinues: true
    });
    void this.launch.debugLogs?.write("cli.codex-app-server.steered", { threadId: running.threadId, turnId: running.turnId });
    if (timeoutMs > 0) this.armPendingTurnTimer(steered, timeoutMs);
    const abort = (): void => {
      if (this.pendingTurn !== steered) return;
      this.server.guardian.rejectPendingGuardianApprovals(new Error("Stopped by user."));
      void this.server.approvals.cancelPendingInboundApprovals(steered, "Stopped by user.").catch(() => undefined);
      if (steered.turnId && this.captureBeforeInterrupt()) {
        void this.server.connection.sendRequest("turn/interrupt", { threadId: steered.threadId, turnId: steered.turnId }).catch(() => undefined);
      }
      this.rejectPendingTurn(new Error("codex app-server turn was cancelled"));
    };
    if (signal) {
      steered.abort = () => signal.removeEventListener("abort", abort);
      signal.addEventListener("abort", abort, { once: true });
      // Stopped while Codex took it: the turn it went into stops now.
      if (signal.aborted) abort();
    }
    return reply;
  }

  private async compact(
    instructions?: string,
    signal?: AbortSignal,
    onSessionId?: CliAgentSessionIdCallback
  ): Promise<CliAgentCompactResult> {
    this.server.guardian.rejectPendingGuardianApprovals(new Error("Codex Guardian approval expired because context compaction started."));
    // A native goal deliberately gives its turn an unbounded timeout. Warm
    // app-server entries can be reused by later slash workflows, but that
    // turn-specific zero must never become an immediate compact timeout.
    const timeoutMs = resolveCodexCompactTimeoutMs(this.launch.options.timeoutMs);
    const currentThreadId = await this.server.thread.ensureThread(timeoutMs);
    const compactOptions: CliAgentRunOptions = {
      ...this.launch.options,
      sessionId: currentThreadId
    };
    if (instructions?.trim()) {
      compactOptions.compactInstructions = instructions;
    } else {
      delete compactOptions.compactInstructions;
    }
    delete compactOptions.clearCompactPrompt;
    const resumeResult = await this.server.connection.sendRequest("thread/resume", codexAppServerThreadResumeParams(
      currentThreadId,
      this.launch.participant,
      this.launch.repoPath,
      this.launch.kind,
      compactOptions
    ), timeoutMs) as CodexAppServerThreadStartResult;
    const compactThreadId = resumeResult.thread?.id ?? currentThreadId;
    this.server.thread.threadId = compactThreadId;
    this.server.thread.threadLoaded = true;
    this.server.thread.takeThread(resumeResult);
    reportSessionId(onSessionId, compactThreadId);
    if (this.pendingCompact) {
      return { participant: this.launch.participant, ok: false, error: "codex app-server already has an active compact operation" };
    }
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      this.rejectPendingCompact(new Error(`codex app-server compact timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
    const abort = (): void => {
      this.rejectPendingCompact(new Error("codex app-server compact was cancelled"));
    };
    const resultPromise = new Promise<CliAgentCompactResult>((resolve, reject) => {
      this.pendingCompact = {
        threadId: compactThreadId,
        startedAt,
        timer,
        abort: signal ? () => signal.removeEventListener("abort", abort) : undefined,
        onSessionId,
        resolve,
        reject
      };
    });
    if (signal?.aborted) {
      abort();
      return resultPromise;
    }
    signal?.addEventListener("abort", abort, { once: true });
    try {
      void this.launch.cli.cliRuns.writeDebugLog("cli-agent-compact-started", {
        providerKind: this.launch.participant.kind,
        participantId: this.launch.participant.id,
        threadId: compactThreadId,
        timeoutMs
      });
      void this.server.connection.sendRequest("thread/compact/start", { threadId: compactThreadId }, timeoutMs)
        .then((result) => {
          const record = asRecord(result);
          if (record) {
            handleCodexAppServerCompactNotification(record, this.launch.participant, this.pendingCompact, () => this.cleanupPendingCompact(), (error) => this.rejectPendingCompact(error));
          }
        })
        .catch((error) => {
          this.rejectPendingCompact(error instanceof Error ? error : new Error(String(error)));
        });
      const result = await resultPromise;
      if (result.contextUsage) {
        return result;
      }
      const logUsage = await this.launch.cli.sessionLogs.extractCodexSessionLogContextUsageWithRetry(result.sessionId ?? compactThreadId, this.launch.participant);
      return logUsage ? { ...result, contextUsage: logUsage } : result;
    } finally {
      if (instructions?.trim()) {
        const clearCompactOptions: CliAgentRunOptions = {
          ...this.launch.options,
          sessionId: compactThreadId,
          clearCompactPrompt: true
        };
        delete clearCompactOptions.compactInstructions;
        await this.server.connection.sendRequest("thread/resume", codexAppServerThreadResumeParams(
          compactThreadId,
          this.launch.participant,
          this.launch.repoPath,
          this.launch.kind,
          clearCompactOptions
        ), 10_000).catch(() => undefined);
      }
    }
  }

  private async run(
    turnPrompt: string,
    signal?: AbortSignal,
    onOutput?: CliAgentOutputCallback,
    onSessionId?: CliAgentSessionIdCallback,
    timeoutMsOverride?: number,
    nativeGoal?: NativeGoalRun,
    onCodexServerRequest?: CliAgentCodexServerRequestCallback,
    _claude?: ClaudeWarmRunContext,
    images?: CliAgentImageInput[]
  ): Promise<ParticipantRunResult> {
    this.server.guardian.rejectPendingGuardianApprovals(new Error("Codex Guardian approval expired because a new turn started."));
    const timeoutMs = nativeGoal ? 0 : (timeoutMsOverride ?? this.launch.cli.cliRuns.runTimeoutMs);
    const currentThreadId = await this.server.thread.ensureThread(timeoutMs);
    reportSessionId(onSessionId, currentThreadId);
    // A fork this turn made that copied the whole thread says why.
    const cutMissed = this.server.thread.forkCutMissed;
    this.server.thread.forkCutMissed = undefined;
    const startedAt = Date.now();
    let aborting = false;
    const abort = (): void => {
      if (aborting) {
        return;
      }
      aborting = true;
      const current = this.pendingTurn;
      if (!current) {
        return;
      }
      // Native interruption can reparent a detached command before the
      // app-server exits. Retain its identity while the tree still exists.
      const capturedBeforeInterrupt = this.captureBeforeInterrupt();
      void this.server.approvals.cancelPendingInboundApprovals(current, "Stopped by user.")
        .catch((error) => {
          void this.launch.debugLogs?.write("cli.codex-app-server.stop-refusal-write-failed", {
            threadId: current.threadId,
            turnId: current.turnId,
            message: errorText(error)
          });
        });
      this.server.guardian.rejectPendingGuardianApprovals(new Error("Stopped by user."));
      if (current.turnId && capturedBeforeInterrupt) {
        void this.server.connection.sendRequest("turn/interrupt", { threadId: current.threadId, turnId: current.turnId }).catch(() => undefined);
      }
      this.rejectPendingTurn(new Error("codex app-server turn was cancelled"));
    };
    const resultPromise = new Promise<ParticipantRunResult>((resolve, reject) => {
      this.pendingTurn = {
        startedAt,
        threadId: currentThreadId,
        cwd: this.launch.repoPath,
        messages: [],
        streamedText: "",
        visibleTranscript: "",
        activityItems: new Map(),
        completedAgentMessages: [],
        nextAgentMessageStartsBlock: false,
        model: this.server.thread.activeModel,
        nativeGoal: nativeGoal ? { turnCompleted: false } : undefined,
        timeoutRemainingMs: timeoutMs > 0 ? timeoutMs : undefined,
        outstandingServerRequestIds: new Set(),
        abort: signal ? () => signal.removeEventListener("abort", abort) : undefined,
        onOutput,
        onCodexServerRequest,
        resolve,
        reject
      };
    });
    // Said with the reply, and with a turn that failed or was stopped
    // (the copy is made either way).
    const reported = cutMissed
      ? resultPromise.then(
        (result) => ({ ...result, forkCutMissed: cutMissed }),
        (error: unknown) => {
          throw Object.assign(error instanceof Error ? error : new Error(String(error)), { forkCutMissed: cutMissed });
        }
      )
      : resultPromise;
    if (this.pendingTurn && timeoutMs > 0) {
      this.armPendingTurnTimer(this.pendingTurn, timeoutMs);
    }
    if (signal?.aborted) {
      abort();
      return reported;
    }
    signal?.addEventListener("abort", abort, { once: true });
    const codexTurnPrompt = codexPrompt(turnPrompt, this.launch.repoPath, this.launch.diffMode, this.launch.kind, this.launch.options);
    try {
      if (nativeGoal) {
        await this.server.connection.sendRequest("thread/goal/set", {
          threadId: currentThreadId,
          objective: nativeGoal.objective,
          status: "active",
          tokenBudget: null
        });
      }
      const collaborationMode = this.launch.cli.codexRuns.codexCollaborationMode(this.launch.participant, this.launch.kind, this.launch.options, this.server.thread.activeModel, this.server.thread.activeEffort);
      const turnParams = {
        threadId: currentThreadId,
        effort: codexReasoningEffort(this.launch.participant.reasoningEffort) ?? null,
        input: codexAppServerTurnInput(codexTurnPrompt, images)
      };
      let turn: CodexAppServerTurnStartResult;
      try {
        turn = await this.server.connection.sendRequest("turn/start", collaborationMode ? { ...turnParams, collaborationMode } : turnParams, timeoutMs) as CodexAppServerTurnStartResult;
      } catch (error) {
        // A Codex that does not take the collaboration mode: its Default
        // is what it runs anyway, so the turn goes without it; Plan mode
        // never runs as something else, it fails and says why.
        if (!collaborationMode || !isCodexCollaborationModeRefusal(errorText(error))) throw error;
        if (collaborationMode.mode === "plan") {
          throw new Error("This Codex does not take Plan mode from the app. Update Codex, or turn Plan mode off.");
        }
        turn = await this.server.connection.sendRequest("turn/start", turnParams, timeoutMs) as CodexAppServerTurnStartResult;
      }
      if (this.pendingTurn) {
        this.pendingTurn.acceptedByProvider = true;
        if (!this.pendingTurn.turnId) {
          this.pendingTurn.turnId = turn.turn?.id;
        }
      }
    } catch (error) {
      this.rejectPendingTurn(error instanceof Error ? error : new Error(String(error)));
    }
    return reported;
  }
}
