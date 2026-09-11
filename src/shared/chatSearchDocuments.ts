import {
  chatMessageHiddenFromTimeline,
  chatMessageVisualThreadRootId,
  chatParticipantRequestReplyRootMap
} from "./chatParticipantRequestThreads";
import type { ChatMessage, ChatParticipant, Conversation } from "./types";

export interface ChatSearchTitleDocument {
  kind: "title";
  titleText: string;
}

export interface ChatSearchMessageDocument {
  kind: "message";
  messageId: string;
  threadRootId?: string;
  role: "user" | "participant";
  authorLabel: string;
  createdAt: string;
  body: string;
}

export type ChatSearchDocument = ChatSearchTitleDocument | ChatSearchMessageDocument;

export function buildChatSearchDocuments(
  conversation: Pick<Conversation, "title" | "messages" | "metadata">
): ChatSearchDocument[] {
  const participantLabels = new Map(
    chatParticipants(conversation.metadata).map((participant) => [participant.id, participant.handle] as const)
  );
  const participantRequestReplyRoots = chatParticipantRequestReplyRootMap(conversation);
  const messageDocuments = conversation.messages.flatMap<ChatSearchMessageDocument>((message) => {
    if (!isSearchableTimelineMessage(conversation, message)) {
      return [];
    }
    const body = message.content.trim();
    const threadRootId = chatMessageVisualThreadRootId(conversation, message, participantRequestReplyRoots);
    return [{
      kind: "message",
      messageId: message.id,
      ...(threadRootId ? { threadRootId } : {}),
      role: message.role,
      authorLabel: message.role === "user"
        ? "You"
        : message.participantLabel?.trim() || participantLabels.get(message.participantId ?? "") || "Participant",
      createdAt: message.createdAt,
      body
    }];
  });
  return [
    { kind: "title", titleText: conversation.title },
    ...messageDocuments
  ];
}

function isSearchableTimelineMessage(
  conversation: Pick<Conversation, "messages">,
  message: ChatMessage
): message is ChatMessage & { role: "user" | "participant" } {
  if (message.role !== "user" && message.role !== "participant") {
    return false;
  }
  if (message.status === "pending" || !message.content.trim()) {
    return false;
  }
  return !chatMessageHiddenFromTimeline(conversation, message);
}

function chatParticipants(metadata: Conversation["metadata"]): ChatParticipant[] {
  const participants = metadata.participants;
  return Array.isArray(participants)
    ? participants.filter((participant): participant is ChatParticipant =>
        Boolean(participant && typeof participant === "object" && typeof participant.id === "string")
      )
    : [];
}
