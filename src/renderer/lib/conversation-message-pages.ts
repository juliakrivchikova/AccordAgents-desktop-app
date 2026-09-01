import type {
  ChatMessage,
  Conversation,
  ConversationMessagePage,
  ConversationMessagePageInfo
} from "../../shared/types";
import { CONVERSATION_UPDATE_TAIL_SIZE, fullListMessagePageInfo } from "../../shared/conversationUpdates";

export const CONVERSATION_MESSAGE_PAGE_SIZE = CONVERSATION_UPDATE_TAIL_SIZE;

export function fullConversationMessagePageInfo(conversation: Conversation): ConversationMessagePageInfo {
  return fullListMessagePageInfo(conversation.messages.length);
}

export function prependMissingMessages(currentMessages: ChatMessage[], olderMessages: ChatMessage[]): ChatMessage[] {
  const currentIds = new Set(currentMessages.map((message) => message.id));
  const missingOlderMessages = olderMessages.filter((message) => !currentIds.has(message.id));
  return [...missingOlderMessages, ...currentMessages];
}

export function mergeMissingMessagesByCreatedAt(currentMessages: ChatMessage[], incomingMessages: ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const message of currentMessages) {
    byId.set(message.id, message);
  }
  for (const message of incomingMessages) {
    byId.set(message.id, message);
  }
  return [...byId.values()].sort((left, right) => {
    const timeDelta = Date.parse(left.createdAt) - Date.parse(right.createdAt);
    return timeDelta || left.id.localeCompare(right.id);
  });
}

export function mergeLoadedMessagePage(
  current: ConversationMessagePageInfo | undefined,
  page: ConversationMessagePage
): ConversationMessagePageInfo {
  return {
    oldestSequence: page.oldestSequence ?? current?.oldestSequence,
    newestSequence: current?.newestSequence ?? page.newestSequence,
    hasMoreBefore: page.hasMoreBefore,
    totalMessages: page.totalMessages
  };
}
