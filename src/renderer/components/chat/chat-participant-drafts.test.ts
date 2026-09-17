import assert from "node:assert/strict";
import test from "node:test";

import type { AgentHealth, AppSettings, ChatRoleConfig, CliProviderHost } from "../../../shared/types";
import { defaultChatAgentPermissions } from "../../../shared/agentPermissions";
import { validateChatCliAgents } from "./chat-cli-readiness";
import {
  chatCliProviderLabel,
  chatConfigProviderLabel,
  chatModelDefaultLabel,
  chatProviderOptionId,
  chatProviderOptionPatch,
  chatProviderOptions,
  normalizeChatParticipantDraftForSettings,
  updateChatParticipantDraft,
  type ChatParticipantDraft
} from "./chat-participant-drafts";

const ROLE: ChatRoleConfig = {
  id: "engineer",
  label: "Software Engineer",
  instructions: "Build.",
  version: 1,
  updatedAt: "2026-09-17T00:00:00.000Z"
};

const ZAI: CliProviderHost = {
  id: "host-zai",
  label: "Z.ai GLM",
  cli: "claude-code",
  vendor: "zai",
  baseUrl: "https://api.z.ai/api/anthropic",
  hasApiKey: true,
  updatedAt: "2026-09-17T00:00:00.000Z"
};

const ZAI_CODEX: CliProviderHost = { ...ZAI, id: "host-zai-codex", label: "Z.ai GLM · Codex", cli: "codex-cli", baseUrl: "https://api.z.ai/api/v1" };

const SETTINGS = {
  providers: [
    { kind: "codex-cli", label: "Codex CLI", enabled: true, model: "gpt-5.5" },
    { kind: "claude-code", label: "Claude Code", enabled: true, model: "opus" }
  ],
  chatRoleConfigs: [ROLE],
  chatBehaviorRules: [],
  cliProviderHosts: [ZAI, ZAI_CODEX]
} as unknown as AppSettings;

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

test("the provider picker lists built-in CLIs first, then every added provider whose CLI is offered", () => {
  const options = chatProviderOptions(["codex-cli", "claude-code", "gemini-cli"], [ZAI, ZAI_CODEX]);
  assert.deepEqual(options.map((option) => option.id), ["codex-cli", "claude-code", "gemini-cli", "host:host-zai", "host:host-zai-codex"]);
  assert.equal(options.find((option) => option.id === "host:host-zai")?.label, "Z.ai GLM");
  assert.deepEqual(chatProviderOptions(["codex-cli"], [ZAI, ZAI_CODEX]).map((option) => option.id), ["codex-cli", "host:host-zai-codex"]);
  assert.equal(chatProviderOptionId("claude-code", ZAI.id), "host:host-zai");
  assert.equal(chatProviderOptionId("claude-code", undefined), "claude-code");
});

test("picking a provider option resolves to kind + binding; unknown bindings fall back to the current kind", () => {
  const plain = draft();
  assert.deepEqual(chatProviderOptionPatch("host:host-zai", plain, [ZAI]), { kind: "claude-code", hostId: ZAI.id });
  assert.deepEqual(chatProviderOptionPatch("host:host-zai-codex", plain, [ZAI, ZAI_CODEX]), { kind: "codex-cli", hostId: ZAI_CODEX.id });
  assert.deepEqual(chatProviderOptionPatch("claude-code", plain, [ZAI]), { kind: "claude-code", hostId: undefined });
  assert.deepEqual(chatProviderOptionPatch("codex-cli", plain, [ZAI]), { kind: "codex-cli", hostId: undefined });
  assert.deepEqual(chatProviderOptionPatch("host:gone", plain, [ZAI]), { kind: "claude-code", hostId: undefined });
  assert.deepEqual(chatProviderOptionPatch("bogus", plain, [ZAI]), { kind: "claude-code", hostId: undefined });
});

