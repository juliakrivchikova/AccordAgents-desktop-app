import type { ChatEventEnvelope } from "./chatEvents";
import type { Conversation } from "./types";

export type ChatConversationResidency = "syncable" | "local-only";

export function chatConversationResidency(conversation: Conversation): ChatConversationResidency {
  return conversation.metadata.residency === "local-only" ? "local-only" : "syncable";
}

export function assertChatEventsCanEnterSyncNetwork(
  conversation: Conversation,
  events: ChatEventEnvelope[]
): void {
  if (chatConversationResidency(conversation) !== "local-only") {
    return;
  }
  const blocked = events.find((event) => event.conversationId === conversation.id);
  if (blocked) {
    throw new Error(`Local-only conversation ${conversation.id} cannot serialize chat event ${blocked.eventId} to sync.`);
  }
}
