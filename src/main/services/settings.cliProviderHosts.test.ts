import assert from "node:assert/strict";
import test from "node:test";
import { SettingsService } from "./settings";
import type { AppSettings, ChatParticipantConfig, ChatRoleConfig } from "../../shared/types";
import {
  CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT,
  CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_DEFAULT
} from "../../shared/chatParticipantRequests";
import { CHAT_AUTO_WATCH_WAKE_LIMIT_DEFAULT } from "../../shared/chatAutoWatch";
import { DEFAULT_CHAT_PROMPT_CONTEXT } from "../../shared/chatPromptContext";
import { CLI_AGENT_RUN_TIMEOUT_DEFAULT_MS } from "../../shared/cliAgentRunSettings";
import { EMPTY_MOBILE_CONTROL_SETTINGS } from "../../shared/mobilePairing";

const ROLE: ChatRoleConfig = {
  id: "custom-engineer",
  label: "Engineer",
  instructions: "Build things.",
  version: 1,
  builtIn: false,
  updatedAt: "2026-09-17T00:00:00.000Z"
};

function settingsServiceWith(initial: { chatParticipantConfigs?: unknown[]; cliProviderHosts?: unknown[] } = {}) {
  const service = Object.create(SettingsService.prototype) as any;
  let stored = {
    settingsVersion: 1,
    roundLimitDefault: 1,
    betaUpdates: false,
    cliAgentRunTimeoutMs: CLI_AGENT_RUN_TIMEOUT_DEFAULT_MS,
    chatAutoWatchWakeLimit: CHAT_AUTO_WATCH_WAKE_LIMIT_DEFAULT,
    chatParticipantRequestMaxDepth: CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT,
    chatParticipantRequestPromptMaxChars: CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_DEFAULT,
    chatPromptContext: DEFAULT_CHAT_PROMPT_CONTEXT,
    cloudRuns: {
      enabled: false,
      mode: "ssh" as const,
      worker: {},
      hasAwsCredentials: false,
      awsInstanceType: "t3.small",
      awsRootVolumeSizeGb: 8,
      maxRuntimeMs: 24 * 60 * 60_000,
      pollIntervalMs: 2_500
    },
    providers: [],
    chatRoleConfigs: [ROLE],
    chatBehaviorRules: [],
    chatSavedPrompts: [],
    chatParticipantConfigs: (initial.chatParticipantConfigs ?? []) as ChatParticipantConfig[],
    chatParticipantSeedState: {},
    cliProviderHosts: initial.cliProviderHosts ?? []
  };
  service.readStored = async () => stored;
  service.writeStored = async (next: typeof stored) => {
    stored = next;
  };
  // Object.create skips the constructor; safeStorage is unavailable in tests,
  // so keys are base64-obfuscated (the same fallback the app uses without a keychain).
  service.getPublicSettings = async (): Promise<AppSettings> => ({
    roundLimitDefault: stored.roundLimitDefault,
    betaUpdates: false,
    cliAgentRunTimeoutMs: stored.cliAgentRunTimeoutMs,
    chatAutoWatchWakeLimit: stored.chatAutoWatchWakeLimit,
    chatParticipantRequestMaxDepth: stored.chatParticipantRequestMaxDepth,
    chatParticipantRequestPromptMaxChars: stored.chatParticipantRequestPromptMaxChars,
    chatPromptContext: stored.chatPromptContext,
    cloudRuns: stored.cloudRuns,
    providers: stored.providers,
    chatRoleConfigs: stored.chatRoleConfigs,
    chatBehaviorRules: stored.chatBehaviorRules,
    chatSavedPrompts: stored.chatSavedPrompts,
    chatParticipantConfigs: stored.chatParticipantConfigs,
    chatParticipantSeedState: stored.chatParticipantSeedState,
    mobileControl: EMPTY_MOBILE_CONTROL_SETTINGS,
    chatCustomAvatars: [],
    cliProviderHosts: service.publicCliProviderHosts(stored)
  });
  return { service, stored: () => stored };
}

