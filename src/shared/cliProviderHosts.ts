import type {
  ChatProviderKind,
  CliProviderHost,
  CliProviderHostCli,
  CliProviderHostUpdate,
  CliProviderHostVendor,
  ProviderModel,
  ProviderModelCatalog
} from "./types";

// An added provider is one of the local CLIs pointed at a vendor's compatible
// endpoint with the user's own API key — exactly what each vendor documents for
// the dedicated CLI. The presets below carry what those guides say (URL, models,
// which credential variable the vendor expects); every value that could be
// exercised was verified with a live request before it was added here.

export const CLI_PROVIDER_HOST_LABEL_MAX_CHARS = 60;
export const CLI_PROVIDER_HOST_CLIS: CliProviderHostCli[] = ["claude-code", "codex-cli"];

/** Env var the app sets for a Codex custom provider's key; Codex reads it
 *  through `model_providers.<id>.env_key`. Not a Settings → Environment name. */
export const CODEX_HOST_API_KEY_ENV = "CODEX_PROVIDER_HOST_API_KEY";
const CODEX_HOST_PROVIDER_ID = "accordagents_host";

type ClaudeCredential = "auth-token" | "api-key";

interface CliProviderHostVendorPreset {
  vendor: CliProviderHostVendor;
  label: string;
  clis: CliProviderHostCli[];
  baseUrl: Partial<Record<CliProviderHostCli, string>>;
  /** Fixed model list; undefined = the CLI's own catalog applies (first-party
   *  vendors); empty = the vendor is unknown, the user types a model id. */
  models?: ProviderModel[];
  defaultModel?: string;
  /** Model Claude Code's internal small calls (titles, summaries) go to. */
  claudeSmallModel?: string;
  /** Which credential variable the vendor's Claude Code guide uses. */
  claudeCredential: ClaudeCredential;
  claudeExtraEnv?: Record<string, string>;
  handleSlug: string;
}

const ZAI_CLAUDE_EXTRA_ENV = {
  // Z.ai's guide: longer request timeout, a 1M auto-compact window for GLM, and
  // no non-essential Anthropic traffic (updates, telemetry, /bug).
  API_TIMEOUT_MS: "3000000",
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
};

