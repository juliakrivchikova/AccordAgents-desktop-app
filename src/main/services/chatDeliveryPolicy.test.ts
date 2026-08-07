import assert from "node:assert/strict";
import test from "node:test";
import {
  createChatDeliveryPolicySnapshot,
  resolveChatDeliveryTargetsFromSnapshot
} from "../../shared/chatDeliveryPolicy";
import type { ChatMessage, ChatParticipant, Conversation } from "../../shared/types";

const OPTIONS = {
  administratorRoleId: "administrator",
  administratorHandles: ["manager"]
};

test("resolveChatDeliveryTargetsFromSnapshot waits when policy inputs are missing or stale", () => {
  const conversation = chatConversation([]);
  const snapshot = createChatDeliveryPolicySnapshot({
    conversationId: conversation.id,
    policyVersion: "policy-v1",
    participants: [participant("codex"), participant("manager", "administrator")],
    options: OPTIONS,
    createdAt: "2026-08-06T00:00:00.000Z"
  });

  assert.deepEqual(resolveChatDeliveryTargetsFromSnapshot({
    conversation,
    content: "@codex hello",
    requiredPolicyVersion: "policy-v1"
  }), {
    status: "waiting-for-policy-sync",
    requiredPolicyVersion: "policy-v1",
    reason: "missing-snapshot"
  });
  assert.deepEqual(resolveChatDeliveryTargetsFromSnapshot({
    conversation,
    content: "@codex hello",
    snapshot,
    requiredPolicyVersion: "policy-v2"
  }), {
    status: "waiting-for-policy-sync",
    requiredPolicyVersion: "policy-v2",
    availablePolicyVersion: "policy-v1",
    reason: "stale-snapshot"
  });
  assert.deepEqual(resolveChatDeliveryTargetsFromSnapshot({
    conversation: { ...conversation, id: "other-conversation" },
    content: "@codex hello",
    snapshot,
    requiredPolicyVersion: "policy-v1"
  }), {
    status: "waiting-for-policy-sync",
    requiredPolicyVersion: "policy-v1",
    availablePolicyVersion: "policy-v1",
    reason: "conversation-mismatch"
  });
});

test("resolveChatDeliveryTargetsFromSnapshot resolves mentions and last-sender fallback from replicated snapshot", () => {
  const codex = participant("codex");
  const manager = participant("manager", "administrator");
  const snapshot = createChatDeliveryPolicySnapshot({
    conversationId: "conversation-1",
    policyVersion: "policy-v1",
    participants: [codex, manager],
    options: OPTIONS,
    createdAt: "2026-08-06T00:00:00.000Z"
  });
  const mentioned = resolveChatDeliveryTargetsFromSnapshot({
    conversation: chatConversation([]),
    content: "@codex hello",
    snapshot,
    requiredPolicyVersion: "policy-v1"
  });
  const fallback = resolveChatDeliveryTargetsFromSnapshot({
    conversation: chatConversation([participantMessage("reply-1", codex.id)]),
    content: "follow up",
    snapshot,
    requiredPolicyVersion: "policy-v1"
  });

  assert.equal(mentioned.status, "ready");
  assert.deepEqual(mentioned.status === "ready" ? mentioned.result.targets.map((item) => item.handle) : [], ["codex"]);
  assert.equal(fallback.status, "ready");
  assert.deepEqual(fallback.status === "ready" ? fallback.result.targets.map((item) => item.handle) : [], ["codex"]);
});

function participant(handle: string, roleConfigId = "engineer"): ChatParticipant {
  return {
    id: `participant-${handle}`,
    handle,
    roleConfigId,
    kind: "codex-cli"
  };
}

function chatConversation(messages: ChatMessage[]): Conversation {
  return {
    id: "conversation-1",
    title: "Conversation",
    kind: "chat",
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
    messages,
    findings: [],
    metadata: {}
  };
}

function participantMessage(id: string, participantId: string): ChatMessage {
  return {
    id,
    role: "participant",
    participantId,
    content: "done",
    createdAt: "2026-08-06T00:00:00.000Z",
    metadata: {}
  };
}
