import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SettingsService } from "./settings";
import { createHeadlessPlatform, setHostPlatform } from "../platform";

// A real service against a real settings file: the studio's whole promise is that
// a drawn avatar is still there after a restart, and only a round trip proves it.
// Run with: node --require ./scripts/electron-stub.cjs
async function service(userData?: string): Promise<{ settings: SettingsService; userData: string }> {
  const dir = userData ?? await mkdtemp(path.join(tmpdir(), "accord-settings-avatars-"));
  process.env.ACCORD_TEST_USER_DATA = dir;
  // Settings reaches its directory through the host platform, so the test says
  // where that is the way the machine runtime does rather than through Electron.
  setHostPlatform(createHeadlessPlatform({ userDataDir: dir, appVersion: "test" }));
  return { settings: new SettingsService(), userData: dir };
}

const PNG_BASE64 = "iVBORw0KGgo=";

test("a saved avatar survives a restart and later settings writes", async () => {
  const { settings, userData } = await service();
  const afterSave = await settings.saveCustomAvatar({ mediaType: "image/png", dataBase64: PNG_BASE64, label: "@gera" });
  assert.equal(afterSave.chatCustomAvatars.length, 1);
  const id = afterSave.chatCustomAvatars[0].id;

  // A second service instance against the same directory is the restart.
  const { settings: restarted } = await service(userData);
  const reloaded = await restarted.getPublicSettings();
  assert.equal(reloaded.chatCustomAvatars.length, 1, "avatar metadata lost across restart");
  assert.equal(reloaded.chatCustomAvatars[0].id, id);
  const read = await restarted.readCustomAvatar(id);
  assert.equal(read.dataBase64, PNG_BASE64);

  // An unrelated settings write must not drop the avatars either.
  await restarted.updateLastRepoPath(userData);
  const stored = JSON.parse(await readFile(path.join(userData, "settings.json"), "utf8")) as Record<string, unknown>;
  assert.equal((stored.chatCustomAvatars as unknown[]).length, 1, "avatar metadata erased by an unrelated write");
});

test("reading an unknown avatar fails instead of returning someone else's bytes", async () => {
  const { settings } = await service();
  await assert.rejects(() => settings.readCustomAvatar("missing"), /not found/);
});

test("an empty picture is rejected before anything is written", async () => {
  const { settings, userData } = await service();
  await assert.rejects(() => settings.saveCustomAvatar({ mediaType: "image/png", dataBase64: "", label: "@gera" }), /Empty/);
  const files = await readdir(path.join(userData, "avatars")).catch(() => []);
  assert.deepEqual(files, []);
});

test("settings written by an older build without avatars still load", async () => {
  const { settings, userData } = await service();
  await writeFile(path.join(userData, "settings.json"), JSON.stringify({ roundLimitDefault: 2, providers: [] }), "utf8");
  const loaded = await settings.getPublicSettings();
  assert.deepEqual(loaded.chatCustomAvatars, []);
});
