const CHAT_TITLE_MAX_LENGTH = 80;
const HANDLE_PREFIX_PATTERN = /^@[A-Za-z0-9_-]{1,64}(?=\s|$)\s*/;
const SLASH_PREFIX_PATTERN = /^\/[A-Za-z0-9_-]{1,80}(?=\s|$)\s*/;
const TRAILING_PUNCTUATION_PATTERN = /[\s:;,.!?/\\-]+$/;
const WRAPPING_QUOTES_PATTERN = /^["'`]+|["'`]+$/g;
const MODEL_OR_PROVIDER_TITLE_PATTERN = /^(?:chatgpt|codex|claude|gemini|grok|openai|anthropic|gpt[- ]?\d(?:\.\d)?(?:[- ]?[a-z0-9]+)?)$/i;

const GENERIC_TITLES = new Set([
  "chat",
  "new chat",
  "conversation",
  "new conversation",
  "untitled",
  "question",
  "request"
]);

export function normalizeManualChatTitle(value: string, fallback = "Chat"): string {
  const normalized = collapseTitleWhitespace(value);
  return truncateChatTitle(normalized || fallback);
}

export function normalizeAutoChatTitle(value: string, fallback = "Chat"): string {
  return sanitizeAutoChatTitleSuggestion(value) ?? fallback;
}

export function sanitizeAutoChatTitleSuggestion(value: string): string | undefined {
  let normalized = collapseTitleWhitespace(value).replace(WRAPPING_QUOTES_PATTERN, "").trim();
  let previous = "";
  while (normalized && normalized !== previous) {
    previous = normalized;
    normalized = normalized
      .replace(HANDLE_PREFIX_PATTERN, "")
      .replace(SLASH_PREFIX_PATTERN, "")
      .trim();
  }
  normalized = normalized
    .replace(WRAPPING_QUOTES_PATTERN, "")
    .replace(TRAILING_PUNCTUATION_PATTERN, "")
    .trim();
  normalized = truncateChatTitle(normalized).replace(TRAILING_PUNCTUATION_PATTERN, "").trim();
  if (!isUsefulAutoChatTitle(normalized)) {
    return undefined;
  }
  return normalized;
}

function collapseTitleWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateChatTitle(value: string): string {
  return value.slice(0, CHAT_TITLE_MAX_LENGTH).trim();
}

function isUsefulAutoChatTitle(value: string): boolean {
  if (!/[A-Za-z0-9]/.test(value)) {
    return false;
  }
  const lower = value.toLowerCase();
  if (GENERIC_TITLES.has(lower)) {
    return false;
  }
  if (MODEL_OR_PROVIDER_TITLE_PATTERN.test(value)) {
    return false;
  }
  return true;
}
