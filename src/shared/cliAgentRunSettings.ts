export const CLI_AGENT_RUN_TIMEOUT_DEFAULT_MS = 24 * 60 * 60_000;
export const CLI_AGENT_RUN_TIMEOUT_MIN_MS = 60 * 60_000;
export const CLI_AGENT_RUN_TIMEOUT_MAX_MS = 7 * 24 * 60 * 60_000;

export function normalizeCliAgentRunTimeoutMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return CLI_AGENT_RUN_TIMEOUT_DEFAULT_MS;
  }
  const floored = Math.floor(value);
  return Math.min(CLI_AGENT_RUN_TIMEOUT_MAX_MS, Math.max(CLI_AGENT_RUN_TIMEOUT_MIN_MS, floored));
}

export function cliAgentRunTimeoutHours(value: unknown): number {
  return Math.round(normalizeCliAgentRunTimeoutMs(value) / (60 * 60_000));
}
