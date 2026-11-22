import { ArrowLeftIcon, XIcon } from "@phosphor-icons/react";

import type { DockedAccord } from "../../../shared/accordProgress";
import type { ChatParticipant } from "../../../shared/types";
import { IconButton } from "../primitives";
import { ChatAccordCard } from "./chat-accord-dock";

/**
 * An Accord in the sessions view's right panel (the User, 2026-11-20): the
 * card the classic view pins above the composer, whole — its drafts, the
 * published version, the signatures, where it stands and Open — with Back
 * to the members and a close. Above the composer the view keeps one line
 * that opens it here (ChatAccordRow).
 */
export function ChatAccordPanel(props: {
  launchId: string;
  accord?: DockedAccord;
  participants: ChatParticipant[];
  onBack: () => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <section className="chat-thread-panel chat-accord-panel" aria-label="Accord" data-testid="chat-accord-panel" data-launch-id={props.launchId}>
      <header className="thread-panel-head chat-thread-head chat-member-session-head" data-titlebar>
        <div>
          <IconButton icon={ArrowLeftIcon} label="Back to members" tooltip="Back to members" data-testid="chat-accord-panel-back" onClick={props.onBack} />
          <h2>Accord</h2>
        </div>
        <div className="thread-panel-actions">
          <IconButton icon={XIcon} label="Close Accord" tooltip="Close" onClick={props.onClose} />
        </div>
      </header>
      <div className="chat-thread-body chat-accord-panel-body">
        {props.accord
          ? <ChatAccordCard launch={props.accord} participants={props.participants} folded={false} />
          : <p className="chat-members-empty">This Accord's notes are not loaded yet. Scroll up in the chat to load older messages.</p>}
      </div>
    </section>
  );
}
