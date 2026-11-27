import type {
  ChatAgentActivityEvent, ChatMessage, ChatMessageMetadata, ChatParticipant, ChatProcessingTranscript, Conversation,
  ReviewProgress
} from "../../../../shared/types";
import type { CliAgentOutputEvent, CliAgentReplyStart } from "../../cliAgents";
import { sanitizeWarningText } from "../../../../shared/warnings";
import { markStopUnconfirmed, markStoppedByUser } from "../../machineTurnOutcome";
import { capChatActivityEvents, withinActivityDetailsBudget } from "../store/mergeStoredChat";
import type { ChatActivityAccumulator } from "./types";
import type { ProgressCallback } from "../types";

const CHAT_PROCESSING_TRANSCRIPT_MAX_CHARS = 2_000_000;
const CHAT_ACTIVITY_DETAIL_MAX_CHARS = 4_000;

/** A row's label is one line; what a CLI hands over as one is kept to this
 *  (the tool rows themselves are shorter: cliToolActivity.ts). */
const CHAT_ACTIVITY_LABEL_MAX_CHARS = 1_000;

export function abortReasonError(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(typeof signal.reason === "string" && signal.reason.trim() ? signal.reason : fallback);
}

/**
 * A Claude Code member's CLI started a reply's message (see
 * ParticipantTurnReservation.behindMemberTurn): when its turn starts. One
 * that was queued starts now; one handed to the step that was running
 * continues that step's work, so, like the CLI's one spinner, its "Working
 * for …" (and its "Worked for …") count from that step's start, not from the
 * User's message: one turn, one clock. Undefined when nothing changes.
 */
export function cliStartedReplyStart(conversation: Conversation, reply: ChatMessage, start: CliAgentReplyStart | undefined): { turnStartedAt?: string } | undefined {
  const joinedId = start?.joinedReply?.messageId;
  const joined = joinedId ? conversation.messages.find((message) => message.id === joinedId) : undefined;
  // The joined reply's own start when this copy of the chat has it; its
  // sending time when it started at once (never queued); else when its CLI
  // says the step began (that reply's start may be on another copy still).
  const joinedQueued = Boolean(joined?.metadata?.queuedBehind || joined?.metadata?.turnQueued);
  const cliStepStart = start?.joinedStepStartedAt !== undefined && Number.isFinite(start.joinedStepStartedAt)
    ? new Date(start.joinedStepStartedAt).toISOString()
    : undefined;
  const stepStartedAt = joined?.metadata?.turnStartedAt ?? (joined && !joinedQueued ? joined.createdAt : undefined) ?? cliStepStart;
  const wasQueued = Boolean(reply.metadata?.queuedBehind || reply.metadata?.turnQueued);
  if (stepStartedAt) return { turnStartedAt: stepStartedAt };
  return wasQueued ? { turnStartedAt: new Date().toISOString() } : undefined;
}

export function withCliStartedReplyStart(metadata: ChatMessageMetadata | undefined, started: { turnStartedAt?: string }): ChatMessageMetadata {
  const next: ChatMessageMetadata = { ...metadata };
  delete next.queuedBehind;
  delete next.turnQueued;
  if (started.turnStartedAt) next.turnStartedAt = started.turnStartedAt;
  return next;
}

export function failedPrecreatedPendingMessageContent(participant: ChatParticipant, error: unknown): string {
  const diagnostic = sanitizeWarningText(error instanceof Error ? error.message : String(error));
  return diagnostic
    ? `@${participant.handle} run failed before a response was produced: ${diagnostic}`
    : `@${participant.handle} run failed before a response was produced.`;
}

export function markParticipantMessageStoppedByUser(
  message: ChatMessage,
  participant: ChatParticipant,
  options: { preserveContent?: boolean } = {}
): void {
  markStoppedByUser(message, participant.handle, options);
}

/** Send now cut this reply short for the message waiting behind it (the CLI's
 *  send-now): it keeps what it wrote, and the member's turn goes on in that
 *  message's reply, as when the CLI hands a message to the running step. It
 *  was not stopped: no "stopped by user". */
export function markParticipantMessageSentNow(message: ChatMessage): void {
  message.status = "done";
  const { workedMs: _workedMs, ...metadata } = message.metadata ?? {};
  message.metadata = { ...metadata, turnContinues: true };
}

/** Rule 2 (docs/parity-requirements.md): a Stop the member's machine never
 *  confirmed is shown as exactly that, never as "stopped by user". */
export function markParticipantMessageStopUnconfirmed(message: ChatMessage, participant: ChatParticipant, reason?: string): void {
  markStopUnconfirmed(message, participant.handle, reason);
}

export function emitChatRunFailure(runId: string, progress: ProgressCallback | undefined, error: unknown): void {
  emitProgress(runId, progress, "error", error instanceof Error ? error.message : String(error));
}

