import { useEffect, useState } from "react";

import { LoadingDot } from "../primitives";
import type { ChatThinkingRow } from "./chat-conversation-data";

export function ChatThinkingRowItem({ row }: { row: ChatThinkingRow }): JSX.Element {
  return (
    <div className="chat-thinking-row" aria-live="polite">
      <div className="chat-thinking-primary">
        <strong>{row.participantLabel}</strong>
        <span>Thinking</span>
        <LoadingDot label="In progress" />
      </div>
      {row.activity && <div className="chat-thinking-activity">{row.activity}</div>}
    </div>
  );
}

export function StreamingMessageContent(props: {
  content?: string;
  activity?: string;
  startedAt: string;
}): JSX.Element {
  const elapsedSeconds = useStreamingElapsedSeconds(props.startedAt);
  const hasContent = Boolean(props.content && props.content.length > 0);
  return (
    <div className="streaming-message-content" aria-live="polite">
      <div className="streaming-message-thinking">
        <span>Thinking</span>
        <LoadingDot label="In progress" />
        <span className="streaming-message-elapsed">{formatElapsed(elapsedSeconds)}</span>
      </div>
      {hasContent && (
        <div className="streaming-message-text">
          {props.content}
          <span className="streaming-caret" aria-hidden="true" />
        </div>
      )}
      {props.activity && <div className="streaming-message-activity">{props.activity}</div>}
    </div>
  );
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
