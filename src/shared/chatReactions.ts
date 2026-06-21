export const CHAT_REACTION_EMOJIS = ["✅", "👍", "👀", "🎉", "❌"] as const;

export type ChatReactionEmoji = typeof CHAT_REACTION_EMOJIS[number];

export function normalizeChatReactionEmoji(value: unknown): ChatReactionEmoji {
  if (typeof value !== "string") {
    throw new Error("Reaction emoji is required.");
  }
  const emoji = value.trim();
  if (!CHAT_REACTION_EMOJIS.includes(emoji as ChatReactionEmoji)) {
    throw new Error(`Reaction emoji must be one of: ${CHAT_REACTION_EMOJIS.join(" ")}`);
  }
  return emoji as ChatReactionEmoji;
}
