import { randomUUID } from "node:crypto";
import type {
  ChatExecutionLeaseMetadata, ChatParticipant, ChatParticipantSession, Conversation, CloudRunStatus
} from "../../../../shared/types";
import type { ChatExecutorLeaseKey } from "../../../../shared/chatExecutionLeases";
import { CHAT_EXECUTOR_LEASE_TTL_MS } from "./constants";
import { isMetadataRecord } from "../compaction/contextUsage";

function normalizeExecutionLeaseMetadata(value: unknown): ChatExecutionLeaseMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Partial<ChatExecutionLeaseMetadata>;
  const conversationId = typeof record.conversationId === "string" ? record.conversationId.trim() : "";
  const participantId = typeof record.participantId === "string" ? record.participantId.trim() : "";
  const participantSessionId = typeof record.participantSessionId === "string" ? record.participantSessionId.trim() : "";
  const leaseId = typeof record.leaseId === "string" ? record.leaseId.trim() : "";
  const holderId = typeof record.holderId === "string" ? record.holderId.trim() : "";
  const generation = typeof record.generation === "number" && Number.isFinite(record.generation)
    ? Math.max(1, Math.floor(record.generation))
    : 0;
  const status = record.status === "active" || record.status === "released" ||
    record.status === "reclaimed" || record.status === "conflict"
    ? record.status
    : undefined;
  const acquiredAt = typeof record.acquiredAt === "string" ? record.acquiredAt : "";
  const heartbeatAt = typeof record.heartbeatAt === "string" ? record.heartbeatAt : "";
  const expiresAt = typeof record.expiresAt === "string" ? record.expiresAt : "";
  if (!conversationId || !participantId || !participantSessionId || !leaseId || !holderId || !generation || !status || !acquiredAt || !heartbeatAt || !expiresAt) {
    return undefined;
  }
  return {
    conversationId,
    participantId,
    participantSessionId,
    leaseId,
    holderId,
    generation,
    status,
    acquiredAt,
    heartbeatAt,
    expiresAt,
    releasedAt: typeof record.releasedAt === "string" ? record.releasedAt : undefined
  };
}

function normalizeCloudRunStatus(value: unknown): CloudRunStatus {
  return value === "completed" || value === "failed" || value === "cancelled" || value === "unknown"
    ? value
    : "running";
}

function normalizeOptionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : undefined;
}

export function participantExecutorLeaseKey(
  conversation: Conversation,
  participant: ChatParticipant,
  session: ChatParticipantSession
): ChatExecutorLeaseKey {
  if (!session.executionSessionId) {
    session.executionSessionId = randomUUID();
  }
  return {
    conversationId: conversation.id,
    participantId: participant.id,
    participantSessionId: session.executionSessionId
  };
}

export function executorLeaseStorageKey(key: ChatExecutorLeaseKey): string {
  return `${key.conversationId}:${key.participantId}:${key.participantSessionId}`;
}

export function executorLeasesByKey(conversation: Conversation): Record<string, ChatExecutionLeaseMetadata> {
  const raw = conversation.metadata.executorLeasesByKey;
  if (!isMetadataRecord(raw)) {
    return {};
  }
  const leases: Record<string, ChatExecutionLeaseMetadata> = {};
  for (const [key, value] of Object.entries(raw)) {
    const lease = normalizeExecutionLeaseMetadata(value);
    if (lease) {
      leases[key] = lease;
    }
  }
  return leases;
}

export function heartbeatParticipantExecutorLease(
  conversation: Conversation,
  lease: ChatExecutionLeaseMetadata | undefined,
  now = new Date().toISOString()
): ChatExecutionLeaseMetadata | undefined {
  if (!lease) {
    return undefined;
  }
  const storageKey = executorLeaseStorageKey(lease);
  const leases = executorLeasesByKey(conversation);
  const current = leases[storageKey];
  if (
    !current ||
    current.leaseId !== lease.leaseId ||
    current.generation !== lease.generation ||
    (current.status !== "active" && current.status !== "reclaimed")
  ) {
    return undefined;
  }
  const renewed: ChatExecutionLeaseMetadata = {
    ...current,
    heartbeatAt: now,
    expiresAt: new Date(Date.parse(now) + CHAT_EXECUTOR_LEASE_TTL_MS).toISOString()
  };
  conversation.metadata = {
    ...conversation.metadata,
    executorLeasesByKey: {
      ...leases,
      [storageKey]: renewed
    }
  };
  return renewed;
}

export function executionLeaseForRun(conversation: Conversation, runId: string): ChatExecutionLeaseMetadata | undefined {
  for (const message of conversation.messages) {
    if (message.metadata?.runId === runId) {
      const lease = normalizeExecutionLeaseMetadata(message.metadata.executionLease);
      if (lease) {
        return lease;
      }
    }
  }
  return undefined;
}

export function executorOwnedEventIsCurrent(
  conversation: Conversation,
  metadata: ChatExecutionLeaseMetadata | undefined
): boolean {
  if (!metadata) {
    return true;
  }
  const current = executorLeasesByKey(conversation)[executorLeaseStorageKey(metadata)];
  return Boolean(current && current.leaseId === metadata.leaseId && current.generation === metadata.generation);
}
