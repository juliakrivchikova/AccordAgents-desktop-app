import { useContext, type ReactNode } from "react";
import { HoverCard } from "radix-ui";
import { KeyIcon, SquareIcon } from "@phosphor-icons/react";

import { SESSIONS_WORK_STATUS_LABELS, sessionsCompactDuration, type SessionsWorkStatus } from "../../../shared/mainSessionView";
import type { MachineListResult } from "../../../shared/machineLink";
import type { ChatParticipant } from "../../../shared/types";
import { IconButton } from "../primitives";
import { ChatBackgroundTasksContext } from "./chat-roster-status";
import { ChatEnvironmentPendingContext, ENVIRONMENT_PENDING_TITLE, environmentPendingText } from "./chat-environment-pending";
import { useStreamingElapsedSeconds } from "./chat-streaming";
import { formatWorkedDuration } from "./chat-worked-row";
import { useMemberModelSummary, type MemberModelSummary } from "./use-member-model-summary";

/** A duration as T3 Code's agent row says it: "5s", "8m", "1.5h", "12h"
 *  (shared with the phone). */
export const formatCompactDuration = sessionsCompactDuration;

/** A running time that counts up every second; compact in a row, full in
 *  its hover card. */
function LiveElapsed(props: { since: string; compact?: boolean }): JSX.Element {
  const ms = useStreamingElapsedSeconds(props.since) * 1000;
  return <>{props.compact ? formatCompactDuration(ms) : formatWorkedDuration(ms)}</>;
}

/** The states a row's dot shows (the User, 2026-11-22): it runs (pulsing)
 *  or waits for her answer. A session that ended or never worked has no dot:
 *  its state no longer matters, its hover card still says it. */
function stateMatters(status: SessionsWorkStatus): boolean {
  return status === "running" || status === "waiting";
}

/** What a row knows of the session it lists. */
export interface ChatAgentRowData {
  id: string;
  status: SessionsWorkStatus;
  /** Its glyph: the provider's bare mark. */
  mark: ReactNode;
  title: string;
  /** Since when it runs, while it runs. */
  since?: string;
  /** How long its latest task took, once it ended. */
  durationMs?: number;
  /** What it does now (its newest step), while it runs. */
  step?: string;
  /** How its latest task ended in one line: its reply, or why it failed. */
  result?: string;
  stop?: () => void;
  onOpen: () => void;
}

/** A member's line under the title in its hover card: its CLI, model and
 *  effort (and a role that is not the ordinary member's). */
export type ChatAgentDetail = (model: MemberModelSummary) => string;

/** A row's end, the same in every state (the User, 2026-11-22): how long it
 *  runs or worked, muted. Never its state (the dot on its glyph says that;
 *  its hover card and accessible name say it in words), nor its model and
 *  effort (its hover card says them). */
function RowMeta(props: { row: ChatAgentRowData; environmentPending: boolean }): JSX.Element {
  const { row } = props;
  const time = row.status === "running" && row.since
    ? <LiveElapsed since={row.since} compact />
    : row.durationMs !== undefined ? formatCompactDuration(row.durationMs) : undefined;
  return (
    <span className="chat-agent-meta">
      {/* New environment variables wait for its background tasks: the
          Environment key in the pending colour, explained in the row's card. */}
      {props.environmentPending && (
        <span className="chat-environment-pending" data-testid="chat-environment-pending" aria-hidden="true">
          <KeyIcon size={12} />
        </span>
      )}
      {time !== undefined && <span className="chat-agent-time" data-testid="chat-agent-time">{time}</span>}
      {/* Stop's place on hover. */}
      {time === undefined && row.stop && <span className="chat-agent-time" aria-hidden="true" />}
    </span>
  );
}

/** The hover card's words: the title, the CLI · model · effort line, the
 *  state, time and background work, then what it does now (while it runs)
 *  or how its task ended. */