const VENDOR_PRESETS: Record<CliProviderHostVendor, CliProviderHostVendorPreset> = {
  anthropic: {
    vendor: "anthropic",
    label: "Anthropic API",
    clis: ["claude-code"],
    baseUrl: { "claude-code": "https://api.anthropic.com" },
    claudeCredential: "api-key",
    handleSlug: "claude"
  },
  zai: {
    vendor: "zai",
    label: "Z.ai GLM",
    clis: ["claude-code", "codex-cli"],
    baseUrl: { "claude-code": "https://api.z.ai/api/anthropic", "codex-cli": "https://api.z.ai/api/v1" },
    models: [
      { id: "glm-5.3", label: "GLM-5.3", description: "Flagship", source: "builtin", recommended: true },
      { id: "glm-5.3-flash", label: "GLM-5.3 Flash", description: "Fast", source: "builtin" },
      { id: "glm-5.2", label: "GLM-5.2", description: "Previous flagship", source: "builtin" }
    ],
    defaultModel: "glm-5.3",
    claudeSmallModel: "glm-5.3-flash",
    claudeCredential: "auth-token",
    claudeExtraEnv: ZAI_CLAUDE_EXTRA_ENV,
    handleSlug: "glm"
  },
  moonshot: {
    vendor: "moonshot",
    label: "Moonshot Kimi",
    clis: ["claude-code"],
    baseUrl: { "claude-code": "https://api.moonshot.ai/anthropic" },
    models: [
      { id: "kimi-k3", label: "Kimi K3", description: "Flagship", source: "builtin", recommended: true },
      { id: "kimi-k3[1m]", label: "Kimi K3 (1M)", description: "Flagship · thinking", source: "builtin" },
      { id: "kimi-k2.7-code", label: "Kimi K2.7 Code", description: "Fast coding tier", source: "builtin" },
      { id: "kimi-k2.6", label: "Kimi K2.6", description: "Latency-sensitive tasks", source: "builtin" }
    ],
    defaultModel: "kimi-k3",
    claudeSmallModel: "kimi-k2.7-code",
    claudeCredential: "auth-token",
    handleSlug: "kimi"
  },
  minimax: {
    vendor: "minimax",
    label: "MiniMax",
    clis: ["claude-code"],
    baseUrl: { "claude-code": "https://api.minimax.io/anthropic" },
    models: [
      { id: "MiniMax-M3[1m]", label: "MiniMax-M3 (1M)", description: "Flagship", source: "builtin", recommended: true },
      { id: "MiniMax-M3", label: "MiniMax-M3", description: "Flagship", source: "builtin" },
      { id: "MiniMax-M2.7", label: "MiniMax-M2.7", description: "Previous generation", source: "builtin" }
    ],
    defaultModel: "MiniMax-M3[1m]",
    claudeSmallModel: "MiniMax-M3[1m]",
    claudeCredential: "auth-token",
    claudeExtraEnv: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000" },
    handleSlug: "minimax"
  },
  deepseek: {
    vendor: "deepseek",
    label: "DeepSeek",
    clis: ["claude-code"],
    baseUrl: { "claude-code": "https://api.deepseek.com/anthropic" },
    models: [
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", description: "Flagship", source: "builtin", recommended: true },
      { id: "deepseek-flash", label: "DeepSeek Flash", description: "Fast", source: "builtin" }
    ],
    defaultModel: "deepseek-v4-pro",
    claudeSmallModel: "deepseek-flash",
    // DeepSeek's guide authenticates its Anthropic endpoint with ANTHROPIC_API_KEY.
    claudeCredential: "api-key",
    handleSlug: "deepseek"
  },
  openai: {
    vendor: "openai",
    label: "OpenAI API",
    clis: ["codex-cli"],
    baseUrl: { "codex-cli": "https://api.openai.com/v1" },
    claudeCredential: "auth-token",
    handleSlug: "codex"
  },
  custom: {
    vendor: "custom",
    label: "Custom endpoint",
    clis: ["claude-code", "codex-cli"],
    baseUrl: {},
    models: [],
    claudeCredential: "auth-token",
    handleSlug: "api"
  }
};

export const CLI_PROVIDER_HOST_VENDORS: CliProviderHostVendor[] = ["anthropic", "zai", "moonshot", "minimax", "deepseek", "openai", "custom"];

export function isCliProviderHostCli(value: unknown): value is CliProviderHostCli {
  return value === "claude-code" || value === "codex-cli";
}

export function isCliProviderHostVendor(value: unknown): value is CliProviderHostVendor {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(VENDOR_PRESETS, value);
}

export function cliProviderHostVendorLabel(vendor: CliProviderHostVendor): string {
  return VENDOR_PRESETS[vendor].label;
}

/** Vendors that can be reached through the given CLI, in picker order. */
export function cliProviderHostVendorsFor(cli: CliProviderHostCli): CliProviderHostVendor[] {
  return CLI_PROVIDER_HOST_VENDORS.filter((vendor) => VENDOR_PRESETS[vendor].clis.includes(cli));
}

export function cliProviderHostDefaultBaseUrl(vendor: CliProviderHostVendor, cli: CliProviderHostCli): string {
  return VENDOR_PRESETS[vendor].baseUrl[cli] ?? "";
}

export function cliProviderHostDefaultLabel(vendor: CliProviderHostVendor, cli: CliProviderHostCli): string {
  const preset = VENDOR_PRESETS[vendor];
  return preset.clis.length > 1 ? `${preset.label} · ${cli === "claude-code" ? "Claude Code" : "Codex"}` : preset.label;
}

/** Fixed model list for the vendor; undefined means "ask the CLI" (first-party
 *  vendors serve the CLI's own catalog). */
