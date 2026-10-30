import { memo, useEffect, useMemo, useState } from "react";

import { MarkdownText } from "../content/markdown-text";
import type { ChatAgentActivityEvent } from "../../../shared/types";
import {
  chatActivityEventsForSegment,
  chatInlineTranscriptBlocks,
  chatInlineTranscriptParts,
  type ChatProcessingTranscriptView,
  type ChatTranscriptSegment
} from "../../../shared/processingTranscript";
import { activityGroupKey, ChatInlineActivityEvent, ChatInlineActivityGroup } from "./chat-inline-activity";
import type { ChatThinkingRow } from "./chat-conversation-progress";
import type { ChatActivityDisclosureState } from "./use-chat-activity-disclosure";

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
  activityDisclosure: ChatActivityDisclosureState;
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
        <StreamingMarkdownText
          activityDisclosure={props.activityDisclosure}
          content={props.content ?? ""}
          activityEvents={props.activityEvents ?? []}
        />
      )}
      {!hasContent && props.activityEvents && props.activityEvents.length > 0 && (
        <ChatInlineTranscript
          activityDisclosure={props.activityDisclosure}
          content=""
          activityEvents={props.activityEvents}
          liveTail
        />
      )}
      {!hasContent && activity && !props.activityEvents?.length && <div className="streaming-message-activity">{activity}</div>}
    </div>
  );
});

export const ChatInlineTranscript = memo(function ChatInlineTranscript(props: {
  activityDisclosure: ChatActivityDisclosureState;
  content: string;
  activityEvents: ChatAgentActivityEvent[];
  segment?: ChatTranscriptSegment;
  /** The run is still streaming and nothing follows this transcript, so a trailing activity group is in progress. */
  liveTail?: boolean;
}): JSX.Element | null {
  const blocks = chatInlineTranscriptBlocks(chatInlineTranscriptParts(props.content, props.activityEvents, props.segment));
  if (blocks.length === 0) {
    return null;
  }
  return (
    <div className="chat-inline-transcript">
      {blocks.map((block, index) => block.kind === "text" ? (
        <MarkdownText content={block.text} key={`text-${index}`} />
      ) : block.kind === "activity" ? (
        <ChatInlineActivityEvent activityDisclosure={props.activityDisclosure} event={block.event} key={block.event.id} />
      ) : (
        <ChatInlineActivityGroup
          activityDisclosure={props.activityDisclosure}
          events={block.events}
          live={Boolean(props.liveTail) && index === blocks.length - 1}
          key={activityGroupKey(block.events)}
        />
      ))}
    </div>
  );
});

export const ChatExpandedProcessingTranscript = memo(function ChatExpandedProcessingTranscript(props: {
  activityDisclosure: ChatActivityDisclosureState;
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
            <ChatInlineTranscript
              activityDisclosure={props.activityDisclosure}
              content={segment.content}
              activityEvents={props.activityEvents}
              segment={segment}
              key={segment.key}
            />
          ))}
        </div>
      )}
      {props.view.renderFinalContent && props.view.finalSegment && (
        chatActivityEventsForSegment(props.activityEvents, props.view.finalSegment).length > 0 ? (
          <ChatInlineTranscript
            activityDisclosure={props.activityDisclosure}
            content={props.view.finalSegment.content}
            activityEvents={props.activityEvents}
            segment={props.view.finalSegment}
          />
        ) : (
          <MarkdownText content={props.view.finalSegment.content} />
        )
      )}
    </>
  );
});

const StreamingMarkdownText = memo(function StreamingMarkdownText(props: {
  activityDisclosure: ChatActivityDisclosureState;
  content: string;
  activityEvents: ChatAgentActivityEvent[];
}): JSX.Element {
  const { activityEvents, content } = props;
  const { completed, tail, tailOffset } = useMemo(() => splitStreamingMarkdown(content), [content]);
  // Activities before the first character of the paragraph in progress belong with the
  // completed text: they sit in the same place on screen and are usually the same run, which
  // must stay one line rather than split at the paragraph break.
  const { completedEvents, tailEvents } = useMemo(() => {
    const leadEnd = tail.search(/\S/);
    const bound = tailOffset + (leadEnd < 0 ? tail.length : leadEnd);
    return {
      completedEvents: activityEvents.filter((event) => (event.afterContentLength ?? 0) <= bound),
      tailEvents: activityEvents
        .filter((event) => (event.afterContentLength ?? 0) > bound)
        .map((event) => ({ ...event, afterContentLength: (event.afterContentLength ?? 0) - tailOffset }))
    };
  }, [activityEvents, tail, tailOffset]);
  const showTail = Boolean(tail.trim()) || tailEvents.length > 0;
  return (
    <div className="streaming-message-text">
      {(completed || completedEvents.length > 0) && (
        <ChatInlineTranscript
          activityDisclosure={props.activityDisclosure}
          content={completed}
          activityEvents={completedEvents}
          liveTail={!showTail}
        />
      )}
      {showTail && (
        <StreamingTailTranscript
          activityDisclosure={props.activityDisclosure}
          content={tail}
          activityEvents={tailEvents}
        />
      )}
      {!showTail && <span className="streaming-caret" aria-hidden="true" />}
    </div>
  );
});

const StreamingTailTranscript = memo(function StreamingTailTranscript(props: {
  activityDisclosure: ChatActivityDisclosureState;
  content: string;
  activityEvents: ChatAgentActivityEvent[];
  segment?: ChatTranscriptSegment;
}): JSX.Element {
  const blocks = chatInlineTranscriptBlocks(chatInlineTranscriptParts(props.content, props.activityEvents, props.segment));
  const lastBlock = blocks[blocks.length - 1];
  return (
    <div className="streaming-tail-transcript">
      {blocks.map((block, index) => block.kind === "text" ? (
        <div className="streaming-message-tail" key={`text-${index}`}>
          {block.text}
          {index === blocks.length - 1 && <span className="streaming-caret" aria-hidden="true" />}
        </div>
      ) : block.kind === "activity" ? (
        <ChatInlineActivityEvent activityDisclosure={props.activityDisclosure} event={block.event} key={block.event.id} />
      ) : (
        <ChatInlineActivityGroup
          activityDisclosure={props.activityDisclosure}
          events={block.events}
          live={index === blocks.length - 1}
          key={activityGroupKey(block.events)}
        />
      ))}
      {lastBlock?.kind !== "text" && <span className="streaming-caret" aria-hidden="true" />}
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

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function useStreamingElapsedSeconds(startedAt: string): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = globalThis.setInterval(() => setNow(Date.now()), 1000);
    const nodeTimer = handle as unknown as { unref?: () => void };
    nodeTimer.unref?.();
    return () => globalThis.clearInterval(handle);
  }, []);
  const startMs = new Date(startedAt).getTime();
  return Math.max(0, Math.floor((now - startMs) / 1000));
}
