import assert from "node:assert/strict";
import test from "node:test";
import { contextWindowForModel } from "../../shared/agentContext";
import { readinessForParticipant } from "../../shared/cliReadiness";
import {
  CODEX_HOST_API_KEY_ENV,
  cliProviderHostDefaultBaseUrl,
  cliProviderHostDefaultLabel,
  cliProviderHostDefaultModel,
  cliProviderHostDefaultModelLabel,
  cliProviderHostForParticipant,
  cliProviderHostHandleSlug,
  cliProviderHostModels,
  cliProviderHostRunConfig,
  cliProviderHostRunVersion,
  cliProviderHostValidationError,
  cliProviderHostVendorsFor,
  normalizeCliProviderHostRecord
} from "../../shared/cliProviderHosts";
import type { AgentHealth, CliProviderHost } from "../../shared/types";

const ZAI: CliProviderHost = {
  id: "host-zai",
  label: "Z.ai GLM",
  cli: "claude-code",
  vendor: "zai",
  baseUrl: "https://api.z.ai/api/anthropic",
  hasApiKey: true,
  updatedAt: "2026-09-17T00:00:00.000Z"
};

test("vendors are offered only through the CLIs their guides document", () => {
  assert.deepEqual(cliProviderHostVendorsFor("claude-code"), ["anthropic", "zai", "moonshot", "minimax", "deepseek", "custom"]);
  // Codex needs a Responses API; Chat-Completions-only vendors are not offered.
  assert.deepEqual(cliProviderHostVendorsFor("codex-cli"), ["zai", "openai", "custom"]);
  assert.equal(cliProviderHostDefaultBaseUrl("zai", "claude-code"), "https://api.z.ai/api/anthropic");
  assert.equal(cliProviderHostDefaultBaseUrl("zai", "codex-cli"), "https://api.z.ai/api/v1");
  assert.equal(cliProviderHostDefaultBaseUrl("moonshot", "codex-cli"), "");
  assert.equal(cliProviderHostDefaultLabel("zai", "codex-cli"), "Z.ai GLM · Codex");
  assert.equal(cliProviderHostDefaultLabel("moonshot", "claude-code"), "Moonshot Kimi");
});

test("validation reports the field that is wrong before anything is stored", () => {
  const base = { cli: "claude-code" as const, vendor: "zai" as const, label: "Z.ai GLM", baseUrl: ZAI.baseUrl };
  assert.equal(cliProviderHostValidationError(base), undefined);
  assert.match(cliProviderHostValidationError({ ...base, cli: "gemini-cli" as never }) ?? "", /which CLI/);
  assert.match(cliProviderHostValidationError({ ...base, vendor: "nope" as never }) ?? "", /vendor/);
  assert.match(cliProviderHostValidationError({ ...base, cli: "codex-cli", vendor: "moonshot" }) ?? "", /not available through Codex/);
  assert.match(cliProviderHostValidationError({ ...base, label: "  " }) ?? "", /name/);
  assert.match(cliProviderHostValidationError({ ...base, baseUrl: "not a url" }) ?? "", /http\(s\) URL/);
  assert.match(cliProviderHostValidationError({ ...base, baseUrl: "ftp://x" }) ?? "", /http\(s\) URL/);
});

test("stored records are repaired or dropped, never half-applied", () => {
  assert.deepEqual(normalizeCliProviderHostRecord({ id: "h1", cli: "claude-code", vendor: "zai", baseUrl: `${ZAI.baseUrl}/`, label: "  My  GLM ", updatedAt: "2026-01-01T00:00:00.000Z" }), {
    id: "h1", cli: "claude-code", vendor: "zai", baseUrl: ZAI.baseUrl, label: "My GLM", updatedAt: "2026-01-01T00:00:00.000Z"
  });
  // Missing URL / name fall back to the vendor defaults.
  assert.equal(normalizeCliProviderHostRecord({ id: "h1", cli: "claude-code", vendor: "moonshot" })?.baseUrl, "https://api.moonshot.ai/anthropic");
  assert.equal(normalizeCliProviderHostRecord({ id: "h1", cli: "claude-code", vendor: "moonshot" })?.label, "Moonshot Kimi");
  // A custom vendor without a URL, an unknown vendor, or a vendor/CLI mismatch is unusable.
  assert.equal(normalizeCliProviderHostRecord({ id: "h1", cli: "claude-code", vendor: "custom" }), undefined);
  assert.equal(normalizeCliProviderHostRecord({ id: "h1", cli: "claude-code", vendor: "other", baseUrl: "https://x" }), undefined);
  assert.equal(normalizeCliProviderHostRecord({ id: "h1", cli: "codex-cli", vendor: "deepseek", baseUrl: "https://x" }), undefined);
  assert.equal(normalizeCliProviderHostRecord("zai"), undefined);
});