export function cliProviderHostModels(host: Pick<CliProviderHost, "vendor">): ProviderModel[] | undefined {
  return VENDOR_PRESETS[host.vendor].models;
}

export function cliProviderHostModelCatalog(host: Pick<CliProviderHost, "vendor" | "cli">): ProviderModelCatalog | undefined {
  const models = cliProviderHostModels(host);
  return models
    ? { kind: host.cli, models, authoritative: true, fetchedAt: new Date(0).toISOString() }
    : undefined;
}

export function cliProviderHostDefaultModel(host: Pick<CliProviderHost, "vendor"> | undefined): string | undefined {
  return host ? VENDOR_PRESETS[host.vendor].defaultModel : undefined;
}

export function cliProviderHostDefaultModelLabel(host: Pick<CliProviderHost, "vendor"> | undefined): string | undefined {
  const id = cliProviderHostDefaultModel(host);
  return id ? cliProviderHostModels(host!)?.find((model) => model.id === id)?.label ?? id : undefined;
}

/** Middle segment of a generated handle ("casey-glm-engineer"). */
export function cliProviderHostHandleSlug(host: Pick<CliProviderHost, "vendor" | "cli"> | undefined): string | undefined {
  if (!host) {
    return undefined;
  }
  const preset = VENDOR_PRESETS[host.vendor];
  return preset.vendor === "custom" ? (host.cli === "claude-code" ? "claude" : "codex") : preset.handleSlug;
}

export function isCliProviderHostHandleSlug(slug: string): boolean {
  return CLI_PROVIDER_HOST_VENDORS.some((vendor) => VENDOR_PRESETS[vendor].handleSlug === slug);
}

export function normalizeCliProviderHostBaseUrl(value: unknown): string | undefined {
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

export function normalizeCliProviderHostLabel(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, CLI_PROVIDER_HOST_LABEL_MAX_CHARS) : "";
}

/** Validates what the user typed (or sent over IPC) before it is stored. */
export function cliProviderHostValidationError(update: Partial<CliProviderHostUpdate>): string | undefined {
  if (!isCliProviderHostCli(update.cli)) {
    return "Choose which CLI the provider runs through.";
  }
  if (!isCliProviderHostVendor(update.vendor)) {
    return "Choose a provider vendor.";
  }
  if (!VENDOR_PRESETS[update.vendor].clis.includes(update.cli)) {
    return `${VENDOR_PRESETS[update.vendor].label} is not available through ${update.cli === "claude-code" ? "Claude Code" : "Codex"}.`;
  }
  if (!normalizeCliProviderHostLabel(update.label)) {
    return "Give the provider a name.";
  }
  if (!normalizeCliProviderHostBaseUrl(update.baseUrl)) {
    return "Endpoint URL must be an http(s) URL.";
  }
  return undefined;
}

/** Accepts stored/wire records; returns undefined for anything unusable so a
 *  damaged record disappears from the list instead of half-applying. */
export function normalizeCliProviderHostRecord(value: unknown): Omit<CliProviderHost, "hasApiKey"> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const cli = record.cli;
  const vendor = record.vendor;
  if (!id || !isCliProviderHostCli(cli) || !isCliProviderHostVendor(vendor) || !VENDOR_PRESETS[vendor].clis.includes(cli)) {
    return undefined;
  }
  const baseUrl = normalizeCliProviderHostBaseUrl(record.baseUrl) ?? cliProviderHostDefaultBaseUrl(vendor, cli);
  if (!baseUrl) {
    return undefined;
  }
  return {
    id,
    label: normalizeCliProviderHostLabel(record.label) || cliProviderHostDefaultLabel(vendor, cli),
    cli,
    vendor,
    baseUrl,
    updatedAt: typeof record.updatedAt === "string" && record.updatedAt ? record.updatedAt : new Date(0).toISOString()
  };
}

/** Members can only be bound to a host that runs through their own CLI. */
export function cliProviderHostForParticipant(
  kind: ChatProviderKind,
  hostId: string | undefined,
  hosts: ReadonlyArray<CliProviderHost>
): CliProviderHost | undefined {
  if (!hostId) {
    return undefined;
  }
  const host = hosts.find((item) => item.id === hostId);
  return host && host.cli === kind ? host : undefined;
}

