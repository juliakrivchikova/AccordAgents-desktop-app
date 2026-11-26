import type { ChatAppToolCapability } from "./types";

export const CHAT_APP_TOOL_CAPABILITIES: ChatAppToolCapability[] = [
  "participants.manage",
  "participants.request",
  "compaction.request",
  "permissions.request",
  // The main session's own (shared/mainSession.ts): give a member a task
  // without a card, and start an Accord.
  "participants.delegate",
  "accord.start",
  // The main session's own, only while it compacts without asking: compact
  // another member's context (docs/main-session.md).
  "participants.compact"
];

export function normalizeChatAppToolCapabilities(value: unknown): ChatAppToolCapability[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const capabilities = new Set<ChatAppToolCapability>();
  for (const item of value) {
    if (typeof item === "string" && (CHAT_APP_TOOL_CAPABILITIES as string[]).includes(item)) {
      capabilities.add(item as ChatAppToolCapability);
    }
  }
  return Array.from(capabilities);
}

export function hasChatAppToolCapability(value: unknown, capability: ChatAppToolCapability): boolean {
  return normalizeChatAppToolCapabilities(value).includes(capability);
}

export function chatAppToolCapabilitiesEqual(left: unknown, right: unknown): boolean {
  return normalizeChatAppToolCapabilities(left).join("|") === normalizeChatAppToolCapabilities(right).join("|");
}
