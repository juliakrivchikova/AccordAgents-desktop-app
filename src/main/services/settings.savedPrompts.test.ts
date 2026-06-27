import assert from "node:assert/strict";
import test from "node:test";
import { SettingsService } from "./settings";
import type { AppSettings, ChatSavedPromptConfig } from "../../shared/types";
import {
  CHAT_SAVED_PROMPT_BODY_MAX_CHARS,
  CHAT_SAVED_PROMPT_LABEL_MAX_CHARS
} from "../../shared/chatSavedPrompts";
import { CHAT_COMPLETION_NOTIFICATION_DEFAULT_THRESHOLD_MS } from "../../shared/chatCompletionNotifications";
import { CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT } from "../../shared/chatParticipantRequests";
import { CLI_AGENT_RUN_TIMEOUT_DEFAULT_MS } from "../../shared/cliAgentRunSettings";

function savedPrompt(overrides: Partial<ChatSavedPromptConfig> = {}): ChatSavedPromptConfig {
  return {
    id: "bug-repro-prompt",
    label: "Bug repro",
    trigger: "bug",
    body: "Please write exact repro steps.",
    version: 1,
    updatedAt: "2026-06-24T00:00:00.000Z",
    ...overrides
  };
}

function settingsServiceWithStoredSettings(initial: Partial<AppSettings> = {}) {
  const service = Object.create(SettingsService.prototype) as any;
  let stored: {
    settingsVersion: number;
    roundLimitDefault: number;
    cliAgentRunTimeoutMs: number;
    chatParticipantRequestMaxDepth: number;
    chatCompletionNotifications: AppSettings["chatCompletionNotifications"];
    providers: AppSettings["providers"];
    chatRoleConfigs: AppSettings["chatRoleConfigs"];
    chatBehaviorRules: AppSettings["chatBehaviorRules"];
    chatSavedPrompts?: ChatSavedPromptConfig[];
    chatParticipantConfigs: AppSettings["chatParticipantConfigs"];
    chatParticipantSeedState: NonNullable<AppSettings["chatParticipantSeedState"]>;
  } = {
    settingsVersion: 1,
    roundLimitDefault: 1,
    cliAgentRunTimeoutMs: CLI_AGENT_RUN_TIMEOUT_DEFAULT_MS,
    chatParticipantRequestMaxDepth: CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT,
    chatCompletionNotifications: { enabled: false, thresholdMs: CHAT_COMPLETION_NOTIFICATION_DEFAULT_THRESHOLD_MS },
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

  return {
    service: service as SettingsService,
    stored: () => stored,
    writeCount: () => writeCount
  };
}

test("getPublicSettings defaults missing saved prompts to an empty list", async () => {
  const { service } = settingsServiceWithStoredSettings({
    chatSavedPrompts: undefined
  } as Partial<AppSettings>);

  const settings = await service.getPublicSettings();

  assert.deepEqual(settings.chatSavedPrompts, []);
});

test("saveChatSavedPromptConfig creates a normalized personal prompt", async () => {
  const { service, stored } = settingsServiceWithStoredSettings();

  const settings = await service.saveChatSavedPromptConfig({
    label: "  Bug repro  ",
    trigger: "/bug-repro",
    body: "  Please write exact repro steps.  "
  });

  const prompt = settings.chatSavedPrompts[0];
  assert.ok(prompt);
  assert.match(prompt.id, /^bug-repro-[0-9a-f-]{36}$/);
  assert.equal(prompt.label, "Bug repro");
  assert.equal(prompt.trigger, "bug-repro");
  assert.equal(prompt.body, "Please write exact repro steps.");
  assert.equal(prompt.version, 1);
  assert.deepEqual(stored().chatSavedPrompts, settings.chatSavedPrompts);
});

test("saveChatSavedPromptConfig updates existing prompts without changing id", async () => {
  const { service } = settingsServiceWithStoredSettings({
    chatSavedPrompts: [savedPrompt({ version: 2 })]
  });

  const settings = await service.saveChatSavedPromptConfig({
    id: "bug-repro-prompt",
    label: "Investigation",
    trigger: "investigate",
    body: "Find the root cause first."
  });

  assert.deepEqual(settings.chatSavedPrompts.map((prompt) => ({
    id: prompt.id,
    label: prompt.label,
    trigger: prompt.trigger,
    body: prompt.body,
    version: prompt.version
  })), [{
    id: "bug-repro-prompt",
    label: "Investigation",
    trigger: "investigate",
    body: "Find the root cause first.",
    version: 3
  }]);
});

test("saveChatSavedPromptConfig rejects invalid or duplicate saved prompts without writing", async () => {
  const { service, writeCount } = settingsServiceWithStoredSettings({
    chatSavedPrompts: [savedPrompt()]
  });

  await assert.rejects(
    () => service.saveChatSavedPromptConfig({
      label: "x".repeat(CHAT_SAVED_PROMPT_LABEL_MAX_CHARS + 1),
      trigger: "new-prompt",
      body: "Body"
    }),
    new RegExp(`${CHAT_SAVED_PROMPT_LABEL_MAX_CHARS} characters or less`)
  );
  await assert.rejects(
    () => service.saveChatSavedPromptConfig({
      label: "Invalid",
      trigger: "bad trigger",
      body: "Body"
    }),
    /letters, numbers, underscores, and hyphens only/
  );
  await assert.rejects(
    () => service.saveChatSavedPromptConfig({
      label: "Duplicate",
      trigger: "/BUG",
      body: "Body"
    }),
    /already exists/
  );
  await assert.rejects(
    () => service.saveChatSavedPromptConfig({
      label: "Oversized",
      trigger: "oversized",
      body: "x".repeat(CHAT_SAVED_PROMPT_BODY_MAX_CHARS + 1)
    }),
    new RegExp(`${CHAT_SAVED_PROMPT_BODY_MAX_CHARS} characters or less`)
  );
  assert.equal(writeCount(), 0);
});

test("deleteChatSavedPromptConfig removes only the matching prompt", async () => {
  const { service, stored } = settingsServiceWithStoredSettings({
    chatSavedPrompts: [
      savedPrompt({ id: "first-prompt", trigger: "first" }),
      savedPrompt({ id: "second-prompt", trigger: "second" })
    ]
  });

  const settings = await service.deleteChatSavedPromptConfig("first-prompt");

  assert.deepEqual(settings.chatSavedPrompts.map((prompt) => prompt.id), ["second-prompt"]);
  assert.deepEqual((stored().chatSavedPrompts ?? []).map((prompt) => prompt.id), ["second-prompt"]);
});
