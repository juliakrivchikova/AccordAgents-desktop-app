import { X } from "lucide-react";
import type { ChatMessage, ChatParticipant, ChatTurnFinishedNoteMetadata } from "../../../shared/types";
import { Avatar, avatarForParticipant } from "../avatar/avatar";
import { useFocusChatMessage } from "../content/markdown-text";
import { IconButton } from "../primitives";
import { avatarForChatParticipant } from "./chat-avatars";
import { ChatMessageWhen } from "./chat-streaming";

// A member finished answering while its reply had other messages below it:
// at the end of the chat, a card with the reply's first line leads back to
// the reply, which stays where it was (the User, 2026-11-04). The cross takes
// the note away; it has no other actions.
export function ChatTurnFinishedNote(props: {
  message: Pick<ChatMessage, "id" | "content" | "createdAt">;
  note: ChatTurnFinishedNoteMetadata;
  participant?: ChatParticipant;
  onDismiss?: (messageId: string) => void;
}): JSX.Element {
  const { message, note, participant } = props;
  const focusMessage = useFocusChatMessage();
  const label = participant ? `@${participant.handle}` : note.participantLabel || "A member";
  const avatar = participant ? avatarForChatParticipant(participant, label) : avatarForParticipant(label, note.participantId);
  return (
    <article data-message-id={message.id} className="chat-turn-finished-note">
      <div className="chat-turn-finished-note-card">
        <button
          type="button"
          className="chat-turn-finished-note-open"
          title={`Go to ${label}'s reply`}
          // Marked as a move of the highlight, as a link to a message is: the
          // chat drops the highlight on any other click outside it.
          onClick={(event) => {
            event.preventDefault();
            focusMessage(note.messageId);
          }}
        >
          {/* The title says who: the avatar is not read out a second time. */}
          <span aria-hidden="true" className="chat-turn-finished-note-avatar-slot">
            <Avatar className="chat-turn-finished-note-avatar" spec={avatar} tooltip={null} />
          </span>
          <span className="chat-turn-finished-note-text">
            <span className="chat-turn-finished-note-title">
              <span className="chat-mention">{label}</span> finished answering · <ChatMessageWhen createdAt={message.createdAt} />
            </span>
            <span className="chat-turn-finished-note-preview">{message.content}</span>
          </span>
        </button>
        {props.onDismiss && (
          <IconButton
            className="chat-turn-finished-note-dismiss"
            size="xs"
            icon={X}
            label="Dismiss note"
            tooltip="Dismiss note"
            onClick={() => props.onDismiss?.(message.id)}
          />
        )}
      </div>
    </article>
  );
}
