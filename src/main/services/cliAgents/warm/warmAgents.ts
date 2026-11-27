import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ConversationKind, ParticipantConfig } from "../../../../shared/types";
import { spawnCommand } from "../../command";
import { spawnNativeProcess } from "../../nativeProcess";
import { usesNativeProcessRegistry } from "../../nativeProcessRegistry";
import { terminateCapturedPosixProcesses } from "../../processTermination";
import { type ClaudePermissionMode, isClaudePermissionMode } from "../claude/permissionModes";
import type { ClaudeSendNowOutcome, CliAgentOutputCallback, CliAgentRunOptions, WarmAgentEntry } from "../types";
import { warmAgentKey, warmAgentScopeKey, warmConversationId, warmKeyAgentEnvKey } from "./warmKeys";
import type { CliModules } from "../modules";
import type { CliDependencies } from "../dependencies";

const NATIVE_GOAL_IDLE_WARNING_MS = 5 * 60_000;

/** clearWarmIdleTimer Members' CLI processes kept alive between turns. */
export class WarmAgents {
  readonly entries = new Map<string, WarmAgentEntry>();
  /** Compactions each member's live Claude Code process ran (its own, when
   *  its context filled, and /compact), by member (warm scope key), not yet
   *  taken by ChatService (takeMemberClaudeCompactions). */
  readonly claudeCompactionsUnreported = new Map<string, number>();
  readonly warmAgentCreations = new Map<string, Promise<WarmAgentEntry>>();
  private readonly conversationShutdowns = new Map<string, Promise<void>>();
  private readonly conversationOperations = new Map<string, number>();
  warmShutdown?: Promise<void>;
  warmOperations = 0;
  readonly warmPreparations = new Set<{ key: string; done: Promise<void> }>();

  constructor(
    private readonly cli: Pick<CliModules, "cliRuns" | "warmAgentClose">,
    private readonly deps: Pick<CliDependencies, "nativeProcessDbPath">
  ) {}

  shutdownWarmAgents(): Promise<void> {
    if (this.warmShutdown) return this.warmShutdown;
    this.cli.cliRuns.nativeShutdownGeneration++;
    const closing = (async () => {
      // An in-flight supervisor handshake must finish before shutdown can
      // declare its process set empty. New handshakes are refused meanwhile.
      await Promise.allSettled([...this.warmPreparations].map(value => value.done));
      await Promise.allSettled([...this.warmAgentCreations.values()]);
      const entries = [...new Set([...this.entries.values(), ...this.cli.warmAgentClose.failedWarmClosures])];
      const alreadyClosing = Array.from(this.cli.warmAgentClose.closingWarmAgents.values());
      this.entries.clear();
      this.cli.warmAgentClose.stopClaudeBackgroundProcessCapture();
      await Promise.all([...alreadyClosing, ...entries.map((entry) => this.cli.warmAgentClose.closeWarmAgent(entry, "shutdown"))]);
    })();
    this.warmShutdown = closing.finally(() => { this.warmShutdown = undefined; });
    return this.warmShutdown;
  }

  /** A changed agent environment: resident processes holding no work close
   * now. A process still answering, queued for, or carrying background work
   * keeps running with the values it started with, as a running dedicated CLI
   * does, and keeps taking its member's messages meanwhile
   * (withBusyMemberEnvironment); its key carries the environment version, so
   * the member's first turn once it is idle replaces it, and otherwise its idle
   * timer retires it. Nothing is fenced: turns keep starting meanwhile. */
  async retireIdleWarmAgents(reason: string): Promise<void> {
    // Taken out of the map in one step, before any await, so no turn can pick
    // one of them up between this check and its close.
    const idle = [...this.entries.values()].filter((entry) =>
      !entry.closed && !entry.activeRuns && entry.isIdle?.() !== false && !entry.hasLiveBackgroundWork?.());
    for (const entry of idle) this.entries.delete(entry.key);
    await Promise.all(idle.map((entry) => this.cli.warmAgentClose.closeWarmAgent(entry, reason)));
  }

