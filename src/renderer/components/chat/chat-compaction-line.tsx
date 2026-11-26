import { ArrowsInSimpleIcon } from "@phosphor-icons/react";
import { sessionsCompactionLineOf, sessionsCompactionLineText } from "../../../shared/mainSession";
import type { ChatMessage, ChatParticipant } from "../../../shared/types";

/** The line a finished compaction leaves in its member's session in the
 *  sessions view, as Claude Code leaves "Conversation compacted" in its
 *  transcript: the member's CLI's words, muted, with the app's compaction
 *  icon in place of the CLI's glyph. Nothing to press. */
export function ChatCompactionLine(props: {
  message: Pick<ChatMessage, "id" | "role" | "metadata">;
  participants?: readonly ChatParticipant[];
}): JSX.Element | null {
  const line = sessionsCompactionLineOf(props.message);
  if (!line) return null;
  const kind = props.participants?.find((participant) => participant.id === line.participantId)?.kind;
  return (
    <div data-message-id={props.message.id} className="chat-compaction-line">
      <ArrowsInSimpleIcon size={14} aria-hidden="true" />
      <span>{sessionsCompactionLineText(kind)}</span>
    </div>
  );
}
