import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ClaudeChromeSetting } from "../../shared/types";

/**
 * Claude in Chrome as Claude Code itself decides it. In its non-interactive
 * mode (the one members run in) the CLI turns the integration off unless it
 * is started with `--chrome` or `CLAUDE_CODE_ENABLE_CFC`, whatever the
 * "Enabled by default" setting of its `/chrome` dialog says; interactively it
 * follows that setting. Members therefore get `--chrome` exactly when the
 * setting is on, and the setting itself is the CLI's own
 * (`claudeInChromeDefaultEnabled` in its global config), changed through its
 * own `edit-chrome-settings` command.
 */

/** Where the CLI keeps its global config for this environment, by its own
 *  rules (Claude Code 2.1.280): a legacy `.config.json` in its config folder
 *  wins; otherwise `.claude.json` (`.claude-custom-oauth.json` with a custom
 *  OAuth URL) in CLAUDE_CONFIG_DIR or the home folder. */
export function claudeGlobalConfigPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  exists: (file: string) => boolean = existsSync
): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  // Windows resolves the home folder from USERPROFILE, whatever HOME says.
  const home = platform === "win32" ? homedir() : env.HOME?.trim() || homedir();
  const legacy = path.join(configDir || path.join(home, ".claude"), ".config.json");
  if (exists(legacy)) return legacy;
  const suffix = env.CLAUDE_CODE_CUSTOM_OAUTH_URL?.trim() ? "-custom-oauth" : "";
  return path.join(configDir || home, `.claude${suffix}.json`);
}

const cache = new Map<string, { mtimeMs: number; size: number; setting: ClaudeChromeSetting }>();

/** The CLI's setting; a missing or unreadable config reads as off. Cached by
 *  the file's modification time, so a member's launch reads it only when it
 *  changed. */
export async function readClaudeChromeSetting(env: NodeJS.ProcessEnv): Promise<ClaudeChromeSetting> {
  const file = claudeGlobalConfigPath(env);
  const info = await stat(file).catch(() => undefined);
  if (!info) return { enabledByDefault: false };
  const cached = cache.get(file);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.setting;
  const parse = async (): Promise<Record<string, unknown> | undefined> => {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return undefined;
    }
  };
  // Being rewritten by the CLI right now: read once more, then what it said
  // before still holds.
  const config = await parse() ?? await new Promise((resolve) => setTimeout(resolve, 50)).then(parse);
  if (!config) return cached?.setting ?? { enabledByDefault: false };
  // Only the setting: the CLI's cached "extension installed" can be stale
  // (it read false here while the extension was installed in a profile).
  const setting: ClaudeChromeSetting = { enabledByDefault: config.claudeInChromeDefaultEnabled === true };
  cache.set(file, { mtimeMs: info.mtimeMs, size: info.size, setting });
  return setting;
}

/** Whether a member's CLI should be started with `--chrome`: only when the
 *  setting is on and the environment does not decide it already
 *  (`CLAUDE_CODE_ENABLE_CFC` takes precedence in the CLI itself). */
export function claudeChromeLaunchFlag(setting: ClaudeChromeSetting, env: NodeJS.ProcessEnv): boolean {
  if (claudeChromeEnvironmentDecides(env)) return false;
  return setting.enabledByDefault;
}

export function claudeChromeEnvironmentDecides(env: NodeJS.ProcessEnv): boolean {
  return env.CLAUDE_CODE_ENABLE_CFC !== undefined && env.CLAUDE_CODE_ENABLE_CFC !== "";
}

/** The edit the CLI's `edit-chrome-settings --json` reads from stdin. */
export function claudeChromeSettingsEdit(enabledByDefault: boolean): string {
  return JSON.stringify({ enabledByDefault });
}

/** The environment for that command: it refuses to run inside a Claude Code
 *  session, which an app started from one would otherwise pass on. */
export function claudeChromeEditEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  delete clean.CLAUDE_CODE_CHILD_SESSION;
  delete clean.CLAUDECODE;
  delete clean.CLAUDE_CODE_ENTRYPOINT;
  return clean;
}
