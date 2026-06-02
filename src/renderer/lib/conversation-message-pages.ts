import type {
  ChatMessage,
  Conversation,
  ConversationMessagePage,
  ConversationMessagePageInfo
} from "../../shared/types";

export const CONVERSATION_MESSAGE_PAGE_SIZE = 80;

export function fullConversationMessagePageInfo(conversation: Conversation): ConversationMessagePageInfo {
  return {
    oldestSequence: conversation.messages.length > 0 ? 0 : undefined,
    newestSequence: conversation.messages.length > 0 ? conversation.messages.length - 1 : undefined,
    hasMoreBefore: false,
    totalMessages: conversation.messages.length
  };
}

export function prependMissingMessages(currentMessages: ChatMessage[], olderMessages: ChatMessage[]): ChatMessage[] {
  const currentIds = new Set(currentMessages.map((message) => message.id));
  const missingOlderMessages = olderMessages.filter((message) => !currentIds.has(message.id));
  return [...missingOlderMessages, ...currentMessages];
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
