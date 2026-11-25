import { createHash } from "node:crypto";
import { assertAgentEnvironmentKeyAllowed, normalizeAgentEnvironmentKey } from "../../../../shared/agentEnvironment";
import type { StoredAgentEnvironmentVariable } from "../types";

export function normalizeAgentEnvironmentVariables(value: unknown): StoredAgentEnvironmentVariable[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const variables: StoredAgentEnvironmentVariable[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = item as Partial<StoredAgentEnvironmentVariable>;
    const key = normalizeAgentEnvironmentKey(record.key);
    if (!key || seen.has(key)) {
      continue;
    }
    try {
      assertAgentEnvironmentKeyAllowed(key);
    } catch {
      continue;
    }
    const encryptedValue = typeof record.encryptedValue === "string" ? record.encryptedValue : "";
    const updatedAt = typeof record.updatedAt === "string" && record.updatedAt
      ? record.updatedAt
      : new Date().toISOString();
    variables.push({
      key,
      encryptedValue,
      enabled: record.enabled === false ? false : true,
      updatedAt,
      protection: record.protection === "os-encrypted" ? "os-encrypted" : "local-obfuscated",
      ...(record.source === "automatic" ? { source: "automatic" as const } : {})
    });
    seen.add(key);
  }
  return variables.sort((left, right) => left.key.localeCompare(right.key));
}

export function agentEnvironmentVersion(env: NodeJS.ProcessEnv, removedKeys: string[] = []): string {
  const hash = createHash("sha256");
  for (const key of removedKeys) {
    hash.update(`-${key}\0`);
  }
  for (const [key, value] of Object.entries(env).sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(key);
    hash.update("\0");
    hash.update(value ?? "");
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

function normalizedStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.flatMap((item) =>
    typeof item === "string" && item.trim() ? [item.trim()] : []
  ))];
}
