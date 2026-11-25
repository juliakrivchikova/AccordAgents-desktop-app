import type { CliStartDefaults } from "../cliStartDefaults";
import type { ChatReasoningEffort } from "./members";

export type ProviderKind = "openai" | "anthropic" | "gemini" | "codex-cli" | "claude-code" | "gemini-cli";

export interface ProviderSettings {
  kind: ProviderKind;
  label: string;
  enabled: boolean;
  model?: string;
}

export type ChatProviderKind = Extract<ProviderKind, "codex-cli" | "claude-code" | "gemini-cli">;

/** Which local CLI an added provider runs through. */
export type CliProviderHostCli = Extract<ChatProviderKind, "claude-code" | "codex-cli" | "gemini-cli">;

export type CliProviderHostVendor = "anthropic" | "zai" | "moonshot" | "minimax" | "deepseek" | "openai" | "google" | "custom";

/** An added provider (General Settings → Add provider): a vendor endpoint
 *  reached through one of the local CLIs with the user's own API key. It sits
 *  next to the built-in, subscription-authenticated CLIs and a member can be
 *  bound to either. The key itself never crosses the bridge. */
export interface CliProviderHost {
  id: string;
  label: string;
  cli: CliProviderHostCli;
  vendor: CliProviderHostVendor;
  baseUrl: string;
  hasApiKey: boolean;
  updatedAt: string;
}

export interface CliProviderHostUpdate {
  id?: string;
  label: string;
  cli: CliProviderHostCli;
  vendor: CliProviderHostVendor;
  baseUrl: string;
  /** Omit to keep the stored key; empty string clears it. */
  apiKey?: string;
}

export interface ProviderSettingsUpdate {
  kind: ProviderKind;
  enabled?: boolean;
  model?: string;
}

export type ProviderModelSource = "cli" | "provider-api" | "configured" | "builtin";

export interface ProviderReasoningEffortOption {
  id: ChatReasoningEffort;
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface ProviderModel {
  id: string;
  label: string;
  description?: string;
  createdAt?: string;
  source?: ProviderModelSource;
  recommended?: boolean;
  hidden?: boolean;
  supportedReasoningEfforts?: ProviderReasoningEffortOption[];
  defaultReasoningEffort?: ChatReasoningEffort;
}

export interface ProviderModelCatalog {
  kind: ProviderKind;
  /** A CLI's list: `recommended` marks the model it runs when none is
   *  chosen, the one the User's own config names (else the CLI's default). */
  models: ProviderModel[];
  authoritative: boolean;
  fetchedAt: string;
  error?: string;
  /** What the CLI starts a new session in with the User's own config on this
   *  device (src/shared/cliStartDefaults.ts); none when it could not say. */
  startDefaults?: CliStartDefaults;
}

export interface ParticipantConfig {
  id: string;
  kind: ProviderKind;
  label: string;
  model?: string;
  reasoningEffort?: ChatReasoningEffort;
  /** `key=value` Codex config overrides passed as `-c` to every codex launch
   *  (exec, app-server, compact); used to route a member through an added
   *  provider's Responses endpoint. */
  codexConfigOverrides?: string[];
  /** Antigravity session settings (settings.json keys) added to every agy
   *  launch; used to route a member to the Gemini API with its own key. */
  geminiSettings?: Record<string, unknown>;
}
