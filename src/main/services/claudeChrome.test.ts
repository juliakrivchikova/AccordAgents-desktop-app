import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  claudeChromeEditEnvironment,
  claudeChromeLaunchFlag,
  claudeChromeSettingsEdit,
  claudeGlobalConfigPath,
  readClaudeChromeSetting
} from "./claudeChrome";

test("the CLI's global config is read where Claude Code keeps it", () => {
  const none = () => false;
  assert.equal(claudeGlobalConfigPath({ HOME: "/Users/me" }, "darwin", none), "/Users/me/.claude.json");
  assert.equal(claudeGlobalConfigPath({ HOME: "/Users/me", CLAUDE_CONFIG_DIR: "/opt/claude" }, "darwin", none), "/opt/claude/.claude.json");
  assert.equal(claudeGlobalConfigPath({ HOME: "/Users/me", CLAUDE_CODE_CUSTOM_OAUTH_URL: "https://sso" }, "darwin", none), "/Users/me/.claude-custom-oauth.json");
  assert.equal(claudeGlobalConfigPath({ HOME: "/Users/me" }, "darwin", (file) => file === "/Users/me/.claude/.config.json"), "/Users/me/.claude/.config.json",
    "a legacy config file wins, as in the CLI");
  assert.equal(claudeGlobalConfigPath({ CLAUDE_CONFIG_DIR: "/opt/claude" }, "darwin", (file) => file === "/opt/claude/.config.json"), "/opt/claude/.config.json");
});

test("members get Claude in Chrome exactly when the CLI's Enabled by default is on", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "accordagents-claude-chrome-"));
  try {
    const env = { CLAUDE_CONFIG_DIR: dir };
    assert.deepEqual(await readClaudeChromeSetting(env), { enabledByDefault: false }, "no config yet: off");
    const file = path.join(dir, ".claude.json");
    await writeFile(file, JSON.stringify({ numStartups: 3, cachedChromeExtensionInstalled: true }));
    assert.deepEqual(await readClaudeChromeSetting(env), { enabledByDefault: false }, "never set: off, as in the CLI without --chrome");
    await writeFile(file, JSON.stringify({ claudeInChromeDefaultEnabled: true, cachedChromeExtensionInstalled: true, other: "x".repeat(10) }));
    await utimes(file, new Date(), new Date(Date.now() + 5_000));
    assert.deepEqual(await readClaudeChromeSetting(env), { enabledByDefault: true }, "a change is read again");
    await writeFile(file, "{ half written");
    await utimes(file, new Date(), new Date(Date.now() + 10_000));
    assert.deepEqual(await readClaudeChromeSetting(env), { enabledByDefault: true }, "a file the CLI is rewriting keeps what it said before");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an environment that already decides Chrome is left to the CLI", () => {
  assert.equal(claudeChromeLaunchFlag({ enabledByDefault: true }, {}), true);
  assert.equal(claudeChromeLaunchFlag({ enabledByDefault: false }, {}), false);
  assert.equal(claudeChromeLaunchFlag({ enabledByDefault: true }, { CLAUDE_CODE_ENABLE_CFC: "0" }), false);
  assert.equal(claudeChromeLaunchFlag({ enabledByDefault: false }, { CLAUDE_CODE_ENABLE_CFC: "1" }), false, "the CLI turns it on itself");
});

test("the setting is changed through the CLI's own edit, outside any Claude Code session", () => {
  assert.equal(claudeChromeSettingsEdit(true), "{\"enabledByDefault\":true}");
  assert.deepEqual(claudeChromeEditEnvironment({ PATH: "/bin", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli" }), { PATH: "/bin" });
});
