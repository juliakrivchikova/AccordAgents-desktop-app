import { randomUUID } from "node:crypto";
import type { ChatExecutionLeaseMetadata, ChatParticipant, ChatParticipantSession, Conversation } from "../../../../shared/types";
import { CHAT_EXECUTOR_LEASE_TTL_MS } from "./constants";
import { executorLeasesByKey, executorLeaseStorageKey, participantExecutorLeaseKey } from "./leaseRecords";

/** Which process may run a member's session. */
export class ExecutorLeases {
  /** Concurrent turns of one member share its executor lease (see
   *  reserveParticipantTurn); it is released when the last of them ends. */
  private readonly executorLeaseHolds = new Map<string, number>();

  acquireParticipantExecutorLease(
    conversation: Conversation,
    participant: ChatParticipant,
    session: ChatParticipantSession,
    holderId: string
  ): ChatExecutionLeaseMetadata {
    const key = participantExecutorLeaseKey(conversation, participant, session);
    const storageKey = executorLeaseStorageKey(key);
    const leases = executorLeasesByKey(conversation);
    const previous = leases[storageKey];
    const now = new Date().toISOString();
    const previousOwnsSession = previous?.status === "active" || previous?.status === "reclaimed";
    const previousExpiresAt = previous ? Date.parse(previous.expiresAt) : NaN;
    const previousExpired = previousOwnsSession && Number.isFinite(previousExpiresAt) && Date.parse(now) > previousExpiresAt;
    if (previousOwnsSession && !previousExpired) {
      if (previous.holderId === holderId) {
        const renewed: ChatExecutionLeaseMetadata = {
          ...previous,
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
        this.executorLeaseHolds.set(`${conversation.id}|${storageKey}`, (this.executorLeaseHolds.get(`${conversation.id}|${storageKey}`) ?? 0) + 1);
        return renewed;
      }
      throw new Error(`@${participant.handle} is waiting for current executor ${previous.holderId} until ${previous.expiresAt}.`);
    }
    const generation = previous ? previous.generation + 1 : 1;
    const lease: ChatExecutionLeaseMetadata = {
      ...key,
      leaseId: randomUUID(),
      holderId,
      generation,
      status: previousExpired ? "reclaimed" : "active",
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: new Date(Date.parse(now) + CHAT_EXECUTOR_LEASE_TTL_MS).toISOString()
    };
    conversation.metadata = {
      ...conversation.metadata,
      executorLeasesByKey: {
        ...leases,
        [storageKey]: lease
      }
    };
    // Another turn of the member may hold it through another copy of the chat.
    this.executorLeaseHolds.set(`${conversation.id}|${storageKey}`, (this.executorLeaseHolds.get(`${conversation.id}|${storageKey}`) ?? 0) + 1);
    return lease;
  }

  releaseParticipantExecutorLease(
    conversation: Conversation,
    lease: ChatExecutionLeaseMetadata | undefined
  ): void {
    if (!lease) {
      return;
    }
    const storageKey = executorLeaseStorageKey(lease);
    const holdKey = `${conversation.id}|${storageKey}`;
    const holds = (this.executorLeaseHolds.get(holdKey) ?? 1) - 1;
    if (holds > 0) {
      // Another turn of the same member still runs on this lease.
      this.executorLeaseHolds.set(holdKey, holds);
      return;
    }
    this.executorLeaseHolds.delete(holdKey);
    const leases = executorLeasesByKey(conversation);
    const current = leases[storageKey];
    if (!current || current.leaseId !== lease.leaseId || current.generation !== lease.generation) {
      return;
    }
    const releasedAt = new Date().toISOString();
    conversation.metadata = {
      ...conversation.metadata,
      executorLeasesByKey: {
        ...leases,
        [storageKey]: {
          ...current,
          status: "released",
          releasedAt,
          heartbeatAt: releasedAt,
          expiresAt: releasedAt
        }
      }
    };
  }
}
