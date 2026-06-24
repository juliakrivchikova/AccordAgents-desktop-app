import assert from "node:assert/strict";
import test from "node:test";
import { SettingsService } from "./settings";
import type { AppSettings, ChatParticipantConfig, ChatRoleConfig } from "../../shared/types";
import { CLI_AGENT_RUN_TIMEOUT_DEFAULT_MS } from "../../shared/cliAgentRunSettings";

function makeRole(over: Partial<ChatRoleConfig> = {}): ChatRoleConfig {
  return {
    id: "custom-reviewer",
    label: "Reviewer",
    instructions: "Review things.",
    version: 1,
    builtIn: false,
    updatedAt: "2026-06-20T00:00:00.000Z",
    ...over
  };
}

function makeParticipant(over: Partial<ChatParticipantConfig> = {}): ChatParticipantConfig {
  return {
    id: "p1",
    handle: "rev",
    roleConfigId: "custom-reviewer",
    behaviorRuleIds: [],
    kind: "codex-cli",
    updatedAt: "2026-06-20T00:00:00.000Z",
    ...over
  };
}

function settingsServiceWith(
  initial: { chatRoleConfigs?: ChatRoleConfig[]; chatParticipantConfigs?: ChatParticipantConfig[] } = {}
) {
  const service = Object.create(SettingsService.prototype) as any;
  let stored = {
    settingsVersion: 1,
    roundLimitDefault: 1,
    cliAgentRunTimeoutMs: CLI_AGENT_RUN_TIMEOUT_DEFAULT_MS,
    providers: [],
    chatRoleConfigs: initial.chatRoleConfigs ?? [],
    chatBehaviorRules: [],
    chatParticipantConfigs: initial.chatParticipantConfigs ?? [],
    chatParticipantSeedState: {}
  };
  let writeCount = 0;
  service.readStored = async () => stored;
  service.writeStored = async (next: typeof stored) => {
    writeCount += 1;
    stored = next;
  };
  service.getPublicSettings = async (): Promise<AppSettings> => ({
    roundLimitDefault: stored.roundLimitDefault,
    cliAgentRunTimeoutMs: stored.cliAgentRunTimeoutMs,
    providers: stored.providers,
    chatRoleConfigs: stored.chatRoleConfigs,
    chatBehaviorRules: stored.chatBehaviorRules,
    chatParticipantConfigs: stored.chatParticipantConfigs,
    chatParticipantSeedState: stored.chatParticipantSeedState
  });
  return { service, stored: () => stored, writeCount: () => writeCount };
}

test("default Chat Assistant does not offer itself for off-setup task work", () => {
  const { service } = settingsServiceWith();
  const roles = (service as any).mergeDefaultRoles(undefined) as ChatRoleConfig[];
  const assistant = roles.find((role) => role.id === "administrator");

  assert.ok(assistant);
  assert.match(assistant.instructions, /help User set up and adjust roles and participants in this chat/);
  assert.match(assistant.instructions, /Understand role and participant setup requests/);
  assert.match(assistant.instructions, /When User describes a problem, task, or question, use that description to suggest or add the most suitable participant who can help/);
  assert.match(assistant.instructions, /Do not interact with, request, or hand off to another participant unless User explicitly asks you to do that/);
  assert.match(assistant.instructions, /If the chat already contains a suitable participant, tell User that participant is available and that User can address them directly with `@handle`/);
  assert.match(assistant.instructions, /Do not offer Chat Assistant as an option for doing the task/);
  assert.match(assistant.instructions, /Only handle the task yourself if User explicitly asks Chat Assistant/);
  assert.match(assistant.instructions, /Do not create a `User choice` block just to offer whether Chat Assistant should handle an off-setup task/);
  assert.doesNotMatch(assistant.instructions, /set up and adjust who participates/);
  assert.doesNotMatch(assistant.instructions, /\b(?:create|edit|manage|set up|adjust)\s+(?:rules|prompts)\b/i);
});

test("archives an unused custom role and retains the record", async () => {
  const { service, stored, writeCount } = settingsServiceWith({ chatRoleConfigs: [makeRole()] });
  const settings: AppSettings = await service.archiveChatRoleConfig("custom-reviewer");
  const role = settings.chatRoleConfigs.find((item) => item.id === "custom-reviewer");
  assert.ok(role, "role is still present after archive");
  assert.ok(role?.archivedAt, "archivedAt is set");
  assert.equal(stored().chatRoleConfigs.length, 1, "the role record is retained, not removed");
  assert.equal(writeCount(), 1);
});

test("rejects archiving a built-in role", async () => {
  const { service, writeCount } = settingsServiceWith({
    chatRoleConfigs: [makeRole({ id: "generic-participant", label: "Generic Participant", builtIn: true })]
  });
  await assert.rejects(() => service.archiveChatRoleConfig("generic-participant"), /cannot be deleted/);
  assert.equal(writeCount(), 0);
});

