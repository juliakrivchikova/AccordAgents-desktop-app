import { memo, useEffect, useMemo, useState } from "react";
import { ChevronRight, FilePenLine, Globe, ShieldCheck, Terminal, type LucideIcon } from "lucide-react";

import { MarkdownText } from "../content/markdown-text";
import type { ChatAgentActivityEvent, ChatAgentActivityKind } from "../../../shared/types";
import {
  chatActivityEventsForSegment,
  chatInlineTranscriptParts,
  type ChatProcessingTranscriptView,
  type ChatTranscriptSegment
} from "../../../shared/processingTranscript";
import type { ChatThinkingRow } from "./chat-conversation-data";

export const ChatThinkingRowItem = memo(function ChatThinkingRowItem({ row }: { row: ChatThinkingRow }): JSX.Element {
  return (
    <div className="chat-thinking-row" aria-live="polite">
      <div className="chat-thinking-primary">
        <strong>{row.participantLabel}</strong>
        <span className="streaming-status-label">Thinking</span>
      </div>
      {row.activity && <div className="chat-thinking-activity">{row.activity}</div>}
    </div>
  );
});

export const StreamingMessageContent = memo(function StreamingMessageContent(props: {
  content?: string;
  activity?: string;
  activityEvents?: ChatAgentActivityEvent[];
  statusLabel?: string;
  startedAt: string;
}): JSX.Element {
  const elapsedSeconds = useStreamingElapsedSeconds(props.startedAt);
  const hasContent = Boolean(props.content?.trim());
  const statusLabel = props.statusLabel ?? (hasContent ? "Responding" : "Thinking");
  const activity = props.activity && props.activity !== statusLabel ? props.activity : undefined;
  return (
    <div className="streaming-message-content" aria-live="polite">
      <div className={`streaming-message-thinking ${hasContent ? "is-compact" : ""}`}>
        <span className="streaming-status-label">{statusLabel}</span>
        <span className="streaming-message-elapsed">{formatElapsed(elapsedSeconds)}</span>
      </div>
      {hasContent && (
        <StreamingMarkdownText content={props.content ?? ""} activityEvents={props.activityEvents ?? []} />
      )}
      {!hasContent && props.activityEvents && props.activityEvents.length > 0 && (
        <ChatInlineTranscript content="" activityEvents={props.activityEvents} />
      )}
      {!hasContent && activity && !props.activityEvents?.length && <div className="streaming-message-activity">{activity}</div>}
    </div>
  );
});

export const ChatInlineTranscript = memo(function ChatInlineTranscript(props: {
  content: string;
  activityEvents: ChatAgentActivityEvent[];
  segment?: ChatTranscriptSegment;
}): JSX.Element | null {
  const parts = chatInlineTranscriptParts(props.content, props.activityEvents, props.segment);
  if (parts.length === 0) {
    return null;
  }
  return (
    <div className="chat-inline-transcript">
      {parts.map((part, index) => part.kind === "text" ? (
        part.text.trim() ? <MarkdownText content={part.text} key={`text-${index}`} /> : null
      ) : (
        <ChatInlineActivityEvent event={part.event} key={part.event.id} />
      ))}
    </div>
  );
});

export const ChatExpandedProcessingTranscript = memo(function ChatExpandedProcessingTranscript(props: {
  view: ChatProcessingTranscriptView;
  activityEvents: ChatAgentActivityEvent[];
}): JSX.Element {
  return (
    <>
      {props.view.notices.length > 0 && (
        <div className="chat-processing-transcript-notices">
          {props.view.notices.map((notice) => <span key={notice}>{notice}</span>)}
        </div>
      )}
      {props.view.leadingSegments.length > 0 && (
        <div className="chat-processing-expanded-prefix">
          {props.view.leadingSegments.map((segment) => (
            <ChatInlineTranscript content={segment.content} activityEvents={props.activityEvents} segment={segment} key={segment.key} />
          ))}
        </div>
      )}
      {props.view.renderFinalContent && props.view.finalSegment && (
        chatActivityEventsForSegment(props.activityEvents, props.view.finalSegment).length > 0 ? (
          <ChatInlineTranscript content={props.view.finalSegment.content} activityEvents={props.activityEvents} segment={props.view.finalSegment} />
        ) : (
          <MarkdownText content={props.view.finalSegment.content} />
        )
      )}
    </>
  );
});

