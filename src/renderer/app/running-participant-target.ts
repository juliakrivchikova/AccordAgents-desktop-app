import type { ChatActivityItem, ChatRunningMessageTarget, Conversation } from "../../shared/types";
import { runningMessageForParticipant, runningMessageTarget } from "../../shared/chatRunningMessage";

/** Where a running member's turn in progress is. Asked of the whole chat,
 *  whatever the open page holds: the page can miss the turn (a long turn's
 *  message can be far above it), hold only a later turn waiting behind it, or
 *  not show the member running at all when the turn runs on another device
 *  (that run is known here only by its message). The loaded page is the
 *  fallback when that read fails. Undefined when the member is not running,
 *  so the caller keeps what it opened before. */
export async function runningParticipantTarget(
  conversation: Conversation,
  participantId: string
): Promise<ChatRunningMessageTarget | undefined> {
  try {
    return await window.consensus.findRunningParticipantMessage(conversation.id, participantId);
  } catch {
    const loaded = runningMessageForParticipant(conversation, participantId);
    return loaded ? runningMessageTarget(loaded) : undefined;
  }
}

/** A running member's Activity row opens the member's turn in progress, the
 *  same message every other way of opening a running member opens. */
export async function withRunningActivityTarget(item: ChatActivityItem, conversation: Conversation): Promise<ChatActivityItem> {
  const participantId = item.kind === "run" && item.status === "running" ? item.participant?.id?.trim() : undefined;
  if (!participantId) {
    return item;
  }
  const target = await runningParticipantTarget(conversation, participantId);
  if (!target) {
    return item;
  }
  return {
    ...item,
    target: {
      ...item.target,
      messageId: target.messageId,
      threadRootId: target.threadRootId,
      messageIsApproximate: undefined
    }
  };
}