test("adding a provider stores the key encrypted and exposes only hasApiKey", async () => {
  const { service, stored } = settingsServiceWith();
  const settings = await service.saveCliProviderHost({ label: " Z.ai  GLM ", cli: "claude-code", vendor: "zai", baseUrl: "https://api.z.ai/api/anthropic/", apiKey: " zai-secret " });
  const host = settings.cliProviderHosts[0];
  assert.ok(host?.id);
  assert.equal(host.label, "Z.ai GLM");
  assert.equal(host.baseUrl, "https://api.z.ai/api/anthropic");
  assert.equal(host.hasApiKey, true);
  assert.equal("apiKey" in host, false);
  assert.equal("encryptedApiKey" in host, false);
  const raw = stored().cliProviderHosts[0] as { encryptedApiKey?: string };
  assert.ok(raw.encryptedApiKey);
  assert.notEqual(raw.encryptedApiKey, "zai-secret");
  assert.equal(JSON.stringify(stored()).includes("zai-secret"), false);
  // The run-time accessor returns the decrypted, trimmed key.
  assert.deepEqual(await service.getCliProviderHostSecret(host.id), { host, apiKey: "zai-secret" });
  assert.equal(await service.getCliProviderHostSecret("missing"), undefined);
});

test("editing keeps the stored key unless a new one is pasted, and an empty paste clears it", async () => {
  const { service } = settingsServiceWith();
  const created = (await service.saveCliProviderHost({ label: "GLM", cli: "claude-code", vendor: "zai", baseUrl: "https://api.z.ai/api/anthropic", apiKey: "first" })).cliProviderHosts[0];
  const renamed = (await service.saveCliProviderHost({ id: created.id, label: "GLM renamed", cli: "claude-code", vendor: "zai", baseUrl: created.baseUrl })).cliProviderHosts[0];
  assert.equal(renamed.label, "GLM renamed");
  assert.equal((await service.getCliProviderHostSecret(created.id))?.apiKey, "first");
  assert.notEqual(renamed.updatedAt, undefined);
  const replaced = (await service.saveCliProviderHost({ id: created.id, label: "GLM renamed", cli: "claude-code", vendor: "zai", baseUrl: created.baseUrl, apiKey: "second" })).cliProviderHosts[0];
  assert.equal((await service.getCliProviderHostSecret(replaced.id))?.apiKey, "second");
  const cleared = (await service.saveCliProviderHost({ id: created.id, label: "GLM renamed", cli: "claude-code", vendor: "zai", baseUrl: created.baseUrl, apiKey: "" })).cliProviderHosts[0];
  assert.equal(cleared.hasApiKey, false);
  assert.equal((await service.getCliProviderHostSecret(cleared.id))?.apiKey, undefined);
});

test("invalid providers are rejected and duplicates by name refused", async () => {
  const { service, stored } = settingsServiceWith();
  await assert.rejects(service.saveCliProviderHost({ label: "x", cli: "gemini-cli" as never, vendor: "zai", baseUrl: "https://x", apiKey: "k" }), /which CLI/);
  await assert.rejects(service.saveCliProviderHost({ label: "x", cli: "codex-cli", vendor: "moonshot", baseUrl: "https://x", apiKey: "k" }), /not available through Codex/);
  await assert.rejects(service.saveCliProviderHost({ label: "x", cli: "claude-code", vendor: "zai", baseUrl: "nope", apiKey: "k" }), /http\(s\) URL/);
  await assert.rejects(service.saveCliProviderHost({ id: "ghost", label: "x", cli: "claude-code", vendor: "zai", baseUrl: "https://x", apiKey: "k" }), /no longer exists/);
  await service.saveCliProviderHost({ label: "GLM", cli: "claude-code", vendor: "zai", baseUrl: "https://api.z.ai/api/anthropic", apiKey: "k" });
  await assert.rejects(service.saveCliProviderHost({ label: " glm ", cli: "codex-cli", vendor: "zai", baseUrl: "https://api.z.ai/api/v1", apiKey: "k" }), /already exists/);
  assert.equal(stored().cliProviderHosts.length, 1);
});

