import assert from "node:assert/strict";
import test from "node:test";
import { newChatIntro, newChatParticipants, newChatTitle, orderByParticipantUsage } from "./newChat";
import type { ChatParticipant } from "./types";

const assistant = { id: "template-assistant", handle: "assistant", roleConfigId: "administrator", kind: "codex-cli", autoWatch: false } as ChatParticipant;
const member = (configId: string, handle: string, autoWatch = false) => ({
  configId, uses: 0, participant: { id: `template-${handle}`, participantConfigId: configId, handle, roleConfigId: "generic-participant", kind: "claude-code", autoWatch } as ChatParticipant
});

test("a new chat has the Chat Assistant first, then each member chosen or named with @ in the first message, each with a fresh id", () => {
  let next = 0;
  const participants = newChatParticipants({
    assistant, members: [member("c-drew", "drew"), member("c-gera", "gera"), member("c-taylor", "taylor")],
    chosenConfigIds: ["c-gera"], firstMessage: "@taylor look at this", newId: () => `id-${++next}`
  });
  assert.deepEqual(participants.map((item) => item.handle), ["assistant", "gera", "taylor"], "in the order the computer saved them");
  assert.deepEqual(participants.map((item) => item.id), ["id-3", "id-1", "id-2"]);
  assert.equal(participants[1].participantConfigId, "c-gera");
});

test("only the first member that watches the chat keeps watching it", () => {
  const participants = newChatParticipants({
    assistant, members: [member("c-a", "a", true), member("c-b", "b", true)], chosenConfigIds: ["c-a", "c-b"], firstMessage: "", newId: () => "x"
  });
  assert.deepEqual(participants.map((item) => item.autoWatch), [false, true, false]);
});

test("the Assistant's name moves aside when a member already has it", () => {
  const participants = newChatParticipants({ assistant, members: [member("c-x", "assistant")], chosenConfigIds: ["c-x"], firstMessage: "", newId: () => "x" });
  assert.deepEqual(participants.map((item) => item.handle), ["assistant-2", "assistant"]);
});

test("the first line and the title are the computer's", () => {
  assert.equal(newChatIntro(["assistant", "drew"]), "Chat started.\nMembers:\n- User\n- @assistant\n- @drew");
  assert.equal(newChatTitle("@drew fix the login page"), "fix the login page");
  assert.equal(newChatTitle("", "shot.png"), "Image: shot.png");
});

test("saved members are offered most used first", () => {
  const configs = [{ id: "a", handle: "a", kind: "codex-cli" as const }, { id: "b", handle: "b", kind: "codex-cli" as const }];
  const summaries = [{ id: "1", kind: "chat", title: "t", createdAt: "", updatedAt: "", chatParticipants: [{ participantConfigId: "b", handle: "b", kind: "codex-cli" }] }] as never;
  assert.deepEqual(orderByParticipantUsage(configs, (item) => item, summaries).map((item) => item.id), ["b", "a"]);
});
