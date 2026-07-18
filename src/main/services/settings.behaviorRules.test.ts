import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SettingsService } from "./settings";
import type { AgentHealth, AppSettings } from "../../shared/types";
import {
  CHAT_BEHAVIOR_RULE_INSTRUCTIONS_MAX_CHARS,
  CHAT_BEHAVIOR_RULE_LABEL_MAX_CHARS
} from "../../shared/chatBehaviorRules";
import {
  CLI_AGENT_RUN_TIMEOUT_DEFAULT_MS,
  CLI_AGENT_RUN_TIMEOUT_MIN_MS
} from "../../shared/cliAgentRunSettings";
import {
  CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT,
  CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_MAX,
  CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_MIN,
  CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_DEFAULT,
  CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_MAX,
  CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_MIN
} from "../../shared/chatParticipantRequests";
import {
  CHAT_PROMPT_CONTEXT_LIMIT_MAX,
  DEFAULT_CHAT_PROMPT_CONTEXT
} from "../../shared/chatPromptContext";

const CODEX_AGENT: AgentHealth = {
  kind: "codex-cli",
  label: "Codex",
  installed: true
};

const CLAUDE_AGENT: AgentHealth = {
  kind: "claude-code",
  label: "Claude Code",
  installed: true
};

const GEMINI_AGENT: AgentHealth = {
  kind: "gemini-cli",
  label: "Antigravity",
  installed: true
};

const MISSING_CLAUDE_AGENT: AgentHealth = {
  kind: "claude-code",
  label: "Claude Code",
  installed: false
};

function settingsServiceWithStoredSettings(initial: Partial<AppSettings> = {}) {
  const service = Object.create(SettingsService.prototype) as any;
  let stored = {
    settingsVersion: 1,
    roundLimitDefault: 1,
    cliAgentRunTimeoutMs: CLI_AGENT_RUN_TIMEOUT_DEFAULT_MS,
    chatParticipantRequestMaxDepth: CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT,
    chatParticipantRequestPromptMaxChars: CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_DEFAULT,
    chatPromptContext: DEFAULT_CHAT_PROMPT_CONTEXT,
    providers: [],
    chatRoleConfigs: [],
    chatBehaviorRules: [],
    chatSavedPrompts: [],
    chatParticipantConfigs: [],
    chatParticipantSeedState: {},
    ...initial
  };
  let writeCount = 0;

  service.readStored = async () => stored;
  service.writeStored = async (next: typeof stored) => {
    writeCount += 1;
    stored = next;
  };
  service.getPublicSettings = async () => ({
    roundLimitDefault: stored.roundLimitDefault,
    cliAgentRunTimeoutMs: service.normalizeCliAgentRunTimeoutMs(stored.cliAgentRunTimeoutMs),
    chatParticipantRequestMaxDepth: service.normalizeChatParticipantRequestMaxDepth(stored.chatParticipantRequestMaxDepth),
    chatParticipantRequestPromptMaxChars: service.normalizeChatParticipantRequestPromptMaxChars(stored.chatParticipantRequestPromptMaxChars),
    chatPromptContext: service.normalizeChatPromptContextSettings(stored.chatPromptContext),
    providers: stored.providers,
    chatRoleConfigs: stored.chatRoleConfigs,
    chatBehaviorRules: stored.chatBehaviorRules,
    chatSavedPrompts: stored.chatSavedPrompts,
    chatParticipantConfigs: stored.chatParticipantConfigs,
    chatParticipantSeedState: stored.chatParticipantSeedState,
    assistantProviderKind: service.normalizeChatProviderKind(stored.assistantProviderKind),
    lastSuccessfulChatProviderKind: service.normalizeChatProviderKind(stored.lastSuccessfulChatProviderKind)
  });

  return {
    service,
    stored: () => stored,
    writeCount: () => writeCount
  };
}

