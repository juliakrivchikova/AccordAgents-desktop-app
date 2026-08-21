import assert from "node:assert/strict";
import test from "node:test";
import type { ChatEventEnvelope } from "../../shared/chatEvents";
import { collectMobileMailboxOutboxEvents } from "./mobileMailboxOutbox";

test("collectMobileMailboxOutboxEvents skips stale route events without blocking current replay", async () => {
  const acceptedFulfilled: string[] = [];
  const events = await collectMobileMailboxOutboxEvents([
    mailboxOutboxEvent({
      eventId: "stale-mobile-event",
      conversationId: "old-conversation",
      content: "@codex stale"
    }),
    mailboxOutboxEvent({
      eventId: "current-mobile-event",
      conversationId: "current-conversation",
      content: "@codex current"
    })
  ], {
    acceptMailboxMessageEvent: () => false,
    acceptFulfilledMobileOutboxEvent: (event) => {
      acceptedFulfilled.push(event.eventId);
    },
    hasAcceptedMobileEvent: () => false,
    hasMobileMailboxResultForMobileEvent: () => false,
    isConversationAllowed: (conversationId) => conversationId === "current-conversation"
  });

  assert.deepEqual(events, [{
    eventId: "current-mobile-event",
    conversationId: "current-conversation",
    createdAt: "2026-08-13T00:00:00.000Z",
    payload: { content: "@codex current" }
  }]);
  assert.deepEqual(acceptedFulfilled, []);
});

test("collectMobileMailboxOutboxEvents carries run.cancel.requested to desktop without message execution claims", async () => {
  const claimAttempts: string[] = [];
  const events = await collectMobileMailboxOutboxEvents([
    mailboxRunCancelEvent({
      eventId: "mobile-cancel-1",
      conversationId: "current-conversation",
      runId: "participant-run-1"
    })
  ], {
    acceptMailboxMessageEvent: () => false,
    acceptMobileOutboxEnvelope: () => true,
    acceptFulfilledMobileOutboxEvent: () => undefined,
    hasAcceptedMobileEvent: () => false,
    hasMobileMailboxResultForMobileEvent: () => false,
    tryAcquireMobileEventExecution: (event) => {
      claimAttempts.push(event.eventId);
      return true;
    },
    isConversationAllowed: () => true
  });

  assert.deepEqual(events, [{
    eventId: "mobile-cancel-1",
    conversationId: "current-conversation",
    kind: "run.cancel.requested",
    createdAt: "2026-08-13T00:00:00.000Z",
    payload: { runId: "participant-run-1" }
  }]);
  assert.deepEqual(claimAttempts, []);
});

test("collectMobileMailboxOutboxEvents skips a run cancellation already accepted by desktop", async () => {
  const acceptedChecks: string[] = [];
  const events = await collectMobileMailboxOutboxEvents([
    mailboxRunCancelEvent({
      eventId: "mobile-cancel-accepted",
      conversationId: "current-conversation",
      runId: "participant-run-finished"
    })
  ], {
    acceptMailboxMessageEvent: () => false,
    acceptMobileOutboxEnvelope: () => true,
    acceptFulfilledMobileOutboxEvent: () => undefined,
    hasAcceptedMobileEvent: (_conversationId, eventId) => {
      acceptedChecks.push(eventId);
      return true;
    },
    hasMobileMailboxResultForMobileEvent: () => false,
    tryAcquireMobileEventExecution: () => {
      throw new Error("accepted cancellation must not acquire a message execution claim");
    },
    isConversationAllowed: () => true
  });

  assert.deepEqual(events, []);
  assert.deepEqual(acceptedChecks, ["mobile-cancel-accepted"]);
});

test("collectMobileMailboxOutboxEvents skips revoked or stale pairing envelopes before claiming", async () => {
  const checked: string[] = [];
  const claimAttempts: string[] = [];
  const acceptedFulfilled: string[] = [];
  const events = await collectMobileMailboxOutboxEvents([
    mailboxOutboxEvent({
      eventId: "revoked-mobile-event",
      conversationId: "current-conversation",
      content: "@codex should not run"
    })
  ], {
    acceptMailboxMessageEvent: () => false,
    acceptMobileOutboxEnvelope: (event) => {
      checked.push(event.eventId);
      return false;
    },
    acceptFulfilledMobileOutboxEvent: (event) => {
      acceptedFulfilled.push(event.eventId);
    },
    hasAcceptedMobileEvent: () => false,
    hasMobileMailboxResultForMobileEvent: () => false,
    tryAcquireMobileEventExecution: (event) => {
      claimAttempts.push(event.eventId);
      return true;
    },
    isConversationAllowed: () => true
  });

  assert.deepEqual(events, []);
  assert.deepEqual(checked, ["revoked-mobile-event"]);
  assert.deepEqual(claimAttempts, []);
  assert.deepEqual(acceptedFulfilled, []);
});

