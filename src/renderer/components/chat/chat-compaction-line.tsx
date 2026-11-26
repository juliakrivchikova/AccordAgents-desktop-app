import { ArrowsInSimpleIcon } from "@phosphor-icons/react";
import { sessionsCompactionLineWords } from "../../../shared/mainSession";
import type { ChatMessage, ChatParticipant } from "../../../shared/types";

/** The line a finished compaction leaves in its member's session in the
 *  sessions view, as Claude Code leaves "Conversation compacted" in its
 *  transcript: the member's CLI's words, muted, with the app's compaction
 *  icon in place of the CLI's glyph. Nothing to press. */
export function ChatCompactionLine(props: {
  message: Pick<ChatMessage, "id" | "role" | "metadata">;
  participants?: readonly ChatParticipant[];
}): JSX.Element | null {
  const words = sessionsCompactionLineWords(props.message, props.participants);
  if (!words) return null;
  return (
    <div data-message-id={props.message.id} className="chat-compaction-line">
      <ArrowsInSimpleIcon size={14} aria-hidden="true" />
      <span>{words}</span>
    </div>
  );
}
