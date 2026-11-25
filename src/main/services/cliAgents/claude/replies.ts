import { randomUUID } from "node:crypto";
import { claudeContextWindowFromResult, claudeMainThreadContext } from "../../cliContextUsage";
import {
  CLAUDE_TOOLS_WITHOUT_ROW, claudeToolActivity, mcpServerToolPrefix, type ClaudeToolActivityContext, type CliToolActivity
} from "../../cliToolActivity";
import { CLAUDE_WARM_CANCELLED_MESSAGE } from "./constants";
import { extractClaudeStreamEventTextDelta, extractClaudeWarmAssistantText, extractClaudeWarmResultText } from "./output";
import type { ClaudeWarmProcessHooks, ClaudeWarmProcessState } from "./types";
import { finalTextFromMessageItems, textWithAgentMessageBoundary, trailingTextBlock } from "../codex/appServerText";
import { emitLiveOutput, reportSessionId } from "../runs/outputText";
import { asRecord, stringField } from "../runs/records";
import type { ClaudeWarmReply, CliAgentOutputCallback, CliAgentReplyStart, CliAgentWarmOptions } from "../types";

// Claude background tasks (Agent/Bash `run_in_background`) on the warm transport.
// Verified on Claude Code 2.1.257 and 2.1.280: the CLI resumes the model with
// the task notification on the same process, and kills its own tasks when stdin
// closes.
const CLAUDE_BACKGROUND_TASK_LABEL_MAX_CHARS = 160;

export function notifyClaudeReplyStarted(warm: CliAgentWarmOptions): void {
  try {
    warm.onReplyStarted?.();
  } catch {
    // An observer failure must not stop the run.
  }
}

export function noteClaudeWarmReplyIdentity(reply: ClaudeWarmReply, event: unknown, state: ClaudeWarmProcessState): void {
  reply.sessionId = state.sessionId ?? reply.sessionId;
  reportSessionId(reply.onSessionId, reply.sessionId);
  reply.model = state.model ?? reply.model;
  const context = claudeMainThreadContext(event);
  if (context) {
    reply.usedTokens = context.usedTokens;
    reply.contextModel = context.model ?? reply.contextModel;
  }
  reply.contextWindowTokens = claudeContextWindowFromResult(event, reply.contextModel ?? reply.model) ?? reply.contextWindowTokens;
}

/** Tool rows and text of the running step, streamed into its reply. */
export function applyClaudeWarmReplyEvent(reply: ClaudeWarmReply, event: unknown, toolContext: ClaudeToolActivityContext): void {
  const onOutput = claudeWarmReplyOutput(reply);
  emitClaudeToolRows(onOutput, event, toolContext);
  if (claudeWarmTextBlockStarted(event) && reply.streamedText.trim()) {
    reply.nextTextBlockStartsBlock = true;
  }
  const streamDelta = extractClaudeStreamEventTextDelta(event);
  if (streamDelta) {
    if (reply.nextTextBlockStartsBlock) {
      reply.streamedText = textWithAgentMessageBoundary(reply.streamedText, streamDelta);
      reply.nextTextBlockStartsBlock = false;
    }
    reply.streamedText += streamDelta;
    emitLiveOutput(onOutput, "text", streamDelta, reply.streamedText);
  }
  const assistantText = extractClaudeWarmAssistantText(event);
  if (assistantText) {
    reply.messages.push(assistantText);
  }
  reply.lastAssistantUuid = claudeAssistantMessageUuid(event) ?? reply.lastAssistantUuid;
}

/** The session's uuid of a top-level assistant message on the stream (the
 *  one Claude Code writes to the transcript and `--resume-session-at`
 *  takes); none for a subagent's. */
export function claudeAssistantMessageUuid(event: unknown): string | undefined {
  const record = asRecord(event);
  if (!record || stringField(record, "type") !== "assistant") return undefined;
  if (record.parent_tool_use_id !== undefined && record.parent_tool_use_id !== null) return undefined;
  return stringField(record, "uuid");
}

export function claudeWarmReplyOutput(reply: ClaudeWarmReply): CliAgentOutputCallback | undefined {
  return reply.settled ? undefined : reply.onOutput;
}