test("collectMobileMailboxOutboxEvents imports fulfilled mobile outbox without rerunning it", async () => {
  const acceptedFulfilled: string[] = [];
  const events = await collectMobileMailboxOutboxEvents([
    mailboxOutboxEvent({
      eventId: "mobile-event-1",
      conversationId: "current-conversation",
      content: "@codex current"
    }),
    mailboxParticipantResultEvent({
      eventId: "result-event-1",
      conversationId: "current-conversation",
      mobileEventId: "mobile-event-1"
    })
  ], {
    acceptMailboxMessageEvent: () => false,
    acceptFulfilledMobileOutboxEvent: (event) => {
      acceptedFulfilled.push(event.eventId);
    },
    hasAcceptedMobileEvent: () => false,
    hasMobileMailboxResultForMobileEvent: () => false,
    isConversationAllowed: () => true
  });

  assert.deepEqual(events, []);
  assert.deepEqual(acceptedFulfilled, ["mobile-event-1"]);
});

test("collectMobileMailboxOutboxEvents imports cloud-claimed mobile outbox without rerunning it", async () => {
  const acceptedFulfilled: string[] = [];
  const events = await collectMobileMailboxOutboxEvents([
    mailboxOutboxEvent({
      eventId: "mobile-event-claimed",
      conversationId: "current-conversation",
      content: "@codex current"
    }),
    mailboxTimelineEvent({
      eventId: "running-event-1",
      conversationId: "current-conversation",
      mobileEventId: "mobile-event-claimed",
      status: "pending",
      createdAt: new Date().toISOString()
    })
  ], {
    acceptMailboxMessageEvent: () => false,
    acceptFulfilledMobileOutboxEvent: (event) => {
      acceptedFulfilled.push(event.eventId);
    },
    hasAcceptedMobileEvent: () => false,
    hasMobileMailboxResultForMobileEvent: () => false,
    isConversationAllowed: () => true
  });

  assert.deepEqual(events, []);
  assert.deepEqual(acceptedFulfilled, ["mobile-event-claimed"]);
});

test("collectMobileMailboxOutboxEvents imports mobile outbox when execution claim is owned elsewhere", async () => {
  const acceptedFulfilled: string[] = [];
  const claimAttempts: string[] = [];
  const events = await collectMobileMailboxOutboxEvents([
    mailboxOutboxEvent({
      eventId: "mobile-event-owned",
      conversationId: "current-conversation",
      content: "@codex current"
    })
  ], {
    acceptMailboxMessageEvent: () => false,
    acceptFulfilledMobileOutboxEvent: (event) => {
      acceptedFulfilled.push(event.eventId);
    },
    hasAcceptedMobileEvent: () => false,
    hasMobileMailboxResultForMobileEvent: () => false,
    tryAcquireMobileEventExecution: (event) => {
      claimAttempts.push(event.eventId);
      return false;
    },
    isConversationAllowed: () => true
  });

  assert.deepEqual(events, []);
  assert.deepEqual(claimAttempts, ["mobile-event-owned"]);
  assert.deepEqual(acceptedFulfilled, ["mobile-event-owned"]);
});

test("collectMobileMailboxOutboxEvents lets desktop reclaim expired cloud runner claims", async () => {
  const acceptedFulfilled: string[] = [];
  const events = await collectMobileMailboxOutboxEvents([
    mailboxOutboxEvent({
      eventId: "mobile-event-expired",
      conversationId: "current-conversation",
      content: "@codex current"
    }),
    mailboxTimelineEvent({
      eventId: "running-event-expired",
      conversationId: "current-conversation",
      mobileEventId: "mobile-event-expired",
      status: "pending",
      createdAt: "2020-01-01T00:00:00.000Z"
    })
  ], {
    acceptMailboxMessageEvent: () => false,
    acceptFulfilledMobileOutboxEvent: (event) => {
      acceptedFulfilled.push(event.eventId);
    },
    hasAcceptedMobileEvent: () => false,
    hasMobileMailboxResultForMobileEvent: () => false,
    isConversationAllowed: () => true
  });

  assert.deepEqual(events, [{
    eventId: "mobile-event-expired",
    conversationId: "current-conversation",
    createdAt: "2026-08-13T00:00:00.000Z",
    payload: { content: "@codex current" }
  }]);
  assert.deepEqual(acceptedFulfilled, []);
});

