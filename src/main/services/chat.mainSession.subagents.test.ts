import assert from "node:assert/strict";
import test from "node:test";

import type { Conversation } from "../../shared/types";
import { mainActor, mainSession, mainSessionChat, participantsOf, testService } from "./chat/test/mainSessionFixtures";

// The chat's sub-agents (its side panel): a project's list in Settings and the
// chat's own layer over it decide which CLI the main session gives a task to,
// and the model and effort its new member runs on.

const REPO = "/work/app";
const projectList = { [REPO]: [{ kind: "codex-cli" as const, model: "gpt-6.2-astra", reasoningEffort: "high" as const }] };

function chatWithList(entries: unknown[] | undefined): Conversation {
  const conversation = mainSessionChat([mainSession("claude-code")], entries === undefined ? {} : { subagentProviders: { entries } });
  return { ...conversation, repoPath: REPO };
}

test("a task goes to the chat's sub-agent, on the model and effort set for it", async () => {
  const { service, storage } = testService({ conversation: chatWithList([]), settings: { subagentProvidersByProject: projectList } });
  const result = await service.delegateTaskFromTool(mainActor(), { task: "Write the migration." });
  assert.equal(result.ok, true, JSON.stringify(result));
  const child = participantsOf(storage.current).find((participant) => participant.id === result.participantId)!;
  assert.equal(child.kind, "codex-cli", "the main session runs on Claude Code, which is not one of the chat's sub-agents: the first one");
  assert.equal(child.model, "gpt-6.2-astra");
  assert.equal(child.reasoningEffort, "high");
});

test("the chat's own effort wins over its project's, and a model named in the call wins over both", async () => {
  const { service, storage } = testService({ conversation: chatWithList([{ kind: "codex-cli", reasoningEffort: "xhigh" }]), settings: { subagentProvidersByProject: projectList } });
  const result = await service.delegateTaskFromTool(mainActor(), { task: "Review it.", kind: "codex-cli", model: "gpt-6.2-mini" });
  assert.equal(result.ok, true, JSON.stringify(result));
  const child = participantsOf(storage.current).find((participant) => participant.id === result.participantId)!;
  assert.equal(child.model, "gpt-6.2-mini");
  assert.equal(child.reasoningEffort, "xhigh");
});

test("a provider that is not one of the chat's sub-agents is refused, and a chat with none says User adds them", async () => {
  const listed = testService({ conversation: chatWithList([]), settings: { subagentProvidersByProject: projectList } });
  const refused = await listed.service.delegateTaskFromTool(mainActor(), { task: "Do it.", kind: "gemini-cli" });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "provider_not_in_chat");
  assert.match(String(refused.reason), /Antigravity is not among this chat's sub-agents \(Codex\)/);

  const empty = testService({ conversation: chatWithList([]) });
  const none = await empty.service.delegateTaskFromTool(mainActor(), { task: "Do it." });
  assert.equal(none.code, "provider_not_in_chat");
  assert.match(String(none.reason), /no sub-agents yet/);
  assert.equal(participantsOf(empty.storage.current).length, 1, "nobody added");
});

test("a chat from before the list still gives tasks to any provider, on the main session's own model", async () => {
  const { service, storage } = testService({ conversation: chatWithList(undefined), settings: { subagentProvidersByProject: projectList } });
  const result = await service.delegateTaskFromTool(mainActor(), { task: "Do it." });
  assert.equal(result.ok, true, JSON.stringify(result));
  const child = participantsOf(storage.current).find((participant) => participant.id === result.participantId)!;
  assert.equal(child.kind, "claude-code", "its own provider, as before");
  assert.equal(child.model, "opus");
});

test("the side panel's changes land in the chat's layer or the project's list, and an old chat keeps the providers it uses", async () => {
  const old = chatWithList(undefined);
  const codexMember = { ...mainSession("gemini-cli"), id: "agy-id", handle: "agy", roleConfigId: "generic", delegatedByParticipantId: "main-id" };
  old.metadata.participants = [...participantsOf(old), codexMember];
  const { service, storage } = testService({ conversation: old, settings: { subagentProvidersByProject: projectList } });

  const thread = await service.updateSubagentProviders({ conversationId: old.id, scope: "thread", change: { type: "set", kind: "codex-cli", reasoningEffort: "medium" } });
  assert.deepEqual(storage.current.metadata.subagentProviders, {
    entries: [{ kind: "gemini-cli" }, { kind: "codex-cli", reasoningEffort: "medium" }]
  }, "its Antigravity member's provider is kept, the effort is this chat's");
  assert.deepEqual(thread.subagentProviders, storage.current.metadata.subagentProviders, "only the layer travels back, not the chat");
  assert.equal(thread.subagentProvidersByProject, undefined);

  const project = await service.updateSubagentProviders({ conversationId: old.id, scope: "project", change: { type: "add", kind: "claude-code" } });
  assert.deepEqual(project.subagentProvidersByProject?.[REPO]?.map((entry) => entry.kind), ["codex-cli", "claude-code"]);
});

test("removing a provider from the project in an old chat does not put it back in that chat", async () => {
  const old = chatWithList(undefined);
  const codexMember = { ...mainSession("codex-cli"), id: "codex-id", handle: "codex", roleConfigId: "generic", delegatedByParticipantId: "main-id" };
  old.metadata.participants = [...participantsOf(old), codexMember];
  const { service, storage } = testService({ conversation: old, settings: { subagentProvidersByProject: projectList } });
  await service.updateSubagentProviders({ conversationId: old.id, scope: "project", change: { type: "remove", kind: "codex-cli" } });
  assert.deepEqual(storage.current.metadata.subagentProviders, { entries: [] }, "Codex was the project's, so the chat has no Codex of its own");
});

test("a sub-agent of the main session's own CLI on another model does not take its effort, and a model named without a provider is refused when the task goes elsewhere", async () => {
  const main = mainSession("claude-code", { reasoningEffort: "xhigh" });
  const own = { ...mainSessionChat([main], { subagentProviders: { entries: [{ kind: "claude-code", model: "haiku" }] } }), repoPath: REPO };
  const first = testService({ conversation: own });
  const result = await first.service.delegateTaskFromTool(mainActor(), { task: "Quick check." });
  assert.equal(result.ok, true, JSON.stringify(result));
  const child = participantsOf(first.storage.current).find((participant) => participant.id === result.participantId)!;
  assert.equal(child.model, "haiku");
  assert.equal(child.reasoningEffort, undefined, "Haiku's own default, not the main session's xhigh");

  const elsewhere = testService({ conversation: chatWithList([]), settings: { subagentProvidersByProject: projectList } });
  const refused = await elsewhere.service.delegateTaskFromTool(mainActor(), { task: "Do it.", model: "sonnet" });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "invalid_request");
  assert.match(String(refused.reason), /Name the provider \(kind\) for model sonnet/);
});

test("a chat from before the list still gives the main session's effort when the call names its own model", async () => {
  const main = mainSession("codex-cli", { model: "gpt-6.2-astra", reasoningEffort: "xhigh" });
  const old = { ...mainSessionChat([main]), repoPath: REPO };
  const { service, storage } = testService({ conversation: old });
  const result = await service.delegateTaskFromTool(mainActor(), { task: "Do it.", model: "gpt-6.2-astra" });
  assert.equal(result.ok, true, JSON.stringify(result));
  const child = participantsOf(storage.current).find((participant) => participant.id === result.participantId)!;
  assert.equal(child.reasoningEffort, "xhigh", "as before the list");
});
