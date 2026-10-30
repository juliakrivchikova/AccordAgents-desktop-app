import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT,
  CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_DEFAULT
} from "../../shared/chatParticipantRequests";
import { DEFAULT_CHAT_PROMPT_CONTEXT } from "../../shared/chatPromptContext";
import { CLI_AGENT_RUN_TIMEOUT_DEFAULT_MS } from "../../shared/cliAgentRunSettings";
import type { AppSettings } from "../../shared/types";
import { SettingsService } from "./settings";

function settingsServiceWithStoredSettings(initial: Partial<AppSettings> = {}) {
  const service = Object.create(SettingsService.prototype) as any;
  let stored = {
    settingsVersion: 1,
    roundLimitDefault: 1,
    betaUpdates: false,
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

  service.readStored = async () => stored;
  service.writeStored = async (next: typeof stored) => {
    stored = next;
  };
  service.getPublicSettings = async () => ({
    roundLimitDefault: stored.roundLimitDefault,
    betaUpdates: service.normalizeBetaUpdates(stored.betaUpdates),
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

test("setRepoFileOpenAction keeps the side panel as a saved choice", async () => {
  const { service, stored } = settingsServiceWithStoredSettings();

  const settings = await service.setRepoFileOpenAction("panel");

  assert.equal(stored().repoFileOpenAction, "panel");
  assert.equal(settings.repoFileOpenAction, "panel");
});

async function settingsOnDisk(contents: Record<string, unknown>) {
  const { mkdtemp, readFile, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(os.tmpdir(), "aa-file-open-settings-"));
  const file = path.join(dir, "settings.json");
  await writeFile(file, JSON.stringify({ settingsVersion: 1, roundLimitDefault: 1, providers: [], ...contents }));
  const make = () => {
    const service = new SettingsService();
    (service as any).settingsPath = file;
    return service;
  };
  return { make, read: async () => JSON.parse(await readFile(file, "utf8")) };
}

test("the side panel becomes the click once, and the earlier choice moves to its Open in button", async () => {
  const disk = await settingsOnDisk({ repoFileOpenAction: "intellij-idea" });

  const first = await disk.make().getPublicSettings();
  assert.equal(first.repoFileOpenAction, "panel");
  assert.equal(first.repoFileExternalOpenAction, "intellij-idea");

  // The User then chooses IntelliJ again; nothing turns it back into the panel.
  const service = disk.make();
  await service.setRepoFileOpenAction("intellij-idea");
  assert.equal((await disk.read()).repoFileOpenPanelMigrated, true);
  const later = await disk.make().getPublicSettings();
  assert.equal(later.repoFileOpenAction, "intellij-idea");
  assert.equal(later.repoFileExternalOpenAction, "intellij-idea");
});

test("a fresh install clicks into the side panel and opens outside with the default app", async () => {
  const disk = await settingsOnDisk({});

  const settings = await disk.make().getPublicSettings();

  assert.equal(settings.repoFileOpenAction, "panel");
  assert.equal(settings.repoFileExternalOpenAction, "open");
});

test("a later write keeps the Open in choice and the migration flag", async () => {
  const disk = await settingsOnDisk({ repoFileOpenAction: "open" });
  const service = disk.make();

  await service.setRepoFileExternalOpenAction("intellij-idea");
  await service.setBetaUpdates(true);

  const written = await disk.read();
  assert.equal(written.repoFileExternalOpenAction, "intellij-idea");
  assert.equal(written.repoFileOpenPanelMigrated, true);
  assert.equal(written.repoFileOpenAction, "panel");
  await assert.rejects(service.setRepoFileExternalOpenAction("reveal"), /IntelliJ IDEA or the default app/);
});