  /** Archive/delete closes resident processes, while leaving provider session
   * files intact for a later unarchive. Other chats continue running. */
  closeConversationSessions(conversationId: string): Promise<void> {
    const pending = this.conversationShutdowns.get(conversationId);
    if (pending) return pending;
    if ((this.conversationOperations.get(conversationId) ?? 0) > 0) {
      return Promise.reject(new Error("Chat cannot be closed while native work is running."));
    }
    const belongs = (key: string): boolean => warmConversationId(key) === conversationId;
    // Install the admission barrier synchronously, before waiting on startup or
    // native shutdown. A second archive shares the exact same closure proof.
    const closing = Promise.resolve().then(async () => {
      await Promise.allSettled([...this.warmPreparations].filter(value => belongs(value.key)).map(value => value.done));
      await Promise.allSettled([...this.warmAgentCreations].filter(([key]) => belongs(key)).map(([, value]) => value));
      const entries = new Set([...this.entries.values(), ...this.cli.warmAgentClose.closingWarmAgents.keys(), ...this.cli.warmAgentClose.failedWarmClosures]);
      await Promise.all([...entries].filter(entry => belongs(entry.key)).map(entry => this.cli.warmAgentClose.closeWarmAgent(entry, "conversation-closed")));
    }).finally(() => this.conversationShutdowns.delete(conversationId));
    this.conversationShutdowns.set(conversationId, closing);
    return closing;
  }

  trackConversationOperation(conversationId: string | undefined, delta: number): void {
    if (!conversationId) return;
    const count = (this.conversationOperations.get(conversationId) ?? 0) + delta;
    if (count > 0) this.conversationOperations.set(conversationId, count);
    else this.conversationOperations.delete(conversationId);
  }

  conversationClosing(conversationId: string): boolean {
    return this.conversationShutdowns.has(conversationId) || [...this.cli.warmAgentClose.failedWarmClosures].some(entry => warmConversationId(entry.key) === conversationId);
  }

  terminateWarmAgentsImmediately(reason = "immediate shutdown"): void {
    const entries = new Set([
      ...this.entries.values(),
      ...this.cli.warmAgentClose.closingWarmAgents.keys(),
      ...this.cli.warmAgentClose.failedWarmClosures
    ]);
    this.entries.clear();
    this.cli.warmAgentClose.stopClaudeBackgroundProcessCapture();
    for (const entry of entries) {
      if (!entry.closed) {
        entry.closed = true;
        void this.cli.cliRuns.writeDebugLog("cli-agent-warm-closed", {
          providerKind: entry.providerKind,
          reason
        });
      }
      this.clearWarmIdleTimer(entry);
      const descendants = this.cli.warmAgentClose.capturedWarmAgentDescendants(entry);
      terminateCapturedPosixProcesses(descendants, "SIGKILL", this.cli.warmAgentClose.readPosixProcessTableForTermination);
      this.cli.warmAgentClose.terminateWarmAgentRoot(entry, "SIGKILL");
    }
  }

  scheduleWarmIdleTimerIfLive(entry: WarmAgentEntry, idleTimeoutMs: number): void {
    if (!entry.closed && entry.process.exitCode === null) {
      this.scheduleWarmIdleTimer(entry, idleTimeoutMs);
    }
  }

  /** Track preparation from before its first await, including login-shell
   * readiness. Shutdown cannot finish while that work could still spawn. */
  beginWarmPreparation(key: string): () => void {
    if (this.cli.cliRuns.nativeAdmissionsFenced || this.warmShutdown || this.conversationClosing(warmConversationId(key) ?? "")) {
      throw new Error("Native sessions are shutting down; this command did not start.");
    }
    let finish!: () => void;
    const entry = { key, done: new Promise<void>(resolve => { finish = resolve; }) };
    this.warmPreparations.add(entry);
    return () => { this.warmPreparations.delete(entry); finish(); };
  }

