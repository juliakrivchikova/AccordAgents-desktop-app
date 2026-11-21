import type { ReactNode } from "react";

import { chatReasoningEffortLabel } from "../../../shared/reasoningEffort";
import type { ChatParticipant } from "../../../shared/types";
import type { ChatComposerProps } from "./chat-composer";
import { ChatProviderMark } from "./chat-member-mark";
import { useMemberDefaultModelName } from "./chat-member-model-name";

const NO_MENTIONS: ChatParticipant[] = [];

/** The placeholder of a composer in the sessions view: no handles there. */
export const SESSIONS_COMPOSER_PLACEHOLDER = "Ask anything. / commands, # files";

/**
 * Whom the main composer's message is for: in the sessions view exactly the
 * main session, whatever the text names; in the classic view nobody fixed
 * (undefined), so the message goes where today's rules send it (an @handle
 * to that member; none to the main session in a main-session chat, the old
 * rules in an old chat). `sessionsMainId`: the main session, only while the
 * chat is shown in the sessions view.
 */
export function mainComposerTargetIds(sessionsMainId: string | undefined): string[] | undefined {
  return sessionsMainId ? [sessionsMainId] : undefined;
}

/**
 * The main composer in the sessions view (docs/main-session.md): it writes to
 * the main session whatever its text names, so it offers no members to
 * mention (commands and files stay), and it carries the main session's model
 * chip, as T3 Code's composer does. It has no "N active runs" pill (the
 * Waiting line and the side panel name and stop the members); while the main
 * session itself runs, its send button stops that run when there is nothing
 * to send. The classic view's composer is as before.
 */
export function sessionsComposerProps(
  mainSessionId: string | undefined,
  renderMemberChip?: (participantId: string) => ReactNode,
  main?: { runIds: readonly string[]; onStopRun?: (runId: string) => void }
): Partial<Pick<ChatComposerProps, "participants" | "placeholder" | "footerChip" | "activeRunCount" | "onStopAllRuns" | "stop">> {
  if (!mainSessionId) {
    return {};
  }
  const runIds = main?.runIds ?? [];
  const onStopRun = main?.onStopRun;
  return {
    participants: NO_MENTIONS,
    placeholder: SESSIONS_COMPOSER_PLACEHOLDER,
    footerChip: renderMemberChip?.(mainSessionId),
    activeRunCount: 0,
    onStopAllRuns: undefined,
    stop: runIds.length > 0 && onStopRun
      ? { label: "Stop the main session", onStop: () => runIds.forEach((runId) => onStopRun(runId)) }
      : undefined
  };
}

/** What a member's model chip says: its provider's logo, its model, its
 *  reasoning effort ("Haiku 5.5 · Low"). Without a model of its own, the one
 *  its CLI runs on by default, else the CLI's name (memberDefaultModelName). */
export function ChatMemberModelChipLabel(props: { participant: ChatParticipant; defaultModelLabel?: string }): JSX.Element {
  const { participant } = props;
  const explicit = participant.model?.trim() || props.defaultModelLabel;
  const cliDefault = useMemberDefaultModelName(participant, !explicit);
  const model = explicit || cliDefault;
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