export interface CliProviderHostRunConfig {
  env: Record<string, string>;
  codexConfigOverrides?: string[];
}

// Claude Code reads its own credentials from these as well; a member on an added
// provider must never send them to that provider. Verified with a request capture
// on Claude Code 2.1.257: an inherited ANTHROPIC_API_KEY is sent as `x-api-key`
// next to the endpoint's Bearer token; an empty value removes the header. The
// CLAUDE_CODE_USE_* switches would route the member to Bedrock/Vertex/Foundry
// and ignore the base URL entirely.
const CLAUDE_CREDENTIAL_ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] as const;
const CLAUDE_CLOUD_SWITCH_ENV_KEYS = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"] as const;

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** Environment (and, for Codex, config overrides) that make the member's CLI
 *  talk to the host with the given key. `model` is the member's chosen model;
 *  the vendor default fills in when it is unset. */
export function cliProviderHostRunConfig(
  host: Pick<CliProviderHost, "id" | "label" | "cli" | "vendor" | "baseUrl">,
  apiKey: string,
  model: string | undefined
): CliProviderHostRunConfig {
  const preset = VENDOR_PRESETS[host.vendor];
  if (host.cli === "codex-cli") {
    if (host.vendor === "openai") {
      const env: Record<string, string> = {
        OPENAI_API_KEY: apiKey
      };
      if (host.baseUrl !== cliProviderHostDefaultBaseUrl("openai", "codex-cli")) {
        env.OPENAI_BASE_URL = host.baseUrl;
      }
      // Codex prefers the ChatGPT sign-in when both are present; the member was
      // explicitly bound to the API key, so ask for it.
      return { env, codexConfigOverrides: [`preferred_auth_method=${tomlString("apikey")}`] };
    }
    return {
      env: { [CODEX_HOST_API_KEY_ENV]: apiKey },
      codexConfigOverrides: [
        `model_provider=${tomlString(CODEX_HOST_PROVIDER_ID)}`,
        `model_providers.${CODEX_HOST_PROVIDER_ID}.name=${tomlString(host.label)}`,
        `model_providers.${CODEX_HOST_PROVIDER_ID}.base_url=${tomlString(host.baseUrl)}`,
        `model_providers.${CODEX_HOST_PROVIDER_ID}.wire_api=${tomlString("responses")}`,
        `model_providers.${CODEX_HOST_PROVIDER_ID}.env_key=${tomlString(CODEX_HOST_API_KEY_ENV)}`
      ]
    };
  }
  const env: Record<string, string> = {};
  for (const key of [...CLAUDE_CREDENTIAL_ENV_KEYS, ...CLAUDE_CLOUD_SWITCH_ENV_KEYS]) {
    env[key] = "";
  }
  env.ANTHROPIC_BASE_URL = host.baseUrl;
  env[preset.claudeCredential === "api-key" ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN"] = apiKey;
  if (host.vendor !== "anthropic") {
    // Claude Code resolves its "opus"/"sonnet"/"haiku"/"fable" aliases (and its
    // own small-model calls) through these, so nothing falls back to an
    // Anthropic id the vendor does not serve.
    const mainModel = model?.trim() || preset.defaultModel;
    if (mainModel) {
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = mainModel;
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = mainModel;
      env.ANTHROPIC_DEFAULT_FABLE_MODEL = mainModel;
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = preset.claudeSmallModel ?? mainModel;
    }
    Object.assign(env, preset.claudeExtraEnv ?? {});
  }
  return { env };
}

/** Appended to the Settings → Environment version so a warm process is recycled
 *  when the host or the member's model changes. */
export function cliProviderHostRunVersion(host: Pick<CliProviderHost, "id" | "updatedAt"> | undefined, model: string | undefined): string {
  return host ? `host:${host.id}|${host.updatedAt}|${model?.trim() || ""}` : "";
}
