import assert from "node:assert/strict";
import test from "node:test";
import type { ChatExecutionLeaseMetadata, ChatParticipant, ChatParticipantSession, Conversation } from "../../shared/types";
import { ExecutorLeases } from "./chat/sessions/executorLeases";
import { executorLeasesByKey, executorLeaseStorageKey, executorOwnedEventIsCurrent, heartbeatParticipantExecutorLease } from "./chat/sessions/leaseRecords";

const NOW = "2026-08-07T00:00:00.000Z";

test("chat executor leases persist and release by participant execution session", () => {
  const leases = new ExecutorLeases();
  const participant = chatParticipant();
  const session = chatSession(participant);
  const conversation = chatConversation(participant, session);

  const lease = leases.acquireParticipantExecutorLease(conversation, participant, session, "desktop") as ChatExecutionLeaseMetadata;

  assert.equal(typeof session.executionSessionId, "string");
  assert.equal(lease.conversationId, conversation.id);
  assert.equal(lease.participantId, participant.id);
  assert.equal(lease.participantSessionId, session.executionSessionId);
  assert.equal(lease.holderId, "desktop");
  assert.equal(lease.generation, 1);
  assert.equal(lease.status, "active");

  const stored = Object.values(executorLeasesByKey(conversation)) as ChatExecutionLeaseMetadata[];
  assert.equal(stored.length, 1);
  assert.equal(stored[0].leaseId, lease.leaseId);

  leases.releaseParticipantExecutorLease(conversation, lease);

  const released = (Object.values(executorLeasesByKey(conversation)) as ChatExecutionLeaseMetadata[])[0];
  assert.equal(released.status, "released");
  assert.equal(typeof released.releasedAt, "string");
});

test("chat executor lease generation fences stale remote-run output metadata", () => {
  const leases = new ExecutorLeases();
  const participant = chatParticipant();
  const session = chatSession(participant);
  const conversation = chatConversation(participant, session);

  const first = leases.acquireParticipantExecutorLease(conversation, participant, session, "remote:aws:host-a");
  assert.equal(executorOwnedEventIsCurrent(conversation, first), true);

  expireLease(conversation, first);
  const second = leases.acquireParticipantExecutorLease(conversation, participant, session, "remote:aws:host-b");

  assert.equal(second.generation, 2);
  assert.equal(second.status, "reclaimed");
  assert.equal(executorOwnedEventIsCurrent(conversation, first), false);
  assert.equal(executorOwnedEventIsCurrent(conversation, second), true);
});

test("chat executor leases block takeover while the current executor lease is live", () => {
  const leases = new ExecutorLeases();
  const participant = chatParticipant();
  const session = chatSession(participant);
  const conversation = chatConversation(participant, session);

  leases.acquireParticipantExecutorLease(conversation, participant, session, "desktop");

  assert.throws(
    () => leases.acquireParticipantExecutorLease(conversation, participant, session, "remote:aws:host-a"),
    /waiting for current executor desktop/
  );
});

test("chat executor leases renew same-holder heartbeat without changing generation", () => {
  const leases = new ExecutorLeases();
  const participant = chatParticipant();
  const session = chatSession(participant);
  const conversation = chatConversation(participant, session);

  const first = leases.acquireParticipantExecutorLease(conversation, participant, session, "desktop") as ChatExecutionLeaseMetadata;
  const second = leases.acquireParticipantExecutorLease(conversation, participant, session, "desktop") as ChatExecutionLeaseMetadata;

  assert.equal(second.leaseId, first.leaseId);
  assert.equal(second.generation, 1);
  assert.equal(second.status, "active");
});

test("chat executor lease heartbeat extends the current holder lease", () => {
  const leases = new ExecutorLeases();
  const participant = chatParticipant();
  const session = chatSession(participant);
  const conversation = chatConversation(participant, session);

  const first = leases.acquireParticipantExecutorLease(conversation, participant, session, "desktop") as ChatExecutionLeaseMetadata;
  const renewed = heartbeatParticipantExecutorLease(conversation, first, "2026-08-07T00:01:00.000Z") as ChatExecutionLeaseMetadata;

  assert.equal(renewed.leaseId, first.leaseId);
  assert.equal(renewed.generation, 1);
  assert.equal(renewed.status, "active");
  assert.equal(renewed.heartbeatAt, "2026-08-07T00:01:00.000Z");
  assert.equal(renewed.expiresAt, "2026-08-07T00:16:00.000Z");
  assert.equal(executorOwnedEventIsCurrent(conversation, first), true);
});

test("chat executor lease heartbeat cannot revive a superseded generation", () => {
  const leases = new ExecutorLeases();
  const participant = chatParticipant();
  const session = chatSession(participant);
  const conversation = chatConversation(participant, session);

  const first = leases.acquireParticipantExecutorLease(conversation, participant, session, "desktop") as ChatExecutionLeaseMetadata;
  expireLease(conversation, first);
  const second = leases.acquireParticipantExecutorLease(conversation, participant, session, "remote:aws:host-a") as ChatExecutionLeaseMetadata;
  const renewed = heartbeatParticipantExecutorLease(conversation, first, "2026-08-07T00:01:00.000Z");

  assert.equal(renewed, undefined);
  assert.equal(executorOwnedEventIsCurrent(conversation, first), false);
  assert.equal(executorOwnedEventIsCurrent(conversation, second), true);
});

function expireLease(
  conversation: Conversation,
  lease: ChatExecutionLeaseMetadata
): void {
  const storageKey = executorLeaseStorageKey(lease);
  conversation.metadata.executorLeasesByKey = {
    ...(conversation.metadata.executorLeasesByKey as Record<string, ChatExecutionLeaseMetadata>),
    [storageKey]: {
      ...lease,
      expiresAt: "2000-01-01T00:00:00.000Z"
    }
  };
}

function chatParticipant(): ChatParticipant {
  return {
    id: "participant-1",
    handle: "codex",
    roleConfigId: "administrator",
    roleConfigVersion: 1,
    kind: "codex-cli",
    remoteExecution: "remote"
  };
}

function chatSession(participant: ChatParticipant): ChatParticipantSession {
  return {
    participantId: participant.id,
    sessionId: "provider-session-1",
    executionSessionId: "execution-session-1",
    roleConfigId: "administrator",
    roleConfigVersion: 1,
    participantKind: participant.kind,
    roleLabel: "Administrator",
    roleInstructions: "Answer directly.",
    updatedAt: NOW
  };
}

function chatConversation(participant: ChatParticipant, session: ChatParticipantSession): Conversation {
  return {
    id: "conversation-1",
    kind: "chat",
    title: "Lease test",
    repoPath: undefined,
    createdAt: NOW,
    updatedAt: NOW,
    messages: [],
    findings: [],
    metadata: {
      participants: [participant],
      participantSessions: [session]
    }
  };
}
