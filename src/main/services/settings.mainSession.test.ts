import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SettingsService } from "./settings";
import { createHeadlessPlatform, setHostPlatform } from "../platform";
import { MAIN_SESSION_ROLE_ID } from "../../shared/mainSession";
import type { ChatRoleConfig } from "../../shared/types";

async function withSettings(run: (make: () => SettingsService, file: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-main-session-settings-"));
  const file = path.join(dir, "settings.json");
  const make = () => { const service = new SettingsService(); (service as unknown as { settingsPath: string }).settingsPath = file; return service; };
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

test("the view a new chat opens in is one of the two views, unset meaning sessions", async () => {
  await withSettings(async (make, file) => {
    assert.equal((await make().getPublicSettings()).defaultChatView, undefined, "unset: new chats open in the sessions view");
    const saved = await make().setDefaultChatView("classic");
    assert.equal(saved.defaultChatView, "classic");
    assert.equal(JSON.parse(await readFile(file, "utf8")).defaultChatView, "classic");
    assert.equal((await make().getPublicSettings()).defaultChatView, "classic", "kept across launches");
    await assert.rejects(make().setDefaultChatView("grid" as never), /Unknown chat view/);
    assert.equal((await make().getPublicSettings()).defaultChatView, "classic");

    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), defaultChatView: "tiles" }));
    assert.equal((await make().getPublicSettings()).defaultChatView, undefined, "anything else read back is the default");
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
