import { memo, useState, type ReactNode } from "react";
import { ArrowBendUpLeftIcon, CaretDownIcon, CaretRightIcon, HammerIcon } from "@phosphor-icons/react";

import {
  SESSIONS_REPLIED_SUMMARY, SESSIONS_WORK_STATUS_LABELS, sessionsDelegationSummary, type SessionsReplyEntry, type SessionsTaskEntry, type SessionsWorkStatus
} from "../../../shared/mainSessionView";
import type { ChatParticipant, ChatProviderKind } from "../../../shared/types";
import { ChatProviderMark, ChatProviderMarkSlot } from "./chat-member-mark";
import { ChatElapsed } from "./chat-task-card";
import { formatWorkedDuration } from "./chat-worked-row";

/**
 * Every finished reply's "Worked for …" in the sessions view, T3 Code's quiet
 * way: muted text and a chevron, no pill. A main-session reply that gave tasks
 * folds them, as T3 Code shows a turn's sub-agents: one slim row per task (the
 * member's provider logo with a dot for its state, the task's title, one line
 * of its result, its time, a chevron into the member's session at that task);
 * while the reply is still being written the rows show under it, open. Any
 * other reply's fold opens its full stream, when it has one; without either
 * it is the muted text alone.
 */
export const ChatWorkedFold = memo(function ChatWorkedFold(props: {
  workedMs?: number;
  entries: readonly SessionsTaskEntry[];
  participants?: readonly ChatParticipant[];
  onOpenTask?: (entry: SessionsTaskEntry) => void;
  /** The reply's full stream, shown in place of its text while open; with
   *  `activity`, whether the fold is open. */
  stream?: { open: boolean; toggle: () => void };
  /** The rows its turn showed while it ran (ChatSessionsFinishedActivity),
   *  shown inside the fold, above its tasks, while it is open. */
  activity?: ReactNode;
}): JSX.Element {
  const [tasksOpen, setTasksOpen] = useState(false);
  const label = props.workedMs !== undefined ? `Worked for ${formatWorkedDuration(props.workedMs)}` : "Worked";
  const hasTasks = props.entries.length > 0;
  const stream = props.activity ? props.stream : undefined;
  const open = stream ? stream.open : hasTasks ? tasksOpen : Boolean(props.stream?.open);
  const toggle = stream ? stream.toggle : hasTasks ? () => setTasksOpen((current) => !current) : props.stream?.toggle;
  return (
    <div className={`chat-worked-fold ${open ? "is-open" : ""}`} data-testid="chat-worked-fold">
      {toggle ? (
        <button type="button" className="chat-worked-fold-toggle" aria-expanded={open} onClick={toggle}>
          <span>{label}</span>
          {open ? <CaretDownIcon size={14} aria-hidden /> : <CaretRightIcon size={14} aria-hidden />}
        </button>
      ) : (
        <span className="chat-worked-fold-toggle is-static">{label}</span>
      )}
      {open && stream && props.activity}
      {hasTasks && open && <ChatDelegationRows entries={props.entries} participants={props.participants} onOpenTask={props.onOpenTask} />}
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
          <HammerIcon size={13} aria-hidden />
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
  const { entry } = props;
  return (
    <ChatWorkRow
      testId="chat-delegation-row"
      participantId={entry.item.targetParticipantId}
      participant={props.participant}
      kind={entry.item.targetKind}
      row={entry}
      onClick={() => props.onOpen?.(entry)}
    />
  );
}

/** The main session's answers to members on the main timeline (the User,
 *  2026-11-27): "Replied" and a row per answer, as a turn's tasks are shown;
 *  a row opens the member's session at the answer. */
export const ChatRepliedRows = memo(function ChatRepliedRows(props: {
  entries: readonly SessionsReplyEntry[];
  participants?: readonly ChatParticipant[];
  onOpen?: (entry: SessionsReplyEntry) => void;
}): JSX.Element {
  return (
    <div className="chat-delegations chat-replies" data-testid="chat-replies">
      <div className="chat-delegations-summary">
        <ArrowBendUpLeftIcon size={13} aria-hidden />
        <span>{SESSIONS_REPLIED_SUMMARY}</span>
      </div>
      {props.entries.map((entry) => (
        <ChatWorkRow
          key={entry.messageId}
          testId="chat-reply-row"
          participantId={entry.participantId}
          participant={props.participants?.find((candidate) => candidate.id === entry.participantId)}
          kind={entry.kind}
          row={entry}
          onClick={() => props.onOpen?.(entry)}
        />
      ))}
    </div>
  );
});

/** One slim row of a turn's work: the member's provider logo with a dot for
 *  the state, the title, one line, the time, a chevron. */
function ChatWorkRow(props: {
  testId: string;
  participantId: string;
  participant?: ChatParticipant;
  kind?: ChatProviderKind;
  row: { title: string; status: Exclude<SessionsWorkStatus, "idle">; line?: string; lineMuted?: true; since?: string; durationMs?: number };
  onClick: () => void;
}): JSX.Element {
  const { row, participant } = props;
  return (
    <button
      type="button"
      className="chat-delegation-row"
      data-testid={props.testId}
      data-participant-id={props.participantId}
      data-task-status={row.status}
      aria-label={`${row.title}: ${SESSIONS_WORK_STATUS_LABELS[row.status]}`}
      onClick={props.onClick}
    >
      <span className="chat-delegation-mark">
        {participant
          ? <ChatProviderMark member={participant} />
          : props.kind ? <ChatProviderMark member={{ kind: props.kind }} /> : <ChatProviderMarkSlot />}
        <span className={`chat-delegation-dot is-${row.status}`} aria-hidden="true" />
      </span>
      <span className="chat-delegation-text">
        <strong className="chat-delegation-title">{row.title}</strong>
        {row.line && <span className={row.lineMuted ? "chat-delegation-line is-muted" : "chat-delegation-line"}>{row.line}</span>}
      </span>
      <span className="chat-delegation-time">
        {row.since
          ? <ChatElapsed className="chat-delegation-elapsed" since={row.since} />
          : row.durationMs !== undefined ? formatWorkedDuration(row.durationMs) : null}
      </span>
      <CaretRightIcon className="chat-delegation-chevron" size={15} aria-hidden />
    </button>
  );
}
