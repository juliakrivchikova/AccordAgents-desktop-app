import type {
  ChatMessage, ChatParticipant, Conversation, ConversationMessagePage, ConversationMessagePageInfo
} from "../../../../shared/types";
import type { SavedMessageRow } from "../types";

const DEFAULT_MESSAGE_PAGE_LIMIT = 80;
const MAX_MESSAGE_PAGE_LIMIT = 200;

export function clearLegacyAccordState(metadata: Conversation["metadata"]): Conversation["metadata"] {
  const policies = Array.isArray(metadata.appToolApprovalPolicies)
    ? metadata.appToolApprovalPolicies.filter((policy) =>
        Boolean(
          policy &&
          typeof policy === "object" &&
          !Array.isArray(policy) &&
          (policy as { capability?: unknown }).capability !== "participants.request" &&
          (policy as { accordLaunchId?: unknown }).accordLaunchId === undefined &&
          (policy as { expiresAt?: unknown }).expiresAt === undefined
        )
      )
    : undefined;
  const next = { ...metadata };
  delete next.accordLaunch;
  delete next.accordRun;
  if (policies) {
    next.appToolApprovalPolicies = policies;
  }
  return next;
}

export function hasPendingAppToolApprovals(conversation: Conversation): boolean {
  return Array.isArray(conversation.metadata.pendingAppToolApprovals) &&
    conversation.metadata.pendingAppToolApprovals.some((approval) =>
      approval &&
      typeof approval === "object" &&
      (approval as { status?: unknown }).status === "pending"
    );
}

export function pendingApprovalTriggerTargets(conversation: Conversation): Array<[string, string]> {
  if (!Array.isArray(conversation.metadata.pendingAppToolApprovals)) {
    return [];
  }
  return conversation.metadata.pendingAppToolApprovals.flatMap((approval) => {
    const messageId = approval?.status === "pending" ? approval.resumeContext?.triggerMessageId?.trim() : "";
    return messageId ? [[conversation.id, messageId] as [string, string]] : [];
  });
}

export function nonTerminalRemoteRunIds(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([runId, raw]) => {
    if (!runId || !raw || typeof raw !== "object" || Array.isArray(raw)) {
      return [];
    }
    const record = raw as Record<string, unknown>;
    const status = record.status;
    const worker = record.worker;
    const host = worker && typeof worker === "object" && !Array.isArray(worker)
      ? (worker as Record<string, unknown>).host
      : undefined;
    if (typeof host !== "string" || !host.trim()) {
      return [];
    }
    return status === "completed" || status === "failed" || status === "cancelled" ? [] : [runId];
  });
}

export function withRemoteRunMetadata(metadata: Record<string, unknown>, runIds: string[]): Record<string, unknown> {
  if (runIds.length === 0) {
    return metadata;
  }
  const preferred = typeof metadata.runId === "string" && runIds.includes(metadata.runId)
    ? metadata.runId
    : runIds[0];
  return {
    ...metadata,
    running: true,
    runId: preferred,
    activeRunIds: runIds
  };
}

export function normalizeMessagePageLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) {
    return DEFAULT_MESSAGE_PAGE_LIMIT;
  }
  return Math.max(1, Math.min(MAX_MESSAGE_PAGE_LIMIT, Math.floor(limit as number)));
}

export function isStoredChatParticipant(value: unknown): value is ChatParticipant {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { handle?: unknown }).handle === "string"
  );
}

export function normalizePositiveInteger(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

export function conversationBody(conversation: Conversation): Conversation {
  return {
    ...conversation,
    messages: []
  };
}

export function rowsMatchMessages(rows: SavedMessageRow[] | undefined, messages: ChatMessage[]): rows is SavedMessageRow[] {
  if (!rows || rows.length !== messages.length) {
    return false;
  }
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index].index !== index || rows[index].id !== messages[index].id) {
      return false;
    }
  }
  return true;
}

export function messagePageInfo(page: ConversationMessagePage): ConversationMessagePageInfo {
  return {
    oldestSequence: page.oldestSequence,
    newestSequence: page.newestSequence,
    hasMoreBefore: page.hasMoreBefore,
    totalMessages: page.totalMessages
  };
}
