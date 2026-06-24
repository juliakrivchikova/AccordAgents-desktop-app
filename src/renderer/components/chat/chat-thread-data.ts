import {
  chatInferredParticipantRequestBatchesByTrigger as sharedInferredParticipantRequestBatchesByTrigger,
  chatMessageHiddenFromTimeline,
  chatMessageVisualThreadRootId,
  chatParticipantRequestReplyRootMap
} from "../../../shared/chatParticipantRequestThreads";
import type { ChatParticipantRequestBatch, Conversation } from "../../../shared/types";

const SHOW_CHAT_SYSTEM_MESSAGES = import.meta.env.VITE_ACCORD_AGENTS_SHOW_SYSTEM_MESSAGES === "1";

export function chatTopLevelMessages(conversation: Conversation): Conversation["messages"] {
  const participantRequestReplyRoots = chatParticipantRequestReplyRootMap(conversation);
  return conversation.messages.filter((message) =>
    !chatMessageHiddenFromTimeline(conversation, message, { showSystemMessages: SHOW_CHAT_SYSTEM_MESSAGES }) &&
    !chatMessageVisualThreadRootId(conversation, message, participantRequestReplyRoots)
  );
}

export function chatThreadSummaryMap(conversation: Conversation): Map<string, { replies: Conversation["messages"]; latestReplyAt?: string }> {
  const summaries = new Map<string, { replies: Conversation["messages"]; latestReplyAt?: string }>();
  const participantRequestReplyRoots = chatParticipantRequestReplyRootMap(conversation);
  for (const message of conversation.messages) {
    if (chatMessageHiddenFromTimeline(conversation, message, { showSystemMessages: SHOW_CHAT_SYSTEM_MESSAGES })) {
      continue;
    }
    const rootId = chatMessageVisualThreadRootId(conversation, message, participantRequestReplyRoots);
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

export function chatInferredParticipantRequestBatchesByTrigger(conversation: Conversation): Map<string, ChatParticipantRequestBatch[]> {
  return sharedInferredParticipantRequestBatchesByTrigger(conversation);
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
