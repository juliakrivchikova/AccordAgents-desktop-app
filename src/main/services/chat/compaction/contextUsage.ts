import type { AgentContextUsage, Conversation } from "../../../../shared/types";
import { normalizeAgentContextUsage } from "../../../../shared/agentContext";

export function updateParticipantContextUsage(
  conversation: Conversation,
  participantId: string,
  usage: AgentContextUsage | undefined
): void {
  if (!usage) {
    return;
  }
  const current = agentContextUsageByParticipant(conversation)[participantId];
  if (current && current.updatedAt > usage.updatedAt) {
    return;
  }
  conversation.metadata = {
    ...conversation.metadata,
    agentContextUsageByParticipant: {
      ...agentContextUsageByParticipant(conversation),
      [participantId]: usage
    }
  };
}

export function sameAgentContextUsage(left: AgentContextUsage | undefined, right: AgentContextUsage): boolean {
  return Boolean(
    left &&
    left.usedTokens === right.usedTokens &&
    left.contextWindowTokens === right.contextWindowTokens &&
    left.percentage === right.percentage &&
    left.source === right.source &&
    left.model === right.model
  );
}

function sameOptionalAgentContextUsage(left: AgentContextUsage | undefined, right: AgentContextUsage | undefined): boolean {
  if (!left || !right) {
    return !left && !right;
  }
  return sameAgentContextUsage(left, right);
}

export function contextUsageUpdatesAfterRefresh(
  conversation: Conversation,
  initialUsage: Record<string, AgentContextUsage>,
  candidateUsage: Record<string, AgentContextUsage>
): Record<string, AgentContextUsage> | undefined {
  const currentUsage = agentContextUsageByParticipant(conversation);
  let updates: Record<string, AgentContextUsage> | undefined;
  for (const [participantId, candidate] of Object.entries(candidateUsage)) {
    const initial = initialUsage[participantId];
    const current = currentUsage[participantId];
    if (!sameOptionalAgentContextUsage(current, initial) && !sameAgentContextUsage(current, candidate)) {
      continue;
    }
    if (sameAgentContextUsage(current, candidate)) {
      continue;
    }
    updates = {
      ...(updates ?? {}),
      [participantId]: candidate
    };
  }
  return updates;
}

export function mergeAgentContextUsageRecords(storedValue: unknown, currentValue: unknown): Record<string, AgentContextUsage> | undefined {
  const stored = normalizedAgentContextUsageRecord(storedValue);
  const current = normalizedAgentContextUsageRecord(currentValue);
  if (!stored && !current) {
    return undefined;
  }
  const merged: Record<string, AgentContextUsage> = {};
  const participantIds = new Set([...Object.keys(stored ?? {}), ...Object.keys(current ?? {})]);
  for (const participantId of participantIds) {
    const storedUsage = stored?.[participantId];
    const currentUsage = current?.[participantId];
    const usage = newerAgentContextUsage(storedUsage, currentUsage);
    if (usage) {
      merged[participantId] = usage;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function normalizedAgentContextUsageRecord(value: unknown): Record<string, AgentContextUsage> | undefined {
  if (!isMetadataRecord(value)) {
    return undefined;
  }
  const usageByParticipant: Record<string, AgentContextUsage> = {};
  for (const [participantId, usage] of Object.entries(value)) {
    const normalized = normalizeAgentContextUsage(usage);
    if (normalized) {
      usageByParticipant[participantId] = normalized;
    }
  }
  return Object.keys(usageByParticipant).length > 0 ? usageByParticipant : undefined;
}

function newerAgentContextUsage(
  stored: AgentContextUsage | undefined,
  current: AgentContextUsage | undefined
): AgentContextUsage | undefined {
  if (!stored || !current) {
    return current ?? stored;
  }
  return current.updatedAt >= stored.updatedAt ? current : stored;
}

export function agentContextUsageByParticipant(conversation: Conversation): Record<string, AgentContextUsage> {
  const value = conversation.metadata.agentContextUsageByParticipant;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const usageByParticipant: Record<string, AgentContextUsage> = {};
  for (const [participantId, usage] of Object.entries(value)) {
    const normalized = normalizeAgentContextUsage(usage);
    if (normalized) {
      usageByParticipant[participantId] = normalized;
    }
  }
  return usageByParticipant;
}

export function isMetadataRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
