import type { ParticipantConfig } from "../../../../shared/types";
import { buildAgentContextUsage, contextWindowForModel } from "../../../../shared/agentContext";
import type { ParticipantRunResult } from "../../providers";
import { CLAUDE_WARM_CANCELLED_MESSAGE } from "./constants";
import { claudeWarmStreamError } from "./output";
import {
  activateClaudeWarmReply, claudeBackgroundTaskLabel, claudeWarmReplyOutput, claudeWarmSegmentText, newClaudeWarmReply,
  noteClaudeWarmReplyIdentity, removeClaudeWarmReply, sendClaudeWarmControl
} from "./replies";
import type { ClaudeWarmProcessHooks, ClaudeWarmProcessState } from "./types";
import { SESSION_LOG_RETRIES } from "../constants";
import { emitLiveOutput, errorText, reportSessionId } from "../runs/outputText";
import { asRecord, findSessionId, stringField } from "../runs/records";
import type { ClaudeWarmReply, CliAgentBackgroundTask, CliAgentOutputEvent, CliAgentReplyStart, CliAgentSelfResumedTurn } from "../types";
import type { CliModules } from "../modules";

// How long a Stop may wait for the CLI to acknowledge an interrupt or a queue
// removal before the reply is settled anyway and the process retired.
const CLAUDE_WARM_STOP_ACK_TIMEOUT_MS = 15_000;

// After a background task finishes while the model is idle the CLI starts a
// step of its own within milliseconds; until it does, the process is not idle.
const CLAUDE_WARM_SELF_RESUME_EXPECTED_MS = 30_000;

// How long a step the CLI starts on its own may be silent before the app is
// told of it anyway (a CLI that does not report its model request).
const CLAUDE_SELF_RESUMED_QUIET_MS = 1_500;

/** Replies of a live Claude Code process: started, stopped, finished, and what they leave running. */
export class ClaudeReplyFlow {
  /** Overridable in tests; see CLAUDE_WARM_STOP_ACK_TIMEOUT_MS. */
  private claudeWarmStopAckTimeoutMs = CLAUDE_WARM_STOP_ACK_TIMEOUT_MS;

  constructor(private readonly cli: Pick<CliModules, "claudeSettings" | "cliRuns" | "sessionLogs">) {}

