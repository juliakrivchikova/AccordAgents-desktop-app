import type { CliProviderHost } from "../../../../shared/types";
import { normalizeCliProviderHostRecord } from "../../../../shared/cliProviderHosts";
import type { StoredCliProviderHost, StoredSettings } from "../types";

// ---- Added providers (General Settings → Add provider) ----

export function normalizedCliProviderHosts(stored: StoredSettings): StoredCliProviderHost[] {
  const seen = new Set<string>();
  const hosts: StoredCliProviderHost[] = [];
  for (const raw of Array.isArray(stored.cliProviderHosts) ? stored.cliProviderHosts : []) {
    const host = normalizeCliProviderHostRecord(raw);
    if (!host || seen.has(host.id)) {
      continue;
    }
    seen.add(host.id);
    const record = raw as Partial<StoredCliProviderHost>;
    hosts.push({
      ...host,
      encryptedApiKey: typeof record.encryptedApiKey === "string" && record.encryptedApiKey ? record.encryptedApiKey : undefined,
      protection: record.protection === "os-encrypted" ? "os-encrypted" : record.protection === "local-obfuscated" ? "local-obfuscated" : undefined
    });
  }
  return hosts;
}

export function publicCliProviderHosts(stored: StoredSettings): CliProviderHost[] {
  return normalizedCliProviderHosts(stored).map((host) => ({
    id: host.id,
    label: host.label,
    cli: host.cli,
    vendor: host.vendor,
    baseUrl: host.baseUrl,
    hasApiKey: Boolean(host.encryptedApiKey),
    updatedAt: host.updatedAt
  }));
}
