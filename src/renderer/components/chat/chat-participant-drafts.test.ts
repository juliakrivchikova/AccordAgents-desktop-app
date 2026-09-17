import assert from "node:assert/strict";
import test from "node:test";

import type { AgentHealth, AppSettings, ChatRoleConfig } from "../../../shared/types";
import { defaultChatAgentPermissions } from "../../../shared/agentPermissions";
import { ZAI_DEFAULT_AUTH_TOKEN_ENV_KEY, ZAI_DEFAULT_BASE_URL } from "../../../shared/chatParticipantEndpoint";
import { validateChatCliAgents } from "./chat-cli-readiness";
import {
  chatCliProviderLabel,
  chatModelDefaultLabel,
  chatProviderOptionId,
  chatProviderOptionPatch,
  chatProviderOptions,
  normalizeChatParticipantDraftForSettings,
  updateChatParticipantDraft,
  validateChatParticipantDrafts,
  type ChatParticipantDraft
} from "./chat-participant-drafts";

const ROLE: ChatRoleConfig = {
  id: "engineer",
  label: "Software Engineer",
  instructions: "Build.",
  version: 1,
  updatedAt: "2026-09-17T00:00:00.000Z"
};

const SETTINGS = {
  providers: [
    { kind: "codex-cli", label: "Codex CLI", enabled: true, model: "gpt-5.5" },
    { kind: "claude-code", label: "Claude Code", enabled: true, model: "opus" }
  ],
  chatRoleConfigs: [ROLE],
  chatBehaviorRules: []
} as unknown as AppSettings;

const ZAI = { preset: "zai" as const, baseUrl: ZAI_DEFAULT_BASE_URL, authTokenEnvKey: ZAI_DEFAULT_AUTH_TOKEN_ENV_KEY };

function draft(patch: Partial<ChatParticipantDraft> = {}): ChatParticipantDraft {
  return {
    handle: "drew-claude-engineer",
    roleConfigId: ROLE.id,
    behaviorRuleIds: [],
    kind: "claude-code",
    model: "opus",
    agentMode: "default",
    permissions: defaultChatAgentPermissions(),
    remoteExecution: "local",
    skipToolchainPreflight: false,
    autoWatch: false,
    ...patch
  };
}

test("the provider picker lists GLM (Z.ai) once, next to Claude Code only", () => {
  const options = chatProviderOptions(["codex-cli", "claude-code", "gemini-cli"]);
  assert.deepEqual(options.map((option) => option.id), ["codex-cli", "claude-code", "claude-code:zai", "gemini-cli"]);
  assert.equal(options.find((option) => option.id === "claude-code:zai")?.label, "GLM (Z.ai)");
  assert.deepEqual(chatProviderOptions(["codex-cli"]).map((option) => option.id), ["codex-cli"]);
  assert.equal(chatProviderOptionId("claude-code", ZAI), "claude-code:zai");
  assert.equal(chatProviderOptionId("claude-code", undefined), "claude-code");
  // An endpoint never counts on a non-Claude kind, even if a record carries one.
  assert.equal(chatProviderOptionId("codex-cli", ZAI), "codex-cli");
});

test("picking a provider option resolves to kind + endpoint, keeping an edited endpoint on the same preset", () => {
  const plain = draft();
  assert.deepEqual(chatProviderOptionPatch("claude-code:zai", plain), { kind: "claude-code", endpoint: ZAI });
  assert.deepEqual(chatProviderOptionPatch("claude-code", plain), { kind: "claude-code", endpoint: undefined });
  assert.deepEqual(chatProviderOptionPatch("codex-cli", plain), { kind: "codex-cli", endpoint: undefined });
  assert.deepEqual(chatProviderOptionPatch("claude-code:bogus", plain), { kind: "claude-code", endpoint: undefined });
  assert.deepEqual(chatProviderOptionPatch("bogus", plain), { kind: "codex-cli", endpoint: undefined });
  const edited = { ...ZAI, baseUrl: "https://proxy.example/anthropic" };
  assert.deepEqual(chatProviderOptionPatch("claude-code:zai", draft({ endpoint: edited })), { kind: "claude-code", endpoint: edited });
});

