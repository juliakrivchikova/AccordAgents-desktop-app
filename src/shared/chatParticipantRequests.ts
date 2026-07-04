export const CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT = 2;
export const CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_MIN = 1;
export const CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_MAX = 5;
export const CHAT_PARTICIPANT_REQUEST_MAX_CHAIN_BATCHES = 24;
export const CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_DEFAULT = 50_000;
export const CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_MIN = 1_000;
export const CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_MAX = 200_000;

export function normalizeChatParticipantRequestMaxDepth(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT;
  }
  return Math.min(
    CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_MAX,
    Math.max(CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_MIN, Math.floor(numeric))
  );
}

export function normalizeChatParticipantRequestPromptMaxChars(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_DEFAULT;
  }
  return Math.min(
    CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_MAX,
    Math.max(CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_MIN, Math.floor(numeric))
  );
}
