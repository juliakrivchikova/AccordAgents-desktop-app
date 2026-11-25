import assert from "node:assert/strict";
import test from "node:test";
import { ChatService } from "./chat";
import { chatDependencies, chatParts } from "./chat/test/chatParts";
import type {
  AgentHealth, ChatMessage, ChatParticipant, ChatParticipantConfig, ChatParticipantSession, CliProviderHost, Conversation,
  ParticipantConfig
} from "../../shared/types";
import {
  chatConversation, chatParticipant, clone, fakeServerLink, installedChatAgents, NOW, ROLE, testService, waitFor
} from "./chat/test/permissionFixtures";

const ZAI_HOST: CliProviderHost = {
  id: "host-zai",
  label: "Z.ai GLM",
  cli: "claude-code",
  vendor: "zai",
  baseUrl: "https://api.z.ai/api/anthropic",
  hasApiKey: true,
  updatedAt: NOW
};

const ZAI_CODEX_HOST: CliProviderHost = {
  id: "host-zai-codex",
  label: "Z.ai GLM · Codex",
  cli: "codex-cli",
  vendor: "zai",
  baseUrl: "https://api.z.ai/api/v1",
  hasApiKey: true,
  updatedAt: NOW
};

function installHosts(service: ChatService, hosts: CliProviderHost[], secrets: Record<string, string | undefined>): void {
  const settings = chatDependencies(service).settings;
  for (const method of ["getPublicSettings", "ensureAssistantProviderDefault", "ensureGenericChatParticipantSeeds"] as const) {
    const original = settings[method].bind(settings);
    settings[method] = async (...args: unknown[]) => ({ ...(await original(...args)), cliProviderHosts: hosts });
  }
  settings.getCliProviderHostSecret = async (id: string) => {
    const host = hosts.find((item) => item.id === id);
    return host ? { host, apiKey: secrets[id] } : undefined;
  };
}

