import assert from "node:assert/strict";
import test from "node:test";
import type { ChatExecutionLeaseMetadata, ChatParticipant, ChatParticipantSession, Conversation, RemoteRunHandle } from "../../shared/types";
import { ChatService } from "./chat";

const NOW = "2026-08-07T00:00:00.000Z";

test("chat executor leases persist and release by participant execution session", () => {
  const service = Object.create(ChatService.prototype) as any;
  const participant = chatParticipant();
  const session = chatSession(participant);
  const conversation = chatConversation(participant, session);

  const lease = service.acquireParticipantExecutorLease(conversation, participant, session, "desktop") as ChatExecutionLeaseMetadata;

  assert.equal(typeof session.executionSessionId, "string");
  assert.equal(lease.conversationId, conversation.id);
  assert.equal(lease.participantId, participant.id);
  assert.equal(lease.participantSessionId, session.executionSessionId);
  assert.equal(lease.holderId, "desktop");
  assert.equal(lease.generation, 1);
  assert.equal(lease.status, "active");

  const stored = Object.values(service.executorLeasesByKey(conversation)) as ChatExecutionLeaseMetadata[];
  assert.equal(stored.length, 1);
  assert.equal(stored[0].leaseId, lease.leaseId);

  service.releaseParticipantExecutorLease(conversation, lease);

  const released = (Object.values(service.executorLeasesByKey(conversation)) as ChatExecutionLeaseMetadata[])[0];
  assert.equal(released.status, "released");
  assert.equal(typeof released.releasedAt, "string");
});

test("chat executor lease generation fences stale remote-run output metadata", () => {
  const service = Object.create(ChatService.prototype) as any;
  const participant = chatParticipant();
  const session = chatSession(participant);
  const conversation = chatConversation(participant, session);

  const first = service.acquireParticipantExecutorLease(conversation, participant, session, "remote:aws:host-a");
  conversation.metadata.remoteRunHandles = {
    "run-1": remoteRunHandle(conversation, participant, first)
  };
  assert.equal(service.remoteRunExecutionLease(conversation, "run-1")?.leaseId, first.leaseId);
  assert.equal(service.executorOwnedEventIsCurrent(conversation, first), true);

  expireLease(service, conversation, first);
  const second = service.acquireParticipantExecutorLease(conversation, participant, session, "remote:aws:host-b");

  assert.equal(second.generation, 2);
  assert.equal(second.status, "reclaimed");
  assert.equal(service.executorOwnedEventIsCurrent(conversation, first), false);
  assert.equal(service.executorOwnedEventIsCurrent(conversation, second), true);
});

test("chat executor leases block takeover while the current executor lease is live", () => {
  const service = Object.create(ChatService.prototype) as any;
  const participant = chatParticipant();
  const session = chatSession(participant);
  const conversation = chatConversation(participant, session);

  service.acquireParticipantExecutorLease(conversation, participant, session, "desktop");

  assert.throws(
    () => service.acquireParticipantExecutorLease(conversation, participant, session, "remote:aws:host-a"),
    /waiting for current executor desktop/
  );
});

test("chat executor leases renew same-holder heartbeat without changing generation", () => {
  const service = Object.create(ChatService.prototype) as any;
  const participant = chatParticipant();
  const session = chatSession(participant);
  const conversation = chatConversation(participant, session);

  const first = service.acquireParticipantExecutorLease(conversation, participant, session, "desktop") as ChatExecutionLeaseMetadata;
  const second = service.acquireParticipantExecutorLease(conversation, participant, session, "desktop") as ChatExecutionLeaseMetadata;

  assert.equal(second.leaseId, first.leaseId);
  assert.equal(second.generation, 1);
  assert.equal(second.status, "active");
});

test("chat executor lease heartbeat extends the current holder lease", () => {
  const service = Object.create(ChatService.prototype) as any;
  const participant = chatParticipant();
  const session = chatSession(participant);
  const conversation = chatConversation(participant, session);

  const first = service.acquireParticipantExecutorLease(conversation, participant, session, "desktop") as ChatExecutionLeaseMetadata;
  const renewed = service.heartbeatParticipantExecutorLease(conversation, first, "2026-08-07T00:01:00.000Z") as ChatExecutionLeaseMetadata;

  assert.equal(renewed.leaseId, first.leaseId);
  assert.equal(renewed.generation, 1);
  assert.equal(renewed.status, "active");
  assert.equal(renewed.heartbeatAt, "2026-08-07T00:01:00.000Z");
  assert.equal(renewed.expiresAt, "2026-08-07T00:16:00.000Z");
  assert.equal(service.executorOwnedEventIsCurrent(conversation, first), true);
});

test("chat executor lease heartbeat cannot revive a superseded generation", () => {
  const service = Object.create(ChatService.prototype) as any;
  const participant = chatParticipant();
  const session = chatSession(participant);
  const conversation = chatConversation(participant, session);

  const first = service.acquireParticipantExecutorLease(conversation, participant, session, "desktop") as ChatExecutionLeaseMetadata;
  expireLease(service, conversation, first);
  const second = service.acquireParticipantExecutorLease(conversation, participant, session, "remote:aws:host-a") as ChatExecutionLeaseMetadata;
  const renewed = service.heartbeatParticipantExecutorLease(conversation, first, "2026-08-07T00:01:00.000Z");

  assert.equal(renewed, undefined);
  assert.equal(service.executorOwnedEventIsCurrent(conversation, first), false);
  assert.equal(service.executorOwnedEventIsCurrent(conversation, second), true);
});

function expireLease(
  service: any,
  conversation: Conversation,
  lease: ChatExecutionLeaseMetadata
): void {
  const storageKey = service.executorLeaseStorageKey(lease);
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

function remoteRunHandle(
  conversation: Conversation,
  participant: ChatParticipant,
  executionLease: RemoteRunHandle["executionLease"]
): RemoteRunHandle {
  return {
    runId: "run-1",
    conversationId: conversation.id,
    participantId: participant.id,
    participantHandle: participant.handle,
    worker: {
      host: "host-a",
      user: "ubuntu"
    },
    status: "running",
    startedAt: NOW,
    updatedAt: NOW,
    executionLease
  };
}
