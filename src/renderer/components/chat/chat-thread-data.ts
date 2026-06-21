import { isChatMessageHiddenFromTimeline } from "../../../shared/chatTimelineVisibility";
import type { Conversation } from "../../../shared/types";

const SHOW_CHAT_SYSTEM_MESSAGES = import.meta.env.VITE_ACCORD_AGENTS_SHOW_SYSTEM_MESSAGES === "1";

export function chatTopLevelMessages(conversation: Conversation): Conversation["messages"] {
  const participantRequestReplyRoots = chatParticipantRequestReplyRootMap(conversation);
  return conversation.messages.filter((message) => !isHiddenChatMessage(message) && !chatVisualThreadRootId(message, participantRequestReplyRoots));
}

export function chatThreadSummaryMap(conversation: Conversation): Map<string, { replies: Conversation["messages"]; latestReplyAt?: string }> {
  const summaries = new Map<string, { replies: Conversation["messages"]; latestReplyAt?: string }>();
  const participantRequestReplyRoots = chatParticipantRequestReplyRootMap(conversation);
  for (const message of conversation.messages) {
    if (isHiddenChatMessage(message)) {
      continue;
    }
    const rootId = chatVisualThreadRootId(message, participantRequestReplyRoots);
    if (!rootId) {
      continue;
    }
    const summary = summaries.get(rootId) ?? { replies: [] };
    summary.replies.push(message);
    if (!summary.latestReplyAt || Date.parse(message.createdAt) > Date.parse(summary.latestReplyAt)) {
      summary.latestReplyAt = message.createdAt;
    }
    summaries.set(rootId, summary);
  }
  for (const summary of summaries.values()) {
    summary.replies.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  }
  return summaries;
}

export function chatContinuedMentionRequestIds(conversation: Conversation): Set<string> {
  return new Set(
    conversation.messages
      .filter((message) => message.metadata?.approvedContinuation && message.metadata.sourceMessageId)
      .map((message) => message.metadata?.sourceMessageId as string)
  );
}

export function formatChatReplyDate(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function formatChatChoiceReceiptTime(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true }).toUpperCase();
}

function isHiddenChatMessage(message: Conversation["messages"][number]): boolean {
  return isChatMessageHiddenFromTimeline(message, { showSystemMessages: SHOW_CHAT_SYSTEM_MESSAGES });
}

function chatParticipantRequestReplyRootMap(conversation: Conversation): Map<string, string> {
  const roots = new Map<string, string>();
  for (const message of conversation.messages) {
    const batch = message.metadata?.participantRequest;
    if (!batch) {
      continue;
    }
    for (const item of batch.items) {
      if (item.replyMessageId) {
        roots.set(item.replyMessageId, message.id);
      }
    }
  }
  return roots;
}

function chatVisualThreadRootId(message: Conversation["messages"][number], participantRequestReplyRoots = new Map<string, string>()): string | undefined {
  if (message.metadata?.chatThreadRootId) {
    return message.metadata.chatThreadRootId;
  }
  const participantRequestRootId = participantRequestReplyRoots.get(message.id);
  if (participantRequestRootId) {
    return participantRequestRootId;
  }
  if (message.role === "user" && message.metadata?.parentMessageId) {
    return message.metadata.threadId ?? message.metadata.parentMessageId;
  }
  return undefined;
}
