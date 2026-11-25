import type { ProviderKind, ProviderSettings } from "../../../../shared/types";
import { CLI_PROVIDER_SETUP } from "../../../../shared/cliReadiness";

export const DEFAULT_PROVIDERS: ProviderSettings[] = [
  { kind: "codex-cli", label: CLI_PROVIDER_SETUP["codex-cli"].label, enabled: true },
  { kind: "claude-code", label: CLI_PROVIDER_SETUP["claude-code"].label, enabled: true },
  { kind: "gemini-cli", label: CLI_PROVIDER_SETUP["gemini-cli"].label, enabled: true }
];

export const DEFAULT_PROVIDER_KINDS = new Set<ProviderSettings["kind"]>(DEFAULT_PROVIDERS.map((provider) => provider.kind));

export function canonicalProviderLabel(kind: ProviderKind, fallback: string): string {
  if (kind === "codex-cli" || kind === "claude-code" || kind === "gemini-cli") {
    return CLI_PROVIDER_SETUP[kind].label;
  }
  return fallback;
}