  /** The CLI started a step with no message of ours pending: a background task
   *  finished while the model was idle (or a scheduled task fired). In the
   *  dedicated CLI that continuation appears as a new turn of the transcript;
   *  here it is offered to the caller as a new reply, once the model works on
   *  it: a notification whose report the CLI has already handed to the model
   *  starts a step that ends at once with nothing (num_turns 0), and the
   *  dedicated CLI shows nothing for it. Its output is buffered until the
   *  caller attaches, so nothing produced before then is lost. */
  startClaudeSelfResumedReply(
    state: ClaudeWarmProcessState,
    participant: ParticipantConfig,
    hooks: ClaudeWarmProcessHooks
  ): ClaudeWarmReply {
    const origin = state.idleOrigin ?? state.lastOrigin;
    let resolveReply!: (result: ParticipantRunResult) => void;
    let rejectReply!: (error: Error) => void;
    const settled = new Promise<ParticipantRunResult>((resolve, reject) => {
      resolveReply = resolve;
      rejectReply = reject;
    });
    settled.catch(() => undefined);
    const buffered: CliAgentOutputEvent[] = [];
    const reply = newClaudeWarmReply({
      origin,
      written: true,
      allowEmptyContent: true,
      sessionId: state.sessionId,
      model: state.model ?? participant.model,
      buffered,
      onOutput: (event) => {
        // Text events carry the whole reply so far; while nobody is attached,
        // keep one merged text event instead of every cumulative copy.
        const last = reply.buffered?.at(-1);
        if (event.kind === "text" && last?.kind === "text" && !last.activityKind && !event.activityKind) {
          reply.buffered?.splice(-1, 1, { ...event, text: `${last.text}${event.text}` });
          return;
        }
        reply.buffered?.push(event);
      },
      resolve: resolveReply,
      reject: rejectReply
    });
    state.replies.push(reply);
    activateClaudeWarmReply(state, reply);
    const handler = state.onSelfResumedTurn;
    void this.cli.cliRuns.writeDebugLog("cli-agent-claude-self-resumed", {
      participantId: participant.id,
      hasHandler: Boolean(handler),
      originRunId: origin?.runId,
      liveTasks: state.backgroundTasks.size
    });
    if (!handler) {
      reply.buffered = undefined;
      reply.onOutput = undefined;
      return reply;
    }
    let attached = false;
    const turn: CliAgentSelfResumedTurn = {
      origin,
      attach: (handlers) => {
        if (attached) {
          return settled;
        }
        attached = true;
        const replay = reply.buffered ?? [];
        reply.buffered = undefined;
        reply.onOutput = handlers.onOutput;
        reply.onSessionId = handlers.onSessionId;
        for (const event of replay) {
          handlers.onOutput?.(event);
        }
        reportSessionId(handlers.onSessionId, reply.sessionId);
        const signal = handlers.signal;
        if (signal && !reply.settled) {
          const abort = (): void => this.stopClaudeWarmReply(state, reply, hooks, participant);
          if (signal.aborted) {
            abort();
          } else {
            signal.addEventListener("abort", abort, { once: true });
            reply.detachSignal = () => signal.removeEventListener("abort", abort);
          }
        }
        return settled;
      }
    };
    const quiet = setTimeout(() => reply.offer?.(), CLAUDE_SELF_RESUMED_QUIET_MS);
    quiet.unref();
    reply.offer = () => {
      reply.offer = undefined;
      clearTimeout(quiet);
      try {
        handler(turn);
      } catch (error) {
        void this.cli.cliRuns.writeDebugLog("cli-agent-claude-self-resumed-handler-error", {
          participantId: participant.id,
          error: errorText(error)
        });
      }
    };
    return reply;
  }

  /** Ends a reply the CLI started itself and then had nothing to do in: the
   *  app was never told of it. Its rows (a background task finished) go to
   *  the reply that comes next. */
  private dropUnofferedReply(state: ClaudeWarmProcessState, reply: ClaudeWarmReply, participant: ParticipantConfig): void {
    reply.offer = undefined;
    state.pendingNotices.unshift(...(reply.buffered ?? []));
    reply.buffered = undefined;
    removeClaudeWarmReply(state, reply);
    void this.cli.cliRuns.writeDebugLog("cli-agent-claude-self-resumed-empty", { participantId: participant.id });
    reply.resolve({ participant, ok: true, content: "", durationMs: Date.now() - reply.startedAt });
  }

