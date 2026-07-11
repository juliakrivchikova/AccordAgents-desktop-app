import type { ChatProviderKind, ProviderSettings } from "./types";

const CHAT_PROVIDER_PREFERENCE: ChatProviderKind[] = ["codex-cli", "claude-code", "gemini-cli"];

export function isChatProviderKind(value: unknown): value is ChatProviderKind {
  return value === "codex-cli" || value === "claude-code" || value === "gemini-cli";
}

export function chatProviderKind(value: unknown, fallback: ChatProviderKind = "codex-cli"): ChatProviderKind {
  return isChatProviderKind(value) ? value : fallback;
}

export function preferredChatProviderSetting(providers: ProviderSettings[]): ProviderSettings | undefined {
  for (const enabled of [true, false]) {
    for (const kind of CHAT_PROVIDER_PREFERENCE) {
      const provider = providers.find((item) => item.kind === kind && (enabled ? item.enabled : true));
      if (provider) {
        return provider;
      }
    }
  }
  return undefined;
}
