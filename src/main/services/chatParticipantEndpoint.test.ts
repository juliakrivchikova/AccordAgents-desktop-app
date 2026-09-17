import assert from "node:assert/strict";
import test from "node:test";
import { contextWindowForModel } from "../../shared/agentContext";
import {
  ZAI_DEFAULT_AUTH_TOKEN_ENV_KEY,
  ZAI_DEFAULT_BASE_URL,
  ZAI_DEFAULT_MODEL,
  ZAI_MODELS,
  chatParticipantEndpointDefaultModel,
  chatParticipantEndpointEnv,
  chatParticipantEndpointEnvVersion,
  chatParticipantEndpointHandleSlug,
  chatParticipantEndpointDefaultModelLabel,
  chatParticipantEndpointFor,
  chatParticipantEndpointLabel,
  chatParticipantEndpointValidationError,
  normalizeChatParticipantEndpoint,
  sameChatParticipantEndpoint
} from "../../shared/chatParticipantEndpoint";

const ZAI = { preset: "zai" as const, baseUrl: ZAI_DEFAULT_BASE_URL, authTokenEnvKey: ZAI_DEFAULT_AUTH_TOKEN_ENV_KEY };

test("normalizeChatParticipantEndpoint repairs partial records and rejects unknown presets", () => {
  assert.deepEqual(normalizeChatParticipantEndpoint({ preset: "zai" }), ZAI);
  assert.deepEqual(
    normalizeChatParticipantEndpoint({ preset: "zai", baseUrl: " https://proxy.example/anthropic/ ", authTokenEnvKey: " MY_KEY " }),
    { preset: "zai", baseUrl: "https://proxy.example/anthropic", authTokenEnvKey: "MY_KEY" }
  );
  // Malformed URL / variable fall back to the preset defaults instead of half-applying.
  assert.deepEqual(normalizeChatParticipantEndpoint({ preset: "zai", baseUrl: "not a url", authTokenEnvKey: "9bad" }), ZAI);
  assert.equal(normalizeChatParticipantEndpoint({ preset: "other", baseUrl: ZAI_DEFAULT_BASE_URL }), undefined);
  assert.equal(normalizeChatParticipantEndpoint("zai"), undefined);
  assert.equal(normalizeChatParticipantEndpoint(undefined), undefined);
});

test("endpoint validation runs on the raw value and names the field that is wrong", () => {
  assert.equal(chatParticipantEndpointValidationError(ZAI), undefined);
  assert.equal(chatParticipantEndpointValidationError({ preset: "zai", baseUrl: " https://proxy.example/ ", authTokenEnvKey: " MY_KEY " }), undefined);
  assert.match(chatParticipantEndpointValidationError({ ...ZAI, baseUrl: "ftp://x" }) ?? "", /Endpoint URL/);
  assert.match(chatParticipantEndpointValidationError({ ...ZAI, baseUrl: "not a url" }) ?? "", /Endpoint URL/);
  assert.match(chatParticipantEndpointValidationError({ ...ZAI, authTokenEnvKey: "with-dash" }) ?? "", /API key variable/);
  // Names Settings → Environment refuses (managed by the app or the OS) are refused here too.
  assert.match(chatParticipantEndpointValidationError({ ...ZAI, authTokenEnvKey: "PATH" }) ?? "", /API key variable/);
  assert.match(chatParticipantEndpointValidationError({ ...ZAI, authTokenEnvKey: "ACCORD_AGENTS_MCP_TOKEN" }) ?? "", /API key variable/);
  assert.match(chatParticipantEndpointValidationError({ preset: "nope" }) ?? "", /not recognized/);
  assert.match(chatParticipantEndpointValidationError("zai") ?? "", /not recognized/);
  assert.equal(chatParticipantEndpointValidationError(undefined), undefined);
  assert.equal(chatParticipantEndpointValidationError(null), undefined);
});

