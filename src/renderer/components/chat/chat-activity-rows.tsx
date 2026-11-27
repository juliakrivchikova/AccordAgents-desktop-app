import { memo, useMemo, useState } from "react";
import { CaretRightIcon, PulseIcon, BrainIcon, FileTextIcon, GlobeIcon, PencilSimpleIcon, TerminalIcon, WrenchIcon } from "@phosphor-icons/react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";

import { claudeStepBlocks, claudeStepSummary } from "../../../shared/claudeStepFold";
import { sessionsActivityRow, type SessionsActivityKind } from "../../../shared/sessionsActivity";
import type { ChatAgentActivityEvent } from "../../../shared/types";

/*
 * A reply's steps as rows (chat-sessions-activity.tsx, chat-live-steps.tsx):
 * one quiet line per step, an outline icon by its kind and what it is about
 * in muted text. A Claude Code member's reads, searches and commands are
 * folded as its CLI folds them (`foldSteps`, claudeStepFold.ts; the User,
 * 2026-11-25): one line with how many of each, which opens to their rows.
 */

export const SESSIONS_ACTIVITY_ICONS: Record<SessionsActivityKind, PhosphorIcon> = {
  thinking: BrainIcon,
  web: GlobeIcon,
  shell: TerminalIcon,
  read: FileTextIcon,
  edit: PencilSimpleIcon,
  tool: WrenchIcon,
  status: PulseIcon
};

/** How many of a running reply's newest steps are drawn; the earlier ones
 *  are one muted "N earlier steps" row (the finished fold opens them). */
export const SESSIONS_ACTIVITY_ROWS_MAX = 50;

export const ChatSessionsActivityRow = memo(function ChatSessionsActivityRow(props: {
  event: ChatAgentActivityEvent;
  current?: boolean;
}): JSX.Element {
  const row = sessionsActivityRow(props.event);
  const Icon = SESSIONS_ACTIVITY_ICONS[row.kind];
  return (
    <div
      className={`chat-sessions-activity-row is-${row.kind}${props.current ? " is-current" : ""}`}
      data-testid="chat-sessions-activity-row"
      data-activity-kind={row.kind}
      title={row.text}
    >
      <Icon className="chat-sessions-activity-icon" size={14} aria-hidden />
      <span className="chat-sessions-activity-text">{row.text}</span>
    </div>
  );
}, (before, after) => before.current === after.current && sameActivityRow(before.event, after.event));

/** A row is drawn again only when what it shows changed (a streamed update
 *  hands it a new object for the same step). */
export function sameActivityRow(left: ChatAgentActivityEvent, right: ChatAgentActivityEvent): boolean {
  return left === right || (left.id === right.id && left.kind === right.kind && left.label === right.label && left.detail === right.detail);
}

/** The muted row standing for the steps not drawn; a button where it opens them. */
export function ChatSessionsEarlierSteps(props: { count: number; onOpen?: () => void }): JSX.Element {
  const text = `${props.count} earlier ${props.count === 1 ? "step" : "steps"}`;
  return props.onOpen ? (
    <button type="button" className="chat-sessions-activity-row chat-sessions-activity-earlier" data-testid="chat-sessions-activity-earlier" onClick={props.onOpen}>
      <span className="chat-sessions-activity-text">{text}</span>
    </button>
  ) : (
    <div className="chat-sessions-activity-row chat-sessions-activity-earlier" data-testid="chat-sessions-activity-earlier">
      <span className="chat-sessions-activity-text">{text}</span>
    </div>
  );
}

/** The lines steps are drawn as: each its own, or folded as Claude Code folds them. */
function stepLines(events: readonly ChatAgentActivityEvent[], foldSteps: boolean | undefined): ChatAgentActivityEvent[][] {
  return foldSteps ? claudeStepBlocks(events).map((block) => block.fold ? block.events : [block.event]) : events.map((event) => [event]);
}

/** Lines of steps without their first `count`, and how many steps those were. */
function withoutFirstLines(lines: ChatAgentActivityEvent[][], count: number): { events: ChatAgentActivityEvent[]; hidden: number } {
  return { events: lines.slice(count).flat(), hidden: lines.slice(0, count).reduce((sum, line) => sum + line.length, 0) };
}

