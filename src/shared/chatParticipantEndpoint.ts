import type {
  ChatParticipantEndpoint,
  ChatParticipantEndpointPreset,
  ChatProviderKind,
  ProviderModel,
  ProviderModelCatalog
} from "./types";
import { agentEnvironmentKeyValidationError } from "./agentEnvironment";

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
const ZAI_LABEL = "GLM (Z.ai)";
const ZAI_HANDLE_SLUG = "glm";

export const ZAI_MODELS: ProviderModel[] = [
  { id: "glm-5.3", label: "GLM-5.3", description: "Flagship", source: "builtin", recommended: true },
  { id: "glm-5.3-flash", label: "GLM-5.3 Flash", description: "Fast", source: "builtin" },
  { id: "glm-5.2", label: "GLM-5.2", description: "Previous flagship", source: "builtin" }
];

// Claude Code reads its own credentials from these as well; an endpoint member
// must never send them to the endpoint. Verified with a request capture on
// Claude Code 2.1.257: an inherited ANTHROPIC_API_KEY is sent as `x-api-key`
// next to the endpoint's Bearer token; an empty value removes the header. The
// CLAUDE_CODE_USE_* switches would route the member to Bedrock/Vertex/Foundry
// and ignore the base URL entirely.
const ANTHROPIC_CREDENTIAL_ENV_KEYS_TO_CLEAR = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY"
] as const;

export function isChatParticipantEndpointPreset(value: unknown): value is ChatParticipantEndpointPreset {
  return value === ZAI_ENDPOINT_PRESET;
}

export function defaultChatParticipantEndpoint(preset: ChatParticipantEndpointPreset): ChatParticipantEndpoint {
  return { preset, baseUrl: ZAI_DEFAULT_BASE_URL, authTokenEnvKey: ZAI_DEFAULT_AUTH_TOKEN_ENV_KEY };
}

/** Accepts stored/wire values; returns undefined for anything that is not a
 *  usable endpoint so a malformed record degrades to plain Claude Code rather
 *  than to a half-configured one. Damaged fields are repaired to the preset
 *  defaults — this is the load-time repair; user input goes through
 *  `chatParticipantEndpointValidationError` first so a typo is reported, not
 *  silently replaced. */
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

/** Same rules as a Settings → Environment key, so the member can only name a
 *  variable that page is able to hold. */
export function normalizeEndpointEnvKey(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed && !agentEnvironmentKeyValidationError(trimmed) ? trimmed : undefined;
}

/** Validates a raw endpoint value (typed by the user or sent over IPC) before it
 *  is normalized, so an invalid URL or variable name is rejected instead of being
 *  swapped for the preset default. */
export function chatParticipantEndpointValidationError(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return "Member endpoint is not recognized.";
  }
  const record = value as Record<string, unknown>;
  if (!isChatParticipantEndpointPreset(record.preset)) {
    return "Member endpoint is not recognized.";
  }
  if (!normalizeEndpointBaseUrl(record.baseUrl)) {
    return "Endpoint URL must be an http(s) URL.";
  }
  if (!normalizeEndpointEnvKey(record.authTokenEnvKey)) {
    return "API key variable must be an environment variable name (letters, numbers, underscores) that Settings → Environment can hold.";
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
  return endpoint?.preset === ZAI_ENDPOINT_PRESET ? ZAI_LABEL : undefined;
}

/** Middle segment of a generated handle ("casey-glm-engineer"). */
export function chatParticipantEndpointHandleSlug(endpoint: ChatParticipantEndpoint | undefined): string | undefined {
  return endpoint?.preset === ZAI_ENDPOINT_PRESET ? ZAI_HANDLE_SLUG : undefined;
}

export function isChatParticipantEndpointHandleSlug(slug: string): boolean {
  return slug === ZAI_HANDLE_SLUG;
}

/** The endpoint serves a fixed, known model list; the CLI's own catalog would
 *  describe Anthropic models the endpoint does not have. */
export function chatParticipantEndpointModelCatalog(preset: ChatParticipantEndpointPreset): ProviderModelCatalog {
  void preset;
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

/** Display label of the endpoint's default model, as the pickers list it. */
export function chatParticipantEndpointDefaultModelLabel(endpoint: ChatParticipantEndpoint | undefined): string | undefined {
  const id = chatParticipantEndpointDefaultModel(endpoint);
  return id ? ZAI_MODELS.find((model) => model.id === id)?.label ?? id : undefined;
}

export interface ChatParticipantEndpointEnvResult {
  env: Record<string, string>;
  /** Set when the Settings → Environment variable named by the endpoint has no usable value. */
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
  const token = Object.prototype.hasOwnProperty.call(manualEnv, endpoint.authTokenEnvKey)
    ? manualEnv[endpoint.authTokenEnvKey]?.trim()
    : undefined;
  if (!token) {
    return { env: {}, missingEnvKey: endpoint.authTokenEnvKey };
  }
  const mainModel = model?.trim() || ZAI_DEFAULT_MODEL;
  const env: Record<string, string> = {
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
  };
  for (const key of ANTHROPIC_CREDENTIAL_ENV_KEYS_TO_CLEAR) {
    env[key] = "";
  }
  return { env };
}

/** Appended to the Settings → Environment version so a warm Claude process is
 *  recycled when the endpoint or the member's model changes. */
export function chatParticipantEndpointEnvVersion(endpoint: ChatParticipantEndpoint | undefined, model: string | undefined): string {
  return endpoint ? `${endpoint.preset}|${endpoint.baseUrl}|${endpoint.authTokenEnvKey}|${model?.trim() || ""}` : "";
}
