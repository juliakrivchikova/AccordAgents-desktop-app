import type { AgentContextUsage, AgentContextUsageSource, ProviderKind } from "./types";

const OPENAI_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "gpt-5.2": 400_000,
  "gpt-5.2-2025-12-11": 400_000,
  "gpt-5.2-codex": 400_000,
  "gpt-5.2-pro": 400_000,
  "gpt-5.2-chat-latest": 128_000,
  "gpt-5.5": 400_000,
  "gpt-5.5-codex": 400_000,
  "gpt-5.1": 400_000,
  "gpt-5.1-codex": 400_000,
  "gpt-5.1-codex-max": 400_000,
  "gpt-5.1-codex-mini": 400_000,
  "gpt-5.1-chat-latest": 128_000,
  "gpt-5": 400_000,
  "gpt-5-codex": 400_000,
  "gpt-5-mini": 400_000,
  "gpt-5-nano": 400_000,
  "gpt-5-chat-latest": 128_000,
  "gpt-4.1": 1_047_576,
  "gpt-4.1-mini": 1_047_576,
  "gpt-4.1-nano": 1_047_576
};

const CLAUDE_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "sonnet": 1_000_000,
  "opus": 1_000_000,
  "claude-fable-5": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-4-5": 200_000,
  "claude-haiku-4-5": 200_000,
  "claude-opus-4-1": 200_000,
  "claude-sonnet-4": 200_000,
  "claude-sonnet-4-20250514": 200_000,
  "claude-3-7-sonnet": 200_000,
  "claude-3-7-sonnet-latest": 200_000,
  "claude-3-5-sonnet": 200_000,
  "claude-3-5-sonnet-latest": 200_000,
  "claude-3-5-haiku": 200_000,
  "claude-3-opus": 200_000,
  "claude-3-sonnet": 200_000,
  "claude-3-haiku": 200_000
};

export function contextWindowForModel(kind: ProviderKind, model: string | undefined): number | undefined {
  const normalized = normalizeModelId(model);
  if (!normalized) {
    return undefined;
  }
  if (kind === "codex-cli" || kind === "openai") {
    return contextWindowFromMap(OPENAI_MODEL_CONTEXT_WINDOWS, normalized) ?? openAiFamilyContextWindow(normalized);
  }
  if (kind === "claude-code" || kind === "anthropic") {
    return contextWindowFromMap(CLAUDE_MODEL_CONTEXT_WINDOWS, normalized) ?? claudeFamilyContextWindow(normalized);
  }
  return undefined;
}

// Fallbacks so a newly released model id (e.g. claude-opus-4-8, gpt-5.5) still
// resolves a context window before its explicit entry is added above. The Claude
// session log carries no context-window field, so an unresolved window means the
// context indicator silently disappears — these keep it working across model bumps.
function claudeFamilyContextWindow(normalizedModel: string): number | undefined {
  const frontier = normalizedModel.match(/^claude-(?:opus|sonnet)-(\d+)-(\d+)/);
  if (frontier) {
    const major = Number(frontier[1]);
    const minor = Number(frontier[2]);
    if (major > 4 || (major === 4 && minor >= 6)) {
      return 1_000_000;
    }
    return 200_000;
  }
  if (normalizedModel.startsWith("claude-fable")) {
    return 1_000_000;
  }
  if (normalizedModel.startsWith("claude-haiku-4")) {
    return 200_000;
  }
  return undefined;
}

function openAiFamilyContextWindow(normalizedModel: string): number | undefined {
  if (/^gpt-5(\.\d+)?(-codex(-max|-mini)?|-pro)?$/.test(normalizedModel)) {
    return 400_000;
  }
  return undefined;
}

export function buildAgentContextUsage(input: {
  usedTokens: number | undefined;
  contextWindowTokens: number | undefined;
  source: AgentContextUsageSource;
  updatedAt?: string;
  model?: string;
}): AgentContextUsage | undefined {
  const usedTokens = positiveInteger(input.usedTokens);
  const contextWindowTokens = positiveInteger(input.contextWindowTokens);
  if (!usedTokens || !contextWindowTokens) {
    return undefined;
  }
  const percentage = Math.max(0, Math.min(100, Math.round((usedTokens / contextWindowTokens) * 100)));
  return {
    usedTokens,
    contextWindowTokens,
    percentage,
    source: input.source,
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    model: input.model?.trim() || undefined
  };
}

export function formatContextUsageLabel(usage: AgentContextUsage): string {
  const remainingTokens = Math.max(0, usage.contextWindowTokens - usage.usedTokens);
  const remainingPercentage = Math.max(0, Math.min(100, Math.round((remainingTokens / usage.contextWindowTokens) * 100)));
  return `${remainingPercentage}% left (${formatContextTokenCount(usage.usedTokens)} used / ${formatContextTokenCount(usage.contextWindowTokens)} tokens)`;
}

function formatContextTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    const value = tokens / 1_000_000;
    return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}k`;
  }
  return `${tokens}`;
}

export function normalizeAgentContextUsage(value: unknown): AgentContextUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Partial<AgentContextUsage>;
  const source = record.source === "codex-cli" || record.source === "claude-code" ? record.source : undefined;
  if (!source || typeof record.updatedAt !== "string") {
    return undefined;
  }
  return buildAgentContextUsage({
    usedTokens: record.usedTokens,
    contextWindowTokens: record.contextWindowTokens,
    source,
    updatedAt: record.updatedAt,
    model: typeof record.model === "string" ? record.model : undefined
  });
}

function contextWindowFromMap(map: Record<string, number>, normalizedModel: string): number | undefined {
  const exact = map[normalizedModel];
  if (exact) {
    return exact;
  }
  const snapshot = normalizedModel.replace(/-\d{4}-\d{2}-\d{2}$/, "").replace(/-\d{8}$/, "");
  return map[snapshot];
}

function normalizeModelId(model: string | undefined): string {
  return model?.trim().toLowerCase() ?? "";
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}
