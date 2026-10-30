import assert from "node:assert/strict";
import test from "node:test";
import { newChatIntro, newChatMemberFitsProject, newChatParticipants, newChatPickedMembers, newChatProjects, newChatTitle, normalizeProjectPath, orderByParticipantUsage } from "./newChat";
import type { ChatParticipant, ConversationSummary } from "./types";

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

test("the projects are the folders of the chats not archived, newest first; a new chat starts in the last folder chosen, or the newest chat's that has one", () => {
  const chat = (id: string, repoPath: string | undefined, updatedAt: string, archived = false) =>
    ({ id, kind: "chat", title: id, repoPath, updatedAt, archived } as unknown as ConversationSummary);
  const summaries = [
    chat("a", "/Users/u/site/", "2026-10-01T00:00:00.000Z"),
    chat("b", "/Users/u/api", "2026-10-03T00:00:00.000Z"),
    chat("c", "/Users/u/site", "2026-10-05T00:00:00.000Z"),
    chat("d", undefined, "2026-10-09T00:00:00.000Z"),
    chat("e", "/Users/u/old", "2026-10-07T00:00:00.000Z", true)
  ];
  const offered = newChatProjects(summaries, undefined);
  assert.deepEqual(offered.projects, [{ path: "/Users/u/site", label: "site" }, { path: "/Users/u/api", label: "api" }], "one per folder, its trailing slash gone");
  assert.equal(offered.defaultProject, "/Users/u/old", "the newest chat with a folder, as the computer's New chat picks it, though the newest chat has none");
  assert.equal(newChatProjects(summaries, "/Users/u/api/").defaultProject, "/Users/u/api", "the folder last chosen comes first");
  assert.deepEqual(newChatProjects([], undefined), { projects: [] }, "no chat with a folder: without a folder");
  assert.equal(normalizeProjectPath("/"), "/");
});

test("the members a new chat gets are those chosen and those the first message names, a name only as a whole handle", () => {
  const members = [member("c-drew", "drew"), member("c-drew2", "drew-2"), member("c-gera", "gera")];
  assert.deepEqual(newChatPickedMembers({ members, chosenConfigIds: ["c-gera"], firstMessage: "@Drew-2 and @drewx" }).map((item) => item.configId), ["c-drew2", "c-gera"]);
});

test("a member on a machine fits a chat in a project that machine has, or in one without a project", () => {
  const cloud = { projects: ["/Users/u/api/"] };
  assert.equal(newChatMemberFitsProject(cloud, "/Users/u/api"), true, "the same folder, written either way");
  assert.equal(newChatMemberFitsProject(cloud, "/Users/u/site"), false);
  assert.equal(newChatMemberFitsProject(cloud, ""), true, "no project");
  assert.equal(newChatMemberFitsProject(cloud, undefined), true);
  assert.equal(newChatMemberFitsProject({ projects: [] }, "/Users/u/api"), false, "a machine with no project copied yet");
  assert.equal(newChatMemberFitsProject({}, "/Users/u/site"), true, "a member of this computer, or a machine with its own folders");
});

test("a member on a machine joins a chat started off the computer on that machine", () => {
  const cloud = { configId: "c-cloud", uses: 0, machineId: "m-cloud", participant: { id: "template-cloud", participantConfigId: "c-cloud", handle: "cloudy", roleConfigId: "generic-participant", kind: "claude-code", cloudRun: {} } as ChatParticipant };
  const participants = newChatParticipants({ assistant, members: [cloud], chosenConfigIds: ["c-cloud"], firstMessage: "hi", newId: () => "id" });
  assert.equal(participants[1].homeMachineId, "m-cloud");
  assert.deepEqual(participants[1].cloudRun, {}, "still a Cloud run member, its machine chosen");
});
