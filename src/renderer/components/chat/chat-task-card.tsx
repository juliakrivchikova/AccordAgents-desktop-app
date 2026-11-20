import { SESSIONS_WORK_STATUS_LABELS, type SessionsWorkStatus } from "../../../shared/mainSessionView";
import { useStreamingElapsedSeconds } from "./chat-streaming";
import { formatWorkedDuration } from "./chat-worked-row";

/** A running time that counts up every second, like a streaming reply's. */
export function ChatElapsed(props: { since: string; className?: string }): JSX.Element {
  const seconds = useStreamingElapsedSeconds(props.since);
  return <span className={props.className ?? "chat-elapsed"}>{formatWorkedDuration(seconds * 1000)}</span>;
}

export function ChatWorkStatusLabel(props: { status: SessionsWorkStatus }): JSX.Element {
  return (
    <span className={`chat-work-status is-${props.status}`} data-work-status={props.status}>
      <span className="chat-work-status-dot" aria-hidden="true" />
      {SESSIONS_WORK_STATUS_LABELS[props.status]}
    </span>
  );
}
