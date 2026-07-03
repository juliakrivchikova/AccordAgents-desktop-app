import type { ChatPromptContextScopeSettings, ChatPromptContextSettings } from "./types";

export const CHAT_PROMPT_CONTEXT_LIMIT_MIN = 0;
export const CHAT_PROMPT_CONTEXT_LIMIT_MAX = 25;
export const CHAT_PROMPT_CONTEXT_TIMELINE_DEFAULT_LIMIT = 3;

export const DEFAULT_CHAT_PROMPT_CONTEXT: ChatPromptContextSettings = {
  thread: { mode: "all_unseen" },
  timeline: { mode: "latest_unseen", limit: CHAT_PROMPT_CONTEXT_TIMELINE_DEFAULT_LIMIT }
};

export function normalizeChatPromptContextSettings(value: unknown): ChatPromptContextSettings {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as { thread?: unknown; timeline?: unknown }
    : {};
  return {
    thread: normalizeChatPromptContextScope(record.thread, DEFAULT_CHAT_PROMPT_CONTEXT.thread),
    timeline: normalizeChatPromptContextScope(record.timeline, DEFAULT_CHAT_PROMPT_CONTEXT.timeline)
  };
}

export function normalizeChatPromptContextScope(
  value: unknown,
  fallback: ChatPromptContextScopeSettings
): ChatPromptContextScopeSettings {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as { mode?: unknown; limit?: unknown }
    : {};
  const rawMode = typeof record.mode === "string" ? record.mode : fallback.mode;
  const mode = rawMode === "off" || rawMode === "all_unseen" || rawMode === "latest_unseen"
    ? rawMode
    : fallback.mode;
  if (mode === "off") {
    return { mode: "off" };
  }
  if (mode === "all_unseen") {
    return { mode: "all_unseen" };
  }
  const fallbackLimit = normalizePromptContextLimit(fallback.limit, CHAT_PROMPT_CONTEXT_TIMELINE_DEFAULT_LIMIT);
  const limit = normalizePromptContextLimit(record.limit, fallbackLimit);
  return limit <= 0 ? { mode: "off" } : { mode: "latest_unseen", limit };
}

export function normalizePromptContextLimit(value: unknown, fallback: number): number {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : fallback;
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(CHAT_PROMPT_CONTEXT_LIMIT_MAX, Math.max(CHAT_PROMPT_CONTEXT_LIMIT_MIN, Math.floor(numeric)));
}
