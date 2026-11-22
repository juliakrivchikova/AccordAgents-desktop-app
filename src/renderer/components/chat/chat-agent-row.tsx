import { useContext, type ReactNode } from "react";
import { HoverCard } from "radix-ui";
import { Square } from "lucide-react";

import { SESSIONS_WORK_STATUS_LABELS, sessionsCompactDuration, type SessionsWorkStatus } from "../../../shared/mainSessionView";
import type { MachineListResult } from "../../../shared/machineLink";
import type { ChatParticipant } from "../../../shared/types";
import { IconButton } from "../primitives";
import { ChatBackgroundTasksContext } from "./chat-roster-status";
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

/** The muted words at a row's end, the same in every state (the User,
 *  2026-11-22): the model and how long it runs or worked, never its state
 *  (the dot on its glyph says that; its hover card and accessible name say
 *  it in words). */
function RowMeta(props: { row: ChatAgentRowData; model?: string }): JSX.Element {
  const { row } = props;
  const time = row.status === "running" && row.since
    ? <LiveElapsed since={row.since} compact />
    : row.durationMs !== undefined ? formatCompactDuration(row.durationMs) : undefined;
  return (
    <span className="chat-agent-meta">
      {props.model && <span className="chat-agent-model">{props.model}</span>}
      {props.model && time !== undefined && <span className="chat-agent-sep" aria-hidden="true">·</span>}
      {time !== undefined && <span className="chat-agent-time" data-testid="chat-agent-time">{time}</span>}
      {/* Stop's place on hover, so it never covers the model's name. */}
      {time === undefined && row.stop && <span className="chat-agent-time" aria-hidden="true" />}
    </span>
  );
}

/** The hover card's words: the title, the CLI · model · effort line, the
 *  state, time and background work, then what it does now (while it runs)
 *  or how its task ended. */
export function ChatAgentCard(props: { row: ChatAgentRowData; detail: string; backgroundTasks: number }): JSX.Element {
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
    </>
  );
}

/** One session in the side panel, as T3 Code lists its agents: the
 *  provider's glyph with a dot for its state (its only mark of it in the
 *  row: a colour per state, pulsing while it runs), its task's title on one
 *  line, the model and how long it ran at the end. Hovering shows Stop where the
 *  time was (only while it runs) and, to its left, a card with the CLI,
 *  model and effort, the state and time and what it does now. A click opens
 *  its whole session in the panel. */
export function ChatAgentRow(props: {
  row: ChatAgentRowData;
  /** The member it lists; none for one no longer in the chat. */
  participant?: ChatParticipant;
  machines: MachineListResult;
  detail?: ChatAgentDetail;
  /** The line a removed member's card says instead of its model. */
  fixedDetail?: string;
  /** What a removed member's row names in the model's place: its CLI. */
  fixedModel?: string;
}): JSX.Element {
  return props.participant
    ? <MemberAgentRow {...props} participant={props.participant} />
    : <AgentRowView row={props.row} {...(props.fixedModel ? { model: props.fixedModel } : {})} detail={props.fixedDetail ?? ""} />;
}

function MemberAgentRow(props: { row: ChatAgentRowData; participant: ChatParticipant; machines: MachineListResult; detail?: ChatAgentDetail }): JSX.Element {
  const model = useMemberModelSummary(props.participant, props.machines);
  return <AgentRowView row={props.row} model={model.model} detail={props.detail?.(model) ?? model.model} />;
}

function AgentRowView(props: { row: ChatAgentRowData; model?: string; detail: string }): JSX.Element {
  const { row } = props;
  const backgroundTasks = useContext(ChatBackgroundTasksContext).get(row.id)?.length ?? 0;
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
            aria-label={[row.title, row.status === "idle" ? "" : SESSIONS_WORK_STATUS_LABELS[row.status], props.model ?? ""].filter(Boolean).join(", ")}
            onClick={row.onOpen}
          >
            <span className="chat-agent-glyph">
              {row.mark}
              {row.status !== "idle" && <span className={`chat-agent-dot is-${row.status}`} aria-hidden="true" />}
            </span>
            <span className="chat-agent-title">{row.title}</span>
            <RowMeta row={row} model={props.model} />
          </button>
        </HoverCard.Trigger>
        <HoverCard.Portal>
          <HoverCard.Content side="left" align="start" sideOffset={12} collisionPadding={8} className="chat-agent-card" data-testid="chat-agent-card">
            <ChatAgentCard row={row} detail={props.detail} backgroundTasks={backgroundTasks} />
          </HoverCard.Content>
        </HoverCard.Portal>
      </HoverCard.Root>
      {row.stop && (
        <IconButton
          size="xs"
          tone="danger"
          icon={Square}
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