test("a member on an added provider runs its CLI against that provider with the stored key", async () => {
  const runs: Array<{ participant: ParticipantConfig; options: any }> = [];
  const participant: ChatParticipant = { ...chatParticipant("claude-code"), hostId: ZAI_HOST.id, hostLabel: ZAI_HOST.label, hostVendor: "zai" };
  const conversation = chatConversation([participant]);
  const { service, tempRoot } = testService({
    conversation,
    run: async (runParticipant, _prompt, _repoPath, _diffMode, _kind, _signal, options) => {
      runs.push({ participant: runParticipant, options });
      return { participant: runParticipant, ok: true, content: "pong", durationMs: 1, sessionId: "glm-session" };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  chatDependencies(service).settings.getManualAgentEnvironment = async () => ({ env: { OTHER_VAR: "kept", ANTHROPIC_API_KEY: "sk-inherited" }, version: "env-v1" });
  installHosts(service, [ZAI_HOST], { [ZAI_HOST.id]: "zai-secret" });

  await service.sendMessage({ conversationId: conversation.id, runId: "run-glm", content: "@drew ping" });
  await waitFor(() => runs.length === 1);

  // Still the Claude Code runner, explicitly on the vendor default model — never the CLI's Anthropic alias.
  assert.equal(runs[0].participant.kind, "claude-code");
  assert.equal(runs[0].participant.model, "glm-5.3");
  const env = runs[0].options.agentEnv;
  assert.equal(env.ANTHROPIC_BASE_URL, "https://api.z.ai/api/anthropic");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "zai-secret");
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, "glm-5.3");
  assert.equal(env.OTHER_VAR, "kept");
  // The user's own Anthropic key from Settings → Environment never travels to the provider.
  assert.equal(env.ANTHROPIC_API_KEY, "");
  // The warm-process key changes with the provider so a plain Claude process is never reused.
  assert.match(runs[0].options.agentEnvKey, /^env-v1\|host:host-zai\|/);
});

test("a Codex member on an added provider gets the provider's -c overrides and key variable", async () => {
  const runs: Array<{ participant: ParticipantConfig; options: any }> = [];
  const participant: ChatParticipant = { ...chatParticipant("codex-cli"), hostId: ZAI_CODEX_HOST.id, hostLabel: ZAI_CODEX_HOST.label, hostVendor: "zai" };
  const conversation = chatConversation([participant]);
  const { service, tempRoot } = testService({
    conversation,
    run: async (runParticipant, _prompt, _repoPath, _diffMode, _kind, _signal, options) => {
      runs.push({ participant: runParticipant, options });
      return { participant: runParticipant, ok: true, content: "pong", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  installHosts(service, [ZAI_CODEX_HOST], { [ZAI_CODEX_HOST.id]: "zai-secret" });

  await service.sendMessage({ conversationId: conversation.id, runId: "run-glm-codex", content: "@codex ping" });
  await waitFor(() => runs.length === 1);
  assert.equal(runs[0].participant.model, "glm-5.3");
  assert.equal(runs[0].options.agentEnv.CODEX_PROVIDER_HOST_API_KEY, "zai-secret");
  // The provider key is for Codex itself, never forced into its shell commands.
  assert.equal(runs[0].options.settingsEnv?.CODEX_PROVIDER_HOST_API_KEY, undefined);
  assert.deepEqual(runs[0].participant.codexConfigOverrides, [
    'model_provider="accordagents_host"',
    'model_providers.accordagents_host.name="Z.ai GLM · Codex"',
    'model_providers.accordagents_host.base_url="https://api.z.ai/api/v1"',
    'model_providers.accordagents_host.wire_api="responses"',
    'model_providers.accordagents_host.env_key="CODEX_PROVIDER_HOST_API_KEY"'
  ]);
});

test("an Antigravity member on a Gemini API key runs agy on that key and agy's own model default", async () => {
  const googleHost: CliProviderHost = {
    id: "host-google",
    label: "Google Gemini API",
    cli: "gemini-cli",
    vendor: "google",
    baseUrl: "https://generativelanguage.googleapis.com",
    hasApiKey: true,
    updatedAt: NOW
  };
  const runs: Array<{ participant: ParticipantConfig; options: any }> = [];
  const participant: ChatParticipant = { ...chatParticipant("gemini-cli"), hostId: googleHost.id, hostLabel: googleHost.label, hostVendor: "google" };
  const conversation = chatConversation([participant]);
  const { service, tempRoot } = testService({
    conversation,
    run: async (runParticipant, _prompt, _repoPath, _diffMode, _kind, _signal, options) => {
      runs.push({ participant: runParticipant, options });
      return { participant: runParticipant, ok: true, content: "pong", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  chatDependencies(service).settings.getManualAgentEnvironment = async () => ({ env: { OTHER_VAR: "kept", GOOGLE_GEMINI_BASE_URL: "https://elsewhere.example" }, version: "env-v1" });
  installHosts(service, [googleHost], { [googleHost.id]: "gemini-secret" });

  await service.sendMessage({ conversationId: conversation.id, runId: "run-gemini-key", content: "@gemini ping" });
  await waitFor(() => runs.length === 1);
  assert.equal(runs[0].participant.kind, "gemini-cli");
  // No fixed vendor default: agy picks its own model on the key, as in its CLI.
  assert.equal(runs[0].participant.model, undefined);
  assert.deepEqual(runs[0].participant.geminiSettings, { modelProvider: "gemini" });
  assert.equal(runs[0].participant.codexConfigOverrides, undefined);
  assert.equal(runs[0].options.agentEnv.GEMINI_API_KEY, "gemini-secret");
  // Pinned to the provider's (default) endpoint, whatever the environment says.
  assert.equal(runs[0].options.agentEnv.GOOGLE_GEMINI_BASE_URL, "");
  assert.equal(runs[0].options.agentEnv.OTHER_VAR, "kept");
  assert.match(runs[0].options.agentEnvKey, /^env-v1\|host:host-google\|/);
});

test("an Antigravity member whose Gemini key was removed fails visibly instead of falling back to the sign-in", async () => {
  const googleHost: CliProviderHost = {
    id: "host-google",
    label: "Google Gemini API",
    cli: "gemini-cli",
    vendor: "google",
    baseUrl: "https://generativelanguage.googleapis.com",
    hasApiKey: false,
    updatedAt: NOW
  };
  const runs: ParticipantConfig[] = [];
  const participant: ChatParticipant = { ...chatParticipant("gemini-cli"), hostId: googleHost.id, hostLabel: googleHost.label, hostVendor: "google" };
  const conversation = chatConversation([participant]);
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant) => {
      runs.push(runParticipant);
      return { participant: runParticipant, ok: true, content: "pong", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  installHosts(service, [googleHost], { [googleHost.id]: undefined });

  await service.sendMessage({ conversationId: conversation.id, runId: "run-gemini-nokey", content: "@gemini ping" });
  await waitFor(() => storage.current.messages.some((message: ChatMessage) => /has no API key/.test(message.content ?? "")));
  assert.equal(runs.length, 0);
});

test("a member on an added provider and a built-in member keep independent env", async () => {
  const runs: Array<{ participant: ParticipantConfig; options: any }> = [];
  const glm: ChatParticipant = { ...chatParticipant("claude-code"), id: "glm-participant", handle: "glm", model: "glm-5.2", hostId: ZAI_HOST.id, hostLabel: ZAI_HOST.label, hostVendor: "zai" };
  const claude = chatParticipant("claude-code");
  const conversation = chatConversation([glm, claude]);
  const { service, tempRoot } = testService({
    conversation,
    run: async (runParticipant, _prompt, _repoPath, _diffMode, _kind, _signal, options) => {
      runs.push({ participant: runParticipant, options });
      return { participant: runParticipant, ok: true, content: "ok", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  chatDependencies(service).settings.getManualAgentEnvironment = async () => ({ env: {}, version: "env-v1" });
  installHosts(service, [ZAI_HOST], { [ZAI_HOST.id]: "zai-secret" });

  await service.sendMessage({ conversationId: conversation.id, runId: "run-both", content: "@glm @drew ping" });
  await waitFor(() => runs.length === 2);

  const glmRun = runs.find((run) => run.participant.id === glm.id);
  const claudeRun = runs.find((run) => run.participant.id === claude.id);
  assert.ok(glmRun && claudeRun);
  assert.equal(glmRun.participant.model, "glm-5.2");
  assert.equal(glmRun.options.agentEnv.ANTHROPIC_DEFAULT_SONNET_MODEL, "glm-5.2");
  assert.equal(claudeRun.participant.model, undefined);
  assert.equal(claudeRun.options.agentEnv.ANTHROPIC_BASE_URL, undefined);
  assert.equal(claudeRun.options.agentEnv.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(claudeRun.options.agentEnvKey, "env-v1");
});

test("a member whose provider lost its key or was removed fails its turn clearly, never spawns, and retires its warm process", async () => {
  for (const [scenario, hosts, secrets, expected] of [
    ["no key", [ZAI_HOST], {}, /Z\.ai GLM has no API key\. Add one under Local CLI setup in Settings\.$/],
    ["removed", [], {}, /Z\.ai GLM was removed from Settings\./]
  ] as const) {
    const runs: unknown[] = [];
    const closed: string[] = [];
    const participant: ChatParticipant = { ...chatParticipant("claude-code"), hostId: ZAI_HOST.id, hostLabel: ZAI_HOST.label, hostVendor: "zai" };
    const conversation = chatConversation([participant]);
    const { service, storage, tempRoot } = testService({
      conversation,
      run: async (runParticipant) => {
        runs.push(runParticipant);
        return { participant: runParticipant, ok: true, content: "ok", durationMs: 1 };
      }
    });
    chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
    installHosts(service, [...hosts], { ...secrets });
    chatDependencies(service).cliRunner.closeWarmAgents = async (_conversationId: string, participantId: string) => {
      closed.push(participantId);
    };

    await service.sendMessage({ conversationId: conversation.id, runId: `run-${scenario}`, content: "@drew ping" });
    await waitFor(() => (storage.current.messages as ChatMessage[]).some((message) => message.status === "error"));
    assert.equal(runs.length, 0, scenario);
    assert.deepEqual(closed, [participant.id], scenario);
    const failed = (storage.current.messages as ChatMessage[]).find((message) => message.status === "error");
    assert.match(failed?.content ?? "", expected, scenario);
    assert.doesNotMatch(failed?.content ?? "", /\.\.$/, scenario);
    assert.equal(storage.current.metadata.activeRunIds?.length ?? 0, 0, scenario);
  }
});

test("a new chat member copies its preset's provider binding and follows later preset edits", async () => {
  const preset: ChatParticipantConfig = {
    id: "preset-glm",
    handle: "glm",
    roleConfigId: ROLE.id,
    behaviorRuleIds: [],
    kind: "claude-code",
    model: "glm-5.3",
    hostId: ZAI_HOST.id,
    updatedAt: NOW
  };
  const { service, storage, tempRoot } = testService({
    agents: installedChatAgents(),
    settings: { chatRoleConfigs: [ROLE], chatParticipantConfigs: [preset] }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  installHosts(service, [ZAI_HOST], { [ZAI_HOST.id]: "zai-secret" });
  const created = await service.createConversation({
    title: "GLM member",
    participants: [{ participantConfigId: preset.id, handle: preset.handle, roleConfigId: preset.roleConfigId, kind: preset.kind, model: preset.model, hostId: preset.hostId }]
  });
  const member = (created.conversation.metadata.participants as ChatParticipant[]).find((item) => item.handle === "glm");
  assert.equal(member?.hostId, ZAI_HOST.id);
  assert.equal(member?.hostLabel, "Z.ai GLM");
  assert.equal(member?.hostVendor, "zai");

  // Switching the preset back to plain Claude Code drops the binding AND the
  // glm-* model, which Anthropic would reject; the member takes the preset's model.
  await service.syncSavedParticipantConfig(undefined, { ...preset, hostId: undefined, model: "opus" });
  const plain = (storage.current.metadata.participants as ChatParticipant[]).find((item) => item.handle === "glm");
  assert.equal(plain?.hostId, undefined);
  assert.equal(plain?.hostLabel, undefined);
  assert.equal(plain?.model, "opus");
});

test("a member on an added provider can be added when its CLI is installed but not signed in", async () => {
  // The dedicated CLI configured per the vendor's guide needs no first-party
  // login (verified: `claude auth status` reports loggedIn with the key in env).
  const agents: AgentHealth[] = [
    { kind: "codex-cli", label: "Codex CLI", installed: true, detection: "detected", runnable: "ready", authentication: "ready" },
    { kind: "claude-code", label: "Claude Code", installed: true, detection: "detected", runnable: "ready", authentication: "required" }
  ];
  const { service, tempRoot } = testService({ agents, settings: { chatRoleConfigs: [ROLE] } });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  installHosts(service, [ZAI_HOST, { ...ZAI_HOST, id: "host-nokey", label: "Kimi", hasApiKey: false }], { [ZAI_HOST.id]: "zai-secret" });

  const created = await service.createConversation({
    title: "GLM without Anthropic login",
    participants: [{ handle: "glm", roleConfigId: ROLE.id, kind: "claude-code", hostId: ZAI_HOST.id }]
  });
  const member = (created.conversation.metadata.participants as ChatParticipant[]).find((item) => item.handle === "glm");
  assert.equal(member?.hostId, ZAI_HOST.id);

  // A plain Claude Code member still needs the Anthropic sign-in...
  await assert.rejects(
    service.addParticipant({ conversationId: created.conversation.id, participant: { handle: "claude", roleConfigId: ROLE.id, kind: "claude-code" } }),
    /sign/i
  );
  // ...and a provider without a key is the equivalent for its members.
  await assert.rejects(
    service.addParticipant({ conversationId: created.conversation.id, participant: { handle: "kimi", roleConfigId: ROLE.id, kind: "claude-code", hostId: "host-nokey" } }),
    /Kimi has no API key/
  );
  // A binding to a provider that no longer exists is refused outright.
  await assert.rejects(
    service.addParticipant({ conversationId: created.conversation.id, participant: { handle: "gone", roleConfigId: ROLE.id, kind: "claude-code", hostId: "host-gone" } }),
    /no longer exists/
  );
});

test("a provider edit follows only members bound to it, refreshing their label and resetting sessions on a vendor change", async () => {
  const closed: string[] = [];
  const bound: ChatParticipant = { ...chatParticipant("claude-code"), id: "bound", handle: "glm", participantConfigId: "preset-glm", hostId: ZAI_HOST.id, hostLabel: "Z.ai GLM", hostVendor: "zai", model: "glm-5.3" };
  const other: ChatParticipant = { ...chatParticipant("claude-code"), id: "other", handle: "drew", model: "opus" };
  const conversation = chatConversation([bound, other], {
    participantSessions: [
      { participantId: "bound", sessionId: "bound-session", roleConfigId: ROLE.id, roleConfigVersion: 1, updatedAt: NOW },
      { participantId: "other", sessionId: "other-session", roleConfigId: ROLE.id, roleConfigVersion: 1, updatedAt: NOW }
    ]
  });
  const snapshots: Conversation[] = [];
  const { service, storage } = testService({ conversation, onSnapshot: (snapshot) => snapshots.push(snapshot) });
  chatDependencies(service).cliRunner.closeWarmAgents = async (_conversationId: string, participantId: string) => {
    closed.push(participantId);
  };

  // Rename only: label follows, session and model untouched.
  await service.syncCliProviderHost({ ...ZAI_HOST, label: "GLM via Z.ai" });
  let participants = storage.current.metadata.participants as ChatParticipant[];
  assert.equal(participants.find((item) => item.id === "bound")?.hostLabel, "GLM via Z.ai");
  assert.equal(participants.find((item) => item.id === "bound")?.model, "glm-5.3");
  assert.equal(participants.find((item) => item.id === "other")?.hostLabel, undefined);
  assert.deepEqual((storage.current.metadata.participantSessions as ChatParticipantSession[]).map((session) => session.participantId), ["bound", "other"]);
  assert.deepEqual(closed, []);
  assert.ok(snapshots.length > 0);

  // Vendor change: the transcript belongs to the old backend, so the session is dropped and the model reset.
  await service.syncCliProviderHost({ ...ZAI_HOST, label: "Kimi", vendor: "moonshot", baseUrl: "https://api.moonshot.ai/anthropic" });
  participants = storage.current.metadata.participants as ChatParticipant[];
  const rebound = participants.find((item) => item.id === "bound");
  assert.equal(rebound?.hostVendor, "moonshot");
  assert.equal(rebound?.model, "kimi-k3");
  assert.deepEqual((storage.current.metadata.participantSessions as ChatParticipantSession[]).map((session) => session.participantId), ["other"]);
  assert.deepEqual(closed, ["bound"]);
});

test("after a provider is removed, hydration keeps the member's binding so it fails visibly instead of switching backends", async () => {
  const runs: unknown[] = [];
  const closed: string[] = [];
  const preset: ChatParticipantConfig = { id: "preset-glm", handle: "glm", roleConfigId: ROLE.id, behaviorRuleIds: [], kind: "claude-code", model: "glm-5.3", hostId: ZAI_HOST.id, updatedAt: NOW };
  const member: ChatParticipant = { ...chatParticipant("claude-code"), id: "bound", handle: "glm", participantConfigId: preset.id, hostId: ZAI_HOST.id, hostLabel: ZAI_HOST.label, hostVendor: "zai", model: "glm-5.3" };
  const conversation = chatConversation([member], {
    participantSessions: [{ participantId: "bound", sessionId: "glm-session", roleConfigId: ROLE.id, roleConfigVersion: 1, updatedAt: NOW }]
  });
  const { service, storage, tempRoot } = testService({
    conversation,
    settings: { chatRoleConfigs: [ROLE], chatParticipantConfigs: [preset] },
    run: async (runParticipant) => {
      runs.push(runParticipant);
      return { participant: runParticipant, ok: true, content: "ok", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  // The provider is gone from settings; the preset keeps its dangling hostId.
  installHosts(service, [], {});
  chatDependencies(service).cliRunner.closeWarmAgents = async (_conversationId: string, participantId: string) => {
    closed.push(participantId);
  };

  await service.retireCliProviderHost(ZAI_HOST.id);
  assert.deepEqual(closed, ["bound"]);

  const hydrated = await service.hydrateContextUsage(clone(storage.current));
  const synced = (hydrated.metadata.participants as ChatParticipant[]).find((item) => item.id === "bound");
  assert.equal(synced?.hostId, ZAI_HOST.id, "binding kept");
  assert.equal(synced?.hostLabel, "Z.ai GLM");
  assert.equal(synced?.model, "glm-5.3");

  await service.sendMessage({ conversationId: conversation.id, runId: "run-removed", content: "@glm ping" });
  await waitFor(() => (storage.current.messages as ChatMessage[]).some((message) => message.status === "error"));
  assert.equal(runs.length, 0, "the built-in CLI is never spawned with the vendor model");
  assert.match((storage.current.messages as ChatMessage[]).find((message) => message.status === "error")?.content ?? "", /Z\.ai GLM was removed from Settings/);
});

test("a member on an added provider is refused on a machine runtime: the provider and its key live on the desktop only", async () => {
  const runs: unknown[] = [];
  const participant: ChatParticipant = { ...chatParticipant("codex-cli"), hostId: ZAI_CODEX_HOST.id, hostLabel: ZAI_CODEX_HOST.label, hostVendor: "zai", homeMachineId: "machine-1" };
  const conversation = chatConversation([participant]);
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant) => {
      runs.push(runParticipant);
      return { participant: runParticipant, ok: true, content: "ok", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  service.setHostMachineId("machine-1");
  // Even a machine that somehow has the provider in its own Settings must not
  // run it: the gate is the member's home, not what happens to be configured.
  installHosts(service, [ZAI_CODEX_HOST], { [ZAI_CODEX_HOST.id]: "zai-secret" });

  service.setServerLink(fakeServerLink("machine-device"));
  await service.startServerTurn({ runId: "turn-run-machine-host", conversationId: conversation.id, messageId: "user-message", participantId: participant.id,
    state: "requested", pendingMessageId: "machine-host-pending" });
  assert.equal(runs.length, 0);
  await waitFor(() => (storage.current.messages as ChatMessage[]).some((message) => message.status === "error"));
  assert.match((storage.current.messages as ChatMessage[]).find((message) => message.status === "error")?.content ?? "", /run on this computer only/);
});
