import {
  chatInferredParticipantRequestBatchesByTrigger as sharedInferredParticipantRequestBatchesByTrigger,
  chatMessageHiddenFromTimeline,
  chatMessageVisualThreadRootId,
  chatParticipantRequestReplyRootMap
} from "../../../shared/chatParticipantRequestThreads";
import { accordFoldedMessageIds } from "../../../shared/accordProgress";
import { turnFinishedNoteOf } from "../../../shared/turnFinishedNoteSource";
import type { ChatParticipantRequestBatch, Conversation } from "../../../shared/types";

const SHOW_CHAT_SYSTEM_MESSAGES = import.meta.env.VITE_ACCORD_AGENTS_SHOW_SYSTEM_MESSAGES === "1";

/** A message the chat draws no row for, on the timeline or in a thread. A
 *  note of an Accord's document is one: its steps are on the Accord's card or
 *  in the document (accordProgress.ts). */
export function isChatMessageHiddenInChat(conversation: Pick<Conversation, "messages">, message: Conversation["messages"][number]): boolean {
  return chatMessageHiddenFromTimeline(conversation, message, { showSystemMessages: SHOW_CHAT_SYSTEM_MESSAGES }) ||
    (message.role === "system" && accordFoldedMessageIds(conversation.messages).has(message.id));
}

/** A message drawn as a row of the chat's main timeline: shown, and not a thread reply. */
export function isChatTopLevelMessage(
  conversation: Pick<Conversation, "messages">,
  message: Conversation["messages"][number],
  participantRequestReplyRoots = chatParticipantRequestReplyRootMap(conversation)
): boolean {
  return !isChatMessageHiddenInChat(conversation, message) &&
    !chatMessageVisualThreadRootId(conversation, message, participantRequestReplyRoots);
}

export function chatTopLevelMessages(conversation: Conversation): Conversation["messages"] {
  const participantRequestReplyRoots = chatParticipantRequestReplyRootMap(conversation);
  return conversation.messages.filter((message) => isChatTopLevelMessage(conversation, message, participantRequestReplyRoots));
}

/** A thread under a message: every row the thread shows (`replies`), and
 *  the replies its count, avatars and time name (`countedReplies`,
 *  `latestReplyAt`) — a turn-finished note in the thread points back at a
 *  reply there and is no reply itself. */
export interface ChatThreadSummary {
  replies: Conversation["messages"];
  countedReplies: Conversation["messages"];
  latestReplyAt?: string;
}

export function chatThreadSummaryMap(conversation: Conversation): Map<string, ChatThreadSummary> {
  const summaries = new Map<string, ChatThreadSummary>();
  const participantRequestReplyRoots = chatParticipantRequestReplyRootMap(conversation);
  for (const message of conversation.messages) {
    if (isChatMessageHiddenInChat(conversation, message)) {
      continue;
    }
    const rootId = chatMessageVisualThreadRootId(conversation, message, participantRequestReplyRoots);
    if (!rootId) {
      continue;
    }
    const summary = summaries.get(rootId) ?? { replies: [], countedReplies: [] };
    summary.replies.push(message);
    if (!turnFinishedNoteOf(message)) {
      summary.countedReplies.push(message);
      if (!summary.latestReplyAt || Date.parse(message.createdAt) > Date.parse(summary.latestReplyAt)) {
        summary.latestReplyAt = message.createdAt;
      }
    }
    summaries.set(rootId, summary);
  }
  const byTime = (left: Conversation["messages"][number], right: Conversation["messages"][number]) =>
    Date.parse(left.createdAt) - Date.parse(right.createdAt);
  for (const summary of summaries.values()) {
    summary.replies.sort(byTime);
    summary.countedReplies.sort(byTime);
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
