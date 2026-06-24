import { isChatMessageHiddenFromTimeline } from "./chatTimelineVisibility";
import type { ChatMessage, ChatParticipantRequestBatch, Conversation } from "./types";

export function isInferredParticipantRequestCarrier(message: Pick<ChatMessage, "metadata">): boolean {
  return message.metadata?.participantRequest?.source === "inferred";
}

export function inferredParticipantRequestSourceRootId(
  messages: readonly ChatMessage[],
  requestMessage: Pick<ChatMessage, "id" | "metadata">
): string | undefined {
  const batch = requestMessage.metadata?.participantRequest;
  if (batch?.source !== "inferred") {
    return undefined;
  }
  const sourceId = batch.triggerMessageId
    ?? requestMessage.metadata?.sourceMessageId
    ?? requestMessage.metadata?.parentMessageId;
  const sourceMessage = sourceId ? messages.find((message) => message.id === sourceId) : undefined;
  if (!sourceMessage) {
    return undefined;
  }
  return sourceMessage.metadata?.chatThreadRootId ?? sourceMessage.id;
}

export function participantRequestVisibleRootId(
  messages: readonly ChatMessage[],
  requestMessage: ChatMessage
): string {
  return inferredParticipantRequestSourceRootId(messages, requestMessage) ?? requestMessage.id;
}

export function chatInferredParticipantRequestBatchesByTrigger(conversation: Pick<Conversation, "messages">): Map<string, ChatParticipantRequestBatch[]> {
  const batches = new Map<string, ChatParticipantRequestBatch[]>();
  for (const message of conversation.messages) {
    const batch = message.metadata?.participantRequest;
    if (batch?.source !== "inferred" || !batch.triggerMessageId) {
      continue;
    }
    const current = batches.get(batch.triggerMessageId) ?? [];
    current.push(batch);
    batches.set(batch.triggerMessageId, current);
  }
  return batches;
}

export function chatParticipantRequestReplyRootMap(conversation: Pick<Conversation, "messages">): Map<string, string> {
  const roots = new Map<string, string>();
  for (const message of conversation.messages) {
    const batch = message.metadata?.participantRequest;
    if (!batch) {
      continue;
    }
    const rootId = participantRequestVisibleRootId(conversation.messages, message);
    if (batch.autoResumeMessageId) {
      roots.set(batch.autoResumeMessageId, rootId);
    }
    for (const item of batch.items) {
      if (item.replyMessageId) {
        roots.set(item.replyMessageId, rootId);
      }
    }
  }
  return roots;
}

export function chatMessageHiddenFromTimeline(
  conversation: Pick<Conversation, "messages">,
  message: ChatMessage,
  options: { showSystemMessages?: boolean } = {}
): boolean {
  if (isInferredParticipantRequestCarrier(message)) {
    return Boolean(inferredParticipantRequestSourceRootId(conversation.messages, message));
  }
  return isChatMessageHiddenFromTimeline(message, options);
}

export function chatMessageVisualThreadRootId(
  conversation: Pick<Conversation, "messages">,
  message: ChatMessage,
  participantRequestReplyRoots = chatParticipantRequestReplyRootMap(conversation)
): string | undefined {
  const participantRequestRootId = participantRequestReplyRoots.get(message.id);
  if (participantRequestRootId) {
    return participantRequestRootId;
  }
  if (isInferredParticipantRequestCarrier(message)) {
    return inferredParticipantRequestSourceRootId(conversation.messages, message);
  }
  if (message.metadata?.chatThreadRootId) {
    return message.metadata.chatThreadRootId;
  }
  if (message.role === "user" && message.metadata?.parentMessageId) {
    return message.metadata.threadId ?? message.metadata.parentMessageId;
  }
  return undefined;
}

export function normalizeInferredParticipantRequestThreads(conversation: Conversation): boolean {
  const messagesById = new Map(conversation.messages.map((message) => [message.id, message]));
  let changed = false;

  for (const requestMessage of conversation.messages) {
    if (!isInferredParticipantRequestCarrier(requestMessage)) {
      continue;
    }
    const sourceRootId = inferredParticipantRequestSourceRootId(conversation.messages, requestMessage);
    if (!sourceRootId) {
      continue;
    }

    const metadata = requestMessage.metadata ?? {};
    const nextMetadata = {
      ...metadata,
      hiddenFromTimeline: true,
      chatThreadRootId: sourceRootId
    };
    if (metadata.hiddenFromTimeline !== true || metadata.chatThreadRootId !== sourceRootId) {
      requestMessage.metadata = nextMetadata;
      changed = true;
    }

    for (const message of conversation.messages) {
      if (message.id === requestMessage.id || message.metadata?.chatThreadRootId !== requestMessage.id) {
        continue;
      }
      message.metadata = {
        ...message.metadata,
        chatThreadRootId: sourceRootId
      };
      changed = true;
    }

    const batch = requestMessage.metadata?.participantRequest;
    const autoResumeMessage = batch?.autoResumeMessageId ? messagesById.get(batch.autoResumeMessageId) : undefined;
    if (autoResumeMessage && autoResumeMessage.metadata?.chatThreadRootId !== sourceRootId) {
      autoResumeMessage.metadata = {
        ...autoResumeMessage.metadata,
        chatThreadRootId: sourceRootId
      };
      changed = true;
    }

    for (const item of batch?.items ?? []) {
      const reply = item.replyMessageId ? messagesById.get(item.replyMessageId) : undefined;
      if (!reply || reply.metadata?.chatThreadRootId === sourceRootId) {
        continue;
      }
      reply.metadata = {
        ...reply.metadata,
        chatThreadRootId: sourceRootId
      };
      changed = true;
    }
  }

  return changed;
}