test("switching to GLM (Z.ai) and back moves model and generated handle to the right side", () => {
  const plain = draft();
  const glm = updateChatParticipantDraft(plain, SETTINGS, chatProviderOptionPatch("claude-code:zai", plain));
  assert.deepEqual(glm.endpoint, ZAI);
  assert.equal(glm.model, "glm-5.3");
  assert.match(glm.handle, /^[a-z]+-glm-engineer$/);

  // Editing the URL keeps the chosen model and the handle.
  const edited = updateChatParticipantDraft({ ...glm, model: "glm-5.2" }, SETTINGS, { endpoint: { ...ZAI, baseUrl: "https://proxy.example" } });
  assert.equal(edited.model, "glm-5.2");
  assert.equal(edited.handle, glm.handle);

  const back = updateChatParticipantDraft(glm, SETTINGS, chatProviderOptionPatch("claude-code", glm));
  assert.equal(back.endpoint, undefined);
  assert.equal(back.model, "opus");
  assert.match(back.handle, /^[a-z]+-claude-engineer$/);

  // A custom handle and an explicit model in the same patch both survive.
  const custom = updateChatParticipantDraft(draft({ handle: "my-bot" }), SETTINGS, { ...chatProviderOptionPatch("claude-code:zai", plain), model: "glm-5.2" });
  assert.equal(custom.handle, "my-bot");
  assert.equal(custom.model, "glm-5.2");

  // Leaving Claude Code drops the endpoint entirely.
  const codex = updateChatParticipantDraft(glm, SETTINGS, { kind: "codex-cli" });
  assert.equal(codex.endpoint, undefined);
  assert.equal(codex.model, "gpt-5.5");
});

test("labels follow the endpoint", () => {
  assert.equal(chatCliProviderLabel("claude-code", ZAI), "GLM (Z.ai)");
  assert.equal(chatCliProviderLabel("claude-code"), "Claude Code");
  assert.equal(chatModelDefaultLabel("claude-code", ZAI), "GLM-5.3 (default)");
  assert.equal(chatModelDefaultLabel("claude-code"), "Claude Code setting");
  assert.equal(chatModelDefaultLabel("codex-cli", ZAI), "Codex CLI setting");
});

test("a blank GLM draft normalized for settings gets the endpoint default model and a glm handle", () => {
  const normalized = normalizeChatParticipantDraftForSettings(draft({ handle: "", model: undefined, endpoint: ZAI }), SETTINGS);
  assert.equal(normalized.model, "glm-5.3");
  assert.match(normalized.handle, /-glm-/);
  assert.deepEqual(normalized.endpoint, ZAI);
});

test("draft validation reports an invalid endpoint URL or variable name", () => {
  assert.match(validateChatParticipantDrafts([draft({ endpoint: { ...ZAI, baseUrl: "nope" } })], [ROLE]) ?? "", /Endpoint URL/);
  assert.match(validateChatParticipantDrafts([draft({ endpoint: { ...ZAI, authTokenEnvKey: "bad-name" } })], [ROLE]) ?? "", /API key variable/);
  assert.equal(validateChatParticipantDrafts([draft({ endpoint: ZAI })], [ROLE]), undefined);
});

test("a GLM member passes readiness when Claude Code is installed but not signed in", () => {
  const agents: AgentHealth[] = [
    { kind: "claude-code", label: "Claude Code", installed: true, detection: "detected", runnable: "ready", authentication: "required" }
  ];
  const providers = [{ kind: "claude-code" as const, enabled: true }];
  assert.equal(validateChatCliAgents([draft({ endpoint: ZAI })], agents, providers), undefined);
  assert.match(validateChatCliAgents([draft()], agents, providers) ?? "", /sign/i);
});
