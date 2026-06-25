import assert from "node:assert/strict";
import test from "node:test";
import { CLI_AGENT_RUN_TIMEOUT_DEFAULT_MS } from "../../shared/cliAgentRunSettings";
import type { AppSettings } from "../../shared/types";
import { SettingsService } from "./settings";

function settingsServiceWithStoredSettings(initial: Partial<AppSettings> = {}) {
  const service = Object.create(SettingsService.prototype) as any;
  let stored = {
    settingsVersion: 1,
    roundLimitDefault: 1,
    cliAgentRunTimeoutMs: CLI_AGENT_RUN_TIMEOUT_DEFAULT_MS,
    providers: [],
    chatRoleConfigs: [],
    chatBehaviorRules: [],
    chatSavedPrompts: [],
    chatParticipantConfigs: [],
    chatParticipantSeedState: {},
    ...initial
  };

  service.readStored = async () => stored;
  service.writeStored = async (next: typeof stored) => {
    stored = next;
  };
  service.getPublicSettings = async () => ({
    roundLimitDefault: stored.roundLimitDefault,
    cliAgentRunTimeoutMs: service.normalizeCliAgentRunTimeoutMs(stored.cliAgentRunTimeoutMs),
    providers: stored.providers,
    chatRoleConfigs: stored.chatRoleConfigs,
    chatBehaviorRules: stored.chatBehaviorRules,
    chatSavedPrompts: stored.chatSavedPrompts,
    chatParticipantConfigs: stored.chatParticipantConfigs,
    chatParticipantSeedState: stored.chatParticipantSeedState,
    repoFileOpenAction: service.normalizeRepoFileOpenAction(stored.repoFileOpenAction)
  });

  return { service, stored: () => stored };
}

test("setRepoFileOpenAction accepts IntelliJ IDEA as a saved file open action", async () => {
  const { service, stored } = settingsServiceWithStoredSettings();

  const settings = await service.setRepoFileOpenAction("intellij-idea");

  assert.equal(stored().repoFileOpenAction, "intellij-idea");
  assert.equal(settings.repoFileOpenAction, "intellij-idea");
});

test("setRepoFileOpenAction clears invalid file open actions", async () => {
  const { service, stored } = settingsServiceWithStoredSettings();

  const settings = await service.setRepoFileOpenAction("idea" as any);

  assert.equal(stored().repoFileOpenAction, undefined);
  assert.equal(settings.repoFileOpenAction, undefined);
});