test("binding to and unbinding from an added provider moves model and generated handle to the right side", () => {
  const plain = draft();
  const glm = updateChatParticipantDraft(plain, SETTINGS, chatProviderOptionPatch("host:host-zai", plain, [ZAI]));
  assert.equal(glm.hostId, ZAI.id);
  assert.equal(glm.model, "glm-5.3");
  assert.match(glm.handle, /^[a-z]+-glm-engineer$/);

  const back = updateChatParticipantDraft(glm, SETTINGS, chatProviderOptionPatch("claude-code", glm, [ZAI]));
  assert.equal(back.hostId, undefined);
  assert.equal(back.model, "opus");
  assert.match(back.handle, /^[a-z]+-claude-engineer$/);

  // A custom handle and an explicit model in the same patch both survive.
  const custom = updateChatParticipantDraft(draft({ handle: "my-bot" }), SETTINGS, { ...chatProviderOptionPatch("host:host-zai", plain, [ZAI]), model: "glm-5.2" });
  assert.equal(custom.handle, "my-bot");
  assert.equal(custom.model, "glm-5.2");

  // Switching the CLI drops a binding that does not run through it.
  const codex = updateChatParticipantDraft(glm, SETTINGS, { kind: "codex-cli" });
  assert.equal(codex.hostId, undefined);
  assert.equal(codex.model, "gpt-5.5");

  // A binding to a provider that no longer exists survives unrelated edits (the
  // editor shows it as removed and asks for a new provider) and clears as soon
  // as the user picks a provider or CLI.
  const stale = updateChatParticipantDraft(draft({ hostId: "gone" }), SETTINGS, { model: "opus" });
  assert.equal(stale.hostId, "gone");
  assert.equal(updateChatParticipantDraft(draft({ hostId: "gone" }), SETTINGS, { kind: "codex-cli" }).hostId, undefined);
  assert.equal(updateChatParticipantDraft(draft({ hostId: "gone" }), SETTINGS, chatProviderOptionPatch("claude-code", plain, [ZAI])).hostId, undefined);
});

test("removed-provider bindings read as such in preset views", () => {
  assert.equal(chatConfigProviderLabel(draft({ hostId: ZAI.id }), [ZAI]), "Z.ai GLM");
  assert.equal(chatConfigProviderLabel(draft({ hostId: "gone" }), [ZAI]), "Removed provider");
  assert.equal(chatConfigProviderLabel(draft(), [ZAI]), "Claude Code");
});

test("labels follow the provider", () => {
  assert.equal(chatCliProviderLabel("claude-code", "Z.ai GLM"), "Z.ai GLM");
  assert.equal(chatCliProviderLabel("claude-code"), "Claude Code");
  assert.equal(chatCliProviderLabel("claude-code", "  "), "Claude Code");
  assert.equal(chatModelDefaultLabel("claude-code", ZAI), "GLM-5.3 (default)");
  assert.equal(chatModelDefaultLabel("claude-code"), "Claude Code setting");
  // First-party vendors keep the CLI's own default; a host for another CLI is ignored.
  assert.equal(chatModelDefaultLabel("claude-code", { ...ZAI, vendor: "anthropic" }), "Claude Code setting");
  assert.equal(chatModelDefaultLabel("codex-cli", ZAI), "Codex CLI setting");
});

test("a blank bound draft normalized for settings gets the vendor default model and a vendor handle", () => {
  const normalized = normalizeChatParticipantDraftForSettings(draft({ handle: "", model: undefined, hostId: ZAI.id }), SETTINGS);
  assert.equal(normalized.model, "glm-5.3");
  assert.match(normalized.handle, /-glm-/);
  assert.equal(normalized.hostId, ZAI.id);
});

test("readiness: a bound member passes when its CLI is installed but not signed in; a keyless or missing provider does not", () => {
  const agents: AgentHealth[] = [
    { kind: "claude-code", label: "Claude Code", installed: true, detection: "detected", runnable: "ready", authentication: "required" }
  ];
  const providers = [{ kind: "claude-code" as const, enabled: true }];
  assert.equal(validateChatCliAgents([draft({ hostId: ZAI.id })], agents, providers, [ZAI]), undefined);
  assert.match(validateChatCliAgents([draft()], agents, providers, [ZAI]) ?? "", /sign/i);
  assert.match(validateChatCliAgents([draft({ hostId: ZAI.id })], agents, providers, [{ ...ZAI, hasApiKey: false }]) ?? "", /Z\.ai GLM has no API key/);
  assert.match(validateChatCliAgents([draft({ hostId: "gone" })], agents, providers, [ZAI]) ?? "", /no longer exists/);
});