function ChatInlineActivityEvent({ event }: { event: ChatAgentActivityEvent }): JSX.Element {
  const Icon = iconForActivityKind(event.kind);
  return (
    <div className={`chat-inline-activity-event is-${event.kind}`} title={event.detail ?? event.label}>
      <Icon size={14} aria-hidden />
      <span>{event.label}</span>
    </div>
  );
}

const StreamingMarkdownText = memo(function StreamingMarkdownText({ content, activityEvents }: { content: string; activityEvents: ChatAgentActivityEvent[] }): JSX.Element {
  const { completed, tail, tailOffset } = useMemo(() => splitStreamingMarkdown(content), [content]);
  const completedSegment = useMemo<ChatTranscriptSegment>(() => ({
    key: "prefix",
    content: completed,
    startOffset: 0,
    endOffset: tailOffset
  }), [completed, tailOffset]);
  const tailSegment = useMemo<ChatTranscriptSegment>(() => ({
    key: "full",
    content: tail,
    startOffset: tailOffset,
    endOffset: content.replace(/\r\n/g, "\n").length
  }), [content, tail, tailOffset]);
  return (
    <div className="streaming-message-text">
      {(completed || chatActivityEventsForSegment(activityEvents, completedSegment).length > 0) && (
        <ChatInlineTranscript content={completed} activityEvents={activityEvents} segment={completedSegment} />
      )}
      {tail && <StreamingTailTranscript content={tail} activityEvents={activityEvents} segment={tailSegment} />}
      {!tail && <span className="streaming-caret" aria-hidden="true" />}
    </div>
  );
});

const StreamingTailTranscript = memo(function StreamingTailTranscript(props: {
  content: string;
  activityEvents: ChatAgentActivityEvent[];
  segment: ChatTranscriptSegment;
}): JSX.Element {
  const parts = chatInlineTranscriptParts(props.content, props.activityEvents, props.segment);
  const lastPart = parts[parts.length - 1];
  return (
    <div className="streaming-tail-transcript">
      {parts.map((part, index) => part.kind === "text" ? (
        <div className="streaming-message-tail" key={`text-${index}`}>
          {part.text}
          {index === parts.length - 1 && <span className="streaming-caret" aria-hidden="true" />}
        </div>
      ) : (
        <ChatInlineActivityEvent event={part.event} key={part.event.id} />
      ))}
      {lastPart?.kind === "activity" && <span className="streaming-caret" aria-hidden="true" />}
    </div>
  );
});

function splitStreamingMarkdown(content: string): { completed: string; tail: string; tailOffset: number } {
  const normalized = content.replace(/\r\n/g, "\n");
  const splitIndex = normalized.lastIndexOf("\n\n");
  if (splitIndex < 0) {
    return { completed: "", tail: normalized, tailOffset: 0 };
  }
  let tailOffset = splitIndex + 2;
  while (normalized[tailOffset] === "\n") {
    tailOffset += 1;
  }
  return {
    completed: normalized.slice(0, splitIndex).trimEnd(),
    tail: normalized.slice(tailOffset),
    tailOffset
  };
}

function iconForActivityKind(kind: ChatAgentActivityKind): LucideIcon {
  if (kind === "command") {
    return Terminal;
  }
  if (kind === "file-edit") {
    return FilePenLine;
  }
  if (kind === "web") {
    return Globe;
  }
  if (kind === "approval") {
    return ShieldCheck;
  }
  return ChevronRight;
}

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function useStreamingElapsedSeconds(startedAt: string): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, []);
  const startMs = new Date(startedAt).getTime();
  return Math.max(0, Math.floor((now - startMs) / 1000));
}
