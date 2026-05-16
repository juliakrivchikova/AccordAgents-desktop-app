import type { ChatAppToolCapability } from "./types";

export const CHAT_APP_TOOL_CAPABILITIES: ChatAppToolCapability[] = ["participants.manage", "permissions.request"];

export function normalizeChatAppToolCapabilities(value: unknown): ChatAppToolCapability[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const capabilities = new Set<ChatAppToolCapability>();
  for (const item of value) {
    if (item === "participants.manage" || item === "permissions.request") {
      capabilities.add(item);
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
