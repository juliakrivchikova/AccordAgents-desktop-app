import type {
  ChatParticipantEndpoint,
  ChatParticipantEndpointPreset,
  ChatProviderKind,
  ProviderModel,
  ProviderModelCatalog
} from "./types";
import { AGENT_ENV_KEY_PATTERN } from "./agentEnvironment";

// A GLM member is Claude Code pointed at Z.ai's Anthropic-compatible endpoint —
// exactly the setup Z.ai documents for the dedicated CLI
// (https://docs.z.ai/devpack/tool/claude). Every value here mirrors that guide so
// the member behaves like Claude Code configured by hand.
export const ZAI_ENDPOINT_PRESET: ChatParticipantEndpointPreset = "zai";
export const ZAI_DEFAULT_BASE_URL = "https://api.z.ai/api/anthropic";
export const ZAI_DEFAULT_AUTH_TOKEN_ENV_KEY = "ZAI_API_KEY";
export const ZAI_DEFAULT_MODEL = "glm-5.3";
const ZAI_SMALL_MODEL = "glm-5.3-flash";
// Z.ai's guide raises the request timeout and auto-compact window for GLM's 1M
// context and turns off Claude Code's non-essential Anthropic traffic.
const ZAI_API_TIMEOUT_MS = "3000000";
const ZAI_AUTO_COMPACT_WINDOW = "1000000";

export const ZAI_MODELS: ProviderModel[] = [
  { id: "glm-5.3", label: "GLM-5.3", description: "Flagship", source: "builtin", recommended: true },
  { id: "glm-5.3-flash", label: "GLM-5.3 Flash", description: "Fast", source: "builtin" },
  { id: "glm-5.2", label: "GLM-5.2", description: "Previous flagship", source: "builtin" }
];

// Context windows for GLM models served through Claude Code; consumed by
// agentContext.ts alongside the Anthropic model map. Z.ai serves these models
// with a 1M window, but Claude Code does not recognize GLM ids and reports
// `contextWindow: 200000` for them (verified on Claude Code 2.1.257, and it is
// what the CLI's own context display uses). The app mirrors the CLI rather than
// the vendor sheet so the live stream and the session-log fallback agree.
export const ZAI_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "glm-5.3": 200_000,
  "glm-5.3-flash": 200_000,
  "glm-5.2": 200_000
};

export function isChatParticipantEndpointPreset(value: unknown): value is ChatParticipantEndpointPreset {
  return value === ZAI_ENDPOINT_PRESET;
}

export function defaultChatParticipantEndpoint(preset: ChatParticipantEndpointPreset): ChatParticipantEndpoint {
  return { preset, baseUrl: ZAI_DEFAULT_BASE_URL, authTokenEnvKey: ZAI_DEFAULT_AUTH_TOKEN_ENV_KEY };
}

/** Accepts stored/wire values; returns undefined for anything that is not a
 *  usable endpoint so a malformed record degrades to plain Claude Code rather
 *  than to a half-configured one. */
export function normalizeChatParticipantEndpoint(value: unknown): ChatParticipantEndpoint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (!isChatParticipantEndpointPreset(record.preset)) {
    return undefined;
  }
  const defaults = defaultChatParticipantEndpoint(record.preset);
  const baseUrl = normalizeEndpointBaseUrl(record.baseUrl) ?? defaults.baseUrl;
  const authTokenEnvKey = normalizeEndpointEnvKey(record.authTokenEnvKey) ?? defaults.authTokenEnvKey;
  return { preset: record.preset, baseUrl, authTokenEnvKey };
}

export function normalizeEndpointBaseUrl(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
  if (!trimmed) {
    return undefined;
  }
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:" ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeEndpointEnvKey(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed && AGENT_ENV_KEY_PATTERN.test(trimmed) ? trimmed : undefined;
}

export function chatParticipantEndpointValidationError(endpoint: ChatParticipantEndpoint | undefined): string | undefined {
  if (!endpoint) {
    return undefined;
  }
  if (!normalizeEndpointBaseUrl(endpoint.baseUrl)) {
    return "Endpoint URL must be an http(s) URL.";
  }
  if (!normalizeEndpointEnvKey(endpoint.authTokenEnvKey)) {
    return "API key variable must be an environment variable name (letters, numbers, underscores).";
  }
  return undefined;
}

export function sameChatParticipantEndpoint(
  left: ChatParticipantEndpoint | undefined,
  right: ChatParticipantEndpoint | undefined
): boolean {
  if (!left || !right) {
    return !left && !right;
  }
  return left.preset === right.preset && left.baseUrl === right.baseUrl && left.authTokenEnvKey === right.authTokenEnvKey;
}

/** Only Claude Code can be pointed at an Anthropic-compatible endpoint. */
export function chatParticipantEndpointFor(
  kind: ChatProviderKind,
  endpoint: ChatParticipantEndpoint | undefined
): ChatParticipantEndpoint | undefined {
  return kind === "claude-code" ? endpoint : undefined;
}

export function chatParticipantEndpointLabel(endpoint: ChatParticipantEndpoint | undefined): string | undefined {
  return endpoint?.preset === ZAI_ENDPOINT_PRESET ? "GLM (Z.ai)" : undefined;
}

export function chatParticipantEndpointModelCatalog(endpoint: ChatParticipantEndpoint): ProviderModelCatalog {
  void endpoint;
  return {
    kind: "claude-code",
    models: ZAI_MODELS,
    authoritative: true,
    fetchedAt: new Date(0).toISOString()
  };
}

export function chatParticipantEndpointDefaultModel(endpoint: ChatParticipantEndpoint | undefined): string | undefined {
  return endpoint?.preset === ZAI_ENDPOINT_PRESET ? ZAI_DEFAULT_MODEL : undefined;
}

export interface ChatParticipantEndpointEnvResult {
  env: Record<string, string>;
  /** Set when the Settings → Environment variable named by the endpoint is absent. */
  missingEnvKey?: string;
}

/** Environment Claude Code needs to talk to the endpoint. `manualEnv` is the
 *  Settings → Environment map; the endpoint's token variable is read from it and
 *  never from the app's own process environment. */
export function chatParticipantEndpointEnv(
  endpoint: ChatParticipantEndpoint,
  manualEnv: Record<string, string | undefined>,
  model: string | undefined
): ChatParticipantEndpointEnvResult {
  const token = manualEnv[endpoint.authTokenEnvKey]?.trim();
  if (!token) {
    return { env: {}, missingEnvKey: endpoint.authTokenEnvKey };
  }
  const mainModel = model?.trim() || ZAI_DEFAULT_MODEL;
  return {
    env: {
      ANTHROPIC_BASE_URL: endpoint.baseUrl,
      ANTHROPIC_AUTH_TOKEN: token,
      // Claude Code resolves its "opus"/"sonnet"/"haiku" aliases (and its own
      // small-model calls) through these, so nothing falls back to an Anthropic id.
      ANTHROPIC_DEFAULT_OPUS_MODEL: mainModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: mainModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: ZAI_SMALL_MODEL,
      API_TIMEOUT_MS: ZAI_API_TIMEOUT_MS,
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: ZAI_AUTO_COMPACT_WINDOW,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
    }
  };
}

/** Stable key so a warm Claude process is recycled when the endpoint changes. */
export function chatParticipantEndpointEnvKey(endpoint: ChatParticipantEndpoint | undefined, model: string | undefined): string {
  return endpoint ? `${endpoint.preset}|${endpoint.baseUrl}|${endpoint.authTokenEnvKey}|${model?.trim() || ""}` : "";
}
