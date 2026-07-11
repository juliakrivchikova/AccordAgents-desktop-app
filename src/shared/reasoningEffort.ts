import type { ChatProviderKind, ChatReasoningEffort, ProviderReasoningEffortOption } from "./types";

const REASONING_EFFORT_LABELS: Record<ChatReasoningEffort, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max"
};

const CODEX_REASONING_EFFORTS: ChatReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh"];
const CLAUDE_REASONING_EFFORTS: ChatReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];
// Antigravity CLI (`agy`) folds effort into the model label (e.g. "Gemini 3.5 Flash (High)"),
// so gemini-cli exposes no separate reasoning-effort dimension.
const GEMINI_CLI_REASONING_EFFORTS: ChatReasoningEffort[] = [];

export function normalizeChatReasoningEffort(value: unknown, kind?: ChatProviderKind): ChatReasoningEffort | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const key = value.trim().toLowerCase().replace(/[\s_-]+/g, "");
  const aliases: Record<string, ChatReasoningEffort> = {
    none: "none",
    no: "none",
    minimal: "minimal",
    min: "minimal",
    low: "low",
    medium: "medium",
    med: "medium",
    high: "high",
    xhigh: "xhigh",
    extrahigh: "xhigh",
    extra: "xhigh",
    max: "max",
    maximum: "max"
  };
  const effort = aliases[key];
  if (!effort || (kind && !isReasoningEffortForProvider(effort, kind))) {
    return undefined;
  }
  return effort;
}

function reasoningEffortsForProvider(kind: ChatProviderKind): ChatReasoningEffort[] {
  if (kind === "claude-code") {
    return CLAUDE_REASONING_EFFORTS;
  }
  if (kind === "gemini-cli") {
    return GEMINI_CLI_REASONING_EFFORTS;
  }
  return CODEX_REASONING_EFFORTS;
}

export function reasoningEffortOptionsForProvider(kind: ChatProviderKind): ProviderReasoningEffortOption[] {
  return reasoningEffortsForProvider(kind).map((id) => ({
    id,
    label: chatReasoningEffortLabel(id)
  }));
}

export function isReasoningEffortForProvider(effort: ChatReasoningEffort, kind: ChatProviderKind): boolean {
  return reasoningEffortsForProvider(kind).includes(effort);
}

export function chatReasoningEffortLabel(effort: ChatReasoningEffort): string {
  return REASONING_EFFORT_LABELS[effort];
}
