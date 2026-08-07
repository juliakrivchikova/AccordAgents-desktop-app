import type { ChatEventEnvelope } from "./chatEvents";
import type { ChatMessage, Conversation } from "./types";

export type ChatConversationEventKind =
  | "conversation.imported"
  | "message.created"
  | "message.updated"
  | "conversation.metadata.updated";

export interface ChatConversationImportedPayload {
  conversation: Conversation;
  importedAt: string;
  source: "legacy-storage";
}

export interface ChatMessageCreatedPayload {
  message: ChatMessage;
}

export interface ChatMessageUpdatedPayload {
  message: ChatMessage;
}

export interface ChatConversationMetadataUpdatedPayload {
  metadata: Conversation["metadata"];
  updatedAt?: string;
}

export type ChatConversationEventPayload =
  | ChatConversationImportedPayload
  | ChatMessageCreatedPayload
  | ChatMessageUpdatedPayload
  | ChatConversationMetadataUpdatedPayload;

export type ChatConversationEventEnvelope = ChatEventEnvelope<ChatConversationEventPayload> & {
  kind: ChatConversationEventKind;
};

export interface ChatEventVisibleScopeGap {
  originId: string;
  logScopeId: string;
  fromSeq: number;
  toSeq: number;
}

export interface ChatEventForkConflict {
  originId: string;
  logScopeId: string;
  originSeq: number;
  eventIds: string[];
}

export interface ChatConversationFoldResult {
  conversation?: Conversation;
  appliedEventIds: string[];
  gaps: ChatEventVisibleScopeGap[];
  forks: ChatEventForkConflict[];
}

export interface ChatConversationFoldOptions {
  conversationId?: string;
  logScopeId?: string;
}

export function foldChatConversationEvents(
  events: ChatEventEnvelope[],
  options: ChatConversationFoldOptions = {}
): ChatConversationFoldResult {
  const scoped = visibleContiguousEvents(events.filter((event) =>
    (!options.conversationId || event.conversationId === options.conversationId) &&
      (!options.logScopeId || event.logScopeId === options.logScopeId)
  ));
  const ordered = scoped.events.sort(compareEventsForProjection);
  let conversation: Conversation | undefined;
  const appliedEventIds: string[] = [];
  for (const event of ordered) {
    if (event.kind === "conversation.imported" && isConversationImportedPayload(event.payload)) {
      conversation = cloneConversation(event.payload.conversation);
      appliedEventIds.push(event.eventId);
      continue;
    }
    if (!conversation) {
      continue;
    }
    const payload = event.payload;
    if (event.kind === "message.created" && isMessagePayload(payload)) {
      if (!conversation.messages.some((message) => message.id === payload.message.id)) {
        conversation.messages.push(cloneMessage(payload.message));
      }
      appliedEventIds.push(event.eventId);
      continue;
    }
    if (event.kind === "message.updated" && isMessagePayload(payload)) {
      const index = conversation.messages.findIndex((message) => message.id === payload.message.id);
      if (index >= 0) {
        conversation.messages[index] = cloneMessage(payload.message);
      }
      appliedEventIds.push(event.eventId);
      continue;
    }
    if (event.kind === "conversation.metadata.updated" && isMetadataPayload(payload)) {
      conversation.metadata = {
        ...conversation.metadata,
        ...payload.metadata
      };
      if (payload.updatedAt) {
        conversation.updatedAt = payload.updatedAt;
      }
      appliedEventIds.push(event.eventId);
    }
  }
  return {
    conversation,
    appliedEventIds,
    gaps: scoped.gaps,
    forks: scoped.forks
  };
}

function visibleContiguousEvents(events: ChatEventEnvelope[]): {
  events: ChatEventEnvelope[];
  gaps: ChatEventVisibleScopeGap[];
  forks: ChatEventForkConflict[];
} {
  const byScope = new Map<string, ChatEventEnvelope[]>();
  for (const event of events) {
    const key = `${event.originId}\0${event.logScopeId}`;
    byScope.set(key, [...(byScope.get(key) ?? []), event]);
  }
  const visible: ChatEventEnvelope[] = [];
  const gaps: ChatEventVisibleScopeGap[] = [];
  const forks: ChatEventForkConflict[] = [];
  for (const scopeEvents of byScope.values()) {
    const bySeq = new Map<number, ChatEventEnvelope[]>();
    for (const event of scopeEvents) {
      bySeq.set(event.originSeq, [...(bySeq.get(event.originSeq) ?? []), event]);
    }
    const sortedSeqs = [...bySeq.keys()].sort((left, right) => left - right);
    let expected = 1;
    for (const seq of sortedSeqs) {
      const seqEvents = bySeq.get(seq) ?? [];
      if (seq > expected) {
        gaps.push({
          originId: seqEvents[0]?.originId ?? "",
          logScopeId: seqEvents[0]?.logScopeId ?? "",
          fromSeq: expected,
          toSeq: seq - 1
        });
        break;
      }
      if (seq < expected) {
        continue;
      }
      const uniqueHashes = new Set(seqEvents.map((event) => event.eventHash));
      if (uniqueHashes.size > 1) {
        forks.push({
          originId: seqEvents[0].originId,
          logScopeId: seqEvents[0].logScopeId,
          originSeq: seq,
          eventIds: seqEvents.map((event) => event.eventId).sort()
        });
        break;
      }
      visible.push(seqEvents[0]);
      expected = seq + 1;
    }
  }
  return { events: visible, gaps, forks };
}

function compareEventsForProjection(left: ChatEventEnvelope, right: ChatEventEnvelope): number {
  return left.logicalTs.localeCompare(right.logicalTs) ||
    left.originId.localeCompare(right.originId) ||
    left.logScopeId.localeCompare(right.logScopeId) ||
    left.originSeq - right.originSeq ||
    left.eventId.localeCompare(right.eventId);
}

function cloneConversation(conversation: Conversation): Conversation {
  return JSON.parse(JSON.stringify(conversation)) as Conversation;
}

function cloneMessage(message: ChatMessage): ChatMessage {
  return JSON.parse(JSON.stringify(message)) as ChatMessage;
}

function isConversationImportedPayload(value: unknown): value is ChatConversationImportedPayload {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as { source?: unknown }).source === "legacy-storage" &&
      (value as { conversation?: unknown }).conversation &&
      typeof (value as { importedAt?: unknown }).importedAt === "string"
  );
}

function isMessagePayload(value: unknown): value is ChatMessageCreatedPayload | ChatMessageUpdatedPayload {
  const message = value && typeof value === "object" && !Array.isArray(value)
    ? (value as { message?: unknown }).message
    : undefined;
  return Boolean(
    message &&
      typeof message === "object" &&
      !Array.isArray(message) &&
      typeof (message as { id?: unknown }).id === "string" &&
      typeof (message as { createdAt?: unknown }).createdAt === "string"
  );
}

function isMetadataPayload(value: unknown): value is ChatConversationMetadataUpdatedPayload {
  const metadata = value && typeof value === "object" && !Array.isArray(value)
    ? (value as { metadata?: unknown }).metadata
    : undefined;
  return Boolean(metadata && typeof metadata === "object" && !Array.isArray(metadata));
}
