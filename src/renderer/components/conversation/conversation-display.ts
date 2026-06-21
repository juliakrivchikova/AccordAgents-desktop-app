import type { Conversation, ConversationKind } from "../../../shared/types";

export const CHAT_ASSISTANT_DISPLAY_NAME = "Chat Assistant";
export const CHAT_ASSISTANT_HANDLE = "assistant";
export const CHAT_ASSISTANT_LEGACY_HANDLE = "admin";
export const CHAT_ASSISTANT_INTERNAL_HANDLE = CHAT_ASSISTANT_LEGACY_HANDLE;
export const CHAT_ASSISTANT_ROLE_ID = "administrator";

export function isChatAssistantHandle(handle: string | undefined): boolean {
  const normalized = handle?.trim().replace(/^@/, "").toLowerCase();
  return normalized === CHAT_ASSISTANT_HANDLE || normalized === CHAT_ASSISTANT_LEGACY_HANDLE;
}

export function isChatAssistantParticipant(participant: { handle: string; roleConfigId?: string } | undefined): boolean {
  return Boolean(participant && (
    participant.roleConfigId === CHAT_ASSISTANT_ROLE_ID ||
    participant.handle.trim().replace(/^@/, "").toLowerCase() === CHAT_ASSISTANT_LEGACY_HANDLE
  ));
}

export function chatParticipantMentionHandle(
  participant: { handle: string; roleConfigId?: string },
  participants: Array<{ handle: string; roleConfigId?: string }> = []
): string {
  if (!isChatAssistantParticipant(participant)) {
    return participant.handle;
  }
  const normalizedHandle = participant.handle.trim().replace(/^@/, "").toLowerCase();
  const assistantAliasTaken = participants.some((item) =>
    item !== participant &&
    item.handle.trim().replace(/^@/, "").toLowerCase() === CHAT_ASSISTANT_HANDLE &&
    item.roleConfigId !== CHAT_ASSISTANT_ROLE_ID
  );
  return normalizedHandle === CHAT_ASSISTANT_LEGACY_HANDLE && !assistantAliasTaken
    ? CHAT_ASSISTANT_HANDLE
    : participant.handle;
}

export function chatParticipantDisplayName(participant: { handle: string; roleConfigId?: string } | undefined): string {
  if (!participant) {
    return "";
  }
  if (isChatAssistantParticipant(participant)) {
    return CHAT_ASSISTANT_DISPLAY_NAME;
  }
  return `@${participant.handle}`;
}

export function chatParticipantReference(handle: string): string {
  const normalized = handle.trim().replace(/^@/, "");
  return isChatAssistantHandle(normalized)
    ? CHAT_ASSISTANT_DISPLAY_NAME
    : `@${normalized}`;
}

export function authorForMessage(message: Conversation["messages"][number], kind: ConversationKind): string {
  if (message.role === "user") {
    return "You";
  }
  if (kind === "implementation-plan" && (message.role === "system" || message.role === "summary" || message.participantId?.startsWith("arbiter:"))) {
    return "Planner";
  }
  if (message.role === "system") {
    return kind === "chat" ? CHAT_ASSISTANT_DISPLAY_NAME : "Arbiter";
  }
  if (
    kind === "chat" &&
    isChatAssistantHandle(message.participantLabel)
  ) {
    return CHAT_ASSISTANT_DISPLAY_NAME;
  }
  if (message.participantLabel?.toLowerCase().includes("(arbiter)") || message.participantLabel?.toLowerCase().includes("(planner)")) {
    return "Arbiter";
  }
  return message.participantLabel || labelForRole(message.role);
}

function labelForRole(role: string): string {
  if (role === "system") {
    return "Consensus engine";
  }
  if (role === "summary") {
    return "Final summary";
  }
  return role;
}