  /** `command_lifecycle`: `queued` when a message enters the CLI's queue,
   *  `started` when a step takes it (at a step's start, or mid-step at the next
   *  tool result), then `completed`, `cancelled` or `discarded`. */
  handleClaudeCommandLifecycle(
    record: Record<string, unknown>,
    state: ClaudeWarmProcessState,
    participant: ParticipantConfig,
    hooks: ClaudeWarmProcessHooks
  ): void {
    if (!state.lifecycleSupported) {
      state.lifecycleSupported = true;
      hooks.flush();
    }
    const uuid = stringField(record, "command_uuid");
    const lifecycle = stringField(record, "state");
    const reply = uuid ? state.replies.find((candidate) => candidate.commandUuid === uuid) : undefined;
    if (!reply || reply.settled) {
      return;
    }
    if (lifecycle === "started") {
      const previous = state.active;
      let start: CliAgentReplyStart | undefined;
      if (previous && previous !== reply && previous.stopRequested && !previous.settled) {
        // Stopped as the next message joined its step: it ends stopped.
        removeClaudeWarmReply(state, previous);
        previous.reject(new Error(CLAUDE_WARM_CANCELLED_MESSAGE));
      } else if (previous && previous !== reply && !previous.settled) {
        // The CLI handed this message to the step that was running. Like the
        // CLI's transcript, which shows the message at that point and the rest
        // of the step after it, the reply so far ends here and everything the
        // step produces from now on answers the new message.
        if (previous.offer) this.dropUnofferedReply(state, previous, participant);
        else this.finishClaudeWarmReply(state, previous, claudeWarmSegmentText(previous, undefined), undefined, participant, { allowEmpty: true, turnContinues: true });
        void this.cli.cliRuns.writeDebugLog("cli-agent-claude-message-joined-step", { participantId: participant.id });
        // A step the CLI started on its own carries the origin of the work
        // that finished, an older reply: its own start is the step's.
        start = {
          ...(previous.commandUuid && previous.origin ? { joinedReply: previous.origin } : {}),
          joinedStepStartedAt: previous.stepStartedAt ?? previous.startedAt
        };
      }
      activateClaudeWarmReply(state, reply, start);
      if (reply.stopRequested) {
        // Its removal from the queue came too late: stop it now that it runs.
        state.interruptTarget = reply;
        state.interruptRequestId = sendClaudeWarmControl(hooks, { subtype: "interrupt" });
      }
      return;
    }
    if ((lifecycle === "cancelled" || lifecycle === "discarded") && state.active !== reply) {
      removeClaudeWarmReply(state, reply);
      reply.reject(new Error(reply.stopRequested
        ? CLAUDE_WARM_CANCELLED_MESSAGE
        : "Claude Code dropped this message before working on it."));
      hooks.settled();
    }
  }

  /** Stop: a running reply is interrupted, which ends only the current step
   *  (background tasks keep running, as with Esc in the dedicated CLI); a
   *  message still waiting in the CLI's queue is removed from it. */
  stopClaudeWarmReply(
    state: ClaudeWarmProcessState,
    reply: ClaudeWarmReply,
    hooks: ClaudeWarmProcessHooks,
    participant: ParticipantConfig
  ): void {
    if (reply.settled || reply.stopRequested) {
      return;
    }
    reply.stopRequested = true;
    if (!reply.written) {
      removeClaudeWarmReply(state, reply);
      reply.reject(new Error(CLAUDE_WARM_CANCELLED_MESSAGE));
      hooks.settled();
      return;
    }
    if (state.active === reply) {
      state.interruptTarget = reply;
      state.interruptRequestId = sendClaudeWarmControl(hooks, { subtype: "interrupt" });
    } else if (reply.commandUuid) {
      const requestId = sendClaudeWarmControl(hooks, { subtype: "cancel_async_message", message_uuid: reply.commandUuid });
      state.cancelRequests.set(requestId, reply);
    }
    reply.stopTimer = setTimeout(() => {
      if (reply.settled) {
        return;
      }
      // The CLI never acknowledged the Stop: settle it and retire the process
      // before the next turn rather than leave the reply running.
      void this.cli.cliRuns.writeDebugLog("cli-agent-claude-stop-unacknowledged", { participantId: participant.id });
      hooks.markUnusable();
      // An active step keeps draining into the settled reply (see above).
      removeClaudeWarmReply(state, reply);
      reply.reject(new Error(CLAUDE_WARM_CANCELLED_MESSAGE));
      hooks.settled();
    }, this.claudeWarmStopAckTimeoutMs);
    reply.stopTimer.unref();
  }

