import { agentEnvironmentKeyValidationError, normalizeAgentEnvironmentKey } from "../../../../shared/agentEnvironment";

/** How a variable name is compared: Windows ignores case ("Path" is PATH). */
export function environmentKeyId(key: string): string {
  return process.platform === "win32" ? key.toUpperCase() : key;
}

/** Deleted names kept from coming back: valid, allowed and listed once. */
export function normalizeRemovedAutomaticKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const keys = new Set<string>();
  for (const item of value) {
    const key = normalizeAgentEnvironmentKey(item);
    if (key && !agentEnvironmentKeyValidationError(key)) keys.add(key);
  }
  return [...keys].sort();
}