test("collectMobileMailboxOutboxEvents skips stale terminal results before strict import", async () => {
  const acceptedTerminal: string[] = [];
  const acceptedFulfilled: string[] = [];
  const events = await collectMobileMailboxOutboxEvents([
    mailboxParticipantResultEvent({
      eventId: "old-result-event",
      conversationId: "old-conversation",
      mobileEventId: "old-mobile-event"
    }),
    mailboxOutboxEvent({
      eventId: "current-mobile-event",
      conversationId: "current-conversation",
      content: "@codex current"
    }),
    mailboxParticipantResultEvent({
      eventId: "current-result-event",
      conversationId: "current-conversation",
      mobileEventId: "current-mobile-event"
    })
  ], {
    acceptMailboxMessageEvent: (event) => {
      const envelope = event as ChatEventEnvelope;
      if (envelope.conversationId === "old-conversation") {
        throw new Error("stale terminal event reached strict importer");
      }
      if (envelope.eventId === "current-result-event") {
        acceptedTerminal.push(envelope.eventId);
        return true;
      }
      return false;
    },
    acceptFulfilledMobileOutboxEvent: (event) => {
      acceptedFulfilled.push(event.eventId);
    },
    hasAcceptedMobileEvent: () => false,
    hasMobileMailboxResultForMobileEvent: () => false,
    isConversationAllowed: (conversationId) => conversationId === "current-conversation"
  });

  assert.deepEqual(events, []);
  assert.deepEqual(acceptedFulfilled, ["current-mobile-event"]);
  assert.deepEqual(acceptedTerminal, ["current-result-event"]);
});

function mailboxOutboxEvent(input: {
  eventId: string;
  conversationId: string;
  content: string;
}): ChatEventEnvelope<{ content: string }> {
  return {
    eventId: input.eventId,
    conversationId: input.conversationId,
    logScopeId: input.conversationId,
    originId: "mobile-test",
    originSeq: 1,
    logicalTs: `0000000000000001:mobile-test:${input.conversationId}`,
    kind: "message.created",
    payload: { content: input.content },
    payloadHash: `sha256:${input.eventId}:payload`,
    eventHash: `sha256:${input.eventId}:event`,
    createdAt: "2026-08-13T00:00:00.000Z"
  };
}

function mailboxRunCancelEvent(input: {
  eventId: string;
  conversationId: string;
  runId: string;
}): ChatEventEnvelope<{ runId: string }> {
  return {
    eventId: input.eventId,
    conversationId: input.conversationId,
    logScopeId: input.conversationId,
    originId: "mobile-test",
    originSeq: 1,
    logicalTs: `0000000000000001:mobile-test:${input.conversationId}`,
    kind: "run.cancel.requested",
    payload: { runId: input.runId },
    payloadHash: `sha256:${input.eventId}:payload`,
    eventHash: `sha256:${input.eventId}:event`,
    createdAt: "2026-08-13T00:00:00.000Z"
  };
}

function mailboxParticipantResultEvent(input: {
  eventId: string;
  conversationId: string;
  mobileEventId: string;
}): ChatEventEnvelope<{ message: unknown }> {
  return {
    eventId: input.eventId,
    conversationId: input.conversationId,
    logScopeId: input.conversationId,
    originId: "mobile-runner-test",
    originSeq: 2,
    logicalTs: `0000000000000002:mobile-runner-test:${input.conversationId}`,
    kind: "message.created",
    payload: {
      message: {
        id: "participant-result-1",
        role: "participant",
        participantLabel: "@codex",
        content: "done",
        status: "done",
        createdAt: "2026-08-13T00:00:01.000Z",
        metadata: {
          runId: `mobile-${input.mobileEventId}`,
          mobileEventId: input.mobileEventId
        }
      }
    },
    payloadHash: `sha256:${input.eventId}:payload`,
    eventHash: `sha256:${input.eventId}:event`,
    createdAt: "2026-08-13T00:00:01.000Z"
  };
}

function mailboxTimelineEvent(input: {
  eventId: string;
  conversationId: string;
  mobileEventId: string;
  status: "pending" | "done" | "error";
  createdAt: string;
}): ChatEventEnvelope<{ type: string; conversationId: string; events: unknown[] }> {
  return {
    eventId: input.eventId,
    conversationId: input.conversationId,
    logScopeId: input.conversationId,
    originId: "mobile-runner-test",
    originSeq: 3,
    logicalTs: `0000000000000003:mobile-runner-test:${input.conversationId}`,
    kind: "mobile.timeline.events",
    payload: {
      type: "mobile.timeline.events",
      conversationId: input.conversationId,
      events: [{
        id: `mobile-${input.mobileEventId}:codex`,
        role: "participant",
        participantLabel: "@codex",
        content: "@codex is running...",
        status: input.status,
        createdAt: input.createdAt,
        runId: `mobile-${input.mobileEventId}`,
        messageId: `mobile-${input.mobileEventId}:codex`,
        mobileEventId: input.mobileEventId
      }]
    },
    payloadHash: `sha256:${input.eventId}:payload`,
    eventHash: `sha256:${input.eventId}:event`,
    createdAt: input.createdAt
  };
}