test("only Claude Code members carry an endpoint", () => {
  assert.deepEqual(chatParticipantEndpointFor("claude-code", ZAI), ZAI);
  assert.equal(chatParticipantEndpointFor("codex-cli", ZAI), undefined);
  assert.equal(chatParticipantEndpointFor("gemini-cli", ZAI), undefined);
  assert.equal(chatParticipantEndpointLabel(ZAI), "GLM (Z.ai)");
  assert.equal(chatParticipantEndpointLabel(undefined), undefined);
  assert.equal(chatParticipantEndpointDefaultModel(ZAI), ZAI_DEFAULT_MODEL);
  assert.equal(chatParticipantEndpointDefaultModel(undefined), undefined);
  assert.equal(chatParticipantEndpointDefaultModelLabel(ZAI), "GLM-5.3");
  assert.equal(chatParticipantEndpointHandleSlug(ZAI), "glm");
  assert.equal(chatParticipantEndpointHandleSlug(undefined), undefined);
  assert.equal(sameChatParticipantEndpoint(ZAI, { ...ZAI }), true);
  assert.equal(sameChatParticipantEndpoint(ZAI, { ...ZAI, authTokenEnvKey: "OTHER" }), false);
  assert.equal(sameChatParticipantEndpoint(undefined, undefined), true);
  assert.equal(sameChatParticipantEndpoint(ZAI, undefined), false);
});

test("endpoint env mirrors the Z.ai Claude Code guide and reads the token from Settings → Environment only", () => {
  const resolved = chatParticipantEndpointEnv(ZAI, { ZAI_API_KEY: " secret-token ", UNRELATED: "x" }, "glm-5.2");
  assert.equal(resolved.missingEnvKey, undefined);
  assert.deepEqual(resolved.env, {
    ANTHROPIC_BASE_URL: ZAI_DEFAULT_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: "secret-token",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.2",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.2",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-5.3-flash",
    API_TIMEOUT_MS: "3000000",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    // Inherited Anthropic credentials and cloud-provider switches are cleared so
    // the user's own Anthropic key is never sent to the endpoint (Claude Code
    // otherwise sends it as x-api-key next to the Bearer token).
    ANTHROPIC_API_KEY: "",
    CLAUDE_CODE_OAUTH_TOKEN: "",
    CLAUDE_CODE_USE_BEDROCK: "",
    CLAUDE_CODE_USE_VERTEX: "",
    CLAUDE_CODE_USE_FOUNDRY: ""
  });
  // No model on the member → the preset default, never the CLI's Anthropic alias.
  assert.equal(chatParticipantEndpointEnv(ZAI, { ZAI_API_KEY: "t" }, undefined).env.ANTHROPIC_DEFAULT_OPUS_MODEL, ZAI_DEFAULT_MODEL);
  // A custom variable name is honored.
  const custom = chatParticipantEndpointEnv({ ...ZAI, authTokenEnvKey: "GLM_TOKEN" }, { GLM_TOKEN: "abc" }, undefined);
  assert.equal(custom.env.ANTHROPIC_AUTH_TOKEN, "abc");
});

test("a missing or blank token variable is reported, not silently sent as an empty header", () => {
  assert.deepEqual(chatParticipantEndpointEnv(ZAI, {}, "glm-5.3"), { env: {}, missingEnvKey: "ZAI_API_KEY" });
  assert.deepEqual(chatParticipantEndpointEnv(ZAI, { ZAI_API_KEY: "   " }, "glm-5.3"), { env: {}, missingEnvKey: "ZAI_API_KEY" });
  // Object prototype members are not Settings values.
  for (const key of ["constructor", "__proto__", "toString"]) {
    assert.deepEqual(chatParticipantEndpointEnv({ ...ZAI, authTokenEnvKey: key }, {}, "glm-5.3"), { env: {}, missingEnvKey: key });
  }
});

test("endpoint env version changes with endpoint or model so a warm process is recycled", () => {
  assert.equal(chatParticipantEndpointEnvVersion(undefined, "glm-5.3"), "");
  const base = chatParticipantEndpointEnvVersion(ZAI, "glm-5.3");
  assert.notEqual(base, chatParticipantEndpointEnvVersion(ZAI, "glm-5.2"));
  assert.notEqual(base, chatParticipantEndpointEnvVersion({ ...ZAI, baseUrl: "https://other.example" }, "glm-5.3"));
  assert.notEqual(base, chatParticipantEndpointEnvVersion({ ...ZAI, authTokenEnvKey: "OTHER" }, "glm-5.3"));
  assert.equal(base, chatParticipantEndpointEnvVersion({ ...ZAI }, " glm-5.3 "));
});

test("GLM models resolve the context window Claude Code itself reports for them", () => {
  for (const model of ZAI_MODELS) {
    assert.equal(contextWindowForModel("claude-code", model.id), 200_000, model.id);
  }
  assert.equal(contextWindowForModel("claude-code", "glm-5.4"), 200_000);
  assert.equal(contextWindowForModel("claude-code", "glm-4.7"), undefined);
  assert.equal(contextWindowForModel("claude-code", "claude-opus-4-8"), 1_000_000);
});
