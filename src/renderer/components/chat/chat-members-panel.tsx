import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";

import type { DockedAccord } from "../../../shared/accordProgress";
import type { SessionsMemberActivity, SessionsMemberRow } from "../../../shared/mainSessionView";
import type { ChatParticipant } from "../../../shared/types";
import { Button } from "@/components/ui/button";
import { IconButton } from "../primitives";
import { ChatAccordRow } from "./chat-accord-dock";
import { ChatProviderMark } from "./chat-member-mark";
import { ChatElapsed, ChatWorkStatusLabel } from "./chat-task-card";
import type { SessionsFormerRow } from "./use-chat-sessions-view";

export interface ChatMembersPanelProps {
  /** The chat's latest Accord, listed first: a row that opens it. */
  accord?: DockedAccord;
  onOpenAccord?: (launchId: string) => void;
  /** The main session, first: its provider and its settings. */
  main?: { participant: ChatParticipant; detail: string; settings?: ReactNode };
  rows: { current: readonly SessionsMemberRow[]; previous: readonly SessionsMemberRow[] };
  /** Members no longer in the chat, whose sessions stay readable. */
  formerRows?: readonly SessionsFormerRow[];
  activity: SessionsMemberActivity;
  runIdsByParticipantId: ReadonlyMap<string, readonly string[]>;
  /** A member's title (its task) and the line under it (provider, model). */
  memberTitle: (participantId: string) => string;
  memberDetail: (participant: ChatParticipant) => string;
  onOpenMember: (participantId: string) => void;
  onStopRuns?: (runIds: readonly string[]) => void;
  onClose: () => void;
}

/** The sessions view's right panel (T3 Code's agents list): the chat's latest
 *  Accord, then every member but the main session, each its provider's logo
 *  and its task, what it does and Stop; while some member works, those that
 *  worked and ended under "Previous"; members no longer in the chat under
 *  "Removed", read-only. */
export function ChatMembersPanel(props: ChatMembersPanelProps): JSX.Element {
  const allRows = [...props.rows.current, ...props.rows.previous];
  const allRunIds = allRows.flatMap((row) => props.runIdsByParticipantId.get(row.participant.id) ?? []);
  const former = props.formerRows ?? [];
  const renderRow = (row: SessionsMemberRow): JSX.Element => {
    const { participant, status } = row;
    const runIds = props.runIdsByParticipantId.get(participant.id) ?? [];
    const title = props.memberTitle(participant.id);
    const running = props.activity.runningSince.get(participant.id);
    const since = status === "running" ? running ?? row.task?.item.createdAt : undefined;
    return (
      <ChatMembersPanelRow
        key={participant.id}
        id={participant.id}
        status={status}
        mark={<ChatProviderMark member={participant} />}
        title={title}
        detail={props.memberDetail(participant)}
        since={since}
        stop={props.onStopRuns && runIds.length > 0 ? () => props.onStopRuns?.(runIds) : undefined}
        onOpen={() => props.onOpenMember(participant.id)}
      />
    );
  };
  return (
    <section className="chat-thread-panel chat-members-panel" aria-label="Members" data-testid="chat-members-panel">
      <header className="thread-panel-head chat-thread-head" data-titlebar>
        <div>
          <h2>Members</h2>
        </div>
        <div className="thread-panel-actions">
          {props.onStopRuns && allRunIds.length > 0 && (
            <Button variant="ghost" size="sm" data-testid="chat-members-stop-all" onClick={() => props.onStopRuns?.(allRunIds)}>
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
        {props.main && (
          <div className="chat-members-list">
            <div className="chat-members-row is-main" data-testid="chat-members-main" data-participant-id={props.main.participant.id}>
              <span className="chat-members-row-main">
                <ChatProviderMark member={props.main.participant} />
                <span className="chat-members-row-text">
                  <strong className="chat-members-row-name">Main session</strong>
                  {props.main.detail && <span className="chat-members-row-task">{props.main.detail}</span>}
                </span>
              </span>
              {props.main.settings}
            </div>
          </div>
        )}
        {allRows.length === 0 && former.length === 0 && (
          <p className="chat-members-empty">No other members yet. The main session adds members when it gives them a task.</p>
        )}
        {props.rows.current.length > 0 && <div className="chat-members-list">{props.rows.current.map(renderRow)}</div>}
        <ChatMembersGroup label="Previous" testId="chat-members-previous" count={props.rows.previous.length}>
          {props.rows.previous.map(renderRow)}
        </ChatMembersGroup>
        <ChatMembersGroup label="Removed" testId="chat-members-removed" count={former.length}>
          {former.map((row) => (
            <ChatMembersPanelRow
              key={row.member.id}
              id={row.member.id}
              status={row.status}
              mark={<span className="chat-provider-icon" aria-hidden="true" />}
              title={row.title}
              detail="No longer in this chat"
              onOpen={() => props.onOpenMember(row.member.id)}
            />
          ))}
        </ChatMembersGroup>
      </div>
    </section>
  );
}

function ChatMembersGroup(props: { label: string; testId: string; count: number; children: ReactNode }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (props.count === 0) {
    return null;
  }
  return (
    <div className="chat-members-previous" data-testid={props.testId}>
      <button type="button" className="chat-members-previous-toggle" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        <span>{props.label}</span>
        <span className="chat-members-previous-count">{props.count}</span>
      </button>
      {open && <div className="chat-members-list">{props.children}</div>}
    </div>
  );
}

function ChatMembersPanelRow(props: {
  id: string;
  status: SessionsMemberRow["status"];
  mark: JSX.Element;
  title: string;
  detail: string;
  since?: string;
  stop?: () => void;
  onOpen: () => void;
}): JSX.Element {
  return (
    <div className="chat-members-row" data-testid="chat-members-row" data-participant-id={props.id} data-member-status={props.status}>
      <button type="button" className="chat-members-row-main" onClick={props.onOpen}>
        {props.mark}
        <span className="chat-members-row-text">
          <strong className="chat-members-row-name">{props.title}</strong>
          {props.detail && <span className="chat-members-row-task">{props.detail}</span>}
        </span>
        <span className="chat-members-row-state">
          {props.status !== "idle" && <ChatWorkStatusLabel status={props.status} />}
          {props.since && <ChatElapsed className="chat-members-row-elapsed" since={props.since} />}
        </span>
      </button>
      {props.stop && (
        <IconButton
          size="xs"
          tone="danger"
          icon={X}
          label={`Stop ${props.title}`}
          tooltip="Stop"
          data-testid="chat-members-row-stop"
          onClick={props.stop}
        />
      )}
    </div>
  );
}