  /** The step's `result`: the reply it carried is finished. Work it left in the
   *  background keeps running on this process; the reply says so. */
  finishClaudeWarmStep(
    event: unknown,
    record: Record<string, unknown>,
    state: ClaudeWarmProcessState,
    participant: ParticipantConfig,
    fallbackSessionId: string | undefined,
    hooks: ClaudeWarmProcessHooks
  ): void {
    state.stepActive = false;
    const reply = state.active;
    state.active = undefined;
    if (!reply || reply.settled) {
      if (!reply && record.is_error === true) {
        state.errorOutsideReply = claudeWarmStreamError(event);
      }
      hooks.settled();
      return;
    }
    noteClaudeWarmReplyIdentity(reply, event, state);
    reply.sessionId = reply.sessionId ?? fallbackSessionId;
    reply.resultEvents.push(event);
    if (reply.offer) {
      if (record.is_error !== true && !claudeWarmSegmentText(reply, event).trim()) {
        this.dropUnofferedReply(state, reply, participant);
        hooks.settled();
        return;
      }
      reply.offer();
    }
    this.noteClaudeBackgroundWorkStillRunning(state, reply);
    const interruptTarget = state.interruptTarget;
    // An interrupt the CLI has answered has done whatever it did by the end
    // of this step; one still unanswered may yet reach the next step.
    if (record.is_error === true || state.interruptRequestId === undefined) {
      state.interruptTarget = undefined;
    }
    if (record.is_error === true && reply.stopRequested) {
      // The interrupt ended the step (`error_during_execution`).
      removeClaudeWarmReply(state, reply);
      reply.reject(new Error(CLAUDE_WARM_CANCELLED_MESSAGE));
    } else if (record.is_error === true && interruptTarget && interruptTarget !== reply
      && stringField(record, "subtype") === "error_during_execution") {
      // A Stop meant for the previous reply reached the CLI after this message
      // had started (as Esc in the dedicated CLI stops whatever runs): this
      // reply was stopped with it, it did not fail.
      removeClaudeWarmReply(state, reply);
      void this.cli.cliRuns.writeDebugLog("cli-agent-claude-stop-reached-next-reply", { participantId: participant.id });
      reply.resolve(this.cli.cliRuns.failed(
        participant,
        new Error("Stopped together with the previous reply: the Stop reached Claude Code after this message had started. Send it again to continue."),
        Date.now() - reply.startedAt
      ));
    } else if (record.is_error === true) {
      const message = claudeWarmStreamError(event) ?? "claude warm process returned an error result";
      removeClaudeWarmReply(state, reply);
      // A failed step is the end of one reply, not of the process: anything
      // still running on it keeps going. With nothing else live the process is
      // replaced before the next turn, as before.
      hooks.markUnusableIfIdle();
      reply.resolve(this.cli.claudeSettings.withClaudePermissionDenialWarning(
        this.cli.cliRuns.failed(participant, new Error(message), Date.now() - reply.startedAt),
        event,
        participant,
        "warm"
      ));
    } else {
      // A reply whose step only started background work may carry no text.
      this.finishClaudeWarmReply(state, reply, claudeWarmSegmentText(reply, event), event, participant, {
        allowEmpty: reply.allowEmptyContent || state.backgroundTasks.size > 0
      });
      state.promptSuggestionTarget = reply.onPromptSuggestion;
    }
    hooks.settled();
  }

  private noteClaudeBackgroundWorkStillRunning(state: ClaudeWarmProcessState, reply: ClaudeWarmReply): void {
    const tasks = Array.from(state.backgroundTasks.values());
    if (tasks.length === 0) {
      return;
    }
    // A note on the finished reply, not a live row: the work belongs to the
    // process, and its result arrives as a reply of its own.
    emitLiveOutput(claudeWarmReplyOutput(reply), "tool", `Running in the background: ${tasks.join("; ")}\n`, undefined, {
      activityKind: "status",
      activityStatus: "completed"
    });
    void this.cli.cliRuns.writeDebugLog("cli-agent-claude-reply-left-background-work", {
      liveTasks: tasks.length
    });
  }

