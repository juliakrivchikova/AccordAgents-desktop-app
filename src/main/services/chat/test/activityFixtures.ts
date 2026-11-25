import type { ChatMessage, ChatParticipant, Conversation } from "../../../../shared/types";

export const NOW = "2026-01-08T12:00:00.000Z";

export const participant: ChatParticipant = {
  id: "participant-1",
  handle: "drew-codex-engineer",
  roleConfigId: "engineer",
  kind: "codex-cli"
};

export const chatAssistant: ChatParticipant = {
  id: "participant-assistant",
  handle: "admin",
  roleConfigId: "administrator",
  kind: "codex-cli"
};

export const remoteParticipant: ChatParticipant = {
  id: "participant-2",
  handle: "taylor-claude-engineer",
  roleConfigId: "engineer",
  kind: "claude-code"
};

export function conversation(patch: Partial<Conversation> = {}): Conversation {
  const { metadata, ...rest } = patch;
  return {
    id: "conversation-1",
    title: "Feature chat",
    kind: "chat",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: NOW,
    messages: [],
    findings: [],
    ...rest,
    metadata: {
      participants: [participant, chatAssistant, remoteParticipant],
      ...metadata
    }
  };
}

export function participantMessage(id: string, patch: Partial<ChatMessage> = {}, target: ChatParticipant = participant): ChatMessage {
  return {
    id,
    role: "participant",
    participantId: target.id,
    participantLabel: `@${target.handle}`,
    content: `${id} content`,
    createdAt: NOW,
    status: "done",
    ...patch,
    metadata: {
      ...patch.metadata
    }
  };
}
