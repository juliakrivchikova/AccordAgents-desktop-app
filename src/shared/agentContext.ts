import type { AgentContextUsage, AgentContextUsageSource, ProviderKind } from "./types";

const OPENAI_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "gpt-5.2": 400_000,
  "gpt-5.2-2025-12-11": 400_000,
  "gpt-5.2-codex": 400_000,
  "gpt-5.2-pro": 400_000,
  "gpt-5.2-chat-latest": 128_000,
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
  "claude-sonnet-4-6": 1_000_000,
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
    return contextWindowFromMap(OPENAI_MODEL_CONTEXT_WINDOWS, normalized);
  }
  if (kind === "claude-code" || kind === "anthropic") {
    return contextWindowFromMap(CLAUDE_MODEL_CONTEXT_WINDOWS, normalized);
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
