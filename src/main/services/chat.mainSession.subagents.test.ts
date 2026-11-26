import assert from "node:assert/strict";
import test from "node:test";

import type { AgentHealth, ChatProviderKind, Conversation } from "../../shared/types";
import { accordSkills, mainActor, mainSession, mainSessionChat, NOW, participantsOf, testService } from "./chat/test/mainSessionFixtures";

// The chat's agents (its side panel, the User, 2026-11-26): every CLI that is
// ready, on its model and effort from Settings → General → Agents; a chat may
// take one out or give it its own model and effort, for that chat only. The
// main session gives tasks only to them.

const REPO = "/work/app";
const SETTINGS_DEFAULTS = { subagentDefaults: [{ kind: "codex-cli" as const, model: "gpt-6.2-astra", reasoningEffort: "high" as const }] };

function chatWithList(entries: unknown[] | undefined, main = mainSession("claude-code")): Conversation {
  const conversation = mainSessionChat([main], entries === undefined ? {} : { subagentProviders: { entries } });
  return { ...conversation, repoPath: REPO };
}

/** Detection as production reports it: every CLI, ready or not. */
function readiness(ready: ChatProviderKind[]): AgentHealth[] {
  return (["codex-cli", "claude-code", "gemini-cli"] as ChatProviderKind[]).map((kind) => ready.includes(kind)
    ? { kind, label: kind, installed: true, detection: "detected", runnable: "ready", authentication: "ready" } as unknown as AgentHealth
    : { kind, label: kind, installed: false, detection: "not-detected" } as unknown as AgentHealth);
}

function childOf(conversation: Conversation, id: unknown) {
  return participantsOf(conversation).find((participant) => participant.id === id)!;
}

test("a new chat gives tasks to every ready CLI, each on Settings' model and effort", async () => {
  const { service, storage } = testService({ conversation: chatWithList([]), settings: SETTINGS_DEFAULTS });
  const result = await service.delegateTaskFromTool(mainActor(), { task: "Write the migration.", kind: "codex-cli" });
  assert.equal(result.ok, true, JSON.stringify(result));
  const child = childOf(storage.current, result.participantId);
  assert.equal(child.kind, "codex-cli");
  assert.equal(child.model, "gpt-6.2-astra", "Settings' model for Codex");
  assert.equal(child.reasoningEffort, "high");

  const own = await service.delegateTaskFromTool(mainActor(), { task: "Check it." });
  assert.equal(own.ok, true, JSON.stringify(own));
  const claude = childOf(storage.current, own.participantId);
  assert.equal(claude.kind, "claude-code", "no provider named: the main session's own CLI, which is ready");
  assert.equal(claude.model, "opus", "nothing set in Settings for it: the main session's own model, as before");
});

test("Settings' model for the main session's own CLI wins over the main session's model", async () => {
  const main = mainSession("claude-code", { reasoningEffort: "xhigh" });
  const { service, storage } = testService({ conversation: chatWithList([], main), settings: { subagentDefaults: [{ kind: "claude-code", model: "sonnet" }] } });
  const result = await service.delegateTaskFromTool(mainActor(), { task: "Quick check." });
  assert.equal(result.ok, true, JSON.stringify(result));
  const child = childOf(storage.current, result.participantId);
  assert.equal(child.model, "sonnet");
  assert.equal(child.reasoningEffort, undefined, "Sonnet's own default, not the main session's xhigh for Opus");
});

test("the chat's own effort wins over Settings', and a model named in the call wins over both", async () => {
  const { service, storage } = testService({ conversation: chatWithList([{ kind: "codex-cli", reasoningEffort: "xhigh" }]), settings: SETTINGS_DEFAULTS });
  const result = await service.delegateTaskFromTool(mainActor(), { task: "Review it.", kind: "codex-cli", model: "gpt-6.2-mini" });
  assert.equal(result.ok, true, JSON.stringify(result));
  const child = childOf(storage.current, result.participantId);
  assert.equal(child.model, "gpt-6.2-mini");
  assert.equal(child.reasoningEffort, "xhigh");
});