export function appendChatActivity(
  runId: string,
  current: ChatActivityAccumulator,
  event: CliAgentOutputEvent,
  options: { createdAt?: string; afterContentLength?: number } = {}
): ChatActivityAccumulator {
  const fullLabel = event.text.trim().replace(/\s+/g, " ");
  if (!fullLabel) {
    return current;
  }
  const label = fullLabel.length > CHAT_ACTIVITY_LABEL_MAX_CHARS
    ? `${fullLabel.slice(0, CHAT_ACTIVITY_LABEL_MAX_CHARS - 1).trimEnd()}…`
    : fullLabel;
  const itemId = event.activityItemId?.trim() || undefined;
  const detail = chatActivityDetail(event.activityDetail);
  if (itemId) {
    const existingIndex = current.events.findIndex((activityEvent) => activityEvent.itemId === itemId);
    if (existingIndex >= 0) {
      const existing = current.events[existingIndex];
      // A step's words can change as it ends, as in its CLI ("Running
      // npm test", then "Ran npm test").
      const nextEvent: ChatAgentActivityEvent = {
        ...existing,
        label,
        detail: detail ?? existing.detail,
        status: event.activityStatus ?? existing.status
      };
      if (nextEvent.label === existing.label && nextEvent.detail === existing.detail && nextEvent.status === existing.status && label === current.label) {
        return current;
      }
      const events = [...current.events];
      events[existingIndex] = nextEvent;
      return {
        events: withinActivityDetailsBudget(events),
        sequence: current.sequence,
        label,
        omittedCount: current.omittedCount
      };
    }
  }
  const sequence = current.sequence + 1;
  const nextEvent: ChatAgentActivityEvent = {
    id: `${runId}:activity:${sequence}`,
    sequence,
    ...(itemId ? { itemId } : {}),
    kind: event.activityKind ?? "tool",
    label,
    detail,
    createdAt: options.createdAt ?? new Date().toISOString(),
    status: event.activityStatus ?? "started",
    afterContentLength: options.afterContentLength
  };
  const capped = capChatActivityEvents([...current.events, nextEvent]);
  return {
    events: capped.events,
    sequence,
    label,
    omittedCount: Math.max(current.omittedCount + capped.dropped, sequence - capped.events.length)
  };
}

function chatActivityDetail(value: string | undefined): string | undefined {
  const detail = value?.trim();
  if (!detail) {
    return undefined;
  }
  if (detail.length <= CHAT_ACTIVITY_DETAIL_MAX_CHARS) {
    return detail;
  }
  let keep = CHAT_ACTIVITY_DETAIL_MAX_CHARS;
  let omitted = detail.length - keep;
  let marker = `… [+${omitted} chars omitted]`;
  while (keep + marker.length > CHAT_ACTIVITY_DETAIL_MAX_CHARS) {
    keep = Math.max(0, CHAT_ACTIVITY_DETAIL_MAX_CHARS - marker.length);
    omitted = detail.length - keep;
    marker = `… [+${omitted} chars omitted]`;
  }
  return `${detail.slice(0, keep)}${marker}`;
}

export function processingTranscriptFromContent(
  content: string,
  capturedAt: string,
  options: { omittedActivityEventCount?: number } = {}
): ChatProcessingTranscript | undefined {
  const normalized = content.replace(/\r\n/g, "\n").trimEnd();
  const omittedActivityEventCount = options.omittedActivityEventCount && options.omittedActivityEventCount > 0
    ? options.omittedActivityEventCount
    : undefined;
  if (!normalized.trim() && !omittedActivityEventCount) {
    return undefined;
  }
  const originalLength = normalized.length;
  const retainedStart = Math.max(0, originalLength - CHAT_PROCESSING_TRANSCRIPT_MAX_CHARS);
  const retained = retainedStart > 0 ? normalized.slice(retainedStart) : normalized;
  return {
    content: retained,
    capturedAt,
    originalLength,
    ...(retainedStart > 0 ? { retainedStart, truncated: true } : {}),
    ...(omittedActivityEventCount ? { omittedActivityEventCount } : {})
  };
}

export function processingTranscriptWithTerminalMessage(
  transcript: ChatProcessingTranscript,
  terminalMessage: string
): ChatProcessingTranscript {
  const terminal = terminalMessage.replace(/\r\n/g, "\n").trim();
  if (!terminal || transcript.content.trimEnd().endsWith(terminal)) {
    return transcript;
  }
  const retainedBase = transcript.content.trimEnd();
  const trimmedChars = transcript.content.length - retainedBase.length;
  const appended = `\n\n${terminal}`;
  let content = `${retainedBase}${appended}`;
  let retainedStart = transcript.retainedStart;
  let truncated = transcript.truncated;
  if (content.length > CHAT_PROCESSING_TRANSCRIPT_MAX_CHARS) {
    const overflow = content.length - CHAT_PROCESSING_TRANSCRIPT_MAX_CHARS;
    content = content.slice(overflow);
    retainedStart = (retainedStart ?? 0) + overflow;
    truncated = true;
  }
  return {
    ...transcript,
    content,
    originalLength: Math.max(0, transcript.originalLength - trimmedChars) + appended.length,
    retainedStart,
    truncated
  };
}

export function emitProgress(
  runId: string,
  progress: ProgressCallback | undefined,
  phase: ReviewProgress["phase"],
  message: string,
  details: Partial<Omit<ReviewProgress, "runId" | "phase" | "message" | "createdAt">> = {}
): void {
  progress?.({
    runId,
    phase,
    message,
    createdAt: new Date().toISOString(),
    ...details
  });
}