export function ChatAgentCard(props: { row: ChatAgentRowData; detail: string; backgroundTasks: number; environmentPending?: boolean }): JSX.Element {
  const { row } = props;
  const time = row.status === "running" && row.since
    ? <LiveElapsed since={row.since} />
    : row.durationMs !== undefined ? formatWorkedDuration(row.durationMs) : undefined;
  const background = props.backgroundTasks > 0
    ? `${props.backgroundTasks} background ${props.backgroundTasks === 1 ? "task" : "tasks"}`
    : undefined;
  const line = row.status === "running" ? row.step : row.result;
  return (
    <>
      <span className="chat-agent-card-title">{row.title}</span>
      {props.detail && <span className="chat-agent-card-line">{props.detail}</span>}
      <span className="chat-agent-card-line">
        {row.status !== "idle" && <span className={`chat-agent-card-status is-${row.status}`}>{SESSIONS_WORK_STATUS_LABELS[row.status]}</span>}
        {time !== undefined && <>{row.status !== "idle" && " · "}{time}</>}
        {background && <>{(row.status !== "idle" || time !== undefined) && " · "}{background}</>}
      </span>
      {line && <span className="chat-agent-card-now">{line}</span>}
      {props.environmentPending && (
        <span className="chat-agent-card-env" data-testid="chat-environment-pending-card">
          <span className="chat-agent-card-env-title">
            <span className="chat-environment-pending" aria-hidden="true"><KeyIcon size={12} /></span>
            {ENVIRONMENT_PENDING_TITLE}
          </span>
          <span className="chat-agent-card-line">{environmentPendingText(props.backgroundTasks)}</span>
        </span>
      )}
    </>
  );
}

/** One session in the side panel, as T3 Code lists its agents: the
 *  provider's glyph with a dot while it runs (pulsing) or waits for the User
 *  (its only mark of it in the row; none once it ended), its task's title on one
 *  line, and how long it runs or worked at the end. Hovering shows Stop
 *  where the time was (only while it runs) and, to its left, a card with the
 *  CLI, model and effort, the state and time and what it does now. A click
 *  opens its whole session in the panel. */
export function ChatAgentRow(props: {
  row: ChatAgentRowData;
  /** The member it lists; none for one no longer in the chat. */
  participant?: ChatParticipant;
  machines: MachineListResult;
  detail?: ChatAgentDetail;
  /** The line a removed member's card says instead of its model. */
  fixedDetail?: string;
}): JSX.Element {
  return props.participant
    ? <MemberAgentRow {...props} participant={props.participant} />
    : <AgentRowView row={props.row} detail={props.fixedDetail ?? ""} />;
}

function MemberAgentRow(props: { row: ChatAgentRowData; participant: ChatParticipant; machines: MachineListResult; detail?: ChatAgentDetail }): JSX.Element {
  const model = useMemberModelSummary(props.participant, props.machines);
  return <AgentRowView row={props.row} detail={props.detail?.(model) ?? model.model} />;
}

function AgentRowView(props: { row: ChatAgentRowData; detail: string }): JSX.Element {
  const { row } = props;
  const backgroundTasks = useContext(ChatBackgroundTasksContext).get(row.id)?.length ?? 0;
  const environmentPending = useContext(ChatEnvironmentPendingContext).has(row.id) && backgroundTasks > 0;
  const status = row.status === "idle" ? row.title : `${row.title}, ${SESSIONS_WORK_STATUS_LABELS[row.status]}`;
  return (
    <li
      className={row.stop ? "chat-agent-row has-stop" : "chat-agent-row"}
      data-testid="chat-members-row"
      data-participant-id={row.id}
      data-member-status={row.status}
    >
      <HoverCard.Root openDelay={400} closeDelay={60}>
        <HoverCard.Trigger asChild>
          <button
            type="button"
            className="chat-agent-row-main"
            aria-label={environmentPending ? `${status}, ${ENVIRONMENT_PENDING_TITLE.toLowerCase()}` : status}
            onClick={row.onOpen}
          >
            <span className="chat-agent-glyph">
              {row.mark}
              {stateMatters(row.status) && <span className={`chat-agent-dot is-${row.status}`} aria-hidden="true" />}
            </span>
            <span className="chat-agent-title">{row.title}</span>
            <RowMeta row={row} environmentPending={environmentPending} />
          </button>
        </HoverCard.Trigger>
        <HoverCard.Portal>
          <HoverCard.Content side="left" align="start" sideOffset={12} collisionPadding={8} className="chat-agent-card" data-testid="chat-agent-card">
            <ChatAgentCard row={row} detail={props.detail} backgroundTasks={backgroundTasks} environmentPending={environmentPending} />
          </HoverCard.Content>
        </HoverCard.Portal>
      </HoverCard.Root>
      {row.stop && (
        <IconButton
          size="xs"
          tone="danger"
          icon={SquareIcon}
          iconWeight="fill"
          className="chat-agent-stop"
          iconClassName="chat-agent-stop-icon"
          label={`Stop ${row.title}`}
          tooltip="Stop"
          data-testid="chat-members-row-stop"
          onClick={row.stop}
        />
      )}
    </li>
  );
}
