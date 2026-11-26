import assert from "node:assert/strict";
import test from "node:test";

import type { AgentHealth, ChatProviderKind, Conversation } from "../../shared/types";
import { mainActor, mainSession, mainSessionChat, participantsOf, testService } from "./chat/test/mainSessionFixtures";

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
