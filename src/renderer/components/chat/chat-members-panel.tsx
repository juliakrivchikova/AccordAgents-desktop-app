import { useState, type ReactNode } from "react";
import { Bot, ChevronDown, X } from "lucide-react";

import type { DockedAccord } from "../../../shared/accordProgress";
import { SESSIONS_REMOVED_MEMBER_DETAIL, type SessionsMemberActivity, type SessionsMemberRow } from "../../../shared/mainSessionView";
import type { ChatParticipant } from "../../../shared/types";
import { IconButton } from "../primitives";
import { ChatAccordRow } from "./chat-accord-dock";
import { ChatAgentRow, type ChatAgentDetail } from "./chat-agent-row";
import { ChatProviderMark, ChatProviderMarkSlot } from "./chat-member-mark";
import { useMachineList } from "./use-cli-start-defaults";
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
  /** A member's title: the task it is named by. */
  memberTitle: (participantId: string) => string;
  /** The line under a member's title in its hover card, from the model and
   *  effort it runs on (its CLI, model, effort, a non-generic role). */
  memberDetail?: (participant: ChatParticipant) => ChatAgentDetail;
  /** How long a member's latest task took, once it ended. */
  taskDurationMs?: (row: SessionsMemberRow) => number | undefined;
  /** What a running member does now: its newest step. */
  currentStep?: (participantId: string) => string | undefined;
  /** How a member's latest task ended, in one line. */
  taskResult?: (participantId: string) => string | undefined;
  onOpenMember: (participantId: string) => void;
  onStopRuns?: (runIds: readonly string[]) => void;
  onClose: () => void;
}

/** The sessions view's right panel, as T3 Code's side panel (the User,
 *  2026-11-22): no title, only its close button; the chat's latest Accord;
 *  then "Agents · N running", the sessions the main session delegated (never
 *  the main session itself, whose settings are its composer's controls), one
 *  line each, Stop on a row's hover and no Stop all; those that worked and
 *  ended folded under "Previous agents", those no longer in the chat under
 *  "Removed", read-only. Nothing is said when there are none. */
export function ChatMembersPanel(props: ChatMembersPanelProps): JSX.Element {
  const machines = useMachineList();
  const former = props.formerRows ?? [];
  const runningCount = props.rows.current.filter((row) => row.status === "running").length;
  const renderRow = (row: SessionsMemberRow): JSX.Element => {
    const { participant, status } = row;
    const runIds = props.runIdsByParticipantId.get(participant.id) ?? [];
    const running = props.activity.runningSince.get(participant.id);
    const since = status === "running" ? running ?? row.task?.item.createdAt : undefined;
    const durationMs = status === "done" ? props.taskDurationMs?.(row) : undefined;
    const step = status === "running" ? props.currentStep?.(participant.id) : undefined;
    const result = status === "done" || status === "failed" ? props.taskResult?.(participant.id) : undefined;
    return (
      <ChatAgentRow
        key={participant.id}
        participant={participant}
        machines={machines}
        detail={props.memberDetail?.(participant)}
        row={{
          id: participant.id,
          status,
          mark: <ChatProviderMark member={participant} />,
          title: props.memberTitle(participant.id),
          ...(since ? { since } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(step ? { step } : {}),
          ...(result ? { result } : {}),
          ...(props.onStopRuns && runIds.length > 0 ? { stop: () => props.onStopRuns?.(runIds) } : {}),
          onOpen: () => props.onOpenMember(participant.id)
        }}
      />
    );
  };
  return (
    <section className="chat-thread-panel chat-members-panel" aria-label="Side panel" data-testid="chat-members-panel">
      <header className="thread-panel-head chat-thread-head chat-members-head" data-titlebar>
        <div />
        <div className="thread-panel-actions">
          <IconButton icon={X} label="Close" tooltip="Close" onClick={props.onClose} />
        </div>
      </header>
      <div className="chat-thread-body chat-members-body" data-testid="chat-members-body">
        {props.accord && props.onOpenAccord && (
          <div className="chat-side-section">
            <ChatAccordRow launch={props.accord} testId="chat-members-accord" onOpen={() => props.onOpenAccord?.(props.accord!.launchId)} />
          </div>
        )}
        {props.rows.current.length > 0 && (
          <div className="chat-side-section" data-testid="chat-members-agents">
            <h3 className="chat-side-heading">{runningCount > 0 ? `Agents · ${runningCount} running` : "Agents"}</h3>
            <ul className="chat-agent-list">{props.rows.current.map(renderRow)}</ul>
          </div>
        )}
        <ChatAgentsGroup label="Previous agents" testId="chat-members-previous" count={props.rows.previous.length}>
          {props.rows.previous.map(renderRow)}
        </ChatAgentsGroup>
        <ChatAgentsGroup label="Removed" testId="chat-members-removed" count={former.length}>
          {former.map((row) => (
            <ChatAgentRow
              key={row.member.id}
              machines={machines}
              fixedDetail={SESSIONS_REMOVED_MEMBER_DETAIL}
              row={{
                id: row.member.id,
                status: row.status,
                mark: row.member.kind ? <ChatProviderMark member={{ kind: row.member.kind }} /> : <ChatProviderMarkSlot />,
                title: row.title,
                onOpen: () => props.onOpenMember(row.member.id)
              }}
            />
          ))}
        </ChatAgentsGroup>
      </div>
    </section>
  );
}

/** A folded group of the panel (T3 Code's "Previous agents"): a row with its
 *  name, its count while folded and a chevron. */
function ChatAgentsGroup(props: { label: string; testId: string; count: number; children: ReactNode }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (props.count === 0) {
    return null;
  }
  return (
    <div className="chat-side-section" data-testid={props.testId}>
      <button type="button" className="chat-agents-group-toggle" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <Bot className="chat-agents-group-icon" size={16} strokeWidth={1.75} aria-hidden="true" />
        <span className="chat-agents-group-label">{props.label}</span>
        {!open && <span className="chat-agents-group-count">{props.count}</span>}
        <ChevronDown className={open ? "chat-agents-group-chevron" : "chat-agents-group-chevron is-folded"} size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open && <ul className="chat-agent-list">{props.children}</ul>}
    </div>
  );
}
