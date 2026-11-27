import type { CommandEnvironmentOptions } from "../../command";

const CLAUDE_CODE_LOGIN_SHELL_AUTH_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL"
];

export const CLAUDE_CODE_SKIP_PROMPT_HISTORY_ENV = "CLAUDE_CODE_SKIP_PROMPT_HISTORY";
export const CLAUDE_CODE_FORCE_SESSION_PERSISTENCE_ENV = "CLAUDE_CODE_FORCE_SESSION_PERSISTENCE";

export const CLAUDE_CODE_COMMAND_ENV_OPTIONS: CommandEnvironmentOptions = {
  dropProcessEnvKeysAbsentFromLoginShell: CLAUDE_CODE_LOGIN_SHELL_AUTH_ENV_KEYS,
  // Claude Code reminds the model that the person has heard nothing from it
  // after this many seconds of silence in a turn, instead of only after five
  // tool rounds and at most three times since her message (the User,
  // 2026-11-27: she follows a member's work in the chat). Claude Code's own
  // setting; one set on this computer or in Settings wins.
  defaults: { CLAUDE_CODE_SILENT_TURN_REMINDER_SECONDS: "60" }
};
