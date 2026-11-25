import assert from "node:assert/strict";
import test from "node:test";
import { chatParts } from "./chat/test/chatParts";
import { resolveDispatchTargetsForContent } from "./chat/choices/mentions";
import { MAIN_SESSION_ROLE_ID } from "../../shared/mainSession";
import type { ChatMessage, ChatParticipant, ChatProviderKind, Conversation, ParticipantConfig } from "../../shared/types";
import {
  ADMIN_ROLE, chatConversation, chatParticipant, installedChatAgents, NOW, ROLE, skillMention, testService, waitFor
} from "./chat/test/permissionFixtures";

test("a message written to chosen members goes to exactly those, whatever @handles it has; an id that is not a member is refused", async () => {
  const main = { ...chatParticipant("claude-code"), id: "main-participant", handle: "main", roleConfigId: MAIN_SESSION_ROLE_ID };
  const codex = chatParticipant("codex-cli");
  const gemini = chatParticipant("gemini-cli");
  const conversation = chatConversation([main, codex, gemini], { mainSessionParticipantId: main.id });
  const runs: ParticipantConfig[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    agents: installedChatAgents(),
    run: async (participant) => {
      runs.push(participant);
      return { participant, ok: true, content: `reply from ${participant.id}`, durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  await service.sendMessage({ conversationId: conversation.id, runId: "explicit", content: "@gemini please look", targetParticipantIds: [codex.id] });
  await waitFor(() => runs.length === 1);
  assert.deepEqual(runs.map((run) => run.id), [codex.id], "the panel's member only: not @gemini, not the main session");
  const sent = storage.current.messages.find((message: ChatMessage) => message.content === "@gemini please look");
  assert.deepEqual(sent?.metadata?.askedParticipantIds, [codex.id]);
  assert.equal(storage.current.messages.some((message: ChatMessage) => /No member named/.test(message.content)), false);

  await assert.rejects(
    () => service.sendMessage({ conversationId: conversation.id, content: "hello", targetParticipantIds: ["not-a-member"] }),
    /No member of this chat has id not-a-member/
  );
  assert.equal(storage.current.messages.some((message: ChatMessage) => message.content === "hello"), false, "nothing is posted");

  await waitFor(async () => service.liveRunIds().length === 0, 5_000);
  runs.length = 0;
  await service.sendMessage({ conversationId: conversation.id, runId: "unaddressed", content: "and now?" });
  await waitFor(() => runs.length === 1);
  assert.deepEqual(runs.map((run) => run.id), [main.id], "without an addressee: the main session, not the member that spoke last");
});

test("unmentioned timeline messages route to the last sender while explicit mentions bypass it", () => {
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const codex = chatParticipant("codex-cli");
  const conversation = chatConversation([assistant, codex]);
  const { service } = testService({ conversation, settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] } });

  const unmentioned = resolveDispatchTargetsForContent(conversation, "Please help me set up this chat.");
  assert.deepEqual(unmentioned.targets.map((participant: ChatParticipant) => participant.handle), ["assistant"]);

  conversation.messages.push({
    id: "codex-reply",
    role: "participant",
    participantId: codex.id,
    content: "message codex-reply",
    createdAt: NOW,
    status: "done",
    metadata: { threadId: "user-message", parentMessageId: "user-message" }
  });
  const lastTimelineSender = resolveDispatchTargetsForContent(conversation, "follow up");
  assert.deepEqual(lastTimelineSender.targets.map((participant: ChatParticipant) => participant.handle), ["codex"]);

  conversation.messages.push({
    id: "assistant-reply",
    role: "participant",
    participantId: assistant.id,
    content: "message assistant-reply",
    createdAt: NOW,
    status: "done",
    metadata: { threadId: "assistant-thread", parentMessageId: "codex-reply" }
  });
  const assistantAsLastSender = resolveDispatchTargetsForContent(conversation, "follow up again");
  assert.deepEqual(assistantAsLastSender.targets.map((participant: ChatParticipant) => participant.handle), ["assistant"]);

  const explicit = resolveDispatchTargetsForContent(conversation, "@codex answer directly.");
  assert.deepEqual(explicit.targets.map((participant: ChatParticipant) => participant.handle), ["codex"]);
});

test("unmentioned thread replies route to the newest thread sender instead of the parent author", () => {
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const codex = chatParticipant("codex-cli");
  const drew = chatParticipant("claude-code");

  const threadMsg = (
    id: string,
    role: ChatMessage["role"],
    threadId: string,
    participantId?: string,
    parentMessageId?: string,
    chatThreadRootId?: string
  ): ChatMessage => ({
    id,
    role,
    participantId,
    content: `message ${id}`,
    createdAt: NOW,
    status: "done",
    metadata: { threadId, parentMessageId, chatThreadRootId }
  });

  const handlesFor = (
    service: any,
    conversation: Conversation,
    content: string,
    context: { parentMessageId?: string; threadId?: string; chatThreadRootId?: string }
  ): string[] =>
    resolveDispatchTargetsForContent(conversation, content, context)
      .targets.map((participant: ChatParticipant) => participant.handle);

  // A real thread reply passes the root as parent; last sender should still win.
  {
    const conversation = chatConversation([assistant, codex]);
    conversation.messages = [
      threadMsg("assistant-root", "participant", "t-mixed", assistant.id),
      threadMsg("codex-reply", "participant", "t-mixed", codex.id, "assistant-root", "assistant-root")
    ];
    const { service } = testService({ conversation, settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] } });
    assert.deepEqual(
      handlesFor(service, conversation, "follow up", { parentMessageId: "assistant-root", threadId: "t-mixed", chatThreadRootId: "assistant-root" }),
      ["codex"]
    );
  }

  // The assistant/administrator is also a valid last sender.
  {
    const conversation = chatConversation([assistant, codex]);
    conversation.messages = [
      threadMsg("codex-root", "participant", "t-assistant", codex.id),
      threadMsg("assistant-reply", "participant", "t-assistant", assistant.id, "codex-root", "codex-root")
    ];
    const { service } = testService({ conversation, settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] } });
    assert.deepEqual(
      handlesFor(service, conversation, "follow up", { parentMessageId: "codex-root", threadId: "t-assistant", chatThreadRootId: "codex-root" }),
      ["assistant"]
    );
  }

  // Removed newest sender is skipped in favor of the next older roster participant.
  {
    const conversation = chatConversation([assistant, codex]);
    conversation.messages = [
      threadMsg("codex-root", "participant", "t-removed", codex.id),
      threadMsg("removed-reply", "participant", "t-removed", "removed-participant", "codex-root", "codex-root")
    ];
    const { service } = testService({ conversation, settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] } });
    assert.deepEqual(
      handlesFor(service, conversation, "follow up", { parentMessageId: "codex-root", threadId: "t-removed", chatThreadRootId: "codex-root" }),
      ["codex"]
    );
  }

  // Top-level participant replies carry a threadId, so timeline routing must not require absent threadId.
  {
    const conversation = chatConversation([assistant, codex, drew]);
    conversation.messages = [
      threadMsg("codex-top-level", "participant", "user-thread", codex.id, "user-message"),
      threadMsg("drew-thread-reply", "participant", "thread-1", drew.id, "thread-root", "thread-root")
    ];
    const { service } = testService({ conversation, settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] } });
    assert.deepEqual(handlesFor(service, conversation, "timeline follow up", {}), ["codex"]);
  }

  // If only a removed participant qualifies in scope, parent author is the fallback.
  {
    const conversation = chatConversation([assistant, codex]);
    conversation.messages = [
      threadMsg("codex-root", "participant", "t-parent-fallback", codex.id),
      threadMsg("removed-reply", "participant", "t-parent-fallback", "removed-participant", "codex-root", "codex-root")
    ];
    const { service } = testService({ conversation, settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] } });
    assert.deepEqual(
      handlesFor(service, conversation, "follow up", { parentMessageId: "codex-root", threadId: "missing-thread", chatThreadRootId: "missing-root" }),
      ["codex"]
    );
  }

  // Explicit mention overrides thread routing.
  {
    const conversation = chatConversation([assistant, codex, drew]);
    conversation.messages = [threadMsg("codex-root", "participant", "codex-root", codex.id)];
    const { service } = testService({ conversation, settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] } });
    assert.deepEqual(handlesFor(service, conversation, "@drew take this", { parentMessageId: "codex-root", threadId: "codex-root" }), ["drew"]);
  }

  // A cold thread with no prior participant still falls back to Chat Assistant.
  {
    const conversation = chatConversation([assistant, codex]);
    conversation.messages = [threadMsg("user-root", "user", "t-cold", undefined)];
    const { service } = testService({ conversation, settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] } });
    assert.deepEqual(handlesFor(service, conversation, "follow up", { parentMessageId: "user-root", threadId: "t-cold" }), ["assistant"]);
  }

  // An unknown explicit mention is preserved and never infers a thread agent or falls back.
  {
    const conversation = chatConversation([assistant, codex]);
    conversation.messages = [threadMsg("codex-root", "participant", "codex-root", codex.id)];
    const { service } = testService({ conversation, settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] } });
    const dispatch = resolveDispatchTargetsForContent(conversation, "@missing help", { parentMessageId: "codex-root", threadId: "codex-root" });
    assert.deepEqual(dispatch.targets, []);
    assert.deepEqual(dispatch.unknownHandles, ["missing"]);
  }
});

