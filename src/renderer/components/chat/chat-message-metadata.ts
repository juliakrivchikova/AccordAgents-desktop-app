import { normalizeAgentContextUsage } from "../../../shared/agentContext";
import type {
  AgentContextUsage,
  ChatImageAttachment,
  ChatParticipant,
  ChatParticipantSession,
  ChatSkillMention,
  Conversation,
  RepoFileMention
} from "../../../shared/types";

export function chatParticipants(conversation: Conversation | undefined): ChatParticipant[] {
  const value = conversation?.metadata.participants;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is ChatParticipant => {
    const participant = item as Partial<ChatParticipant>;
    return (
      typeof participant.id === "string" &&
      typeof participant.handle === "string" &&
      typeof participant.roleConfigId === "string" &&
      (participant.kind === "codex-cli" || participant.kind === "claude-code" || participant.kind === "gemini-cli")
    );
  });
}

export function chatContextUsageByParticipant(conversation: Conversation | undefined): Map<string, AgentContextUsage> {
  const value = conversation?.metadata.agentContextUsageByParticipant;
  const usageByParticipant = new Map<string, AgentContextUsage>();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return usageByParticipant;
  }
  for (const [participantId, usage] of Object.entries(value)) {
    const normalized = normalizeAgentContextUsage(usage);
    if (normalized) {
      usageByParticipant.set(participantId, normalized);
    }
  }
  return usageByParticipant;
}

export function chatSessionsByParticipant(conversation: Conversation | undefined): Map<string, ChatParticipantSession> {
  const value = conversation?.metadata.participantSessions;
  const sessions = new Map<string, ChatParticipantSession>();
  if (!Array.isArray(value)) {
    return sessions;
  }
  for (const item of value) {
    const session = item as Partial<ChatParticipantSession>;
    if (typeof session.participantId === "string" && typeof session.sessionId === "string") {
      sessions.set(session.participantId, session as ChatParticipantSession);
    }
  }
  return sessions;
}

export function contextUsageForMessage(
  message: Conversation["messages"][number],
  usageByParticipant: Map<string, AgentContextUsage>
): AgentContextUsage | undefined {
  return message.role === "participant" && message.participantId ? usageByParticipant.get(message.participantId) : undefined;
}

export function sessionIdForMessage(
  message: Conversation["messages"][number],
  sessionsByParticipant: Map<string, ChatParticipantSession>
): string | undefined {
  return message.role === "participant" && message.participantId
    ? sessionsByParticipant.get(message.participantId)?.sessionId || undefined
    : undefined;
}

export function chatMessageRepoFileMentions(message: Conversation["messages"][number]): RepoFileMention[] {
  const mentions = message.metadata?.repoFileMentions;
  if (!Array.isArray(mentions)) {
    return [];
  }
  const seen = new Set<string>();
  return mentions.flatMap((mention): RepoFileMention[] => {
    const filePath = typeof mention?.path === "string" ? mention.path.trim() : "";
    if (!filePath || seen.has(filePath)) {
      return [];
    }
    seen.add(filePath);
    return [{ path: filePath }];
  });
}

export function chatMessageSkillMentions(message: Conversation["messages"][number]): ChatSkillMention[] {
  const mentions = message.metadata?.skillMentions;
  if (!Array.isArray(mentions)) {
    return [];
  }
  const seen = new Set<string>();
  return mentions.flatMap((mention): ChatSkillMention[] => {
    if (
      !mention ||
      typeof mention !== "object" ||
      typeof mention.skillId !== "string" ||
      typeof mention.displayName !== "string" ||
      typeof mention.frontmatterName !== "string" ||
      typeof mention.contentHash !== "string" ||
      !Array.isArray(mention.variants) ||
      seen.has(mention.skillId)
    ) {
      return [];
    }
    seen.add(mention.skillId);
    return [{
      skillId: mention.skillId,
      displayName: mention.displayName,
      frontmatterName: mention.frontmatterName,
      description: typeof mention.description === "string" ? mention.description : undefined,
      contentHash: mention.contentHash,
      capabilityState: mention.capabilityState,
      variants: mention.variants.filter((variant) =>
        variant &&
        typeof variant === "object" &&
        (variant.providerKind === "codex-cli" || variant.providerKind === "claude-code" || variant.providerKind === "gemini-cli") &&
        (variant.scope === "personal" || variant.scope === "repo") &&
        typeof variant.sourceKey === "string" &&
        typeof variant.frontmatterName === "string" &&
        typeof variant.contentHash === "string"
      )
    }];
  });
}

export function chatMessageImageAttachments(message: Conversation["messages"][number]): ChatImageAttachment[] {
  const attachments = message.metadata?.imageAttachments;
  if (!Array.isArray(attachments)) {
    return [];
  }
  const seen = new Set<string>();
  return attachments.flatMap((attachment): ChatImageAttachment[] => {
    if (
      !attachment ||
      typeof attachment !== "object" ||
      typeof attachment.id !== "string" ||
      seen.has(attachment.id)
    ) {
      return [];
    }
    seen.add(attachment.id);
    return [attachment as ChatImageAttachment];
  });
}
