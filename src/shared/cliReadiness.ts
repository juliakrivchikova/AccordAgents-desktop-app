import type {
  AgentHealth,
  AgentReadinessState,
  ChatProviderKind,
  ProviderSettings
} from "./types";
import { CHAT_PROVIDER_PREFERENCE } from "./chatProviders";

export const CLI_READINESS_STALE_MS = 30_000;

export interface CliProviderSetupMetadata {
  kind: ChatProviderKind;
  label: string;
  executable: string;
  versionArgs: string[];
  loginCommand: string;
  guideUrl: string;
  installCommandByPlatform: Partial<Record<"darwin", string>>;
  probeStrategy: "codex-login-status" | "claude-auth-status" | "antigravity-models";
}

export const CLI_PROVIDER_DISPLAY_ORDER: ChatProviderKind[] = [
  "gemini-cli",
  "claude-code",
  "codex-cli"
];

export const CLI_PROVIDER_SETUP: Record<ChatProviderKind, CliProviderSetupMetadata> = {
  "gemini-cli": {
    kind: "gemini-cli",
    label: "Antigravity",
    executable: "agy",
    versionArgs: ["--version"],
    loginCommand: "agy",
    guideUrl: "https://antigravity.google/docs/cli-install",
    installCommandByPlatform: {
      darwin: "curl -fsSL https://antigravity.google/cli/install.sh | bash"
    },
    probeStrategy: "antigravity-models"
  },
  "claude-code": {
    kind: "claude-code",
    label: "Claude Code",
    executable: "claude",
    versionArgs: ["--version"],
    loginCommand: "claude auth login",
    guideUrl: "https://docs.anthropic.com/en/docs/claude-code/getting-started",
    installCommandByPlatform: {
      darwin: "npm install -g @anthropic-ai/claude-code"
    },
    probeStrategy: "claude-auth-status"
  },
  "codex-cli": {
    kind: "codex-cli",
    label: "Codex",
    executable: "codex",
    versionArgs: ["--version"],
    loginCommand: "codex login",
    guideUrl: "https://github.com/openai/codex/blob/main/README.md",
    installCommandByPlatform: {
      darwin: "curl -fsSL https://chatgpt.com/codex/install.sh | sh"
    },
    probeStrategy: "codex-login-status"
  }
};

export function cliProviderMetadata(kind: ChatProviderKind): CliProviderSetupMetadata {
  return CLI_PROVIDER_SETUP[kind];
}

export function providerEnabled(
  providers: Array<Pick<ProviderSettings, "kind" | "enabled">>,
  kind: ChatProviderKind
): boolean {
  return providers.find((provider) => provider.kind === kind)?.enabled !== false;
}

export function deriveAgentReadiness(health: AgentHealth | undefined, enabled = true): AgentReadinessState {
  if (!enabled) {
    return "disabled";
  }
  if (!health) {
    return "checking";
  }

  const hasNormalizedFacts = Boolean(health.detection || health.runnable || health.authentication);
  if (health.checking && !health.detection && !health.runnable && !health.authentication) {
    return "checking";
  }
  if (!hasNormalizedFacts) {
    return health.installed ? "ready" : "not-detected";
  }
  if (health.detection === "unknown") {
    return "could-not-verify";
  }
  if (health.detection === "not-detected") {
    return "not-detected";
  }
  if (health.runnable === "failed") {
    return "failed-to-run";
  }
  if (health.runnable !== "ready") {
    return "could-not-verify";
  }
  if (health.authentication === "required") {
    return "sign-in-required";
  }
  if (health.authentication === "ready") {
    return "ready";
  }
  return "could-not-verify";
}

export function readinessForProvider(
  kind: ChatProviderKind,
  agents: AgentHealth[],
  providers: Array<Pick<ProviderSettings, "kind" | "enabled">>
): AgentReadinessState {
  return deriveAgentReadiness(
    agents.find((agent) => agent.kind === kind),
    providerEnabled(providers, kind)
  );
}

export function readyProviderKinds(
  agents: AgentHealth[],
  providers: Array<Pick<ProviderSettings, "kind" | "enabled">>
): ChatProviderKind[] {
  return CLI_PROVIDER_DISPLAY_ORDER.filter((kind) => readinessForProvider(kind, agents, providers) === "ready");
}

export function preferredReadyAssistantProviderKind(
  agents: AgentHealth[],
  providers: Array<Pick<ProviderSettings, "kind" | "enabled">>
): ChatProviderKind | undefined {
  return CHAT_PROVIDER_PREFERENCE.find((kind) => readinessForProvider(kind, agents, providers) === "ready");
}

export function resolveAssistantProviderKind(options: {
  agents: AgentHealth[];
  providers: Array<Pick<ProviderSettings, "kind" | "enabled">>;
  explicitKind?: ChatProviderKind;
}): ChatProviderKind | undefined {
  if (options.explicitKind) {
    return readinessForProvider(options.explicitKind, options.agents, options.providers) === "ready"
      ? options.explicitKind
      : undefined;
  }
  return preferredReadyAssistantProviderKind(options.agents, options.providers);
}

export function isAgentSnapshotStale(agents: AgentHealth[], now = Date.now()): boolean {
  if (agents.length === 0) {
    return true;
  }
  return agents.some((agent) => {
    const checkedAt = agent.lastCheckedAt ? Date.parse(agent.lastCheckedAt) : NaN;
    return !Number.isFinite(checkedAt) || now - checkedAt >= CLI_READINESS_STALE_MS;
  });
}

export function agentReadinessReason(state: AgentReadinessState, label: string): string | undefined {
  switch (state) {
    case "disabled":
      return `${label} is disabled. Enable it in Settings.`;
    case "not-detected":
      return `${label} was not detected. Set it up to continue.`;
    case "failed-to-run":
      return `${label} was detected but failed to run.`;
    case "sign-in-required":
      return `${label} requires sign-in.`;
    case "could-not-verify":
      return `${label} readiness could not be verified.`;
    case "checking":
      return `${label} readiness is being checked.`;
    case "ready":
    default:
      return undefined;
  }
}
