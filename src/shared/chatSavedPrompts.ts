import type { ChatSavedPromptConfig } from "./types";

export const CHAT_SAVED_PROMPT_LABEL_MAX_CHARS = 80;
export const CHAT_SAVED_PROMPT_TRIGGER_MAX_CHARS = 48;
export const CHAT_SAVED_PROMPT_BODY_MAX_CHARS = 10_000;

export const CHAT_SAVED_PROMPT_TRIGGER_PATTERN = /^[A-Za-z0-9_-]+$/;

export function normalizeChatSavedPromptTrigger(value: string): string {
  return value.trim().replace(/^\/+/, "");
}

export function isValidChatSavedPromptTrigger(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= CHAT_SAVED_PROMPT_TRIGGER_MAX_CHARS &&
    CHAT_SAVED_PROMPT_TRIGGER_PATTERN.test(value)
  );
}

export function limitChatSavedPromptBody(value: string, maxChars = CHAT_SAVED_PROMPT_BODY_MAX_CHARS): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  if (maxChars <= 3) {
    return normalized.slice(0, maxChars);
  }
  return `${normalized.slice(0, maxChars - 3).trimEnd()}...`;
}

export function matchingChatSavedPrompts(
  prompts: ChatSavedPromptConfig[],
  query: string,
  options: { includeBody?: boolean } = {}
): ChatSavedPromptConfig[] {
  const normalizedQuery = query.trim().toLowerCase();
  const includeBody = options.includeBody === true;
  const matched = prompts.filter((prompt) => {
    if (!normalizedQuery) {
      return true;
    }
    return (
      prompt.trigger.toLowerCase().includes(normalizedQuery) ||
      prompt.label.toLowerCase().includes(normalizedQuery) ||
      (includeBody && prompt.body.toLowerCase().includes(normalizedQuery))
    );
  });
  const score = (prompt: ChatSavedPromptConfig): number => {
    if (!normalizedQuery) {
      return 0;
    }
    const trigger = prompt.trigger.toLowerCase();
    const label = prompt.label.toLowerCase();
    if (trigger === normalizedQuery) {
      return 0;
    }
    if (trigger.startsWith(normalizedQuery)) {
      return 1;
    }
    if (label.startsWith(normalizedQuery)) {
      return 2;
    }
    if (trigger.includes(normalizedQuery)) {
      return 3;
    }
    if (label.includes(normalizedQuery)) {
      return 4;
    }
    return 5;
  };
  return [...matched].sort((left, right) =>
    score(left) - score(right) ||
    left.trigger.localeCompare(right.trigger) ||
    left.label.localeCompare(right.label)
  );
}
