import type { ReactNode } from "react";

import { chatReasoningEffortLabel } from "../../../shared/reasoningEffort";
import type { ChatParticipant } from "../../../shared/types";
import { ChatProviderMark } from "./chat-member-mark";

const NO_MENTIONS: ChatParticipant[] = [];

/** The placeholder of a composer in the sessions view: no handles there. */
export const SESSIONS_COMPOSER_PLACEHOLDER = "Ask anything. / commands, # files";

/**
 * The main composer in the sessions view (docs/main-session.md): it writes to
 * the main session whatever its text names, so it offers no members to
 * mention (commands and files stay), and it carries the main session's model
 * chip, as T3 Code's composer does. The classic view's composer is as before.
 */
export function sessionsComposerProps(
  mainSessionId: string | undefined,
  renderMemberChip?: (participantId: string) => ReactNode
): { participants?: ChatParticipant[]; placeholder?: string; footerChip?: ReactNode } {
  if (!mainSessionId) {
    return {};
  }
  return { participants: NO_MENTIONS, placeholder: SESSIONS_COMPOSER_PLACEHOLDER, footerChip: renderMemberChip?.(mainSessionId) };
}

/** What a member's model chip says: its provider's logo, its model, its
 *  reasoning effort ("Haiku 5.5 · Low"). */
export function ChatMemberModelChipLabel(props: { participant: ChatParticipant; defaultModelLabel?: string }): JSX.Element {
  const { participant } = props;
  const model = participant.model?.trim() || props.defaultModelLabel || "Default model";
  const effort = participant.reasoningEffort ? chatReasoningEffortLabel(participant.reasoningEffort) : undefined;
  return (
    <span className="chat-model-chip-label" data-testid="chat-model-chip-label">
      <ChatProviderMark member={participant} className="is-mini" />
      <span>{model}</span>
      {effort && <span className="chat-model-chip-effort">{effort}</span>}
    </span>
  );
}

/** A member's model chip in a composer of the sessions view: the trigger of
 *  its settings (ChatParticipantMenu's one-member mode). */
export function memberModelChip(participants: readonly ChatParticipant[], participantId: string): ReactNode {
  const participant = participants.find((candidate) => candidate.id === participantId);
  if (!participant) {
    return undefined;
  }
  return (
    <button type="button" className="chat-model-chip" data-testid="chat-model-chip" aria-label="Model and settings" title="Model and settings">
      <ChatMemberModelChipLabel participant={participant} />
    </button>
  );
}
