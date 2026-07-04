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