export function newClaudeWarmReply(fields: Partial<ClaudeWarmReply> & Pick<ClaudeWarmReply, "resolve" | "reject">): ClaudeWarmReply {
  return {
    written: false,
    started: false,
    settled: false,
    stopRequested: false,
    startedAt: Date.now(),
    messages: [],
    streamedText: "",
    nextTextBlockStartsBlock: false,
    resultEvents: [],
    allowEmptyContent: false,
    ...fields
  };
}

export function activateClaudeWarmReply(state: ClaudeWarmProcessState, reply: ClaudeWarmReply, start?: CliAgentReplyStart): void {
  reply.started = true;
  reply.stepStartedAt = start?.joinedStepStartedAt ?? Date.now();
  state.active = reply;
  try {
    reply.onStarted?.(start);
  } catch {
    // A failing observer must not stop the reply from being routed.
  }
  if (reply.localCommand) {
    // A command the CLI runs itself (`/compact`) never hands the model a
    // finished task's notification: the step the CLI starts for it after
    // the command still gets its row and the thread that started the task.
    return;
  }
  state.selfResumeExpectedUntil = 0;
  state.lastOrigin = reply.origin ?? state.lastOrigin;
  state.idleOrigin = undefined;
  const notices = state.pendingNotices.splice(0);
  const onOutput = claudeWarmReplyOutput(reply);
  for (const notice of notices) {
    onOutput?.(notice);
  }
}

export function handleClaudeWarmControlResponse(
  record: Record<string, unknown>,
  state: ClaudeWarmProcessState,
  hooks: ClaudeWarmProcessHooks
): void {
  const response = asRecord(record.response) ?? {};
  const requestId = stringField(response, "request_id");
  const waiter = requestId ? state.controlWaiters.get(requestId) : undefined;
  if (waiter) {
    waiter(response);
    return;
  }
  if (requestId && requestId === state.interruptRequestId) {
    // The CLI has taken the interrupt. With no step running it stopped
    // nothing, and must not be blamed for a later step's failure.
    state.interruptRequestId = undefined;
    if (!state.stepActive) {
      state.interruptTarget = undefined;
    }
    return;
  }
  const reply = requestId ? state.cancelRequests.get(requestId) : undefined;
  if (!requestId || !reply) {
    return;
  }
  state.cancelRequests.delete(requestId);
  const result = asRecord(response.response);
  if (stringField(response, "subtype") === "success" && result?.cancelled === true && !reply.settled && state.active !== reply) {
    removeClaudeWarmReply(state, reply);
    reply.reject(new Error(CLAUDE_WARM_CANCELLED_MESSAGE));
    hooks.settled();
    return;
  }
  // Otherwise the message was already taken: its `started` frame interrupts
  // it, however long the step ahead of it runs, so the acknowledgement
  // deadline (which would retire the whole process) no longer applies.
  if (reply.stopTimer && !reply.settled) {
    clearTimeout(reply.stopTimer);
    reply.stopTimer = undefined;
  }
}

export function sendClaudeWarmControl(hooks: ClaudeWarmProcessHooks, request: Record<string, unknown>): string {
  const requestId = `accord-${randomUUID()}`;
  hooks.write({ type: "control_request", request_id: requestId, request });
  return requestId;
}

export function removeClaudeWarmReply(state: ClaudeWarmProcessState, reply: ClaudeWarmReply): void {
  settleClaudeWarmReply(reply);
  state.replies = state.replies.filter((candidate) => candidate !== reply);
  for (const [requestId, candidate] of state.cancelRequests) {
    if (candidate === reply) {
      state.cancelRequests.delete(requestId);
    }
  }
}

export function settleClaudeWarmReply(reply: ClaudeWarmReply): void {
  reply.settled = true;
  if (reply.timer) {
    clearTimeout(reply.timer);
    reply.timer = undefined;
  }
  if (reply.stopTimer) {
    clearTimeout(reply.stopTimer);
    reply.stopTimer = undefined;
  }
  reply.detachSignal?.();
  reply.detachSignal = undefined;
  // A self-started reply keeps its buffered output until the app attaches,
  // even when the step was faster than the attachment.
}