test("readStored purges legacy hosted providers and encrypted API keys from settings file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accordagents-settings-"));
  const settingsPath = path.join(dir, "settings.json");
  const service = Object.create(SettingsService.prototype) as any;
  service.settingsPath = settingsPath;
  service.storedWriteQueue = Promise.resolve();

  await writeFile(
    settingsPath,
    `${JSON.stringify({
      settingsVersion: 1,
      roundLimitDefault: 3,
      providers: [
        { kind: "openai", label: "OpenAI", enabled: true, model: "gpt-5.2", encryptedApiKey: "secret" },
        { kind: "codex-cli", label: "Codex CLI", enabled: false, model: "gpt-5.2-codex" },
        { kind: "claude-code", label: "Claude Code", enabled: true, model: "claude-sonnet-4-6" }
      ],
      chatRoleConfigs: [],
      chatBehaviorRules: [],
      chatParticipantConfigs: []
    }, null, 2)}\n`,
    "utf8"
  );

  const stored = await service.readStored();
  const persisted = JSON.parse(await readFile(settingsPath, "utf8")) as { providers: Array<Record<string, unknown>> };

  assert.deepEqual(stored.providers.map((provider: { kind: string }) => provider.kind), ["codex-cli", "claude-code", "gemini-cli"]);
  assert.deepEqual(persisted.providers.map((provider) => provider.kind), ["codex-cli", "claude-code", "gemini-cli"]);
  assert.deepEqual(stored.providers.map((provider: { label: string }) => provider.label), ["Codex", "Claude Code", "Antigravity"]);
  assert.deepEqual(persisted.providers.map((provider) => provider.label), ["Codex", "Claude Code", "Antigravity"]);
  assert.equal(JSON.stringify(persisted).includes("encryptedApiKey"), false);
  assert.equal(stored.providers.find((provider: { kind: string }) => provider.kind === "codex-cli")?.enabled, false);
});

test("behavior rule IDs include entropy so deleted rules cannot be reattached by label reuse", () => {
  const service = Object.create(SettingsService.prototype) as Record<string, (label: string) => string>;

  const first = service.behaviorRuleIdFromLabel("Be concise");
  const second = service.behaviorRuleIdFromLabel("Be concise");

  assert.match(first, /^be-concise-[0-9a-f-]{36}$/);
  assert.match(second, /^be-concise-[0-9a-f-]{36}$/);
  assert.notEqual(first, second);
});

test("saveChatBehaviorRuleConfig rejects oversized behavior rules", async () => {
  const service = Object.create(SettingsService.prototype) as any;
  let wroteSettings = false;
  service.readStored = async () => ({
    settingsVersion: 1,
    roundLimitDefault: 1,
    cliAgentRunTimeoutMs: CLI_AGENT_RUN_TIMEOUT_DEFAULT_MS,
    chatParticipantRequestMaxDepth: CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT,
    chatParticipantRequestPromptMaxChars: CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_DEFAULT,
    providers: [],
    chatRoleConfigs: [],
    chatBehaviorRules: [],
    chatSavedPrompts: [],
    chatParticipantConfigs: []
  });
  service.writeStored = async () => {
    wroteSettings = true;
  };
  service.getPublicSettings = async () => ({
    roundLimitDefault: 1,
    cliAgentRunTimeoutMs: CLI_AGENT_RUN_TIMEOUT_DEFAULT_MS,
    chatParticipantRequestMaxDepth: CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT,
    chatParticipantRequestPromptMaxChars: CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_DEFAULT,
    providers: [],
    chatRoleConfigs: [],
    chatBehaviorRules: [],
    chatSavedPrompts: [],
    chatParticipantConfigs: []
  });

  await assert.rejects(
    () => service.saveChatBehaviorRuleConfig({
      label: "x".repeat(CHAT_BEHAVIOR_RULE_LABEL_MAX_CHARS + 1),
      instructions: "Keep replies short."
    }),
    new RegExp(`${CHAT_BEHAVIOR_RULE_LABEL_MAX_CHARS} characters or less`)
  );
  await assert.rejects(
    () => service.saveChatBehaviorRuleConfig({
      label: "Be concise",
      instructions: "x".repeat(CHAT_BEHAVIOR_RULE_INSTRUCTIONS_MAX_CHARS + 1)
    }),
    new RegExp(`${CHAT_BEHAVIOR_RULE_INSTRUCTIONS_MAX_CHARS} characters or less`)
  );
  assert.equal(wroteSettings, false);
});

test("CLI agent run timeout defaults to 24 hours and persists bounded values", async () => {
  const { service, stored } = settingsServiceWithStoredSettings({
    cliAgentRunTimeoutMs: undefined
  } as Partial<AppSettings>);

  assert.equal(await service.getCliAgentRunTimeoutMs(), CLI_AGENT_RUN_TIMEOUT_DEFAULT_MS);

  const customTimeoutMs = 6 * 60 * 60_000;
  const updated = await service.setCliAgentRunTimeoutMs(customTimeoutMs);

  assert.equal(stored().cliAgentRunTimeoutMs, customTimeoutMs);
  assert.equal(updated.cliAgentRunTimeoutMs, customTimeoutMs);

  await service.setCliAgentRunTimeoutMs(5_000);

  assert.equal(stored().cliAgentRunTimeoutMs, CLI_AGENT_RUN_TIMEOUT_MIN_MS);
});

