export const CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT = 2;
export const CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_MIN = 1;
export const CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_MAX = 5;
export const CHAT_PARTICIPANT_REQUEST_MAX_CHAIN_BATCHES = 24;

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
