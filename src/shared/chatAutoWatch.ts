export const CHAT_AUTO_WATCH_WAKE_LIMIT_DEFAULT = 50;
export const CHAT_AUTO_WATCH_WAKE_LIMIT_MIN = 1;
export const CHAT_AUTO_WATCH_WAKE_LIMIT_MAX = 500;

export function normalizeChatAutoWatchWakeLimit(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return CHAT_AUTO_WATCH_WAKE_LIMIT_DEFAULT;
  }
  return Math.min(
    CHAT_AUTO_WATCH_WAKE_LIMIT_MAX,
    Math.max(CHAT_AUTO_WATCH_WAKE_LIMIT_MIN, Math.floor(numeric))
  );
}
