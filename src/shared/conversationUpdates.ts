import type {
  ChatActivityItem,
  ChatMessage,
  Conversation,
  ConversationMessagePageInfo,
  ConversationUpdate
} from "./types";

/** Newest messages every delta update carries regardless of what changed. The
 *  renderer pages messages in windows of the same size (see
 *  `CONVERSATION_MESSAGE_PAGE_SIZE`), so a window opened from storage and the
 *  next delta describe the same stretch of the conversation. */
export const CONVERSATION_UPDATE_TAIL_SIZE = 80;

export interface AppliedConversationUpdate {
  conversation: Conversation;
  /** Messages the conversation holds in total, whatever the window shows. */
  totalMessages: number;
  /** How the window was produced; decides how page info is derived. */
  source: "full" | "trimmed" | "delta";
}

/** The update without its delta descriptor, for consumers that only read the
 *  conversation fields. */
export function conversationFromUpdate(update: ConversationUpdate): Conversation {
  if (!update.messageDelta) {
    return update;
  }
  const { messageDelta: _messageDelta, ...conversation } = update;
  return conversation;
}

/**
 * Merges a `conversations:updated` payload into the messages a window already
 * holds.
 *
 * A full update replaces everything — except that on a chat whose window is
 * a partial page, only as many newest messages are kept as the window had
 * (never fewer than one page), so one full snapshot does not turn an
 * 80-message window into the whole history and make every later update pay
 * for it.
 *
 * A delta update replaces the messages it carries by id, drops the removed
 * ones and re-anchors the newest window. Messages the delta does not mention
 * stay as they were. A changed message the window never loaded is taken only
 * when it falls inside the loaded stretch; anything older lives in storage and
 * arrives when the user pages back, so splicing it in would break the
 * window's continuity.
 */
export function applyConversationUpdate(
  current: Conversation | undefined,
  update: ConversationUpdate
): AppliedConversationUpdate {
  const delta = update.messageDelta;
  const sameConversation = Boolean(current && current.id === update.id);
  if (!delta) {
    const conversation = conversationFromUpdate(update);
    const total = conversation.messages.length;
    if (sameConversation && current && conversation.kind === "chat" && current.messages.length < total) {
      const keep = Math.max(current.messages.length, CONVERSATION_UPDATE_TAIL_SIZE);
      if (keep < total) {
        return {
          conversation: { ...conversation, messages: conversation.messages.slice(total - keep) },
          totalMessages: total,
          source: "trimmed"
        };
      }
    }
    return { conversation, totalMessages: total, source: "full" };
  }
  const tailStart = Math.max(0, update.messages.length - Math.max(0, delta.tailCount));
  const tail = update.messages.slice(tailStart);
  if (!sameConversation || !current) {
    // Nothing to merge into: the carried messages are all this window has.
    return {
      conversation: { ...conversationFromUpdate(update), messages: update.messages },
      totalMessages: Math.max(delta.totalMessages, update.messages.length),
      source: "delta"
    };
  }
  const removedIds = new Set(delta.removedIds);
  const changedOlder = update.messages.slice(0, tailStart);
  const tailIds = new Set(tail.map((message) => message.id));
  const changedById = new Map(changedOlder.map((message) => [message.id, message]));
  const currentIds = new Set(current.messages.map((message) => message.id));
  const kept = current.messages
    .filter((message) => !removedIds.has(message.id) && !tailIds.has(message.id))
    .map((message) => changedById.get(message.id) ?? message);
  const oldestLoadedAt = kept.length > 0 ? Date.parse(kept[0].createdAt) : Number.POSITIVE_INFINITY;
  const inserted = changedOlder.filter((message) =>
    !currentIds.has(message.id) &&
    !tailIds.has(message.id) &&
    !removedIds.has(message.id) &&
    Date.parse(message.createdAt) >= oldestLoadedAt
  );
  const older = inserted.length > 0 ? insertByCreatedAt(kept, inserted) : kept;
  const messages = [...older, ...tail];
  return {
    conversation: { ...conversationFromUpdate(update), messages },
    totalMessages: Math.max(delta.totalMessages, messages.length),
    source: "delta"
  };
}

/** Page info for a window produced by `applyConversationUpdate`. A delta keeps
 *  the oldest loaded sequence the page loader established (the window's start
 *  did not move); a trimmed full snapshot is exactly the newest messages, so
 *  its start follows from the count. */
export function messagePageAfterUpdate(
  previous: ConversationMessagePageInfo | undefined,
  applied: AppliedConversationUpdate
): ConversationMessagePageInfo {
  const loaded = applied.conversation.messages.length;
  const total = applied.totalMessages;
  if (applied.source === "full" || loaded >= total) {
    return fullListMessagePageInfo(loaded);
  }
  const contiguousStart = total - loaded;
  const oldestSequence = applied.source === "delta" && previous?.oldestSequence !== undefined
    ? Math.min(previous.oldestSequence, contiguousStart)
    : contiguousStart;
  return {
    totalMessages: total,
    hasMoreBefore: oldestSequence > 0,
    oldestSequence: loaded > 0 ? oldestSequence : undefined,
    newestSequence: loaded > 0 ? total - 1 : undefined
  };
}

export function fullListMessagePageInfo(count: number): ConversationMessagePageInfo {
  return {
    oldestSequence: count > 0 ? 0 : undefined,
    newestSequence: count > 0 ? count - 1 : undefined,
    hasMoreBefore: false,
    totalMessages: count
  };
}

/**
 * Activity items whose source message the update did not carry. A delta cannot
 * say anything about those messages, so whatever an earlier full snapshot or
 * activity refresh derived from them stands until a later update mentions them.
 * Items for messages the delta removed are dropped with the message. Run items
 * come from conversation metadata and approval items from pending-approvals
 * metadata, both always present, so those are always recomputed.
 */
export function chatActivityItemsForUnknownMessages(
  items: ChatActivityItem[],
  conversationId: string,
  knownMessageIds: Set<string>,
  removedMessageIds: Iterable<string> = []
): ChatActivityItem[] {
  const removed = new Set(removedMessageIds);
  return items.filter((item) => {
    if (item.conversationId !== conversationId || item.kind === "run" || item.kind === "approval") {
      return false;
    }
    const messageId = item.target.messageId ?? item.target.sourceMessageId;
    return typeof messageId === "string" && messageId.length > 0 && !knownMessageIds.has(messageId) && !removed.has(messageId);
  });
}

function insertByCreatedAt(base: ChatMessage[], inserted: ChatMessage[]): ChatMessage[] {
  const result = [...base];
  for (const message of inserted) {
    const time = Date.parse(message.createdAt);
    let index = result.length;
    for (let candidate = 0; candidate < result.length; candidate += 1) {
      if (Date.parse(result[candidate].createdAt) > time) {
        index = candidate;
        break;
      }
    }
    result.splice(index, 0, message);
  }
  return result;
}
