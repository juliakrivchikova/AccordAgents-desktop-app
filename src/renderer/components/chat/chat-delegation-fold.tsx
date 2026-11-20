import { memo, useState } from "react";
import { ChevronDown, ChevronRight, Hammer } from "lucide-react";

import { SESSIONS_WORK_STATUS_LABELS, sessionsDelegationSummary, type SessionsTaskEntry } from "../../../shared/mainSessionView";
import type { ChatParticipant } from "../../../shared/types";
import { ChatProviderMark } from "./chat-member-mark";
import { ChatElapsed } from "./chat-task-card";
import { formatWorkedDuration } from "./chat-worked-row";

/**
 * The main session's delegations in the sessions view, as T3 Code shows a
 * turn's sub-agents: inside its reply's "Worked for …" fold, one slim row per
 * task (the member's provider logo with a dot for its state, the task's
 * title, one line of its result, its time, a chevron into the member's
 * session at that task). While the reply is still being written the rows
 * show under it, open.
 */
export const ChatWorkedFold = memo(function ChatWorkedFold(props: {
  workedMs?: number;
  entries: readonly SessionsTaskEntry[];
  participants?: readonly ChatParticipant[];
  onOpenTask?: (entry: SessionsTaskEntry) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const label = props.workedMs !== undefined ? `Worked for ${formatWorkedDuration(props.workedMs)}` : "Worked";
  return (
    <div className={`chat-worked-fold ${open ? "is-open" : ""}`} data-testid="chat-worked-fold">
      <button type="button" className="chat-worked-fold-toggle" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <span>{label}</span>
        {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
      </button>
      {open && <ChatDelegationRows entries={props.entries} participants={props.participants} onOpenTask={props.onOpenTask} />}
    </div>
  );
});

/** The summary line and one row per task. */
export const ChatDelegationRows = memo(function ChatDelegationRows(props: {
  entries: readonly SessionsTaskEntry[];
  participants?: readonly ChatParticipant[];
  onOpenTask?: (entry: SessionsTaskEntry) => void;
  /** Without its summary line (a task shown on its own). */
  bare?: boolean;
}): JSX.Element {
  return (
    <div className="chat-delegations" data-testid="chat-delegations">
      {!props.bare && (
        <div className="chat-delegations-summary">
          <Hammer size={13} aria-hidden />
          <span>{sessionsDelegationSummary(props.entries.length)}</span>
        </div>
      )}
      {props.entries.map((entry) => (
        <ChatDelegationRow
          key={`${entry.messageId}:${entry.item.targetParticipantId}`}
          entry={entry}
          participant={props.participants?.find((candidate) => candidate.id === entry.item.targetParticipantId)}
          onOpen={props.onOpenTask}
        />
      ))}
    </div>
  );
});

function ChatDelegationRow(props: {
  entry: SessionsTaskEntry;
  participant?: ChatParticipant;
  onOpen?: (entry: SessionsTaskEntry) => void;
}): JSX.Element {
  const { entry, participant } = props;
  return (
    <button
      type="button"
      className="chat-delegation-row"
      data-testid="chat-delegation-row"
      data-participant-id={entry.item.targetParticipantId}
      data-task-status={entry.status}
      aria-label={`${entry.title}: ${SESSIONS_WORK_STATUS_LABELS[entry.status]}`}
      onClick={() => props.onOpen?.(entry)}
    >
      <span className="chat-delegation-mark">
        {participant ? <ChatProviderMark member={participant} /> : <span className="chat-provider-icon" aria-hidden="true" />}
        <span className={`chat-delegation-dot is-${entry.status}`} aria-hidden="true" />
      </span>
      <span className="chat-delegation-text">
        <strong className="chat-delegation-title">{entry.title}</strong>
        {entry.line && <span className="chat-delegation-line">{entry.line}</span>}
      </span>
      <span className="chat-delegation-time">
        {entry.since
          ? <ChatElapsed className="chat-delegation-elapsed" since={entry.since} />
          : entry.durationMs !== undefined ? formatWorkedDuration(entry.durationMs) : null}
      </span>
      <ChevronRight className="chat-delegation-chevron" size={15} aria-hidden />
    </button>
  );
}
