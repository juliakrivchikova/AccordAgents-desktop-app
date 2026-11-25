import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SettingsService } from "./settings";
import { settingsDependencies } from "./settings/test/settingsParts";
import { createHeadlessPlatform, setHostPlatform } from "../platform";
import { MAIN_SESSION_ROLE_ID } from "../../shared/mainSession";
import type { ChatRoleConfig } from "../../shared/types";

async function withSettings(run: (make: () => SettingsService, file: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-main-session-settings-"));
  const file = path.join(dir, "settings.json");
  const make = () => { const service = new SettingsService(); (settingsDependencies(service) as unknown as { settingsPath: string }).settingsPath = file; return service; };
  setHostPlatform(createHeadlessPlatform({ userDataDir: dir, appVersion: "test" }));
  try {
    await run(make, file);
  } finally {
    setHostPlatform(undefined);
    await rm(dir, { recursive: true, force: true });
  }
}

test("an install from before gets the main session's role, and its rights to ask and add members cannot be taken from its stored copy", async () => {
  await withSettings(async (make, file) => {
    const fresh = await make().getPublicSettings();
    const offered = fresh.chatRoleConfigs.find((role) => role.id === MAIN_SESSION_ROLE_ID);
    assert.ok(offered, "seeded like every built-in role");
    assert.equal(offered.builtIn, true);
    assert.deepEqual(
      [offered.participantDefaults?.requestParticipants, offered.participantDefaults?.manageRolesParticipants],
      ["allow", "allow"]
    );

    // A stored copy from an install that had the role already, its rights
    // turned down by hand.
    const stored = JSON.parse(await readFile(file, "utf8").catch(() => "{}")) as { chatRoleConfigs?: ChatRoleConfig[] };
    const roles = (stored.chatRoleConfigs ?? fresh.chatRoleConfigs).map((role) => role.id === MAIN_SESSION_ROLE_ID
      ? { ...role, participantDefaults: { ...role.participantDefaults, requestParticipants: "deny" as const, manageRolesParticipants: "deny" as const } }
      : role);
    await writeFile(file, JSON.stringify({ ...stored, settingsVersion: 1, providers: [], chatRoleConfigs: roles }));
    const reread = (await make().getPublicSettings()).chatRoleConfigs.find((role) => role.id === MAIN_SESSION_ROLE_ID);
    assert.deepEqual(
      [reread?.participantDefaults?.requestParticipants, reread?.participantDefaults?.manageRolesParticipants],
      ["allow", "allow"]
    );

    // An install whose settings predate the role.
    await writeFile(file, JSON.stringify({ settingsVersion: 1, providers: [], chatRoleConfigs: fresh.chatRoleConfigs.filter((role) => role.id !== MAIN_SESSION_ROLE_ID) }));
    assert.ok((await make().getPublicSettings()).chatRoleConfigs.some((role) => role.id === MAIN_SESSION_ROLE_ID));
  });
});

test("Settings → General → New chats: compaction without asking by default, the CLI's own model, effort and mode, kept across launches", async () => {
  await withSettings(async (make, file) => {
    assert.deepEqual((await make().getPublicSettings()).newChatDefaults, { compactWithoutAsking: true }, "unset: the CLI's own, compaction without asking");

    await make().setAssistantProviderKind("claude-code");
    const chosen = await make().setNewChatDefaults({ kind: "claude-code", model: "claude-opus-5-5", reasoningEffort: "high", access: "auto" });
    assert.deepEqual(chosen.newChatDefaults, { kind: "claude-code", model: "claude-opus-5-5", reasoningEffort: "high", access: "auto", compactWithoutAsking: true });
    const off = await make().setNewChatDefaults({ compactWithoutAsking: false, homeMachineId: "machine-1" });
    assert.deepEqual(off.newChatDefaults, { kind: "claude-code", model: "claude-opus-5-5", reasoningEffort: "high", access: "auto", homeMachineId: "machine-1", compactWithoutAsking: false });
    assert.deepEqual((await make().getPublicSettings()).newChatDefaults, off.newChatDefaults, "kept across launches");

    // Back to the CLI's own model; this computer again.
    const reset = await make().setNewChatDefaults({ kind: "claude-code", model: null, homeMachineId: null });
    assert.deepEqual(reset.newChatDefaults, { kind: "claude-code", reasoningEffort: "high", access: "auto", compactWithoutAsking: false });

    // Another provider: its model, effort and mode go back to its own; where
    // it runs and compaction stay.
    await make().setNewChatDefaults({ homeMachineId: "machine-2" });
    const codex = await make().setAssistantProviderKind("codex-cli");
    assert.equal(codex.assistantProviderKind, "codex-cli");
    assert.deepEqual(codex.newChatDefaults, { homeMachineId: "machine-2", compactWithoutAsking: false });

    // A mode the CLI does not have, an unknown provider: refused or dropped.
    const wrongMode = await make().setNewChatDefaults({ kind: "codex-cli", access: "acceptEdits" });
    assert.deepEqual(wrongMode.newChatDefaults, { homeMachineId: "machine-2", compactWithoutAsking: false }, "Claude Code's mode is not Codex's");
    await assert.rejects(make().setNewChatDefaults({ kind: "grid" as never, model: "x" }), /Unknown provider/);

    // Whatever a file holds is read as the CLI's own; a view from before is dropped.
    await writeFile(file, JSON.stringify({
      ...JSON.parse(await readFile(file, "utf8")),
      defaultChatView: "classic",
      newChatDefaults: { kind: "codex-cli", model: 42, reasoningEffort: "loud", access: "full-access", compactWithoutAsking: "no" }
    }));
    const reread = await make().getPublicSettings();
    assert.deepEqual(reread.newChatDefaults, { kind: "codex-cli", access: "full-access", compactWithoutAsking: true });
    assert.equal((reread as unknown as { defaultChatView?: unknown }).defaultChatView, undefined, "not read: every new chat opens in the sessions view");
    // Yet kept in the file through a save, so a downgrade keeps her choice.
    await make().setNewChatDefaults({ compactWithoutAsking: false });
    assert.equal(JSON.parse(await readFile(file, "utf8")).defaultChatView, "classic");
  });
});

test("a saved member is never given the main session's role", async () => {
  await withSettings(async (make) => {
    await assert.rejects(
      make().saveChatParticipantConfig({ handle: "main", roleConfigId: MAIN_SESSION_ROLE_ID, kind: "claude-code", behaviorRuleIds: [] } as never),
      /cannot be given to a saved member/
    );
    assert.deepEqual((await make().getPublicSettings()).chatParticipantConfigs, []);
  });
});