  private finishClaudeWarmReply(
    state: ClaudeWarmProcessState,
    reply: ClaudeWarmReply,
    segment: string,
    event: unknown,
    participant: ParticipantConfig,
    options: { allowEmpty?: boolean; turnContinues?: boolean } = {}
  ): void {
    removeClaudeWarmReply(state, reply);
    const content = segment.trim();
    if (!content && !options.allowEmpty) {
      reply.reject(new Error("Claude warm process completed without response content."));
      return;
    }
    const sessionId = (event === undefined ? undefined : findSessionId(event)) ?? reply.sessionId;
    reportSessionId(reply.onSessionId, sessionId);
    const contextModel = reply.contextModel ?? reply.model;
    const contextUsage = buildAgentContextUsage({
      usedTokens: reply.usedTokens,
      contextWindowTokens: reply.contextWindowTokens ?? contextWindowForModel(participant.kind, contextModel),
      source: "claude-code",
      model: contextModel,
      windowFromCli: reply.contextWindowTokens !== undefined
    });
    let result: ParticipantRunResult = {
      participant,
      ok: true,
      content,
      durationMs: Date.now() - reply.startedAt,
      sessionId,
      roleRuntime: reply.roleRuntime,
      contextUsage,
      ...(reply.lastAssistantUuid ? { sessionCut: reply.lastAssistantUuid } : {}),
      ...(options.turnContinues ? { turnContinues: true } : {})
    };
    for (const raw of reply.resultEvents) {
      result = this.cli.claudeSettings.withClaudePermissionDenialWarning(result, raw, participant, "warm");
    }
    if (contextUsage || !sessionId || reply.localCommand) {
      reply.resolve(result);
      return;
    }
    void this.cli.sessionLogs.extractClaudeSessionLogContextUsageWithRetry(sessionId, participant, SESSION_LOG_RETRIES, reply.contextWindowTokens)
      .then((logUsage) => reply.resolve({ ...result, contextUsage: logUsage }))
      .catch(() => reply.resolve(result));
  }

  /** Tells the caller which background tasks are live whenever that changes,
   *  so the member can be shown as working in the background. */
  reportClaudeBackgroundTasks(state: ClaudeWarmProcessState, participant: ParticipantConfig, ended = false): void {
    const tasks: CliAgentBackgroundTask[] = ended ? [] : Array.from(state.backgroundTasks.entries()).map(([id, label]) => ({
      id,
      label,
      origin: state.backgroundTaskOrigins.get(id)
    }));
    const signature = JSON.stringify(tasks.map((task) => [task.id, task.label, task.origin?.messageId]));
    if (signature === state.reportedBackgroundTasks) {
      return;
    }
    state.reportedBackgroundTasks = signature;
    try {
      state.onBackgroundTasksChanged?.(tasks);
    } catch (error) {
      void this.cli.cliRuns.writeDebugLog("cli-agent-claude-background-report-error", {
        participantId: participant.id,
        error: errorText(error)
      });
    }
  }