test("a CLI the chat took out is refused, and a task without a provider goes to the first one left", async () => {
  const { service, storage } = testService({ conversation: chatWithList([{ kind: "claude-code", removed: true }]) });
  const refused = await service.delegateTaskFromTool(mainActor(), { task: "Do it.", kind: "claude-code" });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "provider_not_in_chat");
  assert.match(String(refused.reason), /User took Claude Code out of this chat's Agents list\. This chat's agents: Antigravity, Codex\./);

  const result = await service.delegateTaskFromTool(mainActor(), { task: "Do it." });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(childOf(storage.current, result.participantId).kind, "gemini-cli", "the main session's own CLI is out: the first in the list");
});

test("a CLI that is not ready is not among the chat's agents, and a chat with none says so", async () => {
  const some = testService({ conversation: chatWithList([]), agents: readiness(["claude-code", "codex-cli"]) });
  const refused = await some.service.delegateTaskFromTool(mainActor(), { task: "Do it.", kind: "gemini-cli" });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "provider_unavailable");
  assert.match(String(refused.reason), /Antigravity was not detected\. Set it up to continue\. This chat's agents: Claude Code, Codex\./);
  const options = await some.service.describeRosterOptionsForTool(mainActor());
  assert.deepEqual(options.chatSubagents?.map((agent) => agent.kind), ["claude-code", "codex-cli"], "describe options list the same agents");

  const none = testService({ conversation: chatWithList([{ kind: "claude-code", removed: true }]), agents: readiness(["claude-code"]) });
  const empty = await none.service.delegateTaskFromTool(mainActor(), { task: "Do it." });
  assert.equal(empty.code, "provider_not_in_chat");
  assert.match(String(empty.reason), /This chat has no agents/);
  assert.equal(participantsOf(none.storage.current).length, 1, "nobody added");
});

test("a Cloud run main session's agents leave out Antigravity, which does not run there", async () => {
  const main = mainSession("claude-code", { cloudRun: { workerId: "worker-1" } as never });
  const { service } = testService({ conversation: chatWithList([], main) });
  const options = await service.describeRosterOptionsForTool(mainActor());
  // Its tasks are given on its machine, which runs this same code.
  assert.deepEqual(options.chatSubagents?.map((agent) => agent.kind), ["claude-code", "codex-cli"]);
});

