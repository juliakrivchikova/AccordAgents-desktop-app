import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";

import type { DockedAccord } from "../../../shared/accordProgress";
import { SESSIONS_REMOVED_MEMBER_DETAIL, type SessionsMemberActivity, type SessionsMemberRow } from "../../../shared/mainSessionView";
import type { ChatParticipant } from "../../../shared/types";
import { Button } from "@/components/ui/button";
import { IconButton } from "../primitives";
import { ChatAccordRow } from "./chat-accord-dock";
import { ChatProviderMark, ChatProviderMarkSlot } from "./chat-member-mark";
import { ChatElapsed, ChatWorkStatusLabel } from "./chat-task-card";
import type { SessionsFormerRow } from "./use-chat-sessions-view";

export interface ChatMembersPanelProps {
  /** The chat's latest Accord, listed first: a row that opens it. */
  accord?: DockedAccord;
  onOpenAccord?: (launchId: string) => void;
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

/** The sessions view's right panel (T3 Code's agents list): no title, only
 *  its close button (the User, 2026-11-21); the chat's latest Accord, then
 *  the sessions the main session delegated (never the main session itself,
 *  whose settings are its composer chip), each its provider's glyph and its
 *  task, what it does and Stop; while one works, those that ended under
 *  "Previous"; those no longer in the chat under "Removed", read-only.
 *  Nothing is said when there are none. */
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
    <section className="chat-thread-panel chat-members-panel" aria-label="Sessions" data-testid="chat-members-panel">
      <header className="thread-panel-head chat-thread-head chat-members-head" data-titlebar>
        <div />
        <div className="thread-panel-actions">
          {props.onStopRuns && allRunIds.length > 0 && (
            <Button variant="ghost" size="sm" data-testid="chat-members-stop-all" onClick={() => props.onStopRuns?.(allRunIds)}>
              Stop all
            </Button>
          )}
          <IconButton icon={X} label="Close" tooltip="Close" onClick={props.onClose} />
        </div>
      </header>
      <div className="chat-thread-body chat-members-body" data-testid="chat-members-body">
        {props.accord && props.onOpenAccord && (
          <ChatAccordRow launch={props.accord} testId="chat-members-accord" onOpen={() => props.onOpenAccord?.(props.accord!.launchId)} />
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
              mark={row.member.kind ? <ChatProviderMark member={{ kind: row.member.kind }} /> : <ChatProviderMarkSlot />}
              title={row.title}
              detail={SESSIONS_REMOVED_MEMBER_DETAIL}
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