  /** Mirrors the CLI's background-task bookkeeping from its `system` events
   *  (verified on Claude Code 2.1.257 and 2.1.280): `task_started` (with
   *  `is_backgrounded`) registers a task, `background_tasks_changed` is the
   *  authoritative list of live tasks, and `task_notification` reports one
   *  finished (`status` "completed", or "stopped" for a killed task). The tasks
   *  belong to the process: they outlive the reply that started them. */
  trackClaudeBackgroundTasks(
    record: Record<string, unknown>,
    subtype: string | undefined,
    state: ClaudeWarmProcessState,
    participant: ParticipantConfig
  ): void {
    if (subtype === "task_started" || subtype === "background_tasks_changed" || subtype === "task_notification") {
      state.lastTaskEventAt = Date.now();
    }
    if (subtype === "task_started") {
      const taskId = stringField(record, "task_id");
      if (taskId && record.is_backgrounded === true && !state.finishedTaskIds.has(taskId)) {
        const label = claudeBackgroundTaskLabel(stringField(record, "description") ?? taskId);
        state.backgroundTasks.set(taskId, label);
        state.backgroundTaskLabels.set(taskId, label);
        state.backgroundTaskOrigins.set(taskId, state.active?.origin ?? state.lastOrigin);
      }
      return;
    }
    if (subtype === "background_tasks_changed") {
      const live = new Map<string, string>();
      for (const task of Array.isArray(record.tasks) ? record.tasks : []) {
        const taskRecord = asRecord(task);
        const taskId = taskRecord ? stringField(taskRecord, "task_id") : undefined;
        if (!taskRecord || !taskId || state.finishedTaskIds.has(taskId)) {
          continue;
        }
        const label = claudeBackgroundTaskLabel(
          stringField(taskRecord, "description") ?? state.backgroundTaskLabels.get(taskId) ?? taskId
        );
        live.set(taskId, label);
        state.backgroundTaskLabels.set(taskId, label);
        if (!state.backgroundTaskOrigins.has(taskId)) {
          state.backgroundTaskOrigins.set(taskId, state.active?.origin ?? state.lastOrigin);
        }
      }
      state.backgroundTasks = live;
      // A finished task is remembered only to ignore a stale list that still
      // names it; once a list without it arrives, it can be forgotten.
      const listed = new Set((Array.isArray(record.tasks) ? record.tasks : [])
        .map((task) => stringField(asRecord(task) ?? {}, "task_id"))
        .filter((taskId): taskId is string => Boolean(taskId)));
      for (const taskId of Array.from(state.finishedTaskIds)) {
        if (!listed.has(taskId)) {
          state.finishedTaskIds.delete(taskId);
        }
      }
      return;
    }
    if (subtype !== "task_notification") {
      return;
    }
    const taskId = stringField(record, "task_id");
    const status = stringField(record, "status") ?? "stopped";
    const backgroundLabel = taskId ? state.backgroundTaskLabels.get(taskId) : undefined;
    const taskOrigin = taskId ? state.backgroundTaskOrigins.get(taskId) : undefined;
    if (taskId) {
      state.backgroundTasks.delete(taskId);
      state.backgroundTaskLabels.delete(taskId);
      state.backgroundTaskOrigins.delete(taskId);
      state.finishedTaskIds.add(taskId);
    }
    // The CLI also reports a long *foreground* command as a task
    // (`task_started` with is_backgrounded false, then a notification when it
    // ends). Its result reaches the model inline and its own tool activity is
    // already shown, so only a task the member put in the background gets a
    // "background task finished" row.
    if (backgroundLabel === undefined) {
      return;
    }
    const completed = status === "completed";
    const notice: CliAgentOutputEvent = {
      kind: "tool",
      text: `Background task ${completed ? "finished" : status}: ${backgroundLabel}\n`,
      activityKind: "status",
      activityStatus: completed ? "completed" : "failed"
    };
    if (state.stepActive && state.active && !state.active.settled && !state.active.localCommand) {
      // The running step receives the notification with its next tool result.
      emitLiveOutput(claudeWarmReplyOutput(state.active), notice.kind, notice.text, undefined, notice);
      return;
    }
    // The model is idle: the CLI is about to start a step of its own for this
    // notification, and the row belongs to the reply that step produces.
    state.pendingNotices.push(notice);
    state.idleOrigin = taskOrigin ?? state.idleOrigin;
    state.selfResumeExpectedUntil = Date.now() + CLAUDE_WARM_SELF_RESUME_EXPECTED_MS;
    void this.cli.cliRuns.writeDebugLog("cli-agent-claude-background-finished-idle", {
      participantId: participant.id,
      status,
      liveTasks: state.backgroundTasks.size
    });
  }

  /** The CLI sends at most one suggestion per ended reply, a few seconds after
   *  its result, and only while no new message has started a step. */
  deliverClaudePromptSuggestion(
    record: Record<string, unknown>,
    state: ClaudeWarmProcessState,
    participant: ParticipantConfig
  ): void {
    const target = state.promptSuggestionTarget;
    state.promptSuggestionTarget = undefined;
    const suggestion = stringField(record, "suggestion")?.trim();
    void this.cli.cliRuns.writeDebugLog("cli.claude.prompt-suggestion", {
      participantId: participant.id,
      delivered: Boolean(target && suggestion),
      chars: suggestion?.length ?? 0
    });
    if (!target || !suggestion) {
      return;
    }
    try {
      target(suggestion);
    } catch (error) {
      void this.cli.cliRuns.writeDebugLog("cli-agent-claude-prompt-suggestion-handler-failed", {
        participantId: participant.id,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
