import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_DELIVERY_POLICY_OPTIONS,
  createChatDeliveryPolicySnapshot,
  resolveChatDeliveryTargets,
  resolveChatDeliveryTargetsFromSnapshot
} from "../../shared/chatDeliveryPolicy";
import { MAIN_SESSION_ROLE_ID } from "../../shared/mainSession";
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

test("in a chat with a main session, a message on the timeline without an @ goes to the main session, not the member that spoke last", () => {
  const main = participant("main", MAIN_SESSION_ROLE_ID);
  const drew = participant("drew", "generic-participant");
  const participants = [main, drew];
  const conversation = { ...chatConversation([participantMessage("reply-drew", drew.id)]), metadata: { participants, mainSessionParticipantId: main.id } };
  const route = (content: string, context?: Parameters<typeof resolveChatDeliveryTargets>[0]["context"]) =>
    resolveChatDeliveryTargets({ conversation, participants, content, context, options: CHAT_DELIVERY_POLICY_OPTIONS });

  assert.deepEqual(route("go on").targets.map((item) => item.handle), ["main"]);
  assert.deepEqual(route("@drew go on").targets.map((item) => item.handle), ["drew"], "an @ still names whom it is for");
  // The phone and the server pass the members without the chat's metadata:
  // the main session is told by its role.
  const bare = resolveChatDeliveryTargets({ conversation: chatConversation([participantMessage("reply-drew", drew.id)]), participants, content: "go on", options: CHAT_DELIVERY_POLICY_OPTIONS });
  assert.deepEqual(bare.targets.map((item) => item.handle), ["main"]);
});

test("in a thread of a main-session chat the thread's own rule holds, and the main session is its last resort", () => {
  const main = participant("main", MAIN_SESSION_ROLE_ID);
  const drew = participant("drew", "generic-participant");
  const participants = [main, drew];
  const inThread: ChatMessage = { ...participantMessage("reply-drew", drew.id), metadata: { chatThreadRootId: "root-1" } };
  const conversation = { ...chatConversation([inThread]), metadata: { participants, mainSessionParticipantId: main.id } };
  const route = (context: Parameters<typeof resolveChatDeliveryTargets>[0]["context"]) =>
    resolveChatDeliveryTargets({ conversation, participants, content: "and then?", context, options: CHAT_DELIVERY_POLICY_OPTIONS }).targets.map((item) => item.handle);

  assert.deepEqual(route({ chatThreadRootId: "root-1" }), ["drew"], "the newest member that spoke in the thread");
  assert.deepEqual(route({ chatThreadRootId: "root-2" }), ["main"], "nobody spoke in that thread yet");
});

test("@assistant and @admin do not reach a main session; a chat from before still routes to its Assistant", () => {
  const main = participant("main", MAIN_SESSION_ROLE_ID);
  const participants = [main, participant("drew", "generic-participant")];
  const conversation = { ...chatConversation([]), metadata: { participants, mainSessionParticipantId: main.id } };
  for (const alias of ["@assistant hi", "@admin hi"]) {
    const routed = resolveChatDeliveryTargets({ conversation, participants, content: alias, options: CHAT_DELIVERY_POLICY_OPTIONS });
    assert.deepEqual(routed.targets, [], alias);
    assert.deepEqual(routed.unknownHandles, [alias.slice(1, alias.indexOf(" "))], alias);
  }

  const assistant = participant("admin", "administrator");
  const codex = participant("codex");
  const old = chatConversation([participantMessage("reply-1", codex.id)]);
  const routed = (content: string) => resolveChatDeliveryTargets({ conversation: old, participants: [assistant, codex], content, options: CHAT_DELIVERY_POLICY_OPTIONS }).targets.map((item) => item.handle);
  assert.deepEqual(routed("follow up"), ["codex"], "the member that spoke last, as before");
  assert.deepEqual(routed("@assistant hi"), ["admin"]);
  assert.deepEqual(resolveChatDeliveryTargets({ conversation: chatConversation([]), participants: [assistant, codex], content: "hi", options: CHAT_DELIVERY_POLICY_OPTIONS }).targets.map((item) => item.handle), ["admin"], "nobody spoke yet: the Assistant");
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
