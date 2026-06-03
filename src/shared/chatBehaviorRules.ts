export const CHAT_BEHAVIOR_RULE_LABEL_MAX_CHARS = 80;
export const CHAT_BEHAVIOR_RULE_INSTRUCTIONS_MAX_CHARS = 1000;

export function limitChatBehaviorRulePromptText(value: string, maxChars = CHAT_BEHAVIOR_RULE_INSTRUCTIONS_MAX_CHARS): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  if (maxChars <= 3) {
    return normalized.slice(0, maxChars);
  }
  return `${normalized.slice(0, maxChars - 3).trimEnd()}...`;
}