test("rejects archiving a role used by a saved participant preset", async () => {
  const { service, writeCount } = settingsServiceWith({
    chatRoleConfigs: [makeRole()],
    chatParticipantConfigs: [makeParticipant()]
  });
  await assert.rejects(() => service.archiveChatRoleConfig("custom-reviewer"), /used by 1 saved participant preset/);
  assert.equal(writeCount(), 0);
});

test("deleting the saved participant preset frees the role for archive", async () => {
  const { service, stored } = settingsServiceWith({
    chatRoleConfigs: [makeRole()],
    chatParticipantConfigs: [makeParticipant()]
  });

  await service.deleteChatParticipantConfig("p1");
  const settings: AppSettings = await service.archiveChatRoleConfig("custom-reviewer");

  assert.equal(stored().chatParticipantConfigs.length, 0);
  const role = settings.chatRoleConfigs.find((item) => item.id === "custom-reviewer");
  assert.ok(role?.archivedAt);
});

test("rejects archiving an unknown role", async () => {
  const { service } = settingsServiceWith({ chatRoleConfigs: [makeRole()] });
  await assert.rejects(() => service.archiveChatRoleConfig("does-not-exist"), /Unknown role/);
});

test("rejects editing an archived role", async () => {
  const { service, writeCount } = settingsServiceWith({
    chatRoleConfigs: [makeRole({ archivedAt: "2026-06-19T00:00:00.000Z" })]
  });
  await assert.rejects(
    () => service.saveChatRoleConfig({
      id: "custom-reviewer",
      label: "Edited Reviewer",
      instructions: "Do something else."
    }),
    /Deleted role "Reviewer" cannot be edited/
  );
  assert.equal(writeCount(), 0);
});

test("rejects editing an archived role in a grouped role/participant write", async () => {
  const { service, writeCount } = settingsServiceWith({
    chatRoleConfigs: [makeRole({ archivedAt: "2026-06-19T00:00:00.000Z" })]
  });
  await assert.rejects(
    () => service.saveChatRoleParticipantConfigBatch([{
      type: "edit_role",
      role: {
        roleConfigId: "custom-reviewer",
        label: "Edited Reviewer",
        instructions: "Do something else."
      }
    }], []),
    /Deleted role "Reviewer" cannot be edited/
  );
  assert.equal(writeCount(), 0);
});

test("rejects assigning an archived role to a new saved participant preset", async () => {
  const { service, writeCount } = settingsServiceWith({
    chatRoleConfigs: [makeRole({ archivedAt: "2026-06-19T00:00:00.000Z" })]
  });
  await assert.rejects(
    () => service.saveChatParticipantConfig({
      handle: "archived",
      roleConfigId: "custom-reviewer",
      kind: "codex-cli"
    }),
    /Deleted role "Reviewer" cannot be assigned/
  );
  assert.equal(writeCount(), 0);
});

test("rejects assigning an archived role in a grouped participant write", async () => {
  const { service, writeCount } = settingsServiceWith({
    chatRoleConfigs: [makeRole({ archivedAt: "2026-06-19T00:00:00.000Z" })]
  });
  await assert.rejects(
    () => service.saveChatRoleParticipantConfigBatch([], [{
      handle: "archived",
      roleConfigId: "custom-reviewer",
      kind: "codex-cli"
    }]),
    /Deleted role "Reviewer" cannot be assigned/
  );
  assert.equal(writeCount(), 0);
});

test("allows editing an existing saved participant that already references an archived role", async () => {
  const { service, stored, writeCount } = settingsServiceWith({
    chatRoleConfigs: [makeRole({ archivedAt: "2026-06-19T00:00:00.000Z" })],
    chatParticipantConfigs: [makeParticipant()]
  });
  await service.saveChatParticipantConfig({
    id: "p1",
    handle: "reviewer",
    roleConfigId: "custom-reviewer",
    kind: "codex-cli"
  });
  assert.equal(stored().chatParticipantConfigs[0].handle, "reviewer");
  assert.equal(stored().chatParticipantConfigs[0].roleConfigId, "custom-reviewer");
  assert.equal(writeCount(), 1);
});

test("archiving is idempotent and does not rewrite an already-archived role", async () => {
  const { service, writeCount } = settingsServiceWith({
    chatRoleConfigs: [makeRole({ archivedAt: "2026-06-19T00:00:00.000Z" })]
  });
  const settings: AppSettings = await service.archiveChatRoleConfig("custom-reviewer");
  assert.equal(settings.chatRoleConfigs[0].archivedAt, "2026-06-19T00:00:00.000Z");
  assert.equal(writeCount(), 0, "already-archived role is not rewritten");
});