export function claudeWarmSegmentText(reply: ClaudeWarmReply, event: unknown): string {
  const resultText = event === undefined ? undefined : extractClaudeWarmResultText(event);
  if (resultText !== undefined && !(reply.localCommand && !resultText.trim() && reply.messages.length > 0)) {
    return resultText;
  }
  if (reply.messages.length > 0) {
    return finalTextFromMessageItems(reply.messages);
  }
  return trailingTextBlock(reply.streamedText);
}

export function isClaudeWarmResult(event: unknown): boolean {
  return stringField(asRecord(event) ?? {}, "type") === "result";
}

/** Output only a running model step produces: its own text, its stream
 *  frames, and the tool results fed back into it. `system` events are not
 *  included — `init` states the step itself, and the rest (notifications,
 *  task bookkeeping) say nothing about whether one is running. */
export function claudeWarmEventShowsModelStep(eventType: string | undefined): boolean {
  return eventType === "assistant" || eventType === "stream_event" || eventType === "user";
}

/** Task descriptions are model-authored (for a Bash task, the raw command);
 *  keep the visible label one line and bounded. */
export function claudeBackgroundTaskLabel(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > CLAUDE_BACKGROUND_TASK_LABEL_MAX_CHARS
    ? `${collapsed.slice(0, CLAUDE_BACKGROUND_TASK_LABEL_MAX_CHARS - 1)}…`
    : collapsed;
}

export function claudeWarmTextBlockStarted(event: unknown): boolean {
  const record = asRecord(event);
  if (!record || stringField(record, "type") !== "stream_event") {
    return false;
  }
  const inner = asRecord(record.event);
  if (!inner || stringField(inner, "type") !== "content_block_start") {
    return false;
  }
  const block = asRecord(inner.content_block);
  return stringField(block ?? {}, "type") === "text";
}

/** One row per tool call of an assistant message (a subagent's too, as
 *  before), in the CLI's own words for it (cliToolActivity.ts), keyed by
 *  the call's id. */
export function emitClaudeToolRows(onOutput: CliAgentOutputCallback | undefined, event: unknown, toolContext: ClaudeToolActivityContext): void {
  for (const call of claudeToolCalls(event, toolContext)) {
    emitLiveOutput(onOutput, "tool", `${call.label}\n`, undefined, {
      activityKind: call.kind,
      activityStatus: "started",
      ...(call.detail ? { activityDetail: call.detail } : {}),
      ...(call.id ? { activityItemId: call.id } : {})
    });
  }
}

function claudeToolCalls(event: unknown, toolContext: ClaudeToolActivityContext): Array<CliToolActivity & { id?: string }> {
  const record = asRecord(event);
  if (!record) {
    return [];
  }
  const message = asRecord(record.message) ?? record;
  const content = message.content;
  if (!Array.isArray(content)) {
    return [];
  }
  const calls: Array<CliToolActivity & { id?: string }> = [];
  for (const block of content) {
    const blockRecord = asRecord(block);
    if (!blockRecord || stringField(blockRecord, "type") !== "tool_use") {
      continue;
    }
    const name = stringField(blockRecord, "name");
    if (name && !CLAUDE_TOOLS_WITHOUT_ROW.has(name)) {
      const id = stringField(blockRecord, "id");
      calls.push({ ...claudeToolActivity(name, asRecord(blockRecord.input), toolContext), ...(id ? { id } : {}) });
    }
  }
  return calls;
}

/** The session's folder and MCP servers from the CLI's `system/init`. */
export function noteClaudeToolContext(record: Record<string, unknown>, toolContext: ClaudeToolActivityContext): void {
  const cwd = stringField(record, "cwd");
  if (cwd) {
    toolContext.cwd = cwd;
  }
  if (Array.isArray(record.mcp_servers)) {
    const names = new Map<string, string>();
    for (const server of record.mcp_servers) {
      const name = stringField(asRecord(server) ?? {}, "name");
      if (name) {
        names.set(mcpServerToolPrefix(name), name);
      }
    }
    toolContext.mcpServerNames = names;
  }
}