test("a selected skill cannot be sent to more than one mentioned participant", async () => {
  const a = chatParticipant("codex-cli");
  const b = chatParticipant("claude-code");
  const conversation = chatConversation([a, b]);
  const { service } = testService({ conversation });
  const mention = skillMention("codex-cli");

  await assert.rejects(
    () => chatParts(service).messageSending.validateChatSkillMentionsForTargets(conversation, "@codex @drew /accord", [mention], [a, b]),
    /runs on a single member/
  );
});

test("a selected skill without an explicit mention targets the implicit last sender", async () => {
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const codex = chatParticipant("codex-cli");
  const conversation = chatConversation([assistant, codex]);
  conversation.messages.push({
    id: "codex-reply",
    role: "participant",
    participantId: codex.id,
    content: "message codex-reply",
    createdAt: NOW,
    status: "done",
    metadata: { threadId: "user-message", parentMessageId: "user-message" }
  });
  const seen: Array<{ kind: ChatProviderKind; participantId: string }> = [];
  const userSkills = {
    async validateMentionForParticipant(
      _mention: unknown,
      kind: ChatProviderKind,
      _context: unknown,
      participantId: string
    ): Promise<{ ok: true }> {
      seen.push({ kind, participantId });
      return { ok: true };
    }
  };
  const { service } = testService({
    conversation,
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] },
    userSkills
  });
  const dispatch = resolveDispatchTargetsForContent(conversation, "Use the selected skill.");

  const validation = await chatParts(service).messageSending.validateChatSkillMentionsForTargets(
    conversation,
    "Use the selected skill.",
    [skillMention("codex-cli")],
    dispatch.targets
  );

  assert.deepEqual(validation.targets.map((participant: ChatParticipant) => participant.handle), ["codex"]);
  assert.deepEqual(seen, [{ kind: "codex-cli", participantId: codex.id }]);
});
