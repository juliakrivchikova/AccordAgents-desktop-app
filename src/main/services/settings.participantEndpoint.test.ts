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
import { ZAI_DEFAULT_AUTH_TOKEN_ENV_KEY, ZAI_DEFAULT_BASE_URL } from "../../shared/chatParticipantEndpoint";

const ROLE: ChatRoleConfig = {
  id: "custom-engineer",
  label: "Engineer",
  instructions: "Build things.",
  version: 1,
  builtIn: false,
  updatedAt: "2026-09-16T00:00:00.000Z"
};

const ZAI = { preset: "zai" as const, baseUrl: ZAI_DEFAULT_BASE_URL, authTokenEnvKey: ZAI_DEFAULT_AUTH_TOKEN_ENV_KEY };

function settingsServiceWith(initial: { chatParticipantConfigs?: unknown[] } = {}) {
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
    chatParticipantSeedState: {}
  };
  service.readStored = async () => stored;
  service.writeStored = async (next: typeof stored) => {
    stored = next;
  };
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
    chatParticipantSeedState: stored.chatParticipantSeedState
  });
  return { service, stored: () => stored };
}

test("a Claude Code member preset keeps its Z.ai endpoint across save and reload", async () => {
  const { service, stored } = settingsServiceWith();
  await service.saveChatParticipantConfig({
    handle: "glm",
    roleConfigId: ROLE.id,
    behaviorRuleIds: [],
    kind: "claude-code",
    model: "glm-5.3",
    endpoint: { preset: "zai", baseUrl: `${ZAI_DEFAULT_BASE_URL}/`, authTokenEnvKey: " ZAI_API_KEY " }
  });
  assert.deepEqual(stored().chatParticipantConfigs[0]?.endpoint, ZAI);
  const reloaded = service.mergeDefaults(JSON.parse(JSON.stringify(stored())));
  assert.deepEqual(reloaded.chatParticipantConfigs[0]?.endpoint, ZAI);
  assert.equal(reloaded.chatParticipantConfigs[0]?.model, "glm-5.3");
});

test("saving a Claude Code preset without an endpoint clears a previously saved one", async () => {
  const { service, stored } = settingsServiceWith({
    chatParticipantConfigs: [{ id: "p1", handle: "glm", roleConfigId: ROLE.id, kind: "claude-code", endpoint: ZAI, updatedAt: "2026-09-16T00:00:00.000Z" }]
  });
  await service.saveChatParticipantConfig({ id: "p1", handle: "glm", roleConfigId: ROLE.id, behaviorRuleIds: [], kind: "claude-code" });
  assert.equal(stored().chatParticipantConfigs[0]?.endpoint, undefined);
});

test("an endpoint never attaches to Codex or Antigravity presets", async () => {
  const { service, stored } = settingsServiceWith();
  await service.saveChatParticipantConfig({ handle: "cx", roleConfigId: ROLE.id, behaviorRuleIds: [], kind: "codex-cli", endpoint: ZAI });
  assert.equal(stored().chatParticipantConfigs[0]?.endpoint, undefined);
  const reloaded = service.mergeDefaults({
    ...JSON.parse(JSON.stringify(stored())),
    chatParticipantConfigs: [{ id: "g1", handle: "gem", roleConfigId: ROLE.id, kind: "gemini-cli", endpoint: ZAI, updatedAt: "2026-09-16T00:00:00.000Z" }]
  });
  assert.equal(reloaded.chatParticipantConfigs[0]?.endpoint, undefined);
});

test("an invalid endpoint URL or variable name is rejected instead of stored", async () => {
  const { service, stored } = settingsServiceWith();
  await assert.rejects(
    service.saveChatParticipantConfig({ handle: "glm", roleConfigId: ROLE.id, behaviorRuleIds: [], kind: "claude-code", endpoint: { preset: "nope" } }),
    /Member endpoint is not recognized/
  );
  assert.equal(stored().chatParticipantConfigs.length, 0);
});

test("a stored endpoint with damaged fields is repaired to the preset defaults on reload", () => {
  const { service } = settingsServiceWith();
  const reloaded = service.mergeDefaults({
    settingsVersion: 1,
    chatRoleConfigs: [ROLE],
    chatParticipantConfigs: [{
      id: "p1",
      handle: "glm",
      roleConfigId: ROLE.id,
      kind: "claude-code",
      endpoint: { preset: "zai", baseUrl: 42, authTokenEnvKey: "" },
      updatedAt: "2026-09-16T00:00:00.000Z"
    }]
  });
  assert.deepEqual(reloaded.chatParticipantConfigs[0]?.endpoint, ZAI);
});
