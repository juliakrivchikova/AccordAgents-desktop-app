import assert from "node:assert/strict";
import test from "node:test";
import {
  canReclaimExecutorLease,
  classifyExecutorOwnedEvent,
  foldExecutorLeaseEvents,
  type ChatExecutorLeaseEvent,
  type ChatExecutorLeaseKey
} from "../../shared/chatExecutionLeases";

const KEY: ChatExecutorLeaseKey = {
  conversationId: "conversation-1",
  participantId: "participant-codex",
  participantSessionId: "session-1"
};

test("canReclaimExecutorLease allows reclaim after expiry", () => {
  const { lease, conflicts } = foldExecutorLeaseEvents([
    claim("desktop", 1, "lease-1", "2026-08-06T00:10:00.000Z")
  ]);

  assert.deepEqual(conflicts, []);
  assert.ok(lease);
  assert.equal(canReclaimExecutorLease(lease!, "2026-08-06T00:10:01.000Z"), true);
  assert.equal(canReclaimExecutorLease(lease!, "2026-08-06T00:09:59.000Z"), false);
});

test("foldExecutorLeaseEvents moves ownership through a visible reclaim generation", () => {
  const { lease, conflicts } = foldExecutorLeaseEvents([
    claim("desktop", 1, "lease-1", "2026-08-06T00:10:00.000Z"),
    {
      kind: "executor.lease.reclaimed",
      key: KEY,
      previousLeaseId: "lease-1",
      leaseId: "lease-2",
      holderId: "runner",
      generation: 2,
      acquiredAt: "2026-08-06T00:10:02.000Z",
      heartbeatAt: "2026-08-06T00:10:02.000Z",
      expiresAt: "2026-08-06T00:20:02.000Z"
    }
  ]);

  assert.deepEqual(conflicts, []);
  assert.equal(lease?.holderId, "runner");
  assert.equal(lease?.generation, 2);
  assert.equal(lease?.status, "reclaimed");
});

test("classifyExecutorOwnedEvent fences stale holder output after reclaim", () => {
  const { lease } = foldExecutorLeaseEvents([
    claim("desktop", 1, "lease-1", "2026-08-06T00:10:00.000Z"),
    {
      kind: "executor.lease.reclaimed",
      key: KEY,
      previousLeaseId: "lease-1",
      leaseId: "lease-2",
      holderId: "runner",
      generation: 2,
      acquiredAt: "2026-08-06T00:10:02.000Z",
      heartbeatAt: "2026-08-06T00:10:02.000Z",
      expiresAt: "2026-08-06T00:20:02.000Z"
    }
  ]);

  assert.equal(classifyExecutorOwnedEvent(lease, {
    leaseId: "lease-1",
    leaseGeneration: 1
  }), "superseded");
  assert.equal(classifyExecutorOwnedEvent(lease, {
    leaseId: "lease-2",
    leaseGeneration: 2
  }), "current");
});

test("foldExecutorLeaseEvents records same-generation duplicate claims as conflicts", () => {
  const { conflicts } = foldExecutorLeaseEvents([
    claim("desktop", 1, "lease-1", "2026-08-06T00:10:00.000Z"),
    claim("runner", 1, "lease-2", "2026-08-06T00:10:00.000Z")
  ]);

  assert.deepEqual(conflicts, ["Lease generation 1 was claimed while generation 1 exists."]);
});

function claim(
  holderId: string,
  generation: number,
  leaseId: string,
  expiresAt: string
): ChatExecutorLeaseEvent {
  return {
    kind: "executor.lease.claimed",
    key: KEY,
    leaseId,
    holderId,
    generation,
    acquiredAt: "2026-08-06T00:00:00.000Z",
    heartbeatAt: "2026-08-06T00:00:00.000Z",
    expiresAt
  };
}
