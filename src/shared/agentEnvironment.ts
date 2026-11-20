export const AGENT_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type AgentEnvironmentValueMap = Record<string, string | undefined>;

const AGENT_ENV_BLOCKED_EXACT = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "PWD",
  "OLDPWD",
  "SHLVL"
]);

const AGENT_ENV_BLOCKED_PREFIXES = ["ACCORD_AGENTS_"];

export function normalizeAgentEnvironmentKey(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function agentEnvironmentKeyValidationError(value: unknown): string | undefined {
  const key = normalizeAgentEnvironmentKey(value);
  if (!key) {
    return "Environment variable key is required.";
  }
  if (!AGENT_ENV_KEY_PATTERN.test(key)) {
    return "Environment variable keys must start with a letter or underscore and contain only letters, numbers, and underscores.";
  }
  if (AGENT_ENV_BLOCKED_EXACT.has(key) || AGENT_ENV_BLOCKED_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    return `${key} is managed by AccordAgents or the operating system and cannot be configured manually.`;
  }
  return undefined;
}

export function assertAgentEnvironmentKeyAllowed(value: unknown): string {
  const error = agentEnvironmentKeyValidationError(value);
  if (error) {
    throw new Error(error);
  }
  return normalizeAgentEnvironmentKey(value);
}

export function filterAllowedAgentEnvironment(env: AgentEnvironmentValueMap | undefined): AgentEnvironmentValueMap {
  const result: AgentEnvironmentValueMap = {};
  for (const [rawKey, value] of Object.entries(env ?? {})) {
    if (value === undefined) {
      continue;
    }
    const key = normalizeAgentEnvironmentKey(rawKey);
    if (!key || agentEnvironmentKeyValidationError(key)) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

/** What the computer sets for its own programs: its system, folders and
 *  session. They describe this computer, so they are not offered as
 *  automatic variables (Windows names are compared in upper case). */
const AUTOMATIC_EXCLUDED_EXACT = new Set([
  "_",
  "OS",
  "COMSPEC",
  "PATHEXT",
  "NUMBER_OF_PROCESSORS",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "USERNAME",
  "USERDOMAIN",
  "USERDOMAIN_ROAMINGPROFILE",
  "COMPUTERNAME",
  "SESSIONNAME",
  "LOGONSERVER",
  "ALLUSERSPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMW6432",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMW6432",
  "PUBLIC",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "DRIVERDATA",
  "PSMODULEPATH",
  "PROMPT",
  "TEMP",
  "TMP",
  "LAUNCHINSTANCEID",
  "MALLOCNANOZONE",
  // New in every shell: following them would rewrite the list each time.
  "ATUIN_SESSION",
  "ATUIN_HISTORY_ID",
  "STARSHIP_SESSION_KEY",
  "STARSHIP_SHELL",
  "SHELL_SESSION_ID",
  "TERM_SESSION_ID",
  "ITERM_SESSION_ID",
  "WEZTERM_PANE"
]);

const AUTOMATIC_EXCLUDED_PREFIXES = ["PROCESSOR_", "ACCORDAGENTS_", "ONEDRIVE"];

/** True for a name read from this computer that is offered as an automatic
 *  variable: a valid, allowed name that is not one of the computer's own. */
export function isAutomaticAgentEnvironmentKey(key: string): boolean {
  if (agentEnvironmentKeyValidationError(key)) {
    return false;
  }
  const upper = key.toUpperCase();
  // Windows names ignore case: "Path" is PATH.
  return !AGENT_ENV_BLOCKED_EXACT.has(upper)
    && !AUTOMATIC_EXCLUDED_EXACT.has(upper) && !AUTOMATIC_EXCLUDED_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/** True when a value is a path on this computer (a folder or file, or a list
 *  of them): such an automatic value is kept from the cloud machines, where
 *  the path does not exist. */
export function isLocalPathValue(value: string): boolean {
  const trimmed = value.trim();
  // A leading "/" alone is not enough: base64 keys can start with one.
  return /^(~\/|[A-Za-z]:[\\/]|\\\\)/.test(trimmed)
    || /^\/(Users|home|opt|usr|var|tmp|private|Applications|Library|System|Volumes|etc|nix|snap|mnt|srv|root|bin|sbin)(\/|:|$)/.test(trimmed);
}

/** The first and last four characters with the middle hidden, so a key can be
 *  recognised without being shown; a short value is all dots. */
export function agentEnvironmentValuePreview(value: string): string {
  const characters = Array.from(value);
  // Shorter values would show too much of themselves.
  if (characters.length < 20) {
    return "••••••••";
  }
  return `${characters.slice(0, 4).join("")}••••••••${characters.slice(-4).join("")}`;
}
