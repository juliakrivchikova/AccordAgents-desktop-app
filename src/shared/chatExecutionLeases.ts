export type ChatExecutorLeaseStatus = "active" | "released" | "reclaimed" | "conflict";

export interface ChatExecutorLeaseKey {
  conversationId: string;
  participantId: string;
  participantSessionId: string;
}

export interface ChatExecutorLease {
  key: ChatExecutorLeaseKey;
  leaseId: string;
  holderId: string;
  generation: number;
  status: ChatExecutorLeaseStatus;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export type ChatExecutorLeaseEvent =
  | {
    kind: "executor.lease.claimed";
    key: ChatExecutorLeaseKey;
    leaseId: string;
    holderId: string;
    generation: number;
    acquiredAt: string;
    heartbeatAt: string;
    expiresAt: string;
  }
  | {
    kind: "executor.lease.heartbeat";
    key: ChatExecutorLeaseKey;
    leaseId: string;
    holderId: string;
    generation: number;
    heartbeatAt: string;
    expiresAt: string;
  }
  | {
    kind: "executor.lease.released";
    key: ChatExecutorLeaseKey;
    leaseId: string;
    holderId: string;
    generation: number;
    releasedAt: string;
  }
  | {
    kind: "executor.lease.reclaimed";
    key: ChatExecutorLeaseKey;
    previousLeaseId: string;
    leaseId: string;
    holderId: string;
    generation: number;
    acquiredAt: string;
    heartbeatAt: string;
    expiresAt: string;
  };

export interface ChatExecutorOwnedEvent {
  leaseId: string;
  leaseGeneration: number;
}

export type ChatExecutorOwnedEventStatus = "current" | "superseded";

export interface ChatExecutorLeaseFoldResult {
  lease?: ChatExecutorLease;
  conflicts: string[];
}

export function foldExecutorLeaseEvents(events: ChatExecutorLeaseEvent[]): ChatExecutorLeaseFoldResult {
  let lease: ChatExecutorLease | undefined;
  const conflicts: string[] = [];
  for (const event of events) {
    if (!lease) {
      if (event.kind === "executor.lease.claimed") {
        lease = {
          key: event.key,
          leaseId: event.leaseId,
          holderId: event.holderId,
          generation: event.generation,
          status: "active",
          acquiredAt: event.acquiredAt,
          heartbeatAt: event.heartbeatAt,
          expiresAt: event.expiresAt
        };
      } else {
        conflicts.push(`Lease event ${event.kind} arrived before a claim.`);
      }
      continue;
    }
    if (!sameLeaseKey(lease.key, event.key)) {
      conflicts.push(`Lease event ${event.kind} belongs to a different session.`);
      continue;
    }
    if (event.generation < lease.generation) {
      continue;
    }
    if (event.generation > lease.generation + 1) {
      conflicts.push(`Lease generation jumped from ${lease.generation} to ${event.generation}.`);
    }
    if (event.kind === "executor.lease.claimed") {
      conflicts.push(`Lease generation ${event.generation} was claimed while generation ${lease.generation} exists.`);
      continue;
    }
    if (event.kind === "executor.lease.heartbeat") {
      if (event.leaseId !== lease.leaseId) {
        conflicts.push(`Heartbeat for generation ${event.generation} used a stale lease id.`);
        continue;
      }
      lease = {
        ...lease,
        holderId: event.holderId,
        heartbeatAt: event.heartbeatAt,
        expiresAt: event.expiresAt,
        status: "active"
      };
      continue;
    }
    if (event.kind === "executor.lease.released") {
      if (event.leaseId !== lease.leaseId) {
        conflicts.push(`Release for generation ${event.generation} used a stale lease id.`);
        continue;
      }
      lease = { ...lease, status: "released" };
      continue;
    }
    lease = {
      key: event.key,
      leaseId: event.leaseId,
      holderId: event.holderId,
      generation: event.generation,
      status: "reclaimed",
      acquiredAt: event.acquiredAt,
      heartbeatAt: event.heartbeatAt,
      expiresAt: event.expiresAt
    };
  }
  return { lease, conflicts };
}

export function canReclaimExecutorLease(lease: ChatExecutorLease, nowIso: string): boolean {
  return lease.status === "active" && Date.parse(nowIso) > Date.parse(lease.expiresAt);
}

export function classifyExecutorOwnedEvent(
  lease: ChatExecutorLease | undefined,
  event: ChatExecutorOwnedEvent
): ChatExecutorOwnedEventStatus {
  if (!lease) {
    return "superseded";
  }
  return event.leaseId === lease.leaseId && event.leaseGeneration === lease.generation
    ? "current"
    : "superseded";
}

function sameLeaseKey(left: ChatExecutorLeaseKey, right: ChatExecutorLeaseKey): boolean {
  return left.conversationId === right.conversationId &&
    left.participantId === right.participantId &&
    left.participantSessionId === right.participantSessionId;
}
