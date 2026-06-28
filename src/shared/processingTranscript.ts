import type { ChatAgentActivityEvent } from "./types";

export interface ChatTranscriptSegment {
  key: "prefix" | "final" | "full";
  content: string;
  startOffset: number;
  endOffset: number;
}

export interface ChatProcessingTranscriptView {
  leadingSegments: ChatTranscriptSegment[];
  finalSegment?: ChatTranscriptSegment;
  renderFinalContent: boolean;
  notices: string[];
}

export type ChatInlineTranscriptPart =
  | { kind: "text"; text: string }
  | { kind: "activity"; event: ChatAgentActivityEvent };

export function chatProcessingTranscriptPrefix(transcriptContent: string, finalContent: string): string {
  const transcript = normalizeComparableText(transcriptContent);
  const final = normalizeComparableText(finalContent);
  if (!transcript || !final || transcript === final || !transcript.endsWith(final)) {
    return "";
  }
  return transcript.slice(0, transcript.length - final.length).trimEnd();
}

export function chatProcessingTranscriptView(
  transcriptContent: string | undefined,
  finalContent: string,
  options: {
    retainedStart?: number;
    truncated?: boolean;
    omittedActivityEventCount?: number;
  } = {}
): ChatProcessingTranscriptView {
  const transcript = normalizeComparableText(transcriptContent ?? "");
  const final = normalizeComparableText(finalContent);
  const retainedStart = Math.max(0, options.retainedStart ?? 0);
  const notices = transcriptNotices(options);
  if (!transcript || !final || transcript === final) {
    return {
      leadingSegments: [],
      finalSegment: final ? {
        key: "final",
        content: finalContent,
        startOffset: retainedStart,
        endOffset: retainedStart + transcript.length
      } : undefined,
      renderFinalContent: true,
      notices
    };
  }
  if (!transcript.endsWith(final)) {
    return {
      leadingSegments: [{
        key: "full",
        content: transcriptContent ?? "",
        startOffset: retainedStart,
        endOffset: retainedStart + transcript.length
      }],
      renderFinalContent: false,
      notices
    };
  }
  const finalStart = transcript.length - final.length;
  const prefixRaw = transcript.slice(0, finalStart);
  const prefix = prefixRaw.trimEnd();
  return {
    leadingSegments: prefix ? [{
      key: "prefix",
      content: prefix,
      startOffset: retainedStart,
      endOffset: retainedStart + prefixRaw.length
    }] : [],
    finalSegment: {
      key: "final",
      content: finalContent,
      startOffset: retainedStart + finalStart,
      endOffset: retainedStart + transcript.length
    },
    renderFinalContent: true,
    notices
  };
}

export function chatProcessingTranscriptViewHasHidden(view: ChatProcessingTranscriptView, activityEvents: ChatAgentActivityEvent[]): boolean {
  if (view.notices.length > 0) {
    return true;
  }
  if (view.leadingSegments.some((segment) => segment.content.trim() || chatActivityEventsForSegment(activityEvents, segment).length > 0)) {
    return true;
  }
  return Boolean(view.finalSegment && chatActivityEventsForSegment(activityEvents, view.finalSegment).length > 0);
}

export function chatActivityEventsForSegment(activityEvents: ChatAgentActivityEvent[], segment: ChatTranscriptSegment): ChatAgentActivityEvent[] {
  const contentLength = segment.content.replace(/\r\n/g, "\n").length;
  const events: ChatAgentActivityEvent[] = [];
  for (const event of activityEvents) {
    const rawOffset = event.afterContentLength ?? 0;
    if (rawOffset < segment.startOffset || rawOffset > segment.endOffset) {
      continue;
    }
    if (segment.key === "prefix" && rawOffset === segment.endOffset) {
      continue;
    }
    events.push({
        ...event,
        afterContentLength: Math.max(0, Math.min(rawOffset - segment.startOffset, contentLength))
    });
  }
  return events.sort((left, right) => {
    const offsetDelta = (left.afterContentLength ?? 0) - (right.afterContentLength ?? 0);
    return offsetDelta || left.sequence - right.sequence;
  });
}

export function chatInlineTranscriptParts(
  content: string,
  activityEvents: ChatAgentActivityEvent[],
  segment?: ChatTranscriptSegment
): ChatInlineTranscriptPart[] {
  const normalized = content.replace(/\r\n/g, "\n");
  const events = segment ? chatActivityEventsForSegment(activityEvents, segment) : [...activityEvents].sort((left, right) => {
    const offsetDelta = activityEventOffset(left, normalized.length) - activityEventOffset(right, normalized.length);
    return offsetDelta || left.sequence - right.sequence;
  });
  const parts: ChatInlineTranscriptPart[] = [];
  let cursor = 0;
  for (const event of events) {
    const offset = activityEventOffset(event, normalized.length);
    if (offset > cursor) {
      parts.push({ kind: "text", text: normalized.slice(cursor, offset) });
    }
    parts.push({ kind: "activity", event });
    cursor = Math.max(cursor, offset);
  }
  if (cursor < normalized.length) {
    parts.push({ kind: "text", text: normalized.slice(cursor) });
  }
  return parts;
}

function transcriptNotices(options: { truncated?: boolean; omittedActivityEventCount?: number }): string[] {
  const notices: string[] = [];
  if (options.truncated) {
    notices.push("Earlier stream output omitted.");
  }
  if (options.omittedActivityEventCount && options.omittedActivityEventCount > 0) {
    const count = options.omittedActivityEventCount;
    notices.push(`${count} earlier ${count === 1 ? "activity" : "activities"} omitted.`);
  }
  return notices;
}

function normalizeComparableText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function activityEventOffset(event: ChatAgentActivityEvent, contentLength: number): number {
  return Math.max(0, Math.min(event.afterContentLength ?? 0, contentLength));
}
