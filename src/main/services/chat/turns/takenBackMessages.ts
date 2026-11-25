import type { ChatMessage, ChatMessageMetadata } from "../../../../shared/types";

/**
 * The User takes a message back while it waits behind its member's turn (the
 * × on it, desktop and phone, or a Stop of everything that waits): as in the
 * member's own CLI, where a message taken out of the queue is never read, no
 * turn after it is given that message as chat it has not seen. It stays in the
 * chat as she wrote it.
 */

/** The mark of a reply that is ending before its turn began. */
export function takenBackMark(reply: ChatMessage): Pick<ChatMessageMetadata, "takenBack"> | undefined {
  const { queuedBehind, turnQueued, sourceMessageId } = reply.metadata ?? {};
  return (queuedBehind || turnQueued) && reply.participantId && sourceMessageId
    ? { takenBack: { participantId: reply.participantId, messageId: sourceMessageId } }
    : undefined;
}

/** The messages this member is not given: taken back from it, or from
 *  everyone they were for. */
export function takenBackMessageIds(messages: readonly ChatMessage[], participantId: string): ReadonlySet<string> {
  const takenBack = new Set<string>();
  const mine = new Set<string>();
  const taken = new Set<string>();
  for (const message of messages) {
    const mark = message.metadata?.takenBack;
    if (mark) {
      takenBack.add(mark.messageId);
      if (mark.participantId === participantId) mine.add(mark.messageId);
    }
  }
  if (takenBack.size === 0) return takenBack;
  for (const message of messages) {
    const source = message.metadata?.sourceMessageId;
    if (message.role === "participant" && source && !message.metadata?.takenBack) taken.add(source);
  }
  return new Set([...takenBack].filter((id) => mine.has(id) || !taken.has(id)));
}