test("a chat from before the list gives tasks to every ready CLI too", async () => {
  const { service, storage } = testService({ conversation: chatWithList(undefined), settings: SETTINGS_DEFAULTS });
  const result = await service.delegateTaskFromTool(mainActor(), { task: "Do it.", kind: "codex-cli" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(childOf(storage.current, result.participantId).model, "gpt-6.2-astra");
});

test("the side panel's changes stay in that chat: taken out, back, its own effort, reset", async () => {
  const { service, storage } = testService({ conversation: chatWithList(undefined), settings: SETTINGS_DEFAULTS });
  const set = await service.updateSubagentProviders({ conversationId: "conversation-1", change: { type: "set", kind: "codex-cli", reasoningEffort: "medium" } });
  assert.deepEqual(storage.current.metadata.subagentProviders, { entries: [{ kind: "codex-cli", reasoningEffort: "medium" }] });
  assert.deepEqual(set, { conversationId: "conversation-1", subagentProviders: storage.current.metadata.subagentProviders }, "only the chat's changes travel back");

  await service.updateSubagentProviders({ conversationId: "conversation-1", change: { type: "remove", kind: "gemini-cli" } });
  assert.deepEqual(storage.current.metadata.subagentProviders, { entries: [{ kind: "codex-cli", reasoningEffort: "medium" }, { kind: "gemini-cli", removed: true }] });
  await service.updateSubagentProviders({ conversationId: "conversation-1", change: { type: "add", kind: "gemini-cli" } });
  await service.updateSubagentProviders({ conversationId: "conversation-1", change: { type: "set", kind: "codex-cli" } });
  assert.deepEqual(storage.current.metadata.subagentProviders, { entries: [] }, "back and reset: nothing of its own left");

  await assert.rejects(service.updateSubagentProviders({ conversationId: "conversation-1", change: { type: "rename", kind: "codex-cli" } as never }), /Invalid agent change/);
});

test("a model named without a provider is refused when the task goes to another CLI", async () => {
  const { service } = testService({ conversation: chatWithList([{ kind: "claude-code", removed: true }]) });
  const refused = await service.delegateTaskFromTool(mainActor(), { task: "Do it.", model: "sonnet" });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "invalid_request");
  assert.match(String(refused.reason), /Name the provider \(kind\) for model sonnet/);
});

test("the main session's effort goes with a member on its own model", async () => {
  const main = mainSession("codex-cli", { model: "gpt-6.2-astra", reasoningEffort: "xhigh" });
  const { service, storage } = testService({ conversation: chatWithList(undefined, main) });
  const result = await service.delegateTaskFromTool(mainActor(), { task: "Do it.", model: "gpt-6.2-astra" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(childOf(storage.current, result.participantId).reasoningEffort, "xhigh");
});

// Review of 2026-11-27: an added provider, an effort set alone, a CLI taken
// out while the CLIs were checked, and a main session on a machine.

test("a main session on an added provider gives tasks to its own CLI there, though that CLI is not signed in itself", async () => {
  const main = mainSession("claude-code", { hostId: "zai", model: "glm-5" });
  const signedOut = readiness(["codex-cli"]).map((agent) => agent.kind === "claude-code"
    ? { ...agent, installed: true, detection: "detected", runnable: "ready", authentication: "required" } as unknown as AgentHealth
    : agent);
  const { service, storage } = testService({
    conversation: chatWithList([], main), agents: signedOut,
    settings: { cliProviderHosts: [{ id: "zai", cli: "claude-code", label: "Z.ai", hasApiKey: true, vendor: "zai" }] as never }
  });
  const options = await service.describeRosterOptionsForTool(mainActor());
  assert.deepEqual(options.chatSubagents?.map((agent) => agent.kind), ["claude-code", "codex-cli"]);
  const result = await service.delegateTaskFromTool(mainActor(), { task: "Do it." });
  assert.equal(result.ok, true, JSON.stringify(result));
  const child = childOf(storage.current, result.participantId);
  assert.equal(child.kind, "claude-code");
  assert.equal(child.hostId, "zai", "on the main session's provider");
  assert.equal(child.model, "glm-5");
});

test("an effort set alone for the main session's CLI goes with the CLI's own model, not the main session's", async () => {
  const main = mainSession("claude-code", { model: "opus", reasoningEffort: "xhigh" });
  const { service, storage } = testService({ conversation: chatWithList([], main), settings: { subagentDefaults: [{ kind: "claude-code", reasoningEffort: "low" }] } });
  const result = await service.delegateTaskFromTool(mainActor(), { task: "Do it." });
  assert.equal(result.ok, true, JSON.stringify(result));
  const child = childOf(storage.current, result.participantId);
  assert.equal(child.model, undefined, "the CLI's own model, which that effort was chosen for");
  assert.equal(child.reasoningEffort, "low");
});

test("a CLI the User takes out while the CLIs are checked gets no task", async () => {
  let fixture: ReturnType<typeof testService> | undefined;
  fixture = testService({
    conversation: chatWithList([]),
    onDetectAgents: () => {
      if (fixture) fixture.storage.current.metadata.subagentProviders = { entries: [{ kind: "codex-cli", removed: true }] };
    }
  });
  const refused = await fixture.service.delegateTaskFromTool(mainActor(), { task: "Do it.", kind: "codex-cli" });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "provider_not_in_chat");
  assert.equal(participantsOf(fixture.storage.current).length, 1, "nobody added");
});

test("an Accord started here for a main session on a machine offers the CLIs that machine has, not this computer's", async () => {
  const main = mainSession("claude-code", { homeMachineId: "m1" });
  const machines = [{ id: "m1", name: "AWS", deviceId: "d1", pairingKey: "k", createdAt: NOW, lastHello: { providers: [{ kind: "gemini-cli", installed: true }] } }];
  const start = (kind: ChatProviderKind) => testService({ conversation: chatWithList([], main), machines, userSkills: accordSkills() })
    .service.startAccord({ conversationId: "conversation-1", facilitatorParticipantId: "main-id", targetParticipantIds: [], targetProviderKinds: [kind], subject: "Pick it." });
  await assert.rejects(start("codex-cli"), /Codex is not in this chat's Agents list/, "ready here, not installed on the machine");
});
