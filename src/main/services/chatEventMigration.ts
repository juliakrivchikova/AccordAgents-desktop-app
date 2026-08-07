import type { ChatEventEnvelope } from "../../shared/chatEvents";
import {
  foldChatConversationEvents,
  type ChatConversationEventEnvelope
} from "../../shared/chatEventProjection";
import { stableJson } from "../../shared/stableJson";
import type { Conversation } from "../../shared/types";
import type { ChatEventLogService } from "./chatEventLog";
import type { StorageService } from "./storage";

export interface ChatConversationImportResult {
  status: "imported" | "already-imported";
  event?: ChatConversationEventEnvelope;
}

export interface ChatConversationProjectionDivergence {
  field: string;
  materialized: unknown;
  projected: unknown;
}

const CONVERSATION_PROJECTION_FIELDS = [
  "id",
  "title",
  "kind",
  "createdAt",
  "updatedAt",
  "repoPath",
  "findings",
  "metadata",
  "messages"
] as const;

export async function importConversationToEventLog(
  storage: StorageService,
  eventLog: ChatEventLogService,
  conversation: Conversation
): Promise<ChatConversationImportResult> {
  const existing = await storage.listChatEvents(conversation.id, conversation.id);
  const importEvent = existing.find((event) => event.kind === "conversation.imported") as
    | ChatConversationEventEnvelope
    | undefined;
  if (importEvent) {
    return { status: "already-imported", event: importEvent };
  }
  const result = await eventLog.appendLocalEvent({
    conversationId: conversation.id,
    logScopeId: conversation.id,
    kind: "conversation.imported",
    payload: {
      source: "legacy-storage",
      importedAt: new Date().toISOString(),
      conversation
    }
  });
  return {
    status: "imported",
    event: result.event as ChatConversationEventEnvelope
  };
}

export function detectChatConversationProjectionDivergence(
  materialized: Conversation,
  events: ChatEventEnvelope[]
): ChatConversationProjectionDivergence[] {
  const folded = foldChatConversationEvents(events, {
    conversationId: materialized.id,
    logScopeId: materialized.id
  });
  if (!folded.conversation) {
    return [{
      field: "conversation",
      materialized,
      projected: undefined
    }];
  }
  return CONVERSATION_PROJECTION_FIELDS.flatMap((field) => {
    const materializedValue = materialized[field];
    const projectedValue = folded.conversation?.[field];
    return stableJson(materializedValue) === stableJson(projectedValue)
      ? []
      : [{ field, materialized: materializedValue, projected: projectedValue }];
  });
}
