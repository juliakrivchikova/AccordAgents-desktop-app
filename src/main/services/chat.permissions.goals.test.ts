import assert from "node:assert/strict";
import test from "node:test";
import { chatParts } from "./chat/test/chatParts";
import type { ChatMessage } from "../../shared/types";
import { chatConversation, chatParticipant, testService, waitFor } from "./chat/test/permissionFixtures";

test("chat native /goal preserves the posted message while enabling the provider-native run", async () => {
  const runs: Array<{ prompt: string; options: any }> = [];
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant, prompt, _repoPath, _diffMode, _kind, _signal, options) => {
      runs.push({ prompt, options });
      return {
        participant: runParticipant,
        ok: true,
        content: "goal complete",
        durationMs: 1,
        sessionId: "goal-session"
      };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  const content = "@codex finish the implementation /goal";
  await service.sendMessage({ conversationId: conversation.id, runId: "native-goal-run", content });
  await waitFor(() => runs.length === 1);

  assert.deepEqual(runs[0].options.nativeGoal, { name: "goal", objective: "finish the implementation" });
  assert.match(runs[0].prompt, /@codex finish the implementation/);
  assert.doesNotMatch(runs[0].prompt, /finish the implementation \/goal/);
  const posted = storage.current.messages.filter((message: ChatMessage) => message.role === "user").at(-1);
  assert.equal(posted?.content, content);
  assert.deepEqual(posted?.metadata?.nativeCommand, {
    name: "goal",
    objective: "finish the implementation"
  });
});

test("chat native /goal requires one target and a non-empty edge command while middle/repeated tokens stay prose", async () => {
  const codex = chatParticipant("codex-cli");
  const claude = chatParticipant("claude-code");
  const conversation = chatConversation([codex, claude]);
  const { service } = testService({ conversation });

  await assert.rejects(
    () => service.sendMessage({
      conversationId: conversation.id,
      runId: "native-goal-two-targets",
      content: "@codex @drew finish together /goal"
    }),
    /exactly one resolved chat member/
  );
  await assert.rejects(
    () => service.sendMessage({
      conversationId: conversation.id,
      runId: "native-goal-empty",
      content: "@codex /goal"
    }),
    /Add a goal/
  );
  await service.sendMessage({
    conversationId: conversation.id,
    runId: "native-goal-middle",
    content: "@codex finish /goal this"
  });
  await service.sendMessage({
    conversationId: conversation.id,
    runId: "native-goal-repeated",
    content: "@codex /goal finish /goal"
  });
});

test("chat does not activate native /goal from inline code", async () => {
  const runs: Array<{ options: any }> = [];
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const { service, tempRoot } = testService({
    conversation,
    run: async (runParticipant, _prompt, _repoPath, _diffMode, _kind, _signal, options) => {
      runs.push({ options });
      return { participant: runParticipant, ok: true, content: "ok", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  await service.sendMessage({
    conversationId: conversation.id,
    runId: "native-goal-code",
    content: "@codex explain `/goal`"
  });
  await waitFor(() => runs.length === 1);
  assert.equal(runs[0].options.nativeGoal, undefined);
});

test("app_chat_send_message keeps participant /goal prose ordinary", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 1,
    capabilities: [],
    snapshotMaxSequence: 0,
    runId: "participant-goal-prose",
    triggerThreadId: "user-message"
  };

  await service.sendChatMessageFromTool(actor, { content: "/goal this is participant prose" });

  assert.equal(storage.current.messages[1].role, "participant");
  assert.equal(storage.current.messages[1].metadata.nativeCommand, undefined);
});