  enqueueWarmRun<T>(entry: WarmAgentEntry, task: () => Promise<T>): Promise<T> {
    return this.trackWarmRun(entry, task, entry.queue);
  }

  /** Admits one run on a warm entry. With `after`, the run waits for it (the
   *  entry's previous run); Claude passes none because its CLI queues
   *  messages itself and hands a message sent mid-step to the running step. */
  trackWarmRun<T>(entry: WarmAgentEntry, task: () => Promise<T>, after?: Promise<void>): Promise<T> {
    if (this.cli.cliRuns.nativeAdmissionsFenced) return Promise.reject(new Error("The machine is stopping after idle; this native command did not start."));
    this.warmOperations++;
    entry.activeRuns = (entry.activeRuns ?? 0) + 1;
    const run = (after ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const refusal = await this.cli.cliRuns.hostRefusal("this native command");
      if (refusal || this.cli.cliRuns.nativeAdmissionsFenced || this.warmShutdown || entry.closed) throw new Error(refusal ?? "Native admission is fenced.");
      return task();
    }).finally(() => { this.warmOperations--; entry.activeRuns = (entry.activeRuns ?? 1) - 1; });
    if (after) {
      entry.queue = run.then(() => undefined, () => undefined);
    }
    return run;
  }

  createTrackedWarmAgent(key: string, construct: () => Promise<WarmAgentEntry>): Promise<WarmAgentEntry> {
    if (this.cli.cliRuns.nativeAdmissionsFenced) return Promise.reject(new Error("The machine is stopping after idle; this native session did not start."));
    if (this.warmShutdown) return Promise.reject(new Error("The native sessions are shutting down; this command did not start."));
    if (this.conversationClosing(warmConversationId(key) ?? "")) return Promise.reject(new Error("This chat's native sessions are closing; this command did not start."));
    const existing = this.warmAgentCreations.get(key);
    if (existing) return existing;
    const creating = (async () => {
      const refusal = await this.cli.cliRuns.hostRefusal("this native session");
      if (refusal || this.cli.cliRuns.nativeAdmissionsFenced || this.warmShutdown || this.conversationClosing(warmConversationId(key) ?? "")) {
        throw new Error(refusal ?? "The native session is shutting down.");
      }
      return construct();
    })().then(async (entry) => {
      if (this.warmShutdown || this.conversationShutdowns.has(warmConversationId(key) ?? "")) {
        await this.cli.warmAgentClose.closeWarmAgent(entry, "shutdown-during-start");
        throw new Error("The native session shut down before this command started.");
      }
      this.entries.set(key, entry);
      return entry;
    }).finally(() => this.warmAgentCreations.delete(key));
    this.warmAgentCreations.set(key, creating);
    return creating;
  }

  async spawnResidentProcess(scope: string, command: string, args: string[], options: {
    cwd?: string; env: NodeJS.ProcessEnv; detached: boolean; stdio: ["pipe", "pipe", "pipe"];
  }): Promise<ChildProcessWithoutNullStreams> {
    // windowsHide: on Windows a console program started from the app gets a
    // console window of its own, and closing it would kill the member.
    if (!this.deps.nativeProcessDbPath || !usesNativeProcessRegistry()) return spawnCommand(command, args, { ...options, windowsHide: true });
    return spawnNativeProcess({ scope, command, args, cwd: options.cwd, env: options.env, dbPath: this.deps.nativeProcessDbPath });
  }

  /** Whether a live process of this member is answering, or about to start a
   *  reply on its own (Claude: a background task finished and the CLI answers
   *  it), before the chat has registered that reply as a run. */
  memberProcessAnswering(conversationId: string, participantId: string): boolean {
    const scopeKey = warmAgentScopeKey({ conversationId, participantId, contextKey: "", idleTimeoutMs: 0 });
    return Array.from(this.entries.values()).some((entry) => entry.scopeKey === scopeKey && !entry.closed && entry.isReplyIdle?.() === false);
  }

  /** How many compactions the member's Claude Code process ran since this was
   *  last asked, each told once: after one, Claude Code rebuilds its system
   *  prompt from the text that process was launched with, which may be older
   *  than the member's access now (ChatService says it again). */
  takeMemberClaudeCompactions(conversationId: string, participantId: string): number {
    const scopeKey = warmAgentScopeKey({ conversationId, participantId, contextKey: "", idleTimeoutMs: 0 });
    const count = this.claudeCompactionsUnreported.get(scopeKey) ?? 0;
    this.claudeCompactionsUnreported.delete(scopeKey);
    return count;
  }

  /** Whether the member's live Claude Code process ran in auto mode (the CLI
   *  said so itself): the account has Claude Code's auto mode. */
  memberClaudeAutoModeAvailable(conversationId: string, participantId: string): boolean {
    const scopeKey = warmAgentScopeKey({ conversationId, participantId, contextKey: "", idleTimeoutMs: 0 });
    return Array.from(this.entries.values())
      .some((entry) => entry.scopeKey === scopeKey && !entry.closed && entry.autoModeSeen?.() === true);
  }

  /** The permission mode the member's live Claude Code process is in (the one
   *  memberClaudeControl talks to), as far as the app knows; undefined with
   *  none live here. */
  memberClaudePermissionMode(conversationId: string, participantId: string): ClaudePermissionMode | undefined {
    const scopeKey = warmAgentScopeKey({ conversationId, participantId, contextKey: "", idleTimeoutMs: 0 });
    const live = Array.from(this.entries.values())
      .filter((entry) => entry.scopeKey === scopeKey && !entry.closed && entry.process.exitCode === null && entry.control);
    const mode = (live.find((item) => item.isReplyIdle?.() === false) ?? live[0])?.permissionMode?.();
    return mode && isClaudePermissionMode(mode) ? mode : undefined;
  }

  /** One of the CLI's own control requests, sent to the member's live Claude
   *  Code process: the one answering now, else any still open. Undefined when
   *  the member has no live Claude Code process on this device. */
  async memberClaudeControl(
    conversationId: string,
    participantId: string,
    request: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<Record<string, unknown> | undefined> {
    const scopeKey = warmAgentScopeKey({ conversationId, participantId, contextKey: "", idleTimeoutMs: 0 });
    const live = Array.from(this.entries.values())
      .filter((entry) => entry.scopeKey === scopeKey && !entry.closed && entry.process.exitCode === null && entry.control);
    const entry = live.find((item) => item.isReplyIdle?.() === false) ?? live[0];
    return entry?.control ? entry.control(request, timeoutMs, signal) : undefined;
  }

  /** Send now on the member's live Claude Code process that answers now
   *  (WarmAgentEntry.sendNow); `unsupported` with none answering here. */
  async memberClaudeSendNow(conversationId: string, participantId: string, waitingRunId?: string, runningRunId?: string): Promise<ClaudeSendNowOutcome> {
    const scopeKey = warmAgentScopeKey({ conversationId, participantId, contextKey: "", idleTimeoutMs: 0 });
    const entry = Array.from(this.entries.values()).find((item) => item.scopeKey === scopeKey && !item.closed &&
      item.process.exitCode === null && item.isReplyIdle?.() === false && item.sendNow);
    return entry?.sendNow ? entry.sendNow(waitingRunId, runningRunId) : "unsupported";
  }

  /** A changed agent environment waits for a busy member process (answering,
   *  or carrying background tasks) the way a Chrome switch does: the member's
   *  messages keep going into the session already running, which keeps the
   *  values it started with, as in the dedicated CLI, and nothing waits. Its
   *  first turn once that process is idle starts with the new values. A run
   *  that would not use that process anyway (a goal, or other settings changed
   *  too) gets the environment as it is now. */
  withBusyMemberEnvironment(
    participant: ParticipantConfig,
    repoPath: string | undefined,
    kind: ConversationKind,
    options: CliAgentRunOptions
  ): CliAgentRunOptions {
    if (!options.warm || options.nativeGoal || kind !== "chat") return options;
    const scopeKey = warmAgentScopeKey(options.warm);
    const busy = Array.from(this.entries.values()).find((entry) => entry.scopeKey === scopeKey && !entry.closed && entry.isIdle?.() === false);
    const running = busy ? warmKeyAgentEnvKey(busy.key) : undefined;
    if (running === undefined || running === (options.agentEnvKey ?? "") ||
      busy!.key !== warmAgentKey(participant, repoPath, kind, { ...options, agentEnvKey: running })) {
      return options;
    }
    void this.cli.cliRuns.writeDebugLog("cli.agent-environment-change-deferred", { participantId: options.warm.participantId });
    return { ...options, agentEnvKey: running };
  }

  /** Retire every warm process of one member, e.g. when the credential it was
   *  started with is removed; otherwise it would linger until the idle timeout. */
  async closeWarmAgents(conversationId: string, participantId: string, reason = "context-changed"): Promise<void> {
    const scopeKey = warmAgentScopeKey({ conversationId, participantId, contextKey: "", idleTimeoutMs: 0 });
    const entries = Array.from(this.entries.values()).filter((entry) => entry.scopeKey === scopeKey);
    for (const entry of entries) {
      this.entries.delete(entry.key);
      await this.cli.warmAgentClose.closeWarmAgent(entry, reason);
    }
  }

  async closeStaleWarmAgents(scopeKey: string, nextKey: string, closable: (entry: WarmAgentEntry) => boolean = () => true, reason = "context-changed"): Promise<void> {
    const stale = Array.from(this.entries.values()).filter((entry) => entry.scopeKey === scopeKey && entry.key !== nextKey && closable(entry));
    for (const entry of stale) {
      this.entries.delete(entry.key);
      await this.cli.warmAgentClose.closeWarmAgent(entry, reason);
    }
  }

  scheduleWarmIdleTimer(entry: WarmAgentEntry, idleTimeoutMs: number): void {
    this.clearWarmIdleTimer(entry);
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined;
      if (entry.isIdle?.() === false) {
        // Still answering or still carrying background work: closing now would
        // destroy it. The process re-arms the timer when it becomes idle.
        return;
      }
      this.entries.delete(entry.key);
      void this.cli.warmAgentClose.closeWarmAgent(entry, "idle-timeout");
    }, idleTimeoutMs);
    entry.idleTimer.unref();
  }

  createNativeGoalIdleMonitor(
    participant: ParticipantConfig,
    onOutput: CliAgentOutputCallback | undefined,
    warningMs = NATIVE_GOAL_IDLE_WARNING_MS
  ): { touch: () => void; close: () => void } {
    let timer: NodeJS.Timeout | undefined;
    let closed = false;
    const schedule = (): void => {
      if (closed) {
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = undefined;
        if (closed) {
          return;
        }
        const text = `${participant.label} has produced no provider output for 5 minutes. The native goal is still running and can be stopped.`;
        onOutput?.({
          kind: "tool",
          text: `${text}\n`,
          activityKind: "status",
          activityStatus: "started"
        });
        void this.cli.cliRuns.writeDebugLog("cli-agent-native-goal-idle-warning", {
          providerKind: participant.kind,
          participantId: participant.id,
          idleMs: warningMs
        });
      }, warningMs);
      timer.unref();
    };
    const touch = (): void => {
      schedule();
    };
    schedule();
    return {
      touch,
      close: (): void => {
        closed = true;
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
      }
    };
  }

  clearWarmIdleTimer(entry: WarmAgentEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
  }
}
