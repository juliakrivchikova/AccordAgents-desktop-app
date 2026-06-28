import type { ChatParticipant, Conversation } from "../../../shared/types";
import { avatarForMessage } from "../avatar/avatar";
import { CHAT_ASSISTANT_ROLE_ID, authorForMessage } from "../conversation/conversation-display";

export function chatReplyPreviewAvatars(
  replies: Conversation["messages"] | undefined,
  participants: ChatParticipant[] | undefined
): Array<{ id: string; avatar: ReturnType<typeof avatarForMessage> }> {
  const avatars: Array<{ id: string; avatar: ReturnType<typeof avatarForMessage> }> = [];
  const keys = new Set<string>();
  for (const reply of replies ?? []) {
    const replyAuthor = authorForMessage(reply, "chat");
    const replyParticipant = reply.participantId
      ? participants?.find((item) => item.id === reply.participantId)
      : reply.role === "system"
        ? participants?.find((item) => item.roleConfigId === CHAT_ASSISTANT_ROLE_ID)
        : undefined;
    const key = reply.participantId ? `participant:${reply.participantId}` : `${reply.role}:${replyAuthor}`;
    if (keys.has(key)) {
      continue;
    }
    keys.add(key);
    avatars.push({
      id: reply.id,
      avatar: avatarForMessage(reply, replyAuthor, replyParticipant)
    });
    if (avatars.length >= 3) {
      break;
    }
  }
  return avatars;
}
