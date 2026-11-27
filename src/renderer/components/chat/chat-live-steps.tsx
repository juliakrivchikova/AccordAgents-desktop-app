import { useMemo, useState, type ReactNode } from "react";
import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";

import { chatActivityStandsAlone } from "../../../shared/processingTranscript";
import { sessionsActivityRow, type SessionsActivityRow } from "../../../shared/sessionsActivity";
import type { ChatAgentActivityEvent } from "../../../shared/types";
import { ChatSessionsCappedRows, SESSIONS_ACTIVITY_ICONS } from "./chat-activity-rows";

/**
 * A running reply's steps folded into one line (the User, 2026-11-27, in
 * both views, here and on the phone): the step the member is at, in the same
 * words its row has, shimmering; the newest step replaces it. Pressed, it
 * opens to every step so far, which keeps growing while open; pressed again,
 * it folds. The reply's notices about the run itself stay where they came,
 * in the reply, never folded in here. Without a step yet it says where the
 * run stands (`fallback`), as a line that does not open.
 */
export function ChatLiveSteps(props: {
  events: readonly ChatAgentActivityEvent[];
  fallback?: string;
  foldSteps?: boolean;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const steps = useMemo(() => props.events.filter((event) => !chatActivityStandsAlone(event)), [props.events]);
  const line = chatLiveStepOf(steps, props.fallback);
  if (!line) {
    return null;
  }
  const Icon = SESSIONS_ACTIVITY_ICONS[line.kind];
  const words = (
    <>
      <Icon className="chat-sessions-activity-icon" size={14} aria-hidden />
      <span className="chat-sessions-activity-text">{line.text}</span>
    </>
  );
  if (steps.length === 0) {
    return (
      <div className="chat-live-steps" data-testid="chat-live-steps">
        <div className="chat-sessions-activity-row chat-live-step is-current" data-testid="chat-live-step">{words}</div>
      </div>
    );
  }
  return (
    <div className="chat-live-steps" data-testid="chat-live-steps">
      <button
        type="button"
        className="chat-sessions-activity-row chat-live-step is-current"
        data-testid="chat-live-step"
        data-activity-kind={line.kind}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {words}
        <CaretRightIcon className="chat-live-step-caret" size={12} aria-hidden />
      </button>
      {open && (
        <div className="chat-live-steps-rows" data-testid="chat-live-steps-rows">
          <ChatSessionsCappedRows events={steps} foldSteps={props.foldSteps} />
        </div>
      )}
    </div>
  );
}

/** What the live line says: the newest step with words (in its row's
 *  words; notices are never named), or without any step where the run
 *  stands (`fallback`). Takes a reply's events, notices and all. */
export function chatLiveStepOf(events: readonly ChatAgentActivityEvent[], fallback?: string): SessionsActivityRow | undefined {
  let sawStep = false;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (chatActivityStandsAlone(event)) continue;
    sawStep = true;
    const row = sessionsActivityRow(event);
    if (row.text) return row;
  }
  const text = sawStep ? undefined : fallback?.trim();
  return text ? { kind: "status", text } : undefined;
}

/**
 * A part of a turn the User's next message joined (turnContinues): it has no
 * "Worked for" of its own, the turn's one is on its last part. Its steps fold
 * into one quiet line, "N steps ›", which opens to them and folds again (the
 * User, 2026-11-27); `folded` is what shows while it is closed.
 */
export function ChatStepsFold(props: { count: number; children: ReactNode; folded?: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false);
  const label = props.count > 0 ? `${props.count} ${props.count === 1 ? "step" : "steps"}` : "Steps";
  return (
    <>
      <button type="button" className="chat-worked-fold-toggle chat-steps-fold" data-testid="chat-steps-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{label}</span>
        {open ? <CaretDownIcon size={14} aria-hidden /> : <CaretRightIcon size={14} aria-hidden />}
      </button>
      {open ? props.children : props.folded}
    </>
  );
}

const NO_NOTICES: ChatAgentActivityEvent[] = [];
/** Each events array's notices, kept so a reply drawn again gets the same
 *  array and its memoized parts do not draw again. */
const noticesOf = new WeakMap<readonly ChatAgentActivityEvent[], ChatAgentActivityEvent[]>();

/** A running reply's notices about the run, which stay in it where they came
 *  while its steps fold into the live line. */
export function chatActivityNotices(events: readonly ChatAgentActivityEvent[]): ChatAgentActivityEvent[] {
  let kept = noticesOf.get(events);
  if (!kept) {
    const found = events.filter(chatActivityStandsAlone);
    kept = found.length > 0 ? found : NO_NOTICES;
    noticesOf.set(events, kept);
  }
  return kept;
}