/**
 * The blocks drawn when only the newest `max` lines of steps are: everything
 * from the first kept line on, and how many steps came before it (the words
 * between them go with them).
 */
export function newestActivityBlocks<T extends { kind: string; event?: ChatAgentActivityEvent; events?: ChatAgentActivityEvent[] }>(
  blocks: readonly T[],
  max: number,
  foldSteps?: boolean
): { blocks: T[]; hidden: number } {
  const counted = blocks.map((block) => ({
    block,
    lines: block.kind === "activity" ? [[block.event!]] : block.kind === "activity-group" ? stepLines(block.events ?? [], foldSteps) : []
  }));
  let toHide = counted.reduce((sum, { lines }) => sum + lines.length, 0) - max;
  if (toHide <= 0) return { blocks: [...blocks], hidden: 0 };
  const kept: T[] = [];
  let hidden = 0;
  for (const { block, lines } of counted) {
    if (toHide <= 0) {
      kept.push(block);
      continue;
    }
    if (lines.length === 0) continue;
    const rest = withoutFirstLines(lines, Math.min(toHide, lines.length));
    if (rest.events.length > 0) kept.push({ ...block, events: rest.events });
    toHide -= lines.length;
    hidden += rest.hidden;
  }
  return { blocks: kept, hidden };
}

/** Steps Claude Code folds: one line, the step it is at while `live`, then
 *  how many of each they were; pressed, their rows under it. */
function ChatSessionsStepFold(props: { events: readonly ChatAgentActivityEvent[]; live?: boolean }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const newest = props.events[props.events.length - 1]!;
  const text = props.live ? sessionsActivityRow(newest).text : claudeStepSummary(props.events);
  if (!text) {
    return null;
  }
  return (
    <>
      <button
        type="button"
        className={`chat-sessions-activity-row chat-sessions-step-fold${props.live ? " is-current" : ""}`}
        data-testid="chat-sessions-step-fold"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="chat-sessions-activity-text">{text}</span>
        <CaretRightIcon className="chat-sessions-step-fold-caret" size={12} aria-hidden />
      </button>
      {open && <div className="chat-sessions-step-fold-rows">{props.events.map((event) => <ChatSessionsActivityRow event={event} key={event.id} />)}</div>}
    </>
  );
}

/** Each step one row, or folded as Claude Code folds them; the last one is
 *  the current step while `live`. */
export function ChatSessionsActivityRows(props: { events: readonly ChatAgentActivityEvent[]; live?: boolean; foldSteps?: boolean }): JSX.Element | null {
  const { events, live, foldSteps } = props;
  const blocks = useMemo(() => (foldSteps ? claudeStepBlocks(events) : undefined), [events, foldSteps]);
  if (events.length === 0) {
    return null;
  }
  if (blocks) {
    return (
      <>
        {blocks.map((block, index) => {
          const current = live && index === blocks.length - 1;
          return block.fold
            ? <ChatSessionsStepFold events={block.events} live={current} key={block.events[0]!.id} />
            : <ChatSessionsActivityRow event={block.event} current={current} key={block.event.id} />;
        })}
      </>
    );
  }
  return (
    <>
      {events.map((event, index) => (
        <ChatSessionsActivityRow event={event} current={live && index === events.length - 1} key={event.id} />
      ))}
    </>
  );
}

/** A finished reply's rows: the newest SESSIONS_ACTIVITY_ROWS_MAX lines, the
 *  earlier ones behind "N earlier steps", which opens them. */
export function ChatSessionsCappedRows(props: { events: readonly ChatAgentActivityEvent[]; foldSteps?: boolean }): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => stepLines(props.events, props.foldSteps), [props.events, props.foldSteps]);
  const { events, hidden } = expanded || lines.length <= SESSIONS_ACTIVITY_ROWS_MAX
    ? { events: props.events, hidden: 0 }
    : withoutFirstLines(lines, lines.length - SESSIONS_ACTIVITY_ROWS_MAX);
  return (
    <>
      {hidden > 0 && <ChatSessionsEarlierSteps count={hidden} onOpen={() => setExpanded(true)} />}
      <ChatSessionsActivityRows events={events} foldSteps={props.foldSteps} />
    </>
  );
}
