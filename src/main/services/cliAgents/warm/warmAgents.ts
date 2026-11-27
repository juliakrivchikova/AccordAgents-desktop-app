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

/** What happens to a member process whose environment is outdated when its
 *  turn ends while it still carries background tasks: "wait" replaces it
 *  once they have finished; "stop" replaces it right after the turn, and the
 *  tasks end with it. PENDING the User's decision (asked 2026-11-27): do not
 *  release before it is answered. */
export type EnvironmentReplacementWithBackgroundTasks = "wait" | "stop";
export const ENVIRONMENT_REPLACEMENT_WITH_BACKGROUND_TASKS: EnvironmentReplacementWithBackgroundTasks = "wait";

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
  /** The environment version members on this device get now (Settings →
   *  Environment on a computer, the imported settings on a machine), once it
   *  has been told (environmentChanged). */
  private environmentVersion?: string;
  environmentReplacementWithBackgroundTasks: EnvironmentReplacementWithBackgroundTasks = ENVIRONMENT_REPLACEMENT_WITH_BACKGROUND_TASKS;

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

  /** The environment members get changed; `version` is the new one
   * (SettingsService.getManualAgentEnvironment). A member process started
   * with other values is closed once it holds no work: at once when idle,
   * otherwise the moment its turn ends (retireIfEnvironmentOutdated), so the
   * member's next message starts a new process that resumes the same session
   * with the new values, as one restarts a dedicated CLI between turns. A turn
   * in progress finishes on the process it started on, and messages sent
   * meanwhile join it (withBusyMemberEnvironment). Nothing is fenced: turns
   * keep starting meanwhile. */
  async environmentChanged(version: string): Promise<void> {
    this.environmentVersion = version;
    // Taken out of the map in one step, before any await, so no turn can pick
    // one of them up between this check and its close.
    const free = [...this.entries.values()].filter((entry) => this.environmentOutdated(entry) && this.freeForEnvironmentChange(entry));
    for (const entry of free) this.entries.delete(entry.key);
    // A close that fails is kept for retry (failedWarmClosures); it does not
    // undo the saved values.
    await Promise.allSettled(free.map((entry) => this.closeForEnvironment(entry)));
  }

  /** Closes a member process started with outdated environment values once
   *  it holds no work. Called whenever that may have become true: a run on it
   *  settled, the process went idle, a turn routed into it is over. */
  retireIfEnvironmentOutdated(entry: WarmAgentEntry): void {
    if (this.entries.get(entry.key) !== entry || !this.environmentOutdated(entry) || !this.freeForEnvironmentChange(entry)) return;
    this.entries.delete(entry.key);
    void this.closeForEnvironment(entry).catch(() => undefined);
  }

  /** Whether the process was started with other environment values than
   *  members get now. Its key carries the version it started with; a member
   *  on an added provider has the provider's own part after a `|`. */
  private environmentOutdated(entry: WarmAgentEntry): boolean {
    const started = warmKeyAgentEnvKey(entry.key);
    return this.environmentVersion !== undefined && !entry.closed && Boolean(started) && started!.split("|")[0] !== this.environmentVersion;
  }

  /** Nothing would be lost by closing the process now: no run is admitted or
   *  being prepared on it, no turn was routed into it, no reply is waiting,
   *  running or about to start on its own, and (unless the User chose to stop
   *  them) no background task runs. */
  private freeForEnvironmentChange(entry: WarmAgentEntry): boolean {
    if (entry.closed || entry.activeRuns || entry.environmentHolds || [...this.warmPreparations].some((value) => value.key === entry.key)) return false;
    if (this.environmentReplacementWithBackgroundTasks === "stop") return (entry.isReplyIdle ?? entry.isIdle)?.() !== false;
    return entry.isIdle?.() !== false && !entry.hasLiveBackgroundWork?.();
  }

  private closeForEnvironment(entry: WarmAgentEntry): Promise<void> {
    void this.cli.cliRuns.writeDebugLog("cli.agent-environment-replaced", {
      providerKind: entry.providerKind,
      scopeKey: entry.scopeKey,
      backgroundTasks: entry.hasLiveBackgroundWork?.() === true
    });
    return this.cli.warmAgentClose.closeWarmAgent(entry, "environment-changed");
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
    }).finally(() => {
      this.warmOperations--;
      entry.activeRuns = (entry.activeRuns ?? 1) - 1;
      // Its turn is over: a process holding outdated environment values is
      // replaced now rather than on the member's next message.
      this.retireIfEnvironmentOutdated(entry);
    });
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
   *  too) gets the environment as it is now. The turn holds that process
   *  until `release` (called once the turn is over), so it is not replaced
   *  under the turn before the turn reaches it. When the User chose to have
   *  background tasks stop for new values, a process kept only by them is
   *  replaced now instead. */
  withBusyMemberEnvironment(
    participant: ParticipantConfig,
    repoPath: string | undefined,
    kind: ConversationKind,
    options: CliAgentRunOptions
  ): { options: CliAgentRunOptions; release: () => void } {
    const unchanged = { options, release: (): void => undefined };
    if (!options.warm || options.nativeGoal || kind !== "chat") return unchanged;
    const scopeKey = warmAgentScopeKey(options.warm);
    const busy = Array.from(this.entries.values()).find((entry) => entry.scopeKey === scopeKey && !entry.closed && entry.isIdle?.() === false);
    const running = busy ? warmKeyAgentEnvKey(busy.key) : undefined;
    if (!busy || running === undefined || running === (options.agentEnvKey ?? "") ||
      busy.key !== warmAgentKey(participant, repoPath, kind, { ...options, agentEnvKey: running })) {
      return unchanged;
    }
    if (this.environmentReplacementWithBackgroundTasks === "stop" && this.freeForEnvironmentChange(busy)) {
      this.entries.delete(busy.key);
      void this.closeForEnvironment(busy).catch(() => undefined);
      return unchanged;
    }
    void this.cli.cliRuns.writeDebugLog("cli.agent-environment-change-deferred", { participantId: options.warm.participantId });
    busy.environmentHolds = (busy.environmentHolds ?? 0) + 1;
    let released = false;
    return {
      options: { ...options, agentEnvKey: running },
      release: (): void => {
        if (released) return;
        released = true;
        busy.environmentHolds = Math.max(0, (busy.environmentHolds ?? 1) - 1);
        this.retireIfEnvironmentOutdated(busy);
      }
    };
  }

  /** A process of this member still closing (replaced for a changed
   *  environment, or by its idle timer): the next one starts once it has
   *  gone, so two processes never hold the member's session at once. */
  private async waitForClosingInScope(scopeKey: string): Promise<void> {
    const closing = [...this.cli.warmAgentClose.closingWarmAgents].filter(([entry]) => entry.scopeKey === scopeKey).map(([, done]) => done);
    if (closing.length) await Promise.allSettled(closing);
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
    await this.waitForClosingInScope(scopeKey);
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
