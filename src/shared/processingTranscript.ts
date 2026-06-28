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
  const events = (segment ? chatActivityEventsForSegment(activityEvents, segment) : [...activityEvents]).map((event) => ({
    ...event,
    afterContentLength: snapActivityOffset(normalized, activityEventOffset(event, normalized.length))
  })).sort((left, right) => {
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

function snapActivityOffset(content: string, offset: number): number {
  const normalizedOffset = Math.max(0, Math.min(offset, content.length));
  if (normalizedOffset === 0) {
    return 0;
  }
  if (normalizedOffset >= content.length || chatTextEndsAtSentenceOrParagraphBoundary(content.slice(0, normalizedOffset))) {
    return normalizedOffset;
  }
  for (let index = normalizedOffset; index < content.length; index += 1) {
    if (content[index] === "\n" && content[index + 1] === "\n") {
      return index;
    }
    const sentenceEnd = sentenceBoundaryEndAt(content, index);
    if (sentenceEnd !== undefined) {
      return sentenceEnd;
    }
  }
  return content.length;
}

export function chatTextEndsAtSentenceOrParagraphBoundary(text: string): boolean {
  const normalized = text.replace(/\r\n/g, "\n").replace(/[ \t\f\v]+$/g, "");
  if (!normalized) {
    return false;
  }
  if (/[\r\n]$/.test(normalized)) {
    return true;
  }
  for (let index = 0; index < normalized.length; index += 1) {
    if (sentenceBoundaryEndAt(normalized, index) === normalized.length) {
      return true;
    }
  }
  return false;
}

function sentenceBoundaryEndAt(content: string, punctuationIndex: number): number | undefined {
  if (!/[.!?:]/.test(content[punctuationIndex] ?? "")) {
    return undefined;
  }
  let end = consumeClosingBoundaryChars(content, punctuationIndex + 1);
  if (content[end] === " " && content[end + 1] === "(") {
    const parentheticalEnd = content.indexOf(")", end + 2);
    if (parentheticalEnd > end + 2) {
      const afterParenthetical = consumeClosingBoundaryChars(content, parentheticalEnd + 1);
      if (afterParenthetical >= content.length || /\s/.test(content[afterParenthetical])) {
        return afterParenthetical;
      }
    }
  }
  if (end >= content.length || /\s/.test(content[end])) {
    return end;
  }
  return undefined;
}

function consumeClosingBoundaryChars(content: string, start: number): number {
  let cursor = start;
  while (/["')\]}”’]/.test(content[cursor] ?? "")) {
    cursor += 1;
  }
  return cursor;
}