test("a member only binds to a provider that runs through its own CLI", () => {
  assert.deepEqual(cliProviderHostForParticipant("claude-code", ZAI.id, [ZAI]), ZAI);
  assert.equal(cliProviderHostForParticipant("codex-cli", ZAI.id, [ZAI]), undefined);
  assert.equal(cliProviderHostForParticipant("claude-code", "missing", [ZAI]), undefined);
  assert.equal(cliProviderHostForParticipant("claude-code", undefined, [ZAI]), undefined);
});

test("vendor presets carry models, defaults and handle slugs; first-party vendors defer to the CLI", () => {
  assert.equal(cliProviderHostModels({ vendor: "zai" })?.[0]?.id, "glm-5.3");
  assert.equal(cliProviderHostDefaultModel({ vendor: "zai" }), "glm-5.3");
  assert.equal(cliProviderHostDefaultModelLabel({ vendor: "zai" }), "GLM-5.3");
  assert.equal(cliProviderHostDefaultModel({ vendor: "moonshot" }), "kimi-k3");
  assert.equal(cliProviderHostDefaultModel({ vendor: "deepseek" }), "deepseek-v4-pro");
  assert.equal(cliProviderHostModels({ vendor: "anthropic" }), undefined);
  assert.equal(cliProviderHostModels({ vendor: "openai" }), undefined);
  assert.deepEqual(cliProviderHostModels({ vendor: "custom" }), []);
  assert.equal(cliProviderHostDefaultModel({ vendor: "custom" }), undefined);
  assert.equal(cliProviderHostHandleSlug({ vendor: "zai", cli: "claude-code" }), "glm");
  assert.equal(cliProviderHostHandleSlug({ vendor: "moonshot", cli: "claude-code" }), "kimi");
  assert.equal(cliProviderHostHandleSlug({ vendor: "custom", cli: "codex-cli" }), "codex");
  assert.equal(cliProviderHostHandleSlug(undefined), undefined);
});

test("Claude Code run config mirrors the vendor's guide and clears every first-party credential", () => {
  const { env, codexConfigOverrides } = cliProviderHostRunConfig(ZAI, " secret ", "glm-5.2");
  assert.equal(codexConfigOverrides, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, ZAI.baseUrl);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, " secret ");
  assert.equal(env.ANTHROPIC_API_KEY, "");
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "");
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, "");
  assert.equal(env.CLAUDE_CODE_USE_VERTEX, "");
  assert.equal(env.CLAUDE_CODE_USE_FOUNDRY, "");
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, "glm-5.2");
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, "glm-5.2");
  assert.equal(env.ANTHROPIC_DEFAULT_FABLE_MODEL, "glm-5.2");
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "glm-5.3-flash");
  assert.equal(env.API_TIMEOUT_MS, "3000000");
  assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "1000000");
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  // No model on the member → the vendor default, never the CLI's Anthropic alias.
  assert.equal(cliProviderHostRunConfig(ZAI, "k", undefined).env.ANTHROPIC_DEFAULT_OPUS_MODEL, "glm-5.3");

  // DeepSeek's guide authenticates with ANTHROPIC_API_KEY; the Bearer variable is cleared instead.
  const deepseek = cliProviderHostRunConfig({ ...ZAI, vendor: "deepseek", baseUrl: "https://api.deepseek.com/anthropic" }, "ds-key", undefined).env;
  assert.equal(deepseek.ANTHROPIC_API_KEY, "ds-key");
  assert.equal(deepseek.ANTHROPIC_AUTH_TOKEN, "");
  assert.equal(deepseek.ANTHROPIC_DEFAULT_HAIKU_MODEL, "deepseek-flash");
  assert.equal(deepseek.API_TIMEOUT_MS, undefined);

  // Anthropic with the user's own key: the CLI keeps its own models and aliases.
  const anthropic = cliProviderHostRunConfig({ ...ZAI, vendor: "anthropic", baseUrl: "https://api.anthropic.com" }, "sk-ant", "opus").env;
  assert.equal(anthropic.ANTHROPIC_API_KEY, "sk-ant");
  assert.equal(anthropic.ANTHROPIC_AUTH_TOKEN, "");
  assert.equal(anthropic.ANTHROPIC_BASE_URL, "https://api.anthropic.com");
  assert.equal(anthropic.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);
  assert.equal(anthropic.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, undefined);

  // A custom Anthropic-compatible endpoint with a typed model id.
  const custom = cliProviderHostRunConfig({ ...ZAI, vendor: "custom", baseUrl: "https://proxy.example/anthropic" }, "tok", "my-model").env;
  assert.equal(custom.ANTHROPIC_BASE_URL, "https://proxy.example/anthropic");
  assert.equal(custom.ANTHROPIC_DEFAULT_OPUS_MODEL, "my-model");
  assert.equal(custom.ANTHROPIC_DEFAULT_HAIKU_MODEL, "my-model");
  // ...and without a model there is nothing to map, so no alias variables are set.
  assert.equal(cliProviderHostRunConfig({ ...ZAI, vendor: "custom", baseUrl: "https://proxy.example" }, "tok", undefined).env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);
});