test("last successful chat provider persists idempotently", async () => {
  const { service, stored, writeCount } = settingsServiceWithStoredSettings();

  await service.recordSuccessfulChatProvider("claude-code");
  assert.equal(stored().lastSuccessfulChatProviderKind, "claude-code");
  assert.equal(writeCount(), 1);

  await service.recordSuccessfulChatProvider("claude-code");
  assert.equal(writeCount(), 1);

  await service.recordSuccessfulChatProvider("codex-cli");
  assert.equal(stored().lastSuccessfulChatProviderKind, "codex-cli");
  assert.equal(writeCount(), 2);
});

test("Assistant provider reads are pure and do not fold the last successful provider", async () => {
  const { service, stored, writeCount } = settingsServiceWithStoredSettings({
    lastSuccessfulChatProviderKind: "claude-code"
  });

  assert.equal((await service.getPublicSettings()).assistantProviderKind, undefined);
  assert.equal(writeCount(), 0);

  await service.ensureAssistantProviderDefault([CODEX_AGENT]);
  assert.equal(stored().assistantProviderKind, "claude-code");
  assert.equal(writeCount(), 1);

  const updated = await service.setAssistantProviderKind("codex-cli");
  assert.equal(stored().assistantProviderKind, "codex-cli");
  assert.equal(updated.assistantProviderKind, "codex-cli");
  assert.equal(writeCount(), 2);

  await service.setAssistantProviderKind("codex-cli");
  assert.equal(writeCount(), 2);
});

test("Assistant provider default uses Codex, Claude, then Antigravity priority and persists once", async () => {
  const { service, stored, writeCount } = settingsServiceWithStoredSettings();

  await service.ensureAssistantProviderDefault([GEMINI_AGENT, CLAUDE_AGENT, CODEX_AGENT]);
  assert.equal(stored().assistantProviderKind, "codex-cli");
  assert.equal(writeCount(), 1);

  await service.ensureAssistantProviderDefault([CLAUDE_AGENT]);
  assert.equal(stored().assistantProviderKind, "codex-cli");
  assert.equal(writeCount(), 1);
});

test("Assistant provider default skips disabled providers and supports an Antigravity-only install", async () => {
  const disabledCodex = settingsServiceWithStoredSettings({
    providers: [
      { kind: "codex-cli", label: "Codex", enabled: false },
      { kind: "claude-code", label: "Claude Code", enabled: true },
      { kind: "gemini-cli", label: "Antigravity", enabled: true }
    ]
  });
  await disabledCodex.service.ensureAssistantProviderDefault([CODEX_AGENT, CLAUDE_AGENT]);
  assert.equal(disabledCodex.stored().assistantProviderKind, "claude-code");

  const antigravityOnly = settingsServiceWithStoredSettings();
  await antigravityOnly.service.ensureAssistantProviderDefault([GEMINI_AGENT]);
  assert.equal(antigravityOnly.stored().assistantProviderKind, "gemini-cli");
});

test("Assistant provider default waits for readiness and initializes on a later refresh", async () => {
  const { service, stored, writeCount } = settingsServiceWithStoredSettings();

  await service.ensureAssistantProviderDefault([]);
  assert.equal(stored().assistantProviderKind, undefined);
  assert.equal(writeCount(), 0);

  await service.ensureAssistantProviderDefault([CLAUDE_AGENT]);
  assert.equal(stored().assistantProviderKind, "claude-code");
  assert.equal(writeCount(), 1);
});

test("concurrent Assistant initialization never overwrites an explicit Settings choice", async () => {
  const { service, stored } = settingsServiceWithStoredSettings();

  await Promise.all([
    service.ensureAssistantProviderDefault([CODEX_AGENT, CLAUDE_AGENT]),
    service.setAssistantProviderKind("claude-code")
  ]);

  assert.equal(stored().assistantProviderKind, "claude-code");
  await service.ensureAssistantProviderDefault([CODEX_AGENT]);
  assert.equal(stored().assistantProviderKind, "claude-code");
});

test("invalid Assistant provider preference is rejected without writing settings", async () => {
  const { service, stored, writeCount } = settingsServiceWithStoredSettings();

  await assert.rejects(
    service.setAssistantProviderKind("openai"),
    /Unknown Assistant provider: openai/
  );
  assert.equal(stored().assistantProviderKind, undefined);
  assert.equal(writeCount(), 0);
});

test("participant request max depth defaults to 2 and persists bounded values", async () => {
  const { service, stored } = settingsServiceWithStoredSettings({
    chatParticipantRequestMaxDepth: undefined
  } as Partial<AppSettings>);

  assert.equal(await service.getChatParticipantRequestMaxDepth(), CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT);

  const updated = await service.setChatParticipantRequestMaxDepth(3);

  assert.equal(stored().chatParticipantRequestMaxDepth, 3);
  assert.equal(updated.chatParticipantRequestMaxDepth, 3);

  await service.setChatParticipantRequestMaxDepth(99);
  assert.equal(stored().chatParticipantRequestMaxDepth, CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_MAX);

  await service.setChatParticipantRequestMaxDepth(0);
  assert.equal(stored().chatParticipantRequestMaxDepth, CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_MIN);
});

