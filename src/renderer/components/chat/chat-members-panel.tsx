import { useState } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";

import type { DockedAccord } from "../../../shared/accordProgress";
import { firstTextLine, memberRunningSince, sessionsTaskRunningSince, type SessionsMemberRow } from "../../../shared/mainSessionView";
import type { ChatMessage, ChatParticipant } from "../../../shared/types";
import { Button } from "@/components/ui/button";
import { chatParticipantDisplayName } from "../conversation/conversation-display";
import { IconButton } from "../primitives";
import { ChatAccordRow } from "./chat-accord-dock";
import { ChatProviderMark } from "./chat-member-mark";
import { ChatElapsed, ChatWorkStatusLabel } from "./chat-task-card";

export interface ChatMembersPanelProps {
  /** The chat's latest Accord, listed first: a row that opens it. */
  accord?: DockedAccord;
  onOpenAccord?: (launchId: string) => void;
  rows: { current: readonly SessionsMemberRow[]; previous: readonly SessionsMemberRow[] };
  messages: readonly ChatMessage[];
  runIdsByParticipantId: ReadonlyMap<string, readonly string[]>;
  roleLabel: (participant: ChatParticipant) => string;
  onOpenMember: (participantId: string) => void;
  onStopRuns?: (runIds: readonly string[]) => void;
  onClose: () => void;
}

/** The sessions view's right panel: the chat's latest Accord, then every
 *  member but the main session, what each does and Stop; while some member
 *  works, those that worked and ended under "Previous" (sessionsMemberRows). */
export function ChatMembersPanel(props: ChatMembersPanelProps): JSX.Element {
  const [previousOpen, setPreviousOpen] = useState(false);
  const allRows = [...props.rows.current, ...props.rows.previous];
  const allRunIds = allRows.flatMap((row) => props.runIdsByParticipantId.get(row.participant.id) ?? []);
  const renderRow = (row: SessionsMemberRow): JSX.Element => (
    <ChatMembersPanelRow
      key={row.participant.id}
      row={row}
      messages={props.messages}
      runIds={props.runIdsByParticipantId.get(row.participant.id) ?? []}
      roleLabel={props.roleLabel(row.participant)}
      onOpen={() => props.onOpenMember(row.participant.id)}
      onStopRuns={props.onStopRuns}
    />
  );
  return (
    <section className="chat-thread-panel chat-members-panel" aria-label="Members" data-testid="chat-members-panel">
      <header className="thread-panel-head chat-thread-head" data-titlebar>
        <div>
          <h2>Members</h2>
        </div>
        <div className="thread-panel-actions">
          {props.onStopRuns && allRunIds.length > 0 && (
            <Button variant="outline" size="sm" data-testid="chat-members-stop-all" onClick={() => props.onStopRuns?.(allRunIds)}>
              Stop all
            </Button>
          )}
          <IconButton icon={X} label="Close members" tooltip="Close members" onClick={props.onClose} />
        </div>
      </header>
      <div className="chat-thread-body chat-members-body">
        {props.accord && props.onOpenAccord && (
          <ChatAccordRow launch={props.accord} testId="chat-members-accord" onOpen={() => props.onOpenAccord?.(props.accord!.launchId)} />
        )}
        {allRows.length === 0 && (
          <p className="chat-members-empty">No other members yet. The main session adds members when it gives them a task.</p>
        )}
        {props.rows.current.length > 0 && <div className="chat-members-list">{props.rows.current.map(renderRow)}</div>}
        {props.rows.previous.length > 0 && (
          <div className="chat-members-previous" data-testid="chat-members-previous">
            <button
              type="button"
              className="chat-members-previous-toggle"
              aria-expanded={previousOpen}
              onClick={() => setPreviousOpen((current) => !current)}
            >
              {previousOpen ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
              <span>Previous</span>
              <span className="chat-members-previous-count">{props.rows.previous.length}</span>
            </button>
            {previousOpen && <div className="chat-members-list">{props.rows.previous.map(renderRow)}</div>}
          </div>
        )}
      </div>
    </section>
  );
}

function ChatMembersPanelRow(props: {
  row: SessionsMemberRow;
  messages: readonly ChatMessage[];
  runIds: readonly string[];
  roleLabel: string;
  onOpen: () => void;
  onStopRuns?: (runIds: readonly string[]) => void;
}): JSX.Element {
  const { participant, status, task } = props.row;
  const name = chatParticipantDisplayName(participant);
  const since = status === "running"
    ? memberRunningSince(participant.id, props.messages) ?? (task ? sessionsTaskRunningSince(task.item, props.messages) : undefined)
    : undefined;
  return (
    <div className="chat-members-row" data-testid="chat-members-row" data-participant-id={participant.id} data-member-status={status}>
      <button type="button" className="chat-members-row-main" onClick={props.onOpen}>
        <ChatProviderMark member={participant} />
        <span className="chat-members-row-text">
          <span className="chat-members-row-name">
            <strong>{name}</strong>
            {props.roleLabel && <span className="chat-members-row-role">{props.roleLabel}</span>}
          </span>
          {task && <span className="chat-members-row-task">{firstTextLine(task.item.prompt)}</span>}
        </span>
        <span className="chat-members-row-state">
          <ChatWorkStatusLabel status={status} />
          {since && <ChatElapsed className="chat-members-row-elapsed" since={since} />}
        </span>
      </button>
      {props.onStopRuns && props.runIds.length > 0 && (
        <IconButton
          size="xs"
          tone="danger"
          icon={X}
          label={`Stop ${name}`}
          tooltip={`Stop ${name}`}
          data-testid="chat-members-row-stop"
          onClick={() => props.onStopRuns?.(props.runIds)}
        />
      )}
    </div>
  );
}
