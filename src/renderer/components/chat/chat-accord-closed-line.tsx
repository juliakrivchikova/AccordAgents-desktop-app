import { createContext, useContext, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { accordClosedLaunchId, accordClosedLineTitle, accordLineOutcome, type DockedAccord } from "../../../shared/accordProgress";
import type { ChatMessage, ChatParticipant } from "../../../shared/types";
import { ArtifactsContext } from "../artifacts/artifacts-context";
import { AccordMergeIcon } from "./accord-merge-icon";
import { ChatAccordCard, accordDisplayTitle } from "./chat-accord-dock";

/** The Accords the chat's closed lines name, read from its loaded messages. */
export interface AccordLinesValue {
  accordOf: (launchId: string) => DockedAccord | undefined;
  participants?: ChatParticipant[];
}

export const AccordLinesContext = createContext<AccordLinesValue | undefined>(undefined);

/**
 * The line a closed Accord left at the end of the chat as it stood when the
 * User pressed the cross on its pinned card (the User, 2026-11-16): one line
 * like a folded urgent alert -- the document's name, then where the Accord
 * stands. A click opens the very card there; its cross, or its head, folds it
 * back. Open or folded is this window's own state, as the alert's is.
 */
export function ChatAccordClosedLine(props: { message: Pick<ChatMessage, "id" | "role" | "metadata"> }): JSX.Element {
  const { message } = props;
  const launchId = accordClosedLaunchId(message);
  const lines = useContext(AccordLinesContext);
  const artifacts = useContext(ArtifactsContext);
  const [open, setOpen] = useState(false);
  const line = useRef<HTMLElement>(null);
  const keepFocus = useRef(false);
  const accord = launchId ? lines?.accordOf(launchId) : undefined;
  useLayoutEffect(() => {
    if (!keepFocus.current) return;
    keepFocus.current = false;
    // The button she pressed is gone: the one that undoes it takes the focus.
    line.current?.querySelector<HTMLElement>(open ? ".chat-accord-dock-toggle" : ".chat-card-row")?.focus({ preventScroll: true });
  }, [open]);

  function toggle(next: boolean): void {
    keepFocus.current = Boolean(line.current?.contains(document.activeElement));
    setOpen(next);
  }

  if (!accord) {
    // Its document's notes are not among the loaded messages: the line says
    // which Accord it was, and opens nothing.
    const title = accordClosedLineTitle(message);
    return (
      <article ref={line} data-message-id={message.id} className="chat-accord-line">
        <div className="chat-card-row">
          <AccordMergeIcon className="chat-card-row-icon chat-accord-line-glyph" />
          <span className="chat-card-row-preview">{title || "Accord"}</span>
          <span className="chat-card-row-outcome">Accord</span>
        </div>
      </article>
    );
  }
  if (open) {
    return (
      <article ref={line} data-message-id={message.id} className="chat-accord-line is-open">
        <ChatAccordCard
          launch={accord}
          participants={lines?.participants}
          folded={false}
          onToggleFold={() => toggle(false)}
          closeLabel="Fold"
          onClose={() => toggle(false)}
        />
      </article>
    );
  }
  const title = accordDisplayTitle(artifacts, accord.progress);
  return (
    <article ref={line} data-message-id={message.id} className="chat-accord-line">
      <button type="button" className="chat-card-row" aria-expanded={false} onClick={() => toggle(true)}>
        <AccordMergeIcon className="chat-card-row-icon chat-accord-line-glyph" />
        <span className="sr-only">Accord: </span>
        <span className="chat-card-row-preview">{title}</span>
        <span className="chat-card-row-outcome">{accordLineOutcome(accord.progress)}</span>
        <ChevronDown className="chat-card-row-chevron" size={14} aria-hidden="true" />
      </button>
    </article>
  );
}
