import { chatMessageVisualThreadRootId } from "../../shared/chatParticipantRequestThreads";
import type { ChatMessage, Conversation } from "../../shared/types";
import { isChatMessageHiddenInChat, isChatTopLevelMessage } from "../components/chat/chat-thread-data";

/** How many messages without a timeline row "Open in chat" goes past. */
export const TIMELINE_ANCHOR_MAX_HOPS = 4;

/**
 * Activity's "Open in chat" opens a row of the chat's main timeline. Some
 * targets have none: a hidden message (the User's pick on a choice card,
 * which a member's answer to a card on the main timeline follows; an
 * approval's control message; an app's trigger), or a reply drawn only in a
 * thread. Those go on to the message they belong to, loading it when it is
 * not loaded yet; when that reaches no row, the Activity item's own message
 * is tried the same way. Gives undefined only when neither reaches a row, so
 * the chat opens without a focus that can never land.
 */
export async function visibleTimelineAnchor(input: {
  conversation: Pick<Conversation, "messages">;
  messageId: string;
  fallbackMessageId?: string;
  /** Loads the page around a message; gives the loaded messages, or undefined when it cannot. */
  load: (messageId: string, messages: ChatMessage[]) => Promise<ChatMessage[] | undefined>;
}): Promise<string | undefined> {
  let messages = input.conversation.messages;
  const find = async (id: string): Promise<ChatMessage | undefined> => {
    const loaded = messages.find((message) => message.id === id);
    if (loaded) {
      return loaded;
    }
    const page = await input.load(id, messages);
    if (!page) {
      return undefined;
    }
    messages = page;
    return messages.find((message) => message.id === id);
  };
  const walk = async (startId: string, seen: Set<string>): Promise<string | undefined> => {
    let id = startId;
    for (let hop = 0; hop <= TIMELINE_ANCHOR_MAX_HOPS && !seen.has(id); hop += 1) {
      seen.add(id);
      const message = await find(id);
      if (!message) {
        return undefined;
      }
      if (isChatTopLevelMessage({ messages }, message)) {
        return id;
      }
      const next = belongsToMessageId({ messages }, message);
      if (!next) {
        return undefined;
      }
      id = next;
    }
    return undefined;
  };

  const seen = new Set<string>();
  const anchorId = await walk(input.messageId, seen);
  if (anchorId) {
    return anchorId;
  }
  const fallbackId = input.fallbackMessageId?.trim();
  return fallbackId ? walk(fallbackId, seen) : undefined;
}

/**
 * The message a message without a row belongs to. A hidden one: its thread's
 * root when it is in a thread, else the message it answers (the User's pick
 * answers its card; its threadId names the card's own conversation chain, not
 * the card). A reply drawn only in a thread: that thread's root.
 */
function belongsToMessageId(conversation: Pick<Conversation, "messages">, message: ChatMessage): string | undefined {
  const metadata = message.metadata;
  const candidates = isChatMessageHiddenInChat(conversation, message)
    // An Accord's document note is shown on the Accord's card, its launch.
    ? [metadata?.chatThreadRootId, metadata?.parentMessageId, metadata?.sourceMessageId, metadata?.accordLaunchMessageId]
    : [chatMessageVisualThreadRootId(conversation, message), metadata?.chatThreadRootId, metadata?.parentMessageId];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim() && value.trim() !== message.id) {
      return value.trim();
    }
  }
  return undefined;
}
