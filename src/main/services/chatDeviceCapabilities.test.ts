import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDeviceEventAcceptance,
  foldChatDeviceCapabilityEvents,
  type ChatDeviceCapabilityEvent
} from "../../shared/chatDeviceCapabilities";
import type { ChatEventEnvelope } from "../../shared/chatEvents";

test("device capability grants accept only scoped conversation writes", () => {
  const state = foldChatDeviceCapabilityEvents([
    grant({ conversationId: "conversation-1" })
  ]);

  assert.equal(classifyDeviceEventAcceptance(state, {
    event: deviceEvent({ conversationId: "conversation-1" }),
    conversationId: "conversation-1",
    requireWrite: true,
    now: now()
  }), "accepted");
  assert.equal(classifyDeviceEventAcceptance(state, {
    event: deviceEvent({ conversationId: "conversation-2", logScopeId: "conversation-2" }),
    conversationId: "conversation-2",
    requireWrite: true,
    now: now()
  }), "missing-capability");
});

test("device capability grants can require cloud-run permission", () => {
  const state = foldChatDeviceCapabilityEvents([
    grant({ canRunCloudParticipants: false })
  ]);

  assert.equal(classifyDeviceEventAcceptance(state, {
    event: deviceEvent(),
    conversationId: "conversation-1",
    requireCloudRun: true,
    now: now()
  }), "missing-capability");
});

test("expired capability grants reject device events visibly", () => {
  const state = foldChatDeviceCapabilityEvents([
    grant({ expiresAt: "2026-08-06T00:00:00.000Z" })
  ]);

  assert.equal(classifyDeviceEventAcceptance(state, {
    event: deviceEvent(),
    conversationId: "conversation-1",
    requireWrite: true,
    now: new Date("2026-08-06T00:00:01.000Z")
  }), "capability-expired");
});

test("revocation rejects only events after the revocation effective logical timestamp", () => {
  const state = foldChatDeviceCapabilityEvents([
    grant({}),
    revoke({ effectiveAfterLogicalTs: "0000000000000002:device-phone:conversation-1" })
  ]);

  assert.equal(classifyDeviceEventAcceptance(state, {
    event: deviceEvent({ originSeq: 2, logicalTs: "0000000000000002:device-phone:conversation-1" }),
    conversationId: "conversation-1",
    requireWrite: true,
    now: now()
  }), "accepted");
  assert.equal(classifyDeviceEventAcceptance(state, {
    event: deviceEvent({ originSeq: 3, logicalTs: "0000000000000003:device-phone:conversation-1" }),
    conversationId: "conversation-1",
    requireWrite: true,
    now: now()
  }), "revoked");
});

interface GrantOverrides {
  conversationId: string;
  canRunCloudParticipants: boolean;
  expiresAt: string;
}

function grant(overrides: Partial<GrantOverrides>): ChatDeviceCapabilityEvent {
  const conversationId = overrides.conversationId ?? "conversation-1";
  return {
    eventId: "grant-event",
    conversationId,
    logScopeId: conversationId,
    originId: "device-desktop",
    originSeq: 1,
    logicalTs: "0000000000000001:device-desktop:conversation-1",
    kind: "device.capability.granted",
    payload: {
      grantId: "grant-phone",
      deviceOriginId: "device-phone",
      deviceKeyId: "key-phone",
      capabilities: [{
        scope: "conversation",
        conversationId,
        canRead: true,
        canWrite: true,
        canRunCloudParticipants: overrides.canRunCloudParticipants ?? true
      }],
      grantedAt: "2026-08-06T00:00:00.000Z",
      ...(overrides.expiresAt ? { expiresAt: overrides.expiresAt } : {})
    },
    payloadHash: "payload-grant",
    eventHash: "hash-grant",
    createdAt: "2026-08-06T00:00:00.000Z"
  };
}

function revoke(overrides: Partial<Extract<ChatDeviceCapabilityEvent["payload"], { revokedAt: string }>>): ChatDeviceCapabilityEvent {
  return {
    eventId: "revoke-event",
    conversationId: "conversation-1",
    logScopeId: "conversation-1",
    originId: "device-desktop",
    originSeq: 2,
    logicalTs: "0000000000000002:device-desktop:conversation-1",
    kind: "device.capability.revoked",
    payload: {
      grantId: "grant-phone",
      deviceOriginId: "device-phone",
      revokedAt: "2026-08-06T00:01:00.000Z",
      ...overrides
    },
    payloadHash: "payload-revoke",
    eventHash: "hash-revoke",
    createdAt: "2026-08-06T00:01:00.000Z"
  };
}

function deviceEvent(overrides: Partial<ChatEventEnvelope> = {}): ChatEventEnvelope {
  return {
    eventId: "phone-event",
    conversationId: "conversation-1",
    logScopeId: "conversation-1",
    originId: "device-phone",
    originSeq: 1,
    logicalTs: "0000000000000001:device-phone:conversation-1",
    kind: "message.created",
    payload: { content: "hello" },
    payloadHash: "payload-phone",
    eventHash: "hash-phone",
    createdAt: "2026-08-06T00:00:00.000Z",
    ...overrides
  };
}

function now(): Date {
  return new Date("2026-08-06T00:00:00.000Z");
}
