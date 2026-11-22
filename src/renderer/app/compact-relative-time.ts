/** How long ago, in the fewest characters: "now", "5m", "3h", "2d", "4w",
 *  "6mo", "1y". Used where a list row has room for little (the sidebar, the
 *  recent chats on New chat). */
export function formatCompactRelativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "";
  }
  const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSeconds < 60) {
    return "now";
  }
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}m`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h`;
  }
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 14) {
    return `${diffDays}d`;
  }
  const diffWeeks = Math.floor(diffDays / 7);
  if (diffWeeks < 8) {
    return `${diffWeeks}w`;
  }
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) {
    return `${Math.max(1, diffMonths)}mo`;
  }
  return `${Math.max(1, Math.floor(diffDays / 365))}y`;
}