test("participant request prompt max chars defaults to 50000 and persists bounded values", async () => {
  const { service, stored } = settingsServiceWithStoredSettings({
    chatParticipantRequestPromptMaxChars: undefined
  } as Partial<AppSettings>);

  assert.equal(await service.getChatParticipantRequestPromptMaxChars(), CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_DEFAULT);

  const updated = await service.setChatParticipantRequestPromptMaxChars(75_000);

  assert.equal(stored().chatParticipantRequestPromptMaxChars, 75_000);
  assert.equal(updated.chatParticipantRequestPromptMaxChars, 75_000);

  await service.setChatParticipantRequestPromptMaxChars(999_999);
  assert.equal(stored().chatParticipantRequestPromptMaxChars, CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_MAX);

  await service.setChatParticipantRequestPromptMaxChars(10);
  assert.equal(stored().chatParticipantRequestPromptMaxChars, CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_MIN);
});

test("chat prompt context normalizes zero latest-unseen limits to off", async () => {
  const { service, stored } = settingsServiceWithStoredSettings();

  const updated = await service.setChatPromptContext({
    thread: { mode: "latest_unseen", limit: 0 },
    timeline: { mode: "latest_unseen", limit: 99 }
  });

  assert.deepEqual(stored().chatPromptContext.thread, { mode: "off" });
  assert.deepEqual(updated.chatPromptContext.thread, { mode: "off" });
  assert.deepEqual(stored().chatPromptContext.timeline, {
    mode: "latest_unseen",
    limit: CHAT_PROMPT_CONTEXT_LIMIT_MAX
  });
});

test("ensureGenericChatParticipantSeeds seeds installed CLI providers once and adds later installs", async () => {
  const { service, stored, writeCount } = settingsServiceWithStoredSettings();

  await service.ensureGenericChatParticipantSeeds([CODEX_AGENT, MISSING_CLAUDE_AGENT]);

  const codexSeed = stored().chatParticipantConfigs[0];
  assert.ok(codexSeed);
  assert.equal(stored().chatParticipantConfigs.length, 1);
  assert.equal(codexSeed.handle, "codex");
  assert.equal(codexSeed.kind, "codex-cli");
  assert.equal(codexSeed.roleConfigId, "generic-participant");
  assert.equal(codexSeed.avatarId, "codex-logo");
  const codexSeedRecord = stored().chatParticipantSeedState?.seededProviders?.["codex-cli"];
  assert.ok(codexSeedRecord);
  assert.equal(codexSeedRecord.participantConfigId, codexSeed.id);

  await service.ensureGenericChatParticipantSeeds([CODEX_AGENT, MISSING_CLAUDE_AGENT]);

  assert.equal(stored().chatParticipantConfigs.length, 1);
  assert.equal(writeCount(), 1);

  await service.ensureGenericChatParticipantSeeds([CODEX_AGENT, CLAUDE_AGENT]);

  const claudeSeed = stored().chatParticipantConfigs.find((participant) => participant.kind === "claude-code");
  assert.equal(stored().chatParticipantConfigs.length, 2);
  assert.equal(claudeSeed?.handle, "claude");
  assert.equal(claudeSeed?.roleConfigId, "generic-participant");
  assert.equal(claudeSeed?.avatarId, "claude-logo");
  const claudeSeedRecord = stored().chatParticipantSeedState?.seededProviders?.["claude-code"];
  assert.ok(claudeSeedRecord);
  assert.equal(claudeSeedRecord.participantConfigId, claudeSeed?.id);
});

test("ensureGenericChatParticipantSeeds does not resurrect deleted generic seed participants", async () => {
  const { service, stored } = settingsServiceWithStoredSettings();
  await service.ensureGenericChatParticipantSeeds([CODEX_AGENT]);
  const seededParticipant = stored().chatParticipantConfigs[0];
  assert.ok(seededParticipant);
  const seededId = seededParticipant.id;

  await service.deleteChatParticipantConfig(seededId);

  assert.equal(stored().chatParticipantConfigs.length, 0);
  assert.equal(stored().chatParticipantSeedState?.seededProviders?.["codex-cli"], undefined);
  const deletedSeedRecord = stored().chatParticipantSeedState?.deletedSeedProviders?.["codex-cli"];
  assert.ok(deletedSeedRecord);
  assert.equal(deletedSeedRecord.participantConfigId, seededId);

  await service.ensureGenericChatParticipantSeeds([CODEX_AGENT]);

  assert.equal(stored().chatParticipantConfigs.length, 0);
  assert.equal(stored().chatParticipantSeedState?.seededProviders?.["codex-cli"], undefined);
});
