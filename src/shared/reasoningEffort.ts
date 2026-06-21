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

export function reasoningEffortOptionsForProvider(kind: ChatProviderKind): ProviderReasoningEffortOption[] {
  const efforts = kind === "claude-code" ? CLAUDE_REASONING_EFFORTS : CODEX_REASONING_EFFORTS;
  return efforts.map((id) => ({
    id,
    label: chatReasoningEffortLabel(id)
  }));
}

export function isReasoningEffortForProvider(effort: ChatReasoningEffort, kind: ChatProviderKind): boolean {
  return (kind === "claude-code" ? CLAUDE_REASONING_EFFORTS : CODEX_REASONING_EFFORTS).includes(effort);
}

export function chatReasoningEffortLabel(effort: ChatReasoningEffort): string {
  return REASONING_EFFORT_LABELS[effort];
}