test("Codex run config routes through a custom model_provider, or the OpenAI key with apikey auth", () => {
  const zai = cliProviderHostRunConfig({ ...ZAI, id: "h2", label: 'Z.ai "GLM"', cli: "codex-cli", baseUrl: "https://api.z.ai/api/v1" }, "zai-key", "glm-5.3");
  assert.deepEqual(zai.env, { [CODEX_HOST_API_KEY_ENV]: "zai-key" });
  assert.deepEqual(zai.codexConfigOverrides, [
    'model_provider="accordagents_host"',
    'model_providers.accordagents_host.name="Z.ai \\"GLM\\""',
    'model_providers.accordagents_host.base_url="https://api.z.ai/api/v1"',
    'model_providers.accordagents_host.wire_api="responses"',
    `model_providers.accordagents_host.env_key="${CODEX_HOST_API_KEY_ENV}"`
  ]);
  const openai = cliProviderHostRunConfig({ ...ZAI, vendor: "openai", cli: "codex-cli", baseUrl: "https://api.openai.com/v1" }, "sk-openai", undefined);
  assert.deepEqual(openai.env, { OPENAI_API_KEY: "sk-openai" });
  assert.deepEqual(openai.codexConfigOverrides, ['preferred_auth_method="apikey"']);
  const proxied = cliProviderHostRunConfig({ ...ZAI, vendor: "openai", cli: "codex-cli", baseUrl: "https://proxy.example/v1" }, "sk-openai", undefined);
  assert.equal(proxied.env.OPENAI_BASE_URL, "https://proxy.example/v1");
});

test("run version changes with the provider record and the member's model", () => {
  assert.equal(cliProviderHostRunVersion(undefined, "x"), "");
  const base = cliProviderHostRunVersion(ZAI, "glm-5.3");
  assert.notEqual(base, cliProviderHostRunVersion(ZAI, "glm-5.2"));
  assert.notEqual(base, cliProviderHostRunVersion({ ...ZAI, updatedAt: "2026-09-18T00:00:00.000Z" }, "glm-5.3"));
  assert.equal(base, cliProviderHostRunVersion({ ...ZAI }, " glm-5.3 "));
});

test("readiness: a bound member needs the CLI to run and the provider to have a key, not a first-party sign-in", () => {
  const agents: AgentHealth[] = [
    { kind: "claude-code", label: "Claude Code", installed: true, detection: "detected", runnable: "ready", authentication: "required" }
  ];
  const providers = [{ kind: "claude-code" as const, enabled: true }];
  assert.equal(readinessForParticipant({ kind: "claude-code" }, agents, providers), "sign-in-required");
  assert.equal(readinessForParticipant({ kind: "claude-code", host: ZAI }, agents, providers), "ready");
  assert.equal(readinessForParticipant({ kind: "claude-code", host: { ...ZAI, hasApiKey: false } }, agents, providers), "sign-in-required");
  // A host for another CLI does not count.
  assert.equal(readinessForParticipant({ kind: "claude-code", host: { ...ZAI, cli: "codex-cli" } }, agents, providers), "sign-in-required");
  const missing: AgentHealth[] = [{ kind: "claude-code", label: "Claude Code", installed: false, detection: "not-detected" }];
  assert.equal(readinessForParticipant({ kind: "claude-code", host: ZAI }, missing, providers), "not-detected");
});

test("GLM models resolve the context window Claude Code itself reports for them", () => {
  for (const model of cliProviderHostModels({ vendor: "zai" }) ?? []) {
    assert.equal(contextWindowForModel("claude-code", model.id), 200_000, model.id);
  }
  assert.equal(contextWindowForModel("claude-code", "glm-4.7"), undefined);
  assert.equal(contextWindowForModel("claude-code", "claude-opus-4-8"), 1_000_000);
});