test("member presets bind only to an existing provider on their own CLI, and lose the binding when it is removed", async () => {
  const { service, stored } = settingsServiceWith();
  const host = (await service.saveCliProviderHost({ label: "GLM", cli: "claude-code", vendor: "zai", baseUrl: "https://api.z.ai/api/anthropic", apiKey: "k" })).cliProviderHosts[0];
  const base = { handle: "glm", roleConfigId: ROLE.id, behaviorRuleIds: [], kind: "claude-code" as const };
  await assert.rejects(service.saveChatParticipantConfig({ ...base, hostId: "missing" }), /no longer exists/);
  await assert.rejects(service.saveChatParticipantConfig({ ...base, kind: "codex-cli", hostId: host.id }), /runs through Claude Code/);
  await service.saveChatParticipantConfig({ ...base, hostId: host.id, model: "glm-5.3" });
  assert.equal(stored().chatParticipantConfigs[0]?.hostId, host.id);
  const reloaded = service.mergeDefaults(JSON.parse(JSON.stringify(stored())));
  assert.equal(reloaded.chatParticipantConfigs[0]?.hostId, host.id);
  assert.equal(reloaded.cliProviderHosts[0]?.id, host.id);

  // Changing the provider's CLI underneath bound presets is refused.
  await assert.rejects(service.saveCliProviderHost({ id: host.id, label: "GLM", cli: "codex-cli", vendor: "zai", baseUrl: "https://api.z.ai/api/v1" }), /Members are bound/);
  // Changing its vendor moves bound presets to the new vendor's default model.
  await service.saveCliProviderHost({ id: host.id, label: "Kimi", cli: "claude-code", vendor: "moonshot", baseUrl: "https://api.moonshot.ai/anthropic" });
  assert.equal(stored().chatParticipantConfigs[0]?.model, "kimi-k3");

  // Removing the provider keeps the preset's (now dangling) binding: it fails
  // visibly until the user picks another provider.
  const after = await service.deleteCliProviderHost(host.id);
  assert.deepEqual(after.cliProviderHosts, []);
  assert.equal(stored().chatParticipantConfigs[0]?.hostId, host.id);
  // Re-saving the preset with other edits keeps the dangling binding...
  const presetId = stored().chatParticipantConfigs[0]!.id;
  await service.saveChatParticipantConfig({ ...base, id: presetId, hostId: host.id, model: "kimi-k3", reasoningEffort: "high" });
  assert.equal(stored().chatParticipantConfigs[0]?.hostId, host.id);
  // ...while a new binding to the missing provider is refused.
  await assert.rejects(service.saveChatParticipantConfig({ ...base, handle: "glm2", hostId: host.id }), /no longer exists/);
  // Deleting again is a no-op.
  assert.deepEqual((await service.deleteCliProviderHost(host.id)).cliProviderHosts, []);
});

test("damaged stored providers are dropped on reload instead of half-applying", () => {
  const { service } = settingsServiceWith();
  const reloaded = service.mergeDefaults({
    settingsVersion: 1,
    providers: [],
    chatRoleConfigs: [ROLE],
    cliProviderHosts: [
      { id: "ok", label: "GLM", cli: "claude-code", vendor: "zai", baseUrl: "https://api.z.ai/api/anthropic", encryptedApiKey: "enc", protection: "local-obfuscated", updatedAt: "2026-09-17T00:00:00.000Z" },
      { id: "dup", label: "Kimi", cli: "claude-code", vendor: "moonshot", baseUrl: 42 },
      { id: "dup", label: "Kimi again", cli: "claude-code", vendor: "moonshot" },
      { id: "bad", label: "x", cli: "codex-cli", vendor: "deepseek", baseUrl: "https://x" },
      "garbage"
    ]
  });
  assert.deepEqual(reloaded.cliProviderHosts.map((host: { id: string; baseUrl: string; encryptedApiKey?: string }) => [host.id, host.baseUrl, Boolean(host.encryptedApiKey)]), [
    ["ok", "https://api.z.ai/api/anthropic", true],
    ["dup", "https://api.moonshot.ai/anthropic", false]
  ]);
});
